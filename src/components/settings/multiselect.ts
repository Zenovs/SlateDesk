/**
 * List logic of the `multiselect` settings field, apart from React so the
 * commit semantics can be tested: the stored value is a list of ids, each
 * once, in the user's order; every change commits the whole new list.
 */
import type { SettingsChoice } from '../../types/settings';

/** The stored value as a clean list: strings only, each once, order kept. */
export function normalizeSelection(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Selects `value` (appended – keeps the order of choosing) or deselects it. */
export function toggleSelection(selection: readonly string[], value: string): string[] {
  return selection.includes(value) ? selection.filter((item) => item !== value) : [...selection, value];
}

export function removeSelection(selection: readonly string[], value: string): string[] {
  return selection.filter((item) => item !== value);
}

/** Moves the entry at `from` to `to`; out-of-range moves change nothing. */
export function moveSelection(selection: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= selection.length || to < 0 || to >= selection.length || from === to) return [...selection];
  const next = [...selection];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Static choices first, then the loaded ones; a value appears once. */
export function mergeChoices(
  fixed: readonly SettingsChoice[] | undefined,
  loaded: readonly SettingsChoice[],
): SettingsChoice[] {
  const seen = new Set<string>();
  const out: SettingsChoice[] = [];
  for (const choice of [...(fixed ?? []), ...loaded]) {
    if (seen.has(choice.value)) continue;
    seen.add(choice.value);
    out.push(choice);
  }
  return out;
}

export interface SelectionChip {
  value: string;
  label: string;
  /** Stored id that the (loaded) choices don't contain – e.g. a deleted person. */
  unknown: boolean;
}

/**
 * Labels of the selected values in their order. Once the choices are known
 * (`resolved`), missing ids read «Unbekannt (<id>)» so they can be removed;
 * before that, `pendingLabel` (e.g. «Lädt …» during the first load) or the
 * bare id stands in.
 */
export function selectionChips(
  selection: readonly string[],
  choices: ReadonlyMap<string, SettingsChoice>,
  resolved: boolean,
  pendingLabel?: string,
): SelectionChip[] {
  return selection.map((value) => {
    const choice = choices.get(value);
    if (choice) return { value, label: choice.label, unknown: false };
    if (resolved) return { value, label: `Unbekannt (${value})`, unknown: true };
    return { value, label: pendingLabel ?? value, unknown: false };
  });
}

/** Lower case without accents, so «muller» finds «Müller». */
export const searchText = (text: string): string =>
  text
    .toLocaleLowerCase('de-CH')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** Choices whose label, hint or group contain every word of `query`. */
export function filterChoices(choices: readonly SettingsChoice[], query: string): SettingsChoice[] {
  const words = searchText(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...choices];
  return choices.filter((choice) => {
    const haystack = searchText(`${choice.label} ${choice.hint ?? ''} ${choice.group ?? ''}`);
    return words.every((word) => haystack.includes(word));
  });
}

export interface ChoiceGroup<T> {
  /** null = entries without a group (listed first). */
  group: string | null;
  items: T[];
}

/** Buckets by `group`, ungrouped entries first, groups in order of first appearance. */
export function groupChoices<T extends { group?: string }>(items: readonly T[]): ChoiceGroup<T>[] {
  const buckets = new Map<string | null, T[]>([[null, []]]);
  for (const item of items) {
    const key = item.group?.trim() || null;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return [...buckets].filter(([, list]) => list.length > 0).map(([group, list]) => ({ group, items: list }));
}
