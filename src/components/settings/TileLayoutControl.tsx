/**
 * Editor of a `tileLayout` field: the widget's tiles on a small grid,
 * arranged like the dashboard layout. Drag a tile (on touch screens only the
 * selected one, so a swipe still scrolls the form), resize it at the
 * bottom-right corner, or select it and use the buttons. Every finished
 * change is written at once – the kiosk shows it live. «Automatisch» goes
 * back to the widget's own flow (value null).
 */
import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react';
import { GridLayout, useContainerWidth, verticalCompactor, type EventCallback, type Layout } from 'react-grid-layout';
import type { DragConfig, GridConfig, ResizeConfig } from 'react-grid-layout/core';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Minus, Plus } from 'lucide-react';
import type { SettingsField } from '../../types/settings';
import { availableMoves, moveItem, resizeItem, type Direction } from '../../utils/gridMoves';
import {
  initialTileLayout,
  parseTileLayout,
  resolveTileLayout,
  TILE_COLUMNS_MAX,
  TILE_COLUMNS_MIN,
  TILE_ROWS_MAX,
  type TileLayout,
} from '../../utils/tileLayout';

type TileLayoutField = Extract<SettingsField, { type: 'tileLayout' }>;

export interface TileLayoutControlProps {
  id: string;
  field: TileLayoutField;
  value: unknown;
  set: (value: unknown) => void;
  values: Record<string, unknown>;
}

const ROW_HEIGHT = 64;
const MARGIN: [number, number] = [6, 6];
const PADDING: [number, number] = [0, 0];
const RESIZE_HANDLES: ResizeConfig['handles'] = ['se'];
/** A press that moves less than this is a tap (select), not a drag. */
const TAP_SLOP_PX = 8;
const TAP_MAX_MS = 600;

const COARSE_QUERY = '(pointer: coarse)';

function subscribeCoarse(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const list = window.matchMedia(COARSE_QUERY);
  list.addEventListener('change', onChange);
  return () => list.removeEventListener('change', onChange);
}

/** Touch screen: only the selected tile may be dragged. */
function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(COARSE_QUERY).matches,
    () => false,
  );
}

const toLayout = (grid: Layout, columns: number): TileLayout => ({
  columns,
  items: grid.map((item) => ({ id: item.i, x: item.x, y: item.y, w: item.w, h: item.h })),
});

interface TileProps {
  id: string;
  label: string;
  w: number;
  h: number;
  selected: boolean;
  onSelect: (id: string) => void;
}

function Tile({ id, label, w, h, selected, onSelect }: TileProps) {
  const press = useRef<{ x: number; y: number; time: number } | null>(null);
  // react-draggable cancels the touch events of its handle, so a tap is
  // recognized from the pointer events instead of a click.
  const onPointerDown = (event: PointerEvent) => {
    press.current = { x: event.clientX, y: event.clientY, time: event.timeStamp };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = press.current;
    press.current = null;
    if (!start) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance < TAP_SLOP_PX && event.timeStamp - start.time < TAP_MAX_MS) onSelect(id);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(id);
    }
  };
  return (
    <div
      className={`settings-tiles-tile${selected ? ' is-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${label} (${w}×${h}) auswählen – zum Verschieben ziehen`}
      title={`${label} – zum Verschieben ziehen`}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        press.current = null;
      }}
      onKeyDown={onKeyDown}
    >
      <span className="settings-tiles-name">{label}</span>
      <span className="settings-tiles-size">
        {w}×{h}
      </span>
    </div>
  );
}

interface TileGridProps {
  layout: Layout;
  columns: number;
  touch: boolean;
  labels: ReadonlyMap<string, string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onStop: (grid: Layout) => void;
}

