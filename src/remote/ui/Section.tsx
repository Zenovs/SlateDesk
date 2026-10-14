import type { ReactNode } from 'react';

export interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right of the title, e.g. an «Hinzufügen» button. */
  actions?: ReactNode;
  children?: ReactNode;
}

/** Titled group of content inside a page (h2 + description + actions), without a surface of its own. */
export function Section({ title, description, actions, children }: SectionProps) {
  return (
    <section className="r-section">
      <div className="r-section-head">
        <div className="r-section-heading">
          <h2 className="r-section-title">{title}</h2>
          {description !== undefined && <p className="r-section-description">{description}</p>}
        </div>
        {actions !== undefined && <div className="r-section-actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}
