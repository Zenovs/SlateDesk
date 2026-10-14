/**
 * Small building blocks shared by widgets: centred state messages, banners,
 * status dots and meters. Colours come from theme tokens (parts.css).
 */
import type { ReactNode } from 'react';
import { LoaderCircle, type LucideIcon } from 'lucide-react';
import type { Tone } from './values';
import '../styles/parts.css';

interface MessageProps {
  icon?: LucideIcon;
  title: string;
  detail?: ReactNode;
  tone?: Tone;
  /** Shows a spinner instead of the icon. */
  busy?: boolean;
}

/** Fills the widget: empty, loading, setup and error states. */
export function WidgetMessage({ icon: Icon, title, detail, tone = 'neutral', busy = false }: MessageProps) {
  return (
    <div className={`wp-message wp-tone-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {busy ? (
        <LoaderCircle className="wp-message-icon wp-spin" aria-hidden="true" />
      ) : (
        Icon && <Icon className="wp-message-icon" aria-hidden="true" />
      )}
      <div className="wp-message-title">{title}</div>
      {detail && <div className="wp-message-detail">{detail}</div>}
    </div>
  );
}

interface BannerProps {
  tone: Tone;
  icon?: LucideIcon;
  children: ReactNode;
}

/** One-line hint above content, e.g. «nicht erreichbar seit 14:05». */
export function WidgetBanner({ tone, icon: Icon, children }: BannerProps) {
  return (
    <div className={`wp-banner wp-tone-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {Icon && <Icon className="wp-banner-icon" aria-hidden="true" />}
      <span className="wp-banner-text">{children}</span>
    </div>
  );
}

interface DotProps {
  tone: Tone;
  /** Pulses – something is running. */
  pulse?: boolean;
  label: string;
  size?: 'sm' | 'md' | 'lg';
}

export function StatusDot({ tone, pulse = false, label, size = 'md' }: DotProps) {
  return (
    <span
      className={`wp-dot wp-dot-${size} wp-tone-${tone}${pulse ? ' wp-dot-pulse' : ''}`}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

interface MeterProps {
  label: ReactNode;
  value: ReactNode;
  /** 0–100 */
  percent: number;
  tone?: Tone;
}

/** Label and value on one line, bar below. */
export function Meter({ label, value, percent, tone = 'accent' }: MeterProps) {
  const width = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  return (
    <div className={`wp-meter wp-tone-${tone}`}>
      <div className="wp-meter-head">
        <span className="wp-meter-label">{label}</span>
        <span className="wp-meter-value">{value}</span>
      </div>
      <div className="wp-meter-track" aria-hidden="true">
        <div className="wp-meter-fill" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

/** Inline spinner for «läuft». */
export function Spinner({ label }: { label: string }) {
  return <LoaderCircle className="wp-spin wp-spinner" role="img" aria-label={label} />;
}
