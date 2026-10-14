/**
 * WidgetPicker – "Widget hinzufügen" popover of the top bar (edit mode only).
 * Grouped by category, searchable; singletons that are already placed are
 * disabled. Closes on Escape, outside click and after adding. A new widget
 * goes into the first gap it fits, else below all others, and is scrolled
 * into view.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { firstFreeSlot } from '../state/defaults';
import { useLayoutStore } from '../store/layoutStore';
import type { WidgetCategory, WidgetManifest } from '../types/widget';
import { uid } from '../utils/uid';
import { getAllWidgets } from '../utils/widgetRegistry';
import { FALLBACK_CATEGORY, WIDGET_CATEGORIES } from '../widgets/catalog';
import { WidgetIcon } from './settings/WidgetIcon';

interface Props {
  onClose: () => void;
  /** Toggle button – clicks on it are not "outside" (it toggles by itself). */
  anchorRef: React.RefObject<HTMLElement | null>;
}

const normalize = (text: string): string =>
  text.toLocaleLowerCase('de-CH').normalize('NFD').replace(/[̀-ͯ]/g, '');

function matches(manifest: WidgetManifest, query: string): boolean {
  if (!query) return true;
  const haystack = normalize(`${manifest.name} ${manifest.description} ${manifest.category ?? ''}`);
  return normalize(query)
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

export const WidgetPicker: React.FC<Props> = ({ onClose, anchorRef }) => {
  const widgets = useLayoutStore((s) => s.widgets);
  const cols = useLayoutStore((s) => s.cols);
  const addWidget = useLayoutStore((s) => s.addWidget);
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose, anchorRef]);

  const placed = useMemo(() => new Set(widgets.map((w) => w.widgetId)), [widgets]);

  const groups = useMemo(() => {
    const byCategory = new Map<WidgetCategory, WidgetManifest[]>();
    for (const { manifest } of getAllWidgets()) {
      if (!matches(manifest, query.trim())) continue;
      const category = manifest.category ?? FALLBACK_CATEGORY;
      byCategory.set(category, [...(byCategory.get(category) ?? []), manifest]);
    }
    return WIDGET_CATEGORIES.filter((category) => byCategory.has(category)).map((category) => ({
      category,
      manifests: [...(byCategory.get(category) ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'de-CH')),
    }));
  }, [query]);

  const add = (manifest: WidgetManifest) => {
    const w = Math.min(Math.max(manifest.defaultWidth, manifest.minWidth, 1), cols);
    const h = Math.max(manifest.defaultHeight, manifest.minHeight, 1);
    // Into a gap where it fits, else below everything; the new widget then
    // scrolls itself into view (WidgetWrapper) – a full screen has no gap.
    addWidget({ instanceId: `${manifest.id}-${uid()}`, widgetId: manifest.id, ...firstFreeSlot(widgets, cols, w, h), w, h });
    onClose();
  };

  return (
    <div ref={panelRef} className="widget-picker" role="dialog" aria-label="Widget hinzufügen">
      <div className="widget-picker-search">
        <Search size={16} />
        <input
          type="search"
          value={query}
          placeholder="Widget suchen…"
          aria-label="Widget suchen"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="widget-picker-list">
        {groups.length === 0 && <div className="widget-picker-empty">Kein Widget gefunden</div>}
        {groups.map(({ category, manifests }) => (
          <div key={category} role="group" aria-label={category}>
            <div className="widget-picker-category">{category}</div>
            {manifests.map((manifest) => {
              const blocked = manifest.singleton === true && placed.has(manifest.id);
              return (
                <button
                  key={manifest.id}
                  type="button"
                  className="widget-picker-item"
                  disabled={blocked}
                  onClick={() => add(manifest)}
                >
                  <span className="widget-picker-icon">
                    <WidgetIcon name={manifest.icon} size={20} />
                  </span>
                  <span className="widget-picker-text">
                    <span className="widget-picker-name">{manifest.name}</span>
                    <span className="widget-picker-description">
                      {blocked ? 'Bereits auf dem Dashboard (nur einmal möglich)' : manifest.description}
                    </span>
                  </span>
                  <span className="widget-picker-size">
                    {Math.min(manifest.defaultWidth, cols)}×{manifest.defaultHeight}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
