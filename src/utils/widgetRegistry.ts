/**
 * Widget Registry
 * 
 * Central registry for all available widgets.
 * To add a new widget:
 * 1. Create a component in src/widgets/
 * 2. Create a WidgetDefinition with manifest + component
 * 3. Call registerWidget() in this file
 * 
 * The registry is used by the Dashboard to render widgets
 * and by the Widget Picker to display available widgets.
 */
import type { WidgetDefinition } from '../types/widget';

const registry = new Map<string, WidgetDefinition>();

export const registerWidget = (definition: WidgetDefinition): void => {
  if (registry.has(definition.manifest.id)) {
    console.warn(`Widget "${definition.manifest.id}" is already registered. Overwriting.`);
  }
  registry.set(definition.manifest.id, definition);
};

export const getWidget = (id: string): WidgetDefinition | undefined => {
  return registry.get(id);
};

export const getAllWidgets = (): WidgetDefinition[] => {
  return Array.from(registry.values());
};

export const getWidgetIds = (): string[] => {
  return Array.from(registry.keys());
};
