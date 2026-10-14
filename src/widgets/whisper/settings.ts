/**
 * Settings of the KI-Assistent: runtime normalization (values may come from
 * the web UI, an import or the pre-2.0 widget) and the one-time rename of
 * legacy keys.
 */
import { useMemo } from 'react';
import { useAppState } from '../../state/appState';
import { useWidgetSettings } from '../../hooks/useWidgetSettings';
import { REDACTED_SECRET } from '../../types/settings';
import {
  WHISPER_AUTO_CLEAR_MAX_MINUTES,
  WHISPER_CHAT_MODELS,
  WHISPER_LANGUAGES,
  WHISPER_MAX_QUICK_PROMPTS,
  WHISPER_RECORD_MAX_SECONDS,
  WHISPER_RECORD_MIN_SECONDS,
  WHISPER_TRANSCRIPTION_MODELS,
  WHISPER_VOICES,
  whisperDefaultSettings,
  type WhisperSettings,
  type WhisperTranscriptionModel,
  type WhisperVoice,
} from '../manifests/whisper';

/** Keys of the pre-2.0 widget (browser TTS and wake word – neither exists in WebKitGTK). */
const OBSOLETE_KEYS = ['ttsRate', 'ttsPitch', 'wakeWordEnabled', 'wakeWord'] as const;

const isChatModel = (value: unknown): value is string => WHISPER_CHAT_MODELS.some((m) => m.value === value);
const isTranscriptionModel = (value: unknown): value is WhisperTranscriptionModel =>
  WHISPER_TRANSCRIPTION_MODELS.some((m) => m.value === value);
const isVoice = (value: unknown): value is WhisperVoice => WHISPER_VOICES.some((v) => v.value === value);
const isLanguage = (value: unknown): value is string => WHISPER_LANGUAGES.some((l) => l.value === value);

const text = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

function wholeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Effective settings. `stored` (the raw instance settings) is only consulted
 * for legacy keys, until the widget has migrated them.
 */
export function normalizeWhisperSettings(
  merged: Record<string, unknown>,
  stored: Record<string, unknown> | undefined,
): WhisperSettings {
  const d = whisperDefaultSettings;
  const legacyEndpoint =
    stored && typeof stored.localEndpoint !== 'string' && typeof stored.localBaseUrl === 'string'
      ? stored.localBaseUrl
      : null;
  const apiKey = text(merged.apiKey, '').trim();

  return {
    provider: merged.provider === 'lokal' || merged.provider === 'local' ? 'lokal' : 'openai',
    // The kiosk always gets the real value; the placeholder would only be an unusable key.
    apiKey: apiKey === REDACTED_SECRET ? '' : apiKey,
    model: isChatModel(merged.model) ? merged.model : d.model,
    localEndpoint: (legacyEndpoint ?? text(merged.localEndpoint, d.localEndpoint)).trim(),
    localModel: text(merged.localModel, '').trim(),
    transcriptionModel: isTranscriptionModel(merged.transcriptionModel) ? merged.transcriptionModel : d.transcriptionModel,
    language: isLanguage(merged.language) ? merged.language : d.language,
    systemPrompt: text(merged.systemPrompt, d.systemPrompt).trim(),
    ttsEnabled: typeof merged.ttsEnabled === 'boolean' ? merged.ttsEnabled : d.ttsEnabled,
    ttsVoice: isVoice(merged.ttsVoice) ? merged.ttsVoice : d.ttsVoice,
    maxRecordSeconds: wholeNumber(
      merged.maxRecordSeconds,
      d.maxRecordSeconds,
      WHISPER_RECORD_MIN_SECONDS,
      WHISPER_RECORD_MAX_SECONDS,
    ),
    autoClearMinutes: wholeNumber(merged.autoClearMinutes, d.autoClearMinutes, 0, WHISPER_AUTO_CLEAR_MAX_MINUTES),
    quickPrompts: Array.isArray(merged.quickPrompts)
      ? merged.quickPrompts
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
          .filter(Boolean)
          .slice(0, WHISPER_MAX_QUICK_PROMPTS)
      : [],
  };
}

/**
 * Patch that renames / drops the keys of the pre-2.0 widget, or null when
 * there is nothing to migrate. `undefined` values delete the key.
 */
export function legacyWhisperPatch(stored: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!stored) return null;
  const patch: Record<string, unknown> = {};
  if ('localBaseUrl' in stored) {
    if (typeof stored.localEndpoint !== 'string' && typeof stored.localBaseUrl === 'string') {
      patch.localEndpoint = stored.localBaseUrl.trim();
    }
    patch.localBaseUrl = undefined;
  }
  if (stored.provider === 'local') patch.provider = 'lokal';
  if ('model' in stored && !isChatModel(stored.model)) patch.model = undefined;
  // Browser voice names of the old speechSynthesis path.
  if ('ttsVoice' in stored && !isVoice(stored.ttsVoice)) patch.ttsVoice = undefined;
  for (const key of OBSOLETE_KEYS) if (key in stored) patch[key] = undefined;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** Normalized settings of one instance plus the (stable) update function. */
export function useWhisperSettings(
  instanceId: string,
): [WhisperSettings, (patch: Partial<WhisperSettings>) => void, Record<string, unknown> | undefined] {
  const [merged, update] = useWidgetSettings(instanceId, whisperDefaultSettings);
  const stored = useAppState((s) => s.state.widgetSettings[instanceId]);
  const settings = useMemo(
    () => normalizeWhisperSettings(merged as unknown as Record<string, unknown>, stored),
    [merged, stored],
  );
  return [settings, update, stored];
}
