/**
 * Setup, error and «stale data» states shared by the lagra widgets.
 *
 * lagra's own error texts never reach the wall (they can name folders or
 * hosts) – only the kind of problem and what to do about it.
 */
import { CloudOff, KeyRound, PlugZap, TriangleAlert } from 'lucide-react';
import type { LagraErrorKind } from '../../lagra/client';
import { formatClock } from './format';
import type { LagraSetup } from './hooks';
import { WidgetBanner, WidgetMessage } from './WidgetParts';

export function LagraSetupMessage({ setup }: { setup: Exclude<LagraSetup, 'ready'> }) {
  if (setup === 'disabled') {
    return (
      <WidgetMessage icon={PlugZap} title="lagra ist ausgeschaltet" detail="lagra in der Fernsteuerung unter «lagra» einschalten" />
    );
  }
  return (
    <WidgetMessage icon={PlugZap} title="lagra ist nicht eingerichtet" detail="lagra in der Fernsteuerung unter «lagra» einrichten" />
  );
}

interface ErrorProps {
  kind: LagraErrorKind | null;
  status: number | null;
}

/** Full-size error when there is no data to show yet. */
export function LagraErrorMessage({ kind, status }: ErrorProps) {
  switch (kind) {
    case 'notConfigured':
      return <LagraSetupMessage setup="notConfigured" />;
    case 'disabled':
      return <LagraSetupMessage setup="disabled" />;
    case 'unauthorized':
      return (
        <WidgetMessage
          icon={KeyRound}
          tone="error"
          title="lagra: Token ungültig"
          detail="Neues Token in der Fernsteuerung unter «lagra» eintragen"
        />
      );
    case 'endpointMissing':
      return (
        <WidgetMessage
          icon={TriangleAlert}
          tone="warn"
          title="lagra-Update nötig"
          detail="Diese lagra-Version kennt die Schnittstelle für SlateDesk noch nicht."
        />
      );
    case 'unreachable':
      return (
        <WidgetMessage
          icon={CloudOff}
          tone="error"
          title="lagra nicht erreichbar"
          detail="Neuer Versuch läuft automatisch."
        />
      );
    case 'sessionExpired':
      return <WidgetMessage icon={KeyRound} tone="warn" title="Sitzung abgelaufen" detail="Bitte neu anmelden." />;
    default:
      return (
        <WidgetMessage
          icon={TriangleAlert}
          tone="error"
          title="lagra-Fehler"
          detail={status ? `lagra hat die Anfrage abgelehnt (Fehler ${status}).` : 'lagra hat unerwartet geantwortet.'}
        />
      );
  }
}

interface StaleProps extends ErrorProps {
  /** epoch ms of the first failed request. */
  failingSince: number | null;
  /** epoch ms of the data still shown. */
  lastUpdated: number | null;
}

/** One line above data that could not be refreshed. */
export function LagraStaleBanner({ kind, status, failingSince, lastUpdated }: StaleProps) {
  const since = failingSince ?? lastUpdated;
  const stand = lastUpdated !== null ? ` – Stand ${formatClock(lastUpdated)}` : '';
  switch (kind) {
    case 'unreachable':
      return (
        <WidgetBanner tone="error" icon={CloudOff}>
          {since !== null ? `nicht erreichbar seit ${formatClock(since)}` : 'nicht erreichbar'}
        </WidgetBanner>
      );
    case 'unauthorized':
      return (
        <WidgetBanner tone="error" icon={KeyRound}>
          Token ungültig{stand}
        </WidgetBanner>
      );
    case 'endpointMissing':
      return (
        <WidgetBanner tone="warn" icon={TriangleAlert}>
          lagra-Update nötig{stand}
        </WidgetBanner>
      );
    default:
      return (
        <WidgetBanner tone="warn" icon={TriangleAlert}>
          {status ? `Aktualisierung fehlgeschlagen (Fehler ${status})` : 'Aktualisierung fehlgeschlagen'}
          {stand}
        </WidgetBanner>
      );
  }
}
