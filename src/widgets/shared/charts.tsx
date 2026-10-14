/**
 * Small SVG charts of the network widgets (Speedtest, Host-Monitor).
 *
 * Both scale with their box through the viewBox – size them with CSS (the
 * widgets use container query units). Colours come from the theme tokens via
 * the tone classes, so they work in dark and light.
 */
import { useId } from 'react';
import '../styles/charts.css';

export type ChartTone = 'ok' | 'warn' | 'crit' | 'muted' | 'accent' | 'info';

// ── Arc gauge ────────────────────────────────────────────────────────────────

interface ArcGaugeProps {
  /** Filled share of the arc, 0..1 (clamped). */
  fraction: number;
  tone: ChartTone;
  /** Formatted value in the centre, e.g. "94.2" or "—". */
  value: string;
  unit?: string;
  /** Screen-reader text. */
  label: string;
}

/** Upper half circle, centre (60|60), radius 50. */
const ARC_PATH = 'M 10 60 A 50 50 0 0 1 110 60';

export function ArcGauge({ fraction, tone, value, unit, label }: ArcGaugeProps) {
  const percent = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) * 100 : 0;
  return (
    <svg className={`arc-gauge chart-tone-${tone}`} viewBox="0 0 120 68" role="img" aria-label={label}>
      <path className="arc-gauge-track" d={ARC_PATH} pathLength={100} />
      {percent > 0 && (
        <path className="arc-gauge-bar" d={ARC_PATH} pathLength={100} strokeDasharray={`${percent} 100`} />
      )}
      <text className="arc-gauge-value" x="60" y={unit ? 49 : 55} textAnchor="middle">
        {value}
      </text>
      {unit && (
        <text className="arc-gauge-unit" x="60" y="63" textAnchor="middle">
          {unit}
        </text>
      )}
    </svg>
  );
}

// ── Time sparkline ───────────────────────────────────────────────────────────

export interface SparkPoint {
  /** epoch ms */
  t: number;
  /** null = no value (failed measurement) – the line breaks there. */
  v: number | null;
}

export interface SparkSeries {
  id: string;
  points: readonly SparkPoint[];
  /** Value at the top edge. */
  max: number;
  tone: ChartTone;
  /** Gradient area below the line. */
  fill?: boolean;
}

interface TimeSparklineProps {
  /** Time axis in epoch ms – a real axis, so gaps in the data stay visible. */
  from: number;
  to: number;
  series: readonly SparkSeries[];
  /** Points further apart than this are not connected (missed checks). */
  maxGapMs?: number;
  /** Times of failures, drawn as red ticks on the baseline. */
  marks?: readonly number[];
  label: string;
}

const VIEW_W = 1000;
const VIEW_H = 100;
const PAD_Y = 6;
/** A lone point is drawn as a short dash so it stays visible. */
const DOT_HALF_W = 4;

type Coord = [number, number];

function toSegments(
  points: readonly SparkPoint[],
  from: number,
  to: number,
  max: number,
  maxGapMs: number,
): Coord[][] {
  const span = Math.max(1, to - from);
  const scale = max > 0 ? max : 1;
  const segments: Coord[][] = [];
  let current: Coord[] = [];
  let lastT = -Infinity;
  for (const point of points) {
    if (point.t < from || point.t > to) continue;
    if (point.v === null || !Number.isFinite(point.v) || point.t - lastT > maxGapMs) {
      if (current.length > 0) segments.push(current);
      current = [];
    }
    lastT = point.t;
    if (point.v === null || !Number.isFinite(point.v)) continue;
    const x = ((point.t - from) / span) * VIEW_W;
    const ratio = Math.min(1, Math.max(0, point.v / scale));
    const y = VIEW_H - PAD_Y - ratio * (VIEW_H - 2 * PAD_Y);
    current.push([x, y]);
  }
  if (current.length > 0) segments.push(current);
  return segments.map((segment) =>
    segment.length === 1
      ? [
          [segment[0][0] - DOT_HALF_W, segment[0][1]],
          [segment[0][0] + DOT_HALF_W, segment[0][1]],
        ]
      : segment,
  );
}

const polyline = (segment: Coord[]): string => segment.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

const area = (segment: Coord[]): string =>
  `${segment[0][0].toFixed(1)},${VIEW_H} ${polyline(segment)} ${segment[segment.length - 1][0].toFixed(1)},${VIEW_H}`;

export function TimeSparkline({ from, to, series, maxGapMs = Infinity, marks = [], label }: TimeSparklineProps) {
  // Gradient ids must be unique per instance and valid inside url(#…).
  const gradientId = `spark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const span = Math.max(1, to - from);

  return (
    <svg className="time-sparkline" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" role="img" aria-label={label}>
      {series.map((s) => {
        const segments = toSegments(s.points, from, to, s.max, maxGapMs);
        const id = `${gradientId}-${s.id}`;
        return (
          <g key={s.id} className={`chart-tone-${s.tone}`}>
            {s.fill && (
              <>
                <defs>
                  <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
                    <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {segments.map((segment, i) => (
                  <polygon key={i} points={area(segment)} fill={`url(#${id})`} />
                ))}
              </>
            )}
            {segments.map((segment, i) => (
              <polyline key={i} className="time-sparkline-line" points={polyline(segment)} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        );
      })}
      {marks
        .filter((t) => t >= from && t <= to)
        .map((t, i) => (
          <rect
            key={i}
            className="time-sparkline-mark"
            x={((t - from) / span) * VIEW_W - 2}
            y={VIEW_H - 16}
            width={4}
            height={16}
          />
        ))}
    </svg>
  );
}
