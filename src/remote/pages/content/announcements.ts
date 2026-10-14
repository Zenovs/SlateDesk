/**
 * Pinnwand (state.data.announcements) for the web UI: status relative to
 * now, the kiosk's order, texts for the time window and the editor draft.
 * Same rules as the Pinnwand widget: `from`/`until` are epoch ms, `until`
 * is exclusive, pinned entries come first.
 */
import { CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { NewAnnouncement } from '../../../state/dataActions';
import type { Announcement, AnnouncementLevel } from '../../../state/types';
import { formatDay, formatDayTime, startOfDay } from '../../format';

export type AnnouncementStatus = 'aktiv' | 'geplant' | 'abgelaufen';

export const LEVELS: Record<AnnouncementLevel, { label: string; icon: LucideIcon }> = {
  info: { label: 'Info', icon: Info },
  wichtig: { label: 'Wichtig', icon: TriangleAlert },
  erfolg: { label: 'Erfolg', icon: CircleCheck },
};

export const LEVEL_ORDER: readonly AnnouncementLevel[] = ['info', 'wichtig', 'erfolg'];

export const TITLE_MAX = 120;
export const TEXT_MAX = 1000;
export const AUTHOR_MAX = 60;

function announcementStatus(item: Announcement, now: number): AnnouncementStatus {
  if (item.until !== undefined && item.until <= now) return 'abgelaufen';
  if (item.from !== undefined && item.from > now) return 'geplant';
  return 'aktiv';
}

/** A scheduled entry counts as new from the moment it appears (kiosk order). */
const publishedAt = (item: Announcement): number => item.from ?? item.createdAt;

export type AnnouncementGroups = Record<AnnouncementStatus, Announcement[]>;

/** Active ones in the kiosk's order, scheduled by start, expired newest first. */
export function groupAnnouncements(all: Record<string, Announcement>, now: number): AnnouncementGroups {
  const groups: AnnouncementGroups = { aktiv: [], geplant: [], abgelaufen: [] };
  for (const item of Object.values(all)) groups[announcementStatus(item, now)].push(item);
  groups.aktiv.sort(
    (a, b) =>
      Number(b.pinned === true) - Number(a.pinned === true) ||
      publishedAt(b) - publishedAt(a) ||
      b.createdAt - a.createdAt ||
      a.id.localeCompare(b.id),
  );
  groups.geplant.sort((a, b) => (a.from ?? 0) - (b.from ?? 0) || a.id.localeCompare(b.id));
  groups.abgelaufen.sort((a, b) => (b.until ?? 0) - (a.until ?? 0) || a.id.localeCompare(b.id));
  return groups;
}

/** `until` at midnight means «through the previous day», as on the kiosk. */
function untilText(until: number, now: number): string {
  return startOfDay(until) === until ? `bis ${formatDay(until - 1, now)}` : `bis ${formatDayTime(until, now)}`;
}

/** «seit heute 08:00 · bis Fr 17.10.», «ab morgen 07:00 · ohne Ende», «abgelaufen gestern 18:00». */
export function windowText(item: Announcement, status: AnnouncementStatus, now: number): string {
  if (status === 'abgelaufen' && item.until !== undefined) return `abgelaufen ${formatDayTime(item.until, now)}`;
  const until = item.until !== undefined ? untilText(item.until, now) : 'ohne Ende';
  if (status === 'geplant' && item.from !== undefined) return `ab ${formatDayTime(item.from, now)} · ${until}`;
  const since = publishedAt(item);
  // createdAt 0 = imported without timestamp – no date is better than 1970.
  return since > 0 ? `seit ${formatDayTime(since, now)} · ${until}` : until;
}

// ── Editor draft ─────────────────────────────────────────────────────────────

export type FromMode = 'sofort' | 'zeitpunkt';
export type UntilMode = 'ohne' | 'zeitpunkt';

export interface AnnouncementDraft {
  title: string;
  text: string;
  level: AnnouncementLevel;
  author: string;
  pinned: boolean;
  fromMode: FromMode;
  /** <input type="datetime-local"> value; kept while «sofort» so switching back restores it. */
  from: string;
  untilMode: UntilMode;
  until: string;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** Epoch ms → value of <input type="datetime-local"> (local time, minutes). */
function toLocalInput(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** <input type="datetime-local"> value → epoch ms (local time); null while incomplete. */
export function fromLocalInput(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return null;
  const [year, month, day, hours, minutes] = match.slice(1).map(Number);
  const ms = new Date(year, month - 1, day, hours, minutes).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function nextFullHour(now: number): number {
  const date = new Date(now);
  date.setHours(date.getHours() + 1, 0, 0, 0);
  return date.getTime();
}

/** Midnight after the day of `ms` – the kiosk shows it as «bis <Tag>». */
function endOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

/** Empty form: visible at once, without end; the time fields hold sensible defaults for when they are switched on. */
export function newDraft(now: number): AnnouncementDraft {
  const from = nextFullHour(now);
  return {
    title: '',
    text: '',
    level: 'info',
    author: '',
    pinned: false,
    fromMode: 'sofort',
    from: toLocalInput(from),
    untilMode: 'ohne',
    until: toLocalInput(endOfDay(now)),
  };
}

/**
 * «Bis» value when the end is switched on: the entered one while it still
 * lies after the start, otherwise the end of the start day.
 */
export function untilDefault(draft: AnnouncementDraft, now: number): string {
  const start = (draft.fromMode === 'zeitpunkt' ? fromLocalInput(draft.from) : null) ?? now;
  const until = fromLocalInput(draft.until);
  return until !== null && until > start ? draft.until : toLocalInput(endOfDay(start));
}

export function draftOf(item: Announcement, now: number): AnnouncementDraft {
  const fallback = newDraft(now);
  return {
    title: item.title,
    text: item.text ?? '',
    level: item.level,
    author: item.author ?? '',
    pinned: item.pinned === true,
    fromMode: item.from !== undefined ? 'zeitpunkt' : 'sofort',
    from: item.from !== undefined ? toLocalInput(item.from) : fallback.from,
    untilMode: item.until !== undefined ? 'zeitpunkt' : 'ohne',
    until: item.until !== undefined ? toLocalInput(item.until) : toLocalInput(endOfDay(item.from ?? now)),
  };
}

/** Values to store; `undefined` removes an optional field when editing. */
export interface AnnouncementValues {
  title: string;
  text: string | undefined;
  level: AnnouncementLevel;
  author: string | undefined;
  pinned: boolean | undefined;
  from: number | undefined;
  until: number | undefined;
}

export type AnnouncementField = keyof AnnouncementValues;

/** Stored fields that edits of these form fields change (both time fields belong to `from`/`until`). */
export function editedFields(edited: Partial<AnnouncementDraft>): AnnouncementField[] {
  const fields = new Set<AnnouncementField>();
  for (const key of Object.keys(edited) as (keyof AnnouncementDraft)[]) {
    fields.add(key === 'fromMode' ? 'from' : key === 'untilMode' ? 'until' : key);
  }
  return [...fields];
}

/**
 * Patch for announcementActions.update with only the edited fields – a field
 * changed elsewhere while the editor was open (e.g. pinned on another phone)
 * is not written back. `undefined` values remove the field.
 */
export function pickValues(values: AnnouncementValues, fields: readonly AnnouncementField[]): Partial<AnnouncementValues> {
  return Object.fromEntries(fields.map((field) => [field, values[field]]));
}

export type DraftErrors = Partial<Record<'title' | 'from' | 'until', string>>;

export interface DraftCheck {
  errors: DraftErrors;
  /** null while there are errors. */
  values: AnnouncementValues | null;
  /** The end lies in the past – saved, but never shown. */
  expired: boolean;
}

export function checkDraft(draft: AnnouncementDraft, now: number): DraftCheck {
  const errors: DraftErrors = {};
  const title = draft.title.trim();
  if (!title) errors.title = 'Bitte einen Titel eingeben';
  const from = draft.fromMode === 'zeitpunkt' ? fromLocalInput(draft.from) : undefined;
  if (from === null) errors.from = 'Bitte Datum und Uhrzeit angeben';
  const until = draft.untilMode === 'zeitpunkt' ? fromLocalInput(draft.until) : undefined;
  if (until === null) errors.until = 'Bitte Datum und Uhrzeit angeben';
  else if (until !== undefined && typeof from === 'number' && until <= from) {
    errors.until = 'Das Ende muss nach dem Beginn liegen';
  }
  if (Object.keys(errors).length > 0 || from === null || until === null) return { errors, values: null, expired: false };

  const text = draft.text.trim();
  const author = draft.author.trim();
  return {
    errors,
    values: {
      title,
      text: text || undefined,
      level: draft.level,
      author: author || undefined,
      pinned: draft.pinned || undefined,
      from,
      until,
    },
    expired: until !== undefined && until <= now,
  };
}

/**
 * Copy of an entry for «Duplizieren». An expired entry is reposted: the
 * copy appears at once and has no end (otherwise it would be expired too).
 */
export function duplicateOf(item: Announcement, now: number): { values: NewAnnouncement; reposted: boolean } {
  const reposted = announcementStatus(item, now) === 'abgelaufen';
  return {
    values: {
      title: item.title,
      text: item.text,
      level: item.level,
      author: item.author,
      pinned: item.pinned,
      from: reposted ? undefined : item.from,
      until: reposted ? undefined : item.until,
    },
    reposted,
  };
}
