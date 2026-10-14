import { describe, expect, it } from 'vitest';
import { isNewPost, postBody } from './news';

describe('postBody', () => {
  it('drops the first line, which is the title', () => {
    expect(postBody({ title: 'Büro zu am Freitag', text: 'Büro zu am Freitag\nBitte Schlüssel & Post beachten.\n\nDanke!' })).toBe(
      'Bitte Schlüssel & Post beachten.\n\nDanke!',
    );
    expect(postBody({ title: 'Nur ein Satz', text: 'Nur ein Satz' })).toBe('');
  });

  it('keeps the whole text when the title was cut or differs', () => {
    const long = `${'Sehr lange erste Zeile '.repeat(6)}\nZweite Zeile`;
    expect(postBody({ title: `${long.slice(0, 99)}…`, text: long })).toBe(long);
    expect(postBody({ title: 'Anders', text: 'Erste Zeile\nZweite' })).toBe('Erste Zeile\nZweite');
  });
});

describe('isNewPost', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');

  it('marks posts of the last 24 hours', () => {
    expect(isNewPost({ createdAt: '2026-10-13T08:00:00Z' }, now)).toBe(true);
    expect(isNewPost({ createdAt: '2026-10-12T12:00:01Z' }, now)).toBe(true);
    expect(isNewPost({ createdAt: '2026-10-12T11:59:59Z' }, now)).toBe(false);
    expect(isNewPost({ createdAt: 'kaputt' }, now)).toBe(false);
  });
});
