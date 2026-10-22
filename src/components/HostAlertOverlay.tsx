/**
 * HostAlertOverlay – a host of a Host-Monitor widget is down: large notice
 * over the dashboard until it answers again (useHostAlertStore). Touches pass
 * through, so the dashboard and the widget's settings stay usable.
 */
import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { allOutages, formatOutageDuration, useHostAlertStore, type HostOutage } from '../services/hostAlerts';
import { useNow } from '../widgets/shared/hooks';

function formatSince(since: number, now: number): string {
  const date = new Date(since);
  const time = date.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
  const day =
    new Date(now).toDateString() === date.toDateString()
      ? ''
      : `${date.toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' })} `;
  return `seit ${day}${time} (${formatOutageDuration(Math.max(0, now - since))})`;
}

export const HostAlertOverlay: React.FC = () => {
  const byInstance = useHostAlertStore((s) => s.outages);
  const outages = useMemo(() => allOutages(byInstance), [byInstance]);
  return outages.length > 0 ? <AlertPanel outages={outages} /> : null;
};

/** Mounted only during an outage – its clock does not tick otherwise. */
const AlertPanel: React.FC<{ outages: HostOutage[] }> = ({ outages }) => {
  const now = useNow(30_000);
  const single = outages.length === 1;

  return (
    <div className="host-alert" role="alert">
      <div className="host-alert-panel">
        <AlertTriangle className="host-alert-icon" aria-hidden="true" />
        <div className="host-alert-title">
          {single ? `${outages[0].name} nicht erreichbar` : `${outages.length} Hosts nicht erreichbar`}
        </div>
        <ul className="host-alert-list">
          {outages.map((outage) => (
            <li key={outage.key}>
              {!single && <span className="host-alert-name">{outage.name}</span>}
              <span className="host-alert-detail">{outage.address}</span>
              {outage.message && <span className="host-alert-detail">{outage.message}</span>}
              {outage.since !== null && <span className="host-alert-since">{formatSince(outage.since, now)}</span>}
            </li>
          ))}
        </ul>
        <div className="host-alert-note">Der Hinweis verschwindet, sobald wieder alles erreichbar ist.</div>
      </div>
    </div>
  );
};
