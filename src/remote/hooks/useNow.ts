/**
 * useNow – the current time (epoch ms) as state, refreshed every
 * `intervalMs` and when the tab becomes visible again. Components use it
 * instead of calling Date.now() while rendering.
 */
import { useEffect, useState } from 'react';

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick();
    };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);

  return now;
}
