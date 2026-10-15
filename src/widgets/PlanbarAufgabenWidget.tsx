/**
 * planbar Aufgaben – die Arbeitsliste ausgewählter Personen aus
 * GET /api/v1/arbeitsliste: Aufgaben und zugewiesene Projekte, nach
 * Fälligkeit (Zürcher Kalendertage), Person, Projekt oder Unternehmen
 * gruppiert. Mehrere Unternehmen werden einzeln gefragt und zusammengeführt;
 * fehlt die Antwort eines Unternehmens, zeigt das Widget die übrigen.
 *
 * Abhaken (falls erlaubt) wirkt am Bildschirm sofort; planbar erfährt es
 * erst nach 5 s, bis dahin lässt es sich rückgängig machen
 * (planbar/completion.ts).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Building2, Check, CircleCheck, ClipboardCheck, FolderKanban, RotateCcw, TriangleAlert, Users } from 'lucide-react';
import { normalizeSelection } from '../components/settings/multiselect';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { completeItem, PlanbarError, planbarErrorText } from '../planbar/client';
import { fetchArbeitslisteAll, type PlanbarFanOut, type PlanbarOrgWorkList } from '../planbar/orgs';
import type { PlanbarPerson, PlanbarWorkItem } from '../planbar/types';
import type { WidgetProps } from '../types/widget';
import {
  PLANBAR_AUFGABEN_DEFAULTS,
  PLANBAR_AUFGABEN_STATUS,
  PLANBAR_AUFGABEN_TYPEN,
  PLANBAR_GRUPPIERUNGEN,
  PLANBAR_ZEITRAEUME,
  type PlanbarAufgabenSettings,
  type PlanbarZeitraum,
} from './manifests/planbar-aufgaben';
import { CompletionQueue, latestWaiting, type LocalChange, UNDO_MS } from './planbar/completion';
import { laterDay, zurichDay } from './planbar/days';
import { dueText, formatHours } from './planbar/format';
import {
  PersonAvatar,
  PlanbarErrorMessage,
  PlanbarHead,
  PlanbarNoOrgsMessage,
  PlanbarOrgBadge,
  PlanbarOrgIssues,
  PlanbarSetupMessage,
  PlanbarStaleBanner,
} from './planbar/PlanbarParts';
import { usePlanbarOrgs, usePlanbarPolling } from './planbar/usePlanbarPolling';
import { buildRows, groupRows, type WorkGroup, type WorkRow, zeitraumBis } from './planbar/workItems';
import { formatCount } from './shared/format';
import { useNow } from './shared/hooks';
import { WidgetMessage } from './shared/WidgetParts';
import { readBoolean, readChoice, readNumber } from './shared/values';
import './styles/planbar-aufgaben.css';

/** How long a failed tick-off stays visible. */
const ERROR_MS = 10_000;
/** Avatars per row at most (with several people selected). */
const MAX_AVATARS = 3;
const RUNNING_STATUSES = new Set(['open', 'in_progress']);

const EMPTY_DETAIL: Record<PlanbarZeitraum, string> = {
  alle: 'Keine offenen Einträge.',
  heute: 'Heute ist nichts mehr fällig.',
  woche: 'Bis Ende Woche ist nichts mehr fällig.',
  'zwei-wochen': 'Bis Ende nächster Woche ist nichts mehr fällig.',
};

interface Loaded {
  result: PlanbarFanOut<PlanbarOrgWorkList>;
  /** epoch ms the request started – changes confirmed before are contained. */
  startedAt: number;
}

interface ActionError {
  text: string;
  at: number;
}

function readSettings(raw: PlanbarAufgabenSettings): PlanbarAufgabenSettings {
  const defaults = PLANBAR_AUFGABEN_DEFAULTS;
  return {
    unternehmen: normalizeSelection(raw.unternehmen),
    benutzer: normalizeSelection(raw.benutzer),
    projekte: normalizeSelection(raw.projekte),
    status: readChoice(raw.status, PLANBAR_AUFGABEN_STATUS, defaults.status),
    typ: readChoice(raw.typ, PLANBAR_AUFGABEN_TYPEN, defaults.typ),
    zeitraum: readChoice(raw.zeitraum, PLANBAR_ZEITRAEUME, defaults.zeitraum),
    gruppierung: readChoice(raw.gruppierung, PLANBAR_GRUPPIERUNGEN, defaults.gruppierung),
    maxItems: readNumber(raw.maxItems, defaults.maxItems, 1, 200),
    showProject: readBoolean(raw.showProject, defaults.showProject),
    showAssignee: readBoolean(raw.showAssignee, defaults.showAssignee),
    allowComplete: readBoolean(raw.allowComplete, defaults.allowComplete),
    refreshSeconds: readNumber(raw.refreshSeconds, defaults.refreshSeconds, 30, 600),
  };
}

