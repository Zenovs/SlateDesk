/**
 * Several planbar Unternehmen at once. A planbar API key belongs to exactly
 * one organisation, so SlateDesk keeps one key per Unternehmen
 * (`state.planbar.unternehmen`) and asks each selected one separately. planbar
 * user ids are global – a person picked once is found in every Unternehmen
 * they belong to (others simply return nothing for them).
 *
 * The fan-out helpers ask all Unternehmen concurrently and merge the answers,
 * every item tagged with its Unternehmen. One failing Unternehmen never hides
 * the others: its error is returned next to the data. Only when all fail does
 * the call reject (with the first error, marked with its Unternehmen).
 */
import { useAppState } from '../state/appState';
import type { PlanbarConfig } from '../state/types';
import { isAbortError } from '../state/transport';
import {
  fetchArbeitsliste,
  fetchMitglieder,
  fetchNews,
  fetchProjektuebersicht,
  fetchZeitZusammenfassung,
  PlanbarError,
  type PlanbarRequestOptions,
} from './client';
import { compareWorkItems, laterDay } from './order';
import type {
  PlanbarNewsPost,
  PlanbarNewsQuery,
  PlanbarOrgMember,
  PlanbarOrgRef,
  PlanbarOrgTimeEntry,
  PlanbarProjectOverview,
  PlanbarProjectQuery,
  PlanbarTeam,
  PlanbarTimeQuery,
  PlanbarWorkItem,
  PlanbarWorkListQuery,
  WithOrg,
} from './types';

/** Name shown for an Unternehmen without one. */
export const UNNAMED_ORG = 'Unternehmen ohne Namen';

export const orgDisplayName = (name: string | undefined): string => name?.trim() || UNNAMED_ORG;

/** What is entered for a key: a real one (kiosk) or «__gesetzt__» (web UI). */
const keySet = (key: unknown): boolean => typeof key === 'string' && key.trim() !== '';

export interface PlanbarOrgEntry extends PlanbarOrgRef {
  /** An API key is stored – only such Unternehmen can be asked. */
  hasKey: boolean;
}

