/**
 * Fans of the kiosk computer (GET/POST /api/fans): speed and PWM duty, and –
 * where the chip lets SlateDesk – automatic, a fixed speed or a curve over the
 * CPU temperature. The safety rules (minimum speed, full speed when hot, fans
 * back to the BIOS when SlateDesk ends) live in src-tauri/src/fans.rs.
 */
import { useCallback, useMemo } from 'react';
import { Fan } from 'lucide-react';
import { SettingsForm } from '../../../components/settings/SettingsForm';
import type { SettingsField } from '../../../types/settings';
import { errorText, fans as loadFans, setFan, type FanInfo, type FanSetting, type FansReport } from '../../api';
import { formatNumber, formatTime } from '../../format';
import { usePoll } from '../../hooks/usePoll';
import { temperatureTone } from '../../systemText';
import { Card, LoadingRow, Notice, StatusDot, toast, type StatusTone } from '../../ui';

const POLL_MS = 3_000;
const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/Zenovs/SlateDesk/main/install.sh | sudo bash';
const DEFAULT_CURVE = { minTemp: 45, maxTemp: 75, minPercent: 30 };
const MODE_LABELS: Record<FanSetting['mode'], string> = { auto: 'Automatisch', fixed: 'Fest', curve: 'Kurve' };

function fanSchema(minPercent: number): SettingsField[] {
  const curve = (values: Record<string, unknown>) => values.mode === 'curve';
  return [
    {
      type: 'radio',
      key: 'mode',
      label: 'Regelung',
      options: [
        { value: 'auto', label: MODE_LABELS.auto },
        { value: 'fixed', label: MODE_LABELS.fixed },
        { value: 'curve', label: MODE_LABELS.curve },
      ],
    },
    {
      type: 'range',
      key: 'percent',
      label: 'Drehzahl',
      min: minPercent,
      max: 100,
      step: 5,
      unit: '%',
      showIf: (values) => values.mode === 'fixed',
    },
    { type: 'range', key: 'minPercent', label: 'Mindestens', min: minPercent, max: 100, step: 5, unit: '%', showIf: curve },
    { type: 'range', key: 'minTemp', label: 'Schneller ab', min: 30, max: 80, step: 1, unit: '°C', showIf: curve },
    { type: 'range', key: 'maxTemp', label: 'Volle Drehzahl ab', min: 35, max: 84, step: 1, unit: '°C', showIf: curve },
  ];
}

function formValues(fan: FanInfo, minPercent: number): Record<string, unknown> {
  const { setting } = fan;
  // Switching to «Fest» starts at the current speed – no jump.
  const current = Math.max(minPercent, Math.round((fan.percent ?? 50) / 5) * 5);
  return {
    mode: setting.mode,
    percent: setting.mode === 'fixed' ? setting.percent : current,
    minTemp: setting.mode === 'curve' ? setting.minTemp : DEFAULT_CURVE.minTemp,
    maxTemp: setting.mode === 'curve' ? setting.maxTemp : DEFAULT_CURVE.maxTemp,
    minPercent: setting.mode === 'curve' ? setting.minPercent : Math.max(minPercent, DEFAULT_CURVE.minPercent),
  };
}

/** The setting for the form values, or why they do not work. */
function toSetting(values: Record<string, unknown>): FanSetting | string {
  const num = (key: string) => Number(values[key]);
  if (values.mode === 'fixed') return { mode: 'fixed', percent: num('percent') };
  if (values.mode === 'curve') {
    if (num('minTemp') >= num('maxTemp')) return '«Schneller ab» muss tiefer liegen als «Volle Drehzahl ab»';
    return { mode: 'curve', minTemp: num('minTemp'), maxTemp: num('maxTemp'), minPercent: num('minPercent') };
  }
  return { mode: 'auto' };
}

function fanState(fan: FanInfo): { tone: StatusTone; label: string } {
  if (fan.guarded) return { tone: 'warn', label: 'Temperaturschutz: 100 %' };
  if (fan.controlled) return { tone: 'ok', label: `SlateDesk: ${MODE_LABELS[fan.setting.mode]}` };
  return { tone: 'idle', label: 'BIOS regelt' };
}

interface FanRowProps {
  fan: FanInfo;
  minPercent: number;
  onChange: (fan: FanInfo, values: Record<string, unknown>) => void;
}

