import { describe, expect, it } from 'vitest';
import type { Announcement, TodoItem } from '../../../state/types';
import { checkDraft, draftOf, editedFields, pickValues } from './announcements';
import { editedTodoPatch, todoDraftOf } from './todos';

describe('editedTodoPatch', () => {
  const todo: TodoItem = { id: 't1', text: 'Kaffeebohnen bestellen', done: false, createdAt: 1, list: 'Büro', due: '2026-10-20' };

  it('contains only the edited fields', () => {
    const base = todoDraftOf(todo);
    expect(editedTodoPatch({ text: 'Kaffeebohnen bestelen' }, base, ['Allgemein', 'Büro'])).toEqual({ text: 'Kaffeebohnen bestelen' });
    expect(editedTodoPatch({}, base, ['Allgemein', 'Büro'])).toEqual({});
  });

  it('keeps clearing a field as removal', () => {
    const patch = editedTodoPatch({ due: '' }, todoDraftOf(todo), ['Büro']);
    expect(patch).toEqual({ due: undefined });
    expect('due' in patch).toBe(true);
  });

  it('normalizes an edited list name like the add form', () => {
    expect(editedTodoPatch({ list: 'büro' }, todoDraftOf(todo), ['Allgemein', 'Büro'])).toEqual({ list: 'Büro' });
    expect(editedTodoPatch({ list: 'Allgemein' }, todoDraftOf(todo), ['Allgemein', 'Büro'])).toEqual({ list: undefined });
  });
});

describe('announcement edits', () => {
  const now = new Date(2026, 9, 13, 9, 30).getTime();
  const item: Announcement = {
    id: 'a1',
    title: 'Lieferung',
    text: 'Heute um 14 Uhr',
    level: 'info',
    pinned: true,
    from: new Date(2026, 9, 13, 8, 0).getTime(),
    createdAt: 1,
  };

  it('maps the time modes to their stored field', () => {
    expect(editedFields({ title: 'x', fromMode: 'sofort', untilMode: 'zeitpunkt', until: '2026-10-14T00:00' }).sort()).toEqual(
      ['from', 'title', 'until'],
    );
  });

  it('writes only the edited fields – a pin set elsewhere is not removed', () => {
    const draft = { ...draftOf({ ...item, pinned: undefined }, now), title: 'Lieferung verschoben' };
    const values = checkDraft(draft, now).values!;
    // The form was opened before the entry was pinned: `pinned` reads undefined there …
    expect(values.pinned).toBeUndefined();
    // … but it is not part of the patch, so the pin stays.
    expect(pickValues(values, editedFields({ title: draft.title }))).toEqual({ title: 'Lieferung verschoben' });
  });
});
