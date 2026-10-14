/**
 * Übersicht: kiosk status (GET /api/system every 15 s), quick actions and
 * a live mini-map of the kiosk screen.
 */
import { useState, type ReactNode } from 'react';
import {
  Activity,
  Cpu,
  LayoutGrid,
  Monitor,
  MonitorOff,
  Moon,
  Pencil,
  PencilOff,
  RefreshCw,
  ScanEye,
  Sun,
  Thermometer,
  Timer,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useAppState } from '../../state/appState';
import { themeActions } from '../../state/dataActions';
import type { ThemeMode } from '../../state/types';
import { actions, type SystemInfo } from '../api';
import { LayoutMiniMap } from '../components/LayoutMiniMap';
import { Stat, UsageBar } from '../components/Stats';
import { formatDuration, formatNumber, formatTime } from '../format';
import type { PollState } from '../hooks/usePoll';
import { useSystemInfo } from '../hooks/useSystemInfo';
import { href, navigate } from '../router';
import { isHighLoad, sessionText, temperatureTone } from '../systemText';
import {
  Button,
  Card,
  LinkButton,
  Notice,
  PageHeader,
  Segmented,
  Spinner,
  StatusDot,
  toast,
  toastResult,
  type SegmentedOption,
  type StatusTone,
} from '../ui';

const STATUS_INTERVAL_MS = 15_000;

