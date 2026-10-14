export type ProgressTone = 'accent' | 'ok' | 'warn' | 'error' | 'auto';

export interface ProgressBarProps {
  /** 0–100; ignored while `indeterminate`. */
  value: number;
  /** 'auto' turns warn at 75 % and error at 90 % (memory, disk). */
  tone?: ProgressTone;
  /** Accessible name, e.g. «Arbeitsspeicher». */
  label: string;
  indeterminate?: boolean;
}

const autoTone = (value: number): Exclude<ProgressTone, 'auto'> => (value >= 90 ? 'error' : value >= 75 ? 'warn' : 'ok');

/** Horizontal progress/usage bar (0–100) with tones and an indeterminate mode. */
export function ProgressBar({ value, tone = 'accent', label, indeterminate = false }: ProgressBarProps) {
  const clamped = Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
  const resolved = tone === 'auto' ? autoTone(clamped) : tone;
  return (
    <div
      className={`r-progress r-progress-${resolved}${indeterminate ? ' is-indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(clamped)}
    >
      <span className="r-progress-fill" style={indeterminate ? undefined : { width: `${clamped}%` }} />
    </div>
  );
}
