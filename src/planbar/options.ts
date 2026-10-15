/**
 * Option providers for planbar settings fields (Unternehmen, people and
 * projects pickers). Manifests that use them import the provider names from
 * here, which also registers the loaders – so kiosk dialog and web UI both
 * get them. People and projects depend on the widget's Unternehmen selection
 * (`optionsDependsOn: ['unternehmen']`; empty = all set up).
 */
import { normalizeSelection } from '../components/settings/multiselect';
import {
  invalidateOptionProvider,
  type ProviderDeps,
  type ProviderOption,
  type ProviderResult,
  registerOptionProvider,
} from '../components/settings/optionProviders';
import { useAppState } from '../state/appState';
import type { AppStateData } from '../state/types';
import type { SettingsField } from '../types/settings';
import { fetchProjektuebersicht, PlanbarError, type PlanbarErrorKind, planbarErrorShort, planbarMemberName } from './client';
import {
  configuredOrgs,
  eachOrg,
  fetchMitgliederAll,
  type PlanbarOrgEntry,
  type PlanbarOrgFailure,
  planbarOrgEntries,
  resolveOrgs,
} from './orgs';
import type { PlanbarMember, PlanbarOrgRef, PlanbarProjectOverview, WithOrg } from './types';

/** Unternehmen of the settings (no network): value = id in `planbar.unternehmen`. */
export const PLANBAR_ORGS_PROVIDER = 'planbar.unternehmen';
/** People of the selected Unternehmen: value = user id, hint = Unternehmen (several) and teams. */
export const PLANBAR_MEMBERS_PROVIDER = 'planbar.mitglieder';
/**
 * Active projects (not done, closed or archived) of the selected Unternehmen,
 * grouped by customer: value = ticket id. Projects already picked in a
 * widget's settings stay listed after they were finished.
 */
export const PLANBAR_PROJECTS_PROVIDER = 'planbar.projekte';
/** Settings key of the Unternehmen selection in every planbar widget. */
export const PLANBAR_ORG_SETTING = 'unternehmen';
/** For pickers that list what the selected Unternehmen have. */
export const DEPENDS_ON_ORGS: string[] = [PLANBAR_ORG_SETTING];

/** First setting of every planbar widget: which Unternehmen it shows (empty = all set up). */
export const planbarOrgField = (): SettingsField => ({
  type: 'multiselect',
  key: PLANBAR_ORG_SETTING,
  label: 'Unternehmen',
  description:
    'Leer = alle eingerichteten Unternehmen. Neue Unternehmen kommen in der Fernsteuerung unter «planbar» dazu.',
  optionsProvider: PLANBAR_ORGS_PROVIDER,
  placeholder: 'Unternehmen suchen',
});

/** Group of projects without customer. */
export const INTERNAL_PROJECTS_GROUP = 'Interne Projekte';
/** Group of picked projects that are done, closed or archived by now. */
export const INACTIVE_PROJECTS_GROUP = 'Nicht mehr aktiv';

/**
 * Settings that store ids from PLANBAR_PROJECTS_PROVIDER: widget id → settings key.
 * Kept here instead of read from the manifests – they import this module.
 */
export const PLANBAR_PROJECT_SETTINGS: ReadonlyMap<string, string> = new Map([
  ['planbar-aufgaben', 'projekte'],
  ['planbar-projekte', 'projekte'],
]);

const PROJECT_PAGE_SIZE = 200;
/** Safety stop – an organisation with more than 1000 active projects is not expected. */
const MAX_PROJECT_PAGES = 5;
/** planbar accepts at most this many ids per request. */
const MAX_IDS = 100;

const byLabel = (a: ProviderOption, b: ProviderOption): number => a.label.localeCompare(b.label, 'de-CH');

/** Unternehmen to choose from: all of the settings, the ones without key with a hint. */
export function orgOptions(entries: readonly PlanbarOrgEntry[]): ProviderOption[] {
  return entries.map((entry) => {
    const option: ProviderOption = { value: entry.id, label: entry.name };
    if (!entry.hasKey) option.hint = 'API-Schlüssel fehlt';
    return option;
  });
}

type MaybeOrgMember = PlanbarMember & { orgs?: readonly PlanbarOrgRef[] };

