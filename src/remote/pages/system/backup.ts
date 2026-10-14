/**
 * Preview of a backup before it replaces the kiosk state: what it contains,
 * which sections fall back to defaults and which secrets the kiosk keeps.
 */
import { withDefaults } from '../../../state/defaults';
import { ALLOWED_TOP_LEVEL_KEYS, dropInvalidTopLevel, isPlainObject } from '../../../state/ops';
import type { RawState } from '../../../state/types';
import { isSecretKey, REDACTED_SECRET } from '../../../types/settings';
import type { BackupFile } from '../../api';

const SECTION_NAMES: Record<string, string> = {
  layout: 'Layout',
  widgetSettings: 'Widget-Einstellungen',
  theme: 'Design',
  kiosk: 'Kiosk-Einstellungen',
  lagra: 'lagra-Verbindung',
  planbar: 'planbar-Verbindung',
  data: 'Pinnwand und Aufgaben',
};

export interface BackupPreview {
  fileName: string;
  exportedAt: number | null;
  /** What gets imported: the file's state without unknown top-level keys. */
  state: RawState;
  /** Top-level keys the kiosk does not know (left out). */
  ignored: string[];
  /** Sections missing in the file – they are reset to the defaults. */
  missing: string[];
  kioskName: string;
  widgets: number;
  configuredWidgets: number;
  announcements: number;
  todos: number;
  openTodos: number;
  darkMode: boolean;
  lagraEnabled: boolean;
  planbarEnabled: boolean;
  /** Secrets marked «gesetzt» – the kiosk fills in its stored values. */
  redactedSecrets: number;
}

function countRedacted(value: unknown, key: string): number {
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countRedacted(item, ''), 0);
  if (isPlainObject(value)) {
    return Object.entries(value).reduce<number>((sum, [childKey, child]) => sum + countRedacted(child, childKey), 0);
  }
  return value === REDACTED_SECRET && isSecretKey(key) ? 1 : 0;
}

export function previewBackup(fileName: string, backup: BackupFile): BackupPreview {
  const state = dropInvalidTopLevel(backup.state);
  const full = withDefaults(state);
  const todos = Object.values(full.data.todos);
  return {
    fileName,
    exportedAt: backup.exportedAt,
    state,
    ignored: Object.keys(backup.state).filter((key) => !(key in state)),
    missing: ALLOWED_TOP_LEVEL_KEYS.filter((key) => key in SECTION_NAMES && !(key in state)).map((key) => SECTION_NAMES[key]),
    kioskName: full.kiosk.name,
    widgets: full.layout.widgets.length,
    configuredWidgets: Object.keys(full.widgetSettings).length,
    announcements: Object.keys(full.data.announcements).length,
    todos: todos.length,
    openTodos: todos.filter((todo) => !todo.done).length,
    darkMode: full.theme.mode === 'dark',
    lagraEnabled: full.lagra.enabled,
    planbarEnabled: full.planbar.enabled,
    redactedSecrets: countRedacted(state, ''),
  };
}
