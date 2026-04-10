/**
 * Whisper Widget – KI-Sprachassistent.
 * Push-to-Talk → OpenAI Whisper (STT) → ChatGPT → Browser-TTS
 * Alternativ: Texteingabe ohne Mikrofon.
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Send, Trash2, VolumeX } from 'lucide-react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface WhisperSettings {
  apiKey: string;
  model: string;
  language: string;
  systemPrompt: string;
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsRate: number;
  ttsPitch: number;
}

const DEFAULT: WhisperSettings = {
  apiKey: '',
  model: 'gpt-4o-mini',
  language: 'de',
  systemPrompt:
    'Du bist ein hilfreicher, freundlicher Assistent namens Slate. ' +
    'Antworte kurz und prägnant. Maximal 3 Sätze wenn möglich.',
  ttsEnabled: true,
  ttsVoice: '',
  ttsRate: 1.0,
  ttsPitch: 1.0,
};

const MODEL_OPTIONS = [
  { value: 'gpt-4o-mini',   label: 'GPT-4o Mini (schnell, günstig)' },
  { value: 'gpt-4o',        label: 'GPT-4o (leistungsstark)' },
  { value: 'gpt-4-turbo',   label: 'GPT-4 Turbo' },
  { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (günstigst)' },
];

const LANGUAGE_OPTIONS = [
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'Français' },
  { value: 'es', label: 'Español' },
  { value: 'it', label: 'Italiano' },
];

const STATUS_LABEL: Record<Status, string> = {
  idle:         '',
  recording:    '🔴 Aufnahme läuft…',
  transcribing: '⏳ Transkribiere…',
  thinking:     '💭 KI denkt…',
  speaking:     '🔊 Spricht…',
  error:        '',
};

const hasTTS = typeof window !== 'undefined' && 'speechSynthesis' in window;

// ─── API-Hilfsfunktionen ──────────────────────────────────────────────────────

async function transcribeAudio(blob: Blob, apiKey: string, language: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', blob, 'audio.webm');
  formData.append('model', 'whisper-1');
  if (language) formData.append('language', language);

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json() as { text: string };
  return data.text.trim();
}

async function chatCompletion(
  history: Message[],
  userText: string,
  apiKey: string,
  model: string,
  systemPrompt: string,
): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history.slice(-18).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userText },
      ],
      max_tokens: 600,
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content.trim();
}

// ─── Hauptkomponente ──────────────────────────────────────────────────────────

const WhisperComponent: React.FC<WidgetProps> = ({ instanceId }) => {
  const [messages, setMessages]         = useState<Message[]>([]);
  const [status, setStatus]             = useState<Status>('idle');
  const [errorMsg, setErrorMsg]         = useState('');
  const [textInput, setTextInput]       = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voices, setVoices]             = useState<SpeechSynthesisVoice[]>([]);

  const recorderRef    = useRef<MediaRecorder | null>(null);
  const chunksRef      = useRef<Blob[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { getSettings, updateSettings } = useWidgetSettingsStore();
  const s = getSettings<WhisperSettings>(instanceId, DEFAULT);

  // ─── Settings-Dialog via Event-Bus ─────────────────────────────────────────
  useEffect(() => {
    const h = () => setSettingsOpen(true);
    eventBus.on(`widget:openSettings:${instanceId}`, h);
    return () => eventBus.off(`widget:openSettings:${instanceId}`, h);
  }, [instanceId]);

  // ─── TTS-Stimmen laden ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!hasTTS) return;
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);

  // ─── Auto-Scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ─── TTS sprechen ──────────────────────────────────────────────────────────
  const speak = useCallback((text: string) => {
    if (!s.ttsEnabled || !hasTTS) { setStatus('idle'); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const langMap: Record<string, string> = { de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT' };
    utterance.lang  = langMap[s.language] ?? s.language;
    utterance.rate  = s.ttsRate;
    utterance.pitch = s.ttsPitch;
    if (s.ttsVoice) {
      const v = voices.find(v => v.name === s.ttsVoice);
      if (v) utterance.voice = v;
    }
    utterance.onstart = () => setStatus('speaking');
    utterance.onend   = () => setStatus('idle');
    utterance.onerror = () => setStatus('idle');
    window.speechSynthesis.speak(utterance);
  }, [s, voices]);

  // ─── Nachricht senden ──────────────────────────────────────────────────────
  const sendMessage = useCallback(async (userText: string, currentMessages: Message[]) => {
    if (!userText.trim() || !s.apiKey) return;

    const userMsg: Message = { role: 'user', content: userText, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setStatus('thinking');
    setErrorMsg('');

    try {
      // currentMessages = history BEFORE the new user message
      const reply = await chatCompletion(currentMessages, userText, s.apiKey, s.model, s.systemPrompt);
      const aiMsg: Message = { role: 'assistant', content: reply, timestamp: Date.now() };
      setMessages(prev => [...prev, aiMsg]);
      speak(reply);
      if (!s.ttsEnabled || !hasTTS) setStatus('idle');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [s, speak]);

  // ─── Aufnahme starten ──────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (status !== 'idle' && status !== 'error') return;
    if (!s.apiKey) {
      setErrorMsg('Kein API-Key – bitte in Einstellungen eintragen.');
      setStatus('error');
      return;
    }
    setErrorMsg('');

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setErrorMsg('Kein Mikrofonzugriff. Erlaubnis prüfen.');
      setStatus('error');
      return;
    }

    chunksRef.current = [];
    const mimeTypes = ['audio/webm', 'audio/ogg', ''];
    const mime = mimeTypes.find(m => !m || MediaRecorder.isTypeSupported(m)) ?? '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };

    // Snapshot der aktuellen Messages für den API-Aufruf
    const msgSnapshot = messages.slice();

    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(chunksRef.current, { type: mime || 'audio/webm' });
      if (blob.size < 1000) { setStatus('idle'); return; }

      setStatus('transcribing');
      try {
        const text = await transcribeAudio(blob, s.apiKey, s.language);
        if (text) await sendMessage(text, msgSnapshot);
        else setStatus('idle');
      } catch (e) {
        setErrorMsg(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    };

    recorder.start();
    recorderRef.current = recorder;
    setStatus('recording');
  }, [status, s, messages, sendMessage]);

  // ─── Aufnahme stoppen ──────────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
  }, []);

  // ─── Mic-Button Klick ──────────────────────────────────────────────────────
  const handleMicClick = useCallback(() => {
    if (status === 'recording') stopRecording();
    else startRecording();
  }, [status, startRecording, stopRecording]);

  // ─── TTS stoppen ───────────────────────────────────────────────────────────
  const stopSpeaking = useCallback(() => {
    if (hasTTS) window.speechSynthesis.cancel();
    setStatus('idle');
  }, []);

  // ─── Text absenden ─────────────────────────────────────────────────────────
  const handleSendText = useCallback(async () => {
    const text = textInput.trim();
    if (!text) return;
    if (!s.apiKey) {
      setErrorMsg('Kein API-Key – bitte in Einstellungen eintragen.');
      setStatus('error');
      return;
    }
    setTextInput('');
    await sendMessage(text, messages);
  }, [textInput, messages, s.apiKey, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendText(); }
  }, [handleSendText]);

  // ─── Chat leeren ───────────────────────────────────────────────────────────
  const clearChat = useCallback(() => {
    if (hasTTS) window.speechSynthesis.cancel();
    setMessages([]);
    setStatus('idle');
    setErrorMsg('');
  }, []);

  // ─── Render ────────────────────────────────────────────────────────────────
  const isRecording = status === 'recording';
  const isBusy      = status === 'transcribing' || status === 'thinking';
  const isSpeaking  = status === 'speaking';
  const noApiKey    = !s.apiKey;

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', gap: 0 }}>

        {/* Kein API-Key Banner */}
        {noApiKey && (
          <div className="whisper-no-key">
            <span>🔑</span>
            <div style={{ flex: 1 }}>
              <div className="whisper-no-key-title">OpenAI API-Key fehlt</div>
              <div className="whisper-no-key-sub">Einstellungen öffnen und Key eintragen</div>
            </div>
            <button
              className="settings-btn settings-btn-primary"
              onClick={() => setSettingsOpen(true)}
              style={{ flexShrink: 0, fontSize: 11, padding: '4px 10px' }}
            >
              ⚙️ Setup
            </button>
          </div>
        )}

        {/* Toolbar (Trash + Stop-Speaking) */}
        {(messages.length > 0 || isSpeaking) && (
          <div className="whisper-toolbar">
            {isSpeaking && (
              <button className="whisper-toolbar-btn" onClick={stopSpeaking} title="Sprachausgabe stoppen">
                <VolumeX size={13} /> Stopp
              </button>
            )}
            {messages.length > 0 && (
              <button className="whisper-toolbar-btn whisper-toolbar-btn-danger" onClick={clearChat} title="Chat leeren">
                <Trash2 size={13} /> Leeren
              </button>
            )}
          </div>
        )}

        {/* Nachrichten */}
        <div className="whisper-messages" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {messages.length === 0 && !noApiKey && (
            <div className="whisper-empty">
              <div className="whisper-empty-icon">🎙️</div>
              <div className="whisper-empty-text">
                Mikrofon-Button drücken und sprechen,<br />oder Text eingeben
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`whisper-msg whisper-msg-${msg.role}`}>
              <div className="whisper-msg-bubble">{msg.content}</div>
              <div className="whisper-msg-time">
                {new Date(msg.timestamp).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}
              </div>
            </div>
          ))}

          {isBusy && (
            <div className="whisper-msg whisper-msg-assistant">
              <div className="whisper-msg-bubble whisper-thinking">
                <span /><span /><span />
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Fehlermeldung */}
        {status === 'error' && errorMsg && (
          <div className="whisper-error">{errorMsg}</div>
        )}

        {/* Status-Zeile */}
        {status !== 'idle' && status !== 'error' && (
          <div className="whisper-status">{STATUS_LABEL[status]}</div>
        )}

        {/* Eingabe-Zeile */}
        <div className="whisper-input-row">
          <input
            type="text"
            className="whisper-text-input"
            placeholder={noApiKey ? 'API-Key fehlt…' : 'Nachricht eingeben…'}
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isBusy || isRecording || noApiKey}
          />
          <button
            className="whisper-send-btn"
            onClick={handleSendText}
            disabled={!textInput.trim() || isBusy || isRecording || noApiKey}
            title="Senden"
          >
            <Send size={15} />
          </button>
          <button
            className={`whisper-mic-btn ${isRecording ? 'recording' : ''}`}
            onClick={handleMicClick}
            disabled={isBusy || noApiKey}
            title={isRecording ? 'Aufnahme stoppen' : 'Sprechen'}
          >
            {isRecording ? <Square size={16} /> : <Mic size={16} />}
          </button>
        </div>
      </div>

      {/* Settings Dialog (Portal → immer zentriert) */}
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={s}
        updateSettings={(patch) => updateSettings(instanceId, patch)}
        voices={voices}
      />
    </>
  );
};

