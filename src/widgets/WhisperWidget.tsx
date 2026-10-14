/**
 * KI-Assistent – chat with OpenAI or a local model (Ollama / LM Studio).
 *
 * Push-to-talk → OpenAI speech recognition → chat → optional OpenAI speech
 * output, played from a blob (WebKitGTK has neither speechSynthesis nor
 * SpeechRecognition). Text input works with every provider.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Bot,
  Check,
  Cloud,
  Cpu,
  Mic,
  RefreshCw,
  Send,
  Square,
  Trash2,
  VolumeX,
  X,
} from 'lucide-react';
import type { WidgetProps } from '../types/widget';
import { widgetSettingsActions } from '../state/dataActions';
import { usePolling } from '../hooks/usePolling';
import { uid } from '../utils/uid';
import { WHISPER_SUGGESTED_LOCAL_MODEL, WHISPER_VOICES } from './manifests/whisper';
import {
  chatCompletion,
  errorMessage,
  isAbortError,
  parseLocalEndpoint,
  probeLocalServer,
  synthesizeSpeech,
  transcribe,
  type ChatMessage,
  type LocalServerStatus,
} from './whisper/api';
import { legacyWhisperPatch, useWhisperSettings } from './whisper/settings';
import { useVoiceRecorder, voiceRecordingSupported, type VoiceRecording } from './whisper/useVoiceRecorder';
import './styles/whisper.css';

type Phase = 'idle' | 'transcribing' | 'thinking' | 'speaking';

interface Message extends ChatMessage {
  id: string;
  /** epoch ms */
  timestamp: number;
}

const MIN_RECORDING_MS = 600;
const MIN_RECORDING_BYTES = 1000;
const LOCAL_PROBE_INTERVAL_MS = 15_000;

const PHASE_LABEL: Record<Phase, string> = {
  idle: '',
  transcribing: 'Spracherkennung …',
  thinking: 'Denkt nach …',
  speaking: 'Liest vor …',
};

const timeFormat = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });

const formatSeconds = (seconds: number): string =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/** Ollama accepts «llama3.2» for «llama3.2:latest». */
const sameModel = (a: string, b: string): boolean =>
  a === b || a === `${b}:latest` || `${a}:latest` === b;

const shortModelName = (model: string): string => model.replace(/:latest$/, '');

// ── Widget ───────────────────────────────────────────────────────────────────

