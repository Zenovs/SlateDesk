/**
 * API Configuration Utility
 * 
 * Provides centralized access to API keys and configuration.
 * Keys are loaded from environment variables (Vite .env system).
 * Falls back gracefully when keys are not configured.
 */

export interface ApiConfig {
  openWeatherMap: {
    apiKey: string | null;
    city: string;
    baseUrl: string;
  };
  newsApi: {
    apiKey: string | null;
    country: string;
    baseUrl: string;
  };
}

export const getApiConfig = (): ApiConfig => ({
  openWeatherMap: {
    apiKey: import.meta.env.VITE_OPENWEATHERMAP_API_KEY || null,
    city: import.meta.env.VITE_WEATHER_CITY || 'Zurich,CH',
    baseUrl: 'https://api.openweathermap.org/data/2.5',
  },
  newsApi: {
    apiKey: import.meta.env.VITE_NEWSAPI_KEY || null,
    country: import.meta.env.VITE_NEWS_COUNTRY || 'ch',
    baseUrl: 'https://newsapi.org/v2',
  },
});

/**
 * Checks if a specific API is configured (has a valid key).
 */
export const isApiConfigured = (api: 'openWeatherMap' | 'newsApi'): boolean => {
  const config = getApiConfig();
  const key = config[api].apiKey;
  return !!key && key.trim().length > 0;
};