function FanRow({ fan, minPercent, onChange }: FanRowProps) {
  const values = useMemo(() => formValues(fan, minPercent), [fan, minPercent]);
  const schema = useMemo(() => fanSchema(minPercent), [minPercent]);
  const state = fanState(fan);
  const meta = [
    fan.chip,
    fan.rpm !== null ? `${formatNumber(fan.rpm, 0)} U/min` : 'ohne Drehzahlsensor',
    fan.percent !== null ? `Ausgang ${fan.percent} %` : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="r-fan">
      <div className="r-fan-head">
        <div>
          <div className="r-fan-name">{fan.name}</div>
          <div className="r-fan-meta">{meta.join(' · ')}</div>
        </div>
        {(fan.controllable || fan.percent !== null) && (
          <span className={`r-pill r-pill-${state.tone}`}>
            <StatusDot tone={state.tone} />
            {state.label}
          </span>
        )}
      </div>
      {fan.controllable && (
        <div className="r-settings">
          <SettingsForm
            schema={schema}
            values={values}
            onChange={(patch) => onChange(fan, { ...values, ...patch })}
            context="remote"
          />
        </div>
      )}
    </div>
  );
}

function Notices({ report }: { report: FansReport }) {
  if (report.fans.length === 0) {
    return (
      <Notice tone="info" title="Keine Lüfter gefunden">
        Dieses Gerät meldet Linux keine Lüfter – bei vielen Mini-PCs (z. B. HP EliteDesk) regelt das BIOS sie allein. Die
        Lüfterkurve lässt sich dann nur im BIOS einstellen.
      </Notice>
    );
  }
  const controllable = report.fans.some((fan) => fan.controllable);
  return (
    <>
      {report.needsAccess && (
        <Notice tone="warning" title="SlateDesk darf die Lüfter noch nicht steuern">
          Einmal die Installation erneut ausführen, am Kiosk im Terminal: <code className="r-code">{INSTALL_COMMAND}</code>
        </Notice>
      )}
      {!controllable && !report.needsAccess && (
        <Notice tone="info" title="Nur ablesbar">
          Diese Lüfter melden ihre Drehzahl, haben aber keinen steuerbaren Ausgang – geregelt werden sie vom BIOS.
        </Notice>
      )}
      {controllable && (
        <Notice tone="info" title="Regelung und Schutz">
          Automatisch: der Chip bzw. das BIOS regelt wie ohne SlateDesk. Kurve: nach der CPU-Temperatur. Nie unter{' '}
          {report.minPercent} %, ab {report.guardTempC} °C CPU-Temperatur immer volle Drehzahl. Beendet sich SlateDesk –
          auch durch einen Absturz –, regelt wieder der Chip bzw. das BIOS.
        </Notice>
      )}
    </>
  );
}

export function FansCard() {
  const poll = usePoll(loadFans, POLL_MS);
  const { data: report, error, lastUpdated, refresh } = poll;

  const change = useCallback(
    (fan: FanInfo, values: Record<string, unknown>) => {
      const setting = toSetting(values);
      if (typeof setting === 'string') {
        toast.error(setting);
        return;
      }
      setFan(fan.id, setting).then(
        () => {
          refresh();
          if (setting.mode !== fan.setting.mode) toast.success(`${fan.name}: ${MODE_LABELS[setting.mode]}`);
        },
        (err: unknown) => toast.error(errorText(err)),
      );
    },
    [refresh],
  );

  const temp = report?.cpuTempC ?? null;
  const tempTone = temp !== null ? temperatureTone(temp) : 'idle';

  return (
    <Card
      title="Lüfter"
      icon={Fan}
      subtitle="Drehzahl und Regelung der Lüfter dieses Geräts."
      actions={
        temp !== null ? (
          <span className={`r-pill r-pill-${tempTone}`}>
            <StatusDot tone={tempTone} />
            CPU {formatNumber(temp, 0)} °C
          </span>
        ) : undefined
      }
      footer={lastUpdated !== null ? `Aktualisiert um ${formatTime(lastUpdated, true)}` : undefined}
    >
      {error && (
        <Notice tone={report ? 'warning' : 'error'} title={report ? 'Keine aktuelle Antwort vom Kiosk' : 'Lüfter nicht verfügbar'}>
          {error}
        </Notice>
      )}
      {!report && !error && <LoadingRow label="Lüfter werden gesucht…" />}
      {report && report.fans.length > 0 && (
        <div className="r-fans">
          {report.fans.map((fan) => (
            <FanRow key={fan.id} fan={fan} minPercent={report.minPercent} onChange={change} />
          ))}
        </div>
      )}
      {report && <Notices report={report} />}
    </Card>
  );
}
