import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';

export type NoticeTone = 'info' | 'success' | 'warning' | 'error';

export interface NoticeProps {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  /** Button/link on the right (or below on phones). */
  action?: ReactNode;
}

const ICONS = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const;

/** Inline callout box (info/success/warning/error) with icon, optional title and action. */
export function Notice({ tone = 'info', title, children, action }: NoticeProps) {
  const Icon = ICONS[tone];
  return (
    <div className={`r-notice r-notice-${tone}`} role={tone === 'error' ? 'alert' : 'note'}>
      <Icon className="r-notice-icon" size={18} aria-hidden="true" />
      <div className="r-notice-content">
        {title !== undefined && <p className="r-notice-title">{title}</p>}
        {children !== undefined && <div className="r-notice-text">{children}</div>}
      </div>
      {action !== undefined && <div className="r-notice-action">{action}</div>}
    </div>
  );
}
