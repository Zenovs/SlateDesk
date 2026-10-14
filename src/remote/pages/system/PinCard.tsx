/** Change the PIN of the web UI (POST /api/auth/pin); other sessions end, this one stays. */
import { useId, useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { changePin, errorText } from '../../api';
import { Button, Card, Field, Notice } from '../../ui';

// New PINs: 6 to 12 digits (remote.rs MIN_PIN_LEN); an older 4- or 5-digit PIN still logs in.
const PIN_PATTERN = /^\d{6,12}$/;
const PIN_MAX = 12;

const digitsOnly = (value: string): string => value.replace(/\D/g, '').slice(0, PIN_MAX);

interface PinErrors {
  current?: string;
  next?: string;
  repeat?: string;
}

function validate(current: string, next: string, repeat: string): PinErrors {
  const errors: PinErrors = {};
  if (!current) errors.current = 'Bitte den aktuellen PIN eingeben';
  if (!PIN_PATTERN.test(next)) errors.next = 'Der neue PIN muss aus 6 bis 12 Ziffern bestehen';
  else if (next === current) errors.next = 'Der neue PIN muss sich vom aktuellen unterscheiden';
  if (repeat !== next) errors.repeat = 'Die beiden Eingaben stimmen nicht überein';
  return errors;
}

export function PinCard() {
  const id = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const errors = validate(current, next, repeat);
  const show = (message: string | undefined) => (submitted ? message : undefined);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    setOutcome(null);
    if (busy || Object.keys(errors).length > 0) return;
    setBusy(true);
    changePin(current, next).then(
      () => {
        setBusy(false);
        setSubmitted(false);
        setCurrent('');
        setNext('');
        setRepeat('');
        setOutcome({
          ok: true,
          text: 'Alle anderen Geräte wurden abgemeldet und müssen sich mit dem neuen PIN anmelden – dieser Browser bleibt angemeldet.',
        });
      },
      (err: unknown) => {
        setBusy(false);
        setOutcome({ ok: false, text: errorText(err) });
      },
    );
  };

  const input = (
    key: keyof PinErrors,
    label: string,
    value: string,
    onValue: (value: string) => void,
    autoComplete: string,
  ) => (
    <Field label={label} htmlFor={`${id}-${key}`} error={show(errors[key])}>
      <input
        id={`${id}-${key}`}
        className="settings-input"
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete={autoComplete}
        maxLength={PIN_MAX}
        value={value}
        aria-invalid={submitted && errors[key] ? true : undefined}
        onChange={(event) => {
          setOutcome(null);
          onValue(digitsOnly(event.target.value));
        }}
      />
    </Field>
  );

  return (
    <Card title="PIN ändern" icon={KeyRound} subtitle="PIN für die Anmeldung an der Fernsteuerung (6 bis 12 Ziffern).">
      <form className="r-settings r-form" onSubmit={submit} noValidate>
        <div className="r-form-grid r-form-grid-3">
          {input('current', 'Aktueller PIN', current, setCurrent, 'current-password')}
          {input('next', 'Neuer PIN', next, setNext, 'new-password')}
          {input('repeat', 'Neuer PIN wiederholen', repeat, setRepeat, 'new-password')}
        </div>
        <div aria-live="polite">
          {outcome && (
            <Notice tone={outcome.ok ? 'success' : 'error'} title={outcome.ok ? 'PIN geändert' : 'PIN nicht geändert'}>
              {outcome.text}
            </Notice>
          )}
        </div>
        <div className="r-form-actions">
          <Button type="submit" variant="primary" icon={KeyRound} busy={busy}>
            PIN ändern
          </Button>
        </div>
      </form>
    </Card>
  );
}
