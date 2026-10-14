/**
 * Widget registration for the kiosk: manifest (from the catalog) + component.
 *
 * To add a widget:
 * 1. Create its manifest in src/widgets/manifests/<id>.ts and list it in catalog.ts
 * 2. Create the component in src/widgets/<Name>Widget.tsx (exports only components)
 * 3. Add it to `definitions` below
 *
 * Gesichtserkennung, Ruhemodus (camera service, face detection) and
 * KI-Assistent (recorder, chat client) are loaded on demand: most dashboards
 * don't use them, and they would otherwise make up a large part of the kiosk's
 * start-up bundle (face-api.js itself is split off by services/faceDetector).
 * WidgetWrapper renders the Suspense fallback while their chunk loads.
 */
import { lazy, type ComponentType } from 'react';
import type { WidgetDefinition } from '../types/widget';
import { registerWidget } from '../utils/widgetRegistry';
import { calendarManifest } from './manifests/calendar';
import { cameraManifest } from './manifests/camera';
import { clockManifest } from './manifests/clock';
import { lagraJobsManifest } from './manifests/lagra-jobs';
import { lagraNeuManifest } from './manifests/lagra-neu';
import { lagraStatusManifest } from './manifests/lagra-status';
import { messagesManifest } from './manifests/messages';
import { nasManifest } from './manifests/nas';
import { newsManifest } from './manifests/news';
import { planbarAufgabenManifest } from './manifests/planbar-aufgaben';
import { planbarNewsManifest } from './manifests/planbar-news';
import { planbarProjekteManifest } from './manifests/planbar-projekte';
import { planbarZeitManifest } from './manifests/planbar-zeit';
import { qrCodeManifest } from './manifests/qrcode';
import { sleeperManifest } from './manifests/sleeper';
import { speedtestManifest } from './manifests/speedtest';
import { systemManifest } from './manifests/system';
import { todoManifest } from './manifests/todo';
import { volumioManifest } from './manifests/volumio';
import { weatherManifest } from './manifests/weather';
import { whisperManifest } from './manifests/whisper';
import { CalendarSettingsExtra, CalendarWidget } from './CalendarWidget';
import { ClockWidget } from './ClockWidget';
import { LagraJobsWidget } from './LagraJobsWidget';
import { LagraNeuWidget } from './LagraNeuWidget';
import { LagraStatusWidget } from './LagraStatusWidget';
import { MessagesWidget } from './MessagesWidget';
import { NasSettingsExtra, NasWidget } from './NasWidget';
import { NewsWidget } from './NewsWidget';
import { PlanbarAufgabenWidget } from './PlanbarAufgabenWidget';
import { PlanbarNewsWidget } from './PlanbarNewsWidget';
import { PlanbarProjekteWidget } from './PlanbarProjekteWidget';
import { PlanbarZeitWidget } from './PlanbarZeitWidget';
import { QrCodeWidget } from './QrCodeWidget';
import { SpeedtestWidget } from './SpeedtestWidget';
import { SystemWidget } from './SystemWidget';
import { TodoWidget } from './TodoWidget';
import { VolumioSettingsExtra, VolumioWidget } from './VolumioWidget';
import { WeatherSettingsExtra, WeatherWidget } from './WeatherWidget';

/** A named component export of a lazily imported module (React.lazy wants a default export). */
function lazyExport<P extends object, M>(load: () => Promise<M>, pick: (module: M) => ComponentType<P>): ComponentType<P> {
  return lazy(() => load().then((module) => ({ default: pick(module) })));
}

const loadCamera = () => import('./CameraWidget');
const loadSleeper = () => import('./SleeperWidget');
const loadWhisper = () => import('./WhisperWidget');

const CameraWidget = lazyExport(loadCamera, (m) => m.CameraWidget);
const CameraSettingsExtra = lazyExport(loadCamera, (m) => m.CameraSettingsExtra);
const SleeperWidget = lazyExport(loadSleeper, (m) => m.SleeperWidget);
const SleeperSettingsExtra = lazyExport(loadSleeper, (m) => m.SleeperSettingsExtra);
const WhisperWidget = lazyExport(loadWhisper, (m) => m.WhisperWidget);
const WhisperSettingsExtra = lazyExport(loadWhisper, (m) => m.WhisperSettingsExtra);

const widgetDefinitions: WidgetDefinition[] = [
  { manifest: clockManifest, component: ClockWidget },
  { manifest: calendarManifest, component: CalendarWidget, settingsExtra: CalendarSettingsExtra },
  { manifest: weatherManifest, component: WeatherWidget, settingsExtra: WeatherSettingsExtra },
  { manifest: messagesManifest, component: MessagesWidget },
  { manifest: todoManifest, component: TodoWidget },
  { manifest: newsManifest, component: NewsWidget },
  { manifest: volumioManifest, component: VolumioWidget, settingsExtra: VolumioSettingsExtra },
  { manifest: speedtestManifest, component: SpeedtestWidget },
  { manifest: nasManifest, component: NasWidget, settingsExtra: NasSettingsExtra },
  { manifest: cameraManifest, component: CameraWidget, settingsExtra: CameraSettingsExtra },
  { manifest: whisperManifest, component: WhisperWidget, settingsExtra: WhisperSettingsExtra },
  { manifest: sleeperManifest, component: SleeperWidget, settingsExtra: SleeperSettingsExtra },
  { manifest: qrCodeManifest, component: QrCodeWidget },
  { manifest: systemManifest, component: SystemWidget },
  { manifest: lagraStatusManifest, component: LagraStatusWidget },
  { manifest: lagraJobsManifest, component: LagraJobsWidget },
  { manifest: lagraNeuManifest, component: LagraNeuWidget },
  { manifest: planbarAufgabenManifest, component: PlanbarAufgabenWidget },
  { manifest: planbarProjekteManifest, component: PlanbarProjekteWidget },
  { manifest: planbarNewsManifest, component: PlanbarNewsWidget },
  { manifest: planbarZeitManifest, component: PlanbarZeitWidget },
];

let initialized = false;

export const initializeWidgets = (): void => {
  if (initialized) return;
  initialized = true;
  widgetDefinitions.forEach(registerWidget);
};
