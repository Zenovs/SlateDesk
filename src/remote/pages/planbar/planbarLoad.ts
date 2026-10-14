/** Loading helper for the planbar page. */
import { PlanbarError } from '../../../planbar/client';
import { loadSettled } from '../settleLoad';

/**
 * What a preview card shows: the data, «planbar-Update nötig» (the route is
 * missing on that planbar) or a missing right of the key. Anything else
 * rejects and shows as an error.
 */
export type PlanbarLoad<T> = { kind: 'ok'; data: T } | { kind: 'missing' } | { kind: 'forbidden'; message: string };

const notConfigured = (err: unknown): boolean => err instanceof PlanbarError && err.kind === 'notConfigured';

/** Runs a planbar request (one retry right after setup, session handling – see loadSettled). */
export const loadPlanbar = <T>(load: () => Promise<T>, signal: AbortSignal): Promise<PlanbarLoad<T>> =>
  loadSettled(
    async (): Promise<PlanbarLoad<T>> => {
      try {
        return { kind: 'ok', data: await load() };
      } catch (err) {
        if (err instanceof PlanbarError && err.kind === 'endpointMissing') return { kind: 'missing' };
        if (err instanceof PlanbarError && err.kind === 'forbidden') return { kind: 'forbidden', message: err.message };
        throw err;
      }
    },
    signal,
    notConfigured,
  );
