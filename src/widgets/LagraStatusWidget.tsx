/**
 * lagra Übersicht – Ampel und Kacheln aus GET /api/v1/uebersicht.
 *
 * Nur Zahlen und Zustände: Der Bildschirm hängt dort, wo auch Besuch steht.
 * «nas» wird separat und seltener geholt – lagra fragt dafür das NAS selbst
 * und braucht bis zu 15 s, länger als der Kiosk auf eine Antwort wartet.
 * Kennt lagra die Übersicht noch nicht (404), zeigt die Kachel wenigstens den
 * Virenscanner aus GET /api/v1/pruefen – höchstens alle 10 min abgefragt, weil
 * lagra jeden dieser Aufrufe protokolliert.
 */
import { useMemo, type ReactNode } from 'react';
import {
  Archive,
  Cpu,
  HardDrive,
  Images,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  MessagesSquare,
  Plug,
  Server,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import {
  fetchPruefenFallback,
  fetchUebersicht,
  isLagraEndpointMissing,
  type LagraErrorKind,
  readSection,
} from '../lagra/client';
import type {
  LagraApi,
  LagraArchiv,
  LagraDam,
  LagraFeedback,
  LagraJobsTeil,
  LagraNas,
  LagraPotentiale,
  LagraPruefen,
  LagraSection,
  LagraServer,
  LagraUebersicht,
  LagraViren,
} from '../lagra/types';
import type { WidgetProps } from '../types/widget';
import {
  LAGRA_STATUS_DEFAULTS,
  LAGRA_STATUS_LABELS,
  LAGRA_STATUS_SECTIONS,
  type LagraStatusSection,
  type LagraStatusSettings,
} from './manifests/lagra-status';
import {
  formatAgo,
  formatBytesOf,
  formatClock,
  formatCount,
  formatDaysAgo,
  formatDecimal,
  formatDuration,
  formatPercent,
  formatTemperature,
  parseClamdDate,
  parseTime,
  percentOf,
} from './shared/format';
import { useLagraPolling, useNow } from './shared/hooks';
import { LagraErrorMessage, LagraSetupMessage, LagraStaleBanner } from './shared/LagraParts';
import { Meter, Spinner, StatusDot, WidgetBanner, WidgetMessage } from './shared/WidgetParts';
import { readBoolean, readNumber, temperatureTone, type Tone, usageTone, worseTone } from './shared/values';
import './styles/lagra-status.css';

const DAY_MS = 24 * 60 * 60_000;
/** NAS values change slowly and cost lagra three DSM calls each (cached 60 s there). */
const NAS_MIN_INTERVAL_MS = 120_000;
const MAX_DISKS = 4;
const MAX_TOKENS = 4;

type MainResult =
  | { kind: 'uebersicht'; data: LagraUebersicht }
  /** lagra without /uebersicht – only the virus scanner via /pruefen (up to 10 min old). */
  | { kind: 'fallback'; pruefen: LagraPruefen | null };

interface Finding {
  tone: Tone;
  text: string;
}

const LEVEL_TEXT: Partial<Record<Tone, string>> = {
  ok: 'Alles in Ordnung',
  warn: 'Hinweis',
  error: 'Störung',
};

/** Only warnings and errors colour a tile; normal fill levels stay neutral. */
const alertTone = (tone: Tone): Tone => (tone === 'warn' || tone === 'error' ? tone : 'neutral');

// ── Building blocks ──────────────────────────────────────────────────────────

interface TileProps {
  icon: LucideIcon;
  title: string;
  tone?: Tone;
  children: ReactNode;
}

function Tile({ icon: Icon, title, tone = 'neutral', children }: TileProps) {
  return (
    <section className={`ls-tile wp-tone-${tone}${tone === 'warn' || tone === 'error' ? ' ls-tile-alert' : ''}`}>
      <header className="ls-tile-title">
        <Icon aria-hidden="true" />
        <span>{title}</span>
      </header>
      {children}
    </section>
  );
}

function Big({ value, label }: { value: string; label: string }) {
  return (
    <div className="ls-big">
      <span className="ls-big-value">{value}</span>
      <span className="ls-big-label">{label}</span>
    </div>
  );
}

function State({ tone, text }: { tone: Tone; text: string }) {
  return (
    <div className="ls-state">
      <StatusDot tone={tone} label={text} />
      <span>{text}</span>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div className={`ls-row${tone ? ` ls-row-toned wp-tone-${tone}` : ''}`}>
      <span className="ls-row-label">{label}</span>
      <span className="ls-row-value">{value}</span>
    </div>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className={`ls-count${tone ? ` ls-row-toned wp-tone-${tone}` : ''}`}>
      <span className="ls-count-value">{formatCount(value)}</span>
      <span className="ls-count-label">{label}</span>
    </div>
  );
}

// ── Tiles ────────────────────────────────────────────────────────────────────

function ServerTile({ server }: { server: LagraServer }) {
  const ramPercent = percentOf(server.ramBelegt, server.ramGesamt);
  const gpu = server.gpu;
  const vramPercent = gpu ? percentOf(gpu.vramBelegt, gpu.vramGesamt) : 0;
  const disks = server.laufwerke.slice(0, MAX_DISKS).map((disk) => ({ ...disk, percent: percentOf(disk.belegt, disk.gesamt) }));
  const cpuTone = temperatureTone(server.cpuTemp, 80, 90);
  const gpuTone = temperatureTone(gpu?.temp, 80, 88);
  const temps = [
    server.cpuTemp !== null ? `CPU ${formatTemperature(server.cpuTemp)}` : null,
    gpu && gpu.temp !== null ? `GPU ${formatTemperature(gpu.temp)}` : null,
  ].filter((text): text is string => text !== null);
  const tone = [usageTone(ramPercent), ...disks.map((disk) => usageTone(disk.percent)), cpuTone, gpuTone]
    .map(alertTone)
    .reduce(worseTone, 'neutral');

  return (
    <Tile icon={Cpu} title="Server" tone={tone}>
      <Big value={server.cpuProzent === null ? '–' : formatPercent(server.cpuProzent)} label="CPU" />
      <div className="ls-more">
        <Meter label="RAM" value={formatBytesOf(server.ramBelegt, server.ramGesamt)} percent={ramPercent} tone={usageTone(ramPercent)} />
        {gpu && <Meter label="GPU" value={formatPercent(gpu.auslastung)} percent={gpu.auslastung} />}
        {gpu && (
          <Meter label="VRAM" value={formatBytesOf(gpu.vramBelegt, gpu.vramGesamt)} percent={vramPercent} tone={usageTone(vramPercent)} />
        )}
        {temps.length > 0 && <Row label="Temperatur" value={temps.join(' · ')} tone={alertTone(worseTone(cpuTone, gpuTone))} />}
        {disks.map((disk) => (
          <Meter
            key={disk.name}
            label={disk.name}
            value={formatPercent(disk.percent)}
            percent={disk.percent}
            tone={usageTone(disk.percent)}
          />
        ))}
        <div className="ls-details">
          {server.last.length > 0 && (
            <Row label="Last" value={`${formatDecimal(server.last[0], 2)} · ${formatCount(server.kerne)} Kerne`} />
          )}
          {server.leistungW !== null && <Row label="Leistung" value={`${formatCount(server.leistungW)}\u00a0W`} />}
          <Row label="Laufzeit" value={formatDuration(server.laufzeitSek)} />
        </div>
      </div>
    </Tile>
  );
}

function JobsTile({ jobs, now }: { jobs: LagraJobsTeil; now: number }) {
  const running = jobs.laufend;
  const stalled = jobs.zeitplan.steht === true;
  const lastTick = parseTime(jobs.zeitplan.letzterTakt);
  const latest = jobs.zuletzt[0];
  const latestAt = latest ? parseTime(latest.ende ?? latest.beginn) : null;
  const tone: Tone = stalled ? 'error' : jobs.fehler24h > 0 ? 'warn' : 'neutral';

  return (
    <Tile icon={ListChecks} title="Aufgaben" tone={tone}>
      <Big value={formatCount(running.length)} label={running.length === 1 ? 'läuft' : 'laufen'} />
      <div className="ls-more">
        {running.slice(0, 3).map((job) => (
          <div key={job.id} className="ls-job">
            <Spinner label="läuft" />
            <span className="ls-job-name">{job.name}</span>
            {job.fortschritt && <span className="ls-job-progress">{job.fortschritt}</span>}
          </div>
        ))}
        <Row label="Fehler (24 Std.)" value={formatCount(jobs.fehler24h)} tone={jobs.fehler24h > 0 ? 'warn' : undefined} />
        {stalled && (
          <Row label="Zeitplan" value={lastTick !== null ? `steht seit ${formatClock(lastTick)}` : 'steht'} tone="error" />
        )}
        {latest && latestAt !== null && (
          <div className="ls-details">
            <Row label="Zuletzt" value={`${latest.name} · ${formatAgo(latestAt, now)}`} />
          </div>
        )}
      </div>
    </Tile>
  );
}

function virenState(eingerichtet: boolean, erreichbar: boolean): { tone: Tone; text: string } {
  if (!eingerichtet) return { tone: 'neutral', text: 'Nicht eingerichtet' };
  return erreichbar ? { tone: 'ok', text: 'Aktiv' } : { tone: 'error', text: 'Antwortet nicht' };
}

function VirenTile({ viren, now }: { viren: LagraViren; now: number }) {
  const state = virenState(viren.eingerichtet, viren.erreichbar);
  const lastFind = viren.letzterFund ? parseTime(viren.letzterFund.am) : null;
  const tone = worseTone(alertTone(state.tone), viren.signaturenVeraltet || viren.funde7Tage > 0 ? 'warn' : 'neutral');

  return (
    <Tile icon={state.tone === 'error' ? ShieldAlert : ShieldCheck} title="Virenscanner" tone={tone}>
      <State tone={state.tone} text={state.text} />
      <div className="ls-more">
        <Row
          label="Signaturen"
          value={viren.signaturenAlterTage === null ? 'unbekannt' : formatDaysAgo(viren.signaturenAlterTage)}
          tone={viren.signaturenVeraltet ? 'warn' : undefined}
        />
        <Row label="Heute geprüft" value={formatCount(viren.heuteGeprueft)} />
        <Row label="Funde (7 Tage)" value={formatCount(viren.funde7Tage)} tone={viren.funde7Tage > 0 ? 'warn' : undefined} />
        <div className="ls-details">
          {viren.fehlerHeute > 0 && <Row label="Prüffehler heute" value={formatCount(viren.fehlerHeute)} tone="warn" />}
          {lastFind !== null && <Row label="Letzter Fund" value={formatAgo(lastFind, now)} />}
          {viren.version && <Row label="Version" value={viren.version} />}
        </div>
      </div>
    </Tile>
  );
}

/** Virus scanner from /pruefen (lagra without /uebersicht). */
function PruefenTile({ pruefen, now }: { pruefen: LagraPruefen; now: number }) {
  const state = virenState(pruefen.eingerichtet, pruefen.erreichbar);
  const stand = parseClamdDate(pruefen.signaturenStand);
  const ageDays = stand !== null ? Math.max(0, Math.floor((now - stand) / DAY_MS)) : null;
  // Same threshold as lagra's own «signaturenVeraltet».
  const outdated = ageDays !== null && ageDays > 3;
  const tone = worseTone(alertTone(state.tone), outdated ? 'warn' : 'neutral');

  return (
    <Tile icon={state.tone === 'error' ? ShieldAlert : ShieldCheck} title="Virenscanner" tone={tone}>
      <State tone={state.tone} text={state.text} />
      <div className="ls-more">
        {ageDays !== null && <Row label="Signaturen" value={formatDaysAgo(ageDays)} tone={outdated ? 'warn' : undefined} />}
        {pruefen.version && <Row label="Version" value={pruefen.version} />}
      </div>
    </Tile>
  );
}

function DamTile({ dam, now }: { dam: LagraDam; now: number }) {
  const kiPercent = percentOf(dam.ki.verschlagwortet, dam.ki.bilder);
  const indexRun = dam.nas.find((nas) => nas.index?.laeuft)?.index ?? null;
  const fullRun = dam.letzterVollerLauf;
  const fullRunAt = fullRun ? parseTime(fullRun.ende ?? fullRun.beginn) : null;
  const fullRunFailed = fullRun?.status === 'fehler' || fullRun?.status === 'abgebrochen';

  return (
    <Tile icon={Images} title="DAM">
      <Big value={formatCount(dam.gesamt)} label="Dateien" />
      <div className="ls-more">
        <Row label="Vorschauen ausstehend" value={formatCount(dam.vorschauen.ausstehend)} />
        <Row label="Vorschauen fehlgeschlagen" value={formatCount(dam.vorschauen.fehlgeschlagen)} />
        {dam.ki.bilder > 0 && (
          <Meter
            label="KI-Verschlagwortung"
            value={formatPercent(kiPercent)}
            percent={kiPercent}
            tone={kiPercent >= 100 ? 'ok' : 'accent'}
          />
        )}
        <div className="ls-details">
          {indexRun ? (
            <Row label="Index läuft" value={`${formatCount(indexRun.dateienGesehen)} Dateien`} tone="accent" />
          ) : (
            fullRunAt !== null && (
              <Row
                label="Voller Lauf"
                value={fullRunFailed ? `fehlgeschlagen · ${formatAgo(fullRunAt, now)}` : formatAgo(fullRunAt, now)}
                tone={fullRunFailed ? 'warn' : undefined}
              />
            )
          )}
          {dam.offeneAufbereitungen > 0 && <Row label="Aufbereitung offen" value={formatCount(dam.offeneAufbereitungen)} />}
        </div>
      </div>
    </Tile>
  );
}

function ArchivTile({ archiv, now }: { archiv: LagraArchiv; now: number }) {
  if (!archiv.eingerichtet) {
    return (
      <Tile icon={Archive} title="Archiv">
        <State tone="neutral" text="Nicht eingerichtet" />
      </Tile>
    );
  }
  const lastIndex = parseTime(archiv.letzterIndex);
  const run = archiv.lauf;
  const runFailed = run !== null && !run.laeuft && run.fehler;

  return (
    <Tile icon={Archive} title="Archiv" tone={archiv.lueckenhaft || runFailed ? 'warn' : 'neutral'}>
      <Big value={formatCount(archiv.dateien)} label="Dateien" />
      <div className="ls-more">
        {run?.laeuft ? (
          <Row label="Abgleich läuft" value={`${formatCount(run.gelesen)} gelesen`} tone="accent" />
        ) : (
          <Row label="Letzter Abgleich" value={lastIndex !== null ? formatAgo(lastIndex, now) : 'noch nie'} />
        )}
        {runFailed && <Row label="Abgleich" value="mit Fehlern beendet" tone="warn" />}
        {archiv.lueckenhaft && <Row label="Index" value="unvollständig" tone="warn" />}
      </div>
    </Tile>
  );
}

function FeedbackTile({ feedback }: { feedback: LagraFeedback }) {
  return (
    <Tile icon={MessagesSquare} title={LAGRA_STATUS_LABELS.feedback}>
      <div className="ls-counts">
        <Count label="Ungelesen" value={feedback.ungelesen} tone={feedback.ungelesen > 0 ? 'accent' : undefined} />
        <Count label="Offen" value={feedback.offen} />
        <Count label="Offene Punkte" value={feedback.offenePunkte} />
        <Count label="Neu (7 Tage)" value={feedback.neu7Tage} />
      </div>
    </Tile>
  );
}

function PotentialeTile({ potentiale, now }: { potentiale: LagraPotentiale; now: number }) {
  const run = potentiale.letzterLauf;
  const runAt = run ? parseTime(run.ende ?? run.beginn) : null;
  const runFailed = run?.status === 'fehler' || run?.status === 'abgebrochen';

  return (
    <Tile icon={Lightbulb} title="Potentiale">
      <div className="ls-counts">
        <Count label="Vorgeschlagen" value={potentiale.vorgeschlagen} />
        <Count label="Angenommen" value={potentiale.angenommen} />
        <Count label="Übergeben" value={potentiale.uebergeben} />
        <Count label="Verworfen" value={potentiale.verworfen} />
      </div>
      {runAt !== null && (
        <div className="ls-details">
          <Row
            label="Letzter Lauf"
            value={runFailed ? `fehlgeschlagen · ${formatAgo(runAt, now)}` : formatAgo(runAt, now)}
            tone={runFailed ? 'warn' : undefined}
          />
        </div>
      )}
    </Tile>
  );
}

function ApiTile({ api, now }: { api: LagraApi; now: number }) {
  const tokens = api.tokens
    .map((token) => ({ name: token.name, at: parseTime(token.zuletzt) }))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, MAX_TOKENS);

  return (
    <Tile icon={Plug} title="Schnittstellen" tone={api.fehler24h > 0 || !api.ollama ? 'warn' : 'neutral'}>
      <State tone={api.ollama ? 'ok' : 'warn'} text={api.ollama ? 'Ollama erreichbar' : 'Ollama nicht erreichbar'} />
      <div className="ls-more">
        <Row label="Aufrufe (24 Std.)" value={formatCount(api.aufrufe24h)} />
        <Row label="Fehler (24 Std.)" value={formatCount(api.fehler24h)} tone={api.fehler24h > 0 ? 'warn' : undefined} />
        {tokens.length > 0 && (
          <div className="ls-details">
            {tokens.map((token) => (
              <Row key={token.name} label={token.name} value={token.at !== null ? formatAgo(token.at, now) : 'nie'} />
            ))}
          </div>
        )}
      </div>
    </Tile>
  );
}

