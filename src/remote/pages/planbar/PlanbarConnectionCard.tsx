/**
 * planbar connection settings (state.planbar: enabled, url, apiKey) and the
 * connection test (GET /api/planbar-test) with the rights of the key. The
 * key is a secret: the kiosk never sends it back, and it clears it when the
 * address changes over HTTP.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlugZap, Unplug } from 'lucide-react';
import { invalidateOptionProvider } from '../../../components/settings/optionProviders';
import { SettingsForm } from '../../../components/settings/SettingsForm';
import { PLANBAR_MEMBERS_PROVIDER, PLANBAR_PROJECTS_PROVIDER } from '../../../planbar/options';
import { useAppState } from '../../../state/appState';
import { DEFAULT_PLANBAR_URL } from '../../../state/defaults';
import { isAbortError } from '../../../state/transport';
import type { SettingsField } from '../../../types/settings';
import { errorText, planbarTest, type PlanbarTestResult } from '../../api';
import { formatTime, plural } from '../../format';
import { isSecretSet, secretsClearedBy } from '../../secrets';
import { Button, Card, Notice, StatusDot, toast, type StatusTone } from '../../ui';
import { httpUrlOrNull } from '../../url';
import { PLANBAR_KEY_PAGE, SCOPE_ROWS, scopeState } from './planbarText';

const SCHEMA: SettingsField[] = [
  {
    type: 'boolean',
    key: 'enabled',
    label: 'planbar verwenden',
    description: 'Schaltet die planbar-Widgets am Kiosk und die Vorschau auf dieser Seite ein.',
  },
  {
    type: 'url',
    key: 'url',
    label: 'Adresse',
    placeholder: DEFAULT_PLANBAR_URL,
    description: 'Adresse von planbar. Leer lassen für die Standardadresse.',
  },
  {
    type: 'secret',
    key: 'apiKey',
    label: 'API-Schlüssel',
    placeholder: 'pk_live_… aus planbar einfügen',
  },
];

/** planbar keys look like `pk_live_<hex>` – anything else is most likely a copy mistake. */
const KEY_PATTERN = /^pk_[a-z]+_[0-9a-f]+$/i;

interface TestState {
  busy: boolean;
  result: PlanbarTestResult | null;
  error: string | null;
  at: number | null;
}

const NO_TEST: TestState = { busy: false, result: null, error: null, at: null };

function membersText(members: number | null): string {
  return members === null
    ? 'Die Personenliste ist mit diesem Schlüssel nicht lesbar.'
    : `${plural(members, 'Person', 'Personen')} in der Organisation.`;
}