/** People by name; `showOrgs`: their Unternehmen lead the hint (several Unternehmen asked). */
export function memberOptions(members: readonly MaybeOrgMember[], showOrgs = false): ProviderOption[] {
  return members
    .map((member) => {
      // planbar ohne SlateDesk-Erweiterung liefert keine Teams.
      const teams = (member.teams ?? []).map((team) => team.name).filter(Boolean);
      const orgs = showOrgs ? (member.orgs ?? []).map((org) => org.name) : [];
      const hint = [orgs.join(', '), teams.join(', ')].filter(Boolean).join(' · ');
      const option: ProviderOption = { value: member.id, label: planbarMemberName(member) };
      if (hint) option.hint = hint;
      return option;
    })
    .sort(byLabel);
}

type MaybeOrgProject = PlanbarProjectOverview & { org?: PlanbarOrgRef };

const GROUP_RANK = { customer: 0, internal: 1, inactive: 2 } as const;

interface ProjectEntry {
  option: ProviderOption;
  org: string;
  rank: number;
  /** Group without the Unternehmen. */
  base: string;
}

function projectEntry(project: MaybeOrgProject, inactive: boolean, showOrgs: boolean): ProjectEntry {
  const customer = project.customer?.name.trim() ?? '';
  const base = inactive ? INACTIVE_PROJECTS_GROUP : customer || INTERNAL_PROJECTS_GROUP;
  const org = showOrgs ? (project.org?.name ?? '') : '';
  const option: ProviderOption = { value: project.id, label: project.title, group: org ? `${org} · ${base}` : base };
  // Finished projects share one group – the hint keeps their customer.
  const hint = inactive
    ? [customer, project.archived ? 'Archiviert' : project.statusLabel].filter(Boolean).join(' · ')
    : project.statusLabel;
  if (hint) option.hint = hint;
  const rank = inactive ? GROUP_RANK.inactive : customer ? GROUP_RANK.customer : GROUP_RANK.internal;
  return { option, org, rank, base };
}

/**
 * Customers alphabetically, then internal projects; projects by title within
 * a group. `picked` are projects the settings already use but planbar no
 * longer lists as active – done, closed or archived ones come last, under
 * «Nicht mehr aktiv», so their chips keep a name. `showOrgs` (several
 * Unternehmen asked): groups read «<Unternehmen> · <Kunde>», by Unternehmen.
 */
export function projectOptions(
  projects: readonly MaybeOrgProject[],
  picked: readonly MaybeOrgProject[] = [],
  showOrgs = false,
): ProviderOption[] {
  const entries = [
    ...projects.map((project) => projectEntry(project, false, showOrgs)),
    ...picked.map((project) => projectEntry(project, project.done || project.archived, showOrgs)),
  ];
  return entries
    .sort(
      (a, b) =>
        a.org.localeCompare(b.org, 'de-CH') ||
        a.rank - b.rank ||
        a.base.localeCompare(b.base, 'de-CH') ||
        byLabel(a.option, b.option),
    )
    .map((entry) => entry.option);
}

/** Project ids stored in the planbar widgets on the dashboard, each once. */
export function storedProjectIds(state: AppStateData): string[] {
  const ids = new Set<string>();
  for (const widget of state.layout.widgets) {
    const key = PLANBAR_PROJECT_SETTINGS.get(widget.widgetId);
    const value = key === undefined ? undefined : state.widgetSettings[widget.instanceId]?.[key];
    if (!Array.isArray(value)) continue;
    for (const id of value) {
      if (typeof id === 'string' && id.trim() !== '') ids.add(id);
    }
  }
  return [...ids];
}

async function loadActiveProjects(org: PlanbarOrgRef): Promise<WithOrg<PlanbarProjectOverview>[]> {
  const projects: WithOrg<PlanbarProjectOverview>[] = [];
  for (let page = 1; page <= MAX_PROJECT_PAGES; page += 1) {
    const result = await fetchProjektuebersicht({ status: 'aktiv', page, pageSize: PROJECT_PAGE_SIZE }, { org: org.id });
    projects.push(...result.data.map((project) => ({ ...project, org })));
    if (result.data.length < PROJECT_PAGE_SIZE || projects.length >= result.total) break;
  }
  return projects;
}

/**
 * Stored ids the active list lacks, looked up whatever their status (each
 * Unternehmen returns its own). A failed lookup only costs the names (the
 * chips say «Unbekannt») – the picker itself needs the active list alone.
 */
async function loadPickedProjects(ids: readonly string[], org: PlanbarOrgRef): Promise<WithOrg<PlanbarProjectOverview>[]> {
  const projects: WithOrg<PlanbarProjectOverview>[] = [];
  for (let start = 0; start < ids.length; start += MAX_IDS) {
    const chunk = ids.slice(start, start + MAX_IDS);
    try {
      const result = await fetchProjektuebersicht({ ids: chunk, status: 'alle', pageSize: chunk.length }, { org: org.id });
      projects.push(...result.data.map((project) => ({ ...project, org })));
    } catch {
      break;
    }
  }
  return projects;
}

