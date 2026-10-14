/**
 * Toast messages of the web UI. Call `toast.success(…)` etc. from anywhere;
 * <Toaster /> renders them (and also shows useAppState's write errors).
 */
import { create } from 'zustand';
import { errorText } from '../errors';

export type ToastKind = 'success' | 'info' | 'warning' | 'error';

/** Button in a toast, e.g. «Rückgängig». Clicking it runs `run` and closes the toast. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

const DURATION_MS: Record<ToastKind, number> = { success: 3500, info: 4500, warning: 8000, error: 8000 };
/** A toast with a button stays long enough to reach it. */
const ACTION_DURATION_MS = 8000;
const MAX_VISIBLE = 4;

export const useToastStore = create<{ toasts: ToastItem[] }>(() => ({ toasts: [] }));

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

function armTimer(item: ToastItem): void {
  clearTimer(item.id);
  const duration = item.action ? Math.max(ACTION_DURATION_MS, DURATION_MS[item.kind]) : DURATION_MS[item.kind];
  timers.set(
    item.id,
    setTimeout(() => dismissToast(item.id), duration),
  );
}

export function dismissToast(id: number): void {
  clearTimer(id);
  useToastStore.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Runs the toast's button action and closes the toast. */
export function runToastAction(id: number): void {
  const item = useToastStore.getState().toasts.find((t) => t.id === id);
  dismissToast(id);
  item?.action?.run();
}

/**
 * Shows a message; the same text again only restarts its timer (and takes
 * the new action, which belongs to the newer change). Returns the toast id.
 */
export function showToast(kind: ToastKind, message: string, options: ToastOptions = {}): number {
  const text = message.trim();
  if (!text) return -1;
  const { toasts } = useToastStore.getState();
  const existing = toasts.find((t) => t.kind === kind && t.message === text);
  if (existing) {
    const updated: ToastItem = { ...existing, action: options.action };
    useToastStore.setState({ toasts: toasts.map((t) => (t.id === existing.id ? updated : t)) });
    armTimer(updated);
    return existing.id;
  }
  const item: ToastItem = { id: nextId++, kind, message: text, action: options.action };
  const next = [...toasts, item];
  for (const old of next.slice(0, Math.max(0, next.length - MAX_VISIBLE))) clearTimer(old.id);
  useToastStore.setState({ toasts: next.slice(-MAX_VISIBLE) });
  armTimer(item);
  return item.id;
}

export const toast = {
  success: (message: string, options?: ToastOptions): number => showToast('success', message, options),
  info: (message: string, options?: ToastOptions): number => showToast('info', message, options),
  warning: (message: string, options?: ToastOptions): number => showToast('warning', message, options),
  /** Accepts the rejection itself (HttpError, Error, string). */
  error: (err: unknown): number => showToast('error', errorText(err)),
};

/**
 * Awaits `task` and toasts the outcome: `success` (text or built from the
 * result) or the German error. Resolves true on success.
 */
export async function toastResult<T>(task: Promise<T>, success: string | ((result: T) => string)): Promise<boolean> {
  try {
    const result = await task;
    toast.success(typeof success === 'function' ? success(result) : success);
    return true;
  } catch (err) {
    toast.error(err);
    return false;
  }
}
