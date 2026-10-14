/**
 * Layout: grid editor for the kiosk dashboard, true to scale (screen size
 * from /api/system, same metrics as the kiosk Dashboard). Drag at the grip,
 * resize at the bottom-right corner – or select a tile and use the buttons.
 * On touch screens only the selected tile can be dragged or resized: the
 * preview fills the phone's width, and a swipe to scroll must never move a
 * widget on the live kiosk. The layout is written only when a drag/resize
 * ends (never from onLayoutChange, which also fires for render echoes and
 * compaction), with «Rückgängig» in the toast.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  GridLayout,
  cloneLayout,
  moveElement,
  useContainerWidth,
  verticalCompactor,
  type EventCallback,
  type Layout,
  type LayoutItem,
} from 'react-grid-layout';
import type { DragConfig, GridConfig, ResizeConfig } from 'react-grid-layout/core';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Copy,
  GripVertical,
  LayoutGrid,
  Minus,
  Plus,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import { WidgetIcon } from '../../components/settings/WidgetIcon';
import { useAppState } from '../../state/appState';
import { layoutActions } from '../../state/dataActions';
import { MAX_WIDGET_ROWS } from '../../state/defaults';
import type { WidgetInstance } from '../../state/types';
import { GRID_CONTAINER_PADDING, GRID_MARGIN } from '../../types/grid';
import type { WidgetManifest } from '../../types/widget';
import { getManifest } from '../../widgets/catalog';
import { WidgetCatalogSheet } from '../components/WidgetCatalogSheet';
import { useDisplayedWidgets } from '../hooks/useDisplayedWidgets';
import { useLocalChoice } from '../hooks/useLocalChoice';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useSystemInfo } from '../hooks/useSystemInfo';
import { contentHeight, kioskRowHeight, usableViewport } from '../kioskGrid';
import { href, navigate } from '../router';
import { Button, Card, ConfirmDialog, EmptyState, Notice, PageHeader, Segmented, toast, type SegmentedOption } from '../ui';
import { addWidget, duplicateWidget, removeWidget } from '../widgetActions';
import { positionText, sizeText } from '../widgetInfo';

const VIEWPORT_POLL_MS = 60_000;
const RESIZE_HANDLES: ResizeConfig['handles'] = ['se'];
const ZOOM_STORAGE_KEY = 'slatedesk-remote:layout-zoom';
const ZOOM_LEVELS = [1, 1.5, 2] as const;
type Zoom = (typeof ZOOM_LEVELS)[number];
const ZOOM_OPTIONS: readonly SegmentedOption<Zoom>[] = ZOOM_LEVELS.map((zoom) => ({ value: zoom, label: `${zoom * 100} %` }));
/** Room below the screen edge, so the «Bildschirmende» line and label stay visible. */
const FOLD_SPACE_PX = 28;
/** A press that moves less than this is a tap (select), not a drag. */
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 600;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Grip of any tile (mouse) – on touch screens only of the selected one, the others scroll the page. */
const DRAG_HANDLE = '.rl-handle';
const SELECTED_DRAG_HANDLE = '.rl-item.is-selected .rl-handle';

/** Writes a dragged/resized layout and offers to undo it – the kiosk shows the change at once. */
function persistLayout(items: Layout, message: string): void {
  const before = useAppState.getState().state.layout.widgets;
  void layoutActions.update(items);
  // The write is optimistic: a changed layout is visible in the store right away.
  if (useAppState.getState().state.layout.widgets === before) return;
  toast.info(message, {
    action: {
      label: 'Rückgängig',
      run: () => {
        void layoutActions.setWidgets(before).then((ok) => {
          if (ok) toast.success('Änderung rückgängig gemacht');
        });
      },
    },
  });
}

// ── Layout operations for the selection panel ──────────────────────────────
// The kiosk grid compacts vertically, so «one row down» would snap right
// back. Up/down therefore swap with the nearest widget above/below (same
// columns); everything ends with the same compaction the grid applies.

