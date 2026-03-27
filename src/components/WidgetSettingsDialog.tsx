/**
 * WidgetSettingsDialog – Enhanced modal dialog for widget settings.
 * Features: larger size, scrollable body, Save/Cancel footer, section support.
 */
import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  onSave?: () => void;
  title: string;
  children: React.ReactNode;
  /** If true, shows Save/Cancel footer. Default: false (children handle their own buttons) */
  showFooter?: boolean;
  /** Custom save button label */
  saveLabel?: string;
}

export const WidgetSettingsDialog: React.FC<Props> = ({
  open,
  onClose,
  onSave,
  title,
  children,
  showFooter = false,
  saveLabel = 'Speichern',
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  // Close on outside click
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  if (!open) return null;

  return (
    <div className="settings-dialog-backdrop" onClick={handleBackdropClick}>
      <div className="settings-dialog" ref={dialogRef}>
        <div className="settings-dialog-header">
          <h3 className="settings-dialog-title">{title}</h3>
          <button className="settings-dialog-close" onClick={onClose} title="Schließen">
            <X size={18} />
          </button>
        </div>
        <div className="settings-dialog-body">
          {children}
        </div>
        {showFooter && (
          <div className="settings-footer">
            <button className="settings-btn" onClick={onClose}>
              Abbrechen
            </button>
            <button
              className="settings-btn settings-btn-primary"
              onClick={() => {
                onSave?.();
                onClose();
              }}
            >
              {saveLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
