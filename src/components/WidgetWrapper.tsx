/**
 * WidgetWrapper – Wraps every widget with a consistent shell:
 * header bar, drag handle, settings button, remove button, error boundary.
 * 
 * Settings button emits 'widget:openSettings:{instanceId}' on the eventBus.
 * Widgets with settings should listen for this event.
 */
import React, { useCallback } from 'react';
import { X, GripHorizontal, Settings } from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import { eventBus } from '../utils/eventBus';
import '../styles/widgets.css';

interface Props {
  instanceId: string;
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  /** Whether the widget has settings (shows gear icon) */
  hasSettings?: boolean;
}

class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export const WidgetWrapper: React.FC<Props> = ({
  instanceId,
  title,
  icon,
  children,
  hasSettings,
}) => {
  const { editMode, removeWidget } = useLayoutStore();

  const handleSettingsClick = useCallback(() => {
    eventBus.emit(`widget:openSettings:${instanceId}`);
  }, [instanceId]);

  return (
    <div className={`widget-container ${editMode ? 'edit-mode' : ''}`}>
      <div className="widget-header">
        <div className="widget-header-title">
          <GripHorizontal size={14} />
          {icon}
          {title}
        </div>
        <div className="widget-header-actions">
          {hasSettings && (
            <button
              className="widget-header-action"
              onClick={handleSettingsClick}
              title="Einstellungen"
            >
              <Settings size={14} />
            </button>
          )}
          {editMode && (
            <button
              className="widget-header-action"
              onClick={() => removeWidget(instanceId)}
              title="Widget entfernen"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
      <div className="widget-body">
        <ErrorBoundary fallback={<div className="widget-error">⚠️ Widget-Fehler</div>}>
          {children}
        </ErrorBoundary>
      </div>
    </div>
  );
};
