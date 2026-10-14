import { beforeEach, describe, expect, it } from 'vitest';
import { useAppState } from './appState';
import { announcementActions, todoActions, widgetSettingsActions } from './dataActions';
import { applyOps } from './ops';
import type { RawState, StateOp, StateSnapshot, StateTransport } from './types';

/** Backend stand-in that records what is sent. */
class RecordingTransport implements StateTransport {
  readonly kind = 'local' as const;
  rev = 0;
  state: RawState;
  readonly calls: StateOp[][] = [];

  constructor(state: RawState) {
    this.state = state;
  }

  load(): Promise<StateSnapshot> {
    return Promise.resolve({ rev: this.rev, state: this.state });
  }

  apply(ops: StateOp[]): Promise<{ rev: number }> {
    this.calls.push(ops);
    this.state = applyOps(this.state, ops);
    this.rev += 1;
    return Promise.resolve({ rev: this.rev });
  }

  subscribe(): () => void {
    return () => {};
  }
}

const todo = { id: 't1', text: 'Milch', done: false, list: 'Einkauf', createdAt: 1 };
const announcement = { id: 'a1', title: 'Fest', level: 'info', createdAt: 1 };
const clock = { instanceId: 'clock-1', widgetId: 'clock', x: 0, y: 0, w: 3, h: 3 };

let transport: RecordingTransport;

beforeEach(async () => {
  transport = new RecordingTransport({
    layout: { widgets: [clock], cols: 12 },
    widgetSettings: { 'clock-1': { format: '24h' } },
    data: { todos: { t1: todo }, announcements: { a1: announcement } },
  });
  await useAppState.getState().init(transport);
});

describe('record edits', () => {
  it('never recreate a todo or announcement a concurrent delete removed', async () => {
    await todoActions.update('t1', { text: 'Hafermilch' });
    await announcementActions.update('a1', { title: 'Sommerfest' });
    expect(transport.calls).toEqual([
      [{ op: 'merge', path: ['data', 'todos', 't1'], value: { text: 'Hafermilch' }, create: false }],
      [{ op: 'merge', path: ['data', 'announcements', 'a1'], value: { title: 'Sommerfest' }, create: false }],
    ]);

    // Another client deleted the todo first: the edit changes nothing.
    const deleted = applyOps(transport.state, [{ op: 'delete', path: ['data', 'todos', 't1'] }]);
    expect(applyOps(deleted, transport.calls[0])).toBe(deleted);
  });
});

describe('widgetSettingsActions.update', () => {
  it('merges into existing settings without recreating them after a delete', async () => {
    await widgetSettingsActions.update('clock-1', { format: '12h' });
    expect(transport.calls).toEqual([
      [{ op: 'merge', path: ['widgetSettings', 'clock-1'], value: { format: '12h' }, create: false }],
    ]);
  });

  it('creates the settings of a placed widget on its first write', async () => {
    await widgetSettingsActions.remove('clock-1');
    await widgetSettingsActions.update('clock-1', { format: '12h' });
    expect(transport.calls[1]).toEqual([{ op: 'merge', path: ['widgetSettings', 'clock-1'], value: { format: '12h' } }]);
    expect(useAppState.getState().state.widgetSettings['clock-1']).toEqual({ format: '12h' });
  });

  it('ignores writes for an instance that is no longer on the dashboard', async () => {
    // E.g. a settings form flushing its draft while the widget is removed from the web UI.
    await expect(widgetSettingsActions.update('weather-gone', { apiKey: 'geheim' })).resolves.toBe(false);
    expect(transport.calls).toHaveLength(0);
    expect(useAppState.getState().state.widgetSettings['weather-gone']).toBeUndefined();
  });
});