function NasTile({ nas }: { nas: LagraNas }) {
  if (!nas.erreichbar) {
    return (
      <Tile icon={HardDrive} title={`NAS · ${nas.name}`} tone="error">
        <State tone="error" text="Nicht erreichbar" />
      </Tile>
    );
  }
  const volumes = nas.volumen.map((volume) => ({ ...volume, percent: percentOf(volume.belegt, volume.gesamt) }));
  const tempTone = worseTone(temperatureTone(nas.tempC, 60, 70), temperatureTone(nas.diskTempMax, 50, 60));
  const temps = [
    nas.tempC !== null ? formatTemperature(nas.tempC) : null,
    nas.diskTempMax !== null ? `Disks ${formatTemperature(nas.diskTempMax)}` : null,
  ].filter((text): text is string => text !== null);
  const tone = [...volumes.map((volume) => usageTone(volume.percent)), tempTone].map(alertTone).reduce(worseTone, 'neutral');

  return (
    <Tile icon={HardDrive} title={`NAS · ${nas.name}`} tone={tone}>
      <State tone="ok" text="Online" />
      <div className="ls-more">
        {volumes.map((volume) => (
          <Meter
            key={volume.name}
            label={volume.name}
            value={formatBytesOf(volume.belegt, volume.gesamt)}
            percent={volume.percent}
            tone={usageTone(volume.percent)}
          />
        ))}
        {temps.length > 0 && <Row label="Temperatur" value={temps.join(' · ')} tone={alertTone(tempTone)} />}
        {(nas.cpuProzent !== null || nas.ramProzent !== null) && (
          <div className="ls-details">
            <Row
              label="CPU · RAM"
              value={`${nas.cpuProzent !== null ? formatPercent(nas.cpuProzent) : '–'} · ${nas.ramProzent !== null ? formatPercent(nas.ramProzent) : '–'}`}
            />
          </div>
        )}
      </div>
    </Tile>
  );
}

