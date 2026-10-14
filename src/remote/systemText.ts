/** Display texts for SystemInfo values (Übersicht and System). */
import type { SystemInfo } from '../utils/backend';
import type { StatusTone } from './ui';

const SESSION_NAMES: Record<string, string> = { wayland: 'Wayland', x11: 'X11', tty: 'Konsole' };

/** «Wayland · GNOME». */
export function sessionText(info: Pick<SystemInfo, 'sessionType' | 'desktop'>): string {
  const type = SESSION_NAMES[info.sessionType.toLowerCase()] ?? (info.sessionType || 'unbekannt');
  return info.desktop ? `${type} · ${info.desktop}` : type;
}

export function temperatureTone(celsius: number): StatusTone {
  if (celsius >= 80) return 'error';
  if (celsius >= 70) return 'warn';
  return 'ok';
}

/** «1.20 / 0.98 / 0.87» load averages are drawn as warn above 1.5 per core. */
export const isHighLoad = (load: number, cpuCount: number): boolean => cpuCount > 0 && load / cpuCount > 1.5;
