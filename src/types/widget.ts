/**
 * SlateDesk Widget Type Definitions
 * 
 * Defines the core types for the widget system.
 * New widgets must implement the WidgetDefinition interface.
 */

export interface WidgetManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  minWidth: number;
  minHeight: number;
  defaultWidth: number;
  defaultHeight: number;
  permissions: string[];
  refreshInterval?: number; // in seconds
  hasSettings?: boolean; // whether this widget has a settings dialog
}

export interface WidgetInstance {
  instanceId: string;
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetDefinition {
  manifest: WidgetManifest;
  component: React.ComponentType<WidgetProps>;
}

export interface WidgetProps {
  instanceId: string;
  width: number;
  height: number;
}

export type ThemeMode = 'light' | 'dark';

export interface LayoutConfig {
  widgets: WidgetInstance[];
  cols: number;
  rowHeight: number;
}
