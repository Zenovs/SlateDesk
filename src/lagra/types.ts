/**
 * Response types of lagra's read-only kiosk endpoints
 * (`GET /api/v1/uebersicht`, `GET /api/v1/jobs`, `GET /api/v1/pruefen`),
 * derived from lagra apps/web/lib/uebersicht.ts and the route handlers.
 *
 * Every section of the Übersicht is optional (only requested `teile` are
 * present) and may be `{ fehler }` on its own – one broken source never
 * fails the whole response.
 */

/** ISO 8601 timestamp, e.g. '2026-10-13T08:15:02.114Z'. */
export type IsoDate = string;

/** Sections in lagra's order. Without `teile=` lagra returns all but «nas» (slow) and «neu» (customer work). */
export type LagraTeil =
  | 'server'
  | 'jobs'
  | 'viren'
  | 'dam'
  | 'archiv'
  | 'feedback'
  | 'potentiale'
  | 'api'
  | 'nas'
  | 'neu';

/** A section that failed on lagra's side (first line of the error, max. 200 chars). */
export interface LagraFehler {
  fehler: string;
}

export type LagraSection<T> = T | LagraFehler;

export const isLagraFehler = (value: unknown): value is LagraFehler =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as LagraFehler).fehler === 'string';

// ── server ───────────────────────────────────────────────────────────────────

export interface LagraLaufwerk {
  name: string;
  /** Bytes */
  belegt: number;
  gesamt: number;
}

export interface LagraGpu {
  name: string;
  /** % */
  auslastung: number;
  /** Bytes */
  vramBelegt: number;
  vramGesamt: number;
  /** °C */
  temp: number | null;
  leistungW: number | null;
  luefterProzent: number | null;
}

export interface LagraLuefter {
  name: string;
  upm: number;
}

export interface LagraServer {
  /** One decimal; null right after start (no second sample yet). */
  cpuProzent: number | null;
  kerne: number;
  /** Load average 1/5/15 min. */
  last: number[];
  /** Bytes */
  ramBelegt: number;
  ramGesamt: number;
  /** °C */
  cpuTemp: number | null;
  laufzeitSek: number;
  laufwerke: LagraLaufwerk[];
  gpu: LagraGpu | null;
  /** Measurable components (CPU side + GPU), W. */
  leistungW: number | null;
  luefter: LagraLuefter[];
}

// ── jobs ─────────────────────────────────────────────────────────────────────

/** JobRun.status in lagra's database. */
export type LagraJobStatus = 'laeuft' | 'fertig' | 'fehler' | 'abgebrochen';
/** JobRun.trigger: scheduled or started by hand. */
export type LagraJobAusloeser = 'plan' | 'hand';
export type LagraPlanArt = 'intervall' | 'taeglich' | 'manuell';

export interface LagraZeitplan {
  aktiv: boolean;
  letzterTakt: IsoDate | null;
  /** No tick for > 3 min; null until the first tick after a server start. */
  steht: boolean | null;
}

export interface LagraLaufenderJob {
  id: string;
  name: string;
  /** Name-free progress, e.g. '37 aufbereitet, 2 übersprungen'. */
  fortschritt: string | null;
  seit: IsoDate | null;
}

export interface LagraLetzterJobLauf {
  id: string;
  name: string;
  status: LagraJobStatus;
  ausloeser: LagraJobAusloeser;
  beginn: IsoDate;
  ende: IsoDate | null;
  ergebnis: string | null;
  fehler: boolean;
}

export interface LagraJobsTeil {
  zeitplan: LagraZeitplan;
  laufend: LagraLaufenderJob[];
  /** Latest run per job, newest first. */
  zuletzt: LagraLetzterJobLauf[];
  fehler24h: number;
}

// ── viren ────────────────────────────────────────────────────────────────────

export interface LagraViren {
  eingerichtet: boolean;
  erreichbar: boolean;
  /** Why clamd is not reachable. */
  grund: string | null;
  version: string | null;
  signaturen: string | null;
  /** clamd's date text, e.g. 'Mon Oct 12 22:31:12 2026'. */
  signaturenStand: string | null;
  signaturenAlterTage: number | null;
  /** Older than 3 days. */
  signaturenVeraltet: boolean;
  heuteGeprueft: number;
  gesamtGeprueft: number;
  fehlerHeute: number;
  funde: number;
  funde7Tage: number;
  letzterFund: { am: IsoDate; signatur: string | null } | null;
}

// ── dam ──────────────────────────────────────────────────────────────────────

export type LagraAssetArt = 'BILD' | 'GRAFIK' | 'VIDEO' | 'AUDIO' | 'DOKUMENT' | 'ANDERE';

export interface LagraIndexLauf {
  laeuft: boolean;
  phase: 'dateien' | 'vorschauen' | 'fertig';
  dateienGesehen: number;
  vorschauenFertig: number;
  vorschauenFehlgeschlagen: number;
  ordnerUebersprungen: number;
  fehler: boolean;
}

export interface LagraDamNas {
  name: string;
  freigaben: number;
  /** Last time something new was indexed (not: last full read). */
  letzteAufnahme: IsoDate | null;
  /** Live index run since the last server start. */
  index: LagraIndexLauf | null;
}

export interface LagraLaufKurz {
  status: LagraJobStatus;
  beginn: IsoDate;
  ende: IsoDate | null;
  ergebnis: string | null;
}