/** Its own component: useContainerWidth starts measuring when it mounts, i.e. with the frame. */
function TileGrid({ layout, columns, touch, labels, selectedId, onSelect, onStop }: TileGridProps) {
  const { width, mounted, containerRef } = useContainerWidth({ measureBeforeMount: true });
  const gridConfig = useMemo<Partial<GridConfig>>(
    () => ({ cols: columns, rowHeight: ROW_HEIGHT, margin: MARGIN, containerPadding: PADDING }),
    [columns],
  );
  const dragConfig = useMemo<Partial<DragConfig>>(
    () => ({
      enabled: true,
      handle: touch ? '.settings-tiles-tile.is-selected' : '.settings-tiles-tile',
      bounded: false,
      threshold: 4,
    }),
    [touch],
  );
  const resizeConfig = useMemo<Partial<ResizeConfig>>(() => ({ enabled: true, handles: RESIZE_HANDLES }), []);
  const onStart = useCallback<EventCallback>(
    (_layout, oldItem) => {
      if (oldItem) onSelect(oldItem.i);
    },
    [onSelect],
  );
  const onDone = useCallback<EventCallback>((finalLayout) => onStop([...finalLayout]), [onStop]);

  return (
    <div className="settings-tiles-frame" ref={containerRef}>
      {mounted && width > 0 && (
        <GridLayout
          className="settings-tiles-grid"
          width={width}
          layout={layout}
          gridConfig={gridConfig}
          dragConfig={dragConfig}
          resizeConfig={resizeConfig}
          compactor={verticalCompactor}
          onDragStart={onStart}
          onDragStop={onDone}
          onResizeStart={onStart}
          onResizeStop={onDone}
        >
          {layout.map((item) => (
            <div key={item.i} className={item.i === selectedId ? 'is-selected' : undefined}>
              <Tile
                id={item.i}
                label={labels.get(item.i) ?? item.i}
                w={item.w}
                h={item.h}
                selected={item.i === selectedId}
                onSelect={onSelect}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}

export function TileLayoutControl({ id, field, value, set, values }: TileLayoutControlProps) {
  const activeKey = (field.activeTiles ? field.activeTiles(values) : field.tiles.map((tile) => tile.value)).join('\n');
  const active = useMemo(() => (activeKey === '' ? [] : activeKey.split('\n')), [activeKey]);
  const stored = useMemo(() => parseTileLayout(value), [value]);
  const labels = useMemo(() => new Map(field.tiles.map((tile) => [tile.value, tile.label])), [field.tiles]);
  const touch = useCoarsePointer();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const columns = stored?.columns ?? 1;
  const layout = useMemo<Layout>(
    () =>
      stored
        ? resolveTileLayout(stored, active).map((item) => ({ i: item.id, x: item.x, y: item.y, w: item.w, h: item.h, maxH: TILE_ROWS_MAX }))
        : [],
    [stored, active],
  );

  const write = useCallback(
    (grid: Layout | null) => {
      if (grid) set(toLayout(grid, columns));
    },
    [set, columns],
  );

  const setColumns = (next: number) => {
    const clamped = Math.min(TILE_COLUMNS_MAX, Math.max(TILE_COLUMNS_MIN, next));
    if (clamped === columns) return;
    const fitted = layout.map((item) => {
      const w = Math.min(item.w, clamped);
      return { ...item, w, x: Math.min(item.x, clamped - w) };
    });
    set(toLayout(verticalCompactor.compact(fitted, clamped), clamped));
  };

  const selected = layout.find((item) => item.i === selectedId) ?? null;
  const moves = selected ? availableMoves(layout, selected.i, columns, TILE_ROWS_MAX) : null;
  const selectedLabel = selected ? (labels.get(selected.i) ?? selected.i) : '';
  const move = (direction: Direction) => selected && write(moveItem(layout, selected.i, direction, columns));
  const resize = (dw: number, dh: number) => selected && write(resizeItem(layout, selected.i, dw, dh, columns, TILE_ROWS_MAX));

  return (
    <div className="settings-field" role="group" aria-labelledby={`${id}-label`}>
      <div className="settings-label" id={`${id}-label`}>
        {field.label}
      </div>
      {field.description && <div className="settings-description">{field.description}</div>}

      {active.length === 0 ? (
        <div className="settings-tiles-note">Zuerst oben Bereiche einschalten.</div>
      ) : !stored ? (
        <div className="settings-tiles-auto">
          <span className="settings-tiles-note">Automatisch – die Kacheln ordnen sich nach der Grösse des Widgets.</span>
          <button type="button" className="settings-btn" onClick={() => set(initialTileLayout(active))}>
            Eigene Anordnung
          </button>
        </div>
      ) : (
        <>
          <div className="settings-tiles-toolbar">
            <span className="settings-tiles-columns">
              <span>Spalten</span>
              <button
                type="button"
                className="settings-icon-btn"
                disabled={columns <= TILE_COLUMNS_MIN}
                onClick={() => setColumns(columns - 1)}
                aria-label="Eine Spalte weniger"
                title="Eine Spalte weniger"
              >
                <Minus size={16} />
              </button>
              <span className="settings-tiles-count" aria-live="polite">
                {columns}
              </span>
              <button
                type="button"
                className="settings-icon-btn"
                disabled={columns >= TILE_COLUMNS_MAX}
                onClick={() => setColumns(columns + 1)}
                aria-label="Eine Spalte mehr"
                title="Eine Spalte mehr"
              >
                <Plus size={16} />
              </button>
            </span>
            <button
              type="button"
              className="settings-btn"
              onClick={() => {
                setSelectedId(null);
                set(null);
              }}
            >
              Automatisch
            </button>
          </div>

          <TileGrid
            layout={layout}
            columns={columns}
            touch={touch}
            labels={labels}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onStop={write}
          />
          <div className="settings-description">
            Die Zeilen teilen sich die Höhe des Widgets. {touch ? 'Kachel antippen, dann ziehen oder die Knöpfe nutzen.' : 'Kachel ziehen, an der Ecke unten rechts in der Grösse ändern – oder anklicken und die Knöpfe nutzen.'}
          </div>

          {selected && moves && (
            <div className="settings-tiles-panel" aria-label={`${selectedLabel} anordnen`} role="group">
              <span className="settings-tiles-panel-name">
                {selectedLabel} · {selected.w}×{selected.h}
              </span>
              <span className="settings-tiles-panel-buttons">
                {(
                  [
                    ['left', ArrowLeft, 'Nach links'],
                    ['up', ArrowUp, 'Nach oben'],
                    ['down', ArrowDown, 'Nach unten'],
                    ['right', ArrowRight, 'Nach rechts'],
                  ] as const
                ).map(([direction, Icon, text]) => (
                  <button
                    key={direction}
                    type="button"
                    className="settings-icon-btn"
                    disabled={!moves[direction]}
                    onClick={() => move(direction)}
                    aria-label={`${selectedLabel}: ${text}`}
                    title={text}
                  >
                    <Icon size={16} />
                  </button>
                ))}
              </span>
              <span className="settings-tiles-panel-buttons">
                <span className="settings-tiles-panel-label">Breite</span>
                <button type="button" className="settings-icon-btn" disabled={!moves.narrower} onClick={() => resize(-1, 0)} aria-label={`${selectedLabel}: schmaler`} title="Schmaler">
                  <Minus size={16} />
                </button>
                <button type="button" className="settings-icon-btn" disabled={!moves.wider} onClick={() => resize(1, 0)} aria-label={`${selectedLabel}: breiter`} title="Breiter">
                  <Plus size={16} />
                </button>
                <span className="settings-tiles-panel-label">Höhe</span>
                <button type="button" className="settings-icon-btn" disabled={!moves.lower} onClick={() => resize(0, -1)} aria-label={`${selectedLabel}: niedriger`} title="Niedriger">
                  <Minus size={16} />
                </button>
                <button type="button" className="settings-icon-btn" disabled={!moves.taller} onClick={() => resize(0, 1)} aria-label={`${selectedLabel}: höher`} title="Höher">
                  <Plus size={16} />
                </button>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
