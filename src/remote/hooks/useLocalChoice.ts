/**
 * useLocalChoice – one of a fixed set of options, remembered per browser
 * (localStorage). Unknown stored values fall back to `fallback`.
 */
import { useCallback, useState } from 'react';
import { readLocal, writeLocal } from '../storage';

export function useLocalChoice<T extends string | number>(
  key: string,
  options: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = readLocal(key);
    return options.find((option) => String(option) === stored) ?? fallback;
  });
  const update = useCallback(
    (next: T) => {
      setValue(next);
      writeLocal(key, String(next));
    },
    [key],
  );
  return [value, update];
}
