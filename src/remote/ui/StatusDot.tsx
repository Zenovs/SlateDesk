export type StatusTone = 'ok' | 'warn' | 'error' | 'info' | 'idle';

export interface StatusDotProps {
  tone: StatusTone;
  /** Gentle pulse for «in progress» states (reconnecting, running). */
  pulse?: boolean;
  /** Screen-reader text; without it the dot is decorative. */
  label?: string;
}

/** Small coloured status dot (ok/warn/error/info/idle), optionally pulsing. */
export function StatusDot({ tone, pulse = false, label }: StatusDotProps) {
  return (
    <span
      className={`r-dot r-dot-${tone}${pulse ? ' is-pulsing' : ''}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
