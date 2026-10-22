/**
 * Lifetime widget – a dot circles calmly as long as everything runs. When it
 * stands still, something hangs and needs a restart.
 *
 * The motion is the signal, so it must stop with whatever hangs:
 * - it is moved frame by frame from JavaScript (requestAnimationFrame), never
 *   by a CSS animation – the compositor keeps a CSS animation running while
 *   the page's script is stuck
 * - the backend is asked for a sign of life every few seconds (`heartbeat`,
 *   which also reads the state store); without an answer the dot stops and
 *   turns red
 * - a frozen display or a hung PC stops everything anyway
 */
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { WidgetProps } from '../types/widget';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { heartbeat, isTauri } from '../utils/backend';
import { formatDuration } from './shared/format';
import { LIFETIME_DEFAULT_SETTINGS, LIFETIME_PERIODS, type LifetimeSettings } from './manifests/lifetime';
import './styles/lifetime.css';

const PULSE_EVERY_MS = 5_000;
/** A heartbeat without answer for this long, or this many failed in a row: the backend hangs. */
const STALL_AFTER_MS = 20_000;
const MAX_FAILURES = 3;
/** Longest step of one frame – after a pause (hidden page) the dot goes on instead of jumping. */
const MAX_FRAME_MS = 100;

// SVG geometry (viewBox 0 0 100 100); angles in degrees, clockwise from the top.
const CENTER = 50;
const RADIUS = 38;
const TAIL_DEGREES = 120;

const polar = (degrees: number): [number, number] => {
  const rad = (degrees * Math.PI) / 180;
  return [CENTER + RADIUS * Math.sin(rad), CENTER - RADIUS * Math.cos(rad)];
};
const [TAIL_X, TAIL_Y] = polar(-TAIL_DEGREES);
const [HEAD_X, HEAD_Y] = polar(0);
const TAIL_PATH = `M ${TAIL_X.toFixed(3)} ${TAIL_Y.toFixed(3)} A ${RADIUS} ${RADIUS} 0 0 1 ${HEAD_X} ${HEAD_Y}`;

interface Pulse {
  /** The backend stopped answering. */
  stalled: boolean;
  /** App uptime in seconds from the last answer; null before it. */
  uptimeSeconds: number | null;
}

function useBackendPulse(): Pulse {
  const [pulse, setPulse] = useState<Pulse>({ stalled: false, uptimeSeconds: null });

  useEffect(() => {
    if (!isTauri()) return;
    let sentAt: number | null = null;
    let failures = 0;
    let disposed = false;
    const stall = () => setPulse((current) => (current.stalled ? current : { ...current, stalled: true }));
    const beat = () => {
      if (sentAt !== null) {
        // Still waiting – one heartbeat at a time, a hung backend must not pile them up.
        if (Date.now() - sentAt > STALL_AFTER_MS) stall();
        return;
      }
      sentAt = Date.now();
      heartbeat().then(
        (uptimeSeconds) => {
          if (disposed) return;
          sentAt = null;
          failures = 0;
          setPulse({ stalled: false, uptimeSeconds });
        },
        () => {
          if (disposed) return;
          sentAt = null;
          failures += 1;
          if (failures >= MAX_FAILURES) stall();
        },
      );
    };
    const timer = setInterval(beat, PULSE_EVERY_MS);
    beat();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return pulse;
}

/** Turns `ref` by 360° per `periodMs` while `running`; keeps its angle when stopped. */
function useOrbit(ref: RefObject<SVGGElement | null>, periodMs: number, running: boolean): void {
  const angle = useRef(0);

  useEffect(() => {
    const group = ref.current;
    if (!group) return;
    const place = () => group.setAttribute('transform', `rotate(${angle.current.toFixed(2)} ${CENTER} ${CENTER})`);
    place();
    if (!running) return;
    let last: number | null = null;
    let frame = requestAnimationFrame(function step(time: number) {
      if (last !== null) {
        const dt = Math.min(time - last, MAX_FRAME_MS);
        angle.current = (angle.current + (dt / periodMs) * 360) % 360;
        place();
      }
      last = time;
      frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [ref, periodMs, running]);
}

export function LifetimeWidget({ instanceId }: WidgetProps) {
  const [settings] = useWidgetSettings<LifetimeSettings>(instanceId, LIFETIME_DEFAULT_SETTINGS);
  const periodSeconds = LIFETIME_PERIODS.includes(settings.periodSeconds)
    ? settings.periodSeconds
    : LIFETIME_DEFAULT_SETTINGS.periodSeconds;
  const pulse = useBackendPulse();
  const orbit = useRef<SVGGElement>(null);
  useOrbit(orbit, periodSeconds * 1000, !pulse.stalled);

  const id = useId().replace(/:/g, '');
  const tailId = `lifetime-tail-${id}`;
  const glowId = `lifetime-glow-${id}`;
  const showUptime = settings.showUptime === true && pulse.uptimeSeconds !== null && !pulse.stalled;

  return (
    <div className={`lifetime${pulse.stalled ? ' is-stalled' : ''}`}>
      <svg
        className="lifetime-orbit"
        viewBox="0 0 100 100"
        role="img"
        aria-label={pulse.stalled ? 'Lebenszeichen: Kiosk-Dienst antwortet nicht' : 'Lebenszeichen: alles läuft'}
      >
        <defs>
          <linearGradient id={tailId} gradientUnits="userSpaceOnUse" x1={TAIL_X} y1={TAIL_Y} x2={HEAD_X} y2={HEAD_Y}>
            <stop offset="0" className="lifetime-stop" stopOpacity="0" />
            <stop offset="1" className="lifetime-stop" stopOpacity="0.85" />
          </linearGradient>
          <radialGradient id={glowId}>
            <stop offset="0" className="lifetime-stop" stopOpacity="0.45" />
            <stop offset="1" className="lifetime-stop" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle className="lifetime-track" cx={CENTER} cy={CENTER} r={RADIUS} />
        <g ref={orbit}>
          <path className="lifetime-tail" d={TAIL_PATH} stroke={`url(#${tailId})`} />
          <circle cx={HEAD_X} cy={HEAD_Y} r="9" fill={`url(#${glowId})`} />
          <circle className="lifetime-head" cx={HEAD_X} cy={HEAD_Y} r="3.4" />
        </g>
      </svg>
      {pulse.stalled && <div className="lifetime-label is-error">Kiosk-Dienst antwortet nicht</div>}
      {showUptime && <div className="lifetime-label">Laufzeit {formatDuration(pulse.uptimeSeconds ?? 0)}</div>}
    </div>
  );
}
