/**
 * lagra: connection settings and test, then – once switched on and with a
 * token – the live overview and the background jobs from lagra (through the
 * kiosk's proxy; the token never reaches the browser).
 */
import { Boxes, ExternalLink, KeyRound } from 'lucide-react';
import { useAppState } from '../../state/appState';
import { isSecretSet } from '../secrets';
import { EmptyState, LinkButton, PageHeader } from '../ui';
import { httpUrlOrNull } from '../url';
import { LagraConnectionCard } from './lagra/LagraConnectionCard';
import { LagraJobsCard } from './lagra/LagraJobsCard';
import { LagraOverview } from './lagra/LagraOverview';

export function LagraPage() {
  const enabled = useAppState((s) => s.state.lagra.enabled);
  const tokenSet = useAppState((s) => isSecretSet(s.state.lagra.token));
  const url = useAppState((s) => httpUrlOrNull(s.state.lagra.url));

  return (
    <div className="r-page">
      <PageHeader
        title="lagra"
        description="Anbindung an lagra einrichten und den Zustand von Server, DAM und Aufgaben prüfen."
        actions={
          url ? (
            <LinkButton href={url} target="_blank" rel="noopener noreferrer" icon={ExternalLink}>
              lagra öffnen
            </LinkButton>
          ) : undefined
        }
      />

      <LagraConnectionCard />

      {!enabled ? (
        <EmptyState
          icon={Boxes}
          title="lagra ist ausgeschaltet"
          description="«lagra verwenden» einschalten, um hier die Übersicht und die Aufgaben von lagra zu sehen."
        />
      ) : !tokenSet ? (
        <EmptyState
          icon={KeyRound}
          title="Token fehlt"
          description="Ohne API-Token kann der Kiosk lagra nicht abfragen. Das Token oben unter «Verbindung» eintragen."
        />
      ) : (
        <>
          <LagraOverview />
          <LagraJobsCard />
        </>
      )}
    </div>
  );
}