function TestResult({ test }: { test: TestState }) {
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
        Adresse und API-Schlüssel funktionieren, aber diese planbar-Version kennt die Endpunkte für SlateDesk noch nicht –
        die planbar-Widgets brauchen das Update. {when}
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

export interface PlanbarConnectionCardProps {
  /** Address or key saved – data shown with the old ones is outdated. */
  onConnectionChange: () => void;
}

export function PlanbarConnectionCard({ onConnectionChange }: PlanbarConnectionCardProps) {
  const planbar = useAppState((s) => s.state.planbar);
  const values = useMemo<Record<string, unknown>>(() => ({ ...planbar }), [planbar]);
  const keySet = isSecretSet(planbar.apiKey);
  const [test, setTest] = useState<TestState>(NO_TEST);
  /** The test uses the stored settings – it waits for the last save. */
  const lastWrite = useRef<Promise<boolean>>(Promise.resolve(true));
  const testRun = useRef<AbortController | null>(null);

  useEffect(() => () => testRun.current?.abort(), []);

  const onChange = useCallback(
    (patch: Record<string, unknown>) => {
      const clean = { ...patch };
      if (typeof clean.url === 'string') {
        const text = clean.url.trim();
        const url = text === '' ? DEFAULT_PLANBAR_URL : httpUrlOrNull(text);
        if (url === null) {
          toast.error('Ungültige Adresse – bitte vollständig mit https:// eingeben');
          delete clean.url;
        } else {
          clean.url = url;
        }
      }
      if (typeof clean.apiKey === 'string') {
        const key = clean.apiKey.trim();
        // Only blanks typed: keep the stored key (removing it is its own button).
        if (key === '' && clean.apiKey !== '') delete clean.apiKey;
        else clean.apiKey = key;
      }
      const { apply, state } = useAppState.getState();
      const current: Record<string, unknown> = { ...state.planbar };
      const changed = Object.keys(clean).filter((key) => current[key] !== clean[key]);
      if (changed.length === 0) return;

      const cleared = secretsClearedBy(SCHEMA, current, clean);
      const write = apply([{ op: 'merge', path: ['planbar'], value: clean }]);
      lastWrite.current = write;
      void write.then((ok) => {
        if (!ok) return;
        // The people and project pickers of the widgets load through this connection.
        invalidateOptionProvider(PLANBAR_MEMBERS_PROVIDER);
        invalidateOptionProvider(PLANBAR_PROJECTS_PROVIDER);
        if (changed.includes('url') || changed.includes('apiKey')) {
          // A test of the old connection would mislead.
          testRun.current?.abort();
          setTest(NO_TEST);
          onConnectionChange();
        }
        if (cleared.length > 0) {
          toast.warning('Adresse geändert – der API-Schlüssel wurde aus Sicherheitsgründen gelöscht. Bitte neu eingeben.');
        } else if (changed.includes('apiKey')) {
          const key = String(clean.apiKey);
          if (key === '') toast.success('API-Schlüssel entfernt');
          else if (KEY_PATTERN.test(key)) toast.success('API-Schlüssel gespeichert');
          else toast.warning('Gespeichert – das sieht aber nicht wie ein planbar-API-Schlüssel (pk_live_…) aus.');
        } else if (changed.includes('enabled')) {
          toast.success(clean.enabled ? 'planbar eingeschaltet' : 'planbar ausgeschaltet');
        } else if (changed.includes('url')) {
          toast.success('Adresse gespeichert');
        }
      });
    },
    [onConnectionChange],
  );

  const runTest = async () => {
    testRun.current?.abort();
    const controller = new AbortController();
    testRun.current = controller;
    setTest((current) => ({ ...current, busy: true }));
    try {
      await lastWrite.current;
      const result = await planbarTest(controller.signal);
      if (!controller.signal.aborted) setTest({ busy: false, result, error: null, at: Date.now() });
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setTest({ busy: false, result: null, error: errorText(err), at: Date.now() });
    }
  };

  const tone: StatusTone = !planbar.enabled ? 'idle' : keySet ? 'ok' : 'warn';
  const status = !planbar.enabled ? 'Ausgeschaltet' : keySet ? 'Eingerichtet' : 'Schlüssel fehlt';
  const pageUrl = httpUrlOrNull(planbar.url);

  return (
    <Card
      title="Verbindung"
      icon={planbar.enabled ? PlugZap : Unplug}
      subtitle="Gilt für die planbar-Widgets am Kiosk und für diese Seite."
      actions={
        <span className={`r-pill r-pill-${tone}`}>
          <StatusDot tone={tone} />
          {status}
        </span>
      }
    >
      <div className="r-settings">
        <SettingsForm schema={SCHEMA} values={values} onChange={onChange} context="remote" />
      </div>
      <Notice tone="info" title="API-Schlüssel">
        Den Schlüssel erstellt ein Admin Unternehmen in planbar unter Unternehmen → API-Schlüssel (
        {pageUrl ? (
          <a href={`${pageUrl}${PLANBAR_KEY_PAGE}`} target="_blank" rel="noopener noreferrer">
            {PLANBAR_KEY_PAGE}
          </a>
        ) : (
          PLANBAR_KEY_PAGE
        )}
        ) → «Schlüssel erstellen», Name z. B. «SlateDesk». Rechte: Aufgaben & Zeiten – Lesen (Schreiben, wenn Aufgaben am
        Kiosk abgehakt werden sollen), Projekte – Lesen, News – Lesen. planbar zeigt den Schlüssel nur einmal an. Wird die
        Adresse geändert, löscht der Kiosk den gespeicherten Schlüssel aus Sicherheitsgründen – deshalb zuerst die Adresse
        anpassen und danach den Schlüssel eintragen.
      </Notice>
      <div className="r-form-actions">
        <Button icon={PlugZap} busy={test.busy} onClick={() => void runTest()}>
          Verbindung testen
        </Button>
      </div>
      <div className="rp-test" aria-live="polite">
        <TestResult test={test} />
      </div>
    </Card>
  );
}
