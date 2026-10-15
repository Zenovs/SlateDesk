/**
 * The planbar Unternehmen: one card each (name, API key, test), adding and
 * removing. A planbar API key always belongs to exactly one organisation,
 * so every Unternehmen whose data SlateDesk shows needs its own key.
 */
import { useMemo, useState } from 'react';
import { Building2, Plus } from 'lucide-react';
import { useAppState } from '../../../state/appState';
import { uid } from '../../../utils/uid';
import { Button, EmptyState, Notice, Section } from '../../ui';
import { httpUrlOrNull } from '../../url';
import { PlanbarOrgCard } from './PlanbarOrgCard';
import { PLANBAR_KEY_PAGE } from './planbarText';

export interface PlanbarOrgsSectionProps {
  /** A key was added, changed or removed. */
  onConnectionChange: () => void;
}

export function PlanbarOrgsSection({ onConnectionChange }: PlanbarOrgsSectionProps) {
  // Ordered by id: the cards keep their place while a name is typed.
  const idList = useAppState((s) => Object.keys(s.state.planbar.unternehmen).sort().join('\n'));
  const ids = useMemo(() => (idList === '' ? [] : idList.split('\n')), [idList]);
  const pageUrl = useAppState((s) => httpUrlOrNull(s.state.planbar.url));
  const [added, setAdded] = useState<string | null>(null);

  const add = () => {
    const id = uid();
    void useAppState
      .getState()
      .apply([{ op: 'set', path: ['planbar', 'unternehmen', id], value: { name: '', apiKey: '' } }])
      .then((ok) => {
        if (ok) setAdded(id);
      });
  };

  const addButton = (
    <Button icon={Plus} variant={ids.length === 0 ? 'primary' : 'secondary'} onClick={add}>
      Unternehmen hinzufügen
    </Button>
  );

  return (
    <Section
      title="Unternehmen"
      description="Ein API-Schlüssel gehört in planbar zu genau einem Unternehmen. Für jedes Unternehmen, dessen Aufgaben, Projekte, News und Zeiten der Kiosk zeigen soll, hier einen Eintrag mit eigenem Schlüssel anlegen – die Widgets zeigen dann alle zusammen oder nur die gewählten."
      actions={ids.length > 0 ? addButton : undefined}
    >
      <Notice tone="info" title="API-Schlüssel erstellen">
        In planbar als Admin Unternehmen anmelden, zum gewünschten Unternehmen wechseln und unter Unternehmen →
        API-Schlüssel (
        {pageUrl ? (
          <a href={`${pageUrl}${PLANBAR_KEY_PAGE}`} target="_blank" rel="noopener noreferrer">
            {PLANBAR_KEY_PAGE}
          </a>
        ) : (
          PLANBAR_KEY_PAGE
        )}
        ) → «Schlüssel erstellen», Name z. B. «SlateDesk». Rechte: Aufgaben & Zeiten – Lesen (Schreiben, wenn Aufgaben am
        Kiosk abgehakt werden sollen), Projekte – Lesen, News – Lesen. planbar zeigt den Schlüssel nur einmal an. Für jedes
        weitere Unternehmen dasselbe in diesem Unternehmen wiederholen.
      </Notice>
      {ids.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="Noch kein Unternehmen"
          description="Ohne Unternehmen mit API-Schlüssel kann der Kiosk planbar nicht abfragen."
          action={addButton}
        />
      ) : (
        <div className="rp-orgs">
          {ids.map((id) => (
            <PlanbarOrgCard key={id} id={id} isNew={id === added} onConnectionChange={onConnectionChange} />
          ))}
        </div>
      )}
    </Section>
  );
}
