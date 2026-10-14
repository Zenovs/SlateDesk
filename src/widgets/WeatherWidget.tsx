/**
 * Weather widget – Open-Meteo through the Rust backend, no API key.
 *
 * The location text is resolved once (geocoding, or the IP address when it
 * is empty) and the result is cached in the widget settings (`geo`), so
 * refreshes only load the forecast. The content follows the real size:
 * small = current conditions, medium = + next hours, large = + days.
 */
import { type ReactNode, useEffect, useEffectEvent, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  AlertTriangle,
  CloudDrizzle,
  CloudFog,
  CloudHail,
  CloudLightning,
  CloudMoon,
  CloudMoonRain,
  CloudRain,
  CloudRainWind,
  CloudSnow,
  CloudSun,
  CloudSunRain,
  Cloudy,
  Droplet,
  Droplets,
  Flower2,
  Leaf,
  Loader2,
  type LucideIcon,
  MapPin,
  Moon,
  RotateCcw,
  Sun,
  Sunrise,
  Thermometer,
  Wind,
} from 'lucide-react';
import { useElementSize } from '../hooks/useElementSize';
import { usePolling } from '../hooks/usePolling';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { useAppState } from '../state/appState';
import type { WidgetProps } from '../types/widget';
import {
  type TempUnit,
  WEATHER_DEFAULT_SETTINGS,
  type WeatherGeo,
  type WeatherModel,
  type WeatherSettings,
} from './manifests/weather';
import { useNow } from './shared/hooks';
import {
  type AirQuality,
  aqiLevel,
  dayLabel,
  describeWeather,
  fetchAirQuality,
  fetchForecast,
  localDateTime,
  normalizeLocationQuery,
  resolveLocation,
  strongestPollen,
  type Tone,
  uvLevel,
  type WeatherForecast,
  type WeatherIconKind,
} from './weather/openMeteo';
import './styles/weather.css';

type ResolvedGeo = Extract<WeatherGeo, { status: 'ok' }>;

const AIR_REFRESH_MS = 60 * 60_000;
/** Content height (px) from which the hourly strip / the days fit as well. */
const MEDIUM_MIN_HEIGHT = 190;
const LARGE_MIN_HEIGHT = 300;
/** Minimum column widths (px) of the hourly strip and the days row. */
const HOUR_MIN_WIDTH = 44;
const DAY_MIN_WIDTH = 54;
const HOURS_AHEAD = 12;

// ── Settings ─────────────────────────────────────────────────────────────────

interface LegacyMigration {
  /** Written once: renamed keys moved, old keys removed. */
  patch: Record<string, unknown>;
  /** Effective values until the patch arrived. */
  values: Partial<WeatherSettings>;
}

/** Version 3 stored `city` and `updateInterval`. */
function legacyMigration(stored: Record<string, unknown> | undefined): LegacyMigration | null {
  if (!stored || !('city' in stored || 'updateInterval' in stored)) return null;
  const patch: Record<string, unknown> = {};
  const values: Partial<WeatherSettings> = {};
  if ('city' in stored) {
    patch.city = undefined;
    if (stored.location === undefined && typeof stored.city === 'string') patch.location = values.location = stored.city;
  }
  if ('updateInterval' in stored) {
    patch.updateInterval = undefined;
    if (stored.refreshMinutes === undefined && typeof stored.updateInterval === 'number') {
      patch.refreshMinutes = values.refreshMinutes = stored.updateInterval;
    }
  }
  return { patch, values };
}

