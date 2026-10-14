import { describe, expect, it } from 'vitest';
import { whisperDefaultSettings } from '../manifests/whisper';
import { audioExtension, parseLocalEndpoint, stripReasoning } from './api';
import { legacyWhisperPatch, normalizeWhisperSettings } from './settings';

/** What useWidgetSettings hands over: defaults merged with the stored values. */
const merged = (stored: Record<string, unknown>): Record<string, unknown> => ({ ...whisperDefaultSettings, ...stored });

describe('normalizeWhisperSettings', () => {
  it('returns the defaults for an empty instance', () => {
    expect(normalizeWhisperSettings(merged({}), undefined)).toEqual(whisperDefaultSettings);
  });

  it('reads the settings of the pre-2.0 widget until they are migrated', () => {
    const stored = {
      provider: 'local',
      localBaseUrl: ' http://192.168.1.50:11434/v1 ',
      model: 'gpt-3.5-turbo',
      ttsVoice: 'Microsoft Hedda',
      apiKey: ' sk-test ',
    };
    const settings = normalizeWhisperSettings(merged(stored), stored);
    expect(settings.provider).toBe('lokal');
    expect(settings.localEndpoint).toBe('http://192.168.1.50:11434/v1');
    expect(settings.model).toBe(whisperDefaultSettings.model);
    expect(settings.ttsVoice).toBe(whisperDefaultSettings.ttsVoice);
    expect(settings.apiKey).toBe('sk-test');
  });

  it('prefers a stored localEndpoint over the legacy key', () => {
    const stored = { localEndpoint: 'http://ki.local:1234', localBaseUrl: 'http://localhost:11434/v1' };
    expect(normalizeWhisperSettings(merged(stored), stored).localEndpoint).toBe('http://ki.local:1234');
  });

  it('clamps numbers, cleans quick prompts and ignores the redaction placeholder', () => {
    const stored = {
      maxRecordSeconds: 999,
      autoClearMinutes: -3,
      quickPrompts: ['  Wetter? ', '', 42, 'Witz'],
      apiKey: '__gesetzt__',
      language: 'xx',
    };
    const settings = normalizeWhisperSettings(merged(stored), stored);
    expect(settings.maxRecordSeconds).toBe(120);
    expect(settings.autoClearMinutes).toBe(0);
    expect(settings.quickPrompts).toEqual(['Wetter?', 'Witz']);
    expect(settings.apiKey).toBe('');
    expect(settings.language).toBe(whisperDefaultSettings.language);
  });
});

describe('legacyWhisperPatch', () => {
  it('renames and drops the old keys in one patch', () => {
    expect(
      legacyWhisperPatch({
        provider: 'local',
        localBaseUrl: 'http://localhost:11434/v1',
        model: 'gpt-4-turbo',
        ttsVoice: '',
        ttsRate: 1,
        ttsPitch: 1,
        wakeWordEnabled: false,
        wakeWord: 'hey slate',
        apiKey: 'sk-test',
      }),
    ).toStrictEqual({
      provider: 'lokal',
      localEndpoint: 'http://localhost:11434/v1',
      localBaseUrl: undefined,
      model: undefined,
      ttsVoice: undefined,
      ttsRate: undefined,
      ttsPitch: undefined,
      wakeWordEnabled: undefined,
      wakeWord: undefined,
    });
  });

  it('leaves current settings alone', () => {
    expect(legacyWhisperPatch(undefined)).toBeNull();
    expect(legacyWhisperPatch({ ...whisperDefaultSettings })).toBeNull();
  });
});

describe('parseLocalEndpoint', () => {
  it('derives the OpenAI-compatible API root', () => {
    for (const [input, apiBase] of [
      ['http://localhost:11434', 'http://localhost:11434/v1'],
      ['http://localhost:11434/', 'http://localhost:11434/v1'],
      ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
      ['http://localhost:11434/api', 'http://localhost:11434/v1'],
      ['http://localhost:1234/v1/chat/completions', 'http://localhost:1234/v1'],
      [' https://ki.example.ch/ollama/v1/models ', 'https://ki.example.ch/ollama/v1'],
    ]) {
      expect(parseLocalEndpoint(input).apiBase, input).toBe(apiBase);
    }
  });

  it('knows whether the server runs on the device', () => {
    expect(parseLocalEndpoint('http://127.0.0.1:11434').onDevice).toBe(true);
    expect(parseLocalEndpoint('http://[::1]:11434').onDevice).toBe(true);
    expect(parseLocalEndpoint('http://192.168.1.50:11434').onDevice).toBe(false);
  });

  it('rejects unusable addresses with German errors', () => {
    expect(() => parseLocalEndpoint('')).toThrow('Keine Server-Adresse');
    expect(() => parseLocalEndpoint('localhost:11434')).toThrow('http://');
    expect(() => parseLocalEndpoint('nicht gültig')).toThrow('Ungültige Server-Adresse');
  });
});

describe('audioExtension', () => {
  it('names the upload after the format the recorder produced', () => {
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('audio/ogg; codecs=opus')).toBe('ogg');
    expect(audioExtension('audio/mp4')).toBe('mp4');
    expect(audioExtension('audio/mpeg')).toBe('mp3');
    expect(audioExtension('audio/wav')).toBe('wav');
    expect(audioExtension('')).toBe('webm');
  });
});

describe('stripReasoning', () => {
  it('removes complete reasoning blocks', () => {
    expect(stripReasoning('<think>\nOkay, the user wants …\n</think>\n\nEs ist 14 Uhr.')).toBe('Es ist 14 Uhr.');
  });

  it('drops a block the token limit cut off', () => {
    expect(stripReasoning('<think>\nOkay, the user wants to know')).toBe('');
    expect(stripReasoning('Kurz: ja. <think>Let me double-check')).toBe('Kurz: ja.');
  });

  it('drops reasoning whose opening tag was part of the chat template', () => {
    expect(stripReasoning('Okay, the user asks …\n</think>\n\nJa, morgen regnet es.')).toBe('Ja, morgen regnet es.');
  });

  it('leaves normal answers alone', () => {
    expect(stripReasoning('  Hallo!  ')).toBe('Hallo!');
  });
});
