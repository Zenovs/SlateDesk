import { useState, type ReactNode } from 'react';
import { Button, type ButtonProps } from './Button';
import { Modal } from './Modal';
import { toast } from './toast';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' for destructive actions (red confirm button). */
  tone?: 'danger' | 'primary';
  /** Confirm is running – buttons disabled, dialog can't be dismissed. */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Controlled yes/no dialog; «Abbrechen» has the initial focus so Enter never destroys anything. */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Bestätigen',
  cancelLabel = 'Abbrechen',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} data-autofocus>
            {cancelLabel}
          </Button>
          <Button variant={tone} onClick={onConfirm} busy={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message !== undefined && <div className="r-confirm-message">{message}</div>}
    </Modal>
  );
}

export interface ConfirmButtonProps extends Omit<ButtonProps, 'onClick' | 'busy'> {
  confirmTitle: ReactNode;
  confirmMessage?: ReactNode;
  /** Defaults to the button text. */
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  /** A returned promise keeps the dialog open (busy) until it settles; rejections are toasted. */
  onConfirm: () => unknown;
}

/** Button that asks for confirmation in a ConfirmDialog before running `onConfirm`. */
export function ConfirmButton({
  confirmTitle,
  confirmMessage,
  confirmLabel,
  tone = 'danger',
  onConfirm,
  children,
  ...buttonProps
}: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = () => {
    const result = onConfirm();
    if (!(result instanceof Promise)) {
      setOpen(false);
      return;
    }
    setBusy(true);
    const close = () => {
      setBusy(false);
      setOpen(false);
    };
    result.then(close, (err: unknown) => {
      toast.error(err);
      close();
    });
  };

  return (
    <>
      <Button {...buttonProps} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <ConfirmDialog
        open={open}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={confirmLabel ?? (typeof children === 'string' ? children : 'Bestätigen')}
        tone={tone}
        busy={busy}
        onConfirm={confirm}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}
