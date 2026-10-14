import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Back link above the title, e.g. `{ href: href('widgets'), label: 'Alle Widgets' }`. */
  back?: { href: string; label: string };
  actions?: ReactNode;
}

/** Page title (h1) with optional back link, description and actions – first element of every page. */
export function PageHeader({ title, description, back, actions }: PageHeaderProps) {
  return (
    <header className="r-page-header">
      {back && (
        <a className="r-back-link" href={back.href}>
          <ChevronLeft size={18} aria-hidden="true" />
          {back.label}
        </a>
      )}
      <div className="r-page-title-row">
        <div className="r-page-heading">
          <h1 className="r-page-title">{title}</h1>
          {description !== undefined && <p className="r-page-description">{description}</p>}
        </div>
        {actions !== undefined && <div className="r-page-actions">{actions}</div>}
      </div>
    </header>
  );
}