/** Settings with legacy keys applied; `migrate` writes the cleanup (only the widget itself does). */
function useWeatherSettings(instanceId: string, migrate: boolean) {
  const stored = useAppState((s) => s.state.widgetSettings[instanceId]);
  const [raw, update] = useWidgetSettings(instanceId, WEATHER_DEFAULT_SETTINGS);
  const migration = useMemo(() => legacyMigration(stored), [stored]);
  const settings = useMemo(() => (migration ? { ...raw, ...migration.values } : raw), [raw, migration]);

  useEffect(() => {
    if (migrate && migration) update(migration.patch as Partial<WeatherSettings>);
  }, [migrate, migration, update]);

  return [settings, update] as const;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The cached location, if it belongs to `query` and is well-formed (state can be imported). */
function geoFor(geo: unknown, query: string): WeatherGeo | null {
  if (typeof geo !== 'object' || geo === null) return null;
  const value = geo as Record<string, unknown>;
  if (value.query !== query) return null;
  if (value.status === 'notFound') return geo as WeatherGeo;
  const valid =
    value.status === 'ok' &&
    isFiniteNumber(value.latitude) &&
    isFiniteNumber(value.longitude) &&
    typeof value.resolvedName === 'string';
  return valid ? (geo as WeatherGeo) : null;
}

const clamp = (value: unknown, min: number, max: number, fallback: number): number =>
  isFiniteNumber(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

// ── Formatting ───────────────────────────────────────────────────────────────

const toUnit = (celsius: number, unit: TempUnit): number => (unit === 'fahrenheit' ? (celsius * 9) / 5 + 32 : celsius);

const degrees = (celsius: number | null, unit: TempUnit): string =>
  celsius === null ? '–' : `${Math.round(toUnit(celsius, unit))}°`;

const COMPASS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'] as const;

const compass = (deg: number): string => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

/** 'YYYY-MM-DDTHH:MM' → 'HH:MM' */
const clockOf = (localTime: string): string => localTime.slice(11, 16);

const formatUpdated = (epochMs: number): string =>
  new Date(epochMs).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });

// ── Icons ────────────────────────────────────────────────────────────────────

type IconTone = 'sun' | 'night' | 'cloud' | 'rain' | 'snow' | 'storm';

const WEATHER_ICONS: Readonly<
  Record<WeatherIconKind, { day: LucideIcon; night: LucideIcon; tone: IconTone; nightTone: IconTone }>
> = {
  clear: { day: Sun, night: Moon, tone: 'sun', nightTone: 'night' },
  partlyCloudy: { day: CloudSun, night: CloudMoon, tone: 'sun', nightTone: 'night' },
  overcast: { day: Cloudy, night: Cloudy, tone: 'cloud', nightTone: 'cloud' },
  fog: { day: CloudFog, night: CloudFog, tone: 'cloud', nightTone: 'cloud' },
  drizzle: { day: CloudDrizzle, night: CloudDrizzle, tone: 'rain', nightTone: 'rain' },
  rain: { day: CloudRain, night: CloudRain, tone: 'rain', nightTone: 'rain' },
  heavyRain: { day: CloudRainWind, night: CloudRainWind, tone: 'rain', nightTone: 'rain' },
  freezing: { day: CloudHail, night: CloudHail, tone: 'snow', nightTone: 'snow' },
  snow: { day: CloudSnow, night: CloudSnow, tone: 'snow', nightTone: 'snow' },
  showers: { day: CloudSunRain, night: CloudMoonRain, tone: 'rain', nightTone: 'rain' },
  snowShowers: { day: CloudSnow, night: CloudSnow, tone: 'snow', nightTone: 'snow' },
  thunder: { day: CloudLightning, night: CloudLightning, tone: 'storm', nightTone: 'storm' },
  unknown: { day: Thermometer, night: Thermometer, tone: 'cloud', nightTone: 'cloud' },
};

interface WeatherIconProps {
  code: number | null;
  isDay: boolean;
  className: string;
  strokeWidth?: number;
}

function WeatherIcon({ code, isDay, className, strokeWidth }: WeatherIconProps) {
  const entry = WEATHER_ICONS[describeWeather(code).icon];
  const Icon = isDay ? entry.day : entry.night;
  const tone = isDay ? entry.tone : entry.nightTone;
  return <Icon className={`${className} weather-tone-${tone}`} strokeWidth={strokeWidth} aria-hidden="true" />;
}

// ── Views ────────────────────────────────────────────────────────────────────

interface MessageProps {
  title: string;
  detail?: string | null;
  /** loading = pulsing cloud; hint = calm note, nothing is broken; error = warning. */
  kind?: 'loading' | 'hint' | 'error';
  onRetry?: () => void;
}

