import { LoaderCircle } from 'lucide-react';

export interface SpinnerProps {
  size?: number;
  /** Announced to screen readers. */
  label?: string;
}

/** Rotating loading indicator with a screen-reader label. */
export function Spinner({ size = 20, label = 'Wird geladen…' }: SpinnerProps) {
  return (
    <span className="r-spinner" role="status">
      <LoaderCircle className="r-spin" size={size} aria-hidden="true" />
      <span className="r-sr-only">{label}</span>
    </span>
  );
}

/** Spinner with a visible text, e.g. as the content of a card that is still loading. */
export function LoadingRow({ label }: { label: string }) {
  return (
    <div className="r-loading-row">
      <Spinner label={label} />
      <span aria-hidden="true">{label}</span>
    </div>
  );
}
