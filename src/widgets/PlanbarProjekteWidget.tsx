/**
 * planbar Projekte – Karten aus GET /api/v1/projektuebersicht: Fortschritt,
 * Termin, Stunden gegenüber Budget, nächster Meilenstein und Beteiligte.
 * Entweder nach Filter (Status, Personen, Leitung) oder ausgewählte
 * Projekte in fester Reihenfolge – aus einem oder mehreren Unternehmen.
 */
import { type CSSProperties, useMemo } from 'react';
import { Flag, FolderKanban, Pin, TriangleAlert } from 'lucide-react';
import { normalizeSelection } from '../components/settings/multiselect';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { fetchProjektuebersichtAll, type PlanbarFanOut, type PlanbarOrgProjects } from '../planbar/orgs';
import type { PlanbarProjectOverview, WithOrg } from '../planbar/types';
import type { WidgetProps } from '../types/widget';
import {
  PLANBAR_PROJEKTE_AUSWAHL,
  PLANBAR_PROJEKTE_DEFAULTS,
  PLANBAR_PROJEKTE_SORTIERUNG,
  PLANBAR_PROJEKTE_STATUS,
  type PlanbarProjekteSettings,
} from './manifests/planbar-projekte';
import { daysBetween, zurichDay } from './planbar/days';
import { deadlineText, dueText, formatHours, formatHoursOf } from './planbar/format';
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
import { hoursBudget, projectQuery, safeColor, sortProjects } from './planbar/projects';
import { usePlanbarOrgs, usePlanbarPolling } from './planbar/usePlanbarPolling';
import { formatCount, formatPercent } from './shared/format';
import { useNow } from './shared/hooks';
import { WidgetMessage } from './shared/WidgetParts';
import { readBoolean, readChoice, readNumber, readString } from './shared/values';
import './styles/planbar-projekte.css';

const MAX_MEMBERS = 5;
const RUNNING_STATUSES = new Set(['open', 'in_progress']);
/** Budget used from this share on: the hours bar turns to a warning. */
const HOURS_WARN_PERCENT = 90;

function readSettings(raw: PlanbarProjekteSettings): PlanbarProjekteSettings {
  const defaults = PLANBAR_PROJEKTE_DEFAULTS;
  return {
    unternehmen: normalizeSelection(raw.unternehmen),
    auswahl: readChoice(raw.auswahl, PLANBAR_PROJEKTE_AUSWAHL, defaults.auswahl),
    projekte: normalizeSelection(raw.projekte),
    status: readChoice(raw.status, PLANBAR_PROJEKTE_STATUS, defaults.status),
    beteiligte: normalizeSelection(raw.beteiligte),
    leiter: readString(raw.leiter, defaults.leiter).trim(),
    sortierung: readChoice(raw.sortierung, PLANBAR_PROJEKTE_SORTIERUNG, defaults.sortierung),
    maxItems: readNumber(raw.maxItems, defaults.maxItems, 1, 30),
    showHours: readBoolean(raw.showHours, defaults.showHours),
    showMilestones: readBoolean(raw.showMilestones, defaults.showMilestones),
    showMembers: readBoolean(raw.showMembers, defaults.showMembers),
    refreshMinutes: readNumber(raw.refreshMinutes, defaults.refreshMinutes, 1, 60),
  };
}

const isOverdue = (project: PlanbarProjectOverview, today: string): boolean =>
  !project.done && !project.archived && (daysBetween(today, project.deadlineDay) ?? 0) < 0;

interface BarProps {
  label: string;
  value: string;
  percent: number;
  tone: 'accent' | 'ok' | 'warn' | 'error' | 'info';
}

