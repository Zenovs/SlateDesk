/**
 * Multiselect commit semantics: every change commits the whole list, built on
 * the latest committed one – quick clicks before a re-render must not lose a
 * choice – and stored ids nobody knows any more stay visible and removable.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SettingsChoice, SettingsField } from '../../types/settings';
import {
  filterChoices,
  groupChoices,
  mergeChoices,
  moveSelection,
  normalizeSelection,
  removeSelection,
  selectionChips,
  toggleSelection,
} from './multiselect';
import { SettingsForm } from './SettingsForm';

const CHOICES: SettingsChoice[] = [
  { value: 'p1', label: 'Website Relaunch', group: 'Muster AG', hint: 'In Bearbeitung' },
  { value: 'p2', label: 'Büroumzug', group: 'Interne Projekte' },
  { value: 'p3', label: 'Jahresbericht', group: 'Müller & Co.' },
  { value: 'p4', label: 'Logo', group: 'Muster AG' },
];

describe('selection list', () => {
  it('normalizes the stored value to unique id strings in order', () => {
    expect(normalizeSelection(['b', 'a', 'b', '', 3, null, 'c'])).toEqual(['b', 'a', 'c']);
    expect(normalizeSelection('a,b')).toEqual([]);
    expect(normalizeSelection(undefined)).toEqual([]);
  });

  it('builds every commit on the latest committed list', () => {
    // What the control does: `current` is updated synchronously with each commit.
    const commits: string[][] = [];
    let current: string[] = [];
    const commit = (next: string[]) => {
      current = next;
      commits.push(next);
    };
    commit(toggleSelection(current, 'p1'));
    commit(toggleSelection(current, 'p3'));
    commit(toggleSelection(current, 'p1'));
    commit(toggleSelection(current, 'p2'));
    expect(commits).toEqual([['p1'], ['p1', 'p3'], ['p3'], ['p3', 'p2']]);
  });

  it('removes, moves and keeps the input untouched', () => {
    const selection = Object.freeze(['a', 'b', 'c']);
    expect(removeSelection(selection, 'b')).toEqual(['a', 'c']);
    expect(removeSelection(selection, 'x')).toEqual(['a', 'b', 'c']);
    expect(moveSelection(selection, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveSelection(selection, 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveSelection(selection, 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveSelection(selection, 2, 3)).toEqual(['a', 'b', 'c']);
    expect(selection).toEqual(['a', 'b', 'c']);
  });
});

describe('chips', () => {
  const byValue = new Map(CHOICES.map((choice) => [choice.value, choice]));

  it('labels known ids and marks unknown ones once the choices are loaded', () => {
    expect(selectionChips(['p4', 'weg'], byValue, true)).toEqual([
      { value: 'p4', label: 'Logo', unknown: false },
      { value: 'weg', label: 'Unbekannt (weg)', unknown: true },
    ]);
  });

  it('shows the bare id while the choices are not known', () => {
    expect(selectionChips(['weg'], new Map(), false)).toEqual([{ value: 'weg', label: 'weg', unknown: false }]);
  });

  it('says «Lädt …» during the first load', () => {
    expect(selectionChips(['p4', 'u1'], new Map(), false, 'Lädt …')).toEqual([
      { value: 'p4', label: 'Lädt …', unknown: false },
      { value: 'u1', label: 'Lädt …', unknown: false },
    ]);
  });
});

describe('choices', () => {
  it('puts static choices first and lists each value once', () => {
    const merged = mergeChoices([{ value: 'alle', label: 'Alle' }, { value: 'p1', label: 'Fix' }], CHOICES);
    expect(merged.map((c) => c.value)).toEqual(['alle', 'p1', 'p2', 'p3', 'p4']);
    expect(merged[1].label).toBe('Fix');
    expect(mergeChoices(undefined, CHOICES)).toEqual(CHOICES);
  });

  it('searches label, hint and group without case and accents', () => {
    expect(filterChoices(CHOICES, 'muller').map((c) => c.value)).toEqual(['p3']);
    expect(filterChoices(CHOICES, 'BUERO').map((c) => c.value)).toEqual([]);
    expect(filterChoices(CHOICES, 'buro').map((c) => c.value)).toEqual(['p2']);
    expect(filterChoices(CHOICES, 'muster bearbeitung').map((c) => c.value)).toEqual(['p1']);
    expect(filterChoices(CHOICES, '   ')).toEqual(CHOICES);
  });

  it('groups in order of appearance, ungrouped entries first', () => {
    const groups = groupChoices([...CHOICES, { value: 'x', label: 'Ohne Gruppe' }]);
    expect(groups.map((g) => [g.group, g.items.map((c) => c.value)])).toEqual([
      [null, ['x']],
      ['Muster AG', ['p1', 'p4']],
      ['Interne Projekte', ['p2']],
      ['Müller & Co.', ['p3']],
    ]);
  });
});

describe('SettingsForm multiselect', () => {
  const render = (field: SettingsField, values: Record<string, unknown>): string =>
    renderToStaticMarkup(createElement(SettingsForm, { schema: [field], values, onChange: () => undefined, context: 'remote' }));

  it('renders chips, unknown ids, search and «Alle abwählen» for static choices', () => {
    const html = render(
      { type: 'multiselect', key: 'projekte', label: 'Projekte', options: CHOICES.concat(CHOICES.map((c) => ({ ...c, value: `${c.value}b` }))) },
      { projekte: ['p1', 'weg'] },
    );
    expect(html).toContain('Website Relaunch entfernen');
    expect(html).toContain('Unbekannt (weg)');
    expect(html).toContain('Alle abwählen');
    expect(html).toContain('type="search"');
    expect(html).toContain('Muster AG');
  });

  it('renders ordered rows with move buttons and an empty state', () => {
    const ordered: SettingsField = { type: 'multiselect', key: 'projekte', label: 'Projekte', options: CHOICES, ordered: true };
    const html = render(ordered, { projekte: ['p3', 'p1'] });
    expect(html.indexOf('Jahresbericht')).toBeLessThan(html.indexOf('Website Relaunch'));
    expect(html).toContain('Jahresbericht nach unten verschieben');
    expect(render(ordered, { projekte: [] })).toContain('Nichts ausgewählt');
  });

  it('shows the loading state of a provider field before the first load', () => {
    const html = render(
      { type: 'multiselect', key: 'benutzer', label: 'Personen', optionsProvider: 'test.noch.nicht.geladen' },
      { benutzer: ['u1'] },
    );
    expect(html).toContain('Auswahl wird geladen');
    // The stored id stays removable, but no raw id is shown before the names are known.
    expect(html).toContain('<span class="settings-chip-label">Lädt …</span>');
    expect(html).not.toContain('>u1<');
    expect(html).toContain('Auswahl neu laden');
  });
});
