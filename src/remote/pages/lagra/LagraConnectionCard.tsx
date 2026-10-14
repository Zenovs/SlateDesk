/**
 * lagra connection settings (state.lagra: enabled, url, token) and the
 * connection test (GET /api/lagra-test). The token is a secret: the kiosk
 * never sends it back, and it clears it when the address changes over HTTP.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlugZap, Unplug } from 'lucide-react';
import { SettingsForm } from '../../../components/settings/SettingsForm';
import { useAppState } from '../../../state/appState';
import { DEFAULT_LAGRA_URL } from '../../../state/defaults';
import { isAbortError } from '../../../state/transport';
import type { SettingsField } from '../../../types/settings';
import { errorText, lagraTest, type LagraTestResult } from '../../api';
import { formatTime } from '../../format';
import { isSecretSet, secretsClearedBy } from '../../secrets';
import { Button, Card, Notice, StatusDot, toast, type StatusTone } from '../../ui';
import { httpUrlOrNull } from '../../url';

const SCHEMA: SettingsField[] = [
  {
    type: 'boolean',
    key: 'enabled',
    label: 'lagra verwenden',
    description: 'Schaltet die lagra-Widgets am Kiosk und die Übersicht auf dieser Seite ein.',
  },
  {
    type: 'url',
    key: 'url',
    label: 'Adresse',
    placeholder: DEFAULT_LAGRA_URL,
    description: 'Basisadresse von lagra. Leer lassen für die Standardadresse.',
  },
  {
    type: 'secret',
    key: 'token',
    label: 'API-Token',
    placeholder: 'Token aus lagra einfügen',
  },
];

interface TestState {
  busy: boolean;
  result: LagraTestResult | null;
  error: string | null;
  at: number | null;
}

/** « (HTTP 200)» – unless the message names the status already («Token ungültig (401)», «Fehler 500 – …»). */
function statusSuffix(message: string, status: number): string {
  if (status <= 0 || new RegExp(`\\b${status}\\b`).test(message)) return '';
  return ` (HTTP ${status})`;
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
  const status = statusSuffix(result.message, result.status);
  if (!result.ok) {
    return (
      <Notice tone="error" title="Keine Verbindung zu lagra">
        {result.message}
        {status}. {when}
      </Notice>
    );
  }
  if (!result.uebersicht) {
    return (
      <Notice tone="warning" title="lagra-Update nötig: Endpunkt /api/v1/uebersicht fehlt">
        Verbindung und Token funktionieren{status}, aber diese lagra-Version kennt die Übersicht für SlateDesk noch nicht –
        die lagra-Widgets brauchen das Update. {when}
      </Notice>
    );
  }
  return (
    <Notice tone="success" title="Verbindung hergestellt">
      {result.message}
      {status}. {when}
    </Notice>
  );
}

export function LagraConnectionCard() {
  const lagra = useAppState((s) => s.state.lagra);
  const values = useMemo<Record<string, unknown>>(() => ({ ...lagra }), [lagra]);
  const tokenSet = isSecretSet(lagra.token);
  const [test, setTest] = useState<TestState>({ busy: false, result: null, error: null, at: null });
  /** The test uses the stored settings – it waits for the last save. */
  const lastWrite = useRef<Promise<boolean>>(Promise.resolve(true));
  const testRun = useRef<AbortController | null>(null);

  useEffect(() => () => testRun.current?.abort(), []);

  const onChange = useCallback((patch: Record<string, unknown>) => {
    const clean = { ...patch };
    if (typeof clean.url === 'string') {
      const text = clean.url.trim();
      const url = text === '' ? DEFAULT_LAGRA_URL : httpUrlOrNull(text);
      if (url === null) {
        toast.error('Ungültige Adresse – bitte vollständig mit https:// eingeben');
        delete clean.url;
      } else {
        clean.url = url;
      }
    }
    const { apply, state } = useAppState.getState();
    const current: Record<string, unknown> = { ...state.lagra };
    const changed = Object.keys(clean).filter((key) => current[key] !== clean[key]);
    if (changed.length === 0) return;

    const cleared = secretsClearedBy(SCHEMA, current, clean);
    const write = apply([{ op: 'merge', path: ['lagra'], value: clean }]);
    lastWrite.current = write;
    void write.then((ok) => {
      if (!ok) return;
      if (cleared.length > 0) {
        toast.warning('Adresse geändert – das API-Token wurde aus Sicherheitsgründen gelöscht. Bitte neu eingeben.');
      } else if (changed.includes('token')) {
        toast.success(clean.token ? 'Token gespeichert' : 'Token entfernt');
      } else if (changed.includes('enabled')) {
        toast.success(clean.enabled ? 'lagra eingeschaltet' : 'lagra ausgeschaltet');
      } else if (changed.includes('url')) {
        toast.success('Adresse gespeichert');
      }
    });
  }, []);

  const runTest = async () => {
    testRun.current?.abort();
    const controller = new AbortController();
    testRun.current = controller;
    setTest((current) => ({ ...current, busy: true }));
    try {
      await lastWrite.current;
      const result = await lagraTest(controller.signal);
      if (!controller.signal.aborted) setTest({ busy: false, result, error: null, at: Date.now() });
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setTest({ busy: false, result: null, error: errorText(err), at: Date.now() });
    }
  };

  const tone: StatusTone = !lagra.enabled ? 'idle' : tokenSet ? 'ok' : 'warn';
  const status = !lagra.enabled ? 'Ausgeschaltet' : tokenSet ? 'Eingerichtet' : 'Token fehlt';
  const pageUrl = httpUrlOrNull(lagra.url);

  return (
    <Card
      title="Verbindung"
      icon={lagra.enabled ? PlugZap : Unplug}
      subtitle="Gilt für die lagra-Widgets am Kiosk und für diese Seite."
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
      <Notice tone="info" title="API-Token">
        Das Token wird in lagra unter{' '}
        {pageUrl ? (
          <a href={`${pageUrl}/schnittstellen`} target="_blank" rel="noopener noreferrer">
            /schnittstellen
          </a>
        ) : (
          '/schnittstellen'
        )}{' '}
        mit dem Namen «slatedesk» erstellt. Wird die Adresse geändert, löscht der Kiosk das gespeicherte Token aus
        Sicherheitsgründen – deshalb zuerst die Adresse anpassen und danach das Token eintragen.
      </Notice>
      <div className="r-form-actions">
        <Button icon={PlugZap} busy={test.busy} onClick={() => void runTest()}>
          Verbindung testen
        </Button>
      </div>
      <div aria-live="polite">
        <TestResult test={test} />
      </div>
    </Card>
  );
}
