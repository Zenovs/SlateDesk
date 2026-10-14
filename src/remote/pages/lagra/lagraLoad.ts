/** Loading helper for the lagra page. */
import { LagraError } from '../../../lagra/client';
import { loadSettled } from '../settleLoad';

const notConfigured = (err: unknown): boolean => err instanceof LagraError && err.kind === 'notConfigured';

/** Runs a lagra request (one retry right after setup, session handling – see loadSettled). */
export const loadLagra = <T>(load: () => Promise<T>, signal: AbortSignal): Promise<T> =>
  loadSettled(load, signal, notConfigured);
