# SlateDesk – Widgets entwickeln

Diese Anleitung beschreibt, wie ein Widget aufgebaut ist und wie ein neues dazukommt. Am Ende steht ein
vollständiges, geprüftes Beispiel ([Wechselkurse](#vollständiges-beispiel-wechselkurse)).

## Bausteine

| Datei | Inhalt | Wichtig |
|---|---|---|
| `src/widgets/manifests/<id>.ts` | Manifest: Name, Grössen, Kategorie, Icon, **Einstellungsschema** und **Standardwerte**, dazu der TypeScript-Typ der Einstellungen | reine Daten – die Fernsteuerung importiert die Datei auch; keine React-, Tauri- oder Widget-Importe |
| `src/widgets/<Name>Widget.tsx` | React-Komponente für den Kiosk, optional eine `…SettingsExtra`-Komponente | exportiert nur Komponenten (React Fast Refresh) |
| `src/widgets/styles/<id>.css` | Styles des Widgets, importiert von der Komponente | Theme-Tokens, Container-Queries |
| `src/widgets/catalog.ts` | Liste aller Manifeste (Widget-Katalog von Kiosk und Fernsteuerung) | Manifest hier eintragen |
| `src/widgets/index.ts` | Registrierung für den Kiosk: Manifest + Komponente (+ Extra) | Komponente hier eintragen |
| `src/components/settings/widgetIcons.ts` | erlaubte Icon-Namen (lucide-react) | neues Icon hier ergänzen |

Die Einstellungen rendert nicht das Widget selbst: Für jedes Manifest mit `settingsSchema` zeigt der
Kiosk-Rahmen (`WidgetWrapper`) im Bearbeiten-Modus ein Zahnrad, das den Dialog mit dem generischen
`SettingsForm` öffnet. Die Fernsteuerung rendert dasselbe Schema unter **Widgets**. Gespeichert wird im
Backend unter `widgetSettings[<instanceId>]` in `state.json`; Kiosk und Fernsteuerung sehen Änderungen
sofort.

## Ablauf

1. Manifest `src/widgets/manifests/<id>.ts` anlegen (Schema, Standardwerte, Typ).
2. Komponente `src/widgets/<Name>Widget.tsx` und Styles `src/widgets/styles/<id>.css` schreiben.
3. Manifest in `catalog.ts`, Komponente in `index.ts` eintragen; Icon in `widgetIcons.ts`, falls neu.
4. `npm test` (vor allem `catalog.test.ts`), `npm run lint`, `npm run build`.
5. In der App ausprobieren (`npx tauri dev`): Widget im Bearbeiten-Modus hinzufügen, Einstellungen am Kiosk
   und in der Fernsteuerung (`http://localhost:5173/remote.html`) ändern, verschiedene Grössen, Hell und Dunkel.

## Manifest

```ts
export interface WidgetManifest {
  id: string;                 // eindeutig, Kleinbuchstaben mit Bindestrich, z. B. 'planbar-zeit' – nie mehr ändern
  name: string;               // Anzeigename (Katalog, Kopfzeile, Fernsteuerung)
  description: string;        // ein Satz für den Katalog
  version: string;
  author: string;
  category?: WidgetCategory;  // 'Zeit & Kalender' | 'Information' | 'Medien' | 'Netzwerk' | 'Sensorik & KI' | 'Büro' | 'lagra' | 'planbar'
  icon?: string;              // lucide-react-Name, muss in widgetIcons.ts stehen
  minWidth: number;           // Rastereinheiten (Standardraster: 12 Spalten, Zeilen à 80 px)
  minHeight: number;
  defaultWidth: number;       // ≤ 12, ≥ minWidth
  defaultHeight: number;
  permissions: string[];      // rein informativ, z. B. ['network'] – wird nicht durchgesetzt
  refreshInterval?: number;   // Sekunden, rein informativ
  settingsSchema?: SettingsField[];
  defaultSettings?: Record<string, unknown>;
  singleton?: boolean;        // höchstens eine Instanz pro Dashboard (z. B. Widgets, die die Kamera belegen)
}
```

- `id` landet in `state.json` jedes Kiosks. Eine umbenannte ID macht vorhandene Widgets zu «Unbekanntes
  Widget».
- `defaultSettings` muss eine **Modulkonstante** aus reinen JSON-Daten sein: `useWidgetSettings` verwendet
  das Objekt als stabile Referenz, und gespeichert wird JSON.
- Neue Einstellungen bekommen immer einen Standardwert. Gespeicherte Einstellungen werden über die
  Standardwerte gelegt – ein älterer Kiosk-Zustand ohne den neuen Schlüssel erhält so automatisch den
  Standard.
- Schlüssel umbenennen heisst migrieren: im Widget den alten Schlüssel lesen, solange der neue fehlt.

## Einstellungen (`settingsSchema`)

Das Schema (`src/types/settings.ts`) ist eine Liste von Feldern. Alle Felder ausser `section` haben

| Eigenschaft | Bedeutung |
|---|---|
| `key` | Schlüssel in den Einstellungen |
| `label` | Beschriftung |
| `description` | Hilfetext unter dem Feld (optional) |
| `showIf(values)` | Feld nur zeigen, wenn die Funktion `true` liefert; bekommt die aktuellen Werte (in einer `list` die Werte des Eintrags) |
| `kioskOnly` | nur im Kiosk-Dialog, nicht in der Fernsteuerung (z. B. Auswahl lokaler Geräte) |

### Feldtypen

| `type` | Wert | Zusätzliche Eigenschaften |
|---|---|---|
| `section` | – (Überschrift, gruppiert die folgenden Felder) | `label`, `description`, `showIf` |
| `text`, `textarea` | `string` | `placeholder` |
| `url` | `string` | `placeholder`; wird erst beim Verlassen des Felds bzw. mit Enter übernommen |
| `secret` | `string` | `placeholder`; wird nie angezeigt, nur «gesetzt» (siehe unten) |
| `number` | `number` | `min`, `max`, `step`, `unit` |
| `range` | `number` (Schieberegler) | `min`, `max` (Pflicht), `step`, `unit` |
| `boolean` | `boolean` (Schalter) | – |
| `radio` | `string \| number` | `options: { value, label }[]` |
| `select` | `string \| number` | `options`, optional `optionsProvider` (geladene Einträge folgen den festen) |
| `multiselect` | `string[]` | `options?: { value, label, group?, hint? }[]`, `optionsProvider?`, `ordered?`, `placeholder?` (Suchfeld) |
| `color` | `string` (`#rrggbb`) | – |
| `time` | `string` (`'HH:MM'`) | – |
| `days` | `number[]` (0 = Sonntag … 6 = Samstag, angezeigt Mo–So) | – |
| `stringList` | `string[]` | `placeholder`, `addLabel` |
| `list` | `Record<string, unknown>[]` | `itemFields` (Schema eines Eintrags), `newItem()` (Standardeintrag), `addLabel`, `itemTitleKey` (Feld als Titel des Eintrags) |

Das Formular speichert Änderungen selbständig: Auswahlfelder sofort, Texte und Zahlen nach kurzer Pause
oder beim Verlassen des Felds, Adressen (`url` und Schlüssel, die auf `url`/`host` enden) nur beim
Verlassen bzw. mit Enter. Jede Speicherung ist ein Schreibzugriff im Backend und kann eine neue Abfrage
des Widgets auslösen – nie pro Tastendruck laden.

### `multiselect` und Options-Provider

Ein `multiselect` speichert eine Liste von IDs. Bei mehr als sechs Einträgen erscheint ein Suchfeld, mit
`group` werden Einträge gruppiert (z. B. Projekte nach Kunde), `hint` zeigt einen Zusatz (z. B. Teams einer
Person). Mit `ordered: true` bestimmt die Reihenfolge der Auswahl die Anzeigereihenfolge und lässt sich
mit Pfeilen ändern. Gespeicherte IDs, die die Liste nicht mehr kennt, erscheinen als «Unbekannt (<id>)»
und lassen sich entfernen.

Einträge, die erst zur Laufzeit bekannt sind (Personen, Projekte …), liefert ein **Options-Provider**:

```ts
// src/<integration>/options.ts
import { registerOptionProvider } from '../components/settings/optionProviders';

export const MEIN_PROVIDER = 'meinDienst.raeume';

registerOptionProvider(MEIN_PROVIDER, async () => {
  const raeume = await ladeRaeume(); // muss im Kiosk UND in der Fernsteuerung funktionieren
  return raeume.map((r) => ({ value: r.id, label: r.name, group: r.stockwerk }));
});
```

```ts
// im Manifest – der Import registriert den Provider in Kiosk und Fernsteuerung
import { MEIN_PROVIDER } from '../../meinDienst/options';

{ type: 'multiselect', key: 'raeume', label: 'Räume', optionsProvider: MEIN_PROVIDER, ordered: true }
```

- Werte eines Providers sind immer Strings. Ergebnisse werden 60 Sekunden für alle Formulare
  zwischengespeichert; bei einem Fehler zeigt das Feld die Meldung mit «Neu laden» und behält die letzten
  Einträge. `invalidateOptionProvider(name)` verwirft den Zwischenspeicher (z. B. nach neuem API-Schlüssel).
- Der Loader läuft auch in der Fernsteuerung, also ausserhalb von Tauri. Vorbild ist
  `src/planbar/options.ts`: `src/planbar/client.ts` fragt im Kiosk über `planbarGet` ab und in der
  Fernsteuerung über den Proxy `/api/planbar/…` des Kiosks.
- Bei `select` mit Provider dürfen feste `options` davor stehen, z. B. `[{ value: '', label: 'Niemand' }]`.

### Geheimnisse und Adressen

- Ein Feld ist **genau dann** `type: 'secret'`, wenn sein Schlüssel (Gross-/Kleinschreibung egal) auf
  `apikey`, `token`, `password` oder `secret` endet. Das Backend schwärzt solche Schlüssel in jeder
  HTTP-Antwort und im Export (`"__gesetzt__"`) – unabhängig vom Schema. Ein Boolean heisst darum nie
  `showToken`, und ein Geheimnis nie `zugang`.
- Ändert die Fernsteuerung einen Schlüssel, der auf `url` oder `host` endet, löscht das Backend ein
  Geheimnis **im selben Objekt**, sofern es nicht in derselben Anfrage neu gesetzt wird. So lässt sich
  kein Token auf einen fremden Server umleiten. Eine Adresse, die mit dem Geheimnis nichts zu tun hat,
  deshalb anders benennen (der KI-Assistent nennt seinen lokalen Server `localEndpoint`, weil daneben der
  OpenAI-`apiKey` liegt).
- Geheimnisse nie im Widget anzeigen oder loggen; der Kiosk-Bildschirm steht oft im Besucherbereich.

### Kiosk-Extras (`settingsExtra`)

Was das Schema nicht abbildet – Verbindungstest, Auswahl einer Kamera, Liste installierter Modelle,
Statusanzeigen – gehört in eine eigene Komponente `({ instanceId }) => …`, die als `settingsExtra` registriert
wird. Sie erscheint nur im Kiosk-Dialog unter dem Formular. Einstellungen schreibt sie mit
`useWidgetSettings`. Beispiele: `VolumioSettingsExtra`, `NasSettingsExtra`, `SleeperSettingsExtra`.

## Komponente

```ts
interface WidgetProps {
  instanceId: string; // Schlüssel der Einstellungen dieser Instanz
  width: number;      // Rastereinheiten – nicht für Pixelgrössen verwenden
  height: number;
}
```

Der Rahmen um das Widget (`WidgetWrapper`) stellt Kopfzeile, Einstellungsdialog, Ladeanzeige für
nachgeladene Widgets und eine Fehlergrenze: Stürzt ein Widget ab, zeigt der Rahmen «Widget-Fehler» und
versucht es nach 1 Minute erneut (mit wachsendem Abstand bis 30 Minuten), damit der Kiosk ohne Eingriff
weiterläuft. Eine Änderung der Einstellungen setzt den Fehler zurück.

### `useWidgetSettings`

```ts
const [settings, update] = useWidgetSettings<MeineSettings>(instanceId, MEINE_DEFAULTS);
update({ modus: 'liste' }); // schreibt nur die übergebenen Schlüssel
```

- Liefert die gespeicherten Werte über den Standardwerten; das Objekt bleibt gleich, bis sich die
  Einstellungen dieser Instanz ändern – sicher in Effekt-Abhängigkeiten.
- `defaults` muss stabil sein (die Modulkonstante aus dem Manifest).
- Werte **defensiv lesen**: Sie können aus älteren Versionen, einem Import oder der Fernsteuerung stammen.
  Helfer in `src/widgets/shared/values.ts`: `readBoolean`, `readString`, `readNumber(wert, standard, min, max)`,
  `readChoice(wert, auswahl, standard)`.

### `usePolling`

```ts
const poll = usePolling(
  (signal) => ladeDaten(ort, signal), // Loader, bekommt ein AbortSignal
  intervalMs,                         // null oder 0 = nur einmal laden
  [ort],                              // Abhängigkeiten wie bei useEffect
  { enabled, pauseWhenHidden, runImmediately },
);
// poll.data, poll.error, poll.loading, poll.lastUpdated, poll.refresh()
```

- Behält bei einem Fehler die letzten guten Daten (`data`) und meldet den Fehler daneben (`error`, deutscher
  Text der geworfenen Exception).
- Wartet nach Fehlern zunehmend länger (höchstens 5 Minuten), überlappt Läufe nie, pausiert, solange die
  Seite verborgen ist, und bricht veraltete Läufe über das `AbortSignal` ab.
- Ändern sich die Abhängigkeiten, beginnt es mit leeren Daten neu. Die Abhängigkeiten werden mit
  `Object.is` verglichen: **nur primitive Werte** oder stabile Objekte übergeben. Ein bei jedem Render neu
  gebautes Array startet die Abfrage endlos neu – Listen deshalb z. B. mit `join(',')` übergeben.
- Für lagra und planbar gibt es `useLagraPolling` (`src/widgets/shared/hooks.ts`) bzw. `usePlanbarPolling`
  (`src/widgets/planbar/usePlanbarPolling.ts`): Sie laufen nur, solange die Verbindung eingerichtet ist,
  starten bei neuer Adresse oder neuem Zugang neu und liefern Art und Beginn des Fehlers.

### Backend (`src/utils/backend.ts`)

Widgets sprechen das Rust-Backend nur über die typisierten Wrapper in `backend.ts` an – **nie**
`@tauri-apps/*` direkt importieren (das würde Tauri in die Fernsteuerung ziehen) und nie `invoke` selbst
aufrufen. Ausserhalb von Tauri (Browser, Fernsteuerung) lehnen alle Wrapper mit `KIOSK_ONLY_MESSAGE`
(«Nur im Kiosk verfügbar») ab; `isTauri()` prüft das vorab.

| Wrapper | Zweck |
|---|---|
| `httpFetch({ url, method?, headers?, body?, timeoutMs?, responseType? })` | beliebige HTTP(S)-Anfrage über das Backend (kein CORS), Antwort `{ status, contentType, body, finalUrl }`, max. 15 MB, Standard-Timeout 15 s; `responseType: 'base64'` für Bilder |
| `feedsFetch(feeds, maxItems?)` | RSS/Atom laden, zusammenführen, sortieren |
| `calendarEvents(sources, fromMs, toMs)` | ICS-Kalender mit Serienterminen |
| `netCheck(targets)`, `runSpeedTest()` | Ping/TCP/HTTP-Prüfungen, Speedtest |
| `lagraGet(path, query?)`, `lagraImage(url)` | lagra (Token bleibt im Backend); im Widget besser `src/lagra/client.ts` |
| `planbarGet(path, query?)`, `planbarPatch(path, body)` | planbar (Schlüssel bleibt im Backend); im Widget besser `src/planbar/client.ts` |
| `systemInfo()`, `remoteInfo()`, `qrSvg(text)` | Gerätedaten, Adressen der Fernsteuerung, QR-Code als SVG |
| `sleepDisplay()`, `wakeDisplay()`, `displayCapabilities()` | Bildschirm aus/an |
| `checkOllama(baseUrl?)` | Status und Modelle eines Ollama-Servers |

Externe Abfragen laufen über `httpFetch` statt über `fetch()`: kein CORS, und die CSP der Kiosk-Ansicht
bleibt eng. Ein neuer Rust-Befehl braucht einen Eintrag in `src-tauri/src/lib.rs` (`generate_handler!`) und
einen Wrapper in `backend.ts`; Rust-Befehle sind `async` und blockieren nie (Timeouts, `kill_on_drop`).

### Weitere Hilfsmittel

- `src/widgets/shared/WidgetParts.tsx` – `WidgetMessage` (füllt das Widget: Leer-, Lade-, Einrichtungs- und
  Fehlerzustand), `WidgetBanner` (einzeiliger Hinweis, z. B. «Stand 14:05 – Aktualisierung fehlgeschlagen»),
  `StatusDot`, `Meter`.
- `src/widgets/shared/format.ts` – Zahlen, Bytes, Dauer, Uhrzeit, «vor 5 Minuten» im Schweizer Format.
- `useNow(intervalMs)` (`shared/hooks.ts`) – aktuelle Zeit als State. In der Render-Funktion nie
  `Date.now()` oder `Math.random()` aufrufen.
- `useElementSize(ref)` (`src/hooks/useElementSize.ts`) – tatsächliche Pixelgrösse eines Elements, wenn CSS
  allein nicht reicht (z. B. QR-Code quadratisch einpassen).
- `useAppState(selector)` (`src/state/appState.ts`) – gemeinsamer Zustand, z. B. `s.state.kiosk.name`.
  Schreiben nur über die Aktionen in `src/state/dataActions.ts`.
- `eventBus` (`src/utils/eventBus.ts`) – Ereignisse zwischen Widgets, z. B. `display:schedule`
  `{ active }` der Bildschirmzeiten.
- Daten im `localStorage` (Verlauf, Zwischenspeicher) immer pro Instanz unter
  `slatedesk:<widget>:<instanceId>:…` ablegen – der Kiosk löscht sie, wenn die Instanz entfernt wird. Leere
  oder kaputte Werte müssen das Widget überstehen. Alles, was Kiosk und Fernsteuerung teilen, gehört in die
  Einstellungen, nicht in den `localStorage`.

## Layout und CSS

- `.widget-body` ist ein Size-Container namens `widget`. Grössen kommen aus der echten Pixelgrösse:
  Einheiten `cqw`, `cqh`, `cqmin` (z. B. `font-size: clamp(16px, 10cqmin, 44px)`) und Abfragen wie
  `@container widget (max-height: 120px) { … }`. `width`/`height` aus `WidgetProps` sind Rastereinheiten
  und taugen nicht für Pixelgrössen.
- Eigene Datei `src/widgets/styles/<id>.css` mit einem kurzen, eigenen Klassenpräfix; `src/styles/widgets.css`
  ist für den Rahmen reserviert.
- Nur Theme-Tokens aus `src/styles/tokens.css` verwenden, dann stimmen Hell, Dunkel und die Akzentfarbe:
  `--text-primary`, `--text-secondary`, `--text-tertiary`, `--bg-secondary`, `--bg-tertiary`,
  `--border-color`, `--accent-color`, `--accent-color-rgb`, `--success-color`, `--warning-color`,
  `--error-color`, `--info-color`, `--spacing-xs` … `--spacing-2xl`, `--radius-sm` … `--radius-xl`,
  `--font-size-xs` … `--font-size-3xl`, `--font-weight-*`.
- Inhalte müssen von der Mindestgrösse bis zum ganzen Bildschirm funktionieren: `min-height: 0` und
  `overflow: hidden` in Flex-Spalten, Text mit `text-overflow: ellipsis` kürzen.
- Bedienelemente am Kiosk sind Touch-Ziele: mindestens 40 × 40 px.

## Registrieren

`src/widgets/catalog.ts` – Manifest importieren und in `widgetCatalog` eintragen (die Reihenfolge ist die
Reihenfolge im Katalog innerhalb der Kategorie):

```ts
import { wechselkurseManifest } from './manifests/wechselkurse';

export const widgetCatalog: WidgetManifest[] = [
  // …
  wechselkurseManifest,
];
```

`src/widgets/index.ts` – Komponente registrieren:

```ts
import { wechselkurseManifest } from './manifests/wechselkurse';
import { WechselkurseWidget } from './WechselkurseWidget';

const widgetDefinitions: WidgetDefinition[] = [
  // …
  { manifest: wechselkurseManifest, component: WechselkurseWidget },
];
```

Grosse Widgets, die die meisten Dashboards nicht brauchen, werden nachgeladen, damit der Kiosk schnell
startet – Muster in `index.ts`:

```ts
const loadCamera = () => import('./CameraWidget');
const CameraWidget = lazyExport(loadCamera, (m) => m.CameraWidget);
const CameraSettingsExtra = lazyExport(loadCamera, (m) => m.CameraSettingsExtra);
```

`src/components/settings/widgetIcons.ts` – ein neues Icon importieren und in `WIDGET_ICONS` eintragen (die
Liste ist bewusst explizit, damit nur verwendete Icons im Bundle landen).

## Regeln von `catalog.test.ts`

Der Test prüft jedes Manifest im Katalog:

- IDs sind eindeutig; Grössen sind ganze Zahlen ≥ 1, `min… ≤ default…`, `defaultWidth ≤ 12`; die Kategorie
  steht in `WIDGET_CATEGORIES`.
- `icon` ist gesetzt und steht in `widgetIcons.ts`.
- Jedes Widget hat ein nicht leeres `settingsSchema` und `defaultSettings`.
- `defaultSettings` und jedes `newItem()` sind reine JSON-Daten; jeder Schlüssel der obersten Ebene hat
  einen Standardwert; keine doppelten Schlüssel.
- `type: 'secret'` genau bei Schlüsseln mit Endung `apikey`/`token`/`password`/`secret` – auch in `list`-Einträgen.
- `multiselect`-Standardwerte sind String-Listen; ohne Provider stehen sie in `options`. Ein `select` mit
  Provider hat einen String oder einen festen Wert als Standard. Jeder genannte `optionsProvider` ist
  registriert – also das Modul mit `registerOptionProvider` aus dem Manifest importieren.
- `showIf` liefert für die Standardwerte ein Boolean und wirft nicht.
- Das Standard-Dashboard (`src/state/defaults.ts`) verwendet nur Katalog-Widgets in mindestens ihrer
  Mindestgrösse, ohne Überlappung, und passt auf 1920 × 1080.

## Vollständiges Beispiel: Wechselkurse

Ein Widget, das die Referenzkurse der Europäischen Zentralbank von der freien
[Frankfurter-API](https://frankfurter.dev) zeigt – mit Mehrfachauswahl, Polling über das Backend,
Fehler- und Leerzuständen und Container-Queries. Die drei Dateien und die beiden Einträge oben ergeben ein
lauffähiges Widget, das `tsc`, ESLint und `catalog.test.ts` besteht.

### `src/widgets/manifests/wechselkurse.ts`

```ts
import type { SettingsChoice, SettingsField } from '../../types/settings';
import type { WidgetManifest } from '../../types/widget';

export const WECHSELKURS_BASEN = ['CHF', 'EUR'] as const;
export type WechselkursBasis = (typeof WECHSELKURS_BASEN)[number];

const WAEHRUNGEN: SettingsChoice[] = [
  { value: 'CHF', label: 'Schweizer Franken (CHF)' },
  { value: 'EUR', label: 'Euro (EUR)' },
  { value: 'USD', label: 'US-Dollar (USD)' },
  { value: 'GBP', label: 'Britisches Pfund (GBP)' },
  { value: 'JPY', label: 'Japanischer Yen (JPY)' },
];

/** Codes, die die Einstellungen anbieten – das Widget zeigt nur diese. */
export const WECHSELKURS_CODES: readonly string[] = WAEHRUNGEN.map((choice) => choice.value);

export type WechselkursSettings = {
  basis: WechselkursBasis;
  /** Währungscodes in Anzeigereihenfolge. */
  waehrungen: string[];
  refreshMinutes: number;
};

/** Modulkonstante: useWidgetSettings braucht ein stabiles Objekt. */
export const WECHSELKURS_DEFAULTS: WechselkursSettings = {
  basis: 'CHF',
  waehrungen: ['EUR', 'USD'],
  refreshMinutes: 60,
};

const settingsSchema: SettingsField[] = [
  {
    type: 'section',
    label: 'Währungen',
    description: 'Referenzkurse der Europäischen Zentralbank, werktags gegen 16 Uhr aktualisiert.',
  },
  {
    type: 'radio',
    key: 'basis',
    label: 'Basiswährung',
    options: [
      { value: 'CHF', label: 'CHF' },
      { value: 'EUR', label: 'EUR' },
    ],
  },
  {
    type: 'multiselect',
    key: 'waehrungen',
    label: 'Anzeigen',
    description: 'In der gewählten Reihenfolge. Die Basiswährung selbst wird übersprungen.',
    options: WAEHRUNGEN,
    ordered: true,
  },
  {
    type: 'select',
    key: 'refreshMinutes',
    label: 'Aktualisieren',
    options: [
      { value: 30, label: 'Alle 30 Minuten' },
      { value: 60, label: 'Jede Stunde' },
      { value: 240, label: 'Alle 4 Stunden' },
    ],
  },
];

export const wechselkurseManifest: WidgetManifest = {
  id: 'wechselkurse',
  name: 'Wechselkurse',
  description: 'Devisenkurse der EZB für ausgewählte Währungen',
  version: '1.0.0',
  author: 'SlateDesk',
  category: 'Information',
  icon: 'TrendingUp',
  minWidth: 2,
  minHeight: 2,
  defaultWidth: 3,
  defaultHeight: 3,
  permissions: ['network'],
  refreshInterval: WECHSELKURS_DEFAULTS.refreshMinutes * 60,
  settingsSchema,
  defaultSettings: WECHSELKURS_DEFAULTS,
};
```

`TrendingUp` steht bereits in `widgetIcons.ts`.

### `src/widgets/WechselkurseWidget.tsx`

```tsx
/**
 * Wechselkurse – Referenzkurse der EZB über die freie Frankfurter-API.
 * Die Abfrage läuft über das Rust-Backend (httpFetch), nicht über fetch():
 * keine CORS-Probleme, und die CSP der Kiosk-Ansicht bleibt eng.
 */
import { TrendingUp } from 'lucide-react';
import { usePolling } from '../hooks/usePolling';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import type { WidgetProps } from '../types/widget';
import { httpFetch, isTauri, KIOSK_ONLY_MESSAGE } from '../utils/backend';
import {
  WECHSELKURS_BASEN,
  WECHSELKURS_CODES,
  WECHSELKURS_DEFAULTS,
  type WechselkursSettings,
} from './manifests/wechselkurse';
import { formatClock } from './shared/format';
import { WidgetBanner, WidgetMessage } from './shared/WidgetParts';
import { readChoice, readNumber } from './shared/values';
import './styles/wechselkurse.css';

interface Kurse {
  /** «2026-10-12» – Tag der EZB-Veröffentlichung. */
  datum: string;
  kurse: Record<string, number>;
}

const kursFormat = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 4, maximumFractionDigits: 4 });

async function ladeKurse(basis: string, ziele: string): Promise<Kurse> {
  const params = new URLSearchParams({ base: basis, symbols: ziele });
  const res = await httpFetch({
    url: `https://api.frankfurter.dev/v1/latest?${params}`,
    headers: { Accept: 'application/json' },
    timeoutMs: 10_000,
  });
  if (res.status !== 200) throw new Error(`Kursdienst antwortet mit HTTP ${res.status}`);

  // Fremde Daten nie ungeprüft rendern.
  const body = JSON.parse(res.body) as { date?: unknown; rates?: unknown };
  if (typeof body.date !== 'string' || typeof body.rates !== 'object' || body.rates === null) {
    throw new Error('Kursdienst: unerwartete Antwort');
  }
  const kurse: Record<string, number> = {};
  for (const [code, wert] of Object.entries(body.rates)) {
    if (typeof wert === 'number' && Number.isFinite(wert)) kurse[code] = wert;
  }
  return { datum: body.date, kurse };
}

