import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { useAppState } from '../../state/appState';
import { dismissToast, runToastAction, showToast, useToastStore } from './toast';
import { useTopModalDialog } from './topLayer';

const ICONS = { success: CircleCheck, info: Info, warning: TriangleAlert, error: CircleAlert } as const;

/**
 * Renders the toast stack. Also turns useAppState's errors (failed writes,
 * lost connection) into error toasts once the state is loaded – before
 * that the loading screen shows them.
 *
 * While a modal dialog is open the stack renders inside it: the dialog sits
 * in the browser's top layer above any z-index and makes the page inert, so
 * a toast outside it (e.g. the error of a failed save in an editor sheet)
 * would be hidden and unreachable.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const ready = useAppState((s) => s.ready);
  const error = useAppState((s) => s.error);
  const dialog = useTopModalDialog();

  useEffect(() => {
    if (!ready || error === null) return;
    const { unauthorized, clearError } = useAppState.getState();
    // An expired session switches to the login page instead.
    if (!unauthorized) showToast('error', error);
    clearError();
  }, [ready, error]);

  const stack = (
    <div className={`r-toasts${dialog ? ' is-in-dialog' : ''}`} aria-live="polite" aria-relevant="additions">
      {toasts.map((item) => {
        const Icon = ICONS[item.kind];
        return (
          <div key={item.id} className={`r-toast r-toast-${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'}>
            <Icon className="r-toast-icon" size={18} aria-hidden="true" />
            <span className="r-toast-text">{item.message}</span>
            {item.action && (
              <button type="button" className="r-toast-action" onClick={() => runToastAction(item.id)}>
                {item.action.label}
              </button>
            )}
            <button type="button" className="r-toast-close" onClick={() => dismissToast(item.id)} aria-label="Meldung schliessen">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
  return dialog ? createPortal(stack, dialog) : stack;
}
