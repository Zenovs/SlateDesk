/**
 * Open-Meteo client for the weather widget (keyless). Every request goes
 * through the Rust backend (`http_fetch`), so neither CORS nor the CSP apply.
 *
 * - Forecast: the chosen model plus `best_match` as per-value fallback –
 *   MeteoSwiss ICON-CH2 only covers the Alpine region and 5 days and has no
 *   UV index, so later days and missing values come from the fallback.
 * - Geocoding: searched in several languages at once, because Open-Meteo
 *   only matches names of the requested language («Sion» exists in the
 *   French index, the German one only knows «Sitten»).
 * - IP location: ipapi.co, fallback ipwho.is (both rate-limited; the widget
 *   caches the result in its settings).
 * - Air quality: European AQI and pollen (CAMS, Europe only).
 */
import { httpFetch } from '../../utils/backend';
import type { WeatherGeo, WeatherModel } from '../manifests/weather';

const REQUEST_TIMEOUT_MS = 12_000;
const FALLBACK_MODEL = 'best_match';

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

const errorMessage = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : typeof err === 'string' && err ? err : 'Unbekannter Fehler';

async function getJson(url: string, service: string, signal: AbortSignal): Promise<Json> {
  let response;
  try {
    response = await httpFetch({ url, timeoutMs: REQUEST_TIMEOUT_MS, headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(`${service}: ${errorMessage(err)}`);
  }
  signal.throwIfAborted();

  let body: unknown = null;
  try {
    body = JSON.parse(response.body);
  } catch {
    // Reported below – error pages are often HTML.
  }
  if (response.status === 429) throw new Error(`${service}: zu viele Anfragen, später erneut versuchen`);
  if (response.status < 200 || response.status >= 300) {
    const reason = isRecord(body) && typeof body.reason === 'string' ? body.reason : '';
    const detail = /no data is available/i.test(reason) ? ' – keine Daten für diesen Ort' : '';
    throw new Error(`${service} antwortet mit HTTP ${response.status}${detail}`);
  }
  if (!isRecord(body)) throw new Error(`${service}: unerwartete Antwort`);
  return body;
}

// ── WMO weather codes ────────────────────────────────────────────────────────

export type WeatherIconKind =
  | 'clear'
  | 'partlyCloudy'
  | 'overcast'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'heavyRain'
  | 'freezing'
  | 'snow'
  | 'showers'
  | 'snowShowers'
  | 'thunder'
  | 'unknown';

export interface WeatherCondition {
  label: string;
  icon: WeatherIconKind;
}

/** All codes Open-Meteo uses (WMO 4677 subset). */
const WMO_CODES: Readonly<Record<number, WeatherCondition>> = {
  0: { label: 'Klar', icon: 'clear' },
  1: { label: 'Überwiegend klar', icon: 'partlyCloudy' },
  2: { label: 'Teilweise bewölkt', icon: 'partlyCloudy' },
  3: { label: 'Bedeckt', icon: 'overcast' },
  45: { label: 'Nebel', icon: 'fog' },
  48: { label: 'Nebel mit Raureif', icon: 'fog' },
  51: { label: 'Leichter Nieselregen', icon: 'drizzle' },
  53: { label: 'Nieselregen', icon: 'drizzle' },
  55: { label: 'Starker Nieselregen', icon: 'drizzle' },
  56: { label: 'Leichter gefrierender Nieselregen', icon: 'freezing' },
  57: { label: 'Gefrierender Nieselregen', icon: 'freezing' },
  61: { label: 'Leichter Regen', icon: 'rain' },
  63: { label: 'Regen', icon: 'rain' },
  65: { label: 'Starker Regen', icon: 'heavyRain' },
  66: { label: 'Leichter Eisregen', icon: 'freezing' },
  67: { label: 'Eisregen', icon: 'freezing' },
  71: { label: 'Leichter Schneefall', icon: 'snow' },
  73: { label: 'Schneefall', icon: 'snow' },
  75: { label: 'Starker Schneefall', icon: 'snow' },
  77: { label: 'Schneegriesel', icon: 'snow' },
  80: { label: 'Leichte Regenschauer', icon: 'showers' },
  81: { label: 'Regenschauer', icon: 'showers' },
  82: { label: 'Heftige Regenschauer', icon: 'heavyRain' },
  85: { label: 'Leichte Schneeschauer', icon: 'snowShowers' },
  86: { label: 'Starke Schneeschauer', icon: 'snowShowers' },
  95: { label: 'Gewitter', icon: 'thunder' },
  96: { label: 'Gewitter mit Hagel', icon: 'thunder' },
  99: { label: 'Gewitter mit starkem Hagel', icon: 'thunder' },
};

const UNKNOWN_CONDITION: WeatherCondition = { label: 'Unbekannt', icon: 'unknown' };

export const describeWeather = (code: number | null): WeatherCondition =>
  (code !== null && WMO_CODES[code]) || UNKNOWN_CONDITION;

// ── Forecast ─────────────────────────────────────────────────────────────────

export interface WeatherCurrent {
  /** Local time of the location, 'YYYY-MM-DDTHH:MM'. */
  time: string;
  temperature: number | null;
  apparentTemperature: number | null;
  humidity: number | null;
  /** km/h */
  windSpeed: number | null;
  windGusts: number | null;
  /** Degrees, direction the wind comes from. */
  windDirection: number | null;
  weatherCode: number | null;
  isDay: boolean;
}

export interface WeatherHour {
  /** Local 'YYYY-MM-DDTHH:MM'. */
  time: string;
  temperature: number | null;
  precipitationProbability: number | null;
  weatherCode: number | null;
  isDay: boolean;
}

export interface WeatherDay {
  /** Local 'YYYY-MM-DD'. */
  date: string;
  weatherCode: number | null;
  tempMax: number | null;
  tempMin: number | null;
  precipitationSum: number | null;
  precipitationProbability: number | null;
  /** Local 'YYYY-MM-DDTHH:MM'. */
  sunrise: string | null;
  sunset: string | null;
  uvIndexMax: number | null;
}

export interface WeatherForecast {
  /** IANA zone of the location (e.g. 'Europe/Zurich'); null if missing. */
  timezone: string | null;
  utcOffsetSeconds: number;
  current: WeatherCurrent;
  hours: WeatherHour[];
  days: WeatherDay[];
  /** Whether the shown values come from MeteoSwiss (attribution). */
  meteoSwiss: boolean;
}

/** The setting allows up to 7; fetching all keeps the slider free of refetches. */
const FORECAST_DAYS = 7;
const CURRENT_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'is_day',
  'weather_code',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
];
const HOURLY_VARS = ['temperature_2m', 'precipitation_probability', 'weather_code', 'is_day'];
const DAILY_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'sunrise',
  'sunset',
  'uv_index_max',
];

