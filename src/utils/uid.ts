/**
 * Simple unique ID generator (no crypto dependency needed).
 */
let counter = 0;
export const v4Style = (): string => {
  counter++;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
};
