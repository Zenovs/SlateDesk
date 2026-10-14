import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HttpFetchRequest, HttpFetchResponse } from '../../utils/backend';
import {
  aqiLevel,
  dayLabel,
  describeWeather,
  localDateTime,
  normalizeLocationQuery,
  parseForecast,
  resolveLocation,
  strongestPollen,
  uvLevel,
} from './openMeteo';

const httpFetch = vi.hoisted(() => vi.fn<(req: HttpFetchRequest) => Promise<HttpFetchResponse>>());
vi.mock('../../utils/backend', () => ({ httpFetch }));

const json = (body: unknown, status = 200): HttpFetchResponse => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
  finalUrl: '',
});

const signal = () => new AbortController().signal;

afterEach(() => {
  httpFetch.mockReset();
});

/** Shape of a `models=meteoswiss_icon_ch2,best_match` answer (suffixed keys, plain `current`). */
const multiModel = {
  timezone: 'Europe/Zurich',
  utc_offset_seconds: 7200,
  current: { time: '2026-10-13T14:15', temperature_2m: 17.4, is_day: 1, weather_code: 1, apparent_temperature: null },
  hourly: {
    time: ['2026-10-13T14:00', '2026-10-13T15:00'],
    temperature_2m_meteoswiss_icon_ch2: [17.0, 17.8],
    temperature_2m_best_match: [16.5, 17.1],
    apparent_temperature_meteoswiss_icon_ch2: [null, null],
    apparent_temperature_best_match: [15.9, 16.4],
    precipitation_probability_meteoswiss_icon_ch2: [0, 10],
    precipitation_probability_best_match: [5, 5],
    weather_code_meteoswiss_icon_ch2: [1, 2],
    weather_code_best_match: [3, 3],
    is_day_meteoswiss_icon_ch2: [1, 1],
    is_day_best_match: [1, 1],
  },
  daily: {
    time: ['2026-10-13', '2026-10-14', '2026-10-19'],
    weather_code_meteoswiss_icon_ch2: [3, 1, null],
    weather_code_best_match: [45, 2, 61],
    temperature_2m_max_meteoswiss_icon_ch2: [19.0, 22.1, null],
    temperature_2m_max_best_match: [17.8, 22.0, 23.1],
    temperature_2m_min_meteoswiss_icon_ch2: [3.3, 8.9, null],
    temperature_2m_min_best_match: [4.0, 9.0, 10.2],
    uv_index_max_meteoswiss_icon_ch2: [null, null, null],
    uv_index_max_best_match: [4.05, 3.95, 3.35],
    sunrise_meteoswiss_icon_ch2: ['2026-10-13T07:44', '2026-10-14T07:46', '2026-10-19T07:52'],
    sunset_best_match: ['2026-10-13T18:48', '2026-10-14T18:46', '2026-10-19T18:37'],
  },
};

describe('parseForecast', () => {
  it('uses the real current block, not the daily maximum', () => {
    const forecast = parseForecast(multiModel, 'meteoswiss_icon_ch2');
    expect(forecast.current.temperature).toBe(17.4);
    expect(forecast.current.weatherCode).toBe(1);
    expect(forecast.days[0].tempMax).toBe(19.0);
  });

  it('prefers the chosen model and fills gaps from best_match', () => {
    const forecast = parseForecast(multiModel, 'meteoswiss_icon_ch2');
    expect(forecast.meteoSwiss).toBe(true);
    expect(forecast.days.map((d) => d.weatherCode)).toEqual([3, 1, 61]);
    expect(forecast.days[2].tempMax).toBe(23.1);
    expect(forecast.days[0].uvIndexMax).toBe(4.05);
    expect(forecast.days[0].sunrise).toBe('2026-10-13T07:44');
    expect(forecast.days[0].sunset).toBe('2026-10-13T18:48');
    expect(forecast.hours[1]).toMatchObject({ time: '2026-10-13T15:00', temperature: 17.8, precipitationProbability: 10 });
  });

  it('fills missing current values from the hour the current time falls into', () => {
    const forecast = parseForecast(multiModel, 'meteoswiss_icon_ch2');
    expect(forecast.current.apparentTemperature).toBe(15.9);
  });

  it('reads unsuffixed keys (only one model had the place) and reports the fallback', () => {
    const outside = {
      timezone: 'Europe/Berlin',
      utc_offset_seconds: 7200,
      current: { time: '2026-10-13T14:00', temperature_2m: 15.7, is_day: 0, weather_code: 0 },
      hourly: { time: ['2026-10-13T14:00'], temperature_2m: [15.7] },
      daily: { time: ['2026-10-13'], temperature_2m_max: [15.8] },
    };
    const forecast = parseForecast(outside, 'meteoswiss_icon_ch2');
    expect(forecast.meteoSwiss).toBe(false);
    expect(forecast.current.isDay).toBe(false);
    expect(forecast.days[0].tempMax).toBe(15.8);
  });

  it('rejects answers without data', () => {
    expect(() => parseForecast({ daily: { time: [] }, hourly: { time: [] } }, 'best_match')).toThrow(/unerwartete/);
  });
});

