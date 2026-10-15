import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompletionQueue, latestWaiting, UNDO_MS } from './completion';

const TASK = { id: 'a', title: 'Texte liefern', done: false };

/** Lets the queue's promise callbacks run. */
const settlePromises = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-13T08:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CompletionQueue', () => {
  it('tells planbar only after the undo window, then keeps the change until a newer list arrives', async () => {
    const send = vi.fn(() => Promise.resolve({}));
    const onSent = vi.fn();
    const queue = new CompletionQueue(send);
    queue.listen({ onSent });

    queue.toggle(TASK);
    expect(queue.getSnapshot().get('a')).toMatchObject({ completed: true, phase: 'waiting' });
    expect(latestWaiting(queue.getSnapshot())?.id).toBe('a');

    vi.advanceTimersByTime(UNDO_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledWith('a', true, undefined);
    expect(queue.getSnapshot().get('a')?.phase).toBe('sending');
    expect(latestWaiting(queue.getSnapshot())).toBeNull();

    await settlePromises();
    const sent = queue.getSnapshot().get('a');
    expect(sent).toMatchObject({ phase: 'sent', completed: true });
    expect(onSent).toHaveBeenCalledWith(sent);

    // A list requested before planbar confirmed does not contain the change yet.
    queue.settle((sent?.sentAt ?? 0) - 1);
    expect(queue.getSnapshot().has('a')).toBe(true);
    queue.settle((sent?.sentAt ?? 0) + 1);
    expect(queue.getSnapshot().has('a')).toBe(false);
  });

  it('takes a change back within the window without asking planbar', () => {
    const send = vi.fn(() => Promise.resolve({}));
    const queue = new CompletionQueue(send);

    queue.toggle(TASK);
    queue.undo('a');
    expect(queue.getSnapshot().size).toBe(0);

    // A second tap on the same row is an undo as well.
    queue.toggle(TASK);
    queue.toggle(TASK);
    expect(queue.getSnapshot().size).toBe(0);

    vi.advanceTimersByTime(UNDO_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });

  it('drops a change planbar refused and reports it', async () => {
    const error = new Error('Fehlende Berechtigung: aufgaben:write');
    const send = vi.fn(() => Promise.reject(error));
    const onFailed = vi.fn();
    const queue = new CompletionQueue(send);
    queue.listen({ onFailed });

    queue.toggle(TASK);
    vi.advanceTimersByTime(UNDO_MS);
    await settlePromises();

    expect(queue.getSnapshot().size).toBe(0);
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', completed: true }), error);
  });

  it('ignores taps while planbar is being asked', () => {
    const pending = deferred();
    const send = vi.fn(() => pending.promise);
    const queue = new CompletionQueue(send);

    queue.toggle(TASK);
    vi.advanceTimersByTime(UNDO_MS);
    queue.toggle(TASK);
    expect(queue.getSnapshot().get('a')?.phase).toBe('sending');
    vi.advanceTimersByTime(UNDO_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reopens a confirmed task and restores the confirmed state on undo or failure', async () => {
    const outcomes = [deferred(), deferred()];
    let call = 0;
    const send = vi.fn(() => outcomes[call++].promise);
    const queue = new CompletionQueue(send);

    queue.toggle(TASK);
    vi.advanceTimersByTime(UNDO_MS);
    outcomes[0].resolve({});
    await settlePromises();
    const sent = queue.getSnapshot().get('a');
    expect(sent?.phase).toBe('sent');

    // The list still says «open» – the tap reopens what is shown as done.
    queue.toggle(TASK);
    expect(queue.getSnapshot().get('a')).toMatchObject({ completed: false, phase: 'waiting', replaces: sent });
    queue.undo('a');
    expect(queue.getSnapshot().get('a')).toBe(sent);

    queue.toggle(TASK);
    vi.advanceTimersByTime(UNDO_MS);
    expect(send).toHaveBeenLastCalledWith('a', false, undefined);
    outcomes[1].reject(new Error('planbar nicht erreichbar'));
    await settlePromises();
    expect(queue.getSnapshot().get('a')).toBe(sent);
  });

  it('takes back every waiting change at once, but not one planbar is already asked about', async () => {
    const pending = deferred();
    const send = vi.fn(() => pending.promise);
    const queue = new CompletionQueue(send);

    queue.toggle(TASK);
    vi.advanceTimersByTime(UNDO_MS);
    expect(send).toHaveBeenCalledTimes(1);
    queue.toggle({ id: 'b', title: 'Korrektur lesen', done: false });
    queue.toggle({ id: 'c', title: 'Rechnung stellen', done: true });

    queue.undoAll();
    expect([...queue.getSnapshot().keys()]).toEqual(['a']);
    expect(latestWaiting(queue.getSnapshot())).toBeNull();

    vi.advanceTimersByTime(UNDO_MS);
    queue.flush();
    expect(send).toHaveBeenCalledTimes(1);
    pending.resolve({});
    await settlePromises();
    expect(queue.getSnapshot().get('a')?.phase).toBe('sent');
  });

  it('sends waiting changes at once when flushed (widget unmounts)', () => {
    const send = vi.fn(() => Promise.resolve({}));
    const queue = new CompletionQueue(send);

    queue.toggle(TASK);
    queue.toggle({ id: 'b', title: 'Korrektur lesen', done: true });
    queue.flush();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith('a', true, undefined);
    expect(send).toHaveBeenCalledWith('b', false, undefined);

    vi.advanceTimersByTime(UNDO_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('offers the most recent tap for «Rückgängig» and notifies subscribers', () => {
    const queue = new CompletionQueue(() => Promise.resolve({}));
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);

    queue.toggle(TASK);
    vi.advanceTimersByTime(1000);
    queue.toggle({ id: 'b', title: 'Korrektur lesen', done: false });
    expect(latestWaiting(queue.getSnapshot())?.id).toBe('b');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    queue.undo('b');
    expect(listener).toHaveBeenCalledTimes(2);
    expect(latestWaiting(queue.getSnapshot())?.id).toBe('a');
  });

  it('stops calling handlers once they were removed', async () => {
    const onSent = vi.fn();
    const queue = new CompletionQueue(() => Promise.resolve({}));
    const remove = queue.listen({ onSent });
    remove();

    queue.toggle(TASK);
    vi.advanceTimersByTime(UNDO_MS);
    await settlePromises();
    expect(queue.getSnapshot().get('a')?.phase).toBe('sent');
    expect(onSent).not.toHaveBeenCalled();
  });

  it('ticks off with the key of the task’s own Unternehmen', async () => {
    const send = vi.fn(() => Promise.resolve({}));
    const queue = new CompletionQueue(send);
    queue.toggle({ ...TASK, org: 'wireon' });
    queue.toggle({ id: 'b', title: 'Offerte', done: true, org: 'sw' });
    expect(queue.getSnapshot().get('a')?.org).toBe('wireon');
    vi.advanceTimersByTime(UNDO_MS);
    expect(send).toHaveBeenCalledWith('a', true, 'wireon');
    expect(send).toHaveBeenCalledWith('b', false, 'sw');
    await settlePromises();
  });
});
