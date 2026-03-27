/**
 * OpenWeatherMap API Integration
 * 
 * Fetches current weather and 5-day forecast from OpenWeatherMap.
 * Falls back to mock data if API key is not configured or on error.
 */
import { getApiConfig, isApiConfigured } from './apiConfig';
import { mockWeatherData, type WeatherForecast } from './mockData';

interface OWMCurrentResponse {
  main: { temp: number; temp_min: number; temp_max: number };
  weather: Array<{ id: number; main: string; description: string; icon: string }>;
  name: string;
}

interface OWMForecastItem {
  dt: number;
  main: { temp: number; temp_min: number; temp_max: number };
  weather: Array<{ id: number; main: string; description: string; icon: string }>;
}

interface OWMForecastResponse {
  list: OWMForecastItem[];
}

/** Map OWM icon code to emoji */
const iconToEmoji = (iconCode: string): string => {
  const map: Record<string, string> = {
    '01d': '☀️', '01n': '🌙',
    '02d': '⛅', '02n': '⛅',
    '03d': '☁️', '03n': '☁️',
    '04d': '☁️', '04n': '☁️',
    '09d': '🌧️', '09n': '🌧️',
    '10d': '🌦️', '10n': '🌧️',
    '11d': '⛈️', '11n': '⛈️',
    '13d': '❄️', '13n': '❄️',
    '50d': '🌫️', '50n': '🌫️',
  };
  return map[iconCode] || '🌡️';
};

/** Translate OWM condition to German */
const translateCondition = (main: string): string => {
  const map: Record<string, string> = {
    'Clear': 'Klar',
    'Clouds': 'Bewölkt',
    'Rain': 'Regen',
    'Drizzle': 'Nieselregen',
    'Thunderstorm': 'Gewitter',
    'Snow': 'Schnee',
    'Mist': 'Nebel',
    'Fog': 'Nebel',
    'Haze': 'Dunst',
  };
  return map[main] || main;
};

/** Get German day name */
const getDayName = (date: Date, isToday: boolean): string => {
  if (isToday) return 'Heute';
  const days = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  return days[date.getDay()];
};

export interface WeatherResult {
  data: WeatherForecast[];
  isLive: boolean;
  city?: string;
  error?: string;
}

/**
 * Fetches weather data from OpenWeatherMap API.
 * Returns mock data if API key is missing or on error.
 * @param overrideCity Optional city override from widget settings
 * @param overrideApiKey Optional API key override from widget settings
 */
export const fetchWeatherData = async (overrideCity?: string, overrideApiKey?: string): Promise<WeatherResult> => {
  const hasOverrideKey = overrideApiKey && overrideApiKey.trim().length > 0;
  
  if (!isApiConfigured('openWeatherMap') && !hasOverrideKey) {
    return { data: mockWeatherData, isLive: false, error: 'API-Key nicht konfiguriert' };
  }

  const config = getApiConfig().openWeatherMap;
  const apiKey = hasOverrideKey ? overrideApiKey!.trim() : config.apiKey;
  const city = overrideCity && overrideCity.trim().length > 0 ? overrideCity.trim() : config.city;

  try {
    // Fetch current weather
    const currentRes = await fetch(
      `${config.baseUrl}/weather?q=${encodeURIComponent(city)}&units=metric&lang=de&appid=${apiKey}`
    );
    if (!currentRes.ok) {
      throw new Error(`Wetter-API Fehler: ${currentRes.status}`);
    }
    const current: OWMCurrentResponse = await currentRes.json();

    // Fetch 5-day forecast
    const forecastRes = await fetch(
      `${config.baseUrl}/forecast?q=${encodeURIComponent(city)}&units=metric&lang=de&appid=${apiKey}`
    );
    if (!forecastRes.ok) {
      throw new Error(`Vorhersage-API Fehler: ${forecastRes.status}`);
    }
    const forecast: OWMForecastResponse = await forecastRes.json();

    // Build today entry
    const today = new Date();
    const todayEntry: WeatherForecast = {
      day: 'Heute',
      icon: iconToEmoji(current.weather[0]?.icon || '01d'),
      tempHigh: Math.round(current.main.temp_max),
      tempLow: Math.round(current.main.temp_min),
      condition: translateCondition(current.weather[0]?.main || ''),
    };

    // Group forecast by day and get min/max temps
    const dailyMap = new Map<string, { tempMin: number; tempMax: number; icon: string; main: string; date: Date }>();
    for (const item of forecast.list) {
      const date = new Date(item.dt * 1000);
      const key = date.toISOString().split('T')[0];
      const todayKey = today.toISOString().split('T')[0];
      if (key === todayKey) continue; // skip today

      const existing = dailyMap.get(key);
      if (existing) {
        existing.tempMin = Math.min(existing.tempMin, item.main.temp_min);
        existing.tempMax = Math.max(existing.tempMax, item.main.temp_max);
        // Use midday icon if available (12:00)
        if (date.getHours() >= 11 && date.getHours() <= 14) {
          existing.icon = item.weather[0]?.icon || existing.icon;
          existing.main = item.weather[0]?.main || existing.main;
        }
      } else {
        dailyMap.set(key, {
          tempMin: item.main.temp_min,
          tempMax: item.main.temp_max,
          icon: item.weather[0]?.icon || '01d',
          main: item.weather[0]?.main || '',
          date,
        });
      }
    }

    // Take next 4 days
    const forecastDays: WeatherForecast[] = Array.from(dailyMap.values())
      .slice(0, 4)
      .map((d) => ({
        day: getDayName(d.date, false),
        icon: iconToEmoji(d.icon),
        tempHigh: Math.round(d.tempMax),
        tempLow: Math.round(d.tempMin),
        condition: translateCondition(d.main),
      }));

    return {
      data: [todayEntry, ...forecastDays],
      isLive: true,
      city: current.name,
    };
  } catch (err) {
    console.error('[WeatherWidget] API-Fehler:', err);
    return {
      data: mockWeatherData,
      isLive: false,
      error: err instanceof Error ? err.message : 'Unbekannter Fehler',
    };
  }
};