/**
 * Arrays for `key` in fallback order. With several models Open-Meteo suffixes
 * every key with the model name; when only one model has data for the place
 * (e.g. ICON-CH2 outside its domain) the keys come without suffix.
 */
function candidates(block: Json | undefined, key: string, models: readonly string[]): unknown[][] {
  const out: unknown[][] = [];
  for (const model of models) {
    const series = block?.[`${key}_${model}`];
    if (Array.isArray(series)) out.push(series);
  }
  const plain = block?.[key];
  if (Array.isArray(plain)) out.push(plain);
  return out;
}

function numberAt(series: unknown[][], index: number): number | null {
  for (const values of series) {
    const value = finite(values[index]);
    if (value !== null) return value;
  }
  return null;
}

function stringAt(series: unknown[][], index: number): string | null {
  for (const values of series) {
    const value = text(values[index]);
    if (value !== null) return value;
  }
  return null;
}

/** First non-null value of `key` in the `current` block (plain or per model). */
function currentValue(block: Json | undefined, key: string, models: readonly string[]): number | null {
  for (const name of [key, ...models.map((model) => `${key}_${model}`)]) {
    const value = finite(block?.[name]);
    if (value !== null) return value;
  }
  return null;
}

export function parseForecast(body: Json, model: WeatherModel): WeatherForecast {
  const models = model === FALLBACK_MODEL ? [FALLBACK_MODEL] : [model, FALLBACK_MODEL];
  const hourly = isRecord(body.hourly) ? body.hourly : undefined;
  const daily = isRecord(body.daily) ? body.daily : undefined;
  const current = isRecord(body.current) ? body.current : undefined;
  const hourTimes = Array.isArray(hourly?.time) ? hourly.time : [];
  const dayTimes = Array.isArray(daily?.time) ? daily.time : [];
  if (dayTimes.length === 0 || hourTimes.length === 0) throw new Error('Open-Meteo: unerwartete Antwort');

  const hourSeries = (key: string) => candidates(hourly, key, models);
  const hTemp = hourSeries('temperature_2m');
  const hProb = hourSeries('precipitation_probability');
  const hCode = hourSeries('weather_code');
  const hDay = hourSeries('is_day');
  const hours: WeatherHour[] = hourTimes.flatMap((time, i) => {
    const t = text(time);
    return t
      ? [
          {
            time: t,
            temperature: numberAt(hTemp, i),
            precipitationProbability: numberAt(hProb, i),
            weatherCode: numberAt(hCode, i),
            isDay: numberAt(hDay, i) !== 0,
          },
        ]
      : [];
  });

  const daySeries = (key: string) => candidates(daily, key, models);
  const dCode = daySeries('weather_code');
  const dMax = daySeries('temperature_2m_max');
  const dMin = daySeries('temperature_2m_min');
  const dSum = daySeries('precipitation_sum');
  const dProb = daySeries('precipitation_probability_max');
  const dRise = daySeries('sunrise');
  const dSet = daySeries('sunset');
  const dUv = daySeries('uv_index_max');
  const days: WeatherDay[] = dayTimes.flatMap((date, i) => {
    const d = text(date);
    return d
      ? [
          {
            date: d,
            weatherCode: numberAt(dCode, i),
            tempMax: numberAt(dMax, i),
            tempMin: numberAt(dMin, i),
            precipitationSum: numberAt(dSum, i),
            precipitationProbability: numberAt(dProb, i),
            sunrise: stringAt(dRise, i),
            sunset: stringAt(dSet, i),
            uvIndexMax: numberAt(dUv, i),
          },
        ]
      : [];
  });

  // `current` comes from the first model that has the place; gaps are filled
  // from the hour the current time falls into.
  const time = text(current?.time) ?? hours[0]?.time ?? '';
  const hourIndex = hours.findIndex((hour) => hour.time === `${time.slice(0, 13)}:00`);
  const fromHour = (series: unknown[][]) => (hourIndex >= 0 ? numberAt(series, hourIndex) : null);
  const now = (key: string) => currentValue(current, key, models) ?? fromHour(hourSeries(key));
  const isDay = now('is_day');
  const result: WeatherCurrent = {
    time,
    temperature: now('temperature_2m'),
    apparentTemperature: now('apparent_temperature'),
    humidity: now('relative_humidity_2m'),
    windSpeed: now('wind_speed_10m'),
    windGusts: now('wind_gusts_10m'),
    windDirection: now('wind_direction_10m'),
    weatherCode: now('weather_code'),
    isDay: isDay !== 0,
  };
  if (result.temperature === null) throw new Error('Open-Meteo: keine aktuellen Werte für diesen Ort');

  // Suffixed keys only exist when the preferred model has the place.
  const preferred = model === FALLBACK_MODEL ? undefined : hourly?.[`temperature_2m_${model}`];
  return {
    timezone: text(body.timezone),
    utcOffsetSeconds: finite(body.utc_offset_seconds) ?? 0,
    current: result,
    hours,
    days,
    meteoSwiss: Array.isArray(preferred) && preferred.some((value) => finite(value) !== null),
  };
}

