/**
 * Option providers for planbar settings fields (people and projects pickers).
 * Manifests that use them import the provider names from here, which also
 * registers the loaders – so kiosk dialog and web UI both get them.
 */
import { registerOptionProvider, type ProviderOption } from '../components/settings/optionProviders';
import { useAppState } from '../state/appState';
import type { AppStateData } from '../state/types';
import { fetchMitglieder, fetchProjektuebersicht, PlanbarError, type PlanbarErrorKind, planbarMemberName } from './client';
import type { PlanbarMember, PlanbarProjectOverview } from './types';

/** People of the organisation: value = user id, hint = teams. */
export const PLANBAR_MEMBERS_PROVIDER = 'planbar.mitglieder';
/**
 * Active projects (not done, closed or archived), grouped by customer: value = ticket id.
 * Projects already picked in a widget's settings stay listed after they were finished.
 */
export const PLANBAR_PROJECTS_PROVIDER = 'planbar.projekte';

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

export function memberOptions(members: readonly PlanbarMember[]): ProviderOption[] {
  return members
    .map((member) => {
      // planbar ohne SlateDesk-Erweiterung liefert keine Teams.
      const teams = (member.teams ?? []).map((team) => team.name).filter(Boolean);
      const option: ProviderOption = { value: member.id, label: planbarMemberName(member) };
      if (teams.length > 0) option.hint = teams.join(', ');
      return option;
    })
    .sort(byLabel);
}

const customerGroup = (project: PlanbarProjectOverview): string =>
  project.customer?.name.trim() || INTERNAL_PROJECTS_GROUP;

function activeOption(project: PlanbarProjectOverview): ProviderOption {
  const option: ProviderOption = { value: project.id, label: project.title, group: customerGroup(project) };
  if (project.statusLabel) option.hint = project.statusLabel;
  return option;
}

/** Finished projects share one group – the hint keeps their customer. */
function inactiveOption(project: PlanbarProjectOverview): ProviderOption {
  const customer = project.customer?.name.trim();
  const state = project.archived ? 'Archiviert' : project.statusLabel;
  const option: ProviderOption = { value: project.id, label: project.title, group: INACTIVE_PROJECTS_GROUP };
  const hint = [customer, state].filter(Boolean).join(' · ');
  if (hint) option.hint = hint;
  return option;
}

const GROUP_RANK: Readonly<Record<string, number>> = { [INTERNAL_PROJECTS_GROUP]: 1, [INACTIVE_PROJECTS_GROUP]: 2 };

/**
 * Customers alphabetically, then internal projects; projects by title within
 * a group. `picked` are projects the settings already use but planbar no
 * longer lists as active – done, closed or archived ones come last, under
 * «Nicht mehr aktiv», so their chips keep a name.
 */
export function projectOptions(
  projects: readonly PlanbarProjectOverview[],
  picked: readonly PlanbarProjectOverview[] = [],
): ProviderOption[] {
  const options = [
    ...projects.map(activeOption),
    ...picked.map((project) => (project.done || project.archived ? inactiveOption(project) : activeOption(project))),
  ];
  const groupRank = (option: ProviderOption) => GROUP_RANK[option.group ?? ''] ?? 0;
  return options.sort(
    (a, b) =>
      groupRank(a) - groupRank(b) || (a.group ?? '').localeCompare(b.group ?? '', 'de-CH') || byLabel(a, b),
  );
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

async function loadActiveProjects(): Promise<PlanbarProjectOverview[]> {
  const projects: PlanbarProjectOverview[] = [];
  for (let page = 1; page <= MAX_PROJECT_PAGES; page += 1) {
    const result = await fetchProjektuebersicht({ status: 'aktiv', page, pageSize: PROJECT_PAGE_SIZE });
    projects.push(...result.data);
    if (result.data.length < PROJECT_PAGE_SIZE || projects.length >= result.total) break;
  }
  return projects;
}

/**
 * Stored ids the active list lacks, looked up whatever their status. A failed
 * lookup only costs the names (the chips say «Unbekannt») – the picker itself
 * needs the active list alone.
 */
async function loadPickedProjects(ids: readonly string[]): Promise<PlanbarProjectOverview[]> {
  const projects: PlanbarProjectOverview[] = [];
  for (let start = 0; start < ids.length; start += MAX_IDS) {
    const chunk = ids.slice(start, start + MAX_IDS);
    try {
      projects.push(...(await fetchProjektuebersicht({ ids: chunk, status: 'alle', pageSize: chunk.length })).data);
    } catch {
      break;
    }
  }
  return projects;
}

async function loadProjectOptions(): Promise<ProviderOption[]> {
  const active = await loadActiveProjects();
  const known = new Set(active.map((project) => project.id));
  const missing = storedProjectIds(useAppState.getState().state).filter((id) => !known.has(id));
  const picked = missing.length > 0 ? await loadPickedProjects(missing) : [];
  return projectOptions(active, picked.filter((project) => !known.has(project.id)));
}

const SETUP_HINTS: Partial<Record<PlanbarErrorKind, string>> = {
  disabled: 'planbar ist ausgeschaltet – in der Fernsteuerung unter «planbar» einschalten',
  notConfigured: 'planbar ist nicht eingerichtet – in der Fernsteuerung unter «planbar» einrichten',
};

/** The picker shows the load error; the kiosk's settings dialog has no setup notice, so it says where to fix it. */
async function withSetupHint(load: () => Promise<ProviderOption[]>): Promise<ProviderOption[]> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof PlanbarError) {
      const hint = SETUP_HINTS[err.kind];
      if (hint) throw new PlanbarError(err.status, hint, err.kind);
    }
    throw err;
  }
}

registerOptionProvider(PLANBAR_MEMBERS_PROVIDER, () =>
  withSetupHint(async () => memberOptions((await fetchMitglieder()).data)),
);
registerOptionProvider(PLANBAR_PROJECTS_PROVIDER, () => withSetupHint(loadProjectOptions));