function KioskStatusCard({ poll }: { poll: PollState<SystemInfo> }) {
  const { data: info, error, loading, lastUpdated, refresh } = poll;
  const online = info !== null && error === null;
  const tone: StatusTone = online ? 'ok' : loading ? 'idle' : 'error';
  const status = online ? 'Online' : loading ? 'Prüfe…' : 'Offline';

  return (
    <Card
      className="r-overview-status"
      title="Kiosk-Status"
      icon={Activity}
      subtitle={info ? `${info.hostname} · Version ${info.version}${info.commit ? ` (${info.commit})` : ''}` : undefined}
      actions={
        <>
          <span className={`r-pill r-pill-${tone}`}>
            <StatusDot tone={tone} pulse={loading && !online} />
            {status}
          </span>
          <Button variant="ghost" size="sm" iconOnly icon={RefreshCw} busy={loading && info !== null} onClick={refresh}>
            Status aktualisieren
          </Button>
        </>
      }
      footer={lastUpdated !== null ? `Aktualisiert um ${formatTime(lastUpdated, true)}` : undefined}
    >
      {error && (
        <Notice tone={info ? 'warning' : 'error'} title={info ? 'Keine aktuelle Antwort vom Kiosk' : 'Status nicht verfügbar'}>
          {info && lastUpdated !== null ? `Angezeigt werden die Werte von ${formatTime(lastUpdated)}. ` : ''}
          {error}
        </Notice>
      )}
      {!info && !error && <Spinner label="Status wird geladen…" />}
      {info && (
        <>
          <div className="r-stats">
            <Stat icon={Timer} label="Laufzeit" value={formatDuration(info.uptimeSeconds)} detail={`App: ${formatDuration(info.appUptimeSeconds)}`} />
            <Stat
              icon={Thermometer}
              label="CPU-Temperatur"
              value={info.cpuTempC === null ? 'unbekannt' : `${formatNumber(info.cpuTempC, 0)} °C`}
              tone={info.cpuTempC === null ? undefined : temperatureTone(info.cpuTempC)}
            />
            <Stat
              icon={Cpu}
              label="Last"
              value={info.load.map((value) => formatNumber(value, 2)).join(' / ')}
              detail={`${info.cpuCount} ${info.cpuCount === 1 ? 'Kern' : 'Kerne'} · 1 / 5 / 15 Min.`}
              tone={isHighLoad(info.load[0], info.cpuCount) ? 'warn' : undefined}
            />
            <Stat
              icon={Monitor}
              label="Bildschirm"
              value={info.viewport ? `${info.viewport.width} × ${info.viewport.height}` : 'unbekannt'}
              detail={sessionText(info)}
            />
          </div>
          <div className="r-usages">
            <UsageBar label="Arbeitsspeicher" used={info.memTotal - info.memAvailable} total={info.memTotal} />
            <UsageBar label="Speicherplatz" used={info.diskTotal - info.diskAvailable} total={info.diskTotal} />
          </div>
          {info.ips.length > 0 && (
            <div className="r-chips" aria-label="IP-Adressen">
              {info.ips.map((ip) => (
                <span key={ip} className="r-chip">
                  {ip}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const THEME_OPTIONS: readonly SegmentedOption<ThemeMode>[] = [
  { value: 'dark', label: 'Dunkel', icon: Moon },
  { value: 'light', label: 'Hell', icon: Sun },
];

type ActionKey = 'reload' | 'identify' | 'sleep' | 'wake' | 'edit-on' | 'edit-off';

function ActionRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="r-action-row" role="group" aria-label={title}>
      <span className="r-action-title">{title}</span>
      <div className="r-action-buttons">{children}</div>
    </div>
  );
}

function QuickActionsCard() {
  const mode = useAppState((s) => s.state.theme.mode);
  const [busy, setBusy] = useState<ActionKey | null>(null);

  const run = <T,>(key: ActionKey, task: () => Promise<T>, success: string | ((result: T) => string)) => {
    setBusy(key);
    void toastResult(task(), success).finally(() => setBusy(null));
  };

  const button = <T,>(key: ActionKey, icon: LucideIcon, label: string, task: () => Promise<T>, success: string | ((result: T) => string)) => (
    <Button icon={icon} busy={busy === key} disabled={busy !== null && busy !== key} onClick={() => run(key, task, success)}>
      {label}
    </Button>
  );

  const setMode = (next: ThemeMode) => {
    void themeActions.setMode(next).then((ok) => {
      if (ok) toast.success(`Kiosk-Design: ${next === 'dark' ? 'Dunkel' : 'Hell'}`);
    });
  };

  return (
    <Card className="r-overview-actions" title="Schnellaktionen" icon={Zap}>
      <div className="r-actions">
        <ActionRow title="Kiosk">
          {button('reload', RefreshCw, 'Neu laden', actions.reload, 'Kiosk wird neu geladen')}
          {button('identify', ScanEye, 'Identifizieren', actions.identify, 'Der Kiosk zeigt 10 Sekunden lang Name und Adresse an')}
        </ActionRow>
        <ActionRow title="Bildschirm">
          {button('sleep', MonitorOff, 'Aus', actions.displaySleep, (backend) => (backend ? `Bildschirm ausgeschaltet (${backend})` : 'Bildschirm ausgeschaltet'))}
          {button('wake', Monitor, 'An', actions.displayWake, 'Bildschirm eingeschaltet')}
        </ActionRow>
        <ActionRow title="Bearbeiten am Kiosk">
          {button('edit-on', Pencil, 'Ein', () => actions.editMode(true), 'Bearbeitungsmodus am Kiosk eingeschaltet')}
          {button('edit-off', PencilOff, 'Aus', () => actions.editMode(false), 'Bearbeitungsmodus am Kiosk ausgeschaltet')}
        </ActionRow>
        <div className="r-action-row" role="group" aria-label="Kiosk-Design">
          <span className="r-action-title">Kiosk-Design</span>
          <Segmented label="Kiosk-Design" value={mode} options={THEME_OPTIONS} onChange={setMode} block />
        </div>
      </div>
    </Card>
  );
}

function ScreenCard({ viewport }: { viewport: SystemInfo['viewport'] }) {
  return (
    <Card
      className="r-overview-screen"
      title="Bildschirm"
      icon={Monitor}
      subtitle={viewport ? 'Live-Ansicht – auf ein Widget tippen, um es einzurichten' : 'Bildschirmgrösse unbekannt – Vorschau im Format 16:9'}
      actions={
        <LinkButton href={href('layout')} size="sm" icon={LayoutGrid}>
          Layout
        </LinkButton>
      }
    >
      <LayoutMiniMap viewport={viewport} onSelect={(instanceId) => navigate(href('widgets', instanceId))} />
    </Card>
  );
}

export function OverviewPage() {
  const system = useSystemInfo(STATUS_INTERVAL_MS);
  return (
    <div className="r-page">
      <PageHeader title="Übersicht" description="Zustand des Kiosks und häufige Aktionen" />
      <div className="r-overview-grid">
        <KioskStatusCard poll={system} />
        <QuickActionsCard />
        <ScreenCard viewport={system.data?.viewport ?? null} />
      </div>
    </div>
  );
}
