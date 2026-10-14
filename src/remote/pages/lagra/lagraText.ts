/** Labels, tones and time texts for lagra data in the web UI. */
import type { LagraAssetArt, LagraJob, LagraJobStatus, LagraZeitplan } from '../../../lagra/types';
import { formatDayTime, formatRelative, parseIso, plural } from '../../format';
import type { NoticeTone, StatusTone } from '../../ui';

export const ASSET_LABELS: Record<LagraAssetArt, string> = {
  BILD: 'Bilder',
  GRAFIK: 'Grafiken',
  VIDEO: 'Videos',
  AUDIO: 'Audio',
  DOKUMENT: 'Dokumente',
  ANDERE: 'Andere',
};

export const ASSET_ORDER: readonly LagraAssetArt[] = ['BILD', 'GRAFIK', 'VIDEO', 'AUDIO', 'DOKUMENT', 'ANDERE'];

interface RunLike {
  status: LagraJobStatus;
  /** «fertig» with an error text (e.g. skipped folders). */
  fehler?: boolean;
}

export function runTone(run: RunLike | null): StatusTone {
  if (!run) return 'idle';
  if (run.status === 'laeuft') return 'info';
  if (run.status === 'fehler') return 'error';
  if (run.status === 'abgebrochen' || run.fehler) return 'warn';
  return 'ok';
}

export function runLabel(run: RunLike | null): string {
  if (!run) return 'noch nie gelaufen';
  if (run.status === 'laeuft') return 'läuft';
  if (run.status === 'fehler') return 'fehlgeschlagen';
  if (run.status === 'abgebrochen') return 'abgebrochen';
  return run.fehler ? 'fertig mit Warnungen' : 'erfolgreich';
}

/** «alle 15 Min.», «stündlich», «täglich um 3 Uhr», «nur von Hand» – «(pausiert)» when switched off. */
export function planText(job: Pick<LagraJob, 'planArt' | 'intervallMinuten' | 'stunde' | 'aktiv'>): string {
  if (job.planArt === 'manuell') return 'nur von Hand';
  let text: string;
  if (job.planArt === 'taeglich') {
    text = job.stunde !== null ? `täglich um ${job.stunde} Uhr` : 'täglich';
  } else {
    const minutes = job.intervallMinuten;
    text =
      minutes === null
        ? 'regelmässig'
        : minutes === 60
          ? 'stündlich'
          : minutes % 60 === 0
            ? `alle ${minutes / 60} Std.`
            : `alle ${minutes} Min.`;
  }
  return job.aktiv ? text : `${text} (pausiert)`;
}

/** «heute 03:12 (vor 5 Std.)»; null for a missing timestamp. */
export function whenText(iso: string | null | undefined, now: number): string | null {
  const ms = parseIso(iso);
  return ms === null ? null : `${formatDayTime(ms, now)} (${formatRelative(ms, now)})`;
}

/** «vor 5 Std.»; null for a missing timestamp. */
export function agoText(iso: string | null | undefined, now: number): string | null {
  const ms = parseIso(iso);
  return ms === null ? null : formatRelative(ms, now);
}

/** «seit heute 08:00»; null for a missing timestamp. */
export function sinceText(iso: string | null | undefined, now: number): string | null {
  const ms = parseIso(iso);
  return ms === null ? null : `seit ${formatDayTime(ms, now)}`;
}

/** Warning when lagra's scheduler does not run, otherwise null. */
export function schedulerProblem(zeitplan: LagraZeitplan, now: number): { tone: NoticeTone; text: string } | null {
  if (!zeitplan.aktiv) {
    return { tone: 'warning', text: 'Der Zeitplan von lagra ist ausgeschaltet – geplante Aufgaben laufen nicht.' };
  }
  if (zeitplan.steht === true) {
    const last = whenText(zeitplan.letzterTakt, now);
    return {
      tone: 'error',
      text: `Der Zeitplan von lagra steht${last ? ` (letzter Takt ${last})` : ''} – geplante Aufgaben laufen nicht.`,
    };
  }
  return null;
}

/** Age of the virus signatures: «von heute», «2 Tage alt». */
export function signatureAge(days: number | null): string {
  if (days === null) return 'unbekannt';
  return days <= 0 ? 'von heute' : plural(days, 'Tag alt', 'Tage alt');
}