export async function fetchForecast(
  latitude: number,
  longitude: number,
  model: WeatherModel,
  signal: AbortSignal,
): Promise<WeatherForecast> {
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    current: CURRENT_VARS.join(','),
    hourly: HOURLY_VARS.join(','),
    daily: DAILY_VARS.join(','),
    timezone: 'auto',
    forecast_days: String(FORECAST_DAYS),
    models: model === FALLBACK_MODEL ? FALLBACK_MODEL : `${model},${FALLBACK_MODEL}`,
  });
  const body = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`, 'Open-Meteo', signal);
  return parseForecast(body, model);
}

// ── Air quality ──────────────────────────────────────────────────────────────

export type PollenKind = 'alder' | 'birch' | 'grass' | 'ragweed';

export interface AirQuality {
  europeanAqi: number | null;
  /** grains/m³; only the kinds the API had values for. */
  pollen: { kind: PollenKind; value: number }[];
}

const POLLEN_KINDS: readonly PollenKind[] = ['alder', 'birch', 'grass', 'ragweed'];

function parseAirQuality(body: Json): AirQuality {
  const current = isRecord(body.current) ? body.current : {};
  return {
    europeanAqi: finite(current.european_aqi),
    pollen: POLLEN_KINDS.flatMap((kind) => {
      const value = finite(current[`${kind}_pollen`]);
      return value === null ? [] : [{ kind, value }];
    }),
  };
}

export async function fetchAirQuality(latitude: number, longitude: number, signal: AbortSignal): Promise<AirQuality> {
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4),
    longitude: longitude.toFixed(4),
    current: ['european_aqi', ...POLLEN_KINDS.map((kind) => `${kind}_pollen`)].join(','),
    timezone: 'auto',
  });
  const body = await getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${params}`, 'Luftqualität', signal);
  return parseAirQuality(body);
}

