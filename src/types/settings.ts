/**
 * Declarative widget settings – rendered by `SettingsForm` in the kiosk
 * dialog and in the web UI (Fernsteuerung) alike. Pure types, no React.
 */

/** Visibility rule; receives the current values (of the item, inside a `list`). */
export type ShowIf = (values: Record<string, unknown>) => boolean;

type Base = {
  key: string;
  label: string;
  description?: string;
  showIf?: ShowIf;
  /** Hidden in the web UI (e.g. camera device selection – only the kiosk knows its devices). */
  kioskOnly?: boolean;
};

/** A fixed choice of a `select` / `radio` field. */
export interface SettingsOption {
  value: string | number;
  label: string;
}

/** A choice of a `multiselect` (static or from an options provider). */
export interface SettingsChoice {
  value: string;
  label: string;
  /** Heading the choice is listed under (e.g. the customer of a project). */
  group?: string;
  /** Secondary text (e.g. the teams of a person). */
  hint?: string;
}

export type SettingsField =
  | { type: 'section'; label: string; description?: string; showIf?: ShowIf }
  | (Base & { type: 'text' | 'url' | 'secret' | 'textarea'; placeholder?: string })
  | (Base & { type: 'number'; min?: number; max?: number; step?: number; unit?: string })
  | (Base & { type: 'boolean' })
  | (Base & { type: 'radio'; options: SettingsOption[] })
  /**
   * `optionsProvider` names choices loaded at runtime
   * (src/components/settings/optionProviders.ts); they follow the static
   * `options` (e.g. `[{ value: '', label: 'Niemand' }]`). Provider values are strings.
   * `optionsDependsOn` lists keys of the same form whose values the provider
   * receives (e.g. the selected Unternehmen) – other values, other choices.
   */
  | (Base & { type: 'select'; options: SettingsOption[]; optionsProvider?: string; optionsDependsOn?: string[] })
  /**
   * string[] – static `options` and/or choices of `optionsProvider`. `ordered`
   * keeps the user's order and lets them change it (e.g. projects in display order).
   */
  | (Base & {
      type: 'multiselect';
      options?: SettingsChoice[];
      optionsProvider?: string;
      /** Keys of the same form passed to the provider (see `select`). */
      optionsDependsOn?: string[];
      ordered?: boolean;
      /** Search field placeholder. */
      placeholder?: string;
    })
  | (Base & {
      type: 'range';
      min: number;
      max: number;
      step?: number;
      unit?: string;
      /** Shown value instead of «value unit», e.g. seconds as «4 min 30 s». */
      format?: (value: number) => string;
    })
  | (Base & { type: 'color' })
  /** 'HH:MM' */
  | (Base & { type: 'time' })
  /** number[] 0..6 (0 = Sonntag), shown as Mo–So chips */
  | (Base & { type: 'days' })
  | (Base & { type: 'stringList'; placeholder?: string; addLabel?: string })
  /**
   * Own arrangement of the widget's tiles, edited like the dashboard layout:
   * a TileLayout (src/utils/tileLayout.ts), or null = automatic. `tiles`
   * names every tile; `activeTiles` returns the ones shown for the current
   * values (e.g. the switched-on sections) – only those are arranged.
   */
  | (Base & {
      type: 'tileLayout';
      tiles: SettingsChoice[];
      activeTiles?: (values: Record<string, unknown>) => string[];
    })
  | (Base & {
      type: 'list';
      itemFields: SettingsField[];
      addLabel?: string;
      itemTitleKey?: string;
      newItem: () => Record<string, unknown>;
    });

/** Every field except `section` – the ones that hold a value. */
export type ValueField = Exclude<SettingsField, { type: 'section' }>;

/** Where a form is rendered: kiosk dialog or web UI. */
export type SettingsContext = 'kiosk' | 'remote';

/** What the backend sends over HTTP instead of a non-empty secret. */
export const REDACTED_SECRET = '__gesetzt__';

const SECRET_KEY_SUFFIXES = ['apikey', 'token', 'password', 'secret'] as const;

/**
 * Same rule as the backend (state.rs `is_secret_key`): such keys are redacted
 * at any depth in every HTTP response. Only `secret` fields may use these
 * names, and every `secret` field must – otherwise the web UI either sees the
 * real value or gets `__gesetzt__` in a plain field.
 */
export const isSecretKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return SECRET_KEY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};