const byName = (a: PlanbarOrgRef, b: PlanbarOrgRef): number =>
  a.name.localeCompare(b.name, 'de-CH', { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** Every Unternehmen of the settings, by name. */
export function planbarOrgEntries(planbar: PlanbarConfig = useAppState.getState().state.planbar): PlanbarOrgEntry[] {
  return Object.entries(planbar.unternehmen)
    .map(([id, entry]) => ({ id, name: orgDisplayName(entry.name), hasKey: keySet(entry.apiKey) }))
    .sort(byName);
}

/** The Unternehmen with an API key («eingerichtet»), by name. */
export function configuredOrgs(planbar: PlanbarConfig = useAppState.getState().state.planbar): PlanbarOrgRef[] {
  return planbarOrgEntries(planbar)
    .filter((entry) => entry.hasKey)
    .map(({ id, name }) => ({ id, name }));
}

/**
 * The Unternehmen a widget asks: the selected ones that are set up, or –
 * with nothing selected – all that are. Selected ids that are gone (or lost
 * their key) are left out; when none is left the result is empty.
 */
export function resolveOrgs(selection: readonly string[], configured: readonly PlanbarOrgRef[]): PlanbarOrgRef[] {
  if (selection.length === 0) return [...configured];
  const wanted = new Set(selection);
  return configured.filter((org) => wanted.has(org.id));
}

/** Stable text for hook dependencies (JSON) – changes when Unternehmen are added, renamed or removed. */
export const orgsKey = (orgs: readonly PlanbarOrgRef[]): string => JSON.stringify(orgs.map(({ id, name }) => ({ id, name })));

// ── Fan-out ──────────────────────────────────────────────────────────────────

export interface PlanbarOrgFailure {
  org: PlanbarOrgRef;
  /** Marked with `org`. */
  error: PlanbarError;
}

export interface PlanbarFanOut<T> {
  data: T;
  /** The Unternehmen that were asked, in order. */
  orgs: PlanbarOrgRef[];
  /** Unternehmen whose answer is missing in `data`. */
  failures: PlanbarOrgFailure[];
}

export type PlanbarMultiOptions = Omit<PlanbarRequestOptions, 'org'>;

function asPlanbarError(err: unknown, org: PlanbarOrgRef): PlanbarError {
  if (err instanceof PlanbarError) return err.forOrg(org);
  const message = err instanceof Error && err.message.trim() ? err.message : 'Unbekannter Fehler';
  return new PlanbarError(0, message, 'http', org);
}

/**
 * Runs `load` for every Unternehmen at once. Rejects when nothing is to be
 * asked (not set up), when cancelled, or when every Unternehmen failed.
 */
export async function eachOrg<T>(
  orgs: readonly PlanbarOrgRef[],
  load: (org: PlanbarOrgRef) => Promise<T>,
  signal?: AbortSignal,
): Promise<{ results: { org: PlanbarOrgRef; value: T }[]; failures: PlanbarOrgFailure[] }> {
  if (orgs.length === 0) throw new PlanbarError(0, 'planbar ist nicht eingerichtet', 'notConfigured');
  const settled = await Promise.allSettled(orgs.map((org) => load(org)));
  const results: { org: PlanbarOrgRef; value: T }[] = [];
  const failures: PlanbarOrgFailure[] = [];
  settled.forEach((outcome, index) => {
    const org = orgs[index];
    if (outcome.status === 'fulfilled') results.push({ org, value: outcome.value });
    else if (isAbortError(outcome.reason) || signal?.aborted) throw outcome.reason;
    else failures.push({ org, error: asPlanbarError(outcome.reason, org) });
  });
  if (results.length === 0) throw failures[0].error;
  return { results, failures };
}

const tag = <T extends object>(items: readonly T[], org: PlanbarOrgRef): WithOrg<T>[] =>
  items.map((item) => ({ ...item, org }));

/** First occurrence of every id (the same Unternehmen entered twice must not list items twice). */
function uniqueById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

const sum = (values: readonly number[]): number =>
  values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

// Members

function mergeTeams(a: readonly PlanbarTeam[], b: readonly PlanbarTeam[]): PlanbarTeam[] {
  const known = new Set(a.map((team) => team.id));
  return [...a, ...b.filter((team) => !known.has(team.id))];
}

/** The people of all Unternehmen, each once, with the Unternehmen they belong to. */
export async function fetchMitgliederAll(
  orgs: readonly PlanbarOrgRef[],
  options: PlanbarMultiOptions = {},
): Promise<PlanbarFanOut<PlanbarOrgMember[]>> {
  const { results, failures } = await eachOrg(
    orgs,
    async (org) => (await fetchMitglieder({ ...options, org: org.id })).data,
    options.signal,
  );
  const byId = new Map<string, PlanbarOrgMember>();
  for (const { org, value } of results) {
    for (const member of value) {
      const known = byId.get(member.id);
      if (!known) {
        byId.set(member.id, { ...member, orgs: [org] });
        continue;
      }
      byId.set(member.id, {
        ...known,
        name: known.name.trim() ? known.name : member.name,
        email: known.email || member.email,
        teams: mergeTeams(known.teams, member.teams),
        orgs: known.orgs.some((o) => o.id === org.id) ? known.orgs : [...known.orgs, org],
      });
    }
  }
  return { data: [...byId.values()], orgs: [...orgs], failures };
}

// Arbeitsliste

export interface PlanbarOrgWorkList {
  /** planbar's order over all Unternehmen, at most `limit` items. */
  data: WithOrg<PlanbarWorkItem>[];
  /** Matching items of all Unternehmen before `limit`. */
  total: number;
  limit: number;
  /** The latest `today` of the answers (planbar's Zurich day). */
  today: string;
}

const DEFAULT_WORK_LIMIT = 50;

/** The Arbeitsliste of the given people in every Unternehmen, merged in planbar's order. */
export async function fetchArbeitslisteAll(
  orgs: readonly PlanbarOrgRef[],
  query: PlanbarWorkListQuery,
  options: PlanbarMultiOptions = {},
): Promise<PlanbarFanOut<PlanbarOrgWorkList>> {
  const { results, failures } = await eachOrg(
    orgs,
    (org) => fetchArbeitsliste(query, { ...options, org: org.id }),
    options.signal,
  );
  const limit = query.limit ?? DEFAULT_WORK_LIMIT;
  const items = uniqueById(results.flatMap(({ org, value }) => tag(value.data, org))).sort(compareWorkItems);
  const today = results.map(({ value }) => value.today).reduce(laterDay);
  return {
    data: { data: items.slice(0, limit), total: sum(results.map(({ value }) => value.total)), limit, today },
    orgs: [...orgs],
    failures,
  };
}

// Projektübersicht

export interface PlanbarOrgProjects {
  /**
   * With `ids` in the order of `ids`; otherwise each Unternehmen's answer in
   * planbar's order, one after the other – sort for display.
   */
  data: WithOrg<PlanbarProjectOverview>[];
  total: number;
}

/** Projects of every Unternehmen (same query each). */
export async function fetchProjektuebersichtAll(
  orgs: readonly PlanbarOrgRef[],
  query: PlanbarProjectQuery = {},
  options: PlanbarMultiOptions = {},
): Promise<PlanbarFanOut<PlanbarOrgProjects>> {
  const { results, failures } = await eachOrg(
    orgs,
    (org) => fetchProjektuebersicht(query, { ...options, org: org.id }),
    options.signal,
  );
  const projects = uniqueById(results.flatMap(({ org, value }) => tag(value.data, org)));
  const { ids } = query;
  if (ids && ids.length > 0) {
    // Hand-picked projects of several Unternehmen keep the picked order (the sort is stable).
    const position = new Map(ids.map((id, index) => [id, index]));
    const rank = (project: PlanbarProjectOverview): number =>
      Math.min(position.get(project.id) ?? ids.length, position.get(project.customerProjectId ?? '') ?? ids.length);
    projects.sort((a, b) => rank(a) - rank(b));
  }
  return {
    data: { data: projects, total: sum(results.map(({ value }) => value.total)) },
    orgs: [...orgs],
    failures,
  };
}

// News

export interface PlanbarOrgNews {
  /** Newest first over all Unternehmen, at most `limit` posts. */
  data: WithOrg<PlanbarNewsPost>[];
  total: number;
}

const DEFAULT_NEWS_LIMIT = 20;

const createdAt = (post: PlanbarNewsPost): number => Date.parse(post.createdAt) || 0;

/** The Infowand posts of every Unternehmen, newest first. */
export async function fetchNewsAll(
  orgs: readonly PlanbarOrgRef[],
  query: PlanbarNewsQuery = {},
  options: PlanbarMultiOptions = {},
): Promise<PlanbarFanOut<PlanbarOrgNews>> {
  const { results, failures } = await eachOrg(orgs, (org) => fetchNews(query, { ...options, org: org.id }), options.signal);
  const posts = uniqueById(results.flatMap(({ org, value }) => tag(value.data, org))).sort(
    (a, b) => createdAt(b) - createdAt(a),
  );
  return {
    data: { data: posts.slice(0, query.limit ?? DEFAULT_NEWS_LIMIT), total: sum(results.map(({ value }) => value.total)) },
    orgs: [...orgs],
    failures,
  };
}

// Zeiten

export interface PlanbarOrgTimeSummary {
  /** One entry per person: minutes summed over the Unternehmen. */
  data: PlanbarOrgTimeEntry[];
  today: string;
  weekStart: string;
}

const addWeekDays = (a: readonly number[], b: readonly number[]): number[] =>
  Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));

