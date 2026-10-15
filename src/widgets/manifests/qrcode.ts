import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export const QR_MODES = ['url', 'wlan', 'text'] as const;
export type QrMode = (typeof QR_MODES)[number];

export const WLAN_ENCRYPTIONS = ['WPA', 'WEP', 'nopass'] as const;
export type WlanEncryption = (typeof WLAN_ENCRYPTIONS)[number];

export type QrCodeSettings = {
  mode: QrMode;
  /**
   * Web address for mode 'url'. Deliberately not named `url`: the backend
   * clears a sibling secret (wlanPassword) whenever a key ending in «url»
   * changes over the web UI.
   */
  link: string;
  text: string;
  wlanSsid: string;
  wlanPassword: string;
  wlanEncryption: WlanEncryption;
  wlanHidden: boolean;
  /** Empty = «Gäste-WLAN» in mode 'wlan'. */
  title: string;
  caption: string;
  showSsid: boolean;
  /** Prints the WLAN password below the code – readable for everybody in the room. */
  revealPasswordText: boolean;
  /** Share of the free space the code uses, in %. */
  size: number;
};

export const QR_CODE_DEFAULTS: QrCodeSettings = {
  mode: 'wlan',
  link: '',
  text: '',
  wlanSsid: '',
  wlanPassword: '',
  wlanEncryption: 'WPA',
  wlanHidden: false,
  title: '',
  caption: 'Kamera öffnen und scannen',
  showSsid: true,
  revealPasswordText: false,
  size: 100,
};

export const DEFAULT_WLAN_TITLE = 'Gäste-WLAN';

const isWlan = (values: Record<string, unknown>): boolean => (values.mode ?? QR_CODE_DEFAULTS.mode) === 'wlan';
const needsPassword = (values: Record<string, unknown>): boolean => isWlan(values) && values.wlanEncryption !== 'nopass';

const settingsSchema: SettingsField[] = [
  {
    type: 'radio',
    key: 'mode',
    label: 'Inhalt',
    options: [
      { value: 'wlan', label: 'WLAN-Zugang' },
      { value: 'url', label: 'Webadresse' },
      { value: 'text', label: 'Text' },
    ],
  },
  {
    type: 'url',
    key: 'link',
    label: 'Webadresse',
    placeholder: 'https://www.beispiel.ch',
    description: 'Ohne «https://» wird es ergänzt.',
    showIf: (values) => values.mode === 'url',
  },
  {
    type: 'textarea',
    key: 'text',
    label: 'Text',
    placeholder: 'Text, Telefonnummer, Kontakt …',
    showIf: (values) => values.mode === 'text',
  },
  { type: 'text', key: 'wlanSsid', label: 'WLAN-Name (SSID)', placeholder: 'Gast', showIf: isWlan },
  {
    type: 'select',
    key: 'wlanEncryption',
    label: 'Verschlüsselung',
    options: [
      { value: 'WPA', label: 'WPA / WPA2 / WPA3' },
      { value: 'WEP', label: 'WEP (veraltet)' },
      { value: 'nopass', label: 'Offen (ohne Passwort)' },
    ],
    showIf: isWlan,
  },
  { type: 'secret', key: 'wlanPassword', label: 'WLAN-Passwort', showIf: needsPassword },
  {
    type: 'boolean',
    key: 'wlanHidden',
    label: 'Verstecktes Netzwerk',
    description: 'Nur einschalten, wenn das WLAN seinen Namen nicht aussendet.',
    showIf: isWlan,
  },
  { type: 'section', label: 'Anzeige' },
  {
    type: 'text',
    key: 'title',
    label: 'Titel',
    placeholder: 'z. B. Gäste-WLAN',
    description: 'Beim WLAN-Zugang steht ohne Eingabe «Gäste-WLAN».',
  },
  { type: 'text', key: 'caption', label: 'Hinweis unter dem Code', placeholder: 'Kamera öffnen und scannen' },
  { type: 'boolean', key: 'showSsid', label: 'WLAN-Namen anzeigen', showIf: isWlan },
  {
    type: 'boolean',
    key: 'revealPasswordText',
    label: 'Passwort als Text anzeigen',
    description: 'Für Geräte ohne Kamera. Alle vor dem Bildschirm können es lesen.',
    showIf: needsPassword,
  },
  { type: 'range', key: 'size', label: 'Grösse des Codes', min: 40, max: 100, step: 5, unit: '%' },
];

export const qrCodeManifest: WidgetManifest = {
  id: 'qrcode',
  name: 'QR-Code',
  description: 'QR-Code für das Gäste-WLAN, eine Webadresse oder einen Text',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'Büro',
  icon: 'QrCode',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 3,
  defaultHeight: 4,
  // Füllt seine Fläche schon ganz – «Schriftgrösse» nur verkleinern.
  maxFontScale: 100,
  permissions: [],
  settingsSchema,
  defaultSettings: QR_CODE_DEFAULTS,
};

// ── Payload ──────────────────────────────────────────────────────────────────

/** Backslash, semicolon, comma, colon and double quote are escaped in WIFI: fields. */
export const escapeWifiField = (value: string): string => value.replace(/[\\;,:"]/g, (char) => `\\${char}`);

/** `WIFI:T:WPA;S:<ssid>;P:<password>;H:true;;` – the format Android and iOS cameras understand. */
export function wifiPayload(ssid: string, password: string, encryption: WlanEncryption, hidden: boolean): string {
  const fields = [`T:${encryption}`, `S:${escapeWifiField(ssid)}`];
  if (encryption !== 'nopass') fields.push(`P:${escapeWifiField(password)}`);
  if (hidden) fields.push('H:true');
  return `WIFI:${fields.join(';')};;`;
}

/** Adds https:// when no scheme is given (a bare domain is not recognised as a link by every camera). */
export function normalizeLink(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^(mailto|tel|sms|geo):/i.test(value)) return value;
  return `https://${value}`;
}

export type QrContent =
  | { ok: true; payload: string }
  /** German hint what to fill in. */
  | { ok: false; missing: string };

/** What the code encodes, or what is missing in the settings. */
export function qrContent(settings: QrCodeSettings): QrContent {
  switch (settings.mode) {
    case 'url': {
      const link = normalizeLink(settings.link);
      return link ? { ok: true, payload: link } : { ok: false, missing: 'Webadresse in den Einstellungen eintragen' };
    }
    case 'text':
      return settings.text.trim()
        ? { ok: true, payload: settings.text }
        : { ok: false, missing: 'Text in den Einstellungen eintragen' };
    case 'wlan': {
      if (!settings.wlanSsid.trim()) return { ok: false, missing: 'WLAN-Name in den Einstellungen eintragen' };
      if (settings.wlanEncryption !== 'nopass' && !settings.wlanPassword) {
        return { ok: false, missing: 'WLAN-Passwort in den Einstellungen eintragen' };
      }
      return {
        ok: true,
        payload: wifiPayload(settings.wlanSsid, settings.wlanPassword, settings.wlanEncryption, settings.wlanHidden),
      };
    }
  }
}
