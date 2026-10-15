/**
 * planbar `/api/v1` types used by SlateDesk (work dashboard): people,
 * Arbeitsliste, Projektübersicht, News and booked time. Day fields
 * (`…Day`, `today`, `weekStart`) are Europe/Zurich days `YYYY-MM-DD`,
 * timestamps ISO-8601 UTC. Ids are planbar cuids; a project id is the
 * planbar ticket id.
 */

export interface PlanbarPerson {
  id: string;
  name: string;
}

export interface PlanbarTeam {
  id: string;
  name: string;
  color: string;
}

export type PlanbarRole = 'org_admin' | 'projektleiter' | 'koordinator' | 'member';

// ── GET /api/v1/mitglieder ───────────────────────────────────────────────────

export interface PlanbarMember {
  id: string;
  /** May be '' – use `email` then (see `planbarMemberName`). */
  name: string;
  email: string;
  /** A PlanbarRole; kept open for roles planbar may add. */
  role: string;
  teams: PlanbarTeam[];
}

export interface PlanbarMemberList {
  data: PlanbarMember[];
}

// ── GET /api/v1/arbeitsliste, PATCH /api/v1/arbeitsliste/:id ─────────────────

export type PlanbarPriority = 'low' | 'medium' | 'high' | 'critical';

export interface PlanbarProjectRef {
  /** Ticket id. */
  id: string;
  customerProjectId: string | null;
  name: string;
  /** null for internal projects. */
  customer: { id: string; name: string } | null;
}

export interface PlanbarWorkItem {
  type: 'aufgabe' | 'projekt';
  id: string;
  title: string;
  /** Tasks: open | in_progress | done; projects: planned | open | in_progress | on_hold | done | closed. */
  status: string;
  /** German label – prefer it for display. */
  statusLabel: string;
  done: boolean;
  /** A PlanbarPriority (open for future values); tasks carry the priority of their project. */
  priority: string | null;
  priorityLabel: string | null;
  dueDate: string | null;
  dueDay: string | null;
  overdue: boolean;
  estimatedHours: number | null;
  /** Primary person, may be null. */
  assignee: PlanbarPerson | null;
  /** Everyone assigned, primary first. */
  assignees: PlanbarPerson[];
  project: PlanbarProjectRef;
  /** Project title for tasks, null for projects. */
  parentTitle: string | null;
  /** Opens planbar in the browser (login there required). */
  url: string;
  updatedAt: string;
}

export interface PlanbarWorkList {
  data: PlanbarWorkItem[];
  /** All matching items before `limit` → «+N weitere». */
  total: number;
  limit: number;
  /** planbar's Zurich day – group by it, not by the kiosk clock. */
  today: string;
}

export interface PlanbarWorkItemPatchResult {
  data: PlanbarWorkItem;
  /** New instance of a recurring task (re-fetch the list after a change). */
  nextInstanceId: string | null;
}

export type PlanbarWorkStatus = 'offen' | 'alle';
export type PlanbarWorkType = 'alle' | 'aufgabe' | 'projekt';

export interface PlanbarWorkListQuery {
  /** Required: whose work (ids from /mitglieder), max 50. */
  benutzer: readonly string[];
  /** Ticket or customer-project ids, max 100. */
  projekte?: readonly string[];
  status?: PlanbarWorkStatus;
  typ?: PlanbarWorkType;
  /** Only items due on or before this Zurich day `YYYY-MM-DD` (drops items without date). */
  bis?: string;
  /** 1–200, default 50. */
  limit?: number;
}

// ── GET /api/v1/projektuebersicht ────────────────────────────────────────────

export interface PlanbarMilestoneRef {
  id: string;
  title: string;
  dueDate: string;
  dueDay: string;
}

export interface PlanbarProjectMember extends PlanbarPerson {
  openTasks: number;
}

export interface PlanbarProjectOverview {
  id: string;
  customerProjectId: string | null;
  title: string;
  status: string;
  statusLabel: string;
  done: boolean;
  archived: boolean;
  /** A PlanbarPriority (open for future values). */
  priority: string;
  priorityLabel: string | null;
  isPinned: boolean;
  /** null for internal projects. */
  customer: PlanbarTeam | null;
  startDate: string | null;
  deadline: string | null;
  deadlineDay: string | null;
  overdue: boolean;
  /** Earliest open schedule entry – may lie in the past (late). */
  nextMilestone: PlanbarMilestoneRef | null;
  /** `percent` is null without tasks. */
  progress: { done: number; total: number; percent: number | null };
  milestones: { done: number; total: number };
  leader: PlanbarPerson | null;
  responsible: PlanbarPerson | null;
  teams: PlanbarTeam[];
  /** Sorted by open tasks, descending. */
  members: PlanbarProjectMember[];
  /** Hours; `percent` = tracked vs planned (else estimated), > 100 = over budget, null without budget. */
  hours: { planned: number | null; estimated: number | null; tracked: number; percent: number | null };
  url: string;
  updatedAt: string;
}

export interface PlanbarProjectPage {
  data: PlanbarProjectOverview[];
  page: number;
  pageSize: number;
  total: number;
}

export type PlanbarProjectState = 'planned' | 'open' | 'in_progress' | 'on_hold' | 'done' | 'closed';

