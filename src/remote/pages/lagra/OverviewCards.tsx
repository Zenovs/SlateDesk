/**
 * One card per section of lagra's GET /api/v1/uebersicht. Counts only –
 * the web UI is for admins, but nothing here needs names of customer work.
 */
import type { ReactNode } from 'react';
import {
  Archive,
  HardDrive,
  Images,
  KeyRound,
  Lightbulb,
  ListChecks,
  MessagesSquare,
  Server,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import type {
  LagraApi,
  LagraArchiv,
  LagraDam,
  LagraFeedback,
  LagraGpu,
  LagraJobsTeil,
  LagraLaufKurz,
  LagraNas,
  LagraPotentiale,
  LagraPruefen,
  LagraServer,
  LagraViren,
} from '../../../lagra/types';
import { Stat, UsageBar } from '../../components/Stats';
import { formatCount, formatDateTime, formatDuration, formatNumber, formatPercent, plural } from '../../format';
import { isHighLoad, temperatureTone } from '../../systemText';
import { Card, EmptyState, Notice, ProgressBar, StatusDot, type StatusTone } from '../../ui';
import {
  agoText,
  ASSET_LABELS,
  ASSET_ORDER,
  runLabel,
  runTone,
  schedulerProblem,
  signatureAge,
  sinceText,
  whenText,
} from './lagraText';

// ── Building blocks ──────────────────────────────────────────────────────────

function Pill({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`r-pill r-pill-${tone}`}>
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

interface SectionCardProps {
  icon: LucideIcon;
  title: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  children?: ReactNode;
}

function SectionCard({ icon, title, subtitle, status, children }: SectionCardProps) {
  return (
    <Card className="rg-card" icon={icon} title={title} subtitle={subtitle} actions={status}>
      {children}
    </Card>
  );
}

/** A section lagra could not deliver – the other sections still show. */
export function SectionErrorCard({ icon, title, message }: { icon: LucideIcon; title: string; message: string }) {
  return (
    <SectionCard icon={icon} title={title} status={<Pill tone="error">Fehler</Pill>}>
      <Notice tone="error">{message}</Notice>
    </SectionCard>
  );
}

/** «letzter Lauf: erfolgreich, heute 02:19 (vor 6 Std.) – 4 neue Ansätze». */
function LastRun({ label, run, now }: { label: string; run: LagraLaufKurz | null; now: number }) {
  if (!run) return null;
  const when = whenText(run.ende ?? run.beginn, now);
  return (
    <p className="rg-line">
      <StatusDot tone={runTone(run)} pulse={run.status === 'laeuft'} />
      <span>
        <strong>{label}:</strong> {runLabel(run)}
        {when ? `, ${when}` : ''}
        {run.ergebnis ? ` – ${run.ergebnis}` : ''}
      </span>
    </p>
  );
}

function CountProgress({ label, done, total }: { label: string; done: number; total: number }) {
  if (!(total > 0)) return null;
  const fraction = Math.min(1, Math.max(0, done / total));
  return (
    <div className="r-usage">
      <div className="r-usage-head">
        <span className="r-usage-label">{label}</span>
        <span className="r-usage-value">
          {formatCount(done)} von {formatCount(total)} ({formatPercent(fraction)})
        </span>
      </div>
      <ProgressBar value={fraction * 100} label={`${label}: ${formatPercent(fraction)}`} />
    </div>
  );
}

const percentText = (value: number | null): string => (value === null ? '–' : `${formatNumber(value, 1)} %`);
const celsiusText = (value: number | null): string => (value === null ? 'unbekannt' : `${formatNumber(value, 0)} °C`);
const wattText = (value: number | null): string => (value === null ? 'unbekannt' : `${formatNumber(value, 0)} W`);

// ── server ───────────────────────────────────────────────────────────────────

function GpuBlock({ gpu }: { gpu: LagraGpu }) {
  return (
    <div className="rg-subsection">
      <h3 className="rg-subtitle">Grafikkarte · {gpu.name}</h3>
      <div className="r-stats">
        <Stat label="Auslastung" value={percentText(gpu.auslastung)} />
        <Stat label="Temperatur" value={celsiusText(gpu.temp)} tone={gpu.temp !== null ? temperatureTone(gpu.temp) : undefined} />
        <Stat label="Leistung" value={wattText(gpu.leistungW)} />
        <Stat label="Lüfter" value={percentText(gpu.luefterProzent)} />
      </div>
      <UsageBar label="Grafikspeicher" used={gpu.vramBelegt} total={gpu.vramGesamt} />
    </div>
  );
}

export function ServerCard({ data }: { data: LagraServer }) {
  const fans = data.luefter.map((fan) => `${fan.name} ${formatCount(fan.upm)} U/min`).join(' · ');
  return (
    <SectionCard icon={Server} title="Server" subtitle={`Läuft seit ${formatDuration(data.laufzeitSek)}`}>
      <div className="r-stats">
        <Stat
          label="CPU"
          value={percentText(data.cpuProzent)}
          detail={plural(data.kerne, 'Kern', 'Kerne')}
          tone={data.cpuProzent !== null && data.cpuProzent >= 90 ? 'warn' : undefined}
        />
        <Stat
          label="Last"
          value={data.last.map((value) => formatNumber(value, 2)).join(' / ') || '–'}
          detail="1 / 5 / 15 Min."
          tone={isHighLoad(data.last[0] ?? 0, data.kerne) ? 'warn' : undefined}
        />
        <Stat
          label="CPU-Temperatur"
          value={celsiusText(data.cpuTemp)}
          tone={data.cpuTemp !== null ? temperatureTone(data.cpuTemp) : undefined}
        />
        <Stat label="Leistung" value={wattText(data.leistungW)} detail={fans || undefined} />
      </div>
      <div className="r-usages">
        <UsageBar label="Arbeitsspeicher" used={data.ramBelegt} total={data.ramGesamt} />
        {data.laufwerke.map((drive) => (
          <UsageBar key={drive.name} label={drive.name} used={drive.belegt} total={drive.gesamt} />
        ))}
      </div>
      {data.gpu && <GpuBlock gpu={data.gpu} />}
    </SectionCard>
  );
}

// ── jobs ─────────────────────────────────────────────────────────────────────

export function JobsSummaryCard({ data, now }: { data: LagraJobsTeil; now: number }) {
  const problem = schedulerProblem(data.zeitplan, now);
  return (
    <SectionCard
      icon={ListChecks}
      title="Aufgaben"
      subtitle={data.laufend.length > 0 ? `${plural(data.laufend.length, 'Aufgabe läuft', 'Aufgaben laufen')} gerade` : 'Zurzeit läuft keine Aufgabe'}
      status={
        data.fehler24h > 0 ? (
          <Pill tone="error">{formatCount(data.fehler24h)} Fehler (24 Std.)</Pill>
        ) : (
          <Pill tone="ok">Keine Fehler</Pill>
        )
      }
    >
      {problem && <Notice tone={problem.tone}>{problem.text}</Notice>}
      {data.laufend.length > 0 && (
        <ul className="rg-rows">
          {data.laufend.map((job) => {
            const since = sinceText(job.seit, now);
            return (
              <li key={job.id} className="rg-row">
                <StatusDot tone="info" pulse label="läuft" />
                <span className="rg-row-main">
                  <span className="rg-row-title">{job.name}</span>
                  <span className="rg-row-meta">{[job.fortschritt, since].filter(Boolean).join(' · ')}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {data.zuletzt.length > 0 && (
        <div className="rg-subsection">
          <h3 className="rg-subtitle">Zuletzt</h3>
          <ul className="rg-rows">
            {data.zuletzt.slice(0, 5).map((run) => (
              <li key={`${run.id}-${run.beginn}`} className="rg-row">
                <StatusDot tone={runTone(run)} label={runLabel(run)} />
                <span className="rg-row-main">
                  <span className="rg-row-title">{run.name}</span>
                  <span className="rg-row-meta">
                    {[runLabel(run), agoText(run.ende ?? run.beginn, now), run.ergebnis].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

// ── viren ────────────────────────────────────────────────────────────────────

function virenStatus(data: Pick<LagraViren, 'eingerichtet' | 'erreichbar'> & { signaturenVeraltet?: boolean }): ReactNode {
  if (!data.eingerichtet) return <Pill tone="idle">Nicht eingerichtet</Pill>;
  if (!data.erreichbar) return <Pill tone="error">Nicht erreichbar</Pill>;
  if (data.signaturenVeraltet) return <Pill tone="warn">Signaturen veraltet</Pill>;
  return <Pill tone="ok">Aktiv</Pill>;
}

export function VirenCard({ data, now }: { data: LagraViren; now: number }) {
  const lastFind = data.letzterFund ? whenText(data.letzterFund.am, now) : null;
  return (
    <SectionCard icon={ShieldCheck} title="Virenscanner" subtitle={data.version ?? undefined} status={virenStatus(data)}>
      {data.eingerichtet && !data.erreichbar && <Notice tone="error">{data.grund ?? 'Der Dienst antwortet nicht.'}</Notice>}
      {data.eingerichtet ? (
        <div className="r-stats">
          <Stat
            label="Signaturen"
            value={signatureAge(data.signaturenAlterTage)}
            detail={data.signaturen ? `Version ${data.signaturen}` : undefined}
            tone={data.signaturenVeraltet ? 'warn' : undefined}
          />
          <Stat label="Heute geprüft" value={formatCount(data.heuteGeprueft)} detail={`insgesamt ${formatCount(data.gesamtGeprueft)}`} />
          <Stat label="Fehler heute" value={formatCount(data.fehlerHeute)} tone={data.fehlerHeute > 0 ? 'warn' : undefined} />
          <Stat
            label="Funde (7 Tage)"
            value={formatCount(data.funde7Tage)}
            detail={`insgesamt ${formatCount(data.funde)}`}
            tone={data.funde7Tage > 0 ? 'error' : undefined}
          />
        </div>
      ) : (
        <EmptyState compact title="Nicht eingerichtet" description={data.grund ?? 'In lagra ist kein Virenscanner eingerichtet.'} />
      )}
      {data.letzterFund && (
        <p className="rg-line">
          <StatusDot tone="error" />
          <span>
            <strong>Letzter Fund:</strong> {lastFind ?? 'unbekannt'}
            {data.letzterFund.signatur ? ` – ${data.letzterFund.signatur}` : ''}
          </span>
        </p>
      )}
    </SectionCard>
  );
}

/** Fallback when lagra has no /uebersicht yet: only the virus scanner from /api/v1/pruefen. */
export function PruefenCard({ data }: { data: LagraPruefen }) {
  // clamd's English date text («Mon Oct 12 22:31:12 2026»); shown as is if it does not parse.
  const stand = data.signaturenStand ? Date.parse(data.signaturenStand) : Number.NaN;
  const standText = Number.isFinite(stand) ? `Stand ${formatDateTime(stand)}` : (data.signaturenStand ?? undefined);
  return (
    <SectionCard icon={ShieldCheck} title="Virenscanner" subtitle={data.version ?? undefined} status={virenStatus(data)}>
      {data.eingerichtet && !data.erreichbar && <Notice tone="error">{data.grund ?? 'Der Dienst antwortet nicht.'}</Notice>}
      <div className="r-stats">
        <Stat label="Signaturen" value={data.signaturen ? `Version ${data.signaturen}` : 'unbekannt'} detail={standText} />
      </div>
    </SectionCard>
  );
}

// ── dam ──────────────────────────────────────────────────────────────────────

export function DamCard({ data, now }: { data: LagraDam; now: number }) {
  const kinds = ASSET_ORDER.filter((kind) => (data.proArt[kind] ?? 0) > 0);
  return (
    <SectionCard icon={Images} title="DAM" subtitle={`${formatCount(data.gesamt)} Dateien`}>
      {kinds.length > 0 && (
        <div className="r-chips" role="group" aria-label="Dateien nach Art">
          {kinds.map((kind) => (
            <span key={kind} className="r-chip">
              {ASSET_LABELS[kind]} {formatCount(data.proArt[kind])}
            </span>
          ))}
        </div>
      )}
      <div className="r-stats">
        <Stat
          label="Vorschauen"
          value={formatCount(data.vorschauen.erstellt)}
          detail={`${formatCount(data.vorschauen.ausstehend)} ausstehend · ${formatCount(data.vorschauen.fehlgeschlagen)} fehlgeschlagen`}
        />
        <Stat label="Offene Aufbereitungen" value={formatCount(data.offeneAufbereitungen)} />
      </div>
      <CountProgress label="KI-Verschlagwortung (Bilder)" done={data.ki.verschlagwortet} total={data.ki.bilder} />
      {data.nas.length > 0 && (
        <div className="rg-subsection">
          <h3 className="rg-subtitle">Quellen</h3>
          <ul className="rg-rows">
            {data.nas.map((source) => {
              const index = source.index;
              const indexText = index?.laeuft
                ? `Einlesen läuft (${index.phase === 'vorschauen' ? 'Vorschauen' : 'Dateien'}): ${formatCount(index.dateienGesehen)} Dateien, ${formatCount(index.vorschauenFertig)} Vorschauen`
                : null;
              const last = agoText(source.letzteAufnahme, now);
              return (
                <li key={source.name} className="rg-row">
                  <StatusDot tone={index?.fehler ? 'warn' : index?.laeuft ? 'info' : 'ok'} pulse={index?.laeuft === true} />
                  <span className="rg-row-main">
                    <span className="rg-row-title">{source.name}</span>
                    <span className="rg-row-meta">
                      {[
                        plural(source.freigaben, 'Freigabe', 'Freigaben'),
                        last ? `zuletzt Neues ${last}` : 'noch nichts aufgenommen',
                        indexText,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <LastRun label="Letzter voller Lauf" run={data.letzterVollerLauf} now={now} />
    </SectionCard>
  );
}

// ── archiv ───────────────────────────────────────────────────────────────────

export function ArchivCard({ data, now }: { data: LagraArchiv; now: number }) {
  if (!data.eingerichtet) {
    return (
      <SectionCard icon={Archive} title="Archiv" status={<Pill tone="idle">Nicht eingerichtet</Pill>}>
        <EmptyState compact title="Nicht eingerichtet" description="In lagra ist kein Archiv angebunden." />
      </SectionCard>
    );
  }
  const run = data.lauf?.laeuft ? data.lauf : null;
  return (
    <SectionCard
      icon={Archive}
      title="Archiv"
      subtitle={`${formatCount(data.dateien)} Dateien`}
      status={data.lueckenhaft ? <Pill tone="warn">Unvollständig</Pill> : <Pill tone="ok">Vollständig</Pill>}
    >
      {data.lueckenhaft && (
        <Notice tone="warning">Ein Durchlauf ist nicht fertig geworden – die Archivsuche findet nicht alles.</Notice>
      )}
      <div className="r-stats">
        <Stat label="Letzter Index" value={agoText(data.letzterIndex, now) ?? 'noch nie'} />
      </div>
      {run && (
        <p className="rg-line">
          <StatusDot tone="info" pulse />
          <span>
            <strong>Läuft ({run.phase === 'schreiben' ? 'schreiben' : 'lesen'}):</strong> {formatCount(run.gelesen)} gelesen,{' '}
            {formatCount(run.geschrieben)} geschrieben, {formatCount(run.entfernt)} entfernt
          </span>
        </p>
      )}
    </SectionCard>
  );
}

// ── feedback / potentiale / api ──────────────────────────────────────────────

export function FeedbackCard({ data }: { data: LagraFeedback }) {
  return (
    <SectionCard icon={MessagesSquare} title="Rückmeldungen (Team)" subtitle="Zahlen für das ganze Team">
      <div className="r-stats">
        <Stat label="Ungelesen" value={formatCount(data.ungelesen)} />
        <Stat label="Offen" value={formatCount(data.offen)} />
        <Stat label="Offene Punkte" value={formatCount(data.offenePunkte)} />
        <Stat label="Neu (7 Tage)" value={formatCount(data.neu7Tage)} />
      </div>
    </SectionCard>
  );
}

export function PotentialeCard({ data, now }: { data: LagraPotentiale; now: number }) {
  return (
    <SectionCard icon={Lightbulb} title="Potentiale">
      <div className="r-stats">
        <Stat label="Vorgeschlagen" value={formatCount(data.vorgeschlagen)} />
        <Stat label="Angenommen" value={formatCount(data.angenommen)} detail="noch nicht übergeben" />
        <Stat label="Übergeben" value={formatCount(data.uebergeben)} />
        <Stat label="Verworfen" value={formatCount(data.verworfen)} />
      </div>
      <LastRun label="Letzte Suche" run={data.letzterLauf} now={now} />
    </SectionCard>
  );
}

/** Name lagra shows for SlateDesk's token (CONTRACT: created as «slatedesk»). */
const OWN_TOKEN = 'slatedesk';

export function ApiCard({ data, now }: { data: LagraApi; now: number }) {
  const healthy = data.datenbank && data.ollama;
  return (
    <SectionCard
      icon={KeyRound}
      title="Schnittstellen"
      subtitle={`${formatCount(data.aufrufe24h)} Aufrufe in 24 Std.`}
      status={healthy ? <Pill tone="ok">Alles erreichbar</Pill> : <Pill tone="error">Störung</Pill>}
    >
      <div className="r-stats">
        <Stat label="Datenbank" value={data.datenbank ? 'erreichbar' : 'nicht erreichbar'} tone={data.datenbank ? undefined : 'error'} />
        <Stat label="KI (Ollama)" value={data.ollama ? 'erreichbar' : 'nicht erreichbar'} tone={data.ollama ? undefined : 'error'} />
        <Stat label="Fehler (24 Std.)" value={formatCount(data.fehler24h)} tone={data.fehler24h > 0 ? 'warn' : undefined} />
      </div>
      {data.tokens.length > 0 && (
        <div className="rg-subsection">
          <h3 className="rg-subtitle">Tokens – zuletzt verwendet</h3>
          <ul className="rg-rows">
            {data.tokens.map((token) => (
              <li key={token.name} className="rg-row">
                <StatusDot tone={token.zuletzt ? 'ok' : 'idle'} />
                <span className="rg-row-main">
                  <span className="rg-row-title">
                    {token.name}
                    {token.name.toLowerCase() === OWN_TOKEN && <span className="r-tag r-tag-accent">dieser Kiosk</span>}
                  </span>
                  <span className="rg-row-meta">{whenText(token.zuletzt, now) ?? 'noch nie verwendet'}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionCard>
  );
}

// ── nas (on demand) ──────────────────────────────────────────────────────────

export function NasDetails({ data }: { data: LagraNas[] }) {
  if (data.length === 0) return <EmptyState compact icon={HardDrive} title="Kein NAS verknüpft" description="In lagra ist kein NAS eingetragen." />;
  return (
    <div className="rg-nas-list">
      {data.map((nas) => (
        <div key={nas.name} className="rg-subsection">
          <h3 className="rg-subtitle rg-subtitle-row">
            <span>
              {nas.name}
              {nas.modell ? ` · ${nas.modell}` : ''}
            </span>
            {nas.erreichbar ? <Pill tone="ok">Erreichbar</Pill> : <Pill tone="error">Nicht erreichbar</Pill>}
          </h3>
          {nas.erreichbar && (
            <>
              <div className="r-stats">
                <Stat label="CPU" value={percentText(nas.cpuProzent)} />
                <Stat label="Arbeitsspeicher" value={percentText(nas.ramProzent)} />
                <Stat
                  label="Temperatur"
                  value={celsiusText(nas.tempC)}
                  detail={nas.diskTempMax !== null ? `Laufwerke bis ${formatNumber(nas.diskTempMax, 0)} °C` : undefined}
                  tone={nas.tempC !== null ? temperatureTone(nas.tempC) : undefined}
                />
                <Stat label="Laufzeit" value={nas.laufzeitSek !== null ? formatDuration(nas.laufzeitSek) : 'unbekannt'} />
              </div>
              <div className="r-usages">
                {nas.volumen.map((volume) => (
                  <UsageBar key={volume.name} label={volume.name} used={volume.belegt} total={volume.gesamt} />
                ))}
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
