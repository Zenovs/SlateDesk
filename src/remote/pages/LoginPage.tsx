/**
 * Login with the kiosk PIN: large numeric keypad for touch, plus a hidden
 * password input so hardware keyboards and password managers work.
 */
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Delete, LayoutDashboard, LogIn } from 'lucide-react';
import { ThemeToggle } from '../components/ThemeControls';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { login, useSession } from '../session';
import { Notice, Spinner } from '../ui';

const MIN_PIN = 4;
const MAX_PIN = 12;
/** Dots shown before typing – the default PIN has 6 digits. */
const DOT_SLOTS = 6;
const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

const lockMessage = (seconds: number): string =>
  `Zu viele Versuche – bitte in ${seconds} ${seconds === 1 ? 'Sekunde' : 'Sekunden'} erneut versuchen`;

export function LoginPage() {
  const name = useSession((s) => s.name);
  const notice = useSession((s) => s.notice);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockSeconds, setLockSeconds] = useState(0);
  /** Bumped on every failure – restarts the shake animation. */
  const [failures, setFailures] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const finePointer = useMediaQuery('(pointer: fine)');

  const locked = lockSeconds > 0;
  const canSubmit = pin.length >= MIN_PIN && !busy && !locked;

  useEffect(() => {
    if (lockSeconds <= 0) return;
    const timer = setTimeout(() => setLockSeconds((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [lockSeconds]);

  // Keyboard users can type right away (also again after a failed attempt or
  // the lockout); on touch screens the keypad is enough – focusing would open
  // the on-screen keyboard over it.
  useEffect(() => {
    if (finePointer && !busy && !locked) inputRef.current?.focus();
  }, [finePointer, busy, locked]);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await login(pin);
    // Success switches to the app (or, above a kept app, to its reload) – this page unmounts.
    if (result.ok) return;
    setBusy(false);
    setPin('');
    setFailures((n) => n + 1);
    if (result.retryAfterSeconds !== null) {
      setLockSeconds(result.retryAfterSeconds);
    } else {
      setError(result.message);
    }
  };

  const append = (digit: string) => {
    if (busy || locked) return;
    setError(null);
    setPin((current) => (current + digit).slice(0, MAX_PIN));
  };

  const removeLast = () => {
    if (busy) return;
    setPin((current) => current.slice(0, -1));
  };

  // Keys typed while a keypad button has the focus.
  const handlers = useRef({ append, removeLast, submit });
  useLayoutEffect(() => {
    handlers.current = { append, removeLast, submit };
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target === inputRef.current || event.ctrlKey || event.metaKey || event.altKey) return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        handlers.current.append(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        handlers.current.removeLast();
      } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        void handlers.current.submit();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  const message = locked ? lockMessage(lockSeconds) : error;
  const slots = Math.max(DOT_SLOTS, pin.length);

  return (
    <div className="r-fullscreen r-login">
      <div className="r-fullscreen-corner">
        <ThemeToggle />
      </div>

      <form className="r-login-card" onSubmit={onSubmit} noValidate>
        <span className="r-status-icon" aria-hidden="true">
          <LayoutDashboard size={28} />
        </span>
        <h1 className="r-login-title">{name}</h1>
        <p className="r-login-subtitle">Fernsteuerung – PIN eingeben</p>

        {notice && <Notice tone="info">{notice}</Notice>}

        <label className="r-sr-only" htmlFor="r-pin">
          PIN
        </label>
        <input
          ref={inputRef}
          id="r-pin"
          name="pin"
          className="r-pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          maxLength={MAX_PIN}
          value={pin}
          disabled={busy || locked}
          onChange={(event) => {
            setError(null);
            setPin(event.target.value.replace(/\D/g, '').slice(0, MAX_PIN));
          }}
        />

        <div
          key={failures}
          className={`r-pin-dots${failures > 0 ? ' is-shaking' : ''}`}
          aria-hidden="true"
          onClick={() => inputRef.current?.focus()}
        >
          {Array.from({ length: slots }, (_, index) => (
            <span key={index} className={`r-pin-dot${index < pin.length ? ' is-filled' : ''}`} />
          ))}
        </div>

        <p className={`r-login-message${message ? ' is-error' : ''}`} role="alert">
          {message ?? ' '}
        </p>

        <div className="r-keypad" role="group" aria-label="Ziffernblock">
          {DIGITS.map((digit) => (
            <button key={digit} type="button" className="r-key" onClick={() => append(digit)} disabled={busy || locked}>
              {digit}
            </button>
          ))}
          <button
            type="button"
            className="r-key r-key-muted"
            onClick={removeLast}
            disabled={busy || pin.length === 0}
            aria-label="Letzte Ziffer löschen"
            title="Letzte Ziffer löschen"
          >
            <Delete size={24} aria-hidden="true" />
          </button>
          <button type="button" className="r-key" onClick={() => append('0')} disabled={busy || locked}>
            0
          </button>
          <button type="submit" className="r-key r-key-primary" disabled={!canSubmit} aria-label="Anmelden" title="Anmelden">
            {busy ? <Spinner size={24} label="Anmeldung läuft…" /> : <LogIn size={24} aria-hidden="true" />}
          </button>
        </div>

        <p className="r-login-hint">
          Den PIN zeigt der Kiosk in der oberen Leiste unter «Bearbeiten» → «Fernsteuerung» (sofern Bearbeiten am Kiosk
          erlaubt ist).
        </p>
      </form>
    </div>
  );
}
