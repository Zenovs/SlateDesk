import { WidgetIcon } from '../../components/settings/WidgetIcon';
import { useAppState } from '../../state/appState';
import { getManifest } from '../../widgets/catalog';
import { useDisplayedWidgets } from '../hooks/useDisplayedWidgets';
import { contentHeight, kioskRowHeight, usableViewport, widgetRect, type Viewport } from '../kioskGrid';

export interface LayoutMiniMapProps {
  /** Kiosk grid area; null → 16:9 is assumed. */
  viewport: Viewport | null;
  onSelect: (instanceId: string) => void;
}

const percent = (value: number, total: number): string => `${(value / total) * 100}%`;

/**
 * Live miniature of the kiosk screen in its aspect ratio: one box per
 * widget (icon + name). Content below the screen edge is shown under a
 * dashed «Bildschirmende» line.
 */
export function LayoutMiniMap({ viewport, onSelect }: LayoutMiniMapProps) {
  const { widgets, labels } = useDisplayedWidgets();
  const cols = useAppState((s) => s.state.layout.cols);
  const rowHeightSetting = useAppState((s) => s.state.layout.rowHeight);
  const fitRows = useAppState((s) => s.state.layout.fitRows);

  const screen = usableViewport(viewport);
  const rowHeight = kioskRowHeight({ rowHeight: rowHeightSetting, fitRows }, screen);
  const total = Math.max(screen.height, contentHeight(widgets, rowHeight));
  const overflows = total > screen.height + 0.5;

  return (
    <div className="r-minimap" style={{ aspectRatio: `${screen.width} / ${total}` }}>
      <div className="r-minimap-screen" style={{ height: percent(screen.height, total) }} aria-hidden="true" />
      {overflows && (
        <div className="r-minimap-fold" style={{ top: percent(screen.height, total) }} aria-hidden="true">
          <span>Bildschirmende</span>
        </div>
      )}
      {widgets.map((widget) => {
        const rect = widgetRect(widget, cols, rowHeight, screen);
        const label = labels.get(widget.instanceId) ?? widget.widgetId;
        return (
          <button
            key={widget.instanceId}
            type="button"
            className="r-minimap-item"
            style={{
              left: percent(rect.left, screen.width),
              top: percent(rect.top, total),
              width: percent(rect.width, screen.width),
              height: percent(rect.height, total),
            }}
            onClick={() => onSelect(widget.instanceId)}
            title={label}
            aria-label={`${label} – Einstellungen öffnen`}
          >
            <WidgetIcon name={getManifest(widget.widgetId)?.icon} className="r-minimap-icon" />
            <span className="r-minimap-label">{label}</span>
          </button>
        );
      })}
      {widgets.length === 0 && <p className="r-minimap-empty">Keine Widgets platziert</p>}
    </div>
  );
}
