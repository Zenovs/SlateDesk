/**
 * planbar Infowand posts for the News widget. planbar posts have no title of
 * their own: `title` is the first line of `text`, cut with «…» when longer
 * than 100 characters.
 */
import type { PlanbarNewsPost } from '../../planbar/types';
import { parseTime } from '../shared/format';

/** Posts younger than this get a «Neu» mark. */
export const NEW_POST_MS = 24 * 60 * 60_000;

/** The text below the title: everything after the first line – or all of it when the title was cut. */
export function postBody(post: Pick<PlanbarNewsPost, 'title' | 'text'>): string {
  const text = post.text.trim();
  if (post.title.endsWith('…')) return text;
  const lineEnd = text.indexOf('\n');
  const firstLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
  if (firstLine.trim() !== post.title.trim()) return text;
  return lineEnd === -1 ? '' : text.slice(lineEnd + 1).trim();
}

export function isNewPost(post: Pick<PlanbarNewsPost, 'createdAt'>, now: number): boolean {
  const created = parseTime(post.createdAt);
  return created !== null && now - created >= 0 && now - created < NEW_POST_MS;
}
