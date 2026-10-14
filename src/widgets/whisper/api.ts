/**
 * Requests of the KI-Assistent.
 *
 * OpenAI is called directly from the webview (the CSP allows https:), so the
 * recording can be uploaded as multipart and the speech answer comes back as
 * a blob. The local server (Ollama, LM Studio) is reached through the backend
 * (`http_fetch`): no CORS, and the webview CSP does not block its port.
 * The OpenAI key is never sent anywhere but api.openai.com.
 */
import { checkOllama, httpFetch, type HttpFetchResponse } from '../../utils/backend';
import type { WhisperSettings } from '../manifests/whisper';

const OPENAI_API = 'https://api.openai.com/v1';
const OPENAI_TIMEOUT_MS = 60_000;
/** A local model may first have to be loaded into memory – slow on small devices. */
const LOCAL_TIMEOUT_MS = 120_000;
const LOCAL_PROBE_TIMEOUT_MS = 5_000;
/** Earlier messages sent along as context. */
const MAX_HISTORY = 18;
const MAX_ANSWER_TOKENS = 600;
const TEMPERATURE = 0.7;
const TTS_MODEL = 'gpt-4o-mini-tts';
/** Input limit of /v1/audio/speech. */
const TTS_MAX_CHARS = 4096;
const MAX_DETAIL_CHARS = 200;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type ChatSettings = Pick<
  WhisperSettings,
  'provider' | 'apiKey' | 'model' | 'localEndpoint' | 'localModel' | 'systemPrompt'
>;

// ── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when the caller's signal aborted the request (conversation cleared, unmount). */
class RequestAbortedError extends Error {
  constructor() {
    super('Abgebrochen');
    this.name = 'AbortError';
  }
}

export const isAbortError = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';

export const errorMessage = (err: unknown): string => {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return 'Unbekannter Fehler';
};

