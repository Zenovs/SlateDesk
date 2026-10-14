import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

/** vorschau = live image, unscharf = blurred image, nur-zahl = no image, only the number of people. */
export type CameraPrivacy = 'vorschau' | 'unscharf' | 'nur-zahl';

export type CameraSettings = {
  /** '' = default camera (never pinned to a deviceId). Chosen on the kiosk (settingsExtra). */
  deviceId: string;
  autoStart: boolean;
  privacy: CameraPrivacy;
  mirror: boolean;
  faceDetection: boolean;
  showBoxes: boolean;
  /** Detections per second. */
  fps: number;
  /** 0..1 */
  scoreThreshold: number;
  /** TinyFaceDetector input size in px. */
  inputSize: number;
};

export const CAMERA_DEFAULT_SETTINGS: CameraSettings = {
  deviceId: '',
  // The stream is shared with the Ruhemodus widget, so starting on its own is safe now.
  autoStart: true,
  privacy: 'vorschau',
  mirror: true,
  faceDetection: true,
  showBoxes: true,
  fps: 4,
  scoreThreshold: 0.5,
  inputSize: 224,
};

/**
 * Defaults of the pre-backend widget for instances imported from it (it saved
 * only changed keys): the camera did not start on its own.
 */
export const CAMERA_LEGACY_DEFAULTS: Pick<CameraSettings, 'autoStart'> = { autoStart: false };

export const CAMERA_FPS_LIMITS = { min: 1, max: 10 } as const;

const detectionOn = (values: Record<string, unknown>): boolean => values.faceDetection === true;

const cameraSettingsSchema: SettingsField[] = [
  {
    type: 'section',
    label: 'Kamera',
    description:
      'Das Bild wird nur auf dem Kiosk verarbeitet – nichts wird gespeichert oder übertragen. Welche Kamera verwendet wird, lässt sich am Kiosk einstellen.',
  },
  {
    key: 'autoStart',
    type: 'boolean',
    label: 'Automatisch starten',
    description: 'Kamera beim Start des Kiosks einschalten.',
  },
  {
    key: 'privacy',
    type: 'radio',
    label: 'Anzeige',
    description: '«Nur Anzahl» zeigt kein Bild, sondern nur, wie viele Personen erkannt werden.',
    options: [
      { value: 'vorschau', label: 'Live-Bild' },
      { value: 'unscharf', label: 'Unscharf' },
      { value: 'nur-zahl', label: 'Nur Anzahl' },
    ],
  },
  {
    key: 'mirror',
    type: 'boolean',
    label: 'Bild spiegeln',
    description: 'Wie ein Spiegel – passend für Kameras, die zum Betrachter zeigen.',
    showIf: (values) => values.privacy !== 'nur-zahl',
  },
  { type: 'section', label: 'Gesichtserkennung' },
  {
    key: 'faceDetection',
    type: 'boolean',
    label: 'Gesichter erkennen',
    description: 'Meldet die Anwesenheit auch anderen Widgets, z.B. dem Ruhemodus.',
  },
  {
    key: 'showBoxes',
    type: 'boolean',
    label: 'Gesichter markieren',
    showIf: (values) => detectionOn(values) && values.privacy !== 'nur-zahl',
  },
  {
    key: 'fps',
    type: 'range',
    label: 'Erkennungen pro Sekunde',
    description: 'Weniger Erkennungen brauchen weniger Rechenleistung.',
    min: CAMERA_FPS_LIMITS.min,
    max: CAMERA_FPS_LIMITS.max,
    step: 1,
    showIf: detectionOn,
  },
  {
    key: 'scoreThreshold',
    type: 'range',
    label: 'Erkennungsschwelle',
    description: 'Höher = weniger Fehlerkennungen, dafür werden entfernte Gesichter eher übersehen.',
    min: 0.1,
    max: 0.9,
    step: 0.05,
    showIf: detectionOn,
  },
  {
    key: 'inputSize',
    type: 'select',
    label: 'Genauigkeit',
    description: 'Genauer erkennt auch kleine Gesichter, braucht aber mehr Rechenleistung.',
    options: [
      { value: 128, label: 'Sehr schnell (128 px)' },
      { value: 160, label: 'Schnell (160 px)' },
      { value: 224, label: 'Ausgewogen (224 px)' },
      { value: 320, label: 'Genau (320 px)' },
      { value: 416, label: 'Sehr genau (416 px)' },
    ],
    showIf: detectionOn,
  },
];

export const cameraManifest: WidgetManifest = {
  id: 'camera',
  name: 'Gesichtserkennung',
  description: 'Kamerabild mit lokaler Gesichtserkennung – auch unscharf oder nur als Personenzahl',
  version: '4.0.0',
  author: 'SlateDesk',
  category: 'Sensorik & KI',
  icon: 'ScanFace',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 3,
  defaultHeight: 4,
  permissions: ['camera'],
  settingsSchema: cameraSettingsSchema,
  defaultSettings: CAMERA_DEFAULT_SETTINGS,
  singleton: true,
};
