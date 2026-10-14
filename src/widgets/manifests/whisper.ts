import type { WidgetManifest } from '../../types/widget';
import type { SettingsField } from '../../types/settings';

/**
 * KI-Assistent – chat with OpenAI or a local OpenAI-compatible server
 * (Ollama, LM Studio). Speech input and output always use OpenAI, so they
 * need the API key also with the local provider.
 */
export type WhisperProvider = 'openai' | 'lokal';
export type WhisperTranscriptionModel = 'whisper-1' | 'gpt-4o-mini-transcribe';
export type WhisperVoice = 'alloy' | 'echo' | 'fable' | 'nova' | 'onyx' | 'shimmer';

export type WhisperSettings = {
  provider: WhisperProvider;
  /** OpenAI only – never sent to the local server. */
  apiKey: string;
  /** OpenAI chat model. */
  model: string;
  /**
   * Base address of the local server, e.g. http://localhost:11434 (with or
   * without /v1). Deliberately not named …Url: the backend clears sibling
   * secrets when a *url key changes over HTTP, which would drop the apiKey.
   */
  localEndpoint: string;
  localModel: string;
  transcriptionModel: WhisperTranscriptionModel;
  /** ISO 639-1 code for speech recognition; '' = detect automatically. */
  language: string;
  systemPrompt: string;
  ttsEnabled: boolean;
  ttsVoice: WhisperVoice;
  maxRecordSeconds: number;
  /** Clear the conversation after this many minutes without activity; 0 = never. */
  autoClearMinutes: number;
  quickPrompts: string[];
};

export const WHISPER_CHAT_MODELS: readonly { value: string; label: string }[] = [
  { value: 'gpt-4o-mini', label: 'GPT-4o mini (schnell, günstig)' },
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 mini' },
  { value: 'gpt-4.1', label: 'GPT-4.1 (am leistungsfähigsten)' },
];

