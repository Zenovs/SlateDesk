/**
 * WidgetSettingsDialog – Modal-Dialog für Widget-Einstellungen.
 * Wird via React Portal direkt in document.body gerendert, damit
 * position:fixed korrekt funktioniert – unabhängig von CSS-Transforms
 * der übergeordneten Widget-Container (react-grid-layout).
 */
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  onSave?: () => void;
  title: string;
  children: React.ReactNode;
  showFooter?: boolean;
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
  // Escape-Taste schliesst Dialog
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const dialog = (
    <div
      className="settings-dialog-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="settings-dialog">
        <div className="settings-dialog-header">
          <h3 className="settings-dialog-title">{title}</h3>
          <button className="settings-dialog-close" onClick={onClose} title="Schliessen">
            <X size={18} />
          </button>
        </div>
        <div className="settings-dialog-body">
          {children}
        </div>
        {showFooter && (
          <div className="settings-footer">
            <button className="settings-btn" onClick={onClose}>Abbrechen</button>
            <button className="settings-btn settings-btn-primary" onClick={() => { onSave?.(); onClose(); }}>
              {saveLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  // Portal: Dialog wird in document.body gerendert – ausserhalb aller
  // CSS-Transform-Container → position:fixed zeigt immer auf den Viewport
  return createPortal(dialog, document.body);
};