const SECTION_ICONS: Record<LagraStatusSection, LucideIcon> = {
  server: Cpu,
  jobs: ListChecks,
  viren: ShieldAlert,
  dam: Images,
  archiv: Archive,
  feedback: MessagesSquare,
  potentiale: Lightbulb,
  api: Plug,
  nas: HardDrive,
};

/** A section lagra could not read – its own error text stays off the wall. */
function MissingTile({ section }: { section: LagraStatusSection }) {
  return (
    <Tile icon={SECTION_ICONS[section]} title={LAGRA_STATUS_LABELS[section]} tone="warn">
      <State tone="warn" text="Keine Daten von lagra" />
    </Tile>
  );
}

function sectionTile<T>(
  section: LagraStatusSection,
  value: LagraSection<T> | undefined,
  render: (data: T) => ReactNode,
): ReactNode {
  const { data, error } = readSection(value);
  if (data !== null) return render(data);
  return error !== null ? <MissingTile key={section} section={section} /> : null;
}

// ── Status light ─────────────────────────────────────────────────────────────

function sectionFindings(data: LagraUebersicht): Finding[] {
  const findings: Finding[] = [];
  const jobs = readSection(data.jobs).data;
  if (jobs?.zeitplan.steht === true) findings.push({ tone: 'error', text: 'Zeitplan steht' });
  if (jobs && jobs.fehler24h > 0) {
    findings.push({ tone: 'warn', text: `${formatCount(jobs.fehler24h)} Fehler bei Aufgaben (24 Std.)` });
  }
  const viren = readSection(data.viren).data;
  if (viren?.eingerichtet && !viren.erreichbar) findings.push({ tone: 'error', text: 'Virenscanner antwortet nicht' });
  if (viren?.signaturenVeraltet) {
    findings.push({
      tone: 'warn',
      text:
        viren.signaturenAlterTage !== null
          ? `Virensignaturen ${formatCount(viren.signaturenAlterTage)} Tage alt`
          : 'Virensignaturen veraltet',
    });
  }
  for (const section of LAGRA_STATUS_SECTIONS) {
    if (section === 'nas') continue;
    if (readSection(data[section]).error !== null) {
      findings.push({ tone: 'warn', text: `${LAGRA_STATUS_LABELS[section]}: keine Daten` });
    }
  }
  return findings;
}

