/**
 * Lifetime widget – a dot circles calmly as long as everything runs. When it
 * stands still, something hangs and needs a restart.
 *
 * The motion is the signal, so it must stop with whatever hangs – and still
 * run without a stutter when the page is busy:
 * - the rotation is an animation of the compositor (Web Animations API on its
 *   own layer): smooth, no repaint per frame, independent of the script
 * - but it only ever has a buffer of a few seconds (BUFFER_MS), which the
 *   script tops up. If the page's script hangs, nobody tops it up and the dot
 *   stops when the buffer runs out – an endless CSS animation would keep
 *   turning on the compositor
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
/** Motion the compositor runs ahead of the script: if the page hangs, the dot stops after this long. */
const BUFFER_MS = 4_000;
/** The buffer is topped up whenever less than this is left. */
const REFILL_BELOW_MS = 2_000;
const REFILL_CHECK_MS = 500;

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

interface OrbitState {
  animation: Animation | null;
  /** Angle the current animation started at (degrees). */
  angle: number;
}

const endOf = (animation: Animation): number => Number(animation.effect?.getComputedTiming().endTime ?? 0);

/**
 * Turns `ref` by 360° per `periodMs` on the compositor while `running`, with
 * a buffer of BUFFER_MS that this script keeps topping up; keeps its angle
 * when stopped or when the speed changes.
 */
function useOrbit(ref: RefObject<SVGSVGElement | null>, periodMs: number, running: boolean): void {
  const orbit = useRef<OrbitState>({ animation: null, angle: 0 });
  const runningRef = useRef(running);

  useEffect(() => {
    const element = ref.current;
    const state = orbit.current;
    if (!element || typeof element.animate !== 'function') return;

    /** Where `animation` is now – or where it stopped when its buffer ran out. */
    const angleOf = (animation: Animation): number =>
      (state.angle + (360 * Math.min(Number(animation.currentTime ?? 0), endOf(animation))) / periodMs) % 360;

    const start = (angle: number) => {
      state.animation?.cancel();
      state.angle = angle;
      state.animation = element.animate(
        [{ transform: `rotate(${angle}deg)` }, { transform: `rotate(${angle + 360}deg)` }],
        { duration: periodMs, iterations: BUFFER_MS / periodMs, easing: 'linear', fill: 'forwards' },
      );
      if (!runningRef.current) state.animation.pause();
    };

    const refill = () => {
      const animation = state.animation;
      if (!animation || !runningRef.current) return;
      // The buffer ran out (the page hung) – go on from where the dot stopped.
      if (animation.playState === 'finished') {
        start(angleOf(animation));
        return;
      }
      const time = Number(animation.currentTime ?? 0);
      if (endOf(animation) - time < REFILL_BELOW_MS) {
        animation.effect?.updateTiming({ iterations: (time + BUFFER_MS) / periodMs });
      }
    };

    start(state.angle);
    const timer = setInterval(refill, REFILL_CHECK_MS);
    return () => {
      clearInterval(timer);
      const animation = state.animation;
      if (animation) {
        state.angle = angleOf(animation);
        animation.cancel();
        state.animation = null;
      }
    };
  }, [ref, periodMs]);

  useEffect(() => {
    runningRef.current = running;
    const animation = orbit.current.animation;
    if (!animation) return;
    if (!running) animation.pause();
    else if (animation.playState === 'paused') animation.play();
  }, [running]);
}

export function LifetimeWidget({ instanceId }: WidgetProps) {
  const [settings] = useWidgetSettings<LifetimeSettings>(instanceId, LIFETIME_DEFAULT_SETTINGS);
  const periodSeconds = LIFETIME_PERIODS.includes(settings.periodSeconds)
    ? settings.periodSeconds
    : LIFETIME_DEFAULT_SETTINGS.periodSeconds;
  const pulse = useBackendPulse();
  const spinner = useRef<SVGSVGElement>(null);
  useOrbit(spinner, periodSeconds * 1000, !pulse.stalled);

  const id = useId().replace(/:/g, '');
  const tailId = `lifetime-tail-${id}`;
  const glowId = `lifetime-glow-${id}`;
  const showUptime = settings.showUptime === true && pulse.uptimeSeconds !== null && !pulse.stalled;

  return (
    <div className={`lifetime${pulse.stalled ? ' is-stalled' : ''}`}>
      <div
        className="lifetime-stage"
        role="img"
        aria-label={pulse.stalled ? 'Lebenszeichen: Kiosk-Dienst antwortet nicht' : 'Lebenszeichen: alles läuft'}
      >
        <svg className="lifetime-orbit" viewBox="0 0 100 100" aria-hidden="true">
          <circle className="lifetime-track" cx={CENTER} cy={CENTER} r={RADIUS} />
        </svg>
        {/* Its own box: the compositor turns it as a whole (both boxes are centred the same way). */}
        <svg ref={spinner} className="lifetime-orbit lifetime-spinner" viewBox="0 0 100 100" aria-hidden="true">
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
          <path className="lifetime-tail" d={TAIL_PATH} stroke={`url(#${tailId})`} />
          <circle cx={HEAD_X} cy={HEAD_Y} r="9" fill={`url(#${glowId})`} />
          <circle className="lifetime-head" cx={HEAD_X} cy={HEAD_Y} r="3.4" />
        </svg>
      </div>
      {pulse.stalled && <div className="lifetime-label is-error">Kiosk-Dienst antwortet nicht</div>}
      {showUptime && <div className="lifetime-label">Laufzeit {formatDuration(pulse.uptimeSeconds ?? 0)}</div>}
    </div>
  );
}