// ─── Settings Dialog ──────────────────────────────────────────────────────────

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
  settings: WhisperSettings;
  updateSettings: (patch: Partial<WhisperSettings>) => void;
  voices: SpeechSynthesisVoice[];
}

const SettingsDialog: React.FC<SettingsDialogProps> = ({
  open, onClose, settings, updateSettings, voices,
}) => {
  const [localKey, setLocalKey] = useState(settings.apiKey);

  useEffect(() => {
    if (open) setLocalKey(settings.apiKey);
  }, [open, settings.apiKey]);

  const save = () => { updateSettings({ apiKey: localKey.trim() }); onClose(); };

  const langFilter = ({ de: 'de', en: 'en', fr: 'fr', es: 'es', it: 'it' } as Record<string, string>)[settings.language] ?? '';
  const filtered = voices.filter(v => !langFilter || v.lang.toLowerCase().startsWith(langFilter));
  const displayVoices = filtered.length > 0 ? filtered : voices;

  return (
    <WidgetSettingsDialog
      open={open}
      onClose={onClose}
      onSave={save}
      title="KI-Assistent Einstellungen"
      showFooter
      saveLabel="Speichern"
    >
      {/* API Key */}
      <div className="settings-section">
        <div className="settings-section-title">OpenAI API-Key</div>
        <div className="settings-field">
          <label className="settings-label">API-Key</label>
          <input
            type="password"
            className="settings-input"
            placeholder="sk-..."
            value={localKey}
            onChange={e => setLocalKey(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="settings-description">Erhältlich unter platform.openai.com → API keys</div>
        </div>
      </div>

      <hr className="settings-divider" />

      {/* Modell & Sprache */}
      <div className="settings-section">
        <div className="settings-section-title">Sprachmodell</div>
        <div className="settings-field">
          <label className="settings-label">KI-Modell</label>
          <select className="settings-select" value={settings.model} onChange={e => updateSettings({ model: e.target.value })}>
            {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="settings-field">
          <label className="settings-label">Sprache (Whisper + TTS)</label>
          <select className="settings-select" value={settings.language} onChange={e => updateSettings({ language: e.target.value })}>
            {LANGUAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      </div>

      <hr className="settings-divider" />

      {/* System-Prompt */}
      <div className="settings-section">
        <div className="settings-section-title">Persönlichkeit</div>
        <div className="settings-field">
          <label className="settings-label">System-Prompt</label>
          <textarea
            className="settings-input whisper-prompt-textarea"
            value={settings.systemPrompt}
            onChange={e => updateSettings({ systemPrompt: e.target.value })}
            rows={4}
          />
          <div className="settings-description">Definiert Persönlichkeit und Verhalten des Assistenten</div>
        </div>
      </div>

      <hr className="settings-divider" />

      {/* TTS */}
      <div className="settings-section">
        <div className="settings-section-title">Sprachausgabe (TTS)</div>
        {!hasTTS && (
          <div className="whisper-no-key" style={{ marginBottom: 'var(--spacing-sm)' }}>
            <span>⚠️</span>
            <div className="whisper-no-key-sub">SpeechSynthesis wird auf diesem Gerät nicht unterstützt.</div>
          </div>
        )}
        <div className="settings-toggle">
          <div>
            <div className="settings-toggle-label">Sprachausgabe aktivieren</div>
            <div className="settings-toggle-sublabel">KI-Antworten laut vorlesen</div>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={settings.ttsEnabled && hasTTS}
              disabled={!hasTTS}
              onChange={e => updateSettings({ ttsEnabled: e.target.checked })}
            />
            <span className="toggle-switch-slider" />
          </label>
        </div>

        {settings.ttsEnabled && hasTTS && (
          <>
            <div className="settings-field" style={{ marginTop: 'var(--spacing-md)' }}>
              <label className="settings-label">Stimme</label>
              <select className="settings-select" value={settings.ttsVoice} onChange={e => updateSettings({ ttsVoice: e.target.value })}>
                <option value="">Standard-Stimme</option>
                {displayVoices.map(v => <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>)}
              </select>
            </div>
            <div className="settings-field">
              <label className="settings-label">
                Geschwindigkeit <span className="settings-range-value">{settings.ttsRate.toFixed(1)}×</span>
              </label>
              <input type="range" className="settings-range" min={0.5} max={2} step={0.1}
                value={settings.ttsRate} onChange={e => updateSettings({ ttsRate: parseFloat(e.target.value) })} />
            </div>
            <div className="settings-field">
              <label className="settings-label">
                Tonhöhe <span className="settings-range-value">{settings.ttsPitch.toFixed(1)}</span>
              </label>
              <input type="range" className="settings-range" min={0.5} max={2} step={0.1}
                value={settings.ttsPitch} onChange={e => updateSettings({ ttsPitch: parseFloat(e.target.value) })} />
            </div>
          </>
        )}
      </div>
    </WidgetSettingsDialog>
  );
};

// ─── Widget-Definition ────────────────────────────────────────────────────────

export const whisperWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'whisper',
    name: 'KI-Assistent',
    description: 'Sprachassistent mit OpenAI Whisper + ChatGPT und Sprachausgabe',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 3,
    minHeight: 4,
    defaultWidth: 4,
    defaultHeight: 7,
    permissions: ['microphone'],
    hasSettings: true,
  },
  component: WhisperComponent,
};