/** «2026-10-12» → «12.10.2026» */
const datumText = (iso: string): string => iso.split('-').reverse().join('.');

export function WechselkurseWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings<WechselkursSettings>(instanceId, WECHSELKURS_DEFAULTS);
  // Gespeicherte Werte können von älteren Versionen oder Importen stammen – defensiv lesen.
  const basis = readChoice(raw.basis, WECHSELKURS_BASEN, WECHSELKURS_DEFAULTS.basis);
  const refreshMinutes = readNumber(raw.refreshMinutes, WECHSELKURS_DEFAULTS.refreshMinutes, 15, 1440);
  const ziele = (Array.isArray(raw.waehrungen) ? raw.waehrungen : [])
    .filter((code): code is string => typeof code === 'string' && WECHSELKURS_CODES.includes(code) && code !== basis)
    .join(',');
  const inKiosk = isTauri();

  // deps sind Strings: ein neues Array bei jedem Render würde die Abfrage endlos neu starten.
  const poll = usePolling(() => ladeKurse(basis, ziele), refreshMinutes * 60_000, [basis, ziele], {
    enabled: inKiosk && ziele !== '',
  });

  if (!inKiosk) {
    return <WidgetMessage icon={TrendingUp} title={KIOSK_ONLY_MESSAGE} detail="Die Kurse lädt das Backend der Kiosk-App." />;
  }
  if (ziele === '') {
    return (
      <WidgetMessage icon={TrendingUp} title="Keine Währung gewählt" detail="In den Einstellungen mindestens eine Währung auswählen." />
    );
  }
  const data = poll.data;
  if (!data) {
    return poll.error ? (
      <WidgetMessage icon={TrendingUp} tone="error" title="Kurse nicht verfügbar" detail={poll.error} />
    ) : (
      <WidgetMessage busy title="Kurse werden geladen …" />
    );
  }

  return (
    <div className="fx">
      <ul className="fx-list">
        {ziele.split(',').map((code) => (
          <li key={code} className="fx-row">
            <span className="fx-pair">
              1 {basis} in {code}
            </span>
            <span className="fx-rate">{code in data.kurse ? kursFormat.format(data.kurse[code]) : '–'}</span>
          </li>
        ))}
      </ul>
      <div className="fx-foot">EZB-Kurs vom {datumText(data.datum)}</div>
      {poll.error && poll.lastUpdated !== null && (
        <WidgetBanner tone="warn">Stand {formatClock(poll.lastUpdated)} – Aktualisierung fehlgeschlagen</WidgetBanner>
      )}
    </div>
  );
}
```

Was das Beispiel zeigt:

- Alle Zustände sind abgedeckt: ausserhalb des Kiosks, nichts gewählt, erstes Laden, Fehler ohne Daten,
  Fehler mit alten Daten (Banner statt leerem Widget). Es gibt keine Beispiel- oder Demodaten.
- `httpFetch` kann nicht abgebrochen werden; deshalb ignoriert der Loader das `AbortSignal` – `usePolling`
  verwirft verspätete Antworten selbst.
- Die Antwort des fremden Dienstes wird geprüft, bevor sie gerendert wird.

### `src/widgets/styles/wechselkurse.css`

```css
/* Wechselkurse (WechselkurseWidget) – Grössen aus dem Widget-Container (cqmin), nicht aus Rastereinheiten. */

