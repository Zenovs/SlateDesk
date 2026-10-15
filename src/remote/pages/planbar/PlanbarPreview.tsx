/**
 * planbar preview through the kiosk's proxy: the open work of one person
 * (chosen here, remembered per browser) and the latest news of the
 * Infowand – of one Unternehmen or all of them, the same data the planbar
 * widgets show on the kiosk.
 */
import { useId, useMemo, useState } from 'react';
import { ClipboardCheck, Megaphone, RefreshCw, UsersRound } from 'lucide-react';
import { planbarErrorShort } from '../../../planbar/client';
import { memberOptions } from '../../../planbar/options';
import {
  configuredOrgs,
  fetchArbeitslisteAll,
  fetchMitgliederAll,
  fetchNewsAll,
  orgsKey,
  type PlanbarOrgFailure,
} from '../../../planbar/orgs';
import type { PlanbarNewsPost, PlanbarOrgRef, PlanbarWorkItem, WithOrg } from '../../../planbar/types';
import { useAppState } from '../../../state/appState';
import { formatRelative, formatTime, parseIso, plural } from '../../format';
import { useNow } from '../../hooks/useNow';
import { usePoll } from '../../hooks/usePoll';
import { readLocal, writeLocal } from '../../storage';
import { Button, Card, EmptyState, Field, LoadingRow, Notice, Section, StatusDot } from '../../ui';
import { loadPlanbar, type PlanbarLoad } from './planbarLoad';
import { contextText, dueInfo, priorityTag, safeLink } from './planbarText';

/** Same pace as the widgets (planbar-api.md: Arbeitsliste 60 s, News 5 min). */
const WORK_POLL_MS = 60_000;
const NEWS_POLL_MS = 5 * 60_000;
const WORK_LIMIT = 8;
const NEWS_LIMIT = 5;
const PERSON_KEY = 'slatedesk-remote:planbar-person';
const ORG_KEY = 'slatedesk-remote:planbar-org';
/** Choice «Alle Unternehmen». */
const ALL_ORGS = '';

const updatedText = (lastUpdated: number | null): string | null =>
  lastUpdated === null ? null : `Aktualisiert um ${formatTime(lastUpdated, true)}`;

/** No data for a reason the user can fix: planbar too old or a right of the key missing. */
function UnavailableNotice({ load, what, right }: { load: PlanbarLoad<unknown> | null; what: string; right: string }) {
  if (load?.kind === 'missing') {
    return (
      <Notice tone="warning" title="planbar-Update nötig">
        Diese planbar-Version liefert {what} für SlateDesk noch nicht.
      </Notice>
    );
  }
  if (load?.kind === 'forbidden') {
    return (
      <Notice tone="warning" title="Recht fehlt">
        Für {what} braucht der API-Schlüssel das Recht {right}. Den Schlüssel in planbar unter Unternehmen → API-Schlüssel
        anpassen oder neu erstellen. ({load.message})
      </Notice>
    );
  }
  return null;
}

/** Unternehmen that did not answer while the others did. */
function OrgFailures({ failures }: { failures: readonly PlanbarOrgFailure[] | undefined }) {
  if (!failures || failures.length === 0) return null;
  return (
    <Notice tone="warning" title="Nicht alle Unternehmen haben geantwortet">
      {failures.map((failure) => `${failure.org.name}: ${planbarErrorShort(failure.error)}`).join(' · ')}
    </Notice>
  );
}

function WorkRow({ item, today, showOrg }: { item: WithOrg<PlanbarWorkItem>; today: string; showOrg: boolean }) {
  const due = dueInfo(item, today);
  const priority = priorityTag(item);
  const context = contextText(item);
  const link = safeLink(item.url);
  const tone = due?.tone === 'overdue' ? 'error' : due?.tone === 'today' ? 'warn' : 'idle';
  return (
    <li className="rp-item">
      <StatusDot tone={tone} />
      <div className="rp-item-main">
        <p className="rp-item-title">
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer">
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </p>
        {context && <p className="rp-item-text">{context}</p>}
        <p className="rp-item-tags">
          {showOrg && <span className="r-tag r-tag-accent">{item.org.name}</span>}
          {item.type === 'projekt' && <span className="r-tag r-tag-accent">Projekt</span>}
          {due && (
            <span className={`r-tag${due.tone === 'overdue' ? ' r-tag-error' : due.tone === 'today' ? ' r-tag-warn' : ''}`}>
              {due.text}
            </span>
          )}
          {priority && <span className="r-tag">{priority}</span>}
          {item.status !== 'open' && <span className="r-tag">{item.statusLabel}</span>}
        </p>
      </div>
    </li>
  );
}

