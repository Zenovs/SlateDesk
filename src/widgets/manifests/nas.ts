import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export type HostCheckKind = 'ping' | 'tcp' | 'http';

export type MonitoredHost = {
  name: string;
  /** IP or hostname; pasted URLs and "host:port" are accepted and split up by the widget. */
  host: string;
  kind: HostCheckKind;
  /** tcp / http only. For http, 443 means https. */
  port: number;
  /** http only. */
  path: string;
};

export type HostMonitorSettings = {
  hosts: MonitoredHost[];
  intervalSeconds: number;
  warnLatencyMs: number;
  critLatencyMs: number;
  /** Consecutive failed checks before a host counts as down – single lost pings are no outage. */
  failureThreshold: number;
  showSparkline: boolean;
  historyHours: number;
  /** Notice and mail only once a host has been unreachable this long (minutes, from its first failed check); 0 = as soon as it counts as down. */
  alertAfterMinutes: number;
  /** Large notice over the whole kiosk while a host is down. */
  alertScreen: boolean;
  /** Mail when a host goes down and when it answers again (set up in the web UI, System → Mail-Versand). */
  alertMail: boolean;
};

export const HOST_CHECK_KINDS: readonly HostCheckKind[] = ['ping', 'tcp', 'http'];

export const ALERT_AFTER_OPTIONS: readonly number[] = [0, 2, 5, 10, 15, 30];

export const HOST_MONITOR_DEFAULT_SETTINGS: HostMonitorSettings = {
  hosts: [],
  intervalSeconds: 60,
  warnLatencyMs: 20,
  critLatencyMs: 100,
  failureThreshold: 3,
  showSparkline: true,
  historyHours: 12,
  alertAfterMinutes: 5,
  alertScreen: true,
  alertMail: true,
};

const hostItemFields: SettingsField[] = [
  { key: 'name', type: 'text', label: 'Name', placeholder: 'z.B. NAS, Router, Drucker' },
  { key: 'host', type: 'text', label: 'Adresse', placeholder: 'z.B. 192.168.1.10 oder nas.local' },
  {
    key: 'kind',
    type: 'select',
    label: 'Prüfung',
    options: [
      { value: 'ping', label: 'Ping (ICMP)' },
      { value: 'tcp', label: 'TCP-Port' },
      { value: 'http', label: 'Webseite (HTTP/HTTPS)' },
    ],
  },
  {
    key: 'port',
    type: 'number',
    label: 'Port',
    min: 1,
    max: 65535,
    step: 1,
    description:
      'z.B. 445 (Dateifreigabe), 5000/5001 (Synology DSM), 9100 (Drucker). Bei HTTP: 443 = https, sonst http – oder die Adresse mit https:// eintragen.',
    showIf: (values) => values.kind === 'tcp' || values.kind === 'http',
  },
  {
    key: 'path',
    type: 'text',
    label: 'Pfad',
    placeholder: '/',
    description: 'Jede Antwort zählt als erreichbar, ausser Serverfehler (HTTP 5xx).',
    showIf: (values) => values.kind === 'http',
  },
];

const hostMonitorSettingsSchema: SettingsField[] = [
  {
    type: 'section',
    label: 'Hosts',
    description: 'Ein Host zeigt eine grosse Anzeige, mehrere eine Liste.',
  },
  {
    key: 'hosts',
    type: 'list',
    label: 'Überwachte Hosts',
    addLabel: 'Host hinzufügen',
    itemTitleKey: 'name',
    itemFields: hostItemFields,
    newItem: () => ({ name: '', host: '', kind: 'ping', port: 80, path: '/' }),
  },
  { type: 'section', label: 'Prüfung' },
  {
    key: 'intervalSeconds',
    type: 'select',
    label: 'Prüfen',
    options: [
      { value: 30, label: 'Alle 30 Sekunden' },
      { value: 60, label: 'Jede Minute' },
      { value: 300, label: 'Alle 5 Minuten' },
      { value: 900, label: 'Alle 15 Minuten' },
    ],
  },
  {
    key: 'failureThreshold',
    type: 'number',
    label: 'Als ausgefallen melden nach',
    unit: 'Fehlversuchen',
    description: 'Fehlversuche in Folge – einzelne verlorene Pings sind noch kein Ausfall.',
    min: 1,
    max: 10,
    step: 1,
  },
  {
    type: 'section',
    label: 'Bei Ausfall',
    description: 'Das Widget zeigt einen Ausfall sofort. Hinweis und Mail kommen erst, wenn er anhält.',
  },
  {
    key: 'alertAfterMinutes',
    type: 'select',
    label: 'Hinweis und Mail nach',
    options: ALERT_AFTER_OPTIONS.map((minutes) => ({
      value: minutes,
      label: minutes === 0 ? 'Sofort (sobald als ausgefallen gezählt)' : `${minutes} Minuten`,
    })),
    description: 'So lange muss ein Host ununterbrochen nicht erreichbar sein. Kürzere Aussetzer zeigt nur das Widget selbst.',
  },
  {
    key: 'alertScreen',
    type: 'boolean',
    label: 'Grosser Hinweis auf dem Bildschirm',
    description: 'Bleibt über dem ganzen Dashboard, bis wieder alles erreichbar ist.',
  },
  {
    key: 'alertMail',
    type: 'boolean',
    label: 'Mail senden',
    description:
      'Je eine Mail beim Ausfall und wenn der Host wieder antwortet. Server und Empfänger stehen in der Fernsteuerung unter System → Mail-Versand.',
  },
  { type: 'section', label: 'Antwortzeit', description: 'Farben der Anzeige: grün, gelb ab «Warnung», rot ab «Kritisch».' },
  { key: 'warnLatencyMs', type: 'number', label: 'Warnung ab', unit: 'ms', min: 1, max: 10000, step: 1 },
  { key: 'critLatencyMs', type: 'number', label: 'Kritisch ab', unit: 'ms', min: 1, max: 10000, step: 1 },
  { type: 'section', label: 'Anzeige' },
  { key: 'showSparkline', type: 'boolean', label: 'Verlauf anzeigen' },
  {
    key: 'historyHours',
    type: 'select',
    label: 'Verlauf und Verfügbarkeit über',
    options: [
      { value: 6, label: 'Letzte 6 Stunden' },
      { value: 12, label: 'Letzte 12 Stunden' },
      { value: 24, label: 'Letzte 24 Stunden' },
    ],
  },
];

export const nasManifest: WidgetManifest = {
  id: 'nas',
  name: 'Host-Monitor',
  description: 'Erreichbarkeit von NAS, Servern und Diensten',
  version: '2.2.0',
  author: 'SlateDesk',
  category: 'Netzwerk',
  icon: 'Server',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 3,
  defaultHeight: 4,
  permissions: ['network'],
  settingsSchema: hostMonitorSettingsSchema,
  defaultSettings: HOST_MONITOR_DEFAULT_SETTINGS,
};