describe('describeWeather', () => {
  it('maps freezing drizzle and freezing rain explicitly', () => {
    expect(describeWeather(56)).toEqual({ label: 'Leichter gefrierender Nieselregen', icon: 'freezing' });
    expect(describeWeather(57).icon).toBe('freezing');
    expect(describeWeather(66)).toEqual({ label: 'Leichter Eisregen', icon: 'freezing' });
    expect(describeWeather(67).label).toBe('Eisregen');
    expect(describeWeather(65).icon).toBe('heavyRain');
    expect(describeWeather(77).label).toBe('Schneegriesel');
  });

  it('falls back for unknown or missing codes', () => {
    expect(describeWeather(42).icon).toBe('unknown');
    expect(describeWeather(null).label).toBe('Unbekannt');
  });
});

describe('time helpers', () => {
  it('formats wall-clock time of the location', () => {
    const epoch = Date.UTC(2026, 9, 13, 12, 5); // 14:05 in Zurich (CEST)
    expect(localDateTime(epoch, 'Europe/Zurich', 0)).toBe('2026-10-13T14:05');
    expect(localDateTime(Date.UTC(2026, 11, 31, 23, 30), 'Europe/Zurich', 0)).toBe('2027-01-01T00:30');
  });

  it('falls back to the fixed offset for unknown zones', () => {
    expect(localDateTime(Date.UTC(2026, 9, 13, 12, 5), 'Mars/Olympus', 3600)).toBe('2026-10-13T13:05');
  });

  it('labels days from the date string as a local date', () => {
    expect(dayLabel('2026-10-13', '2026-10-13')).toBe('Heute');
    expect(dayLabel('2026-10-14', '2026-10-13')).toBe('Morgen');
    expect(dayLabel('2026-10-15', '2026-10-13')).toBe('Do');
    expect(dayLabel('2026-11-01', '2026-10-31')).toBe('Morgen');
    expect(dayLabel('2026-10-18', '2026-10-13')).toBe('So');
  });

  it('normalizes the location text', () => {
    expect(normalizeLocationQuery('  Sion,   Schweiz ')).toBe('Sion, Schweiz');
    expect(normalizeLocationQuery(undefined)).toBe('');
  });
});

describe('uvLevel', () => {
  it('classifies the rounded value it shows (WHO scale on whole numbers)', () => {
    expect(uvLevel(2.4)).toEqual({ value: 2, label: 'niedrig' });
    expect(uvLevel(2.7)).toEqual({ value: 3, label: 'mässig' });
    expect(uvLevel(5.6)).toEqual({ value: 6, label: 'hoch' });
    expect(uvLevel(7.8)).toEqual({ value: 8, label: 'sehr hoch' });
    expect(uvLevel(10.5)).toEqual({ value: 11, label: 'extrem' });
    expect(uvLevel(0)).toEqual({ value: 0, label: 'niedrig' });
  });
});

describe('air quality', () => {
  it('names the EAQI levels', () => {
    expect(aqiLevel(12).label).toBe('gut');
    expect(aqiLevel(28).label).toBe('ausreichend');
    expect(aqiLevel(55)).toEqual({ label: 'mässig', tone: 'moderate' });
    expect(aqiLevel(130).label).toBe('extrem schlecht');
  });

  it('reports the strongest pollen load', () => {
    expect(strongestPollen({ europeanAqi: 20, pollen: [] })).toBeNull();
    expect(strongestPollen({ europeanAqi: 20, pollen: [{ kind: 'grass', value: 0.2 }] })?.label).toBe('keine Pollen');
    expect(
      strongestPollen({
        europeanAqi: 20,
        pollen: [
          { kind: 'grass', value: 25 },
          { kind: 'birch', value: 5 },
        ],
      })?.label,
    ).toBe('Gräser mässig');
    expect(strongestPollen({ europeanAqi: 20, pollen: [{ kind: 'birch', value: 400 }] })?.label).toBe('Birke sehr stark');
  });
});