function WeatherMessage({ title, detail, kind = 'loading', onRetry }: MessageProps) {
  const Icon = kind === 'error' ? AlertTriangle : kind === 'hint' ? MapPin : CloudSun;
  return (
    <div className={`weather-message weather-message--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon
        className={`weather-message-icon${kind === 'loading' ? ' weather-message-icon--pulse' : ''}`}
        aria-hidden="true"
      />
      <div className="weather-message-title">{title}</div>
      {detail && <div className="weather-message-detail">{detail}</div>}
      {onRetry && (
        <button type="button" className="weather-retry" onClick={onRetry}>
          <RotateCcw size={16} aria-hidden="true" />
          Erneut versuchen
        </button>
      )}
    </div>
  );
}

interface Detail {
  key: string;
  icon: ReactNode;
  text: string;
  tone?: Tone;
}

interface ViewProps {
  data: WeatherForecast;
  geo: ResolvedGeo;
  unit: TempUnit;
  showHourly: boolean;
  showDetails: boolean;
  forecastDays: number;
  /** null = air quality disabled. */
  air: { data: AirQuality | null; error: string | null } | null;
  width: number;
  height: number;
  now: number;
  lastUpdated: number | null;
  stale: boolean;
}

function WeatherView(props: ViewProps) {
  const { data, geo, unit, showHourly, showDetails, forecastDays, air, width, height, now, lastUpdated, stale } = props;
  const { current } = data;
  const local = localDateTime(now, data.timezone, data.utcOffsetSeconds);
  const today = local.slice(0, 10);
  const days = data.days.filter((day) => day.date >= today);
  const todayData = days[0]?.date === today ? days[0] : null;
  const upcoming = data.hours.filter((hour) => hour.time > local && hour.temperature !== null).slice(0, HOURS_AHEAD);

  const tier = height >= LARGE_MIN_HEIGHT ? 3 : height >= MEDIUM_MIN_HEIGHT ? 2 : 1;
  const showHours = showHourly && tier >= 2 && upcoming.length > 0;
  const showDays = days.length > 0 && (tier === 3 || (tier === 2 && !showHours));
  // Narrow widgets still cover the next 12 hours, in 2- or 3-hour steps.
  const hourStep = width >= HOURS_AHEAD * HOUR_MIN_WIDTH ? 1 : width >= (HOURS_AHEAD / 2) * HOUR_MIN_WIDTH ? 2 : 3;
  const hours = upcoming.filter((_, index) => index % hourStep === 0);
  const shownDays = days.slice(0, Math.max(1, Math.min(forecastDays, Math.floor(width / DAY_MIN_WIDTH))));

  const details: Detail[] = [];
  if (showDetails) {
    if (current.apparentTemperature !== null) {
      details.push({
        key: 'feels',
        icon: <Thermometer aria-hidden="true" />,
        text: `Gefühlt ${degrees(current.apparentTemperature, unit)}`,
      });
    }
    if (current.windSpeed !== null) {
      const direction = current.windDirection !== null && current.windSpeed >= 1 ? ` ${compass(current.windDirection)}` : '';
      const gusts =
        current.windGusts !== null && current.windGusts >= current.windSpeed + 10
          ? `, Böen ${Math.round(current.windGusts)}`
          : '';
      details.push({
        key: 'wind',
        icon: <Wind aria-hidden="true" />,
        text: `${Math.round(current.windSpeed)} km/h${direction}${gusts}`,
      });
    }
    if (current.humidity !== null) {
      details.push({ key: 'humidity', icon: <Droplets aria-hidden="true" />, text: `${Math.round(current.humidity)} % Feuchte` });
    }
    if (todayData && todayData.uvIndexMax !== null) {
      const uv = uvLevel(todayData.uvIndexMax);
      details.push({ key: 'uv', icon: <Sun aria-hidden="true" />, text: `UV max. ${uv.value} (${uv.label})` });
    }
    if (todayData?.sunrise && todayData.sunset) {
      details.push({
        key: 'sun',
        icon: <Sunrise aria-hidden="true" />,
        text: `${clockOf(todayData.sunrise)} – ${clockOf(todayData.sunset)}`,
      });
    }
  }
  if (air) {
    if (air.data) {
      if (air.data.europeanAqi !== null) {
        const level = aqiLevel(air.data.europeanAqi);
        details.push({ key: 'aqi', icon: <Leaf aria-hidden="true" />, text: `Luft ${level.label}`, tone: level.tone });
      }
      const pollen = strongestPollen(air.data);
      if (pollen) details.push({ key: 'pollen', icon: <Flower2 aria-hidden="true" />, text: pollen.label, tone: pollen.tone });
    } else if (air.error) {
      details.push({ key: 'aqi', icon: <Leaf aria-hidden="true" />, text: 'Luftqualität nicht verfügbar' });
    }
  }

  const condition = describeWeather(current.weatherCode);
  const updated = lastUpdated !== null ? formatUpdated(lastUpdated) : null;

  return (
    <>
      <div className="weather-header">
        <span className="weather-place">
          <MapPin className="weather-place-icon" aria-hidden="true" />
          <span className="weather-place-name">{geo.resolvedName}</span>
          {geo.source === 'ip' && <span className="weather-badge">Auto</span>}
        </span>
        <span className={`weather-status${stale ? ' weather-status--stale' : ''}`}>
          {stale && <AlertTriangle className="weather-status-icon" aria-hidden="true" />}
          <span className="weather-source">{data.meteoSwiss ? 'MeteoSwiss · Open-Meteo' : 'Open-Meteo'}</span>
          {updated && <span>{stale ? `Stand ${updated}` : updated}</span>}
        </span>
      </div>

      <div className="weather-now">
        <div className="weather-now-main">
          <WeatherIcon code={current.weatherCode} isDay={current.isDay} className="weather-now-icon" strokeWidth={1.5} />
          <div className="weather-now-text">
            <div className="weather-now-temp">
              {degrees(current.temperature, unit)}
              <span className="weather-now-unit">{unit === 'fahrenheit' ? 'F' : 'C'}</span>
            </div>
            <div className="weather-now-condition">{condition.label}</div>
            {todayData && (todayData.tempMax !== null || todayData.tempMin !== null) && (
              <div className="weather-now-range">
                <span>max {degrees(todayData.tempMax, unit)}</span>
                <span>min {degrees(todayData.tempMin, unit)}</span>
              </div>
            )}
          </div>
        </div>
        {details.length > 0 && (
          <ul className="weather-details">
            {details.map((detail) => (
              <li key={detail.key} className={`weather-detail${detail.tone ? ` weather-detail--${detail.tone}` : ''}`}>
                {detail.icon}
                <span>{detail.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {showHours && (
        <div className="weather-hours">
          {hours.map((hour) => {
            const probability = hour.precipitationProbability;
            return (
              <div key={hour.time} className="weather-hour">
                <span className="weather-hour-time">{hour.time.slice(11, 13)} Uhr</span>
                <WeatherIcon code={hour.weatherCode} isDay={hour.isDay} className="weather-hour-icon" />
                <span className="weather-hour-temp">{degrees(hour.temperature, unit)}</span>
                <span className={`weather-rain${probability === null || probability < 20 ? ' weather-rain--low' : ''}`}>
                  <Droplet aria-hidden="true" />
                  {probability === null ? '–' : `${Math.round(probability)} %`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {showDays && (
        <div className="weather-days">
          {shownDays.map((day) => {
            const probability = day.precipitationProbability;
            const rain =
              probability !== null
                ? `${Math.round(probability)} %`
                : day.precipitationSum !== null
                  ? `${day.precipitationSum.toFixed(1)} mm`
                  : '–';
            const low = probability !== null ? probability < 20 : (day.precipitationSum ?? 0) < 0.5;
            return (
              <div key={day.date} className={`weather-day${day.date === today ? ' weather-day--today' : ''}`}>
                <span className="weather-day-name">{dayLabel(day.date, today)}</span>
                <WeatherIcon code={day.weatherCode} isDay className="weather-day-icon" />
                <span className="weather-day-temps">
                  <span className="weather-day-max">{degrees(day.tempMax, unit)}</span>
                  <span className="weather-day-min">{degrees(day.tempMin, unit)}</span>
                </span>
                <span className={`weather-rain${low ? ' weather-rain--low' : ''}`}>
                  <Droplet aria-hidden="true" />
                  {rain}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

// ── Location lookup (widget ↔ its settings extra) ────────────────────────────

/** State of the widget's location lookup – the settings dialog cannot see its poller. */
interface LookupStatus {
  /** The normalized location text the lookup is for. */
  query: string;
  error: string | null;
  loading: boolean;
  retry: () => void;
}

const lookups = new Map<string, LookupStatus>();
const lookupListeners = new Set<() => void>();

function setLookup(instanceId: string, status: LookupStatus, registered: boolean): void {
  if (registered) lookups.set(instanceId, status);
  else if (lookups.get(instanceId) === status) lookups.delete(instanceId);
  else return;
  for (const listener of [...lookupListeners]) listener();
}

function subscribeLookups(listener: () => void): () => void {
  lookupListeners.add(listener);
  return () => {
    lookupListeners.delete(listener);
  };
}

/** The widget's lookup for `query`; null while the widget is not mounted or still on another text. */
function useLookup(instanceId: string, query: string): LookupStatus | null {
  const status = useSyncExternalStore(subscribeLookups, () => lookups.get(instanceId) ?? null);
  return status?.query === query ? status : null;
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function WeatherWidget({ instanceId }: WidgetProps) {
  const [settings, update] = useWeatherSettings(instanceId, true);
  const query = normalizeLocationQuery(settings.location);
  const model: WeatherModel = settings.model === 'best_match' ? 'best_match' : 'meteoswiss_icon_ch2';
  const refreshMs = clamp(settings.refreshMinutes, 5, 240, WEATHER_DEFAULT_SETTINGS.refreshMinutes) * 60_000;
  const forecastDays = clamp(settings.forecastDays, 3, 7, WEATHER_DEFAULT_SETTINGS.forecastDays);
  const unit: TempUnit = settings.tempUnit === 'fahrenheit' ? 'fahrenheit' : 'celsius';

  const geo = geoFor(settings.geo, query);
  const coords = geo?.status === 'ok' ? geo : null;
  const latitude = coords?.latitude ?? null;
  const longitude = coords?.longitude ?? null;

  // Runs only while no location is cached for the current text; «not found»
  // is cached as well, so a typo costs one lookup, not one per refresh.
  const located = usePolling(
    async (signal) => {
      const resolved = await resolveLocation(query, signal);
      signal.throwIfAborted();
      update({ geo: resolved });
      return resolved;
    },
    null,
    [query],
    { enabled: geo === null },
  );

  useEffect(() => {
    const status: LookupStatus = { query, error: located.error, loading: located.loading, retry: located.refresh };
    setLookup(instanceId, status, true);
    return () => setLookup(instanceId, status, false);
  }, [instanceId, query, located.error, located.loading, located.refresh]);

  const forecast = usePolling(
    (signal) =>
      coords
        ? fetchForecast(coords.latitude, coords.longitude, model, signal)
        : Promise.reject(new Error('Kein Standort')),
    refreshMs,
    [latitude, longitude, model],
    { enabled: coords !== null },
  );

  const airQuality = usePolling(
    (signal) =>
      coords ? fetchAirQuality(coords.latitude, coords.longitude, signal) : Promise.reject(new Error('Kein Standort')),
    AIR_REFRESH_MS,
    [latitude, longitude],
    { enabled: coords !== null && settings.showAirQuality === true },
  );

  // The kiosk often boots before the network is up – retry as soon as it is.
  const retryFailed = useEffectEvent(() => {
    if (located.error) located.refresh();
    if (forecast.error) forecast.refresh();
    if (airQuality.error) airQuality.refresh();
  });
  useEffect(() => {
    const onOnline = () => retryFailed();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(rootRef);
  const now = useNow(60_000);

  let content: ReactNode;
  if (geo === null) {
    if (!located.error) {
      content = <WeatherMessage title={query ? `«${query}» wird gesucht …` : 'Standort wird ermittelt …'} />;
    } else if (query) {
      content = (
        <WeatherMessage
          kind="error"
          title={`«${query}» konnte nicht gesucht werden`}
          detail={located.error}
          onRetry={located.refresh}
        />
      );
    } else {
      // No place entered and the IP services failed (often just rate-limited):
      // a calm hint on the wall – the provider details are in the settings.
      content = (
        <WeatherMessage
          kind="hint"
          title="Standort unbekannt"
          detail="In den Einstellungen einen Ort eintragen."
          onRetry={located.refresh}
        />
      );
    }
  } else if (geo.status === 'notFound') {
    content = (
      <WeatherMessage
        kind="error"
        title={`Ort «${geo.query}» nicht gefunden`}
        detail="In den Einstellungen den Ort anpassen – mit Land oder Kanton ergänzen oder die Postleitzahl eintragen."
      />
    );
  } else if (!forecast.data) {
    content = forecast.error ? (
      <WeatherMessage kind="error" title="Wetterdaten nicht verfügbar" detail={forecast.error} onRetry={forecast.refresh} />
    ) : (
      <WeatherMessage title="Wetter wird geladen …" />
    );
  } else {
    content = (
      <WeatherView
        data={forecast.data}
        geo={geo}
        unit={unit}
        showHourly={settings.showHourly !== false}
        showDetails={settings.showDetails !== false}
        forecastDays={forecastDays}
        air={settings.showAirQuality === true ? { data: airQuality.data, error: airQuality.error } : null}
        width={width}
        height={height}
        now={now}
        lastUpdated={forecast.lastUpdated}
        stale={forecast.error !== null}
      />
    );
  }

  return (
    <div ref={rootRef} className="weather">
      {content}
    </div>
  );
}

/** Kiosk dialog: shows which place the location text resolved to. */
export function WeatherSettingsExtra({ instanceId }: { instanceId: string }) {
  const [settings] = useWeatherSettings(instanceId, false);
  const query = normalizeLocationQuery(settings.location);
  const geo = geoFor(settings.geo, query);
  const lookup = useLookup(instanceId, query);

  let status: ReactNode;
  if (geo === null && lookup?.error) {
    status = (
      <>
        <div className="settings-info-box error">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            <strong>{query ? `Suche nach «${query}» fehlgeschlagen` : 'Standort nicht ermittelt'}</strong>
            <br />
            {lookup.error}
            <br />
            Ein neuer Versuch folgt automatisch.
          </span>
        </div>
        <button
          type="button"
          className="settings-btn weather-lookup-retry"
          onClick={lookup.retry}
          disabled={lookup.loading}
        >
          {lookup.loading ? (
            <Loader2 size={16} className="settings-spin" aria-hidden="true" />
          ) : (
            <RotateCcw size={16} aria-hidden="true" />
          )}
          {query ? 'Erneut suchen' : 'Erneut versuchen'}
        </button>
      </>
    );
  } else if (geo === null) {
    status = (
      <div className="settings-info-box">
        <MapPin size={16} aria-hidden="true" />
        <span>{query ? `«${query}» wird gesucht …` : 'Standort wird über die IP-Adresse ermittelt …'}</span>
      </div>
    );
  } else if (geo.status === 'notFound') {
    status = (
      <div className="settings-info-box error">
        <AlertTriangle size={16} aria-hidden="true" />
        <span>
          «{geo.query}» wurde nicht gefunden. Schreibweise prüfen, Land oder Kanton ergänzen (z. B. «Sion, Schweiz») oder
          die Postleitzahl eintragen.
        </span>
      </div>
    );
  } else {
    const place = [geo.region, geo.country].filter(Boolean).join(', ');
    status = (
      <div className="settings-info-box success">
        <MapPin size={16} aria-hidden="true" />
        <span>
          <strong>{geo.resolvedName}</strong>
          {place && ` (${place})`}
          <br />
          {geo.latitude.toFixed(3)}, {geo.longitude.toFixed(3)} ·{' '}
          {geo.source === 'ip'
            ? 'über die IP-Adresse ermittelt – für einen genauen Standort den Ort eintragen'
            : 'über die Ortssuche gefunden'}
        </span>
      </div>
    );
  }

  return (
    <>
      {status}
      <p className="settings-description weather-attribution-note">
        Wetterdaten: Open-Meteo.com (CC BY 4.0), Modell ICON-CH2 von MeteoSwiss. Kein API-Schlüssel nötig.
      </p>
    </>
  );
}