/** The Unternehmen a picker lists: the widget's selection, empty = all set up. */
function orgsFor(deps: ProviderDeps): PlanbarOrgRef[] {
  const configured = configuredOrgs();
  if (configured.length === 0) throw new PlanbarError(0, 'planbar ist nicht eingerichtet', 'notConfigured');
  const orgs = resolveOrgs(normalizeSelection(deps[PLANBAR_ORG_SETTING]), configured);
  if (orgs.length === 0) {
    const message = 'Die gewählten Unternehmen sind nicht eingerichtet – oben ein anderes wählen';
    throw new PlanbarError(0, message, 'invalidRequest');
  }
  return orgs;
}

/** «Unvollständig – wireon: planbar-Update nötig» for Unternehmen that did not answer. */
export function failureNote(failures: readonly PlanbarOrgFailure[]): string | null {
  if (failures.length === 0) return null;
  return `Unvollständig – ${failures.map((f) => `${f.org.name}: ${planbarErrorShort(f.error)}`).join(' · ')}`;
}

async function loadMemberOptions(deps: ProviderDeps): Promise<ProviderResult> {
  const result = await fetchMitgliederAll(orgsFor(deps));
  return { options: memberOptions(result.data, result.orgs.length > 1), warning: failureNote(result.failures) };
}

async function loadProjectOptions(deps: ProviderDeps): Promise<ProviderResult> {
  const orgs = orgsFor(deps);
  const { results, failures } = await eachOrg(orgs, loadActiveProjects);
  const active = results.flatMap(({ value }) => value);
  const known = new Set(active.map((project) => project.id));
  const missing = storedProjectIds(useAppState.getState().state).filter((id) => !known.has(id));
  const picked =
    missing.length > 0 ? (await Promise.all(results.map(({ org }) => loadPickedProjects(missing, org)))).flat() : [];
  // Each Unternehmen was asked for all missing ids – keep every project once.
  const seen = new Set(known);
  const extra = picked.filter((project) => {
    if (seen.has(project.id)) return false;
    seen.add(project.id);
    return true;
  });
  return { options: projectOptions(active, extra, orgs.length > 1), warning: failureNote(failures) };
}

const SETUP_HINTS: Partial<Record<PlanbarErrorKind, string>> = {
  disabled: 'planbar ist ausgeschaltet – in der Fernsteuerung unter «planbar» einschalten',
  notConfigured: 'planbar ist nicht eingerichtet – in der Fernsteuerung unter «planbar» einrichten',
};

/**
 * The picker shows the load error; the kiosk's settings dialog has no setup
 * notice, so it says where to fix it – and, with several Unternehmen, which
 * one failed.
 */
async function withSetupHint<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof PlanbarError) {
      const hint = SETUP_HINTS[err.kind];
      const prefix = err.org && configuredOrgs().length > 1 ? `${err.org.name}: ` : '';
      if (hint) throw new PlanbarError(err.status, `${prefix}${hint}`, err.kind, err.org);
      if (prefix) throw new PlanbarError(err.status, `${prefix}${err.message}`, err.kind, err.org);
    }
    throw err;
  }
}

async function loadOrgOptions(): Promise<ProviderResult> {
  const options = orgOptions(planbarOrgEntries());
  const none = 'Noch kein Unternehmen eingerichtet – in der Fernsteuerung unter «planbar» hinzufügen';
  return { options, warning: options.length === 0 ? none : null };
}

registerOptionProvider(PLANBAR_ORGS_PROVIDER, loadOrgOptions);
registerOptionProvider(PLANBAR_MEMBERS_PROVIDER, (deps) => withSetupHint(() => loadMemberOptions(deps)));
registerOptionProvider(PLANBAR_PROJECTS_PROVIDER, (deps) => withSetupHint(() => loadProjectOptions(deps)));

// Unternehmen added, renamed, keys or address changed (here or on another device): the pickers
// of open forms load again.
useAppState.subscribe((current, previous) => {
  if (current.state.planbar === previous.state.planbar) return;
  for (const name of [PLANBAR_ORGS_PROVIDER, PLANBAR_MEMBERS_PROVIDER, PLANBAR_PROJECTS_PROVIDER]) {
    invalidateOptionProvider(name);
  }
});
