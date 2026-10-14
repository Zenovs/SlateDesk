/**
 * Building blocks shared by the planbar widgets: setup, error and «stale
 * data» states, the summary line and person avatars.
 *
 * planbar's own error texts are German and name what is wrong (e.g. a
 * revoked key) – they may be shown; the hint what to do comes from here.
 */
import type { CSSProperties, ReactNode } from 'react';
import { CloudOff, KeyRound, type LucideIcon, PlugZap, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { PlanbarPerson } from '../../planbar/types';
import { formatClock } from '../shared/format';
import { WidgetBanner, WidgetMessage } from '../shared/WidgetParts';
import { initials, personHue } from './format';
import type { PlanbarFailure, PlanbarSetup } from './usePlanbarPolling';
import '../styles/planbar-shared.css';

/** planbar's reason behind SlateDesk's prefix: «planbar: API-Schlüssel ungültig (401) – <reason>». */
function reasonOf(message: string): string | null {
  const index = message.indexOf(' – ');
  const reason = index === -1 ? '' : message.slice(index + 3).trim();
  return reason || null;
}

export function PlanbarSetupMessage({ setup }: { setup: Exclude<PlanbarSetup, 'ready'> }) {
  if (setup === 'disabled') {
    return (
      <WidgetMessage
        icon={PlugZap}
        title="planbar ist ausgeschaltet"
        detail="planbar in der Fernsteuerung unter «planbar» einschalten"
      />
    );
  }
  return (
    <WidgetMessage
      icon={PlugZap}
      title="planbar ist nicht eingerichtet"
      detail="planbar in der Fernsteuerung unter «planbar» einrichten"
    />
  );
}

interface ErrorProps {
  failure: PlanbarFailure;
  /** Right of the API key this widget needs, as planbar's key dialog names it («News – Lesen»). */
  right: string;
}

/** Full-size error when there is no data to show yet. */
export function PlanbarErrorMessage({ failure, right }: ErrorProps) {
  const reason = reasonOf(failure.message);
  switch (failure.kind) {
    case 'notConfigured':
      return <PlanbarSetupMessage setup="notConfigured" />;
    case 'disabled':
      return <PlanbarSetupMessage setup="disabled" />;
    case 'unauthorized':
      return (
        <WidgetMessage
          icon={KeyRound}
          tone="error"
          title="planbar: API-Schlüssel ungültig"
          detail={`${reason ? `${reason}. ` : ''}Neuen Schlüssel in der Fernsteuerung unter «planbar» eintragen.`}
        />
      );
    case 'forbidden':
      return (
        <WidgetMessage
          icon={ShieldAlert}
          tone="warn"
          title="planbar: Berechtigung fehlt"
          detail={`${reason ? `${reason}. ` : ''}Der API-Schlüssel braucht das Recht «${right}» (planbar: Unternehmen → API-Schlüssel).`}
        />
      );
    case 'endpointMissing':
      return (
        <WidgetMessage
          icon={TriangleAlert}
          tone="warn"
          title="planbar-Update nötig"
          detail="Diese planbar-Version kennt die Schnittstelle für SlateDesk noch nicht."
        />
      );
    case 'unreachable':
      return (
        <WidgetMessage icon={CloudOff} tone="error" title="planbar nicht erreichbar" detail="Neuer Versuch läuft automatisch." />
      );
    case 'sessionExpired':
      return <WidgetMessage icon={KeyRound} tone="warn" title="Sitzung abgelaufen" detail="Bitte neu anmelden." />;
    case 'invalidRequest':
    case 'notFound':
      return (
        <WidgetMessage
          icon={TriangleAlert}
          tone="error"
          title="planbar hat die Anfrage abgelehnt"
          detail={reason ?? failure.message}
        />
      );
    default:
      return (
        <WidgetMessage
          icon={TriangleAlert}
          tone="error"
          title="planbar-Fehler"
          detail={
            reason ??
            (failure.status ? `planbar antwortet mit Fehler ${failure.status}.` : 'planbar hat unerwartet geantwortet.')
          }
        />
      );
  }
}

/** One line above data that could not be refreshed. */
export function PlanbarStaleBanner({ failure, lastUpdated }: { failure: PlanbarFailure; lastUpdated: number | null }) {
  const stand = lastUpdated !== null ? ` – Stand ${formatClock(lastUpdated)}` : '';
  switch (failure.kind) {
    case 'unreachable':
      return (
        <WidgetBanner tone="error" icon={CloudOff}>
          planbar nicht erreichbar seit {formatClock(failure.since)}
          {stand}
        </WidgetBanner>
      );
    case 'unauthorized':
      return (
        <WidgetBanner tone="error" icon={KeyRound}>
          API-Schlüssel ungültig{stand}
        </WidgetBanner>
      );
    case 'forbidden':
      return (
        <WidgetBanner tone="warn" icon={ShieldAlert}>
          Berechtigung fehlt{stand}
        </WidgetBanner>
      );
    case 'endpointMissing':
      return (
        <WidgetBanner tone="warn" icon={TriangleAlert}>
          planbar-Update nötig{stand}
        </WidgetBanner>
      );
    default:
      return (
        <WidgetBanner tone="warn" icon={TriangleAlert}>
          {failure.status ? `Aktualisierung fehlgeschlagen (Fehler ${failure.status})` : 'Aktualisierung fehlgeschlagen'}
          {stand}
        </WidgetBanner>
      );
  }
}

interface HeadProps {
  icon: LucideIcon;
  children: ReactNode;
  /** epoch ms of the data shown; hidden while a stale banner says it. */
  lastUpdated: number | null;
  stale: boolean;
}

/** Summary line on top of a widget: icon, counts, «Stand 14:05». */
export function PlanbarHead({ icon: Icon, children, lastUpdated, stale }: HeadProps) {
  return (
    <div className="pb-head">
      <Icon className="pb-head-icon" aria-hidden="true" />
      <span className="pb-head-summary">{children}</span>
      {!stale && lastUpdated !== null && <span className="pb-head-time">Stand {formatClock(lastUpdated)}</span>}
    </div>
  );
}

interface AvatarProps {
  person: PlanbarPerson;
  /** Small number on the avatar, e.g. open tasks. */
  count?: number;
}

/** Initials in the person's colour (the same in every planbar widget). */
export function PersonAvatar({ person, count }: AvatarProps) {
  const style = { '--pb-hue': personHue(person.id) } as CSSProperties;
  const name = person.name.trim() || 'Ohne Namen';
  const label = count === undefined ? name : `${name}: ${count} offen`;
  return (
    <span className="pb-avatar" style={style} role="img" aria-label={label} title={label}>
      <span className="pb-avatar-initials">{initials(person.name)}</span>
      {count !== undefined && count > 0 && <span className="pb-avatar-count">{count}</span>}
    </span>
  );
}