function completionErrorText(change: LocalChange, err: unknown): string {
  if (err instanceof PlanbarError && err.kind === 'forbidden') {
    return 'Abhaken nicht erlaubt: Der API-Schlüssel dieses Unternehmens braucht bei «Aufgaben & Zeiten» das Recht «Schreiben».';
  }
  if (err instanceof PlanbarError && err.kind === 'notFound') return `«${change.title}» gibt es in planbar nicht mehr.`;
  const what = change.completed ? 'abgehakt' : 'wieder geöffnet';
  return `«${change.title}» wurde nicht ${what}: ${planbarErrorText(err)}`;
}

/** The selected person's name as planbar writes it in the list (for the summary line). */
function personName(items: readonly PlanbarWorkItem[], id: string): string | null {
  for (const item of items) {
    const person = item.assignees.find((p) => p.id === id) ?? (item.assignee?.id === id ? item.assignee : null);
    if (person?.name.trim()) return person.name.trim();
  }
  return null;
}

/** Selected people among the assignees; without any, the primary assignee. */
function rowPeople(item: PlanbarWorkItem, selected: ReadonlySet<string>): PlanbarPerson[] {
  const mine = item.assignees.filter((person) => selected.has(person.id));
  if (mine.length > 0) return mine.slice(0, MAX_AVATARS);
  return item.assignee ? [item.assignee] : [];
}

const priorityClass = (priority: string | null): string =>
  priority === 'critical' || priority === 'high' ? ` pa-prio-${priority}` : '';

// ── Rows ─────────────────────────────────────────────────────────────────────

interface RowOptions {
  today: string;
  showProject: boolean;
  showAssignee: boolean;
  /** Several Unternehmen on screen: each entry names its own. */
  showOrg: boolean;
  selected: ReadonlySet<string>;
  canComplete: boolean;
  onToggle: (row: WorkRow) => void;
}

