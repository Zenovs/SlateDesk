/**
 * lagra Übersicht via the kiosk's proxy: the default sections every 30 s
 * while the page is visible, the (slow) NAS status only on request. Without
 * /api/v1/uebersicht (older lagra) it falls back to the virus scanner.
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
  RefreshCw,
  Server,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { fetchPruefenFallback, fetchUebersicht, isLagraEndpointMissing, readSection } from '../../../lagra/client';
import type { LagraNas, LagraPruefen, LagraSection, LagraUebersicht } from '../../../lagra/types';
import { formatDayTime, formatTime, parseIso } from '../../format';
import { useNow } from '../../hooks/useNow';
import { useOnDemand } from '../../hooks/useOnDemand';
import { usePoll } from '../../hooks/usePoll';
import { Button, Card, LoadingRow, Notice, Section, Spinner } from '../../ui';
import {
  ApiCard,
  ArchivCard,
  DamCard,
  FeedbackCard,
  JobsSummaryCard,
  NasDetails,
  PotentialeCard,
  PruefenCard,
  SectionErrorCard,
  ServerCard,
  VirenCard,
} from './OverviewCards';
import { loadLagra } from './lagraLoad';

const OVERVIEW_POLL_MS = 30_000;

type OverviewData = { kind: 'uebersicht'; data: LagraUebersicht } | { kind: 'pruefen'; data: LagraPruefen };

const loadOverview = (signal: AbortSignal): Promise<OverviewData> =>
  loadLagra(async () => {
    try {
      return { kind: 'uebersicht', data: await fetchUebersicht({}, { signal }) };
    } catch (err) {
      if (!isLagraEndpointMissing(err)) throw err;
      // Older lagra without /uebersicht: /pruefen, asked at most every 10 minutes (shared cache).
      const pruefen = await fetchPruefenFallback({ signal });
      if (pruefen === null) throw err;
      return { kind: 'pruefen', data: pruefen };
    }
  }, signal);

const loadNas = (signal: AbortSignal): Promise<LagraNas[]> =>
  loadLagra(async () => {
    const section = readSection((await fetchUebersicht({ teile: ['nas'] }, { signal })).nas);
    if (section.error !== null) throw new Error(section.error);
    return section.data ?? [];
  }, signal);

/** Renders one section: its card, its own error, or nothing when lagra did not send it. */
function sectionCard<T>(
  section: LagraSection<T> | undefined,
  icon: LucideIcon,
  title: string,
  render: (data: T) => ReactNode,
): ReactNode {
  const { data, error } = readSection(section);
  if (error !== null) return <SectionErrorCard icon={icon} title={title} message={error} />;
  return data === null ? null : render(data);
}

function NasCard({ now }: { now: number }) {
  const nas = useOnDemand(loadNas);
  return (
    <Card
      className="rg-card"
      icon={HardDrive}
      title="NAS"
      subtitle={
        nas.lastUpdated !== null
          ? `Abgefragt ${formatDayTime(nas.lastUpdated, now)}`
          : 'Wird nur auf Anfrage abgefragt – das kann bis zu 15 Sekunden dauern.'
      }
      actions={
        <Button size="sm" icon={RefreshCw} busy={nas.loading} onClick={nas.run}>
          {nas.data ? 'Aktualisieren' : 'Abfragen'}
        </Button>
      }
    >
      {nas.error && <Notice tone="error">{nas.error}</Notice>}
      {nas.loading && nas.data === null && <Spinner label="NAS wird abgefragt…" />}
      {nas.data && <NasDetails data={nas.data} />}
    </Card>
  );
}

export function LagraOverview() {
  const poll = usePoll(loadOverview, OVERVIEW_POLL_MS);
  const now = useNow(OVERVIEW_POLL_MS);
  const { data, error, loading, lastUpdated, refresh } = poll;

  const stand = data?.kind === 'uebersicht' ? parseIso(data.data.stand) : null;
  const description =
    stand !== null
      ? `Stand ${formatDayTime(stand, now)} · wird alle 30 Sekunden aktualisiert`
      : 'Zustand von lagra – wird alle 30 Sekunden aktualisiert';

  let content: ReactNode = null;
  if (data?.kind === 'uebersicht') {
    const ue = data.data;
    content = (
      <div className="rg-grid">
        {sectionCard(ue.server, Server, 'Server', (d) => <ServerCard data={d} />)}
        {sectionCard(ue.jobs, ListChecks, 'Aufgaben', (d) => <JobsSummaryCard data={d} now={now} />)}
        {sectionCard(ue.viren, ShieldCheck, 'Virenscanner', (d) => <VirenCard data={d} now={now} />)}
        {sectionCard(ue.dam, Images, 'DAM', (d) => <DamCard data={d} now={now} />)}
        {sectionCard(ue.archiv, Archive, 'Archiv', (d) => <ArchivCard data={d} now={now} />)}
        {sectionCard(ue.feedback, MessagesSquare, 'Rückmeldungen (Team)', (d) => <FeedbackCard data={d} />)}
        {sectionCard(ue.potentiale, Lightbulb, 'Potentiale', (d) => <PotentialeCard data={d} now={now} />)}
        {sectionCard(ue.api, KeyRound, 'Schnittstellen', (d) => <ApiCard data={d} now={now} />)}
        <NasCard now={now} />
      </div>
    );
  } else if (data?.kind === 'pruefen') {
    content = (
      <>
        <Notice tone="warning" title="lagra-Update nötig: Endpunkt /api/v1/uebersicht fehlt">
          Diese lagra-Version kennt die Übersicht für SlateDesk noch nicht – angezeigt wird nur der Virenscanner.
        </Notice>
        <div className="rg-grid">
          <PruefenCard data={data.data} />
        </div>
      </>
    );
  }

  return (
    <Section
      title="Übersicht"
      description={description}
      actions={
        <Button size="sm" variant="ghost" icon={RefreshCw} busy={loading && data !== null} onClick={refresh}>
          Aktualisieren
        </Button>
      }
    >
      {error && (
        <Notice tone={data ? 'warning' : 'error'} title={data ? 'Keine aktuelle Antwort von lagra' : 'Übersicht nicht verfügbar'}>
          {data && lastUpdated !== null ? `Angezeigt wird der Stand von ${formatTime(lastUpdated)}. ` : ''}
          {error}
        </Notice>
      )}
      {data === null && !error && (
        <Card className="rg-card">
          <LoadingRow label="Übersicht wird geladen…" />
        </Card>
      )}
      {content}
    </Section>
  );
}
