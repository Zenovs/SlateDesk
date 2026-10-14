/** Details of the kiosk computer from GET /api/system. */
import type { ReactNode } from 'react';
import { RefreshCw, Server } from 'lucide-react';
import type { SystemInfo } from '../../api';
import { UsageBar } from '../../components/Stats';
import { formatDuration, formatNumber, formatTime, plural } from '../../format';
import type { PollState } from '../../hooks/usePoll';
import { isHighLoad, sessionText, temperatureTone } from '../../systemText';
import { Button, Card, LoadingRow, Notice } from '../../ui';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="r-dl-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Chips({ items, empty }: { items: readonly string[]; empty: string }) {
  if (items.length === 0) return <>{empty}</>;
  return (
    <span className="r-chips">
      {items.map((item) => (
        <span key={item} className="r-chip">
          {item}
        </span>
      ))}
    </span>
  );
}

export function DeviceCard({ poll }: { poll: PollState<SystemInfo> }) {
  const { data: info, error, loading, lastUpdated, refresh } = poll;
  const temperatureClass = info && info.cpuTempC !== null ? `r-tone-${temperatureTone(info.cpuTempC)}` : undefined;

  return (
    <Card
      title="Gerät"
      icon={Server}
      subtitle={info?.hostname}
      actions={
        <Button size="sm" variant="ghost" iconOnly icon={RefreshCw} busy={loading && info !== null} onClick={refresh}>
          Geräteinfo aktualisieren
        </Button>
      }
      footer={lastUpdated !== null ? `Aktualisiert um ${formatTime(lastUpdated, true)}` : undefined}
    >
      {error && (
        <Notice tone={info ? 'warning' : 'error'} title={info ? 'Keine aktuelle Antwort vom Kiosk' : 'Geräteinfo nicht verfügbar'}>
          {error}
        </Notice>
      )}
      {!info && !error && <LoadingRow label="Geräteinfo wird geladen…" />}
      {info && (
        <>
          <dl className="r-dl">
            <Row label="Version">
              {info.version}
              {info.commit ? ` (${info.commit})` : ''}
            </Row>
            <Row label="IP-Adressen">
              <Chips items={info.ips} empty="keine" />
            </Row>
            <Row label="Fernsteuerung">
              {info.remote.enabled ? <Chips items={info.remote.urls} empty={`Port ${info.remote.port}`} /> : 'ausgeschaltet'}
            </Row>
            <Row label="Sitzung">{sessionText(info)}</Row>
            <Row label="Bildschirm">
              {info.viewport ? `${info.viewport.width} × ${info.viewport.height} px` : 'noch nicht gemeldet'}
            </Row>
            <Row label="Prozessor">
              {plural(info.cpuCount, 'Kern', 'Kerne')} · Last{' '}
              <span className={isHighLoad(info.load[0], info.cpuCount) ? 'r-tone-warn' : undefined}>
                {info.load.map((value) => formatNumber(value, 2)).join(' / ')}
              </span>
            </Row>
            <Row label="CPU-Temperatur">
              <span className={temperatureClass}>{info.cpuTempC === null ? 'unbekannt' : `${formatNumber(info.cpuTempC, 0)} °C`}</span>
            </Row>
            <Row label="Laufzeit">
              System {formatDuration(info.uptimeSeconds)} · App {formatDuration(info.appUptimeSeconds)}
            </Row>
          </dl>
          <div className="r-usages">
            <UsageBar label="Arbeitsspeicher" used={info.memTotal - info.memAvailable} total={info.memTotal} />
            <UsageBar label="Speicherplatz" used={info.diskTotal - info.diskAvailable} total={info.diskTotal} />
          </div>
        </>
      )}
    </Card>
  );
}
