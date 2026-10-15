/**
 * SlateDesk Widget Type Definitions
 *
 * A widget consists of a pure-data manifest (src/widgets/manifests/<id>.ts,
 * also imported by the web UI) and a React component that is registered for
 * the kiosk in src/widgets/index.ts.
 */
import type { ComponentType } from 'react';
import type { SettingsField } from './settings';

export type { ThemeMode, WidgetInstance } from '../state/types';

export type WidgetCategory =
  | 'Zeit & Kalender'
  | 'Information'
  | 'Medien'
  | 'Netzwerk'
  | 'Sensorik & KI'
  | 'Büro'
  | 'lagra'
  | 'planbar';

export interface WidgetManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category?: WidgetCategory;
  /** lucide-react icon name, e.g. 'Clock'. */
  icon?: string;
  /** Grid units. */
  minWidth: number;
  minHeight: number;
  defaultWidth: number;
  defaultHeight: number;
  permissions: string[];
  /** Seconds. */
  refreshInterval?: number;
  /** Rendered by the core (kiosk dialog and web UI) when present. */
  settingsSchema?: SettingsField[];
  /** Must be a module-level constant – used as stable defaults object. */
  defaultSettings?: Record<string, unknown>;
  /** At most one instance per dashboard (e.g. widgets competing for the camera). */
  singleton?: boolean;
  /** Upper end of «Darstellung → Schriftgrösse» in percent (default 150); 100 for widgets that already fill their area. */
  maxFontScale?: number;
}

export interface WidgetProps {
  instanceId: string;
  /** Grid units – size content from the real pixel size (container queries / useElementSize). */
  width: number;
  height: number;
}

export interface WidgetDefinition {
  manifest: WidgetManifest;
  component: ComponentType<WidgetProps>;
  /** Extra kiosk-only UI below the generic settings form (e.g. connection test). */
  settingsExtra?: ComponentType<{ instanceId: string }>;
}
