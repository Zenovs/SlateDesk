/** Result of the planbar connection test of one Unternehmen: reachable, people, rights of the key. */
import { formatTime, plural } from '../../format';
import { Notice, StatusDot } from '../../ui';
import { SCOPE_ROWS, scopeState, type TestState } from './planbarText';

function membersText(members: number | null): string {
  return members === null
    ? 'Die Personenliste ist mit diesem Schlüssel nicht lesbar.'
    : `${plural(members, 'Person', 'Personen')} im Unternehmen.`;
}

export function TestResultView({ test }: { test: TestState }) {
  if (test.at === null) return null;
  const when = `Geprüft um ${formatTime(test.at, true)}.`;
  if (test.error !== null) {
    return (
      <Notice tone="error" title="Test fehlgeschlagen">
        {test.error} {when}
      </Notice>
    );
  }
  const result = test.result;
  if (!result) return null;
  if (!result.ok) {
    return (
      <Notice tone="error" title="Keine Verbindung zu planbar">
        {result.message}. {when}
      </Notice>
    );
  }
  if (!result.dashboard || !result.scopes) {
    return (
      <Notice tone="warning" title="planbar-Update nötig">
        Adresse und API-Schlüssel funktionieren{result.members !== null ? ` (${membersText(result.members)})` : ''}, aber
        diese planbar-Version kennt die Endpunkte für SlateDesk noch nicht – die planbar-Widgets brauchen das Update. {when}
      </Notice>
    );
  }
  const scopes = result.scopes;
  const missing = SCOPE_ROWS.some((row) => !row.optional && !scopes[row.key]);
  return (
    <>
      <Notice tone={missing ? 'warning' : 'success'} title={missing ? 'Verbunden – Rechte fehlen' : 'Verbindung hergestellt'}>
        {missing ? 'Die fehlenden Rechte in planbar unter Unternehmen → API-Schlüssel ergänzen. ' : ''}
        {membersText(result.members)} {when}
      </Notice>
      <ul className="rp-items" aria-label="Rechte des API-Schlüssels">
        {SCOPE_ROWS.map((row) => {
          const state = scopeState(row, scopes[row.key]);
          return (
            <li key={row.key} className="rp-item">
              <StatusDot tone={state.tone} />
              <div className="rp-item-main">
                <p className="rp-item-title">{row.label}</p>
                <p className="rp-item-meta">
                  {state.text} – {row.usage}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
