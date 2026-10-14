import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WidgetInstance } from '../state/types';
import { forgetRemovedInstances } from './instanceStorage';

class MemoryStorage {
  private items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
  keys(): string[] {
    return [...this.items.keys()].sort();
  }
}

const widget = (instanceId: string): WidgetInstance => ({ instanceId, widgetId: 'speedtest', x: 0, y: 0, w: 4, h: 3 });

describe('forgetRemovedInstances', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    vi.stubGlobal('window', { localStorage: storage });
    for (const key of [
      'slatedesk:speedtest:speedtest-a:last',
      'slatedesk:speedtest:speedtest-a:history',
      'slatedesk:nas:nas-b:history',
      'slatedesk:speedtest:history',
      'slatedesk-migrated',
      'slatedesk-state',
    ]) {
      storage.setItem(key, '1');
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes only the per-instance keys of removed widgets', () => {
    forgetRemovedInstances([widget('speedtest-a'), widget('nas-b')], [widget('nas-b')]);
    expect(storage.keys()).toEqual([
      'slatedesk-migrated',
      'slatedesk-state',
      'slatedesk:nas:nas-b:history',
      'slatedesk:speedtest:history',
    ]);
  });

  it('keeps everything when no widget was removed', () => {
    const before = storage.keys();
    forgetRemovedInstances([widget('speedtest-a')], [widget('speedtest-a'), widget('nas-b')]);
    expect(storage.keys()).toEqual(before);
  });

  it('copes with storage that is not available', () => {
    vi.stubGlobal('window', {
      get localStorage(): Storage {
        throw new Error('blocked');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => forgetRemovedInstances([widget('speedtest-a')], [])).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