export function WhisperWidget({ instanceId }: WidgetProps) {
  const [settings, , stored] = useWhisperSettings(instanceId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [voiceSupported] = useState(voiceRecordingSupported);

  /** Same content as `messages`, readable in async callbacks without stale closures. */
  const messagesRef = useRef<Message[]>([]);
  /** Controller of the running turn (transcription → chat → speech). */
  const turnRef = useRef<AbortController | null>(null);
  const playbackRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const migratedRef = useRef(false);
  const settingsRef = useRef(settings);
  useLayoutEffect(() => {
    settingsRef.current = settings;
  });

  // Pre-2.0 keys (localBaseUrl, provider 'local', browser TTS, wake word) – once per mount.
  useEffect(() => {
    if (migratedRef.current) return;
    migratedRef.current = true;
    const patch = legacyWhisperPatch(stored);
    if (patch) void widgetSettingsActions.update(instanceId, patch);
  }, [instanceId, stored]);

  const isLocal = settings.provider === 'lokal';
  const hasKey = settings.apiKey !== '';
  const setupProblem: { title: string; text: string } | null =
    !isLocal && !hasKey
      ? {
          title: 'OpenAI API-Key fehlt',
          text: 'In den Einstellungen eintragen (Bearbeiten → Zahnrad) oder über die Fernsteuerung – oder den lokalen Anbieter wählen.',
        }
      : isLocal && !settings.localEndpoint
        ? { title: 'Server-Adresse fehlt', text: 'In den Einstellungen die Adresse von Ollama oder LM Studio eintragen.' }
        : isLocal && !settings.localModel
          ? { title: 'Kein Modell gewählt', text: 'In den Einstellungen eines der installierten Modelle auswählen.' }
          : null;
  const canChat = setupProblem === null;
  const canTalk = canChat && hasKey && voiceSupported;

  const commitMessages = useCallback((next: Message[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const stopPlayback = useCallback(() => {
    const playback = playbackRef.current;
    playbackRef.current = null;
    if (!playback) return;
    const { audio, url } = playback;
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    URL.revokeObjectURL(url);
  }, []);

  const abortTurn = useCallback(() => {
    turnRef.current?.abort();
    turnRef.current = null;
  }, []);

  /** Ends `controller`'s turn unless a newer one took over. */
  const finishTurn = useCallback((controller: AbortController) => {
    if (turnRef.current !== controller) return;
    turnRef.current = null;
    setPhase('idle');
  }, []);

  const beginTurn = useCallback((): AbortController => {
    abortTurn();
    stopPlayback();
    const controller = new AbortController();
    turnRef.current = controller;
    setError(null);
    return controller;
  }, [abortTurn, stopPlayback]);

  /** Plays the spoken answer; resolves when it ended or the turn was aborted. */
  const speak = useCallback(
    async (text: string, signal: AbortSignal) => {
      const blob = await synthesizeSpeech(text, settingsRef.current, signal);
      if (signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const audio = new Audio();
      playbackRef.current = { audio, url };
      try {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
          audio.onended = () => resolve();
          audio.onerror = () => reject(new Error('Wiedergabe fehlgeschlagen.'));
          audio.src = url;
          audio.play().catch((err: unknown) => {
            const blocked = (err as { name?: unknown } | null)?.name === 'NotAllowedError';
            reject(new Error(blocked ? 'Wiedergabe wurde vom System blockiert.' : 'Wiedergabe fehlgeschlagen.'));
          });
        });
      } finally {
        if (playbackRef.current?.audio === audio) stopPlayback();
      }
    },
    [stopPlayback],
  );

  /** Sends `text` as the next user message and handles the answer. */
  const runTurn = useCallback(
    async (text: string, controller: AbortController) => {
      const { signal } = controller;
      const current = settingsRef.current;
      const history: Message[] = [
        ...messagesRef.current,
        { id: uid(), role: 'user', content: text, timestamp: Date.now() },
      ];
      commitMessages(history);
      setPhase('thinking');
      try {
        const reply = await chatCompletion(history, current, signal);
        if (signal.aborted) return;
        commitMessages([
          ...messagesRef.current,
          { id: uid(), role: 'assistant', content: reply, timestamp: Date.now() },
        ]);
        if (current.ttsEnabled && current.apiKey) {
          setPhase('speaking');
          try {
            await speak(reply, signal);
          } catch (err) {
            if (signal.aborted || isAbortError(err)) return;
            setError(`Sprachausgabe: ${errorMessage(err)}`);
          }
        }
      } catch (err) {
        if (signal.aborted || isAbortError(err)) return;
        setError(errorMessage(err));
      }
      finishTurn(controller);
    },
    [commitMessages, finishTurn, speak],
  );

  const handleRecording = useCallback(
    async (recording: VoiceRecording) => {
      if (recording.durationMs < MIN_RECORDING_MS || recording.blob.size < MIN_RECORDING_BYTES) {
        setError('Aufnahme zu kurz – Mikrofon antippen, sprechen und zum Senden nochmals antippen.');
        return;
      }
      const controller = beginTurn();
      setPhase('transcribing');
      let text: string;
      try {
        text = await transcribe(recording.blob, recording.mimeType, settingsRef.current, controller.signal);
      } catch (err) {
        if (controller.signal.aborted || isAbortError(err)) return;
        setError(`Spracherkennung: ${errorMessage(err)}`);
        finishTurn(controller);
        return;
      }
      if (controller.signal.aborted) return;
      if (!text) {
        setError('Nichts verstanden – bitte nochmals versuchen.');
        finishTurn(controller);
        return;
      }
      await runTurn(text, controller);
    },
    [beginTurn, finishTurn, runTurn],
  );

  const {
    recording,
    elapsedSeconds,
    levelRef,
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording,
  } = useVoiceRecorder({
    maxSeconds: settings.maxRecordSeconds,
    onComplete: (rec) => void handleRecording(rec),
    onError: setError,
  });

  const busy = phase === 'transcribing' || phase === 'thinking';

  const sendText = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || busy || recording) return;
      if (!canChat) return;
      setDraft('');
      void runTurn(text, beginTurn());
    },
    [busy, recording, canChat, runTurn, beginTurn],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    sendText(draft);
  };

  const handleMic = () => {
    if (recording) {
      stopRecording();
      return;
    }
    if (busy) return;
    if (!hasKey) {
      setError(
        isLocal
          ? 'Spracheingabe braucht einen OpenAI API-Key (in den Einstellungen). Texteingabe funktioniert auch ohne.'
          : 'OpenAI API-Key fehlt – in den Einstellungen eintragen.',
      );
      return;
    }
    if (!voiceSupported) {
      setError('Dieses Gerät unterstützt keine Sprachaufnahme – bitte die Texteingabe verwenden.');
      return;
    }
    if (!canChat) return;
    if (phase === 'speaking') {
      abortTurn();
      stopPlayback();
      setPhase('idle');
    }
    setError(null);
    void startRecording();
  };

  /** Cancels transcription / answer / speech; the conversation stays. */
  const stopTurn = () => {
    abortTurn();
    stopPlayback();
    setPhase('idle');
  };

  const clearConversation = useCallback(() => {
    abortTurn();
    stopPlayback();
    cancelRecording();
    commitMessages([]);
    setPhase('idle');
    setError(null);
    setDraft('');
  }, [abortTurn, stopPlayback, cancelRecording, commitMessages]);

  // Visitor-facing kiosk: forget the conversation after a while without activity.
  const hasConversation = messages.length > 0 || draft !== '' || error !== null;
  useEffect(() => {
    if (settings.autoClearMinutes <= 0 || !hasConversation || phase !== 'idle' || recording) return;
    const timer = setTimeout(clearConversation, settings.autoClearMinutes * 60_000);
    return () => clearTimeout(timer);
  }, [settings.autoClearMinutes, hasConversation, messages, draft, error, phase, recording, clearConversation]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
  }, [messages, phase]);

  useEffect(
    () => () => {
      abortTurn();
      stopPlayback();
    },
    [abortTurn, stopPlayback],
  );

  const modelLabel = isLocal ? shortModelName(settings.localModel) : settings.model;
  const emptyText = canTalk
    ? 'Mikrofon antippen und sprechen – oder eine Frage eintippen.'
    : isLocal && !hasKey
      ? 'Frage eintippen. Für die Spracheingabe braucht es zusätzlich einen OpenAI API-Key.'
      : 'Frage eintippen.';
  const showQuickPrompts = canChat && settings.quickPrompts.length > 0 && !recording;

  return (
    <div className="assistant" ref={levelRef}>
      <div className="assistant-toolbar">
        <span className={`assistant-provider${isLocal ? ' local' : ''}`} title={isLocal ? settings.localEndpoint : 'OpenAI'}>
          {isLocal ? <Cpu size={14} aria-hidden /> : <Cloud size={14} aria-hidden />}
          <span className="assistant-provider-name">{isLocal ? 'Lokal' : 'OpenAI'}</span>
          {modelLabel && <span className="assistant-provider-model">{modelLabel}</span>}
        </span>
        {messages.length > 0 && (
          <button type="button" className="assistant-tool-btn" onClick={clearConversation} aria-label="Gespräch leeren">
            <Trash2 size={16} aria-hidden />
            <span className="assistant-tool-label">Leeren</span>
          </button>
        )}
      </div>

      <div className="assistant-messages" ref={listRef} aria-live="polite">
        {!canChat && setupProblem && (
          <div className="assistant-setup-card">
            <AlertTriangle size={20} aria-hidden />
            <div>
              <div className="assistant-setup-title">{setupProblem.title}</div>
              <div className="assistant-setup-text">{setupProblem.text}</div>
            </div>
          </div>
        )}
        {canChat && messages.length === 0 && (
          <div className="assistant-empty">
            <Bot className="assistant-empty-icon" aria-hidden />
            <div>{emptyText}</div>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`assistant-msg ${message.role === 'user' ? 'from-user' : 'from-ai'}`}>
            <div className="assistant-bubble">{message.content}</div>
            <div className="assistant-time">{timeFormat.format(message.timestamp)}</div>
          </div>
        ))}
        {busy && (
          <div className="assistant-msg from-ai" aria-label={PHASE_LABEL[phase]}>
            <div className="assistant-bubble assistant-typing">
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {showQuickPrompts && (
        <div className="assistant-quick" role="group" aria-label="Schnellfragen">
          {settings.quickPrompts.map((prompt, index) => (
            <button
              key={`${index}-${prompt}`}
              type="button"
              className="assistant-quick-btn"
              disabled={busy}
              onClick={() => sendText(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="assistant-error" role="alert">
          <AlertTriangle size={16} aria-hidden />
          <span className="assistant-error-text">{error}</span>
          <button type="button" className="assistant-icon-btn" onClick={() => setError(null)} aria-label="Meldung schliessen">
            <X size={16} aria-hidden />
          </button>
        </div>
      )}

      {recording ? (
        <div className="assistant-status recording">
          <span className="assistant-rec-dot" aria-hidden />
          <span className="assistant-status-text">
            Aufnahme {formatSeconds(elapsedSeconds)} / {formatSeconds(settings.maxRecordSeconds)}
          </span>
          <div className="assistant-meter" aria-hidden>
            <span />
          </div>
          <button type="button" className="assistant-icon-btn" onClick={cancelRecording} aria-label="Aufnahme verwerfen">
            <X size={16} aria-hidden />
          </button>
        </div>
      ) : (
        phase !== 'idle' && (
          <div className="assistant-status">
            <span className="assistant-status-text">{PHASE_LABEL[phase]}</span>
            <button type="button" className="assistant-tool-btn" onClick={stopTurn}>
              {phase === 'speaking' ? <VolumeX size={16} aria-hidden /> : <Square size={14} aria-hidden />}
              <span>{phase === 'speaking' ? 'Stopp' : 'Abbrechen'}</span>
            </button>
          </div>
        )
      )}

      <form className="assistant-input-row" onSubmit={handleSubmit}>
        <input
          type="text"
          className="assistant-input"
          placeholder={canChat ? 'Frage eintippen …' : 'Nicht eingerichtet'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={!canChat || busy || recording}
          enterKeyHint="send"
          aria-label="Frage"
        />
        <button
          type="submit"
          className="assistant-round-btn"
          disabled={!canChat || busy || recording || draft.trim() === ''}
          aria-label="Senden"
        >
          <Send size={18} aria-hidden />
        </button>
        <button
          type="button"
          className={`assistant-round-btn assistant-mic${recording ? ' recording' : ''}${canTalk ? '' : ' unavailable'}`}
          onClick={handleMic}
          disabled={!canChat || busy}
          aria-pressed={recording}
          aria-label={recording ? 'Aufnahme beenden und senden' : 'Sprechen'}
        >
          {recording ? <Square size={18} aria-hidden /> : <Mic size={18} aria-hidden />}
        </button>
      </form>
    </div>
  );
}

// ── Settings extra (kiosk) ───────────────────────────────────────────────────

type Capability = { ok: boolean; text: string };

function CapabilityRow({ label, capability }: { label: string; capability: Capability }) {
  return (
    <div className="assistant-capability">
      <span className={`assistant-dot ${capability.ok ? 'ok' : 'off'}`} aria-hidden />
      <span className="assistant-capability-label">{label}</span>
      <span className="assistant-capability-text">{capability.text}</span>
    </div>
  );
}

function ServerStatusLine({ status }: { status: LocalServerStatus }) {
  if (status.reachable) {
    const text =
      status.kind === 'ollama'
        ? `Ollama läuft${status.version ? ` (Version ${status.version})` : ''} – ${status.host}`
        : `Server erreichbar (OpenAI-kompatibel, z. B. LM Studio) – ${status.host}`;
    return (
      <div className="settings-status">
        <span className="assistant-dot ok" aria-hidden />
        {text}
      </div>
    );
  }
  return (
    <div className="settings-status">
      <span className={`assistant-dot ${status.installedNotRunning ? 'warn' : 'error'}`} aria-hidden />
      {status.installedNotRunning
        ? 'Ollama ist installiert, läuft aber nicht.'
        : `Kein KI-Server erreichbar unter ${status.host}.`}
    </div>
  );
}

function SetupInstructions({ status }: { status: LocalServerStatus }) {
  if (status.installedNotRunning) {
    return (
      <div className="settings-info-box warning assistant-instructions">
        <div>
          <strong>Ollama starten</strong>
          <div>
            Auf dem Gerät als Administrator: <code>sudo systemctl start ollama</code>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="settings-info-box assistant-instructions">
      <div>
        <strong>Ollama installieren</strong>
        <div>
          {status.onDevice ? 'Auf dem Gerät' : 'Auf dem Server-Rechner'} als Administrator:{' '}
          <code>curl -fsSL https://ollama.com/install.sh | sh</code>, danach:{' '}
          <code>ollama pull {WHISPER_SUGGESTED_LOCAL_MODEL}</code>
        </div>
        {!status.onDevice && (
          <div className="assistant-instructions-note">
            Auf einem anderen Rechner muss Ollama im Netzwerk erreichbar sein (Umgebungsvariable{' '}
            <code>OLLAMA_HOST=0.0.0.0</code>).
          </div>
        )}
        <div className="assistant-instructions-note">Alternativ LM Studio mit aktiviertem Server verwenden (Port 1234).</div>
      </div>
    </div>
  );
}

function ModelPicker({
  status,
  selected,
  onSelect,
}: {
  status: LocalServerStatus;
  selected: string;
  onSelect: (model: string) => void;
}) {
  if (status.models.length === 0) {
    return (
      <div className="settings-info-box warning assistant-instructions">
        <div>
          <strong>Noch kein Modell installiert</strong>
          {status.kind === 'ollama' ? (
            <div>
              {status.onDevice ? 'Auf dem Gerät' : 'Auf dem Server-Rechner'}:{' '}
              <code>ollama pull {WHISPER_SUGGESTED_LOCAL_MODEL}</code>
            </div>
          ) : (
            <div>In LM Studio ein Modell herunterladen und laden.</div>
          )}
        </div>
      </div>
    );
  }
  const selectedMissing = selected !== '' && !status.models.some((model) => sameModel(model, selected));
  return (
    <div className="assistant-model-picker">
      <div className="settings-label">Installierte Modelle – antippen zum Auswählen</div>
      <div className="assistant-models">
        {status.models.map((model) => {
          const active = selected !== '' && sameModel(model, selected);
          return (
            <button
              key={model}
              type="button"
              className={`assistant-model-btn${active ? ' active' : ''}`}
              aria-pressed={active}
              onClick={() => onSelect(model)}
            >
              {active && <Check size={14} aria-hidden />}
              {model}
            </button>
          );
        })}
      </div>
      {selectedMissing && (
        <div className="settings-field-error">Das gewählte Modell «{selected}» ist auf dem Server nicht installiert.</div>
      )}
    </div>
  );
}

function LocalServerPanel({
  endpoint,
  selected,
  onSelect,
}: {
  endpoint: string;
  selected: string;
  onSelect: (model: string) => void;
}) {
  const endpointError = useMemo(() => {
    try {
      parseLocalEndpoint(endpoint);
      return null;
    } catch (err) {
      return errorMessage(err);
    }
  }, [endpoint]);

  const { data, error, loading, refresh } = usePolling(
    () => probeLocalServer(endpoint),
    LOCAL_PROBE_INTERVAL_MS,
    [endpoint],
    { enabled: endpointError === null },
  );

  return (
    <div className="assistant-server">
      <div className="settings-section-title assistant-extra-title">
        <span>Lokaler KI-Server</span>
        <button
          type="button"
          className="settings-btn"
          onClick={refresh}
          disabled={loading || endpointError !== null}
        >
          <RefreshCw size={14} className={loading ? 'assistant-spin' : undefined} aria-hidden />
          Prüfen
        </button>
      </div>

      {endpointError ? (
        <div className="settings-info-box error">{endpointError}</div>
      ) : data ? (
        <>
          <ServerStatusLine status={data} />
          {data.reachable ? (
            <ModelPicker status={data} selected={selected} onSelect={onSelect} />
          ) : (
            <SetupInstructions status={data} />
          )}
          {error && <div className="assistant-stale">Letzte Prüfung fehlgeschlagen: {error}</div>}
        </>
      ) : error ? (
        <div className="settings-info-box error">Status konnte nicht geprüft werden: {error}</div>
      ) : (
        <div className="settings-status">
          <RefreshCw size={14} className="assistant-spin" aria-hidden />
          Verbindung wird geprüft …
        </div>
      )}
    </div>
  );
}

/** Kiosk-only part of the settings dialog: speech capabilities and the local server status. */
export function WhisperSettingsExtra({ instanceId }: { instanceId: string }) {
  const [settings, update] = useWhisperSettings(instanceId);
  const [voiceSupported] = useState(voiceRecordingSupported);
  const hasKey = settings.apiKey !== '';
  const voiceName = WHISPER_VOICES.find((voice) => voice.value === settings.ttsVoice)?.label ?? settings.ttsVoice;

  const speechInput: Capability = !voiceSupported
    ? { ok: false, text: 'Dieses Gerät unterstützt keine Sprachaufnahme' }
    : hasKey
      ? { ok: true, text: `bereit (bis ${settings.maxRecordSeconds} s)` }
      : { ok: false, text: 'braucht einen OpenAI API-Key' };
  const speechOutput: Capability = !settings.ttsEnabled
    ? { ok: false, text: 'ausgeschaltet' }
    : hasKey
      ? { ok: true, text: `bereit (Stimme ${voiceName})` }
      : { ok: false, text: 'braucht einen OpenAI API-Key' };

  return (
    <div className="assistant-extra">
      {settings.provider === 'lokal' && (
        <LocalServerPanel
          endpoint={settings.localEndpoint}
          selected={settings.localModel}
          onSelect={(model) => update({ localModel: model })}
        />
      )}
      <div className="assistant-capabilities">
        <div className="settings-section-title assistant-extra-title">Sprache</div>
        <CapabilityRow label="Spracheingabe" capability={speechInput} />
        <CapabilityRow label="Sprachausgabe" capability={speechOutput} />
        {settings.provider === 'openai' && (
          <div className="settings-description">
            Jede Anfrage wird über das OpenAI-Konto des API-Keys abgerechnet.
          </div>
        )}
      </div>
    </div>
  );
}
