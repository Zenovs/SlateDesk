/**
 * planbar: the address for all Unternehmen, one card per Unternehmen (name,
 * API key, connection test), then – once switched on and with a key – a
 * preview of the work list and the news from planbar (through the kiosk's
 * proxy; the keys never reach the browser).
 */
import { useCallback, useState } from 'react';
import { ExternalLink, KeyRound, SquareKanban } from 'lucide-react';
import { invalidateOptionProvider } from '../../components/settings/optionProviders';
import { PLANBAR_MEMBERS_PROVIDER, PLANBAR_ORGS_PROVIDER, PLANBAR_PROJECTS_PROVIDER } from '../../planbar/options';
import { configuredOrgs } from '../../planbar/orgs';
import { useAppState } from '../../state/appState';
import { EmptyState, LinkButton, PageHeader } from '../ui';
import { httpUrlOrNull } from '../url';
import { PlanbarConnectionCard } from './planbar/PlanbarConnectionCard';
import { PlanbarOrgsSection } from './planbar/PlanbarOrgsSection';
import { PlanbarPreview } from './planbar/PlanbarPreview';

export function PlanbarPage() {
  const enabled = useAppState((s) => s.state.planbar.enabled);
  const configured = useAppState((s) => configuredOrgs(s.state.planbar).length > 0);
  const hasOrgs = useAppState((s) => Object.keys(s.state.planbar.unternehmen).length > 0);
  const url = useAppState((s) => httpUrlOrNull(s.state.planbar.url));
  // A new address or key starts the preview over (keys are redacted, so their values can't tell).
  const [connection, setConnection] = useState(0);
  const onConnectionChange = useCallback(() => {
    // The people and project pickers of the widgets load through these connections.
    for (const name of [PLANBAR_ORGS_PROVIDER, PLANBAR_MEMBERS_PROVIDER, PLANBAR_PROJECTS_PROVIDER]) {
      invalidateOptionProvider(name);
    }
    setConnection((n) => n + 1);
  }, []);

  return (
    <div className="r-page">
      <PageHeader
        title="planbar"
        description="Anbindung an planbar einrichten – ein API-Schlüssel pro Unternehmen – und prüfen, was die planbar-Widgets am Kiosk anzeigen."
        actions={
          url ? (
            <LinkButton href={url} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>
              planbar öffnen
            </LinkButton>
          ) : undefined
        }
      />

      <PlanbarConnectionCard onConnectionChange={onConnectionChange} />
      <PlanbarOrgsSection onConnectionChange={onConnectionChange} />

      {!enabled ? (
        <EmptyState
          icon={SquareKanban}
          title="planbar ist ausgeschaltet"
          description="«planbar verwenden» einschalten, um hier die Arbeitsliste und die News aus planbar zu sehen."
        />
      ) : !configured ? (
        // Without any Unternehmen the section above already says what to do.
        hasOrgs && (
          <EmptyState
            icon={KeyRound}
            title="API-Schlüssel fehlt"
            description="Ohne Unternehmen mit API-Schlüssel kann der Kiosk planbar nicht abfragen. Oben beim Unternehmen den Schlüssel eintragen."
          />
        )
      ) : (
        <PlanbarPreview key={connection} />
      )}
    </div>
  );
}
