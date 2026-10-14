/**
 * useSystemInfo – polls GET /api/system. The last answer is shared between
 * pages, so e.g. the layout editor knows the kiosk's screen size right away.
 */
import { create } from 'zustand';
import { system, type SystemInfo } from '../api';
import { usePoll, type PollState } from './usePoll';

const useSystemCache = create<{ info: SystemInfo | null }>(() => ({ info: null }));

async function fetchSystem(signal: AbortSignal): Promise<SystemInfo> {
  const info = await system(signal);
  useSystemCache.setState({ info });
  return info;
}

export function useSystemInfo(intervalMs: number): PollState<SystemInfo> {
  const cached = useSystemCache((s) => s.info);
  const poll = usePoll(fetchSystem, intervalMs);
  return poll.data === null && cached !== null ? { ...poll, data: cached } : poll;
}