type Direction = 'left' | 'right' | 'up' | 'down';

interface Moves {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  narrower: boolean;
  wider: boolean;
  lower: boolean;
  taller: boolean;
}

const sharesColumns = (a: LayoutItem, b: LayoutItem): boolean => a.x < b.x + b.w && b.x < a.x + a.w;

/** Nearest widget directly above/below `item` that shares a column with it. */
function neighbour(layout: Layout, item: LayoutItem, direction: 'up' | 'down'): LayoutItem | null {
  let best: LayoutItem | null = null;
  for (const other of layout) {
    if (other.i === item.i || !sharesColumns(item, other)) continue;
    if (direction === 'down' && other.y >= item.y + item.h && (!best || other.y < best.y)) best = other;
    if (direction === 'up' && other.y + other.h <= item.y && (!best || other.y + other.h > best.y + best.h)) best = other;
  }
  return best;
}

function availableMoves(layout: Layout, id: string, cols: number): Moves | null {
  const item = layout.find((l) => l.i === id);
  if (!item) return null;
  return {
    left: item.x > 0,
    right: item.x + item.w < cols,
    up: neighbour(layout, item, 'up') !== null,
    down: neighbour(layout, item, 'down') !== null,
    narrower: item.w > Math.max(1, item.minW ?? 1),
    wider: item.w < Math.min(item.maxW ?? cols, cols - item.x),
    lower: item.h > Math.max(1, item.minH ?? 1),
    taller: item.h < MAX_WIDGET_ROWS,
  };
}

/** `layout` must be compacted (what the kiosk shows). */
function moveItem(layout: Layout, id: string, direction: Direction, cols: number): Layout | null {
  const items = cloneLayout(layout);
  const item = items.find((l) => l.i === id);
  if (!item) return null;
  let { x, y } = item;
  if (direction === 'left') x -= 1;
  if (direction === 'right') x += 1;
  if (direction === 'up' || direction === 'down') {
    const other = neighbour(items, item, direction);
    if (!other) return null;
    // Up: take the neighbour's row (it is pushed below). Down: go below the
    // neighbour; compaction lifts it into the freed space.
    y = direction === 'up' ? other.y : other.y + other.h;
  }
  x = clamp(x, 0, Math.max(0, cols - item.w));
  if (x === item.x && y === item.y) return null;
  return verticalCompactor.compact(moveElement(items, item, x, y, false, false, 'vertical', cols), cols);
}

function resizeItem(layout: Layout, id: string, dw: number, dh: number, cols: number): Layout | null {
  const item = layout.find((l) => l.i === id);
  if (!item) return null;
  const w = clamp(item.w + dw, Math.min(Math.max(1, item.minW ?? 1), cols - item.x), Math.min(item.maxW ?? cols, cols - item.x));
  const h = clamp(item.h + dh, Math.max(1, item.minH ?? 1), MAX_WIDGET_ROWS);
  if (w === item.w && h === item.h) return null;
  return verticalCompactor.compact(
    layout.map((l) => (l.i === id ? { ...l, w, h } : l)),
    cols,
  );
}

// ── Tile ─────────────────────────────────────────────────────────────────────

interface TileProps {
  instance: WidgetInstance;
  label: string;
  manifest: WidgetManifest | undefined;
  selected: boolean;
  /** Live size while resizing. */
  size: { w: number; h: number };
  canDuplicate: boolean;
  onSelect: (instanceId: string) => void;
  onDuplicate: (instance: WidgetInstance) => void;
  onRemove: (instance: WidgetInstance) => void;
}