const shorten = (text: string): string =>
  text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS - 1)}…` : text;

/** `{ error: { message, code } }` (OpenAI, Ollama) or `{ error: "…" }` (LM Studio). */
function errorDetail(body: unknown): { message: string; code: string } {
  if (typeof body !== 'object' || body === null) return { message: '', code: '' };
  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return { message: error, code: '' };
  if (typeof error !== 'object' || error === null) return { message: '', code: '' };
  const { message, code, type } = error as { message?: unknown; code?: unknown; type?: unknown };
  return {
    message: typeof message === 'string' ? message : '',
    code: typeof code === 'string' ? code : typeof type === 'string' ? type : '',
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

async function openAiErrorText(res: Response): Promise<string> {
  const { message, code } = errorDetail(parseJson(await res.text().catch(() => '')));
  switch (res.status) {
    case 401:
      return 'OpenAI: API-Key ungültig oder widerrufen (401) – in den Einstellungen prüfen.';
    case 403:
      return 'OpenAI: Zugriff verweigert (403) – Berechtigungen des API-Keys prüfen.';
    case 404:
      return 'OpenAI: Modell nicht verfügbar (404) – in den Einstellungen ein anderes wählen.';
    case 413:
      return 'OpenAI: Aufnahme zu gross (413) – kürzer sprechen.';
    case 429:
      return code === 'insufficient_quota'
        ? 'OpenAI: Guthaben aufgebraucht (429) – Abrechnung auf platform.openai.com prüfen.'
        : 'OpenAI: Zu viele Anfragen (429) – bitte kurz warten.';
  }
  if (res.status >= 500) return `OpenAI ist gestört (HTTP ${res.status}) – später nochmals versuchen.`;
  return `OpenAI hat die Anfrage abgelehnt (HTTP ${res.status})${message ? `: ${shorten(message)}` : '.'}`;
}

/**
 * POST to the OpenAI API with a 60 s timeout covering the whole exchange
 * (including the body), aborted early by `signal`.
 */
async function openAiPost<T>(
  path: string,
  apiKey: string,
  body: string | FormData,
  signal: AbortSignal,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  if (signal.aborted) throw new RequestAbortedError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, OPENAI_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal.addEventListener('abort', forwardAbort, { once: true });

  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
  // FormData sets its own multipart boundary.
  if (typeof body === 'string') headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(`${OPENAI_API}${path}`, { method: 'POST', headers, body, signal: controller.signal });
    if (!res.ok) throw new Error(await openAiErrorText(res));
    return await read(res);
  } catch (err) {
    if (signal.aborted) throw new RequestAbortedError();
    if (timedOut) {
      throw new Error(`Zeitüberschreitung: OpenAI hat nicht innert ${OPENAI_TIMEOUT_MS / 1000} Sekunden geantwortet.`);
    }
    // fetch() rejects with a TypeError when the network fails.
    if (err instanceof TypeError) throw new Error('OpenAI ist nicht erreichbar – Internetverbindung prüfen.');
    throw err;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', forwardAbort);
  }
}

async function readOpenAiJson(res: Response): Promise<unknown> {
  const data = parseJson(await res.text());
  if (data === null) throw new Error('OpenAI hat eine ungültige Antwort geliefert.');
  return data;
}

// ── Chat ─────────────────────────────────────────────────────────────────────

function chatMessages(history: readonly ChatMessage[], systemPrompt: string) {
  const recent = history.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  return systemPrompt ? [{ role: 'system' as const, content: systemPrompt }, ...recent] : recent;
}

const THINK_OPEN_RE = /<think>/i;
const THINK_CLOSE_RE = /<\/think>/i;

/**
 * Removes the reasoning of local models (qwen3, deepseek-r1 …) from an answer:
 * complete <think>…</think> blocks, a block cut off by the token limit (no
 * closing tag) and reasoning whose opening tag sat in the chat template (only
 * the closing tag arrives). Returns '' when nothing but reasoning is left.
 */
export function stripReasoning(content: string): string {
  let text = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const lastClose = text.search(/<\/think>(?![\s\S]*<\/think>)/i);
  if (lastClose !== -1) text = text.slice(lastClose + '</think>'.length);
  const open = text.search(THINK_OPEN_RE);
  if (open !== -1) text = text.slice(0, open);
  return text.trim();
}

/** `choices[0].message.content` of a chat completion, without reasoning blocks of local models. */
function replyText(data: unknown, source: string): string {
  const choices = (data as { choices?: unknown } | null)?.choices;
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const content = (first as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (typeof content !== 'string') throw new Error(`${source} hat eine ungültige Antwort geliefert.`);
  const text = stripReasoning(content);
  if (!text && (THINK_OPEN_RE.test(content) || THINK_CLOSE_RE.test(content))) {
    throw new Error(
      `${source}: Das Modell hat nur nachgedacht und keine Antwort geliefert – in den Einstellungen ein Modell ohne Denkmodus wählen.`,
    );
  }
  if (!text) throw new Error(`${source} hat eine leere Antwort geliefert.`);
  return text;
}

/** Sends the conversation (its last entry is the new user message) and returns the answer. */
export function chatCompletion(
  history: readonly ChatMessage[],
  settings: ChatSettings,
  signal: AbortSignal,
): Promise<string> {
  const messages = chatMessages(history, settings.systemPrompt);
  if (settings.provider === 'lokal') return localChat(messages, settings, signal);
  const body = JSON.stringify({
    model: settings.model,
    messages,
    max_completion_tokens: MAX_ANSWER_TOKENS,
    temperature: TEMPERATURE,
  });
  return openAiPost('/chat/completions', settings.apiKey, body, signal, async (res) =>
    replyText(await readOpenAiJson(res), 'OpenAI'),
  );
}

// ── Local server (Ollama / LM Studio) ────────────────────────────────────────

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

export interface LocalEndpoint {
  /** OpenAI-compatible API root, e.g. http://localhost:11434/v1 */
  apiBase: string;
  host: string;
  /** Runs on this device. */
  onDevice: boolean;
}

/** Accepts http://host:port, …/v1, …/api or the full …/v1/chat/completions address. */
export function parseLocalEndpoint(endpoint: string): LocalEndpoint {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error('Keine Server-Adresse eingetragen.');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Ungültige Server-Adresse: ${trimmed}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Die Server-Adresse muss mit http:// oder https:// beginnen.');
  }
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|models)$/, '');
  if (path.endsWith('/api')) path = path.slice(0, -'/api'.length);
  if (!path.endsWith('/v1')) path = `${path}/v1`;
  return {
    apiBase: `${url.origin}${path}`,
    host: url.host,
    onDevice: LOCAL_HOSTNAMES.has(url.hostname.toLowerCase()),
  };
}

function localErrorText(res: HttpFetchResponse, model: string): string {
  const { message } = errorDetail(parseJson(res.body));
  if (/model/i.test(message) && /not found|does not exist|nicht gefunden|no such/i.test(message)) {
    return `Modell «${model}» ist auf dem Server nicht vorhanden – mit «ollama pull ${model}» laden oder in den Einstellungen ein anderes wählen.`;
  }
  if (res.status === 404) return 'Lokaler KI-Server: Endpunkt nicht gefunden (404) – Server-Adresse prüfen.';
  return `Lokaler KI-Server meldet einen Fehler (HTTP ${res.status})${message ? `: ${shorten(message)}` : '.'}`;
}

async function localChat(
  messages: ReturnType<typeof chatMessages>,
  settings: ChatSettings,
  signal: AbortSignal,
): Promise<string> {
  const endpoint = parseLocalEndpoint(settings.localEndpoint);
  let res: HttpFetchResponse;
  try {
    // http_fetch cannot be cancelled; an aborted turn just ignores the late answer.
    res = await httpFetch({
      url: `${endpoint.apiBase}/chat/completions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        model: settings.localModel,
        messages,
        max_tokens: MAX_ANSWER_TOKENS,
        temperature: TEMPERATURE,
        stream: false,
      }),
      timeoutMs: LOCAL_TIMEOUT_MS,
    });
  } catch (err) {
    if (signal.aborted) throw new RequestAbortedError();
    const detail = errorMessage(err);
    if (detail.includes('Zeitüberschreitung')) {
      throw new Error(`Zeitüberschreitung: Das lokale Modell hat nicht innert ${LOCAL_TIMEOUT_MS / 1000} Sekunden geantwortet.`);
    }
    if (detail.includes('keine Verbindung')) {
      throw new Error(`Lokaler KI-Server (${endpoint.host}) nicht erreichbar – läuft Ollama bzw. LM Studio?`);
    }
    throw new Error(`Lokaler KI-Server (${endpoint.host}): ${detail}`);
  }
  if (signal.aborted) throw new RequestAbortedError();
  if (res.status < 200 || res.status >= 300) throw new Error(localErrorText(res, settings.localModel));
  return replyText(parseJson(res.body), 'Der lokale KI-Server');
}

