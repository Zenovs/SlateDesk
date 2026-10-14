import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface CardProps {
  title?: ReactNode;
  /** Small line below the title. */
  subtitle?: ReactNode;
  icon?: LucideIcon;
  /** Right side of the header (buttons, status). */
  actions?: ReactNode;
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}

/** Surface with optional header (icon, title, subtitle, actions) and footer – the basic building block of every page. */
export function Card({ title, subtitle, icon: Icon, actions, footer, className, children }: CardProps) {
  const hasHeader = title !== undefined || actions !== undefined;
  return (
    <section className={`r-card${className ? ` ${className}` : ''}`}>
      {hasHeader && (
        <header className="r-card-header">
          {Icon && (
            <span className="r-card-icon" aria-hidden="true">
              <Icon size={18} />
            </span>
          )}
          <div className="r-card-heading">
            {title !== undefined && <h2 className="r-card-title">{title}</h2>}
            {subtitle !== undefined && <p className="r-card-subtitle">{subtitle}</p>}
          </div>
          {actions !== undefined && <div className="r-card-actions">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className="r-card-body">{children}</div>}
      {footer !== undefined && <footer className="r-card-footer">{footer}</footer>}
    </section>
  );
}