function Bar({ label, value, percent, tone }: BarProps) {
  const width = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return (
    <div className={`pp-bar pp-tone-${tone}`}>
      <div className="pp-bar-head">
        <span className="pp-bar-label">{label}</span>
        <span className="pp-bar-value">{value}</span>
      </div>
      <div className="pp-bar-track" aria-hidden="true">
        <div className="pp-bar-fill" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

interface CardOptions {
  today: string;
  /** Several Unternehmen on screen: each card names its own. */
  showOrg: boolean;
  showHours: boolean;
  showMilestones: boolean;
  showMembers: boolean;
}

function ProjectCard({ project, options }: { project: WithOrg<PlanbarProjectOverview>; options: CardOptions }) {
  const { today } = options;
  const color = safeColor(project.customer?.color);
  const style = color ? ({ '--pp-color': color } as CSSProperties) : undefined;
  const deadline = project.deadlineDay && !project.done && !project.archived ? deadlineText(project.deadlineDay, today) : null;
  const state = project.archived ? 'Archiviert' : RUNNING_STATUSES.has(project.status) ? null : project.statusLabel;
  const sub = [project.customer?.name ?? 'Intern', project.leader ? `Leitung ${project.leader.name}` : null]
    .filter(Boolean)
    .join(' · ');

  const { progress } = project;
  const progressTone = project.done || (progress.total > 0 && progress.done === progress.total) ? 'ok' : 'accent';
  const hours = hoursBudget(project.hours);
  const hoursTone = hours.over ? 'error' : (hours.percent ?? 0) >= HOURS_WARN_PERCENT ? 'warn' : 'info';
  const milestone = options.showMilestones ? project.nextMilestone : null;
  const milestoneLate = milestone !== null && (daysBetween(today, milestone.dueDay) ?? 0) < 0;
  const members = options.showMembers ? project.members : [];

  const classes = `pp-card${deadline?.tone === 'overdue' ? ' pp-card-overdue' : ''}${project.done || project.archived ? ' pp-card-done' : ''}`;

  return (
    <article className={classes} style={style}>
      <header className="pp-card-head">
        <h3 className="pp-title">
          {project.isPinned && <Pin className="pp-pin" aria-label="Angeheftet" />}
          {project.title}
        </h3>
        {deadline && <span className={`pp-deadline pp-deadline-${deadline.tone}`}>{deadline.text}</span>}
      </header>
      <div className="pp-sub">
        {options.showOrg && <PlanbarOrgBadge org={project.org} />}
        <span className="pp-sub-text">{sub}</span>
        {state && <span className="pp-state">{state}</span>}
      </div>
      {progress.total > 0 ? (
        <Bar
          label={`Aufgaben ${formatCount(progress.done)}/${formatCount(progress.total)}`}
          value={formatPercent(progress.percent ?? (progress.done / progress.total) * 100)}
          percent={progress.percent ?? (progress.done / progress.total) * 100}
          tone={progressTone}
        />
      ) : (
        <div className="pp-line pp-muted">Noch keine Aufgaben</div>
      )}
      {options.showHours &&
        (hours.budget !== null ? (
          <Bar
            label={`Stunden ${formatHoursOf(hours.tracked, hours.budget)}`}
            value={hours.percent !== null ? formatPercent(hours.percent) : ''}
            percent={hours.percent ?? 0}
            tone={hoursTone}
          />
        ) : (
          hours.tracked > 0 && <div className="pp-line pp-muted">{formatHours(hours.tracked)} erfasst, ohne Budget</div>
        ))}
      {milestone && (
        <div className={`pp-line pp-milestone${milestoneLate ? ' pp-milestone-late' : ''}`}>
          <Flag aria-hidden="true" />
          <span className="pp-milestone-title">{milestone.title}</span>
          <span className="pp-milestone-day">{dueText(milestone.dueDay, today)}</span>
        </div>
      )}
      {members.length > 0 && (
        <div className="pp-members">
          {members.slice(0, MAX_MEMBERS).map((member) => (
            <PersonAvatar key={member.id} person={member} count={member.openTasks} />
          ))}
          {members.length > MAX_MEMBERS && <span className="pp-members-more">+{formatCount(members.length - MAX_MEMBERS)}</span>}
        </div>
      )}
    </article>
  );
}

export function PlanbarProjekteWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings(instanceId, PLANBAR_PROJEKTE_DEFAULTS);
  const settings = useMemo(() => readSettings(raw), [raw]);
  const query = useMemo(() => projectQuery(settings), [settings]);
  const queryKey = JSON.stringify(query);
  const now = useNow(60_000);

  const orgs = usePlanbarOrgs(settings.unternehmen);

  const poll = usePlanbarPolling<PlanbarFanOut<PlanbarOrgProjects>>(
    (signal) => fetchProjektuebersichtAll(orgs, query ?? {}, { signal }),
    settings.refreshMinutes * 60_000,
    [orgs, queryKey],
    query !== null && orgs.length > 0,
  );

  if (poll.setup !== 'ready') return <PlanbarSetupMessage setup={poll.setup} />;
  if (orgs.length === 0) return <PlanbarNoOrgsMessage />;
  if (query === null) {
    return <WidgetMessage icon={FolderKanban} title="Keine Projekte ausgewählt" detail="In den Einstellungen Projekte auswählen" />;
  }
  if (poll.data === null) {
    if (poll.failure) return <PlanbarErrorMessage failure={poll.failure} right="Projekte – Lesen" />;
    if (poll.error !== null) return <WidgetMessage icon={TriangleAlert} tone="error" title="planbar-Fehler" detail={poll.error} />;
    return <WidgetMessage busy title="Projekte werden geladen …" />;
  }

  const today = zurichDay(now);
  const picked = settings.auswahl === 'ausgewaehlt';
  const { data, orgs: asked, failures } = poll.data;
  // Hand-picked projects keep the chosen order (orgs.ts merges them in the order of `ids`).
  const projects = picked ? data.data : sortProjects(data.data, settings.sortierung);
  const shown = projects.slice(0, settings.maxItems);
  const more = Math.max(projects.length, picked ? 0 : data.total) - shown.length;
  // An Unternehmen that did not answer does not mean its projects are gone.
  const missing = picked && failures.length === 0 ? Math.max(0, (query.ids?.length ?? 0) - data.data.length) : 0;
  const overdue = shown.filter((project) => isOverdue(project, today)).length;
  const stale = poll.failure !== null;
  const options: CardOptions = {
    today,
    showOrg: asked.length > 1,
    showHours: settings.showHours,
    showMilestones: settings.showMilestones,
    showMembers: settings.showMembers,
  };

  return (
    <div className="pp">
      <PlanbarHead icon={FolderKanban} lastUpdated={poll.lastUpdated} stale={stale}>
        {formatCount(shown.length)} {shown.length === 1 ? 'Projekt' : 'Projekte'}
        {overdue > 0 && (
          <>
            {' · '}
            <span className="pb-alert">{formatCount(overdue)} überfällig</span>
          </>
        )}
        {missing > 0 && ` · ${formatCount(missing)} nicht gefunden`}
      </PlanbarHead>
      {poll.failure && <PlanbarStaleBanner failure={poll.failure} lastUpdated={poll.lastUpdated} />}
      {!poll.failure && <PlanbarOrgIssues failures={failures} />}
      {shown.length === 0 ? (
        <div className="pp-empty">
          <WidgetMessage
            icon={FolderKanban}
            title="Keine Projekte"
            detail={picked ? 'Die ausgewählten Projekte gibt es in planbar nicht mehr.' : 'Kein Projekt passt zum Filter.'}
          />
        </div>
      ) : (
        <div className={`pp-grid${stale ? ' pp-grid-stale' : ''}`}>
          {shown.map((project) => (
            <ProjectCard key={`${project.org.id}:${project.id}`} project={project} options={options} />
          ))}
          {more > 0 && <div className="pp-more">+{formatCount(more)} weitere in planbar</div>}
        </div>
      )}
    </div>
  );
}
