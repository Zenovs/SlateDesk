/**
 * Mail settings (state.mail) for the Host-Monitor's outage mails, the test
 * mail (POST /api/mail-test) and the last delivery (GET /api/mail-status).
 * The password is a secret: the kiosk never sends it back, and it clears it
 * when the server changes over HTTP.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mail, MailX, Send } from 'lucide-react';
import { SettingsForm } from '../../../components/settings/SettingsForm';
import { useAppState } from '../../../state/appState';
import { isAbortError } from '../../../state/transport';
import type { SettingsField } from '../../../types/settings';
import { errorText, mailStatus, mailTest, type MailStatus, type MailTestResult } from '../../api';
import { formatDayTime, formatTime, plural } from '../../format';
import { useNow } from '../../hooks/useNow';
import { isSecretSet, secretsClearedBy } from '../../secrets';
import { Button, Card, Notice, StatusDot, toast, type StatusTone } from '../../ui';

const STATUS_POLL_MS = 30_000;

const SCHEMA: SettingsField[] = [
  {
    type: 'boolean',
    key: 'enabled',
    label: 'Mails senden',
    description: 'Host-Monitor-Widgets mit «Mail senden» melden jeden Ausfall – und wenn der Host wieder antwortet.',
  },
  {
    type: 'text',
    key: 'to',
    label: 'Empfänger',
    placeholder: 'name@beispiel.ch',
    description: 'Mehrere Adressen mit Komma trennen.',
  },
  { type: 'section', label: 'Postausgangsserver (SMTP)' },
  {
    type: 'text',
    key: 'host',
    label: 'Server',
    placeholder: 'z. B. asmtp.mail.hostpoint.ch',
    description:
      'Postausgangsserver (SMTP) des Postfachs, das die Mails verschickt – bei Hostpoint asmtp.mail.hostpoint.ch. Es muss nicht das Postfach des Empfängers sein.',
  },
  {
    type: 'number',
    key: 'port',
    label: 'Port',
    min: 1,
    max: 65535,
    step: 1,
    description: '587 (STARTTLS) oder 465 (SSL/TLS).',
  },
  { type: 'text', key: 'user', label: 'Benutzer', placeholder: 'Mail-Adresse des Postfachs' },
  { type: 'secret', key: 'password', label: 'Passwort', placeholder: 'Passwort des Postfachs' },
  {
    type: 'text',
    key: 'from',
    label: 'Absender',
    placeholder: 'Leer = Benutzer',
    description: 'Muss der Server für dieses Postfach erlauben – meist die Adresse des Postfachs selbst.',
  },
];

interface TestState {
  busy: boolean;
  result: MailTestResult | null;
  error: string | null;
  at: number | null;
}

function TestResult({ test }: { test: TestState }) {
  if (test.at === null) return null;
  const when = `Geprüft um ${formatTime(test.at, true)}.`;
  if (test.error !== null || !test.result) {
    return (
      <Notice tone="error" title="Test fehlgeschlagen">
        {test.error ?? 'Keine Antwort'} {when}
      </Notice>
    );
  }
  return (
    <Notice tone={test.result.ok ? 'success' : 'error'} title={test.result.ok ? 'Test-Mail gesendet' : 'Test-Mail nicht gesendet'}>
      {test.result.message}. {when}
    </Notice>
  );
}

function DeliveryStatus({ status }: { status: MailStatus | null }) {
  const now = useNow(STATUS_POLL_MS);
  if (!status || (status.last === null && status.pending === 0)) return null;
  const { last, pending } = status;
  const waiting = pending > 0 ? ` ${plural(pending, 'Mail wartet', 'Mails warten')} auf den nächsten Versuch.` : '';
  if (last === null) return <Notice tone="info">{waiting.trim()}</Notice>;
  const when = formatDayTime(last.at, now);
  return last.ok ? (
    <Notice tone="info" title="Letzte Ausfall-Mail">
      «{last.subject}» gesendet {when}.{waiting}
    </Notice>
  ) : (
    <Notice tone="warning" title="Letzte Ausfall-Mail nicht gesendet">
      «{last.subject}» ({when}): {last.error ?? 'unbekannter Fehler'}.{waiting}
    </Notice>
  );
}

export function MailCard() {
  const mail = useAppState((s) => s.state.mail);
  const values = useMemo<Record<string, unknown>>(() => ({ ...mail }), [mail]);
  const [test, setTest] = useState<TestState>({ busy: false, result: null, error: null, at: null });
  const [status, setStatus] = useState<MailStatus | null>(null);
  /** The test uses the stored settings – it waits for the last save. */
  const lastWrite = useRef<Promise<boolean>>(Promise.resolve(true));
  const testRun = useRef<AbortController | null>(null);

  useEffect(() => () => testRun.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      mailStatus(controller.signal).then(setStatus, (err: unknown) => {
        if (!isAbortError(err)) setStatus(null);
      });
    void load();
    const timer = setInterval(() => void load(), STATUS_POLL_MS);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);

  const onChange = useCallback((patch: Record<string, unknown>) => {
    const clean = { ...patch };
    for (const key of ['host', 'user', 'from', 'to']) {
      const value = clean[key];
      if (typeof value === 'string') clean[key] = value.trim();
    }
    if (typeof clean.host === 'string' && !/^[A-Za-z0-9.-]*$/.test(clean.host)) {
      toast.error('Ungültiger Server – nur den Namen eingeben, z. B. asmtp.mail.hostpoint.ch');
      delete clean.host;
    }
    const { apply, state } = useAppState.getState();
    const current: Record<string, unknown> = { ...state.mail };
    const changed = Object.keys(clean).filter((key) => current[key] !== clean[key]);
    if (changed.length === 0) return;

    const cleared = secretsClearedBy(SCHEMA, current, clean);
    const write = apply([{ op: 'merge', path: ['mail'], value: clean }]);
    lastWrite.current = write;
    void write.then((ok) => {
      if (!ok) return;
      if (cleared.length > 0) {
        toast.warning('Server geändert – das Passwort wurde aus Sicherheitsgründen gelöscht. Bitte neu eingeben.');
      } else if (changed.includes('password')) {
        toast.success(clean.password ? 'Passwort gespeichert' : 'Passwort entfernt');
      } else if (changed.includes('enabled')) {
        toast.success(clean.enabled ? 'Mail-Versand eingeschaltet' : 'Mail-Versand ausgeschaltet');
      } else {
        toast.success('Gespeichert');
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
      const result = await mailTest(controller.signal);
      if (!controller.signal.aborted) setTest({ busy: false, result, error: null, at: Date.now() });
    } catch (err) {
      if (controller.signal.aborted || isAbortError(err)) return;
      setTest({ busy: false, result: null, error: errorText(err), at: Date.now() });
    }
  };

  const complete = mail.host !== '' && mail.to !== '' && (mail.user === '' || isSecretSet(mail.password));
  const tone: StatusTone = !mail.enabled ? 'idle' : complete ? 'ok' : 'warn';
  const label = !mail.enabled ? 'Ausgeschaltet' : complete ? 'Eingerichtet' : 'Unvollständig';

  return (
    <Card
      title="Mail-Versand"
      icon={mail.enabled ? Mail : MailX}
      subtitle="Für Ausfall-Mails des Host-Monitors."
      actions={
        <span className={`r-pill r-pill-${tone}`}>
          <StatusDot tone={tone} />
          {label}
        </span>
      }
    >
      <div className="r-settings">
        <SettingsForm schema={SCHEMA} values={values} onChange={onChange} context="remote" />
      </div>
      <Notice tone="info" title="Passwort">
        Das Passwort bleibt auf dem Kiosk und wird nie an den Browser zurückgeschickt. Wird der Server geändert, löscht
        der Kiosk es aus Sicherheitsgründen – deshalb zuerst den Server eintragen und danach das Passwort.
      </Notice>
      <div className="r-form-actions">
        <Button icon={Send} busy={test.busy} onClick={() => void runTest()}>
          Test-Mail senden
        </Button>
      </div>
      <div aria-live="polite">
        <TestResult test={test} />
      </div>
      <DeliveryStatus status={status} />
    </Card>
  );
}
