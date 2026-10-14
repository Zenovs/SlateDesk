import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export type WeatherModel = 'best_match' | 'meteoswiss_icon_ch2';
export type TempUnit = 'celsius' | 'fahrenheit';

/**
 * Location the widget resolved for `query` (the normalized location text,
 * '' = IP auto-location). Written by the widget itself – not part of the
 * schema – so refreshes reuse it instead of geocoding again.
 */
export type WeatherGeo =
  | {
      query: string;
      status: 'ok';
      source: 'search' | 'ip';
      latitude: number;
      longitude: number;
      resolvedName: string;
      region: string | null;
      country: string | null;
    }
  | { query: string; status: 'notFound' };

export type WeatherSettings = {
  /** Place name or postcode; empty = IP auto-location. */
  location: string;
  tempUnit: TempUnit;
  model: WeatherModel;
  showHourly: boolean;
  /** 3–7 */
  forecastDays: number;
  showDetails: boolean;
  showAirQuality: boolean;
  refreshMinutes: number;
  geo: WeatherGeo | null;
};

export const WEATHER_DEFAULT_SETTINGS: WeatherSettings = {
  location: '',
  tempUnit: 'celsius',
  model: 'meteoswiss_icon_ch2',
  showHourly: true,
  forecastDays: 5,
  showDetails: true,
  showAirQuality: false,
  refreshMinutes: 30,
  geo: null,
};

const weatherSettingsSchema: SettingsField[] = [
  { type: 'section', label: 'Standort' },
  {
    key: 'location',
    type: 'text',
    label: 'Ort',
    placeholder: 'z. B. Sion, Zürich oder 3930',
    description:
      'Leer lassen = Standort einmalig über die IP-Adresse bestimmen. Mehrdeutige Namen mit Land oder Kanton ergänzen (z. B. «Freiburg, Deutschland») oder die Postleitzahl eintragen.',
  },
  {
    type: 'section',
    label: 'Vorhersage',
    description: 'Je nach Grösse zeigt das Widget das aktuelle Wetter, dazu den Stundenverlauf und bei genug Platz die nächsten Tage.',
  },
  {
    key: 'model',
    type: 'select',
    label: 'Wettermodell',
    options: [
      { value: 'meteoswiss_icon_ch2', label: 'MeteoSwiss ICON-CH2 (2 km, Alpenraum)' },
      { value: 'best_match', label: 'Automatisch (Open-Meteo)' },
    ],
    description:
      'ICON-CH2 rechnet 5 Tage voraus. Spätere Tage, den UV-Index und Orte ausserhalb des Alpenraums ergänzt Open-Meteo automatisch.',
  },
  { key: 'forecastDays', type: 'range', label: 'Tage in der Vorhersage', min: 3, max: 7, step: 1 },
  { key: 'showHourly', type: 'boolean', label: 'Stundenverlauf (nächste 12 Stunden)' },
  { type: 'section', label: 'Anzeige' },
  {
    key: 'tempUnit',
    type: 'radio',
    label: 'Temperatur',
    options: [
      { value: 'celsius', label: '°C (Celsius)' },
      { value: 'fahrenheit', label: '°F (Fahrenheit)' },
    ],
  },
  {
    key: 'showDetails',
    type: 'boolean',
    label: 'Details',
    description: 'Gefühlte Temperatur, Wind, Luftfeuchtigkeit, UV-Index, Sonnenauf- und -untergang.',
  },
  {
    key: 'showAirQuality',
    type: 'boolean',
    label: 'Luftqualität und Pollen',
    description: 'Europäischer Luftqualitätsindex und Pollenbelastung (nur in Europa verfügbar).',
  },
  {
    key: 'refreshMinutes',
    type: 'select',
    label: 'Aktualisieren alle',
    options: [
      { value: 10, label: '10 Minuten' },
      { value: 15, label: '15 Minuten' },
      { value: 30, label: '30 Minuten' },
      { value: 60, label: '1 Stunde' },
      { value: 120, label: '2 Stunden' },
    ],
  },
];

export const weatherManifest: WidgetManifest = {
  id: 'weather',
  name: 'Wetter',
  description: 'Aktuelles Wetter, Stundenverlauf und Vorhersage (MeteoSwiss, Open-Meteo)',
  version: '4.0.0',
  author: 'SlateDesk',
  category: 'Information',
  icon: 'CloudSun',
  minWidth: 3,
  minHeight: 2,
  defaultWidth: 4,
  defaultHeight: 3,
  permissions: ['network'],
  refreshInterval: 1800,
  settingsSchema: weatherSettingsSchema,
  defaultSettings: WEATHER_DEFAULT_SETTINGS,
};