export type Tone = 'good' | 'fair' | 'moderate' | 'bad';

/**
 * UV index as shown («UV max. 3 (mässig)»). The WHO scale is defined on whole
 * numbers, so the category comes from the same rounded value as the number.
 */
export function uvLevel(uv: number): { value: number; label: string } {
  const value = Math.round(uv);
  const label = value < 3 ? 'niedrig' : value < 6 ? 'mässig' : value < 8 ? 'hoch' : value < 11 ? 'sehr hoch' : 'extrem';
  return { value, label };
}

/** Levels of the European Air Quality Index (EEA). */
export function aqiLevel(aqi: number): { label: string; tone: Tone } {
  if (aqi < 20) return { label: 'gut', tone: 'good' };
  if (aqi < 40) return { label: 'ausreichend', tone: 'fair' };
  if (aqi < 60) return { label: 'mässig', tone: 'moderate' };
  if (aqi < 80) return { label: 'schlecht', tone: 'bad' };
  if (aqi < 100) return { label: 'sehr schlecht', tone: 'bad' };
  return { label: 'extrem schlecht', tone: 'bad' };
}

const POLLEN_NAMES: Readonly<Record<PollenKind, string>> = {
  alder: 'Erle',
  birch: 'Birke',
  grass: 'Gräser',
  ragweed: 'Ambrosia',
};

/** grains/m³ from which the load counts as mässig / stark / sehr stark (MeteoSwiss guide values). */
const POLLEN_THRESHOLDS: Readonly<Record<PollenKind, readonly [number, number, number]>> = {
  alder: [10, 70, 250],
  birch: [10, 70, 300],
  grass: [20, 50, 150],
  ragweed: [6, 11, 40],
};

const POLLEN_LEVELS = ['schwach', 'mässig', 'stark', 'sehr stark'] as const;

/** Strongest pollen load, or null when there is no pollen data (outside Europe). */
export function strongestPollen(air: AirQuality): { label: string; tone: Tone } | null {
  if (air.pollen.length === 0) return null;
  let best: { kind: PollenKind; level: number } | null = null;
  for (const { kind, value } of air.pollen) {
    if (value < 1) continue;
    const level = POLLEN_THRESHOLDS[kind].filter((threshold) => value >= threshold).length;
    if (!best || level > best.level) best = { kind, level };
  }
  if (!best) return { label: 'keine Pollen', tone: 'good' };
  const tones: Tone[] = ['fair', 'moderate', 'bad', 'bad'];
  return { label: `${POLLEN_NAMES[best.kind]} ${POLLEN_LEVELS[best.level]}`, tone: tones[best.level] };
}

// ── Location ─────────────────────────────────────────────────────────────────

/** The form commits trimmed or untrimmed text – both must map to the same cache entry. */
export const normalizeLocationQuery = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

interface GeoCandidate {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  featureCode: string;
  countryCode: string;
  country: string | null;
  admin1: string | null;
  population: number;
  postcodes: string[];
}

const GEOCODING_LANGUAGES = ['de', 'fr', 'it', 'en'] as const;

const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim();

