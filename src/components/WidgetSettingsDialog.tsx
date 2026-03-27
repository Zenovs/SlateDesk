/**
 * WidgetSettingsDialog – Generic modal dialog for widget settings.
 * Renders widget-specific settings content passed as children.
 */
import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export const WidgetSettingsDialog: React.FC<Props> = ({ open, onClose, title, children }) => {
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
      </div>
    </div>
  );
};
