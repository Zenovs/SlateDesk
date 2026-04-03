/**
 * Weather API – Open-Meteo (kostenlos, kein API-Key)
 * Standort: automatisch via IP oder manuell via Stadtname.
 */

export interface WeatherForecast {
  day: string;
  icon: string;
  tempHigh: number;
  tempLow: number;
  condition: string;
}

export interface WeatherResult {
  data: WeatherForecast[];
  isLive: boolean;
  city?: string;
  error?: string;
}

interface GeoLocation {
  latitude: number;
  longitude: number;
  city: string;
}

// WMO Wetter-Code → Emoji + Text
function wmoToWeather(code: number): { icon: string; condition: string } {
  if (code === 0)                return { icon: '☀️',  condition: 'Klar' };
  if (code === 1)                return { icon: '🌤️',  condition: 'Überwiegend klar' };
  if (code === 2)                return { icon: '⛅',  condition: 'Teilweise bewölkt' };
  if (code === 3)                return { icon: '☁️',  condition: 'Bedeckt' };
  if (code <= 48)                return { icon: '🌫️',  condition: 'Nebel' };
  if (code <= 55)                return { icon: '🌦️',  condition: 'Nieselregen' };
  if (code <= 65)                return { icon: '🌧️',  condition: 'Regen' };
  if (code <= 77)                return { icon: '❄️',  condition: 'Schnee' };
  if (code <= 82)                return { icon: '🌦️',  condition: 'Regenschauer' };
  if (code <= 86)                return { icon: '🌨️',  condition: 'Schneeschauer' };
  if (code <= 99)                return { icon: '⛈️',  condition: 'Gewitter' };
  return { icon: '🌡️', condition: 'Unbekannt' };
}

const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

// Standort via IP ermitteln
async function getLocationByIp(): Promise<GeoLocation> {
  const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('IP-Geolocation fehlgeschlagen');
  const data = await res.json();
  return { latitude: data.latitude, longitude: data.longitude, city: data.city || data.region || 'Unbekannt' };
}

// Standort via Stadtname suchen
async function getLocationByCity(city: string): Promise<GeoLocation> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=de`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('Geocoding fehlgeschlagen');
  const data = await res.json();
  if (!data.results?.length) throw new Error(`Stadt "${city}" nicht gefunden`);
  const r = data.results[0];
  return { latitude: r.latitude, longitude: r.longitude, city: `${r.name}, ${r.country}` };
}

// Wetter von Open-Meteo holen
async function fetchFromOpenMeteo(loc: GeoLocation): Promise<WeatherResult> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&daily=temperature_2m_max,temperature_2m_min,weathercode&current=temperature_2m,weathercode&timezone=auto&forecast_days=5`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo Fehler: ${res.status}`);
  const data = await res.json();

  const days: WeatherForecast[] = data.daily.time.map((dateStr: string, i: number) => {
    const date = new Date(dateStr);
    const { icon, condition } = wmoToWeather(data.daily.weathercode[i]);
    return {
      day: i === 0 ? 'Heute' : DAYS[date.getDay()],
      icon,
      tempHigh: Math.round(data.daily.temperature_2m_max[i]),
      tempLow: Math.round(data.daily.temperature_2m_min[i]),
      condition,
    };
  });

  return { data: days, isLive: true, city: loc.city };
}

/**
 * Haupt-Funktion: Standort automatisch (IP) oder manuell (Stadtname),
 * Wetterdaten von Open-Meteo.
 */
export async function fetchWeatherData(cityOverride?: string): Promise<WeatherResult> {
  try {
    const loc = cityOverride?.trim()
      ? await getLocationByCity(cityOverride.trim())
      : await getLocationByIp();
    return await fetchFromOpenMeteo(loc);
  } catch (err) {
    return {
      data: [],
      isLive: false,
      error: err instanceof Error ? err.message : 'Unbekannter Fehler',
    };
  }
}