export interface PlanbarProjectQuery {
  /** Only these projects, in this order (max 100). */
  ids?: readonly string[];
  /** 'aktiv' (default) | 'erledigt' | 'archiviert' | 'alle' | a list of raw statuses. */
  status?: 'aktiv' | 'erledigt' | 'archiviert' | 'alle' | readonly PlanbarProjectState[];
  /** Projects these people are involved in (max 50). */
  benutzer?: readonly string[];
  /** Projects led by these people (max 50). */
  leiter?: readonly string[];
  customerId?: string;
  teamId?: string;
  /** Title search. */
  q?: string;
  page?: number;
  /** Max 200, default 50. */
  pageSize?: number;
}

// ── GET /api/v1/news ─────────────────────────────────────────────────────────

export type PlanbarVisibility = 'member' | 'koordinator' | 'projektleiter' | 'org_admin';

export interface PlanbarNewsPost {
  id: string;
  /** First line of the post (cut with «…» beyond 100 characters). */
  title: string;
  /** One line, ≤ 280 characters. */
  teaser: string;
  /** Full text with \n line breaks, ≤ 5000 characters. */
  text: string;
  author: PlanbarPerson | null;
  visibility: PlanbarVisibility;
  visibilityLabel: string;
  mentions: {
    users: PlanbarPerson[];
    teams: PlanbarTeam[];
    projects: { id: string | null; customerProjectId: string; name: string }[];
  };
  commentCount: number;
  lastComment: { author: PlanbarPerson | null; createdAt: string; teaser: string } | null;
  /** The Infowand (no per-post anchor). */
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlanbarNewsList {
  data: PlanbarNewsPost[];
  total: number;
  limit: number;
}

export interface PlanbarNewsQuery {
  /** 1–100, default 20. */
  limit?: number;
  /** `YYYY-MM-DD` (from Zurich midnight) or an ISO timestamp. */
  seit?: string;
  /** Include posts up to this level; default 'member' = visible to everyone. */
  sichtbarkeit?: PlanbarVisibility;
}

// ── GET /api/v1/zeiten/zusammenfassung ───────────────────────────────────────

export interface PlanbarTimer {
  startedAt: string;
  /** At request time – count up locally from `startedAt` between polls. */
  elapsedMinutes: number;
  label: string;
  projectLabel: string | null;
  taskLabel: string | null;
  ticketId: string | null;
  subTaskId: string | null;
  url: string | null;
}

export interface PlanbarTimeEntry {
  user: PlanbarPerson;
  /** Booked minutes; the running timer is not included yet. */
  todayMinutes: number;
  weekMinutes: number;
  /** Monday … Sunday. */
  weekDays: number[];
  timer: PlanbarTimer | null;
}

export interface PlanbarTimeSummary {
  data: PlanbarTimeEntry[];
  today: string;
  /** Monday of this week. */
  weekStart: string;
}

export interface PlanbarTimeQuery {
  /** Without: all members of the organisation (max 200). */
  benutzer?: readonly string[];
}

// ── Several Unternehmen ──────────────────────────────────────────────────────

/** A planbar organisation («Unternehmen») with its own API key in SlateDesk. */
export interface PlanbarOrgRef {
  /** Id in `planbar.unternehmen`. */
  id: string;
  /** Display name (never empty). */
  name: string;
}

/** A planbar answer item with the Unternehmen it came from. */
export type WithOrg<T> = T & { org: PlanbarOrgRef };

/** A person of one or more Unternehmen – planbar user ids are global. */
export interface PlanbarOrgMember extends PlanbarMember {
  /** The Unternehmen the person belongs to, in the order of the request. */
  orgs: PlanbarOrgRef[];
}

/** Booked time of a person summed over the Unternehmen. */
export interface PlanbarOrgTimeEntry extends PlanbarTimeEntry {
  orgs: PlanbarOrgRef[];
}

// ── GET /api/planbar-test (SlateDesk web server) ─────────────────────────────

export interface PlanbarScopes {
  /** `aufgaben:read` – Arbeitsliste and booked time. */
  aufgaben: boolean;
  /** `aufgaben:write` – ticking off tasks. */
  aufgabenSchreiben: boolean;
  /** `projekte:read` */
  projekte: boolean;
  /** `news:read` */
  news: boolean;
}

export interface PlanbarTestResult {
  ok: boolean;
  /** HTTP status of planbar, 0 when it was not reached. */
  status: number;
  message: string;
  /** planbar has the SlateDesk endpoints (false → «planbar-Update nötig»). */
  dashboard: boolean;
  /** People in the organisation; null when /mitglieder is not readable with this key. */
  members: number | null;
  /** null when planbar lacks the endpoints or was not reached. */
  scopes: PlanbarScopes | null;
}

/** Test of one Unternehmen. */
export interface PlanbarOrgTestResult extends PlanbarTestResult {
  /** Id in `planbar.unternehmen`. */
  org: string;
  /** As entered (may be empty). */
  name: string;
}

/** `GET /api/planbar-test[?org=<id>]`: one Unternehmen, or every one with a key. */
export interface PlanbarTestReport {
  results: PlanbarOrgTestResult[];
}
