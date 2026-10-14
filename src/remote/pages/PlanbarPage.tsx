/**
 * planbar: connection settings and test, then – once switched on and with
 * an API key – a preview of the work list and the news from planbar
 * (through the kiosk's proxy; the key never reaches the browser).
 */
import { useCallback, useState } from 'react';
import { ExternalLink, KeyRound, SquareKanban } from 'lucide-react';
import { useAppState } from '../../state/appState';
import { isSecretSet } from '../secrets';
import { EmptyState, LinkButton, PageHeader } from '../ui';
import { httpUrlOrNull } from '../url';
import { PlanbarConnectionCard } from './planbar/PlanbarConnectionCard';
import { PlanbarPreview } from './planbar/PlanbarPreview';

export function PlanbarPage() {
  const enabled = useAppState((s) => s.state.planbar.enabled);
  const keySet = useAppState((s) => isSecretSet(s.state.planbar.apiKey));
  const url = useAppState((s) => httpUrlOrNull(s.state.planbar.url));
  // A new address or key starts the preview over (the key is redacted, so its value can't tell).
  const [connection, setConnection] = useState(0);
  const onConnectionChange = useCallback(() => setConnection((n) => n + 1), []);

  return (
    <div className="r-page">
      <PageHeader
        title="planbar"
        description="Anbindung an planbar einrichten und prüfen, was die planbar-Widgets am Kiosk anzeigen."
        actions={
          url ? (
            <LinkButton href={url} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>
              planbar öffnen
            </LinkButton>
          ) : undefined
        }
      />

      <PlanbarConnectionCard onConnectionChange={onConnectionChange} />

      {!enabled ? (
        <EmptyState
          icon={SquareKanban}
          title="planbar ist ausgeschaltet"
          description="«planbar verwenden» einschalten, um hier die Arbeitsliste und die News aus planbar zu sehen."
        />
      ) : !keySet ? (
        <EmptyState
          icon={KeyRound}
          title="API-Schlüssel fehlt"
          description="Ohne API-Schlüssel kann der Kiosk planbar nicht abfragen. Den Schlüssel oben unter «Verbindung» eintragen."
        />
      ) : (
        <PlanbarPreview key={connection} />
      )}
    </div>
  );
}