function WorkCard({ orgs }: { orgs: readonly PlanbarOrgRef[] }) {
  const selectId = useId();
  const orgKey = orgsKey(orgs);
  const several = orgs.length > 1;
  // Once (and again when the tab comes back) – people rarely change.
  const members = usePoll(
    (signal) => loadPlanbar(() => fetchMitgliederAll(orgs, { signal }), signal),
    0,
    { resetKey: orgKey },
  );
  const options = useMemo(
    () => (members.data?.kind === 'ok' ? memberOptions(members.data.data.data, several) : []),
    [members.data, several],
  );
  const [stored, setStored] = useState(() => readLocal(PERSON_KEY));
  const person = options.find((option) => option.value === stored) ?? options[0] ?? null;
  const personId = person?.value ?? null;

  const work = usePoll(
    (signal) =>
      loadPlanbar(
        () => fetchArbeitslisteAll(orgs, { benutzer: personId ? [personId] : [], limit: WORK_LIMIT }, { signal }),
        signal,
      ),
    WORK_POLL_MS,
    { enabled: personId !== null, resetKey: `${orgKey}|${personId ?? ''}` },
  );
  const result = work.data?.kind === 'ok' ? work.data.data : null;
  const list = result?.data ?? null;

  const choose = (id: string) => {
    setStored(id);
    writeLocal(PERSON_KEY, id);
  };
  const refresh = () => {
    members.refresh();
    work.refresh();
  };

  const more = list && list.total > list.data.length ? `+${list.total - list.data.length} weitere in planbar` : null;
  const footer = [more, updatedText(work.lastUpdated)].filter(Boolean).join(' · ');

  return (
    <Card
      icon={ClipboardCheck}
      title="Arbeitsliste"
      subtitle={several ? 'Offene Aufgaben und Projekte einer Person in allen Unternehmen' : 'Offene Aufgaben und Projekte einer Person'}
      actions={
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={RefreshCw}
          busy={(members.loading && members.data !== null) || (work.loading && work.data !== null)}
          onClick={refresh}
        >
          Arbeitsliste aktualisieren
        </Button>
      }
      footer={footer || undefined}
    >
      {members.error && (
        <Notice tone={members.data ? 'warning' : 'error'} title="Personen nicht verfügbar">
          {members.error}
        </Notice>
      )}
      <UnavailableNotice load={members.data} what="die Personenliste" right="«Aufgaben & Zeiten – Lesen» oder «Projekte – Lesen»" />
      <OrgFailures failures={members.data?.kind === 'ok' ? members.data.data.failures : undefined} />
      {members.data === null && !members.error && <LoadingRow label="Personen werden geladen…" />}
      {members.data?.kind === 'ok' && options.length === 0 && (
        <EmptyState compact icon={UsersRound} title="Keine Personen" description="planbar meldet keine Personen im Unternehmen." />
      )}

      {person && (
        <>
          <div className="r-settings">
            <Field label="Person" htmlFor={selectId} hint={`${plural(options.length, 'Person', 'Personen')} in planbar`}>
              <select id={selectId} className="settings-select" value={person.value} onChange={(e) => choose(e.target.value)}>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.hint ? `${option.label} (${option.hint})` : option.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {work.error && (
            <Notice tone={list ? 'warning' : 'error'} title={list ? 'Keine aktuelle Antwort von planbar' : 'Arbeitsliste nicht verfügbar'}>
              {work.error}
            </Notice>
          )}
          <UnavailableNotice load={work.data} what="die Arbeitsliste" right="«Aufgaben & Zeiten – Lesen»" />
          <OrgFailures failures={result?.failures} />
          {work.data === null && !work.error && <LoadingRow label="Arbeitsliste wird geladen…" />}
          {list &&
            (list.data.length === 0 ? (
              <EmptyState
                compact
                icon={ClipboardCheck}
                title="Nichts offen"
                description={`${person.label} hat keine offenen Aufgaben oder Projekte.`}
              />
            ) : (
              <ul className="rp-items">
                {list.data.map((item) => (
                  <WorkRow key={`${item.org.id}:${item.type}:${item.id}`} item={item} today={list.today} showOrg={several} />
                ))}
              </ul>
            ))}
        </>
      )}
    </Card>
  );
}

