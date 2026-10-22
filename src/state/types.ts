/**
 * Persisted dashboard state – single source of truth lives in the Rust
 * backend (state.json). Shape is binding for kiosk, web UI and Rust.
 */

export interface AppStateData {
  version: 1;
  layout: LayoutData;
  widgetSettings: Record<string /* instanceId */, Record<string, unknown>>;
  theme: ThemeData;
  kiosk: KioskConfig;
  lagra: LagraConfig;
  planbar: PlanbarConfig;
  mail: MailConfig;
  data: {
    /** Keyed by id → race-free set/delete from kiosk and web UI. */
    todos: Record<string, TodoItem>;
    announcements: Record<string, Announcement>;
  };
}

export interface LayoutData {
  widgets: WidgetInstance[];
  /** Grid columns (default 12). */
  cols: number;
  /** Row height in px (default 80). */
  rowHeight: number;
  /** 0 = off; > 0: rowHeight is computed so that this many rows fill the screen height. */
  fitRows: number;
  /**
   * Widgets stay where they are put (utils/freeGrid). Missing in states of
   * older versions, whose grid moved every widget up into free space: their
   * positions are compacted once as that grid showed them (withDefaults), and
   * the kiosk stores the result (migrate.ts).
   */
  freePlacement: boolean;
}

export type ThemeMode = 'dark' | 'light';

export interface ThemeData {
  mode: ThemeMode;
  /** `null` = accent colour of the active theme. */
  accent: string | null;
}

export interface KioskConfig {
  /** Shown as web UI title and in the identify overlay. */
  name: string;
  showTopBar: boolean;
  /** false hides "Bearbeiten" on the kiosk (edit only via web UI). */
  allowLocalEditing: boolean;
  /** 0 = never. */
  editModeAutoExitMinutes: number;
  /** 0 = never hide. */
  cursorHideSeconds: number;
  displaySchedule: DisplaySchedule;
}

export interface DisplaySchedule {
  enabled: boolean;
  /** 'HH:MM' */
  on: string;
  /** 'HH:MM' */
  off: string;
  /** 0 = Sonntag … 6 = Samstag */
  days: number[];
}

export interface LagraConfig {
  enabled: boolean;
  url: string;
  token: string;
  /** Sign of life to lagra every minute; lagra mails when it stops (src-tauri/src/lagra.rs). */
  lebenszeichen: boolean;
}

export interface PlanbarConfig {
  enabled: boolean;
  url: string;
  /**
   * A planbar API key belongs to exactly one organisation («Unternehmen»), so
   * there is one key per Unternehmen. Keyed by id (`^[A-Za-z0-9_-]{1,40}$`) –
   * object paths keep the secret restore of the backend working.
   */
  unternehmen: Record<string, PlanbarOrgConfig>;
}

export interface PlanbarOrgConfig {
  /** Shown in the widgets (≤ 60 characters), may be empty. */
  name: string;
  /** Secret (`pk_live_…`) – redacted over HTTP; a new `planbar.url` over HTTP clears every key. */
  apiKey: string;
}

/** SMTP access for the Host-Monitor's outage mails (src-tauri/src/mail.rs). */
export interface MailConfig {
  enabled: boolean;
  /** Postausgangsserver, e.g. asmtp.mail.hostpoint.ch – changing it over HTTP clears the password. */
  host: string;
  /** 465 = TLS, anything else STARTTLS. */
  port: number;
  user: string;
  /** Secret – redacted over HTTP. */
  password: string;
  /** Sender address; '' = the user name. */
  from: string;
  /** Recipients, separated by comma or semicolon. */
  to: string;
}

export type TodoPriority = 'niedrig' | 'normal' | 'hoch';

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  /** Missing = 'Allgemein'. */
  list?: string;
  priority?: TodoPriority;
  /** YYYY-MM-DD */
  due?: string;
  assignee?: string;
  createdAt: number;
  doneAt?: number;
}

export type AnnouncementLevel = 'info' | 'wichtig' | 'erfolg';

export interface Announcement {
  id: string;
  title: string;
  text?: string;
  level: AnnouncementLevel;
  author?: string;
  /** epoch ms */
  from?: number;
  /** epoch ms */
  until?: number;
  pinned?: boolean;
  createdAt: number;
}

export interface WidgetInstance {
  instanceId: string;
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── Operations ───────────────────────────────────────────────────────────────

export type Path = (string | number)[];

export type StateOp =
  /** Create intermediate objects as needed. `path: []` replaces the whole state. */
  | { op: 'set'; path: Path; value: unknown }
  /**
   * Shallow merge into the object at path (created if missing). `create: false`
   * makes it a no-op when the target is missing – for edits of records that a
   * concurrent delete may have removed (they must not come back half-empty).
   */
  | { op: 'merge'; path: Path; value: Record<string, unknown>; create?: boolean }
  /** Remove key / array index; no-op if missing. */
  | { op: 'delete'; path: Path }
  /** Append to the array at path (created if missing). */
  | { op: 'push'; path: Path; value: unknown };

/** State as stored by the backend: may lack keys, never trusted. */
export type RawState = Record<string, unknown>;

export interface StateSnapshot {
  rev: number;
  state: RawState;
}

export interface StateEvent extends StateSnapshot {
  origin: string;
  /**
   * Set by a transport after it lost and regained its event stream: the
   * snapshot was loaded fresh and is authoritative even if its rev is lower
   * (backend state was reset).
   */
  resync?: boolean;
}

export type TransportKind = 'tauri' | 'http' | 'local';

export interface StateTransport {
  readonly kind: TransportKind;
  load(): Promise<StateSnapshot>;
  apply(ops: StateOp[]): Promise<{ rev: number }>;
  /**
   * `onStatus` reports whether live updates are currently flowing.
   * `onSessionLost`: the stream was refused because the web UI session ended
   * (HTTP only) – the transport has stopped reconnecting.
   */
  subscribe(
    cb: (event: StateEvent) => void,
    onStatus?: (connected: boolean) => void,
    onSessionLost?: () => void,
  ): () => void;
}
