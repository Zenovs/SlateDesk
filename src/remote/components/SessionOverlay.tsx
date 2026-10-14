/**
 * Full-screen layer above the kept app after the session ended (login, then
 * loading). A modal <dialog> in the top layer: it covers editor sheets that
 * are still open below it and makes the app inert until the state is back.
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { registerModalDialog } from '../ui/topLayer';

export function SessionOverlay({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);

  // Layout effect: open before the content's effects run, so the login's
  // input focus is not taken away again by showModal().
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    mounted.current = true;
    if (!dialog.open) dialog.showModal();
    const unregister = registerModalDialog(dialog);
    return () => {
      mounted.current = false;
      if (dialog.open) dialog.close();
      unregister();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="r-session-overlay"
      aria-label="Anmeldung"
      // Not dismissible: Escape does nothing, and a browser that closes it anyway gets it back.
      onCancel={(event) => event.preventDefault()}
      onClose={() => {
        if (mounted.current && ref.current && !ref.current.open) ref.current.showModal();
      }}
    >
      {children}
    </dialog>
  );
}
