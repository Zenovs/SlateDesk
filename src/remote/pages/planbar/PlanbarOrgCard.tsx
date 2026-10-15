/**
 * One planbar Unternehmen (`state.planbar.unternehmen.<id>`): name, API key
 * and its connection test. A key belongs to exactly one organisation in
 * planbar. Writes go to the Unternehmen's object path, so the kiosk can put
 * back the key it never sends (the web UI only sees «gesetzt»).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Building2, PlugZap, Trash2 } from 'lucide-react';
import { SettingsForm } from '../../../components/settings/SettingsForm';
import { orgDisplayName } from '../../../planbar/orgs';
import { useAppState } from '../../../state/appState';
import { MAX_PLANBAR_ORG_NAME } from '../../../state/defaults';
import { isAbortError } from '../../../state/transport';
import type { SettingsField } from '../../../types/settings';
import { errorText, planbarTest } from '../../api';
import { isSecretSet } from '../../secrets';
import { Button, Card, ConfirmButton, StatusDot, toast, type StatusTone } from '../../ui';
import { NO_TEST, type TestState } from './planbarText';
import { TestResultView } from './PlanbarTestResult';

const SCHEMA: SettingsField[] = [
  {
    type: 'text',
    key: 'name',
    label: 'Name',
    placeholder: 'z. B. wireon',
    description: 'So heisst das Unternehmen in den Widgets und in den Auswahllisten.',
  },
  {
    type: 'secret',
    key: 'apiKey',
    label: 'API-Schlüssel',
    placeholder: 'pk_live_… aus planbar einfügen',
    description: 'Der Schlüssel dieses Unternehmens – in planbar gehört jeder Schlüssel zu genau einem Unternehmen.',
  },
];

/** planbar keys look like `pk_live_<hex>` – anything else is most likely a copy mistake. */
const KEY_PATTERN = /^pk_[a-z]+_[0-9a-f]+$/i;

export interface PlanbarOrgCardProps {
  id: string;
  /** Just added: the name field gets the focus. */
  isNew?: boolean;
  /** The key of this Unternehmen changed – data shown with the old one is outdated. */
  onConnectionChange: () => void;
}

export function PlanbarOrgCard({ id, isNew = false, onConnectionChange }: PlanbarOrgCardProps) {
  const org = useAppState((s) => (Object.hasOwn(s.state.planbar.unternehmen, id) ? s.state.planbar.unternehmen[id] : null));
  const values = useMemo<Record<string, unknown>>(() => ({ name: org?.name ?? '', apiKey: org?.apiKey ?? '' }), [org]);
  const keySet = isSecretSet(org?.apiKey);
  const [test, setTest] = useState<TestState>(NO_TEST);
  /** The test uses the stored key – it waits for the last save. */
  const lastWrite = useRef<Promise<boolean>>(Promise.resolve(true));
  const testRun = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => testRun.current?.abort(), []);

  useEffect(() => {
    if (isNew) boxRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [isNew]);

  const onChange = useCallback(
    (patch: Record<string, unknown>) => {
      const clean: Record<string, unknown> = {};
      if (typeof patch.name === 'string') clean.name = patch.name.trim().slice(0, MAX_PLANBAR_ORG_NAME);
      if (typeof patch.apiKey === 'string') {
        const key = patch.apiKey.trim();
        // Only blanks typed: keep the stored key (removing it is its own button).
        if (key !== '' || patch.apiKey === '') clean.apiKey = key;
      }
      const { apply, state } = useAppState.getState();
      const stored = Object.hasOwn(state.planbar.unternehmen, id) ? state.planbar.unternehmen[id] : null;
      if (!stored) return;
      const current: Record<string, unknown> = { ...stored };
      const changed = Object.keys(clean).filter((key) => current[key] !== clean[key]);
      if (changed.length === 0) return;

      // `create: false`: removed meanwhile (other device) – the edit must not bring it back half.
      const write = apply([{ op: 'merge', path: ['planbar', 'unternehmen', id], value: clean, create: false }]);
      lastWrite.current = write;
      void write.then((ok) => {
        if (!ok || !changed.includes('apiKey')) return;
        // A test of the old key would mislead.
        testRun.current?.abort();
        setTest(NO_TEST);
        onConnectionChange();
        const key = String(clean.apiKey);
        if (key === '') toast.success('API-Schlüssel entfernt');
        else if (KEY_PATTERN.test(key)) toast.success('API-Schlüssel gespeichert');
        else toast.warning('Gespeichert – das sieht aber nicht wie ein planbar-API-Schlüssel (pk_live_…) aus.');
      });
    },
    [id, onConnectionChange],
  );

  const runTest = async () => {
    testRun.current?.abort();
    const controller = new AbortController();
    testRun.current = controller;
    setTest((current) => ({ ...current, busy: true }));
    try {
      await lastWrite.current;
      const report = await planbarTest(id, controller.signal);
      const result = report.results.find((entry) => entry.org === id) ?? report.results[0] ?? null;
      if (controller.signal.aborted) return;
      if (result) setTest({ busy: false, result, error: null, at: Date.now() });
      else setTest({ busy: false, result: null, error: 'Der Kiosk hat kein Ergebnis geliefert.', at: Date.now() });
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setTest({ busy: false, result: null, error: errorText(err), at: Date.now() });
    }
  };

  const remove = async () => {
    const ok = await useAppState.getState().apply([{ op: 'delete', path: ['planbar', 'unternehmen', id] }]);
    if (!ok) throw new Error('Das Unternehmen konnte nicht entfernt werden');
    onConnectionChange();
    toast.success(`«${orgDisplayName(org?.name)}» entfernt`);
  };

  if (!org) return null;

  const name = orgDisplayName(org.name);
  const tone: StatusTone = keySet ? 'ok' : 'warn';

  return (
    <div ref={boxRef}>
      <Card
        title={org.name.trim() ? name : 'Neues Unternehmen'}
        icon={Building2}
        subtitle={keySet ? 'API-Schlüssel gespeichert' : 'Noch ohne API-Schlüssel – die Widgets fragen es erst mit Schlüssel ab.'}
        actions={
          <span className={`r-pill r-pill-${tone}`}>
            <StatusDot tone={tone} />
            {keySet ? 'Eingerichtet' : 'Schlüssel fehlt'}
          </span>
        }
      >
        <div className="r-settings">
          <SettingsForm schema={SCHEMA} values={values} onChange={onChange} context="remote" />
        </div>
        <div className="r-form-actions rp-org-actions">
          <Button icon={PlugZap} busy={test.busy} disabled={!keySet} onClick={() => void runTest()}>
            Verbindung testen
          </Button>
          <ConfirmButton
            variant="ghost"
            icon={Trash2}
            confirmTitle={`«${name}» entfernen?`}
            confirmMessage="Der API-Schlüssel wird gelöscht. Widgets, die nur dieses Unternehmen zeigen, melden danach «Unternehmen nicht eingerichtet»."
            confirmLabel="Entfernen"
            onConfirm={remove}
          >
            Entfernen
          </ConfirmButton>
        </div>
        <div className="rp-test" aria-live="polite">
          <TestResultView test={test} />
        </div>
      </Card>
    </div>
  );
}
