/**
 * Ticking off planbar tasks on the kiosk.
 *
 * A tap only marks the task here; planbar hears about it once the undo
 * window has passed. Taking it back within the window therefore changes
 * nothing in planbar – completing has side effects there (next instance of a
 * recurring task, daily report, running timers stop) that reopening would
 * not undo. After planbar confirmed, the change stays until a list loaded
 * later shows the new state, so the row does not flip back meanwhile.
 *
 * Plain store (subscribe / getSnapshot) for useSyncExternalStore; the timers
 * live here, not in React state.
 */

export const UNDO_MS = 5_000;

export type ChangePhase = 'waiting' | 'sending' | 'sent';

export interface LocalChange {
  id: string;
  title: string;
  /** New state: true = erledigt. */
  completed: boolean;
  /** waiting = in the undo window, sending = planbar is asked, sent = planbar confirmed. */
  phase: ChangePhase;
  /** epoch ms of the tap (start of the undo window). */
  startedAt: number;
  /** epoch ms planbar confirmed the change. */
  sentAt: number | null;
  /** Confirmed change this one replaced – comes back on undo or failure. */
  replaces: LocalChange | null;
}

export type ChangeMap = ReadonlyMap<string, LocalChange>;

export type CompletionSender = (id: string, completed: boolean) => Promise<unknown>;

export interface CompletionHandlers {
  /** planbar confirmed a change – load the list again. */
  onSent?: (change: LocalChange) => void;
  /** planbar refused or did not answer – the change was dropped. */
  onFailed?: (change: LocalChange, err: unknown) => void;
}

/** The most recent change still in its undo window (for «Rückgängig»), null if none. */
export function latestWaiting(changes: ChangeMap): LocalChange | null {
  let latest: LocalChange | null = null;
  for (const change of changes.values()) {
    if (change.phase === 'waiting' && (latest === null || change.startedAt >= latest.startedAt)) latest = change;
  }
  return latest;
}

export class CompletionQueue {
  private changes: ChangeMap = new Map();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private handlers: CompletionHandlers = {};
  private readonly send: CompletionSender;
  private readonly undoMs: number;

  constructor(send: CompletionSender, undoMs = UNDO_MS) {
    this.send = send;
    this.undoMs = undoMs;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ChangeMap => this.changes;

  /** Sets the callbacks (replacing earlier ones); the returned function removes them again. */
  listen(handlers: CompletionHandlers): () => void {
    this.handlers = handlers;
    return () => {
      if (this.handlers === handlers) this.handlers = {};
    };
  }

  /**
   * Tap on a task: marks it done (or open again). A second tap within the
   * undo window takes the change back; while planbar is asked, taps wait.
   */
  toggle(item: { id: string; title: string; done: boolean }, now = Date.now()): void {
    const current = this.changes.get(item.id);
    if (current?.phase === 'waiting') {
      this.undo(item.id);
      return;
    }
    if (current?.phase === 'sending') return;
    const shownDone = current ? current.completed : item.done;
    this.put({
      id: item.id,
      title: item.title,
      completed: !shownDone,
      phase: 'waiting',
      startedAt: now,
      sentAt: null,
      replaces: current ?? null,
    });
    this.timers.set(
      item.id,
      setTimeout(() => this.commit(item.id), this.undoMs),
    );
  }

  /** Takes back a change that is still in its undo window. */
  undo(id: string): void {
    const change = this.changes.get(id);
    if (!change || change.phase !== 'waiting') return;
    this.clearTimer(id);
    this.restore(change);
  }

  /**
   * Takes back every change still in its undo window – ticking off was
   * switched off meanwhile, so the widget no longer offers «Rückgängig» for
   * them. Changes planbar is already asked about stay.
   */
  undoAll(): void {
    for (const change of [...this.changes.values()]) {
      if (change.phase === 'waiting') this.undo(change.id);
    }
  }

  /** Forgets confirmed changes that a list whose loading started at `loadStartedAt` already contains. */
  settle(loadStartedAt: number): void {
    let next: Map<string, LocalChange> | null = null;
    for (const [id, change] of this.changes) {
      if (change.phase === 'sent' && change.sentAt !== null && change.sentAt < loadStartedAt) {
        next ??= new Map(this.changes);
        next.delete(id);
      }
    }
    if (next) this.publish(next);
  }

  /** Sends every change still in its undo window now – the widget goes away, the taps count. */
  flush(): void {
    for (const change of [...this.changes.values()]) {
      if (change.phase === 'waiting') this.commit(change.id);
    }
  }

  private commit(id: string): void {
    this.clearTimer(id);
    const change = this.changes.get(id);
    if (!change || change.phase !== 'waiting') return;
    const sending: LocalChange = { ...change, phase: 'sending' };
    this.put(sending);
    this.send(id, change.completed).then(
      () => {
        if (this.changes.get(id) !== sending) return;
        const sent: LocalChange = { ...sending, phase: 'sent', sentAt: Date.now(), replaces: null };
        this.put(sent);
        this.handlers.onSent?.(sent);
      },
      (err: unknown) => {
        if (this.changes.get(id) !== sending) return;
        this.restore(sending);
        this.handlers.onFailed?.(sending, err);
      },
    );
  }

  /** Back to what was shown before `change`: the confirmed change it replaced, or planbar's state. */
  private restore(change: LocalChange): void {
    const next = new Map(this.changes);
    if (change.replaces) next.set(change.id, change.replaces);
    else next.delete(change.id);
    this.publish(next);
  }

  private put(change: LocalChange): void {
    this.publish(new Map(this.changes).set(change.id, change));
  }

  private publish(next: ChangeMap): void {
    this.changes = next;
    for (const listener of this.listeners) listener();
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(id);
  }
}
