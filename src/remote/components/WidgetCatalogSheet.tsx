import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { WidgetIcon } from '../../components/settings/WidgetIcon';
import { useAppState } from '../../state/appState';
import type { WidgetCategory, WidgetManifest } from '../../types/widget';
import { FALLBACK_CATEGORY, WIDGET_CATEGORIES, widgetCatalog } from '../../widgets/catalog';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { EmptyState, Modal } from '../ui';
import { isSingletonPlaced } from '../widgetActions';

export interface WidgetCatalogSheetProps {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen widget; the caller places it and closes the sheet. */
  onAdd: (manifest: WidgetManifest) => void;
}

interface CatalogGroup {
  category: WidgetCategory;
  items: WidgetManifest[];
}

/** Lower case without accents, so «buro» finds «Büro». */
const normalize = (text: string): string =>
  text
    .toLocaleLowerCase('de-CH')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

function groupCatalog(query: string): CatalogGroup[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  const matches = (manifest: WidgetManifest) => {
    const haystack = normalize(`${manifest.name} ${manifest.description} ${manifest.category ?? FALLBACK_CATEGORY}`);
    return terms.every((term) => haystack.includes(term));
  };
  return WIDGET_CATEGORIES.map((category) => ({
    category,
    items: widgetCatalog.filter((m) => (m.category ?? FALLBACK_CATEGORY) === category && matches(m)),
  })).filter((group) => group.items.length > 0);
}

function CatalogContent({ onAdd }: Pick<WidgetCatalogSheetProps, 'onAdd'>) {
  const widgets = useAppState((s) => s.state.layout.widgets);
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupCatalog(query), [query]);
  // On phones the keyboard would cover the list – only focus with a mouse.
  const finePointer = useMediaQuery('(pointer: fine)');

  return (
    <div className="r-catalog">
      <label className="r-search">
        <Search size={18} aria-hidden="true" />
        <span className="r-sr-only">Widgets durchsuchen</span>
        <input
          type="search"
          value={query}
          placeholder="Widgets durchsuchen"
          onChange={(event) => setQuery(event.target.value)}
          data-autofocus={finePointer ? true : undefined}
          autoComplete="off"
          enterKeyHint="search"
        />
      </label>

      {groups.length === 0 ? (
        <EmptyState icon={Search} title="Keine Treffer" description={`Kein Widget passt zu «${query.trim()}».`} compact />
      ) : (
        groups.map((group) => (
          <section key={group.category} className="r-catalog-group" aria-label={group.category}>
            <h3 className="r-catalog-category">{group.category}</h3>
            <ul className="r-catalog-list">
              {group.items.map((manifest) => {
                const placed = isSingletonPlaced(manifest, widgets);
                return (
                  <li key={manifest.id}>
                    <button
                      type="button"
                      className="r-catalog-item"
                      disabled={placed}
                      onClick={() => onAdd(manifest)}
                    >
                      <span className="r-catalog-icon" aria-hidden="true">
                        <WidgetIcon name={manifest.icon} size={22} />
                      </span>
                      <span className="r-catalog-text">
                        <span className="r-catalog-name">{manifest.name}</span>
                        <span className="r-catalog-description">{manifest.description}</span>
                      </span>
                      <span className="r-catalog-meta">
                        {placed ? 'Bereits platziert' : `${manifest.defaultWidth}×${manifest.defaultHeight}`}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

/** Bottom sheet with all widgets grouped by category, searchable; singletons that are placed are disabled. */
export function WidgetCatalogSheet({ open, onClose, onAdd }: WidgetCatalogSheetProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Widget hinzufügen"
      description="Neue Widgets erscheinen unten auf dem Kiosk und lassen sich danach im Layout verschieben."
      variant="sheet"
      size="lg"
    >
      <CatalogContent onAdd={onAdd} />
    </Modal>
  );
}
