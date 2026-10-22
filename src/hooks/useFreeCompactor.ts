/**
 * The free-placement compactor of a GridLayout (utils/freeGrid) with its drag
 * bookkeeping: pass `start` to onDragStart and onResizeStart, and call `end`
 * in onDragStop and onResizeStop. A drag that react-grid-layout drops without
 * a stop (a very short tap) is ended once the pointer is released.
 */
import { useCallback, useEffect, useMemo } from 'react';
import type { EventCallback } from 'react-grid-layout';
import { createFreeCompactor, type FreeCompactor } from '../utils/freeGrid';

export function useFreeCompactor(): { compactor: FreeCompactor; start: EventCallback } {
  const compactor = useMemo(() => createFreeCompactor(), []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // After react-grid-layout's own stop handling, which runs on the same release.
    const release = () => {
      clearTimeout(timer);
      timer = setTimeout(() => compactor.end(), 0);
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [compactor]);

  const start = useCallback<EventCallback>(
    (layout, oldItem) => {
      if (oldItem) compactor.begin(layout, oldItem.i);
    },
    [compactor],
  );

  return { compactor, start };
}