export interface LagraDam {
  gesamt: number;
  proArt: Record<LagraAssetArt, number>;
  vorschauen: { erstellt: number; ausstehend: number; fehlgeschlagen: number };
  offeneAufbereitungen: number;
  /** AI tagging: images with preview / of those tagged. */
  ki: { bilder: number; verschlagwortet: number };
  nas: LagraDamNas[];
  letzterVollerLauf: LagraLaufKurz | null;
}

// ── archiv ───────────────────────────────────────────────────────────────────

export interface LagraArchivLauf {
  laeuft: boolean;
  phase: 'lesen' | 'schreiben' | 'fertig';
  gelesen: number;
  geschrieben: number;
  entfernt: number;
  fehler: boolean;
}

export interface LagraArchiv {
  eingerichtet: boolean;
  dateien: number;
  letzterIndex: IsoDate | null;
  /** A pass is unfinished – search does not find everything. */
  lueckenhaft: boolean;
  lauf: LagraArchivLauf | null;
}

// ── feedback / potentiale / api ──────────────────────────────────────────────

/** Team-wide counts – not anybody's personal badge. */
export interface LagraFeedback {
  ungelesen: number;
  offen: number;
  offenePunkte: number;
  neu7Tage: number;
}

export interface LagraPotentiale {
  vorgeschlagen: number;
  /** Accepted, not yet collected by durchblick. */
  angenommen: number;
  uebergeben: number;
  verworfen: number;
  letzterLauf: LagraLaufKurz | null;
}

export interface LagraApiToken {
  name: string;
  zuletzt: IsoDate | null;
}

export interface LagraApi {
  datenbank: boolean;
  ollama: boolean;
  aufrufe24h: number;
  fehler24h: number;
  tokens: LagraApiToken[];
}

// ── nas (opt-in) ─────────────────────────────────────────────────────────────

export interface LagraNasVolumen {
  name: string;
  /** Bytes */
  belegt: number;
  gesamt: number;
}

export interface LagraNas {
  name: string;
  modell: string | null;
  erreichbar: boolean;
  cpuProzent: number | null;
  ramProzent: number | null;
  tempC: number | null;
  diskTempMax: number | null;
  laufzeitSek: number | null;
  volumen: LagraNasVolumen[];
}

// ── neu (opt-in) ─────────────────────────────────────────────────────────────

export interface LagraNeuesAsset {
  id: string;
  art: LagraAssetArt;
  /** Only with `namen=1` – names often reveal the customer. */
  name: string | null;
  hinzugefuegt: IsoDate;
  /** '/api/v1/assets/<id>/vorschau' – needs the token (use lagraImageUrl). */
  vorschauPfad: string;
  /** Same with lagra's public base URL. */
  vorschauUrl: string;
}

// ── GET /api/v1/uebersicht ───────────────────────────────────────────────────

export interface LagraUebersicht {
  stand: IsoDate;
  dauerMs: number;
  teile: LagraTeil[];
  server?: LagraSection<LagraServer>;
  jobs?: LagraSection<LagraJobsTeil>;
  viren?: LagraSection<LagraViren>;
  dam?: LagraSection<LagraDam>;
  archiv?: LagraSection<LagraArchiv>;
  feedback?: LagraSection<LagraFeedback>;
  potentiale?: LagraSection<LagraPotentiale>;
  api?: LagraSection<LagraApi>;
  nas?: LagraSection<LagraNas[]>;
  neu?: LagraSection<LagraNeuesAsset[]>;
}

export interface LagraUebersichtQuery {
  teile?: readonly LagraTeil[];
  /** 1–30, default 12. */
  neuAnzahl?: number;
  /** Default 'BILD'; 'alle' = every kind with a preview. */
  neuArt?: LagraAssetArt | 'alle';
  /** Restrict «neu» to one folder below the API roots, e.g. '/daten/Intern/Schaufenster'. */
  ordner?: string;
  /** Include file names in «neu». */
  namen?: boolean;
}

// ── GET /api/v1/jobs ─────────────────────────────────────────────────────────

export interface LagraJobLauf {
  status: LagraJobStatus;
  ausloeser: LagraJobAusloeser;
  beginn: IsoDate;
  ende: IsoDate | null;
  dauerSek: number | null;
  ergebnis: string | null;
  fehler: boolean;
  /** Only with `details=1` (may name folders). */
  fehlerText: string | null;
}

export interface LagraJob {
  id: string;
  name: string;
  beschreibung: string;
  planArt: LagraPlanArt;
  aktiv: boolean;
  intervallMinuten: number | null;
  /** Hour of day for daily jobs. */
  stunde: number | null;
  /** Heavy job – only one of those runs at a time. */
  schwer: boolean;
  laeuft: boolean;
  seit: IsoDate | null;
  fortschritt: string | null;
  /** Estimate; null while running, for manual or inactive jobs. */
  naechsterLaufEtwa: IsoDate | null;
  /** Newest first. */
  verlauf: LagraJobLauf[];
}

export interface LagraJobs {
  zeitplan: LagraZeitplan;
  treffer: LagraJob[];
}

export interface LagraJobsQuery {
  /** Only this job (404 «Unbekannte Aufgabe» if unknown). */
  id?: string;
  /** 1–20, default 5. */
  verlauf?: number;
  /** Error texts and full progress (may contain names). */
  details?: boolean;
}

// ── GET /api/v1/pruefen (fallback when /uebersicht is missing) ───────────────

export interface LagraPruefen {
  eingerichtet: boolean;
  erreichbar: boolean;
  version: string | null;
  signaturen: string | null;
  signaturenStand: string | null;
  grund: string | null;
}
