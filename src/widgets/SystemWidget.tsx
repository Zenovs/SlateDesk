/**
 * Kiosk-Status – Name, Adressen, Laufzeit, Temperatur und Auslastung dieses
 * Bildschirms, dazu Adresse und QR-Code der Fernsteuerung.
 *
 * Der PIN der Fernsteuerung kommt nie an die Wand: Er wird gleich nach dem
 * Laden verworfen und steht nur im Fernsteuerungs-Dialog des Kiosks.
 */
import { Monitor, Smartphone } from 'lucide-react';
import { usePolling } from '../hooks/usePolling';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import type { WidgetProps } from '../types/widget';
import { isTauri, KIOSK_ONLY_MESSAGE, remoteInfo, systemInfo, type SystemInfo } from '../utils/backend';
import { SYSTEM_WIDGET_DEFAULTS, type SystemWidgetSettings } from './manifests/system';
import {
  formatBytesOf,
  formatClock,
  formatDecimal,
  formatDuration,
  formatTemperature,
  percentOf,
} from './shared/format';
import { useQrImage } from './shared/hooks';
import { Meter, StatusDot, WidgetBanner, WidgetMessage } from './shared/WidgetParts';
import { readBoolean, temperatureTone, usageTone } from './shared/values';
import './styles/system.css';

const SYSTEM_INTERVAL_MS = 30_000;
/** Addresses change rarely (DHCP, cable plugged in). */
const REMOTE_INTERVAL_MS = 60_000;

/** RemoteInfo without the PIN. */
interface RemoteView {
  enabled: boolean;
  urls: string[];
  error: string | null;
}

async function loadRemote(): Promise<RemoteView> {
  const info = await remoteInfo();
  return { enabled: info.enabled, urls: info.urls, error: info.error };
}