export const WHISPER_TRANSCRIPTION_MODELS: readonly { value: WhisperTranscriptionModel; label: string }[] = [
  { value: 'whisper-1', label: 'Whisper' },
  { value: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe (genauer)' },
];

export const WHISPER_LANGUAGES: readonly { value: string; label: string }[] = [
  { value: 'de', label: 'Deutsch' },
  { value: 'fr', label: 'Französisch' },
  { value: 'it', label: 'Italienisch' },
  { value: 'en', label: 'Englisch' },
  { value: 'es', label: 'Spanisch' },
  { value: '', label: 'Automatisch erkennen' },
];

export const WHISPER_VOICES: readonly { value: WhisperVoice; label: string }[] = [
  { value: 'nova', label: 'Nova' },
  { value: 'alloy', label: 'Alloy' },
  { value: 'echo', label: 'Echo' },
  { value: 'fable', label: 'Fable' },
  { value: 'onyx', label: 'Onyx' },
  { value: 'shimmer', label: 'Shimmer' },
];

export const WHISPER_RECORD_MIN_SECONDS = 5;
export const WHISPER_RECORD_MAX_SECONDS = 120;
export const WHISPER_AUTO_CLEAR_MAX_MINUTES = 240;
export const WHISPER_MAX_QUICK_PROMPTS = 12;

const WHISPER_DEFAULT_ENDPOINT = 'http://localhost:11434';
export const WHISPER_SUGGESTED_LOCAL_MODEL = 'llama3.2';

export const whisperDefaultSettings: WhisperSettings = {
  provider: 'openai',
  apiKey: '',
  model: 'gpt-4o-mini',
  localEndpoint: WHISPER_DEFAULT_ENDPOINT,
  localModel: '',
  transcriptionModel: 'whisper-1',
  language: 'de',
  systemPrompt:
    'Du bist Slate, ein hilfreicher und freundlicher Assistent. Antworte kurz und prägnant, ' +
    'wenn möglich in höchstens drei Sätzen. Verwende Schweizer Rechtschreibung (ss statt ß) ' +
    'und kein Markdown, da die Antwort auch vorgelesen wird.',
  ttsEnabled: true,
  ttsVoice: 'nova',
  maxRecordSeconds: 30,
  autoClearMinutes: 5,
  quickPrompts: [],
};

const isLocal = (values: Record<string, unknown>): boolean => values.provider === 'lokal';

const whisperSettingsSchema: SettingsField[] = [
  { type: 'section', label: 'KI-Anbieter' },
  {
    key: 'provider',
    type: 'radio',
    label: 'Anbieter',
    options: [
      { value: 'openai', label: 'OpenAI (Cloud)' },
      { value: 'lokal', label: 'Lokal (Ollama / LM Studio)' },
    ],
  },
  {
    key: 'apiKey',
    type: 'secret',
    label: 'OpenAI API-Key',
    placeholder: 'sk-…',
    description:
      'Erstellen unter platform.openai.com → API keys. Beim lokalen Anbieter optional: nur für Spracheingabe ' +
      'und Sprachausgabe – der Key wird nie an den lokalen Server gesendet.',
  },
  {
    key: 'model',
    type: 'select',
    label: 'Modell',
    options: [...WHISPER_CHAT_MODELS],
    showIf: (values) => !isLocal(values),
  },
  {
    key: 'localEndpoint',
    type: 'url',
    label: 'Server-Adresse',
    placeholder: WHISPER_DEFAULT_ENDPOINT,
    description: 'Ollama: http://localhost:11434 · LM Studio: http://localhost:1234 – auch ein Rechner im LAN ist möglich.',
    showIf: isLocal,
  },
  {
    key: 'localModel',
    type: 'text',
    label: 'Lokales Modell',
    placeholder: `z. B. ${WHISPER_SUGGESTED_LOCAL_MODEL}`,
    description: 'Am Kiosk unten aus der Liste der installierten Modelle wählen.',
    showIf: isLocal,
  },

  { type: 'section', label: 'Spracheingabe', description: 'Läuft über OpenAI und braucht den API-Key.' },
  {
    key: 'transcriptionModel',
    type: 'select',
    label: 'Spracherkennung',
    options: [...WHISPER_TRANSCRIPTION_MODELS],
  },
  { key: 'language', type: 'select', label: 'Sprache', options: [...WHISPER_LANGUAGES] },
  {
    key: 'maxRecordSeconds',
    type: 'number',
    label: 'Maximale Aufnahmedauer',
    description: 'Danach stoppt die Aufnahme automatisch.',
    min: WHISPER_RECORD_MIN_SECONDS,
    max: WHISPER_RECORD_MAX_SECONDS,
    step: 5,
    unit: 's',
  },

  { type: 'section', label: 'Sprachausgabe' },
  {
    key: 'ttsEnabled',
    type: 'boolean',
    label: 'Antworten vorlesen',
    description: 'Über OpenAI – braucht den API-Key.',
  },
  {
    key: 'ttsVoice',
    type: 'select',
    label: 'Stimme',
    options: [...WHISPER_VOICES],
    showIf: (values) => values.ttsEnabled === true,
  },

  { type: 'section', label: 'Gespräch' },
  {
    key: 'systemPrompt',
    type: 'textarea',
    label: 'Anweisung an den Assistenten',
    description: 'Wird jeder Unterhaltung vorangestellt (System-Prompt).',
  },
  {
    key: 'quickPrompts',
    type: 'stringList',
    label: 'Schnellfragen',
    description: 'Erscheinen als Knöpfe im Widget.',
    placeholder: 'z. B. Erzähl mir einen Witz',
    addLabel: 'Frage hinzufügen',
  },
  {
    key: 'autoClearMinutes',
    type: 'number',
    label: 'Gespräch leeren nach',
    description: 'Minuten ohne Aktivität, danach wird die Unterhaltung gelöscht. 0 = nie.',
    min: 0,
    max: WHISPER_AUTO_CLEAR_MAX_MINUTES,
    step: 1,
    unit: 'min',
  },
];

export const whisperManifest: WidgetManifest = {
  id: 'whisper',
  name: 'KI-Assistent',
  description: 'Sprach- und Textassistent mit OpenAI oder lokalen Modellen (Ollama / LM Studio)',
  version: '2.0.0',
  author: 'SlateDesk',
  category: 'Sensorik & KI',
  icon: 'Bot',
  minWidth: 3,
  minHeight: 4,
  defaultWidth: 4,
  defaultHeight: 7,
  permissions: ['microphone'],
  settingsSchema: whisperSettingsSchema,
  defaultSettings: whisperDefaultSettings,
};
