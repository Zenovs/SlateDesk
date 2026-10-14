/**
 * Open modal <dialog>s, newest last. showModal() puts a dialog in the
 * browser's top layer – above every z-index – and makes the rest of the page
 * inert, so anything that must stay visible and clickable while a dialog is
 * open (the toast stack) renders into the topmost one.
 */
import { useSyncExternalStore } from 'react';

const dialogs: HTMLDialogElement[] = [];
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

/** Call right after showModal(); the returned function after close(). */
export function registerModalDialog(dialog: HTMLDialogElement): () => void {
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

const topDialog = (): HTMLDialogElement | null => dialogs[dialogs.length - 1] ?? null;

/** The topmost open modal dialog, or null. */
export function useTopModalDialog(): HTMLDialogElement | null {
  return useSyncExternalStore(subscribe, topDialog, () => null);
}