const FEATURE_SCORES: Readonly<Record<string, number>> = {
  PPLC: 25,
  PPLA: 20,
  PPLA2: 15,
  PPLA3: 10,
  PPLA4: 10,
  PPL: 8,
};

/**
 * Exact name or postcode beats everything; then the optional qualifier after
 * a comma («Freiburg, Deutschland»), Switzerland (the kiosk's home), the
 * kind of place and its population.
 */
function scoreCandidate(candidate: GeoCandidate, name: string, qualifier: string): number {
  const wanted = fold(name);
  const candidateName = fold(candidate.name);
  let score = 0;
  if (candidateName === wanted || candidate.postcodes.includes(name.trim())) score += 100;
  else if (candidateName.startsWith(wanted)) score += 25;

  if (qualifier) {
    const q = fold(qualifier);
    const matches = [candidate.country, candidate.countryCode, candidate.admin1].some((value) => {
      if (!value) return false;
      const v = fold(value);
      return v === q || v.includes(q);
    });
    score += matches ? 60 : -40;
  }
  if (candidate.countryCode === 'CH') score += 30;
  score += FEATURE_SCORES[candidate.featureCode] ?? (candidate.featureCode.startsWith('PPL') ? 4 : 0);
  score += Math.min(20, Math.log10(candidate.population + 1) * 3.5);
  return score;
}

function toCandidate(raw: unknown): GeoCandidate | null {
  if (!isRecord(raw)) return null;
  const id = finite(raw.id);
  const name = text(raw.name);
  const latitude = finite(raw.latitude);
  const longitude = finite(raw.longitude);
  if (id === null || name === null || latitude === null || longitude === null) return null;
  return {
    id,
    name,
    latitude,
    longitude,
    featureCode: text(raw.feature_code) ?? '',
    countryCode: text(raw.country_code) ?? '',
    country: text(raw.country),
    admin1: text(raw.admin1),
    population: finite(raw.population) ?? 0,
    postcodes: Array.isArray(raw.postcodes) ? raw.postcodes.filter((p): p is string => typeof p === 'string') : [],
  };
}

async function geocode(query: string, signal: AbortSignal): Promise<WeatherGeo> {
  const [namePart, ...rest] = query.split(',');
  const name = namePart.trim();
  const qualifier = rest.join(',').trim();
  if (!name) return { query, status: 'notFound' };

  const settled = await Promise.allSettled(
    GEOCODING_LANGUAGES.map((language) => {
      const params = new URLSearchParams({ name, count: '10', language, format: 'json' });
      return getJson(`https://geocoding-api.open-meteo.com/v1/search?${params}`, 'Ortssuche', signal);
    }),
  );
  signal.throwIfAborted();

  // A partial answer is no answer: the widget caches the result for good, and
  // the missing language may be the only one that knows the place («Ginevra»)
  // or a better match than the others («Sion»). Errors are retried instead.
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw new Error(errorMessage(failure.reason));

  // First language wins for duplicates, so German names are preferred.
  const byId = new Map<number, { candidate: GeoCandidate; language: string }>();
  settled.forEach((result, index) => {
    if (result.status !== 'fulfilled' || !Array.isArray(result.value.results)) return;
    for (const raw of result.value.results) {
      const candidate = toCandidate(raw);
      if (candidate && !byId.has(candidate.id)) byId.set(candidate.id, { candidate, language: GEOCODING_LANGUAGES[index] });
    }
  });

  let best: { candidate: GeoCandidate; language: string; score: number } | null = null;
  for (const entry of byId.values()) {
    const score = scoreCandidate(entry.candidate, name, qualifier);
    if (!best || score > best.score) best = { ...entry, score };
  }
  if (!best) return { query, status: 'notFound' };

  const { candidate } = best;
  let region = candidate.admin1;
  let country = candidate.country;
  // Region and country in German also when only another index knew the name
  // («Sion» → Kanton Wallis, Schweiz); the name itself stays as typed.
  if (best.language !== 'de') {
    try {
      const params = new URLSearchParams({ id: String(candidate.id), language: 'de' });
      const german = toCandidate(await getJson(`https://geocoding-api.open-meteo.com/v1/get?${params}`, 'Ortssuche', signal));
      region = german?.admin1 ?? region;
      country = german?.country ?? country;
    } catch {
      // Optional – the names in the other language are fine as well.
      signal.throwIfAborted();
    }
  }
  return {
    query,
    status: 'ok',
    source: 'search',
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    resolvedName: candidate.name,
    region,
    country,
  };
}

