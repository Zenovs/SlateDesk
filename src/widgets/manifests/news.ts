import type { SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export type NewsMode = 'liste' | 'rotation' | 'ticker';

export type NewsFeed = { name: string; url: string; enabled: boolean };

export type NewsSettings = {
  feeds: NewsFeed[];
  mode: NewsMode;
  maxItems: number;
  /** 0 = no limit */
  maxAgeHours: number;
  rotateSeconds: number;
  showImages: boolean;
  showSummary: boolean;
  showSource: boolean;
  excludeKeywords: string[];
  refreshMinutes: number;
};

export const NEWS_DEFAULT_SETTINGS: NewsSettings = {
  feeds: [
    { name: 'SRF News', url: 'https://www.srf.ch/news/bnf/rss/1646', enabled: true },
    { name: 'NZZ Neueste', url: 'https://www.nzz.ch/recent.rss', enabled: true },
  ],
  mode: 'liste',
  maxItems: 8,
  maxAgeHours: 24,
  rotateSeconds: 12,
  showImages: true,
  showSummary: true,
  showSource: true,
  excludeKeywords: [],
  refreshMinutes: 15,
};

const notTicker = (values: Record<string, unknown>): boolean => values.mode !== 'ticker';

const newsSettingsSchema: SettingsField[] = [
  {
    type: 'section',
    label: 'Quellen',
    description:
      'RSS- oder Atom-Feeds, ohne API-Schlüssel. Weitere Beispiele: 20 Minuten (https://partner-feeds.20min.ch/rss/20minuten), watson (https://www.watson.ch/api/1.0/rss/index.xml), SRF Schweiz (https://www.srf.ch/news/bnf/rss/1890).',
  },
  {
    key: 'feeds',
    type: 'list',
    label: 'Feeds',
    addLabel: 'Feed hinzufügen',
    itemTitleKey: 'name',
    itemFields: [
      { key: 'name', type: 'text', label: 'Name', placeholder: 'z. B. SRF News' },
      { key: 'url', type: 'url', label: 'Feed-Adresse', placeholder: 'https://…' },
      { key: 'enabled', type: 'boolean', label: 'Aktiv' },
    ],
    newItem: () => ({ name: '', url: '', enabled: true }),
  },
  { type: 'section', label: 'Darstellung' },
  {
    key: 'mode',
    type: 'radio',
    label: 'Ansicht',
    options: [
      { value: 'liste', label: 'Liste' },
      { value: 'rotation', label: 'Schlagzeile (wechselnd)' },
      { value: 'ticker', label: 'Laufband' },
    ],
  },
  { key: 'maxItems', type: 'range', label: 'Anzahl Meldungen', min: 3, max: 30, step: 1 },
  {
    key: 'rotateSeconds',
    type: 'range',
    label: 'Wechsel alle',
    min: 5,
    max: 60,
    step: 1,
    unit: 's',
    showIf: (values) => values.mode === 'rotation',
  },
  { key: 'showImages', type: 'boolean', label: 'Bilder anzeigen', showIf: notTicker },
  { key: 'showSummary', type: 'boolean', label: 'Kurztext anzeigen', showIf: notTicker },
  { key: 'showSource', type: 'boolean', label: 'Quelle anzeigen' },
  { type: 'section', label: 'Filter' },
  {
    key: 'maxAgeHours',
    type: 'select',
    label: 'Höchstalter',
    options: [
      { value: 6, label: '6 Stunden' },
      { value: 12, label: '12 Stunden' },
      { value: 24, label: '24 Stunden' },
      { value: 48, label: '2 Tage' },
      { value: 72, label: '3 Tage' },
      { value: 168, label: '1 Woche' },
      { value: 0, label: 'Unbegrenzt' },
    ],
  },
  {
    key: 'excludeKeywords',
    type: 'stringList',
    label: 'Ausblenden bei Stichwort',
    description: 'Meldungen mit einem dieser Wörter im Titel oder Kurztext werden nicht angezeigt (Gross-/Kleinschreibung egal).',
    placeholder: 'Stichwort',
  },
  {
    key: 'refreshMinutes',
    type: 'select',
    label: 'Aktualisieren alle',
    options: [
      { value: 5, label: '5 Minuten' },
      { value: 10, label: '10 Minuten' },
      { value: 15, label: '15 Minuten' },
      { value: 30, label: '30 Minuten' },
      { value: 60, label: '1 Stunde' },
    ],
  },
];

export const newsManifest: WidgetManifest = {
  id: 'news',
  name: 'Nachrichten',
  description: 'Schlagzeilen aus RSS-Feeds (z. B. SRF, NZZ) als Liste, wechselnde Schlagzeile oder Laufband',
  version: '3.0.0',
  author: 'SlateDesk',
  category: 'Information',
  icon: 'Newspaper',
  minWidth: 3,
  minHeight: 1,
  defaultWidth: 4,
  defaultHeight: 4,
  permissions: ['network'],
  refreshInterval: 900,
  settingsSchema: newsSettingsSchema,
  defaultSettings: NEWS_DEFAULT_SETTINGS,
};
