/**
 * Whisper Widget – KI-Sprachassistent.
 * Unterstützt OpenAI (Cloud) und lokale Modelle via Ollama / LM Studio / LocalAI.
 * Push-to-Talk → Whisper (STT) → Chat-API → Browser-TTS
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Mic, Square, Send, Trash2, VolumeX, RefreshCw } from 'lucide-react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { WidgetSettingsDialog } from '../components/WidgetSettingsDialog';
import { eventBus } from '../utils/eventBus';

// ─── Types ────────────────────────────────────────────────────────────────────

type Status = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'error';
type Provider = 'openai' | 'local';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface WhisperSettings {
  // Cloud (OpenAI)
  apiKey: string;
  model: string;
  // Local (Ollama / LM Studio / LocalAI)
  provider: Provider;
  localBaseUrl: string;
  localModel: string;
  // Gemeinsam
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
  provider: 'openai',
  localBaseUrl: 'http://localhost:11434/v1',
  localModel: '',
  language: 'de',
  systemPrompt:
    'Du bist ein hilfreicher, freundlicher Assistent namens Slate. ' +
    'Antworte kurz und prägnant. Maximal 3 Sätze wenn möglich.',
  ttsEnabled: true,
  ttsVoice: '',
  ttsRate: 1.0,
  ttsPitch: 1.0,
};

const OPENAI_MODELS = [
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
  settings: WhisperSettings,
): Promise<string> {
  const isLocal = settings.provider === 'local';
  const baseUrl = isLocal ? settings.localBaseUrl.replace(/\/$/, '') : 'https://api.openai.com/v1';
  const model   = isLocal ? settings.localModel : settings.model;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  // Ollama benötigt keinen echten Key, aber den Header erwartet es trotzdem
  if (!isLocal && settings.apiKey) headers['Authorization'] = `Bearer ${settings.apiKey}`;
  if (isLocal) headers['Authorization'] = 'Bearer ollama';

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: settings.systemPrompt },
        ...history.slice(-18).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userText },
      ],
      max_tokens: 600,
      temperature: 0.7,
      stream: false,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: { message?: string } })?.error?.message || `HTTP ${res.status}`);
  }
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0].message.content.trim();
}

/** Fragt laufende Modelle vom lokalen Server ab (OpenAI-kompatibel: GET /v1/models) */
async function fetchLocalModels(baseUrl: string): Promise<string[]> {
  const url = baseUrl.replace(/\/$/, '');
  const res = await fetch(`${url}/models`, {
    headers: { Authorization: 'Bearer ollama' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json() as { data: Array<{ id: string }> };
  return data.data.map(m => m.id).sort();
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

  const isLocal  = s.provider === 'local';
  const canChat  = isLocal ? !!s.localModel : !!s.apiKey;
  const canSTT   = !!s.apiKey; // Whisper ist immer OpenAI

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
    if (!userText.trim() || !canChat) return;

    const userMsg: Message = { role: 'user', content: userText, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setStatus('thinking');
    setErrorMsg('');

    try {
      const reply = await chatCompletion(currentMessages, userText, s);
      const aiMsg: Message = { role: 'assistant', content: reply, timestamp: Date.now() };
      setMessages(prev => [...prev, aiMsg]);
      speak(reply);
      if (!s.ttsEnabled || !hasTTS) setStatus('idle');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [canChat, s, speak]);

  // ─── Aufnahme starten ──────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    if (status !== 'idle' && status !== 'error') return;
    if (!canSTT) {
      setErrorMsg('Für Spracherkennung wird ein OpenAI API-Key benötigt.');
      setStatus('error');
      return;
    }
    if (!canChat) {
      setErrorMsg(isLocal ? 'Kein lokales Modell gewählt.' : 'Kein API-Key konfiguriert.');
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
  }, [status, canSTT, canChat, isLocal, messages, s, sendMessage]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
  }, []);

  const handleMicClick = useCallback(() => {
    if (status === 'recording') stopRecording();
    else startRecording();
  }, [status, startRecording, stopRecording]);

  const stopSpeaking = useCallback(() => {
    if (hasTTS) window.speechSynthesis.cancel();
    setStatus('idle');
  }, []);

  const handleSendText = useCallback(async () => {
    const text = textInput.trim();
    if (!text) return;
    if (!canChat) {
      setErrorMsg(isLocal ? 'Kein lokales Modell gewählt.' : 'Kein API-Key konfiguriert.');
      setStatus('error');
      return;
    }
    setTextInput('');
    await sendMessage(text, messages);
  }, [textInput, messages, canChat, isLocal, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendText(); }
  }, [handleSendText]);

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

  // Provider-Badge
  const providerBadge = isLocal
    ? { label: '🖥 Lokal', color: '#22c55e', bg: 'rgba(34,197,94,0.1)' }
    : { label: '☁ OpenAI', color: '#818cf8', bg: 'rgba(129,140,248,0.1)' };

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

        {/* Setup-Banner wenn nicht konfiguriert */}
        {!canChat && (
          <div className="whisper-no-key">
            <span>{isLocal ? '🖥' : '🔑'}</span>
            <div style={{ flex: 1 }}>
              <div className="whisper-no-key-title">
                {isLocal ? 'Kein Modell gewählt' : 'OpenAI API-Key fehlt'}
              </div>
              <div className="whisper-no-key-sub">
                {isLocal
                  ? 'Ollama starten und Modell in Einstellungen wählen'
                  : 'API-Key bei platform.openai.com erstellen'}
              </div>
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

        {/* Toolbar */}
        <div className="whisper-toolbar">
          {/* Provider-Badge */}
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
            background: providerBadge.bg, color: providerBadge.color,
            border: `1px solid ${providerBadge.color}40`,
            marginRight: 'auto',
          }}>
            {providerBadge.label}
            {isLocal && s.localModel && (
              <span style={{ opacity: 0.8, fontWeight: 400 }}> · {s.localModel.split(':')[0]}</span>
            )}
            {!isLocal && s.model && (
              <span style={{ opacity: 0.8, fontWeight: 400 }}> · {s.model}</span>
            )}
          </span>
          {isSpeaking && (
            <button className="whisper-toolbar-btn" onClick={stopSpeaking} title="TTS stoppen">
              <VolumeX size={13} /> Stopp
            </button>
          )}
          {messages.length > 0 && (
            <button className="whisper-toolbar-btn whisper-toolbar-btn-danger" onClick={clearChat} title="Chat leeren">
              <Trash2 size={13} /> Leeren
            </button>
          )}
        </div>

        {/* Nachrichten */}
        <div className="whisper-messages" style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {messages.length === 0 && canChat && (
            <div className="whisper-empty">
              <div className="whisper-empty-icon">{isLocal ? '🖥️' : '🎙️'}</div>
              <div className="whisper-empty-text">
                {canSTT
                  ? 'Mikrofon-Button drücken und sprechen,\noder Text eingeben'
                  : isLocal
                    ? 'Lokales Modell bereit – Text eingeben'
                    : 'Text eingeben oder API-Key für Sprache setzen'}
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

        {status === 'error' && errorMsg && (
          <div className="whisper-error">{errorMsg}</div>
        )}
        {status !== 'idle' && status !== 'error' && (
          <div className="whisper-status">{STATUS_LABEL[status]}</div>
        )}

        {/* Eingabe-Zeile */}
        <div className="whisper-input-row">
          <input
            type="text"
            className="whisper-text-input"
            placeholder={!canChat ? 'Nicht konfiguriert…' : 'Nachricht eingeben…'}
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isBusy || isRecording || !canChat}
          />
          <button
            className="whisper-send-btn"
            onClick={handleSendText}
            disabled={!textInput.trim() || isBusy || isRecording || !canChat}
            title="Senden"
          >
            <Send size={15} />
          </button>
          <button
            className={`whisper-mic-btn ${isRecording ? 'recording' : ''}`}
            onClick={handleMicClick}
            disabled={isBusy || !canSTT || !canChat}
            title={!canSTT ? 'OpenAI Key für Mikrofon nötig' : isRecording ? 'Aufnahme stoppen' : 'Sprechen'}
          >
            {isRecording ? <Square size={16} /> : <Mic size={16} />}
          </button>
        </div>
      </div>

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
  const [localKey, setLocalKey]         = useState(settings.apiKey);
  const [localUrl, setLocalUrl]         = useState(settings.localBaseUrl);
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetchError, setFetchError]     = useState('');
  const [fetching, setFetching]         = useState(false);

  useEffect(() => {
    if (open) {
      setLocalKey(settings.apiKey);
      setLocalUrl(settings.localBaseUrl);
      setFetchedModels([]);
      setFetchError('');
    }
  }, [open, settings.apiKey, settings.localBaseUrl]);

  const save = () => {
    updateSettings({ apiKey: localKey.trim(), localBaseUrl: localUrl.trim() });
    onClose();
  };

  const handleFetchModels = async () => {
    setFetching(true);
    setFetchError('');
    setFetchedModels([]);
    try {
      const models = await fetchLocalModels(localUrl);
      setFetchedModels(models);
      if (models.length > 0 && !settings.localModel) {
        updateSettings({ localModel: models[0] });
      }
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : 'Verbindung fehlgeschlagen');
    } finally {
      setFetching(false);
    }
  };

  const langFilter = ({ de: 'de', en: 'en', fr: 'fr', es: 'es', it: 'it' } as Record<string, string>)[settings.language] ?? '';
  const filteredVoices = voices.filter(v => !langFilter || v.lang.toLowerCase().startsWith(langFilter));
  const displayVoices  = filteredVoices.length > 0 ? filteredVoices : voices;

  const modelList = fetchedModels.length > 0 ? fetchedModels : (settings.localModel ? [settings.localModel] : []);

  return (
    <WidgetSettingsDialog
      open={open}
      onClose={onClose}
      onSave={save}
      title="KI-Assistent Einstellungen"
      showFooter
      saveLabel="Speichern"
    >
      {/* Provider wählen */}
      <div className="settings-section">
        <div className="settings-section-title">Provider</div>
        <div className="settings-radio-group">
          <label className={`settings-radio-option ${settings.provider === 'openai' ? 'active' : ''}`}>
            <input type="radio" name="provider" value="openai"
              checked={settings.provider === 'openai'}
              onChange={() => updateSettings({ provider: 'openai' })} />
            ☁ OpenAI (Cloud)
          </label>
          <label className={`settings-radio-option ${settings.provider === 'local' ? 'active' : ''}`}>
            <input type="radio" name="provider" value="local"
              checked={settings.provider === 'local'}
              onChange={() => updateSettings({ provider: 'local' })} />
            🖥 Lokal (Ollama / LM Studio)
          </label>
        </div>
      </div>

      <hr className="settings-divider" />

      {/* Cloud-Einstellungen */}
      {settings.provider === 'openai' && (
        <div className="settings-section">
          <div className="settings-section-title">OpenAI Cloud</div>
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
          <div className="settings-field">
            <label className="settings-label">Modell</label>
            <select className="settings-select" value={settings.model}
              onChange={e => updateSettings({ model: e.target.value })}>
              {OPENAI_MODELS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Local-Einstellungen */}
      {settings.provider === 'local' && (
        <div className="settings-section">
          <div className="settings-section-title">Lokaler Server</div>

          <div className="settings-info-box" style={{ marginBottom: 'var(--spacing-md)' }}>
            <span>💡</span>
            <div>
              Ollama installieren und starten: <strong>ollama serve</strong><br />
              Modell laden: <strong>ollama pull llama3.2</strong>
            </div>
          </div>

          <div className="settings-field">
            <label className="settings-label">Server-URL</label>
            <input
              type="text"
              className="settings-input"
              placeholder="http://localhost:11434/v1"
              value={localUrl}
              onChange={e => setLocalUrl(e.target.value)}
            />
            <div className="settings-description">
              Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1
            </div>
          </div>

          {/* Modelle abrufen */}
          <div className="settings-field">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-xs)' }}>
              <label className="settings-label" style={{ margin: 0, flex: 1 }}>Modell</label>
              <button
                className="settings-btn"
                onClick={handleFetchModels}
                disabled={fetching}
                style={{ fontSize: 11, padding: '3px 10px', gap: 4 }}
              >
                <RefreshCw size={12} style={{ animation: fetching ? 'spin 1s linear infinite' : 'none' }} />
                {fetching ? 'Lade…' : 'Modelle abrufen'}
              </button>
            </div>

            {fetchError && (
              <div className="settings-info-box error" style={{ marginBottom: 'var(--spacing-xs)' }}>
                <span>⚠️</span>
                <span>{fetchError} – Ist der Server gestartet?</span>
              </div>
            )}

            {modelList.length > 0 ? (
              <select className="settings-select" value={settings.localModel}
                onChange={e => updateSettings({ localModel: e.target.value })}>
                <option value="">– Modell wählen –</option>
                {modelList.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '6px 0' }}>
                Klicke „Modelle abrufen" um verfügbare Modelle zu laden.
              </div>
            )}
          </div>
        </div>
      )}

      <hr className="settings-divider" />

      {/* Sprache & System-Prompt */}
      <div className="settings-section">
        <div className="settings-section-title">Allgemein</div>
        <div className="settings-field">
          <label className="settings-label">Sprache (Whisper-STT + TTS)</label>
          <select className="settings-select" value={settings.language}
            onChange={e => updateSettings({ language: e.target.value })}>
            {LANGUAGE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          {settings.provider === 'local' && (
            <div className="settings-description">
              ⚠ Spracherkennung (Mikrofon) benötigt immer einen OpenAI API-Key.
            </div>
          )}
        </div>
        <div className="settings-field">
          <label className="settings-label">System-Prompt</label>
          <textarea
            className="settings-input whisper-prompt-textarea"
            value={settings.systemPrompt}
            onChange={e => updateSettings({ systemPrompt: e.target.value })}
            rows={4}
          />
        </div>
      </div>

      <hr className="settings-divider" />

      {/* TTS */}
      <div className="settings-section">
        <div className="settings-section-title">Sprachausgabe (TTS)</div>
        {!hasTTS && (
          <div className="settings-description" style={{ marginBottom: 'var(--spacing-sm)' }}>
            ⚠ SpeechSynthesis nicht verfügbar.
          </div>
        )}
        <div className="settings-toggle">
          <div>
            <div className="settings-toggle-label">Sprachausgabe aktivieren</div>
            <div className="settings-toggle-sublabel">KI-Antworten laut vorlesen</div>
          </div>
          <label className="toggle-switch">
            <input type="checkbox" checked={settings.ttsEnabled && hasTTS} disabled={!hasTTS}
              onChange={e => updateSettings({ ttsEnabled: e.target.checked })} />
            <span className="toggle-switch-slider" />
          </label>
        </div>

        {settings.ttsEnabled && hasTTS && (
          <>
            <div className="settings-field" style={{ marginTop: 'var(--spacing-md)' }}>
              <label className="settings-label">Stimme</label>
              <select className="settings-select" value={settings.ttsVoice}
                onChange={e => updateSettings({ ttsVoice: e.target.value })}>
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
    description: 'Sprachassistent: OpenAI oder lokale Modelle via Ollama / LM Studio',
    version: '1.1.0',
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
