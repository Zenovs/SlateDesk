/**
 * Open modal <dialog>s, newest last. showModal() puts a dialog in the
 * browser's top layer – above every z-index – and makes the rest of the page
 * inert, so anything that must stay visible and clickable while a dialog is
 * open (the toast stack) renders into the topmost one.
 */
import { useSyncExternalStore } from 'react';

const dialogs: HTMLDialogElement[] = [];
/** Dialogs registered with `holdsInput: false` (the login overlay). */
const withoutInput = new WeakSet<HTMLDialogElement>();
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

/**
 * Call right after showModal(); the returned function after close().
 * `holdsInput: false` marks a dialog whose input may be lost (the login
 * overlay) – see inputDialogOpen().
 */
export function registerModalDialog(dialog: HTMLDialogElement, { holdsInput = true } = {}): () => void {
  if (!holdsInput) withoutInput.add(dialog);
  dialogs.push(dialog);
  notify();
  return () => {
    const index = dialogs.lastIndexOf(dialog);
    if (index === -1) return;
    dialogs.splice(index, 1);
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while a modal dialog that may hold unsaved input (an editor) is open. */
export const inputDialogOpen = (): boolean => dialogs.some((dialog) => !withoutInput.has(dialog));

/** Calls `listener` whenever a modal dialog opens or closes; returns the unsubscribe function. */
export const onModalDialogsChange: (listener: () => void) => () => void = subscribe;

const topDialog = (): HTMLDialogElement | null => dialogs[dialogs.length - 1] ?? null;

/** The topmost open modal dialog, or null. */
export function useTopModalDialog(): HTMLDialogElement | null {
  return useSyncExternalStore(subscribe, topDialog, () => null);
}