describe('resolveLocation', () => {
  const place = (id: number, name: string, countryCode: string, featureCode: string, population: number, admin1 = '') => ({
    id,
    name,
    latitude: id,
    longitude: id,
    feature_code: featureCode,
    country_code: countryCode,
    country: countryCode,
    admin1,
    population,
  });

  it('finds «Sion» in the French index instead of a French village from the German one', async () => {
    httpFetch.mockImplementation(async ({ url }) => {
      const { pathname, searchParams } = new URL(url);
      // German names of the chosen place, looked up by id.
      if (pathname === '/v1/get') return json({ ...place(3, 'Sitten', 'CH', 'PPLA', 34708, 'Kanton Wallis'), country: 'Schweiz' });
      const language = searchParams.get('language');
      if (language === 'de') return json({ results: [place(1, 'Sion-les-Mines', 'FR', 'PPL', 1478), place(2, 'Sion', 'FR', 'PPL', 85)] });
      if (language === 'fr') return json({ results: [place(3, 'Sion', 'CH', 'PPLA', 34708, 'Canton du Valais')] });
      return json({ generationtime_ms: 0.1 });
    });
    const geo = await resolveLocation('Sion', signal());
    expect(geo).toMatchObject({
      status: 'ok',
      source: 'search',
      resolvedName: 'Sion',
      latitude: 3,
      region: 'Kanton Wallis',
      country: 'Schweiz',
    });
  });

  it('keeps the names of the other language when the German lookup fails', async () => {
    httpFetch.mockImplementation(async ({ url }) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname === '/v1/get') return json({ error: true }, 500);
      return searchParams.get('language') === 'fr'
        ? json({ results: [place(3, 'Sion', 'CH', 'PPLA', 34708, 'Canton du Valais')] })
        : json({ generationtime_ms: 0.1 });
    });
    expect(await resolveLocation('Sion', signal())).toMatchObject({ resolvedName: 'Sion', region: 'Canton du Valais' });
  });

  it('honours a qualifier after the comma', async () => {
    httpFetch.mockImplementation(async () =>
      json({
        results: [place(1, 'Freiburg', 'CH', 'PPLA', 38000, 'Kanton Freiburg'), place(2, 'Freiburg', 'DE', 'PPLA2', 230000, 'Baden-Württemberg')],
      }),
    );
    expect(await resolveLocation('Freiburg, Baden-Württemberg', signal())).toMatchObject({ latitude: 2 });
    expect(await resolveLocation('Freiburg', signal())).toMatchObject({ latitude: 1 });
  });

  it('caches «not found» as a result', async () => {
    httpFetch.mockResolvedValue(json({ generationtime_ms: 0.1 }));
    expect(await resolveLocation('Z', signal())).toEqual({ query: 'Z', status: 'notFound' });
  });

  it('fails instead of caching «not found» when one language index did not answer', async () => {
    httpFetch.mockImplementation(async ({ url }) => {
      if (new URL(url).searchParams.get('language') === 'it') throw new Error('Zeitüberschreitung');
      return json({ generationtime_ms: 0.1 });
    });
    await expect(resolveLocation('Ginevra', signal())).rejects.toThrow(/Ortssuche: Zeitüberschreitung/);
  });

  it('fails instead of caching a weaker match when one language index did not answer', async () => {
    httpFetch.mockImplementation(async ({ url }) => {
      const language = new URL(url).searchParams.get('language');
      if (language === 'fr') return json({ error: true }, 503);
      return language === 'de' ? json({ results: [place(2, 'Sion', 'FR', 'PPL', 85)] }) : json({ generationtime_ms: 0.1 });
    });
    await expect(resolveLocation('Sion', signal())).rejects.toThrow(/Ortssuche antwortet mit HTTP 503/);
  });

  it('fails when the search is not reachable at all', async () => {
    httpFetch.mockRejectedValue(new Error('Anfrage fehlgeschlagen: keine Verbindung'));
    await expect(resolveLocation('Zürich', signal())).rejects.toThrow(/Ortssuche: Anfrage fehlgeschlagen/);
  });

  it('locates by IP with a fallback provider', async () => {
    httpFetch.mockImplementation(async ({ url }) =>
      url.startsWith('https://ipapi.co')
        ? json({ error: true, reason: 'RateLimited' }, 429)
        : json({ success: true, latitude: 47.06, longitude: 7.63, city: 'Burgdorf', region: 'Bern', country: 'Schweiz' }),
    );
    expect(await resolveLocation('', signal())).toEqual({
      query: '',
      status: 'ok',
      source: 'ip',
      latitude: 47.06,
      longitude: 7.63,
      resolvedName: 'Burgdorf',
      region: 'Bern',
      country: 'Schweiz',
    });
  });

  it('explains what to do when no IP provider answers', async () => {
    httpFetch.mockResolvedValue(json({ error: true }, 503));
    await expect(resolveLocation('', signal())).rejects.toThrow(/In den Einstellungen einen Ort eintragen/);
  });
});