type IpLocation = Omit<Extract<WeatherGeo, { status: 'ok' }>, 'query' | 'status' | 'source'>;

function ipLocation(latitude: unknown, longitude: unknown, city: unknown, region: unknown, country: unknown): IpLocation {
  const lat = finite(latitude);
  const lon = finite(longitude);
  if (lat === null || lon === null) throw new Error('keine Koordinaten erhalten');
  const regionName = text(region);
  return {
    latitude: lat,
    longitude: lon,
    resolvedName: text(city) ?? regionName ?? 'Unbekannter Ort',
    region: regionName,
    country: text(country),
  };
}

const IP_PROVIDERS: readonly { name: string; locate: (signal: AbortSignal) => Promise<IpLocation> }[] = [
  {
    name: 'ipapi.co',
    locate: async (signal) => {
      const body = await getJson('https://ipapi.co/json/', 'ipapi.co', signal);
      if (body.error === true) throw new Error(`ipapi.co: ${text(body.reason) ?? 'Fehler'}`);
      return ipLocation(body.latitude, body.longitude, body.city, body.region, body.country_name);
    },
  },
  {
    name: 'ipwho.is',
    locate: async (signal) => {
      const body = await getJson(
        'https://ipwho.is/?fields=success,message,latitude,longitude,city,region,country',
        'ipwho.is',
        signal,
      );
      if (body.success === false) throw new Error(`ipwho.is: ${text(body.message) ?? 'Fehler'}`);
      return ipLocation(body.latitude, body.longitude, body.city, body.region, body.country);
    },
  },
];

async function locateByIp(signal: AbortSignal): Promise<WeatherGeo> {
  const reasons: string[] = [];
  for (const provider of IP_PROVIDERS) {
    try {
      const location = await provider.locate(signal);
      return { query: '', status: 'ok', source: 'ip', ...location };
    } catch (err) {
      signal.throwIfAborted();
      const message = errorMessage(err);
      reasons.push(message.startsWith(provider.name) ? message : `${provider.name}: ${message}`);
    }
  }
  throw new Error(
    `Standort konnte nicht über die IP-Adresse ermittelt werden (${reasons.join('; ')}). In den Einstellungen einen Ort eintragen.`,
  );
}

/**
 * Geocodes `query` (normalized), or locates by IP when it is empty. «Not
 * found» is a result (only when every language index answered), not an error.
 */
export function resolveLocation(query: string, signal: AbortSignal): Promise<WeatherGeo> {
  return query ? geocode(query, signal) : locateByIp(signal);
}

// ── Time helpers ─────────────────────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  if (!formatters.has(timeZone)) {
    let formatter: Intl.DateTimeFormat | null = null;
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      // Unknown zone name – callers fall back to the fixed UTC offset.
    }
    formatters.set(timeZone, formatter);
  }
  return formatters.get(timeZone) ?? null;
}

/**
 * `epochMs` as wall-clock time of the forecast location, 'YYYY-MM-DDTHH:MM' –
 * the format Open-Meteo uses with `timezone=auto`, so plain string
 * comparisons work (also across DST changes, unlike a fixed offset).
 */
export function localDateTime(epochMs: number, timeZone: string | null, utcOffsetSeconds: number): string {
  const formatter = timeZone ? formatterFor(timeZone) : null;
  if (formatter) {
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(epochMs)) parts[part.type] = part.value;
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
  }
  const shifted = new Date(epochMs + utcOffsetSeconds * 1000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(
    shifted.getUTCHours(),
  )}:${pad(shifted.getUTCMinutes())}`;
}

/** 'YYYY-MM-DD' as a local calendar date (never through UTC parsing). */
function parseDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

/** 'Heute', 'Morgen' or the short weekday. */
export function dayLabel(date: string, today: string): string {
  if (date === today) return 'Heute';
  const base = parseDate(today);
  const day = parseDate(date);
  if (!base || !day) return date;
  const tomorrow = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
  if (day.getTime() === tomorrow.getTime()) return 'Morgen';
  return WEEKDAYS[day.getDay()];
}
