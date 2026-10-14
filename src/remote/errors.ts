/** German text of any rejection (HttpError, Error, string). */
export const errorText = (err: unknown): string => {
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return 'Unbekannter Fehler';
};
