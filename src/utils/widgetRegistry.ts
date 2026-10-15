/**
 * Widget Registry – kiosk lookup of widget definitions (manifest + component).
 *
 * Filled once at startup by `initializeWidgets()` (src/widgets/index.ts).
 * Code that only needs metadata (and the web UI) uses src/widgets/catalog.ts.
 */
import type { WidgetDefinition } from '../types/widget';
import { withCommonSettings } from '../widgets/commonSettings';

const registry = new Map<string, WidgetDefinition>();

export const registerWidget = (definition: WidgetDefinition): void => {
  if (registry.has(definition.manifest.id)) {
    console.warn(`Widget "${definition.manifest.id}" is already registered. Overwriting.`);
  }
  // Same manifest as in the catalog: with the common settings (Darstellung).
  registry.set(definition.manifest.id, { ...definition, manifest: withCommonSettings(definition.manifest) });
};

export const getWidget = (id: string): WidgetDefinition | undefined => registry.get(id);

export const getAllWidgets = (): WidgetDefinition[] => Array.from(registry.values());
