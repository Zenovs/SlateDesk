import { afterEach, describe, expect, it, vi } from 'vitest';
import { runToastAction, toast, useToastStore } from './toast';

afterEach(() => {
  vi.useRealTimers();
  useToastStore.setState({ toasts: [] });
});

describe('toast actions', () => {
  it('runs the action once and closes the toast', () => {
    const run = vi.fn();
    const id = toast.success('Raster umgestellt', { action: { label: 'Rückgängig', run } });
    runToastAction(id);
    runToastAction(id);
    expect(run).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('keeps one toast per text and takes the newest action', () => {
    const first = vi.fn();
    const second = vi.fn();
    const id = toast.info('Widget verschoben', { action: { label: 'Rückgängig', run: first } });
    expect(toast.info('Widget verschoben', { action: { label: 'Rückgängig', run: second } })).toBe(id);
    runToastAction(id);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('leaves a toast with an action up long enough to reach the button', () => {
    vi.useFakeTimers();
    toast.success('Ohne Aktion');
    toast.success('Mit Aktion', { action: { label: 'Rückgängig', run: () => {} } });
    vi.advanceTimersByTime(4_000);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['Mit Aktion']);
    vi.advanceTimersByTime(5_000);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
