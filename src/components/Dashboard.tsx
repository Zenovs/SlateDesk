/**
 * Dashboard – Main grid layout that renders all widget instances.
 * Uses react-grid-layout v2 hooks API for responsive layout.
 */
import React, { useMemo, useCallback } from 'react';
import { Responsive, useContainerWidth, verticalCompactor } from 'react-grid-layout';
import type { GridLayoutItem, GridLayout, GridLayouts } from '../types/grid';
import { useLayoutStore } from '../store/layoutStore';
import { getWidget } from '../utils/widgetRegistry';
import { WidgetWrapper } from './WidgetWrapper';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

export const Dashboard: React.FC = () => {
  const { widgets, cols, rowHeight, editMode, updateLayout } = useLayoutStore();
  const { containerRef, width } = useContainerWidth();

  const layout: GridLayoutItem[] = useMemo(
    () =>
      widgets.map((w) => ({
        i: w.instanceId,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        minW: 2,
        minH: 2,
        static: !editMode,
      })),
    [widgets, editMode]
  );

  const handleLayoutChange = useCallback(
    (current: GridLayout, allLayouts: GridLayouts) => {
      const lgLayout = allLayouts.lg || current;
      updateLayout(lgLayout);
    },
    [updateLayout]
  );

  return (
    <div ref={containerRef} style={{ flex: 1, overflow: 'auto', overflowX: 'hidden', padding: '8px', maxWidth: '100vw', width: '100%' }}>
      {width > 0 && (
        <Responsive
          className="layout"
          width={width}
          layouts={{ lg: layout, md: layout, sm: layout }}
          breakpoints={{ lg: 1200, md: 900, sm: 600 }}
          cols={{ lg: cols, md: 8, sm: 4 }}
          rowHeight={rowHeight}
          margin={[12, 12]}
          containerPadding={[8, 8]}
          compactor={verticalCompactor}
          dragConfig={{
            enabled: editMode,
            handle: '.widget-header',
            bounded: false,
            threshold: 3,
          }}
          resizeConfig={{
            enabled: editMode,
            handles: ['se'],
          }}
          onLayoutChange={handleLayoutChange}
        >
          {widgets.map((w) => {
            const def = getWidget(w.widgetId);
            if (!def) {
              return (
                <div key={w.instanceId}>
                  <WidgetWrapper instanceId={w.instanceId} title="Unbekannt">
                    <div className="widget-error">
                      Widget &quot;{w.widgetId}&quot; nicht gefunden.
                    </div>
                  </WidgetWrapper>
                </div>
              );
            }
            const Comp = def.component;
            return (
              <div key={w.instanceId}>
                <WidgetWrapper
                  instanceId={w.instanceId}
                  title={def.manifest.name}
                  hasSettings={def.manifest.hasSettings}
                >
                  <Comp instanceId={w.instanceId} width={w.w} height={w.h} />
                </WidgetWrapper>
              </div>
            );
          })}
        </Responsive>
      )}
    </div>
  );
};
