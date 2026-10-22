/**
 * Log of the kiosk (GET /api/protokoll, src-tauri/src/health.rs): a sample
 * every minute – free memory, swap, load, CPU temperature, memory of
 * SlateDesk – and events (start, end, display, mail, warnings). After a hang
 * it shows what happened before; the whole log and the app log can be
 * downloaded.
 */
import { useState } from 'react';
import { Download, ScrollText } from 'lucide-react';
import { downloadAppLog, downloadProtokoll, errorText, protokoll, type LogEvent, type LogLevel, type LogSample } from '../../api';
import { formatDayTime, formatNumber, formatTime } from '../../format';
import { useNow } from '../../hooks/useNow';
import { usePoll } from '../../hooks/usePoll';
import { Button, Card, LoadingRow, Notice, StatusDot, toast, type StatusTone } from '../../ui';

const POLL_MS = 60_000;
const SHOWN_EVENTS = 20;
/** An unexpected end this recent is shown on top. */
const RECENT_MS = 7 * 24 * 3_600_000;
const CHART_W = 300;
const CHART_H = 56;

const TONES: Record<LogLevel, StatusTone> = { info: 'idle', warn: 'warn', error: 'error' };

interface ChartProps {
  label: string;
  samples: LogSample[];
  value: (sample: LogSample) => number | undefined;
  format: (value: number) => string;
  /** Upper end of the scale; default the highest value. */
  max?: number;
  now: number;
}

/** Line over the last 24 h with the current value and the range. */
function Chart({ label, samples, value, format, max, now }: ChartProps) {
  const points = samples.flatMap((s) => {
    const v = value(s);
    return v === undefined ? [] : [{ t: s.t, v }];
  });
  if (points.length < 2) return null;
  const values = points.map((p) => p.v);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const top = Math.max(max ?? high, 1);
  const from = points[0].t;
  const span = Math.max(points[points.length - 1].t - from, 1);
  const line = points
    .map((p) => `${((p.t - from) / span) * CHART_W},${CHART_H - (p.v / top) * (CHART_H - 2) - 1}`)
    .join(' ');
  return (
    <div className="r-log-chart">
      <div className="r-log-chart-head">
        <span>{label}</span>
        <strong>{format(values[values.length - 1])}</strong>
      </div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" aria-hidden="true">
        <polygon points={`0,${CHART_H} ${line} ${CHART_W},${CHART_H}`} className="r-log-chart-area" />
        <polyline points={line} className="r-log-chart-line" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="r-log-chart-foot">
        <span>{formatDayTime(from, now)}</span>
        <span>
          {format(low)} – {format(high)}
        </span>
        <span>{formatTime(points[points.length - 1].t)}</span>
      </div>
    </div>
  );
}

function EventItem({ event, now }: { event: LogEvent; now: number }) {
  return (
    <li className={`r-log-item is-${event.level}`}>
      <StatusDot tone={TONES[event.level]} />
      <div className="r-log-body">
        <div className="r-log-text">{event.text}</div>
        <div className="r-log-time">{formatDayTime(event.t, now)}</div>
        {event.detail && (
          <details className="r-log-detail">
            <summary>Details</summary>
            <pre>{event.detail}</pre>
          </details>
        )}
      </div>
    </li>
  );
}

const mb = (value: number) => `${formatNumber(value, 0)} MB`;

export function ProtokollCard() {
  const poll = usePoll(protokoll, POLL_MS);
  const { data: report, error, lastUpdated } = poll;
  const now = useNow(POLL_MS);
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<'log' | 'app' | null>(null);

  const download = (which: 'log' | 'app') => {
    setBusy(which);
    (which === 'log' ? downloadProtokoll() : downloadAppLog())
      .catch((err: unknown) => toast.error(errorText(err)))
      .finally(() => setBusy(null));
  };

  const samples = report?.samples ?? [];
  const last = samples.length > 0 ? samples[samples.length - 1] : null;
  const crash = report?.events.find((e) => e.level === 'error' && now - e.t < RECENT_MS) ?? null;
  const events = report ? (showAll ? report.events : report.events.slice(0, SHOWN_EVENTS)) : [];

  return (
    <Card
      title="Protokoll"
      icon={ScrollText}
      subtitle="Lebenszeichen jede Minute und Ereignisse – zeigt, was vor einem Hänger los war."
      footer={lastUpdated !== null ? `Aktualisiert um ${formatTime(lastUpdated, true)}` : undefined}
    >
      {error && (
        <Notice tone={report ? 'warning' : 'error'} title={report ? 'Keine aktuelle Antwort vom Kiosk' : 'Protokoll nicht verfügbar'}>
          {error}
        </Notice>
      )}
      {!report && !error && <LoadingRow label="Protokoll wird geladen…" />}
      {crash && (
        <Notice tone="error" title={`Unerwartetes Ende (${formatDayTime(crash.t, now)})`}>
          {crash.text}
        </Notice>
      )}
      {report && (
        <>
          <p className="r-log-summary">
            SlateDesk läuft seit {formatDayTime(report.started, now)}
            {last
              ? ` · Arbeitsspeicher frei ${mb(last.memAvailableMb)} von ${mb(last.memTotalMb)}, Swap ${mb(last.swapUsedMb)}, Last ${formatNumber(last.load1, 1)}`
              : ' · erster Messpunkt nach einer Minute'}
          </p>
          {samples.length >= 2 && (
            <div className="r-log-charts">
              <Chart
                label="Freier Arbeitsspeicher"
                samples={samples}
                value={(s) => s.memAvailableMb}
                format={mb}
                max={last?.memTotalMb}
                now={now}
              />
              <Chart label="SlateDesk (App + WebKit)" samples={samples} value={(s) => s.appMb} format={mb} now={now} />
              <Chart
                label="CPU-Temperatur"
                samples={samples}
                value={(s) => s.cpuTempC}
                format={(v) => `${formatNumber(v, 0)} °C`}
                max={100}
                now={now}
              />
            </div>
          )}
          {events.length > 0 ? (
            <ul className="r-log-list">
              {events.map((event, index) => (
                <EventItem key={`${event.t}-${index}`} event={event} now={now} />
              ))}
            </ul>
          ) : (
            <p className="r-log-summary">Noch keine Ereignisse.</p>
          )}
          {!showAll && report.events.length > SHOWN_EVENTS && (
            <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
              Alle {report.events.length} Ereignisse zeigen
            </Button>
          )}
        </>
      )}
      <div className="r-form-actions r-form-actions-start">
        <Button icon={Download} size="sm" busy={busy === 'log'} onClick={() => download('log')}>
          Protokoll herunterladen
        </Button>
        <Button icon={Download} size="sm" variant="ghost" busy={busy === 'app'} onClick={() => download('app')}>
          App-Log herunterladen
        </Button>
      </div>
    </Card>
  );
}