function NewsRow({ post, now, showOrg }: { post: WithOrg<PlanbarNewsPost>; now: number; showOrg: boolean }) {
  const link = safeLink(post.url);
  const created = parseIso(post.createdAt);
  const meta = [
    showOrg ? post.org.name : null,
    post.author?.name,
    created !== null ? formatRelative(created, now) : null,
    post.commentCount > 0 ? plural(post.commentCount, 'Kommentar', 'Kommentare') : null,
  ].filter(Boolean);
  return (
    <li className="rp-item">
      <div className="rp-item-main">
        <p className="rp-item-title">
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer">
              {post.title}
            </a>
          ) : (
            post.title
          )}
        </p>
        {post.teaser && <p className="rp-item-text">{post.teaser}</p>}
        {meta.length > 0 && <p className="rp-item-meta">{meta.join(' · ')}</p>}
      </div>
    </li>
  );
}

function NewsCard({ orgs }: { orgs: readonly PlanbarOrgRef[] }) {
  const news = usePoll(
    (signal) => loadPlanbar(() => fetchNewsAll(orgs, { limit: NEWS_LIMIT }, { signal }), signal),
    NEWS_POLL_MS,
    { resetKey: orgsKey(orgs) },
  );
  const now = useNow(60_000);
  const result = news.data?.kind === 'ok' ? news.data.data : null;
  const posts = result?.data ?? null;
  const several = orgs.length > 1;

  return (
    <Card
      icon={Megaphone}
      title="News"
      subtitle="Neueste Beiträge der Infowand, die alle sehen"
      actions={
        <Button size="sm" variant="ghost" iconOnly icon={RefreshCw} busy={news.loading && news.data !== null} onClick={news.refresh}>
          News aktualisieren
        </Button>
      }
      footer={updatedText(news.lastUpdated) ?? undefined}
    >
      {news.error && (
        <Notice tone={posts ? 'warning' : 'error'} title={posts ? 'Keine aktuelle Antwort von planbar' : 'News nicht verfügbar'}>
          {news.error}
        </Notice>
      )}
      <UnavailableNotice load={news.data} what="die News" right="«News – Lesen»" />
      <OrgFailures failures={result?.failures} />
      {news.data === null && !news.error && <LoadingRow label="News werden geladen…" />}
      {posts &&
        (posts.data.length === 0 ? (
          <EmptyState compact icon={Megaphone} title="Keine News" description="Auf der Infowand gibt es noch keine Beiträge für alle." />
        ) : (
          <ul className="rp-items">
            {posts.data.map((post) => (
              <NewsRow key={`${post.org.id}:${post.id}`} post={post} now={now} showOrg={several} />
            ))}
          </ul>
        ))}
    </Card>
  );
}

export function PlanbarPreview() {
  const selectId = useId();
  const configuredKey = useAppState((s) => orgsKey(configuredOrgs(s.state.planbar)));
  const configured = useMemo(() => JSON.parse(configuredKey) as PlanbarOrgRef[], [configuredKey]);
  const [stored, setStored] = useState(() => readLocal(ORG_KEY) ?? ALL_ORGS);
  const choice = configured.some((org) => org.id === stored) ? stored : ALL_ORGS;
  const orgs = useMemo(
    () => (choice === ALL_ORGS ? configured : configured.filter((org) => org.id === choice)),
    [choice, configured],
  );

  const choose = (id: string) => {
    setStored(id);
    writeLocal(ORG_KEY, id === ALL_ORGS ? null : id);
  };

  return (
    <Section title="Vorschau" description="Daten aus planbar, über den Kiosk abgefragt – so sehen sie die planbar-Widgets.">
      {configured.length > 1 && (
        <div className="r-settings rp-preview-orgs">
          <Field label="Unternehmen" htmlFor={selectId} hint={plural(configured.length, 'Unternehmen', 'Unternehmen')}>
            <select id={selectId} className="settings-select" value={choice} onChange={(e) => choose(e.target.value)}>
              <option value={ALL_ORGS}>Alle Unternehmen</option>
              {configured.map((org) => (
                <option key={org.id} value={org.id}>
                  {org.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <div className="rp-grid">
        <WorkCard orgs={orgs} />
        <NewsCard orgs={orgs} />
      </div>
    </Section>
  );
}
