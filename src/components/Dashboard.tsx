/**
 * Dashboard – the widget grid.
 *
 * One fixed (non-responsive) react-grid-layout v2 grid: the kiosk has a
 * single screen, and per-breakpoint layouts silently dropped edits. The
 * layout is persisted only when the user finishes a drag or resize – never
 * from onLayoutChange, which also fires for render echoes and compaction
 * (that would write every remote change straight back).
 *
 * Placement is free (utils/freeGrid): a widget stays where it is dropped,
 * also alone in the middle of the screen.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { GridLayout, useContainerWidth, type EventCallback, type Layout } from 'react-grid-layout';
import type { DragConfig, GridConfig, ResizeConfig } from 'react-grid-layout/core';
import { useLayoutStore } from '../store/layoutStore';
import { useElementSize } from '../hooks/useElementSize';
import { useFreeCompactor } from '../hooks/useFreeCompactor';
import { GRID_CONTAINER_PADDING, GRID_MARGIN, fitRowHeight } from '../types/grid';
import { isTauri, reportViewport } from '../utils/backend';
import { getManifest } from '../widgets/catalog';
import { WidgetWrapper } from './WidgetWrapper';
import 'react-grid-layout/css/styles.css';

const RESIZE_HANDLES: ResizeConfig['handles'] = ['se'];
const VIEWPORT_REPORT_DELAY_MS = 1000;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const Dashboard: React.FC = () => {
  const widgets = useLayoutStore((s) => s.widgets);
  const cols = useLayoutStore((s) => s.cols);
  const storedRowHeight = useLayoutStore((s) => s.rowHeight);
  const fitRows = useLayoutStore((s) => s.fitRows);
  const editMode = useLayoutStore((s) => s.editMode);
  const updateLayout = useLayoutStore((s) => s.updateLayout);

  // Outer element: visible area (height for fitRows, viewport report).
  // Inner element: grid width without padding or scrollbar.
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewport = useElementSize(viewportRef);
  const { width, mounted, containerRef } = useContainerWidth({ measureBeforeMount: true });

  const rowHeight = fitRows > 0 && viewport.height > 0 ? fitRowHeight(viewport.height, fitRows) : storedRowHeight;

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

  const gridConfig = useMemo<Partial<GridConfig>>(
    () => ({ cols, rowHeight, margin: GRID_MARGIN, containerPadding: GRID_CONTAINER_PADDING }),
    [cols, rowHeight],
  );

  const dragConfig = useMemo<Partial<DragConfig>>(
    () => ({ enabled: editMode, handle: '.widget-header', cancel: '.no-drag', bounded: false, threshold: 3 }),
    [editMode],
  );

  const resizeConfig = useMemo<Partial<ResizeConfig>>(
    () => ({ enabled: editMode, handles: RESIZE_HANDLES }),
    [editMode],
  );

  const { compactor, start: startMove } = useFreeCompactor();
  const persistLayout = useCallback<EventCallback>(
    (finalLayout) => {
      compactor.end();
      updateLayout(finalLayout);
    },
    [compactor, updateLayout],
  );

  const children = useMemo(
    () =>
      widgets.map((w) => (
        <div key={w.instanceId}>
          <WidgetWrapper instanceId={w.instanceId} widgetId={w.widgetId} w={w.w} h={w.h} />
        </div>
      )),
    [widgets],
  );

  // The web UI previews the layout with the kiosk's real grid area.
  useEffect(() => {
    if (!isTauri() || viewport.width === 0 || viewport.height === 0) return;
    const timer = setTimeout(() => {
      reportViewport(viewport.width, viewport.height).catch((err: unknown) => {
        console.warn('Bildschirmgrösse konnte nicht gemeldet werden:', err);
      });
    }, VIEWPORT_REPORT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [viewport.width, viewport.height]);

  const canRender = mounted && width > 0 && (fitRows === 0 || viewport.height > 0);

  return (
    <div ref={viewportRef} className={`dashboard${editMode ? ' is-editing' : ''}`}>
      <div ref={containerRef} className="dashboard-measure">
        {canRender && (
          <GridLayout
            className="layout"
            width={width}
            layout={layout}
            gridConfig={gridConfig}
            dragConfig={dragConfig}
            resizeConfig={resizeConfig}
            compactor={compactor}
            onDragStart={startMove}
            onDragStop={persistLayout}
            onResizeStart={startMove}
            onResizeStop={persistLayout}
          >
            {children}
          </GridLayout>
        )}
      </div>
    </div>
  );
};
