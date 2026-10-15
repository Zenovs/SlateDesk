/**
 * Reloads the web UI when the kiosk runs a different build than the one this
 * page was loaded from. An open tab keeps its JavaScript across a kiosk
 * update – logging in again does not replace it – so new settings (a wider
 * slider, a new widget) would stay invisible until a manual reload.
 *
 * The build is the commit from the public /api/health. The first answer is
 * the page's own build; any later, different one reloads the page – but
 * never while an editor dialog (unsaved input) is open: the reload waits
 * until it is closed. The login overlay alone does not hold it back.
 */
import { isPlainObject } from '../state/ops';
import { toast } from './ui/toast';
import { inputDialogOpen, onModalDialogsChange } from './ui/topLayer';

/** Check interval while the page is visible. */
const CHECK_MS = 60_000;
const REQUEST_TIMEOUT_MS = 4_000;
/** Time to read the toast before the page reloads. */
const RELOAD_DELAY_MS = 1_500;
export const RELOAD_NOTICE = 'Neue SlateDesk-Version auf dem Kiosk – die Fernsteuerung wird neu geladen';
export const RELOAD_AFTER_DIALOG_NOTICE =
  'Neue SlateDesk-Version auf dem Kiosk – die Fernsteuerung wird nach dem Schliessen des Dialogs neu geladen';

export interface BuildWatchDeps {
  /** Commit of the running kiosk; null when unknown (no git build), undefined when unreachable. */
  fetchCommit: () => Promise<string | null | undefined>;
  reload: () => void;
  /** An editor dialog is open – the reload waits for it to close. */
  editorOpen: () => boolean;
  onModalChange: (listener: () => void) => () => void;
  notify: (message: string) => void;
}

export interface BuildWatch {
  /** Asks the kiosk for its build; resolves true when a reload is due. */
  check: () => Promise<boolean>;
}

export function createBuildWatch(deps: BuildWatchDeps): BuildWatch {
  /** undefined until the first answer. */
  let loaded: string | null | undefined;
  let reloading = false;

  const reloadWhenIdle = (): void => {
    if (!deps.editorOpen()) {
      deps.reload();
      return;
    }
    const stop = deps.onModalChange(() => {
      if (deps.editorOpen()) return;
      stop();
      deps.reload();
    });
  };

  return {
    async check() {
      if (reloading) return true;
      const commit = await deps.fetchCommit();
      if (commit === undefined) return false;
      if (loaded === undefined) {
        loaded = commit;
        return false;
      }
      // Builds without a commit can't be compared – never reload for them.
      if (commit === null || loaded === null || commit === loaded) return false;
      reloading = true;
      deps.notify(deps.editorOpen() ? RELOAD_AFTER_DIALOG_NOTICE : RELOAD_NOTICE);
      reloadWhenIdle();
      return true;
    },
  };
}

async function fetchCommit(): Promise<string | null | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
    if (!res.ok) return undefined;
    const body: unknown = await res.json();
    if (!isPlainObject(body) || body.ok !== true) return undefined;
    return typeof body.commit === 'string' && body.commit ? body.commit : null;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const watch = createBuildWatch({
  fetchCommit,
  reload: () => setTimeout(() => window.location.reload(), RELOAD_DELAY_MS),
  editorOpen: inputDialogOpen,
  onModalChange: onModalDialogsChange,
  notify: (message) => toast.info(message),
});

/** Checks now, e.g. after the event stream reconnected (the kiosk restarts on every update). */
export const checkBuild = (): Promise<boolean> => watch.check();

/** Checks at once, every minute while the page is visible, and when it becomes visible again. */
export function startBuildWatch(): () => void {
  void checkBuild();
  const interval = setInterval(() => {
    if (document.visibilityState === 'visible') void checkBuild();
  }, CHECK_MS);
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') void checkBuild();
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    clearInterval(interval);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
