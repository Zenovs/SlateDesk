/** Widgets: all instances on the kiosk in reading order → per-instance settings. */
import { useMemo, useState } from 'react';
import { ChevronRight, Plus, Puzzle } from 'lucide-react';
import { WidgetIcon } from '../../components/settings/WidgetIcon';
import { useAppState } from '../../state/appState';
import type { WidgetManifest } from '../../types/widget';
import { getManifest } from '../../widgets/catalog';
import { WidgetCatalogSheet } from '../components/WidgetCatalogSheet';
import { useDisplayedWidgets } from '../hooks/useDisplayedWidgets';
import { href, navigate } from '../router';
import { Button, EmptyState, PageHeader } from '../ui';
import { addWidget } from '../widgetActions';
import { positionText, sizeText, sortByPosition } from '../widgetInfo';

export function WidgetsPage() {
  const { widgets, labels } = useDisplayedWidgets();
  const widgetSettings = useAppState((s) => s.state.widgetSettings);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const sorted = useMemo(() => sortByPosition(widgets), [widgets]);

  const add = (manifest: WidgetManifest) => {
    const id = addWidget(manifest);
    setCatalogOpen(false);
    if (id) navigate(href('widgets', id));
  };

  const addButton = (
    <Button variant="primary" icon={Plus} onClick={() => setCatalogOpen(true)}>
      Widget hinzufügen
    </Button>
  );

  return (
    <div className="r-page">
      <PageHeader title="Widgets" description="Einstellungen der Widgets auf dem Kiosk" actions={addButton} />

      {sorted.length === 0 ? (
        <EmptyState
          icon={Puzzle}
          title="Noch keine Widgets"
          description="Auf dem Kiosk ist noch kein Widget platziert."
          action={addButton}
        />
      ) : (
        <ul className="r-list">
          {sorted.map((instance) => {
            const manifest = getManifest(instance.widgetId);
            const configurable = (manifest?.settingsSchema?.length ?? 0) > 0;
            const customized = Object.keys(widgetSettings[instance.instanceId] ?? {}).length > 0;
            return (
              <li key={instance.instanceId}>
                <a className="r-list-item" href={href('widgets', instance.instanceId)}>
                  <span className="r-list-icon" aria-hidden="true">
                    <WidgetIcon name={manifest?.icon} size={20} />
                  </span>
                  <span className="r-list-text">
                    <span className="r-list-title">{labels.get(instance.instanceId)}</span>
                    <span className="r-list-subtitle">
                      {positionText(instance)} · {sizeText(instance)}
                    </span>
                  </span>
                  {!manifest ? (
                    <span className="r-badge r-badge-warn">Unbekannt</span>
                  ) : !configurable ? (
                    <span className="r-badge">Keine Einstellungen</span>
                  ) : customized ? (
                    <span className="r-badge r-badge-accent">Angepasst</span>
                  ) : null}
                  <ChevronRight className="r-list-chevron" size={18} aria-hidden="true" />
                </a>
              </li>
            );
          })}
        </ul>
      )}

      <WidgetCatalogSheet open={catalogOpen} onClose={() => setCatalogOpen(false)} onAdd={add} />
    </div>
  );
}