const LayoutTile = memo(function LayoutTile({
  instance,
  label,
  manifest,
  selected,
  size,
  canDuplicate,
  onSelect,
  onDuplicate,
  onRemove,
}: TileProps) {
  const pressStart = useRef<{ x: number; y: number; time: number } | null>(null);
  const select = () => onSelect(instance.instanceId);

  // The grip is the drag handle; react-draggable cancels its touch events,
  // so a tap is recognized from the pointer events instead of a click.
  const onPointerDown = (event: PointerEvent) => {
    pressStart.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = pressStart.current;
    pressStart.current = null;
    if (!start) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance < TAP_SLOP_PX && event.timeStamp - start.time < TAP_MAX_MS) select();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      select();
    }
  };

  return (
    <div className={`rl-tile${selected ? ' is-selected' : ''}${manifest ? '' : ' is-unknown'}`} data-instance={instance.instanceId}>
      <div
        className="rl-tile-head rl-handle"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`${label} (${sizeText(size)}) auswählen – zum Verschieben ziehen`}
        title={`${label} – zum Verschieben ziehen`}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          pressStart.current = null;
        }}
        onKeyDown={onKeyDown}
      >
        <GripVertical className="rl-grip" size={16} aria-hidden="true" />
        <WidgetIcon name={manifest?.icon} className="rl-icon" size={18} />
        <span className="rl-name">{label}</span>
      </div>
      <div className="rl-tile-body" onClick={select}>
        <span className="rl-size">{sizeText(size)}</span>
        <div className="rl-actions rl-nodrag">
          <a
            className="rl-action"
            href={href('widgets', instance.instanceId)}
            title="Einstellungen"
            aria-label={`${label}: Einstellungen`}
            onClick={(event) => event.stopPropagation()}
          >
            <Settings2 size={16} aria-hidden="true" />
          </a>
          <button
            type="button"
            className="rl-action"
            title="Duplizieren"
            aria-label={`${label} duplizieren`}
            disabled={!canDuplicate}
            onClick={(event) => {
              event.stopPropagation();
              onDuplicate(instance);
            }}
          >
            <Copy size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="rl-action rl-action-danger"
            title="Entfernen"
            aria-label={`${label} entfernen`}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(instance);
            }}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
});

// ── Selection panel ──────────────────────────────────────────────────────────

interface SelectionPanelProps {
  instance: WidgetInstance;
  label: string;
  manifest: WidgetManifest | undefined;
  canDuplicate: boolean;
  moves: Moves;
  onMove: (direction: Direction) => void;
  onResize: (dw: number, dh: number) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onClose: () => void;
}

