/**
 * Widget catalog – the manifests of all widgets, without components.
 *
 * Pure data: the web UI imports this file, so it must never pull in widget
 * components, React or Tauri. Kiosk registration happens in ./index.ts.
 */
import type { WidgetCategory, WidgetManifest } from '../types/widget';
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

export const widgetCatalog: WidgetManifest[] = [
  clockManifest,
  calendarManifest,
  weatherManifest,
  messagesManifest,
  todoManifest,
  newsManifest,
  volumioManifest,
  speedtestManifest,
  nasManifest,
  cameraManifest,
  whisperManifest,
  sleeperManifest,
  qrCodeManifest,
  systemManifest,
  lagraStatusManifest,
  lagraJobsManifest,
  lagraNeuManifest,
  planbarAufgabenManifest,
  planbarProjekteManifest,
  planbarNewsManifest,
  planbarZeitManifest,
];

/** Display order of the categories (picker, web UI). */
export const WIDGET_CATEGORIES: readonly WidgetCategory[] = [
  'Zeit & Kalender',
  'Information',
  'Büro',
  'Medien',
  'Netzwerk',
  'Sensorik & KI',
  'lagra',
  'planbar',
];

/** Category for manifests that don't declare one. */
export const FALLBACK_CATEGORY: WidgetCategory = 'Information';

const byId = new Map(widgetCatalog.map((manifest) => [manifest.id, manifest]));

export const getManifest = (id: string): WidgetManifest | undefined => byId.get(id);

export const knownWidgetIds = (): string[] => widgetCatalog.map((manifest) => manifest.id);
