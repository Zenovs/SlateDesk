import { useId, type ReactNode } from 'react';

export interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}

/** On/off switch row (whole row is the touch target), styled like the SettingsForm toggles. */
export function Toggle({ checked, onChange, label, description, disabled = false }: ToggleProps) {
  const id = useId();
  return (
    <label className={`r-toggle${disabled ? ' is-disabled' : ''}`} htmlFor={id}>
      <span className="r-toggle-text">
        <span className="r-toggle-label">{label}</span>
        {description !== undefined && <span className="r-toggle-description">{description}</span>}
      </span>
      <span className="toggle-switch">
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-switch-slider" />
      </span>
    </label>
  );
}