function nasFindings(nas: LagraSection<LagraNas[]> | undefined): Finding[] {
  const { data, error } = readSection(nas);
  if (error !== null) return [{ tone: 'warn', text: 'NAS: keine Daten' }];
  const offline = data?.filter((entry) => !entry.erreichbar).length ?? 0;
  return offline > 0 ? [{ tone: 'error', text: offline === 1 ? 'NAS nicht erreichbar' : `${offline} NAS nicht erreichbar` }] : [];
}

/** The request itself failed (data shown, if any, is from an earlier one). */
function requestFinding(kind: LagraErrorKind | null): Finding {
  switch (kind) {
    case 'unauthorized':
      return { tone: 'error', text: 'Token ungültig' };
    case 'unreachable':
      return { tone: 'error', text: 'lagra nicht erreichbar' };
    case 'endpointMissing':
      return { tone: 'warn', text: 'lagra-Update nötig' };
    default:
      return { tone: 'error', text: 'Aktualisierung fehlgeschlagen' };
  }
}

const TONE_ORDER: Tone[] = ['error', 'warn', 'ok', 'accent', 'neutral'];

// ── Widget ───────────────────────────────────────────────────────────────────

export function LagraStatusWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings<LagraStatusSettings>(instanceId, LAGRA_STATUS_DEFAULTS);
  const now = useNow(30_000);

  const sections = useMemo(
    () =>
      Object.fromEntries(
        LAGRA_STATUS_SECTIONS.map((section) => [section, readBoolean(raw[section], LAGRA_STATUS_DEFAULTS[section])]),
      ) as Record<LagraStatusSection, boolean>,
    [raw],
  );
  const refreshMs = readNumber(raw.refreshSeconds, LAGRA_STATUS_DEFAULTS.refreshSeconds, 10, 600) * 1000;
  const mainKey = LAGRA_STATUS_SECTIONS.filter((section) => section !== 'nas' && sections[section]).join(',');
  const wantViren = sections.viren;

  const main = useLagraPolling<MainResult>(
    async (signal) => {
      const teile = mainKey.split(',') as LagraStatusSection[];
      try {
        return { kind: 'uebersicht', data: await fetchUebersicht({ teile }, { signal }) };
      } catch (err) {
        if (!isLagraEndpointMissing(err)) throw err;
        // Reused for 10 min: this poll runs every refreshSeconds, lagra logs each /pruefen call.
        return { kind: 'fallback', pruefen: wantViren ? await fetchPruefenFallback({ signal }) : null };
      }
    },
    refreshMs,
    [mainKey, wantViren],
    mainKey !== '',
  );

  const nas = useLagraPolling(
    async (signal) => (await fetchUebersicht({ teile: ['nas'] }, { signal })).nas,
    Math.max(refreshMs, NAS_MIN_INTERVAL_MS),
    [],
    sections.nas,
  );

  if (main.setup !== 'ready') return <LagraSetupMessage setup={main.setup} />;
  if (mainKey === '' && !sections.nas) {
    return <WidgetMessage icon={Server} title="Keine Bereiche gewählt" detail="In den Einstellungen festlegen, was angezeigt wird." />;
  }

  // The leading poll decides about loading and full-size errors.
  const lead = mainKey !== '' ? main : nas;
  if (lead.data === null && lead.lastUpdated === null) {
    if (lead.error !== null) return <LagraErrorMessage kind={lead.errorKind} status={lead.errorStatus} />;
    return <WidgetMessage busy title="lagra wird abgefragt …" />;
  }

  const result = mainKey !== '' ? main.data : null;
  const uebersicht = result?.kind === 'uebersicht' ? result.data : null;
  const fallback = result?.kind === 'fallback' ? result : null;
  // Without /uebersicht there is no NAS section either – the update banner covers it.
  const showNas = sections.nas && fallback === null && nas.errorKind !== 'endpointMissing';
  const nasSection = nas.data ?? undefined;

  const findings: Finding[] = [];
  if (lead.error !== null) findings.push(requestFinding(lead.errorKind));
  if (fallback) {
    findings.push({ tone: 'warn', text: 'lagra-Update nötig' });
    if (fallback.pruefen?.eingerichtet && !fallback.pruefen.erreichbar) {
      findings.push({ tone: 'error', text: 'Virenscanner antwortet nicht' });
    }
  }
  if (uebersicht) findings.push(...sectionFindings(uebersicht));
  if (showNas) {
    if (lead !== nas && nas.error !== null) findings.push({ tone: 'warn', text: 'NAS: keine aktuellen Daten' });
    findings.push(...nasFindings(nasSection));
  }
  findings.sort((a, b) => TONE_ORDER.indexOf(a.tone) - TONE_ORDER.indexOf(b.tone));
  const level = findings.reduce<Tone>((worst, finding) => worseTone(worst, finding.tone), 'ok');

  const tiles: ReactNode[] = [];
  if (uebersicht) {
    if (sections.server) tiles.push(sectionTile('server', uebersicht.server, (data) => <ServerTile key="server" server={data} />));
    if (sections.jobs) tiles.push(sectionTile('jobs', uebersicht.jobs, (data) => <JobsTile key="jobs" jobs={data} now={now} />));
    if (sections.viren) tiles.push(sectionTile('viren', uebersicht.viren, (data) => <VirenTile key="viren" viren={data} now={now} />));
    if (sections.dam) tiles.push(sectionTile('dam', uebersicht.dam, (data) => <DamTile key="dam" dam={data} now={now} />));
    if (sections.archiv) {
      tiles.push(sectionTile('archiv', uebersicht.archiv, (data) => <ArchivTile key="archiv" archiv={data} now={now} />));
    }
    if (sections.feedback) {
      tiles.push(sectionTile('feedback', uebersicht.feedback, (data) => <FeedbackTile key="feedback" feedback={data} />));
    }
    if (sections.potentiale) {
      tiles.push(
        sectionTile('potentiale', uebersicht.potentiale, (data) => (
          <PotentialeTile key="potentiale" potentiale={data} now={now} />
        )),
      );
    }
    if (sections.api) tiles.push(sectionTile('api', uebersicht.api, (data) => <ApiTile key="api" api={data} now={now} />));
  }
  if (fallback?.pruefen) tiles.push(<PruefenTile key="pruefen" pruefen={fallback.pruefen} now={now} />);
  if (showNas) {
    if (nasSection !== undefined) {
      tiles.push(sectionTile('nas', nasSection, (list) => list.map((entry) => <NasTile key={`nas-${entry.name}`} nas={entry} />)));
    } else if (nas.error !== null) {
      tiles.push(<MissingTile key="nas" section="nas" />);
    }
  }

  const stale = lead.error !== null;
  const levelText = LEVEL_TEXT[level] ?? '';
  const reason = findings.length > 0 ? findings[0].text : null;

  return (
    <div className="ls">
      <div className="ls-head">
        <StatusDot tone={level} size="lg" label={`lagra: ${levelText}`} />
        <div className="ls-head-text">
          <span className="ls-head-level">{levelText}</span>
          {reason && (
            <span className="ls-head-reason">
              {reason}
              {findings.length > 1 && <span className="ls-head-more"> +{findings.length - 1}</span>}
            </span>
          )}
        </div>
        {lead.lastUpdated !== null && !stale && <span className="ls-head-time">Stand {formatClock(lead.lastUpdated)}</span>}
      </div>
      {stale && (
        <LagraStaleBanner
          kind={lead.errorKind}
          status={lead.errorStatus}
          failingSince={lead.failingSince}
          lastUpdated={lead.lastUpdated}
        />
      )}
      {fallback && (
        <WidgetBanner tone="warn" icon={TriangleAlert}>
          lagra-Update nötig – diese Version liefert nur den Virenscanner
        </WidgetBanner>
      )}
      {tiles.length > 0 && <div className={`ls-tiles${stale ? ' ls-tiles-stale' : ''}`}>{tiles}</div>}
    </div>
  );
}
