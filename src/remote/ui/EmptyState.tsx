import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** E.g. a Button that creates the first entry. */
  action?: ReactNode;
  /** Less padding, for use inside cards. */
  compact?: boolean;
}

/** Centered placeholder for «nothing here yet» (icon, title, text, optional action). */
export function EmptyState({ icon: Icon, title, description, action, compact = false }: EmptyStateProps) {
  return (
    <div className={`r-empty${compact ? ' r-empty-compact' : ''}`}>
      {Icon && (
        <span className="r-empty-icon" aria-hidden="true">
          <Icon size={compact ? 22 : 28} />
        </span>
      )}
      <p className="r-empty-title">{title}</p>
      {description !== undefined && <p className="r-empty-description">{description}</p>}
      {action !== undefined && <div className="r-empty-action">{action}</div>}
    </div>
  );
}