function WorkRowView({ row, showDue, options }: { row: WorkRow; showDue: boolean; options: RowOptions }) {
  const { item } = row;
  const isTask = item.type === 'aufgabe';
  const classes = `pa-row${priorityClass(item.priority)}${row.done ? ' pa-row-done' : ''}${row.overdue ? ' pa-row-overdue' : ''}${
    row.pending ? ' pa-row-pending' : ''
  }${row.leaving ? ' pa-row-leaving' : ''}`;

  const project = isTask ? (item.parentTitle ?? item.project.name) : null;
  const customer = item.project.customer?.name ?? null;
  const projectText = [project, customer].filter(Boolean).join(' · ');
  const people = options.showAssignee ? rowPeople(item, options.selected) : [];
  const projectState = !isTask && !RUNNING_STATUSES.has(item.status) ? item.statusLabel : null;
  const inProgress = isTask && item.status === 'in_progress' && !row.done;
  const hours = item.estimatedHours !== null && item.estimatedHours > 0 ? item.estimatedHours : null;
  const showProjectText = options.showProject && projectText !== '';
  const org = options.showOrg ? (item.org ?? null) : null;
  const hasMeta = !isTask || inProgress || showProjectText || hours !== null || org !== null;

  return (
    <li className={classes}>
      {options.canComplete && isTask ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={row.done}
          aria-label={`«${item.title}» ${row.done ? 'wieder öffnen' : 'abhaken'}`}
          className="pa-check"
          onClick={() => options.onToggle(row)}
          disabled={row.leaving}
        >
          <span className="pa-check-circle">
            <Check aria-hidden="true" />
          </span>
        </button>
      ) : (
        <span className="pa-mark" aria-hidden="true">
          {!isTask ? <FolderKanban /> : row.done ? <Check /> : <span className="pa-bullet" />}
        </span>
      )}
      <div className="pa-main">
        <div className="pa-title" title={item.priorityLabel ? `Priorität: ${item.priorityLabel}` : undefined}>
          {item.title}
        </div>
        {hasMeta && (
          <div className="pa-meta">
            {org && <PlanbarOrgBadge org={org} />}
            {!isTask && <span className="pa-tag pa-tag-type">Projekt</span>}
            {projectState && <span className="pa-tag">{projectState}</span>}
            {inProgress && <span className="pa-tag pa-tag-active">{item.statusLabel}</span>}
            {showProjectText && <span className="pa-project">{projectText}</span>}
            {hours !== null && (
              <span className="pa-hours" title="Geschätzter Aufwand">
                {formatHours(hours)}
              </span>
            )}
          </div>
        )}
      </div>
      {((showDue && item.dueDay) || people.length > 0) && (
        <div className="pa-side">
          {showDue && item.dueDay && <span className="pa-due">{dueText(item.dueDay, options.today)}</span>}
          {people.length > 0 && (
            <span className="pa-people">
              {people.map((person) => (
                <PersonAvatar key={person.id} person={person} />
              ))}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function GroupView({ group, options }: { group: WorkGroup; options: RowOptions }) {
  // Heute / Morgen say the day already.
  const showDue = group.due !== 'heute' && group.due !== 'morgen' && group.due !== 'ohne';
  const count = group.rows.filter((row) => !row.leaving).length;
  return (
    <section className={`pa-group${group.due ? ` pa-group-${group.due}` : ''}`}>
      <h3 className="pa-group-title">
        {group.person && <PersonAvatar person={group.person} />}
        {group.org && <Building2 className="pa-group-icon" aria-hidden="true" />}
        <span className="pa-group-label">{group.label}</span>
        {group.detail && <span className="pa-group-detail">{group.detail}</span>}
        {count > 0 && <span className="pa-group-count">{formatCount(count)}</span>}
      </h3>
      <ul className="pa-list">
        {group.rows.map((row) => (
          <WorkRowView key={`${row.item.org?.id ?? ''}:${row.item.id}`} row={row} showDue={showDue} options={options} />
        ))}
      </ul>
    </section>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function PlanbarAufgabenWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings(instanceId, PLANBAR_AUFGABEN_DEFAULTS);
  const settings = useMemo(() => readSettings(raw), [raw]);
  const now = useNow(60_000);
  const [queue] = useState(() => new CompletionQueue((id, completed, org) => completeItem(id, completed, { org })));
  const changes = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const [actionError, setActionError] = useState<ActionError | null>(null);

  const orgs = usePlanbarOrgs(settings.unternehmen);
  const poll = usePlanbarPolling<Loaded>(
    async (signal) => {
      const startedAt = Date.now();
      const result = await fetchArbeitslisteAll(
        orgs,
        {
          benutzer: settings.benutzer,
          projekte: settings.projekte,
          status: settings.status,
          typ: settings.typ,
          // Evaluated per request: rolls over at Zurich midnight without a new query.
          bis: zeitraumBis(settings.zeitraum, zurichDay(Date.now())),
          limit: settings.maxItems,
        },
        { signal },
      );
      return { result, startedAt };
    },
    settings.refreshSeconds * 1000,
    [
      orgs,
      settings.benutzer.join(','),
      settings.projekte.join(','),
      settings.status,
      settings.typ,
      settings.zeitraum,
      settings.maxItems,
    ],
    settings.benutzer.length > 0 && orgs.length > 0,
  );
  const { refresh } = poll;
  const loaded = poll.data;

  useEffect(
    () =>
      queue.listen({
        onSent: () => refresh(),
        onFailed: (change, err) => setActionError({ text: completionErrorText(change, err), at: Date.now() }),
      }),
    [queue, refresh],
  );

  // Changes are dropped only once a list containing them is on screen – no flicker back.
  useEffect(() => {
    if (loaded) queue.settle(loaded.startedAt);
  }, [queue, loaded]);

  // Ticking off switched off (e.g. from a phone) within the undo window: the row loses its
  // checkbox and «Rückgängig» disappears, so those taps must not reach planbar either.
  useEffect(() => {
    if (!settings.allowComplete) queue.undoAll();
  }, [queue, settings.allowComplete]);

  // Taps still in their undo window count when the widget goes away.
  useEffect(() => () => queue.flush(), [queue]);

  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(null), ERROR_MS);
    return () => clearTimeout(timer);
  }, [actionError]);

  const today = loaded ? laterDay(loaded.result.data.today, zurichDay(now)) : zurichDay(now);
  const onlyOpen = settings.status === 'offen';
  const rows = useMemo(
    () => (loaded ? buildRows(loaded.result.data.data, changes, today, onlyOpen) : []),
    [loaded, changes, today, onlyOpen],
  );
  const groups = useMemo(
    () => groupRows(rows, settings.gruppierung, today, settings.benutzer, orgs),
    [rows, settings.gruppierung, today, settings.benutzer, orgs],
  );
  const selected = useMemo(() => new Set(settings.benutzer), [settings.benutzer]);

  if (poll.setup !== 'ready') return <PlanbarSetupMessage setup={poll.setup} />;
  if (orgs.length === 0) return <PlanbarNoOrgsMessage />;
  if (settings.benutzer.length === 0) {
    return <WidgetMessage icon={Users} title="Keine Personen ausgewählt" detail="In den Einstellungen Personen auswählen" />;
  }
  if (!loaded) {
    if (poll.failure) return <PlanbarErrorMessage failure={poll.failure} right="Aufgaben & Zeiten – Lesen" />;
    if (poll.error !== null) return <WidgetMessage icon={TriangleAlert} tone="error" title="planbar-Fehler" detail={poll.error} />;
    return <WidgetMessage busy title="Arbeitsliste wird geladen …" />;
  }

  const list = loaded.result.data;
  const visible = rows.filter((row) => !row.leaving);
  const open = visible.filter((row) => !row.done).length;
  const overdue = visible.filter((row) => row.overdue).length;
  const more = Math.max(0, list.total - list.data.length);
  const name = settings.benutzer.length === 1 ? personName(list.data, settings.benutzer[0]) : null;
  const stale = poll.failure !== null;
  const waiting = settings.allowComplete ? latestWaiting(changes) : null;
  const waitingCount = [...changes.values()].filter((change) => change.phase === 'waiting').length;

  const options: RowOptions = {
    today,
    showProject: settings.showProject && settings.gruppierung !== 'projekt',
    showAssignee: settings.showAssignee && settings.benutzer.length > 1 && settings.gruppierung !== 'person',
    showOrg: loaded.result.orgs.length > 1 && settings.gruppierung !== 'unternehmen',
    selected,
    canComplete: settings.allowComplete,
    onToggle: (row) => {
      setActionError(null);
      // Ticked off with the key of the task's own Unternehmen.
      queue.toggle({ id: row.item.id, title: row.item.title, done: row.item.done, org: row.item.org?.id });
    },
  };

  return (
    <div className="pa">
      <PlanbarHead icon={ClipboardCheck} lastUpdated={poll.lastUpdated} stale={stale}>
        {name && `${name} · `}
        {formatCount(open)} offen
        {overdue > 0 && (
          <>
            {' · '}
            <span className="pb-alert">{formatCount(overdue)} überfällig</span>
          </>
        )}
      </PlanbarHead>
      {poll.failure && <PlanbarStaleBanner failure={poll.failure} lastUpdated={poll.lastUpdated} />}
      {!poll.failure && <PlanbarOrgIssues failures={loaded.result.failures} />}
      {visible.length === 0 ? (
        <div className="pa-empty">
          {onlyOpen ? (
            <WidgetMessage icon={CircleCheck} tone="ok" title="Alles erledigt" detail={EMPTY_DETAIL[settings.zeitraum]} />
          ) : (
            <WidgetMessage icon={ClipboardCheck} title="Keine Einträge" detail="planbar meldet für diese Auswahl nichts." />
          )}
        </div>
      ) : (
        <div className={`pa-scroll${stale ? ' pa-scroll-stale' : ''}`}>
          {groups.map((group) => (
            <GroupView key={group.key} group={group} options={options} />
          ))}
          {more > 0 && <div className="pa-more">+{formatCount(more)} weitere in planbar</div>}
        </div>
      )}
      {actionError ? (
        <div key={actionError.at} className="pa-feedback pa-feedback-error" role="alert">
          <TriangleAlert className="pa-feedback-icon" aria-hidden="true" />
          <span className="pa-feedback-text">{actionError.text}</span>
        </div>
      ) : (
        waiting && (
          <div key={`${waiting.id}:${waiting.startedAt}`} className="pa-feedback" role="status">
            <CircleCheck className="pa-feedback-icon" aria-hidden="true" />
            <span className="pa-feedback-text">
              «{waiting.title}» {waiting.completed ? 'erledigt' : 'wieder offen'}
              {waitingCount > 1 && <span className="pa-feedback-more"> +{formatCount(waitingCount - 1)}</span>}
            </span>
            <button type="button" className="pa-undo" onClick={() => queue.undo(waiting.id)}>
              <RotateCcw aria-hidden="true" />
              Rückgängig
            </button>
            <span className="pa-feedback-timer" style={{ animationDuration: `${UNDO_MS}ms` }} aria-hidden="true" />
          </div>
        )
      )}
    </div>
  );
}