/**
 * Booked time per person in every Unternehmen. planbar counts only the time
 * booked in the asking Unternehmen – a person working for several gets the
 * sum; a running timer is the one of the first Unternehmen that has one.
 */
export async function fetchZeitZusammenfassungAll(
  orgs: readonly PlanbarOrgRef[],
  query: PlanbarTimeQuery = {},
  options: PlanbarMultiOptions = {},
): Promise<PlanbarFanOut<PlanbarOrgTimeSummary>> {
  const { results, failures } = await eachOrg(
    orgs,
    (org) => fetchZeitZusammenfassung(query, { ...options, org: org.id }),
    options.signal,
  );
  const byUser = new Map<string, PlanbarOrgTimeEntry>();
  for (const { org, value } of results) {
    for (const entry of value.data) {
      const known = byUser.get(entry.user.id);
      if (!known) {
        byUser.set(entry.user.id, { ...entry, weekDays: [...entry.weekDays], orgs: [org] });
        continue;
      }
      byUser.set(entry.user.id, {
        ...known,
        user: known.user.name.trim() ? known.user : entry.user,
        todayMinutes: known.todayMinutes + entry.todayMinutes,
        weekMinutes: known.weekMinutes + entry.weekMinutes,
        weekDays: addWeekDays(known.weekDays, entry.weekDays),
        timer: known.timer ?? entry.timer,
        orgs: [...known.orgs, org],
      });
    }
  }
  const days = results.map(({ value }) => value);
  return {
    data: {
      data: [...byUser.values()],
      today: days.map((day) => day.today).reduce(laterDay),
      weekStart: days.map((day) => day.weekStart).reduce(laterDay),
    },
    orgs: [...orgs],
    failures,
  };
}