function SelectionPanel({
  instance,
  label,
  manifest,
  canDuplicate,
  moves,
  onMove,
  onResize,
  onDuplicate,
  onRemove,
  onClose,
}: SelectionPanelProps) {
  return (
    <Card
      className="rl-selection"
      title={
        <span className="r-inline-status">
          <WidgetIcon name={manifest?.icon} size={18} />
          {label}
        </span>
      }
      subtitle={`${positionText(instance)} · Grösse ${sizeText(instance)}`}
      actions={
        <Button variant="ghost" iconOnly icon={X} onClick={onClose}>
          Auswahl aufheben
        </Button>
      }
    >
      <div className="rl-selection-actions">
        <Button icon={Settings2} onClick={() => navigate(href('widgets', instance.instanceId))}>
          Einstellungen
        </Button>
        <Button icon={Copy} onClick={onDuplicate} disabled={!canDuplicate}>
          Duplizieren
        </Button>
        <Button icon={Trash2} variant="danger" onClick={onRemove}>
          Entfernen
        </Button>
      </div>
      <div className="rl-controls">
        <div className="rl-control" role="group" aria-label="Verschieben">
          <span className="rl-control-label">Verschieben</span>
          <div className="rl-control-buttons">
            <Button iconOnly icon={ArrowLeft} disabled={!moves.left} onClick={() => onMove('left')}>
              Nach links
            </Button>
            <Button iconOnly icon={ArrowUp} disabled={!moves.up} onClick={() => onMove('up')}>
              Nach oben
            </Button>
            <Button iconOnly icon={ArrowDown} disabled={!moves.down} onClick={() => onMove('down')}>
              Nach unten
            </Button>
            <Button iconOnly icon={ArrowRight} disabled={!moves.right} onClick={() => onMove('right')}>
              Nach rechts
            </Button>
          </div>
        </div>
        <div className="rl-control" role="group" aria-label="Breite">
          <span className="rl-control-label">Breite</span>
          <div className="rl-control-buttons">
            <Button iconOnly icon={Minus} disabled={!moves.narrower} onClick={() => onResize(-1, 0)}>
              Schmaler
            </Button>
            <span className="rl-control-value">{instance.w}</span>
            <Button iconOnly icon={Plus} disabled={!moves.wider} onClick={() => onResize(1, 0)}>
              Breiter
            </Button>
          </div>
        </div>
        <div className="rl-control" role="group" aria-label="Höhe">
          <span className="rl-control-label">Höhe</span>
          <div className="rl-control-buttons">
            <Button iconOnly icon={Minus} disabled={!moves.lower} onClick={() => onResize(0, -1)}>
              Niedriger
            </Button>
            <span className="rl-control-value">{instance.h}</span>
            <Button iconOnly icon={Plus} disabled={!moves.taller} onClick={() => onResize(0, 1)}>
              Höher
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

interface LiveSize {
  i: string;
  w: number;
  h: number;
}

export function LayoutPage() {
  const widgets = useAppState((s) => s.state.layout.widgets);
  // What the kiosk shows (compacted) – for heights, labels and positions.
  const displayed = useDisplayedWidgets();
  const cols = useAppState((s) => s.state.layout.cols);
  const rowHeightSetting = useAppState((s) => s.state.layout.rowHeight);
  const fitRows = useAppState((s) => s.state.layout.fitRows);
  const system = useSystemInfo(VIEWPORT_POLL_MS);
  const knownViewport = system.data?.viewport ?? null;
  const touch = useMediaQuery('(pointer: coarse)');
  const screen = usableViewport(knownViewport);

  const [zoom, setZoom] = useLocalChoice<Zoom>(ZOOM_STORAGE_KEY, ZOOM_LEVELS, 1);
  const { width: containerWidth, mounted, containerRef } = useContainerWidth({ measureBeforeMount: true });
  const width = Math.floor(containerWidth * zoom);
  const scale = width > 0 ? width / screen.width : 0;
  const kioskRow = kioskRowHeight({ rowHeight: rowHeightSetting, fitRows }, screen);
  const screenHeight = screen.height * scale;
  const gridHeight = contentHeight(displayed.widgets, kioskRow) * scale;
  const showFold = fitRows === 0 || gridHeight > screenHeight + 1;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveSize, setLiveSize] = useState<LiveSize | null>(null);
  const [removeTarget, setRemoveTarget] = useState<WidgetInstance | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const scrollTarget = useRef<string | null>(null);

  const { labels } = displayed;
  const selected = displayed.widgets.find((w) => w.instanceId === selectedId) ?? null;
  const labelOf = useCallback((instance: WidgetInstance) => labels.get(instance.instanceId) ?? instance.widgetId, [labels]);

  const layout = useMemo<Layout>(
    () =>
      widgets.map((w) => {
        const manifest = getManifest(w.widgetId);
        return {
          i: w.instanceId,
          x: w.x,
          y: w.y,
          w: w.w,
          h: w.h,
          minW: clamp(manifest?.minWidth ?? 1, 1, cols),
          minH: Math.max(1, manifest?.minHeight ?? 1),
          maxW: cols,
        };
      }),
    [widgets, cols],
  );
  // What the kiosk shows – the base for the selection panel's moves.
  const shownLayout = useMemo(() => verticalCompactor.compact(layout, cols), [layout, cols]);

  const gridConfig = useMemo<Partial<GridConfig>>(
    () => ({
      cols,
      rowHeight: kioskRow * scale,
      margin: [GRID_MARGIN[0] * scale, GRID_MARGIN[1] * scale],
      containerPadding: [GRID_CONTAINER_PADDING[0] * scale, GRID_CONTAINER_PADDING[1] * scale],
    }),
    [cols, kioskRow, scale],
  );

  const dragConfig = useMemo<Partial<DragConfig>>(
    () => ({
      enabled: true,
      handle: touch ? SELECTED_DRAG_HANDLE : DRAG_HANDLE,
      cancel: '.rl-nodrag',
      bounded: false,
      threshold: 4,
    }),
    [touch],
  );
  const resizeConfig = useMemo<Partial<ResizeConfig>>(() => ({ enabled: true, handles: RESIZE_HANDLES }), []);

  const onDragStart = useCallback<EventCallback>((_layout, oldItem) => {
    if (oldItem) setSelectedId(oldItem.i);
  }, []);
  const onResize = useCallback<EventCallback>((_layout, _oldItem, newItem) => {
    if (!newItem) return;
    setLiveSize((prev) =>
      prev && prev.i === newItem.i && prev.w === newItem.w && prev.h === newItem.h ? prev : { i: newItem.i, w: newItem.w, h: newItem.h },
    );
  }, []);
  const onDragStop = useCallback<EventCallback>((finalLayout) => {
    persistLayout(finalLayout, 'Widget verschoben');
  }, []);
  const onResizeStop = useCallback<EventCallback>((finalLayout) => {
    setLiveSize(null);
    persistLayout(finalLayout, 'Grösse geändert');
  }, []);

  const duplicate = useCallback(
    (instance: WidgetInstance) => {
      const id = duplicateWidget(instance, labelOf(instance));
      if (id) {
        scrollTarget.current = id;
        setSelectedId(id);
      }
    },
    [labelOf],
  );

  const add = (manifest: WidgetManifest) => {
    const id = addWidget(manifest);
    setCatalogOpen(false);
    if (id) {
      scrollTarget.current = id;
      setSelectedId(id);
    }
  };

  const confirmRemove = () => {
    if (!removeTarget) return;
    const target = removeTarget;
    setRemoveTarget(null);
    if (selectedId === target.instanceId) setSelectedId(null);
    void removeWidget(target.instanceId, labelOf(target));
  };

  const applyLayout = (next: Layout | null) => {
    if (next) void layoutActions.update(next);
  };

  // Bring a newly added or duplicated tile into view once it is rendered.
  useEffect(() => {
    const id = scrollTarget.current;
    if (!id) return;
    const element = document.querySelector<HTMLElement>(`[data-instance="${CSS.escape(id)}"]`);
    if (!element) return;
    scrollTarget.current = null;
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }, [widgets, mounted, width]);

  const children = useMemo(
    () =>
      widgets.map((instance) => {
        const manifest = getManifest(instance.widgetId);
        const size = liveSize && liveSize.i === instance.instanceId ? liveSize : instance;
        // The grid merges this class into its item (drag handle and resize corner on touch screens).
        return (
          <div key={instance.instanceId} className={`rl-item${instance.instanceId === selectedId ? ' is-selected' : ''}`}>
            <LayoutTile
              instance={instance}
              label={labelOf(instance)}
              manifest={manifest}
              selected={instance.instanceId === selectedId}
              size={size}
              canDuplicate={!manifest?.singleton}
              onSelect={setSelectedId}
              onDuplicate={duplicate}
              onRemove={setRemoveTarget}
            />
          </div>
        );
      }),
    [widgets, liveSize, selectedId, labelOf, duplicate],
  );

  const canRender = mounted && width > 0;
  const gridInfo = `${screen.width} × ${screen.height} px · ${cols} Spalten · ${
    fitRows > 0 ? `${fitRows} Zeilen eingepasst` : `Zeilenhöhe ${rowHeightSetting} px`
  }`;
  const selectedManifest = selected ? getManifest(selected.widgetId) : undefined;
  const selectedMoves = selected ? availableMoves(shownLayout, selected.instanceId, cols) : null;

  return (
    <div className="r-page r-page-wide">
      <PageHeader
        title="Layout"
        description="Widgets anordnen und in der Grösse ändern – Änderungen erscheinen sofort am Kiosk."
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCatalogOpen(true)}>
            Widget hinzufügen
          </Button>
        }
      />

      <div className="rl-toolbar">
        <p className="rl-info">{gridInfo}</p>
        <Segmented label="Zoom" value={zoom} options={ZOOM_OPTIONS} onChange={setZoom} />
      </div>

      {!knownViewport && (
        <Notice tone="info">
          {system.error
            ? `Bildschirmgrösse des Kiosks nicht verfügbar (${system.error}) – Vorschau im Format 16:9.`
            : 'Der Kiosk hat seine Bildschirmgrösse noch nicht gemeldet – Vorschau im Format 16:9.'}
        </Notice>
      )}

      <div ref={containerRef} className={`rl-scroller${zoom > 1 ? ' is-zoomed' : ''}`}>
        {canRender && (
          <div
            className="rl-canvas"
            style={{ width, minHeight: Math.max(screenHeight + (showFold ? FOLD_SPACE_PX : 0), gridHeight) }}
          >
            <div className="rl-screen" style={{ height: screenHeight }} aria-hidden="true" />
            {showFold && (
              <div className="rl-fold" style={{ top: screenHeight }} aria-hidden="true">
                <span>Bildschirmende Kiosk</span>
              </div>
            )}
            {widgets.length === 0 && (
              <div className="rl-empty" style={{ height: screenHeight }}>
                <EmptyState
                  icon={LayoutGrid}
                  title="Noch keine Widgets"
                  description="Mit «Widget hinzufügen» das erste Widget platzieren."
                  compact
                />
              </div>
            )}
            <GridLayout
              className="rl-grid"
              width={width}
              layout={layout}
              gridConfig={gridConfig}
              dragConfig={dragConfig}
              resizeConfig={resizeConfig}
              compactor={verticalCompactor}
              onDragStart={onDragStart}
              onDragStop={onDragStop}
              onResizeStart={onDragStart}
              onResize={onResize}
              onResizeStop={onResizeStop}
            >
              {children}
            </GridLayout>
          </div>
        )}
      </div>

      {touch ? (
        <p className="r-hint">
          Antippen wählt ein Widget aus – darunter erscheinen weitere Aktionen. Das ausgewählte Widget lässt sich am Griff
          verschieben und an der Ecke unten rechts in der Grösse ändern; über den übrigen Widgets wird die Seite gescrollt.
        </p>
      ) : (
        <p className="r-hint">
          Am Griff <GripVertical size={14} aria-hidden="true" className="r-hint-icon" /> ziehen verschiebt ein Widget, die
          Ecke unten rechts ändert seine Grösse. Antippen wählt es aus – darunter erscheinen weitere Aktionen.
        </p>
      )}

      {selected && selectedMoves && (
        <SelectionPanel
          instance={selected}
          label={labelOf(selected)}
          manifest={selectedManifest}
          canDuplicate={!selectedManifest?.singleton}
          moves={selectedMoves}
          onMove={(direction) => applyLayout(moveItem(shownLayout, selected.instanceId, direction, cols))}
          onResize={(dw, dh) => applyLayout(resizeItem(shownLayout, selected.instanceId, dw, dh, cols))}
          onDuplicate={() => duplicate(selected)}
          onRemove={() => setRemoveTarget(selected)}
          onClose={() => setSelectedId(null)}
        />
      )}

      <WidgetCatalogSheet open={catalogOpen} onClose={() => setCatalogOpen(false)} onAdd={add} />
      <ConfirmDialog
        open={removeTarget !== null}
        title="Widget entfernen?"
        message={
          removeTarget
            ? `«${labelOf(removeTarget)}» wird vom Kiosk entfernt. Seine Einstellungen werden ebenfalls gelöscht.`
            : undefined
        }
        confirmLabel="Entfernen"
        onConfirm={confirmRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
