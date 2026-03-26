/**
 * WidgetWrapper – Wraps every widget with a consistent shell:
 * header bar, drag handle, remove button, error boundary.
 */
import React from 'react';
import { X, GripHorizontal } from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import '../styles/widgets.css';

interface Props {
  instanceId: string;
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
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

export const WidgetWrapper: React.FC<Props> = ({ instanceId, title, icon, children }) => {
  const { editMode, removeWidget } = useLayoutStore();

  return (
    <div className={`widget-container ${editMode ? 'edit-mode' : ''}`}>
      <div className="widget-header">
        <div className="widget-header-title">
          <GripHorizontal size={14} />
          {icon}
          {title}
        </div>
        <div className="widget-header-actions">
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
