/**
 * Adding, duplicating and removing widget instances from the web UI, with
 * feedback toasts. Writes go through useAppState (optimistic, then synced).
 */
import { useAppState } from '../state/appState';
import { layoutActions } from '../state/dataActions';
import { bottomOf, sanitizeWidgets } from '../state/defaults';
import type { StateOp, WidgetInstance } from '../state/types';
import type { WidgetManifest } from '../types/widget';
import { uid } from '../utils/uid';
import { getManifest } from '../widgets/catalog';
import { compactWidgets } from './kioskGrid';
import { withoutSecrets } from './secrets';
import { toast } from './ui/toast';

/**
 * Widget list with `widget` appended below all others, compacted like the
 * kiosk shows it – so stored positions match what the user sees.
 */
function withAppended(widgets: readonly WidgetInstance[], widget: WidgetInstance, cols: number): WidgetInstance[] {
  return compactWidgets(sanitizeWidgets([...widgets, { ...widget, y: bottomOf(widgets) }], cols), cols);
}

/** The manifest allows only one instance and it is already placed. */
export function isSingletonPlaced(manifest: WidgetManifest, widgets: readonly WidgetInstance[]): boolean {
  return manifest.singleton === true && widgets.some((w) => w.widgetId === manifest.id);
}

/** Places a new instance below all others (moving up into a free gap, like on the kiosk) with the manifest's default size. Returns its id. */
export function addWidget(manifest: WidgetManifest): string | null {
  const { widgets, cols } = useAppState.getState().state.layout;
  if (isSingletonPlaced(manifest, widgets)) {
    toast.info(`«${manifest.name}» kann nur einmal platziert werden`);
    return null;
  }
  const w = Math.min(cols, Math.max(1, manifest.minWidth, manifest.defaultWidth));
  const h = Math.max(1, manifest.minHeight, manifest.defaultHeight);
  const instanceId = `${manifest.id}-${uid()}`;
  void layoutActions
    .setWidgets(withAppended(widgets, { instanceId, widgetId: manifest.id, x: 0, y: 0, w, h }, cols))
    .then((ok) => {
      if (ok) toast.success(`«${manifest.name}» hinzugefügt`);
    });
  return instanceId;
}

/**
 * Copies an instance (size and settings) to a new instanceId below all
 * others – one write, so the kiosk never shows the copy without settings.
 * Returns the new id.
 */
export function duplicateWidget(instance: WidgetInstance, label: string): string | null {
  const manifest = getManifest(instance.widgetId);
  const { state, apply } = useAppState.getState();
  if (manifest && isSingletonPlaced(manifest, state.layout.widgets)) {
    toast.info(`«${manifest.name}» kann nur einmal platziert werden`);
    return null;
  }

  const instanceId = `${instance.widgetId}-${uid()}`;
  const ops: StateOp[] = [];
  const settings = state.widgetSettings[instance.instanceId];
  // Stored secrets only exist at their original place on the kiosk.
  const copy = settings ? withoutSecrets(settings) : null;
  if (copy) ops.push({ op: 'set', path: ['widgetSettings', instanceId], value: copy.value });
  const widgets = withAppended(
    state.layout.widgets,
    { instanceId, widgetId: instance.widgetId, x: instance.x, y: 0, w: instance.w, h: instance.h },
    state.layout.cols,
  );
  ops.push({ op: 'set', path: ['layout', 'widgets'], value: widgets });

  void apply(ops).then((ok) => {
    if (!ok) return;
    if (copy?.dropped) toast.warning(`«${label}» dupliziert – Passwörter und Schlüssel im Duplikat bitte neu eingeben`);
    else toast.success(`«${label}» dupliziert`);
  });
  return instanceId;
}

/** Removes the instance and its settings. */
export async function removeWidget(instanceId: string, label: string): Promise<boolean> {
  const ok = await layoutActions.remove(instanceId);
  if (ok) toast.success(`«${label}» entfernt`);
  return ok;
}