function Fact({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'error' }) {
  return (
    <div className={`sys-fact${tone ? ` sys-fact-toned wp-tone-${tone}` : ''}`}>
      <span className="sys-fact-value">{value}</span>
      <span className="sys-fact-label">{label}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="sys-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Details({ info }: { info: SystemInfo }) {
  const memUsed = Math.max(0, info.memTotal - info.memAvailable);
  const diskUsed = Math.max(0, info.diskTotal - info.diskAvailable);
  const memPercent = percentOf(memUsed, info.memTotal);
  const diskPercent = percentOf(diskUsed, info.diskTotal);
  const commit = info.commit ? info.commit.slice(0, 7) : null;
  const desktop = info.desktop && info.desktop !== 'unbekannt' ? info.desktop : null;

  return (
    <div className="sys-details">
      <Meter label="Arbeitsspeicher" value={formatBytesOf(memUsed, info.memTotal)} percent={memPercent} tone={usageTone(memPercent)} />
      {info.diskTotal > 0 && (
        <Meter label="Speicherplatz" value={formatBytesOf(diskUsed, info.diskTotal)} percent={diskPercent} tone={usageTone(diskPercent)} />
      )}
      <dl className="sys-rows">
        <DetailRow
          label="Last"
          value={`${info.load.map((value) => formatDecimal(value, 2)).join(' · ')} (${info.cpuCount} Kerne)`}
        />
        <DetailRow label="Version" value={commit ? `${info.version} · ${commit}` : info.version} />
        <DetailRow label="Sitzung" value={desktop ? `${info.sessionType} · ${desktop}` : info.sessionType} />
        {info.viewport && <DetailRow label="Anzeige" value={`${info.viewport.width} × ${info.viewport.height} px`} />}
        <DetailRow label="App läuft seit" value={formatDuration(info.appUptimeSeconds)} />
      </dl>
    </div>
  );
}

function RemoteBlock({ remote, error }: { remote: RemoteView | null; error: string | null }) {
  const url = remote?.enabled && !remote.error ? (remote.urls[0] ?? null) : null;
  const qr = useQrImage(url);

  let hint: string | null = null;
  if (!remote) hint = error ? `Fernsteuerung: ${error}` : null;
  else if (!remote.enabled) hint = 'Fernsteuerung ist ausgeschaltet';
  else if (remote.error) hint = `Fernsteuerung nicht erreichbar: ${remote.error}`;
  else if (!url) hint = 'Keine Netzwerkadresse – ist das Netzwerkkabel eingesteckt?';

  if (!url) {
    return hint ? (
      <div className="sys-remote">
        <WidgetBanner tone={remote?.enabled === false ? 'neutral' : 'warn'} icon={Smartphone}>
          {hint}
        </WidgetBanner>
      </div>
    ) : null;
  }

  return (
    <div className="sys-remote">
      <div className="sys-qr">
        {qr.src ? (
          <img src={qr.src} alt={`QR-Code für ${url}`} />
        ) : (
          <span className="sys-qr-hint">{qr.error ? 'QR-Code nicht verfügbar' : 'QR-Code wird erzeugt …'}</span>
        )}
      </div>
      <div className="sys-remote-text">
        <span className="sys-remote-label">Fernsteuerung</span>
        <span className="sys-remote-url">{url}</span>
        <span className="sys-remote-hint">Mit dem Handy scannen und mit der PIN anmelden</span>
      </div>
    </div>
  );
}

export function SystemWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings<SystemWidgetSettings>(instanceId, SYSTEM_WIDGET_DEFAULTS);
  const showRemote = readBoolean(raw.showRemote, SYSTEM_WIDGET_DEFAULTS.showRemote);
  const showDetails = readBoolean(raw.showDetails, SYSTEM_WIDGET_DEFAULTS.showDetails);
  const inKiosk = isTauri();

  const system = usePolling(() => systemInfo(), SYSTEM_INTERVAL_MS, [], { enabled: inKiosk });
  const remote = usePolling(loadRemote, REMOTE_INTERVAL_MS, [], { enabled: inKiosk && showRemote });

  if (!inKiosk) {
    return <WidgetMessage icon={Monitor} title={KIOSK_ONLY_MESSAGE} detail="Zeigt den Zustand des Bildschirms, auf dem SlateDesk läuft." />;
  }
  const info = system.data;
  if (!info) {
    return system.error ? (
      <WidgetMessage icon={Monitor} tone="error" title="Systemdaten nicht verfügbar" detail={system.error} />
    ) : (
      <WidgetMessage busy title="Systemdaten werden geladen …" />
    );
  }

  const tempTone = temperatureTone(info.cpuTempC, 70, 80);
  const ips = info.ips.slice(0, 3);

  return (
    <div className={`sys${showRemote ? ' sys-with-remote' : ''}`}>
      <div className="sys-main">
        <div className="sys-head">
          <StatusDot tone={system.error ? 'warn' : 'ok'} label={system.error ? 'Daten veraltet' : 'Kiosk läuft'} />
          <span className="sys-host">{info.hostname}</span>
        </div>
        <div className="sys-ips">{ips.length > 0 ? ips.join(' · ') : 'Keine Netzwerkadresse'}</div>
        <div className="sys-facts">
          <Fact label="Laufzeit" value={formatDuration(info.uptimeSeconds)} />
          {info.cpuTempC !== null && (
            <Fact
              label="CPU-Temperatur"
              value={formatTemperature(info.cpuTempC)}
              tone={tempTone === 'warn' || tempTone === 'error' ? tempTone : undefined}
            />
          )}
          <Fact label="Last (1 Min.)" value={formatDecimal(info.load[0], 2)} />
        </div>
        {showDetails && <Details info={info} />}
        {system.error && system.lastUpdated !== null && (
          <WidgetBanner tone="warn">Stand {formatClock(system.lastUpdated)} – Aktualisierung fehlgeschlagen</WidgetBanner>
        )}
      </div>
      {showRemote && <RemoteBlock remote={remote.data} error={remote.error} />}
    </div>
  );
}
