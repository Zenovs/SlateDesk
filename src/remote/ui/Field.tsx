import { useId, type ReactNode } from 'react';

export interface FieldProps {
  label: ReactNode;
  /** id of the input – the label becomes its <label for>. Without it the field is a labelled group (e.g. Segmented). */
  htmlFor?: string;
  /** Small text right of the label, e.g. «optional». */
  hint?: ReactNode;
  description?: ReactNode;
  /** Validation message below the control. */
  error?: ReactNode;
  children: ReactNode;
}

/**
 * Form row in the look of the SettingsForm fields (label, description,
 * control, error). Put forms inside `.r-settings` for touch-sized inputs.
 */
export function Field({ label, htmlFor, hint, description, error, children }: FieldProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const heading = (
    <>
      {label}
      {hint !== undefined && <span className="r-field-hint">{hint}</span>}
    </>
  );
  return (
    <div className="settings-field r-field">
      {htmlFor ? (
        <label className="settings-label" htmlFor={htmlFor} id={labelId}>
          {heading}
        </label>
      ) : (
        <div className="settings-label" id={labelId}>
          {heading}
        </div>
      )}
      {description !== undefined && <div className="settings-description">{description}</div>}
      {htmlFor ? (
        children
      ) : (
        <div role="group" aria-labelledby={labelId} className="r-field-group">
          {children}
        </div>
      )}
      {error ? (
        <div className="settings-field-error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