export interface LocalServerStatus {
  reachable: boolean;
  /** 'ollama': Ollama API answers; 'kompatibel': only the OpenAI-compatible API (e.g. LM Studio). */
  kind: 'ollama' | 'kompatibel' | null;
  version: string | null;
  models: string[];
  /** Ollama is installed on this device but does not answer. */
  installedNotRunning: boolean;
  host: string;
  onDevice: boolean;
}

async function listCompatibleModels(apiBase: string): Promise<string[]> {
  const res = await httpFetch({
    url: `${apiBase}/models`,
    headers: { Accept: 'application/json' },
    timeoutMs: LOCAL_PROBE_TIMEOUT_MS,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  const data = (parseJson(res.body) as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('keine Modell-Liste');
  const ids = data
    .map((entry) => (entry as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** Asks the configured server for its status and installed models (Ollama API, else /v1/models). */
export async function probeLocalServer(endpoint: string): Promise<LocalServerStatus> {
  const parsed = parseLocalEndpoint(endpoint);
  const base = { host: parsed.host, onDevice: parsed.onDevice };
  const [ollama, compatible] = await Promise.allSettled([
    checkOllama(parsed.apiBase),
    listCompatibleModels(parsed.apiBase),
  ]);
  if (ollama.status === 'fulfilled' && ollama.value.running) {
    const { version, models } = ollama.value;
    return { ...base, reachable: true, kind: 'ollama', version, models, installedNotRunning: false };
  }
  if (compatible.status === 'fulfilled') {
    return { ...base, reachable: true, kind: 'kompatibel', version: null, models: compatible.value, installedNotRunning: false };
  }
  // E.g. outside the kiosk – there is no answer to show.
  if (ollama.status === 'rejected') throw ollama.reason;
  return {
    ...base,
    reachable: false,
    kind: null,
    version: null,
    models: [],
    installedNotRunning: ollama.value.installed,
  };
}

// ── Speech (OpenAI) ──────────────────────────────────────────────────────────

/** File extension OpenAI expects for the recorder's MIME type (it detects the format by name). */
export function audioExtension(mimeType: string): string {
  const type = mimeType.split(';')[0].trim().toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg') || type.includes('opus')) return 'ogg';
  if (type.includes('mp4') || type.includes('m4a')) return 'mp4';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  if (type.includes('flac')) return 'flac';
  return 'webm';
}

export function transcribe(
  audio: Blob,
  mimeType: string,
  settings: Pick<WhisperSettings, 'apiKey' | 'transcriptionModel' | 'language'>,
  signal: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append('file', audio, `aufnahme.${audioExtension(mimeType)}`);
  form.append('model', settings.transcriptionModel);
  form.append('response_format', 'json');
  if (settings.language) form.append('language', settings.language);
  return openAiPost('/audio/transcriptions', settings.apiKey, form, signal, async (res) => {
    const text = (await readOpenAiJson(res) as { text?: unknown }).text;
    if (typeof text !== 'string') throw new Error('OpenAI hat eine ungültige Antwort geliefert.');
    return text.trim();
  });
}

/** Spoken answer as an MP3 blob. */
export function synthesizeSpeech(
  text: string,
  settings: Pick<WhisperSettings, 'apiKey' | 'ttsVoice'>,
  signal: AbortSignal,
): Promise<Blob> {
  const body = JSON.stringify({
    model: TTS_MODEL,
    voice: settings.ttsVoice,
    input: text.slice(0, TTS_MAX_CHARS),
    response_format: 'mp3',
  });
  return openAiPost('/audio/speech', settings.apiKey, body, signal, async (res) => {
    const blob = await res.blob();
    if (blob.size === 0) throw new Error('OpenAI hat eine leere Sprachausgabe geliefert.');
    return blob.type.startsWith('audio/') ? blob : new Blob([blob], { type: 'audio/mpeg' });
  });
}
