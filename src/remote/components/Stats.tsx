/** Value tiles and usage bars shared by Übersicht, System and lagra. */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { formatBytes } from '../format';
import { ProgressBar, type StatusTone } from '../ui';

export interface StatProps {
  icon?: LucideIcon;
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  /** Colours the value (warn/error); ok and info stay neutral. */
  tone?: StatusTone;
}

/** Labelled value tile; place several in a `.r-stats` grid. */
export function Stat({ icon: Icon, label, value, detail, tone }: StatProps) {
  return (
    <div className="r-stat">
      <span className="r-stat-label">
        {Icon && <Icon size={16} aria-hidden="true" />}
        {label}
      </span>
      <span className={`r-stat-value${tone ? ` r-tone-${tone}` : ''}`}>{value}</span>
      {detail !== undefined && <span className="r-stat-detail">{detail}</span>}
    </div>
  );
}

export interface UsageBarProps {
  label: string;
  used: number;
  total: number;
  /** Formats used/total (default: bytes). */
  format?: (value: number) => string;
}

/** «7.5 GB von 16 GB» with a bar that turns orange at 75 % and red at 90 %; nothing for an unknown total. */
export function UsageBar({ label, used, total, format = formatBytes }: UsageBarProps) {
  if (!(total > 0)) return null;
  const clamped = Math.min(total, Math.max(0, used));
  const percent = (clamped / total) * 100;
  return (
    <div className="r-usage">
      <div className="r-usage-head">
        <span className="r-usage-label">{label}</span>
        <span className="r-usage-value">
          {format(clamped)} von {format(total)}
        </span>
      </div>
      <ProgressBar value={percent} tone="auto" label={`${label}: ${Math.round(percent)} % belegt`} />
    </div>
  );
}
