/**
 * useElementSize – content-box size of an element in px (rounded), tracked
 * with a ResizeObserver. 0×0 until the first measurement.
 *
 * The element must be mounted together with the component that owns the ref
 * (the observer attaches once per ref object).
 */
import { type RefObject, useEffect, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

const ZERO: ElementSize = { width: 0, height: 0 };

export function useElementSize<T extends Element>(ref: RefObject<T | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>(ZERO);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;

    // Fires once right after observe(), then on every size change (max. once per frame).
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
