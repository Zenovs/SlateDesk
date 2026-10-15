import { describe, expect, it, vi } from 'vitest';
import { createBuildWatch, RELOAD_AFTER_DIALOG_NOTICE, RELOAD_NOTICE, type BuildWatchDeps } from './buildWatch';

function setup(answers: (string | null | undefined)[], editor = false) {
  const listeners = new Set<() => void>();
  const state = { editor };
  const deps: BuildWatchDeps = {
    fetchCommit: vi.fn(() => Promise.resolve(answers.shift())),
    reload: vi.fn(),
    editorOpen: () => state.editor,
    onModalChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: vi.fn(),
  };
  const closeEditor = () => {
    state.editor = false;
    for (const listener of [...listeners]) listener();
  };
  return { watch: createBuildWatch(deps), deps, closeEditor, listeners };
}

describe('build watch', () => {
  it('takes the first answer as the page build and reloads once the kiosk runs another', async () => {
    const { watch, deps } = setup(['aaa111', 'aaa111', 'bbb222', 'ccc333']);
    expect(await watch.check()).toBe(false);
    expect(await watch.check()).toBe(false);
    expect(deps.reload).not.toHaveBeenCalled();
    expect(await watch.check()).toBe(true);
    expect(deps.notify).toHaveBeenCalledWith(RELOAD_NOTICE);
    expect(deps.reload).toHaveBeenCalledTimes(1);
    // Already reloading: no further requests or reloads.
    expect(await watch.check()).toBe(true);
    expect(deps.fetchCommit).toHaveBeenCalledTimes(3);
    expect(deps.reload).toHaveBeenCalledTimes(1);
  });

  it('ignores unreachable answers and builds without a commit', async () => {
    const { watch, deps } = setup([undefined, 'aaa111', undefined, null, 'aaa111']);
    for (let i = 0; i < 5; i++) expect(await watch.check()).toBe(false);
    expect(deps.reload).not.toHaveBeenCalled();

    const unknown = setup([null, 'aaa111']);
    expect(await unknown.watch.check()).toBe(false);
    expect(await unknown.watch.check()).toBe(false);
    expect(unknown.deps.reload).not.toHaveBeenCalled();
  });

  it('waits for an open editor to close before reloading', async () => {
    const { watch, deps, closeEditor, listeners } = setup(['aaa111', 'bbb222'], true);
    await watch.check();
    expect(await watch.check()).toBe(true);
    expect(deps.notify).toHaveBeenCalledWith(RELOAD_AFTER_DIALOG_NOTICE);
    expect(deps.reload).not.toHaveBeenCalled();
    closeEditor();
    expect(deps.reload).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});
