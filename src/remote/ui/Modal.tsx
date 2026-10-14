import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { registerModalDialog } from './topLayer';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Buttons at the bottom (right-aligned, stacked on phones). */
  footer?: ReactNode;
  /** 'sheet' slides up from the bottom on phones (centered dialog on wide screens). */
  variant?: 'dialog' | 'sheet';
  size?: 'sm' | 'md' | 'lg';
  /** false: no close button, Escape and backdrop clicks are ignored (e.g. while saving). */
  dismissible?: boolean;
}

// Several modals may be open at once (confirm on top of a sheet).
let scrollLocks = 0;

function lockScroll(): () => void {
  scrollLocks += 1;
  document.documentElement.classList.add('r-scroll-locked');
  return () => {
    scrollLocks -= 1;
    if (scrollLocks === 0) document.documentElement.classList.remove('r-scroll-locked');
  };
}

function ModalDialog({
  onClose,
  title,
  description,
  children,
  footer,
  variant = 'dialog',
  size = 'md',
  dismissible = true,
}: Omit<ModalProps, 'open'>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const pressedOnBackdrop = useRef(false);
  /** False while the dialog is closed by unmounting (not by the browser). */
  const mounted = useRef(false);
  const latest = useRef({ onClose, dismissible });
  useLayoutEffect(() => {
    latest.current = { onClose, dismissible };
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    mounted.current = true;
    // showModal: focus trap, Escape handling and an inert page behind the dialog.
    if (!dialog.open) dialog.showModal();
    const unregister = registerModalDialog(dialog);
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const unlock = lockScroll();
    return () => {
      mounted.current = false;
      unlock();
      if (dialog.open) dialog.close();
      unregister();
    };
  }, []);

  const requestClose = () => {
    if (latest.current.dismissible) latest.current.onClose();
  };

  return (
    <dialog
      ref={ref}
      className={`r-modal r-modal-${variant} r-modal-${size}`}
      aria-labelledby={titleId}
      aria-describedby={description !== undefined ? descriptionId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      // Browsers may still close on a repeated Escape – keep the owner's state
      // in sync. (A late event from a re-shown dialog, e.g. StrictMode, is ignored.)
      onClose={() => {
        if (mounted.current && !ref.current?.open) latest.current.onClose();
      }}
      // Backdrop clicks hit the <dialog> itself; a press that started inside
      // (e.g. selecting text) and ended outside must not close it.
      onPointerDown={(event) => {
        pressedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && pressedOnBackdrop.current) requestClose();
        pressedOnBackdrop.current = false;
      }}
    >
      <div className="r-modal-panel">
        <header className="r-modal-header">
          <div className="r-modal-heading">
            <h2 className="r-modal-title" id={titleId}>
              {title}
            </h2>
            {description !== undefined && (
              <p className="r-modal-description" id={descriptionId}>
                {description}
              </p>
            )}
          </div>
          {dismissible && (
            <button type="button" className="r-btn r-btn-ghost r-btn-md r-btn-icon" onClick={requestClose} aria-label="Schliessen" title="Schliessen">
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </header>
        {children !== undefined && <div className="r-modal-body">{children}</div>}
        {footer !== undefined && <footer className="r-modal-footer">{footer}</footer>}
      </div>
    </dialog>
  );
}

/**
 * Modal dialog / bottom sheet on the native <dialog> (focus trap, Escape,
 * inert background). Content is mounted only while open, so its state
 * resets on every opening. Mark the element to focus with `data-autofocus`.
 */
export function Modal({ open, ...props }: ModalProps) {
  return open ? <ModalDialog {...props} /> : null;
}