.fx {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  min-height: 0;
  overflow: hidden;
}

.fx-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: var(--spacing-xs);
}

.fx-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing-sm);
  min-width: 0;
}

.fx-pair {
  color: var(--text-secondary);
  font-size: clamp(12px, 5cqmin, 20px);
  white-space: nowrap;
}

.fx-rate {
  color: var(--text-primary);
  font-size: clamp(16px, 11cqmin, 44px);
  font-weight: var(--font-weight-bold);
  font-variant-numeric: tabular-nums;
}

.fx-foot {
  flex-shrink: 0;
  color: var(--text-tertiary);
  font-size: var(--font-size-xs);
}

/* Breite, niedrige Kachel: Kurse nebeneinander. */
@container widget (min-aspect-ratio: 2 / 1) {
  .fx-list {
    flex-direction: row;
    align-items: center;
    justify-content: space-around;
  }

  .fx-row {
    flex-direction: column;
    align-items: center;
  }
}

/* Sehr niedrig: Fusszeile weglassen. */
@container widget (max-height: 120px) {
  .fx-foot {
    display: none;
  }
}
```

Dazu die beiden Einträge aus [Registrieren](#registrieren). Danach erscheint «Wechselkurse» im Katalog
unter «Information» – am Kiosk und in der Fernsteuerung, mit demselben Einstellungsformular.

## Checkliste

- [ ] Texte auf Deutsch mit Schweizer Rechtschreibung («ss», nie «ß»).
- [ ] Kein Mock: Ohne Konfiguration erklärt ein Leerzustand, was einzurichten ist («In den Einstellungen …
      eintragen» bzw. «in der Fernsteuerung unter «…» einrichten»).
- [ ] Fehler deutsch und ruhig anzeigen, letzte Daten behalten; Fehler nie als «offline» tarnen.
- [ ] Keine Abfrage pro Tastendruck; Intervalle angemessen (der Kiosk läuft rund um die Uhr).
- [ ] Datenschutz: Was erscheint am Bildschirm, wenn Besuch davorsteht? Namen, Dateinamen, Termintitel nur
      mit bewusster Einstellung zeigen, wo das nötig ist.
- [ ] Hell und Dunkel, kleinste und grösste Grösse, Bearbeiten-Modus und Fernsteuerung ausprobiert.
- [ ] `npm test`, `npm run lint`, `npm run build` grün; bei Rust-Änderungen `cargo test` und `cargo clippy`.
