/**
 * Pinnwand (id 'messages') – Mitteilungen aus `state.data.announcements`.
 *
 * Erfasst werden sie in der Fernsteuerung (Inhalte → Pinnwand). Sichtbar ist
 * nur, was gerade in seinem from/until-Fenster liegt; angeheftete zuerst,
 * danach die neusten. Im Bearbeiten-Modus lassen sie sich am Kiosk löschen.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, Megaphone, Pin, Trash2, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { useAppState } from '../state/appState';
import { announcementActions } from '../state/dataActions';
import type { Announcement, AnnouncementLevel } from '../state/types';
import { useLayoutStore } from '../store/layoutStore';
import type { WidgetProps } from '../types/widget';
import {
  MESSAGES_MAX_ITEMS_LIMIT,
  MESSAGES_ROTATE_MAX_SECONDS,
  MESSAGES_ROTATE_MIN_SECONDS,
  messagesDefaultSettings,
  type MessagesSettings,
} from './manifests/messages';
import './styles/messages.css';

/** from/until are re-checked this often (and whenever the announcements change). */
const NOW_TICK_MS = 30_000;
const DELETE_CONFIRM_MS = 5_000;
/** More announcements than this in rotation → "3 / 12" instead of dots. */
const MAX_PAGER_DOTS = 10;
/** Text lengths from which a rotation card uses a smaller type scale. */
const LONG_TEXT = 140;
const VERY_LONG_TEXT = 320;

const LEVELS: Record<AnnouncementLevel, { label: string; Icon: LucideIcon }> = {
  info: { label: 'Info', Icon: Info },
  wichtig: { label: 'Wichtig', Icon: TriangleAlert },
  erfolg: { label: 'Erfolg', Icon: CheckCircle2 },
};

const DAY_FORMAT = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'short' });
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'short', year: 'numeric' });
const TIME_FORMAT = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });

// ── Helpers ──────────────────────────────────────────────────────────────────

const intInRange = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Stored settings are not trusted (old versions, hand-edited state). */
function sanitizeSettings(settings: MessagesSettings): MessagesSettings {
  const defaults = messagesDefaultSettings;
  return {
    title: typeof settings.title === 'string' ? settings.title.trim() : '',
    mode: settings.mode === 'rotation' ? 'rotation' : 'liste',
    rotateSeconds: intInRange(
      settings.rotateSeconds,
      MESSAGES_ROTATE_MIN_SECONDS,
      MESSAGES_ROTATE_MAX_SECONDS,
      defaults.rotateSeconds,
    ),
    maxItems: intInRange(settings.maxItems, 1, MESSAGES_MAX_ITEMS_LIMIT, defaults.maxItems),
    levelFilter: settings.levelFilter === 'wichtig' ? 'wichtig' : 'alle',
    showAuthor: typeof settings.showAuthor === 'boolean' ? settings.showAuthor : defaults.showAuthor,
    showDate: typeof settings.showDate === 'boolean' ? settings.showDate : defaults.showDate,
  };
}

const isActive = (item: Announcement, now: number): boolean =>
  (item.from === undefined || item.from <= now) && (item.until === undefined || now < item.until);

/** A scheduled announcement counts as new from the moment it appears. */
const publishedAt = (item: Announcement): number => item.from ?? item.createdAt;

function visibleAnnouncements(
  all: Record<string, Announcement>,
  now: number,
  levelFilter: MessagesSettings['levelFilter'],
): Announcement[] {
  return Object.values(all)
    .filter((item) => isActive(item, now) && (levelFilter === 'alle' || item.level === 'wichtig'))
    .sort(
      (a, b) =>
        Number(b.pinned === true) - Number(a.pinned === true) ||
        publishedAt(b) - publishedAt(a) ||
        b.createdAt - a.createdAt ||
        a.id.localeCompare(b.id),
    );
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 'heute' / 'gestern' / 'morgen' / '13. Okt.' (with year if not the current one). */
function dayLabel(ms: number, now: number): string {
  const diff = Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
  if (diff === 0) return 'heute';
  if (diff === -1) return 'gestern';
  if (diff === 1) return 'morgen';
  return new Date(ms).getFullYear() === new Date(now).getFullYear()
    ? DAY_FORMAT.format(ms)
    : DAY_YEAR_FORMAT.format(ms);
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** `until` is exclusive: an end at midnight means "through the previous day". */
function untilLabel(until: number, now: number): string {
  const atMidnight = startOfDay(until) === until;
  return atMidnight ? `bis ${dayLabel(until - 1, now)}` : `bis ${dayLabel(until, now)} ${TIME_FORMAT.format(until)}`;
}

function metaParts(item: Announcement, settings: MessagesSettings, now: number): string[] {
  const parts: string[] = [];
  if (settings.showAuthor && item.author) parts.push(item.author);
  if (settings.showDate) {
    const published = publishedAt(item);
    // createdAt 0 = imported without timestamp – no date is better than 1970.
    if (published > 0) parts.push(capitalize(dayLabel(published, now)));
    if (item.until !== undefined) parts.push(untilLabel(item.until, now));
  }
  return parts;
}

/**
 * Current time for the from/until checks: refreshed every 30 s and right
 * when the announcements change, so a new one shows up at once.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    const unsubscribe = useAppState.subscribe((next, prev) => {
      if (next.state.data.announcements !== prev.state.data.announcements) setNow(Date.now());
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  }, []);
  return now;
}

// ── Card ─────────────────────────────────────────────────────────────────────

interface CardProps {
  item: Announcement;
  settings: MessagesSettings;
  now: number;
  editMode: boolean;
  confirming: boolean;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (id: string) => void;
}

function AnnouncementCard({ item, settings, now, editMode, confirming, onAskDelete, onCancelDelete, onDelete }: CardProps) {
  const level = LEVELS[item.level];
  const meta = metaParts(item, settings, now);

  return (
    <article className={`pinnwand-card pinnwand-card--${item.level}${item.pinned ? ' pinnwand-card--pinned' : ''}`}>
      <span className="pinnwand-card-icon" role="img" aria-label={level.label} title={level.label}>
        <level.Icon aria-hidden="true" />
      </span>
      <div className="pinnwand-card-body">
        <h3 className="pinnwand-card-title">
          {item.title}
          {item.pinned && <Pin className="pinnwand-pin" aria-label="Angeheftet" />}
        </h3>
        {item.text && <p className="pinnwand-card-text">{item.text}</p>}
        {meta.length > 0 && (
          <div className="pinnwand-card-meta">
            {meta.map((part, index) => (
              <span key={index}>{part}</span>
            ))}
          </div>
        )}
      </div>
      {editMode && !confirming && (
        <button
          type="button"
          className="pinnwand-delete no-drag"
          onClick={(event) => {
            event.stopPropagation();
            onAskDelete(item.id);
          }}
          title="Mitteilung löschen"
          aria-label={`Mitteilung löschen: ${item.title}`}
        >
          <Trash2 aria-hidden="true" />
        </button>
      )}
      {editMode && confirming && (
        <div className="pinnwand-confirm no-drag" role="group" aria-label="Mitteilung löschen?" onClick={(e) => e.stopPropagation()}>
          <span className="pinnwand-confirm-text">Mitteilung löschen?</span>
          <div className="pinnwand-confirm-actions">
            <button type="button" className="pinnwand-confirm-button danger" onClick={() => onDelete(item.id)}>
              <Trash2 aria-hidden="true" />
              Löschen
            </button>
            <button type="button" className="pinnwand-confirm-button" onClick={onCancelDelete}>
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

/** One announcement at a time; a tap shows the next one (auto-advance pauses in edit mode). */
function RotationView({
  items,
  rotateSeconds,
  paused,
  renderCard,
}: {
  items: Announcement[];
  rotateSeconds: number;
  paused: boolean;
  renderCard: (item: Announcement) => ReactNode;
}) {
  const [index, setIndex] = useState(0);
  const count = items.length;
  const position = index % count;
  const item = items[position];

  useEffect(() => {
    if (paused || count < 2) return;
    const timer = setTimeout(() => setIndex((i) => ((i % count) + 1) % count), rotateSeconds * 1000);
    return () => clearTimeout(timer);
  }, [paused, count, rotateSeconds, index]);

  const next = () => {
    if (count > 1) setIndex((i) => ((i % count) + 1) % count);
  };

  const textLength = item.text?.length ?? 0;
  const sizeClass =
    textLength > VERY_LONG_TEXT ? ' pinnwand-stage--xlong' : textLength > LONG_TEXT ? ' pinnwand-stage--long' : '';

  return (
    <>
      <div className={`pinnwand-stage${sizeClass}${count > 1 ? ' pinnwand-stage--browsable' : ''}`} onClick={next}>
        <div key={item.id} className="pinnwand-stage-item">
          {renderCard(item)}
        </div>
      </div>
      {count > 1 && (
        <div className="pinnwand-pager" aria-label={`Mitteilung ${position + 1} von ${count}`}>
          {count > MAX_PAGER_DOTS ? (
            <span className="pinnwand-pager-count">
              {position + 1} / {count}
            </span>
          ) : (
            items.map((entry, i) => (
              <span key={entry.id} className={`pinnwand-pager-dot${i === position ? ' active' : ''}`} />
            ))
          )}
        </div>
      )}
    </>
  );
}

export function MessagesWidget({ instanceId }: WidgetProps) {
  const [storedSettings] = useWidgetSettings(instanceId, messagesDefaultSettings);
  const settings = useMemo(() => sanitizeSettings(storedSettings), [storedSettings]);
  const announcements = useAppState((s) => s.state.data.announcements);
  const editMode = useLayoutStore((s) => s.editMode);
  const now = useNow();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const visible = useMemo(
    () => visibleAnnouncements(announcements, now, settings.levelFilter),
    [announcements, now, settings.levelFilter],
  );
  const shown = visible.slice(0, settings.maxItems);
  const hiddenCount = visible.length - shown.length;

  useEffect(() => {
    if (confirmId === null) return;
    const timer = setTimeout(() => setConfirmId(null), DELETE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirmId]);

  const renderCard = (item: Announcement) => (
    <AnnouncementCard
      item={item}
      settings={settings}
      now={now}
      editMode={editMode}
      confirming={editMode && confirmId === item.id}
      onAskDelete={setConfirmId}
      onCancelDelete={() => setConfirmId(null)}
      onDelete={(id) => {
        setConfirmId(null);
        void announcementActions.remove(id);
      }}
    />
  );

  const header = settings.title ? (
    <div className="pinnwand-header">
      <Megaphone aria-hidden="true" />
      <span>{settings.title}</span>
    </div>
  ) : null;

  if (shown.length === 0) {
    const filteredOut = settings.levelFilter === 'wichtig' && Object.values(announcements).some((a) => isActive(a, now));
    return (
      <div className="pinnwand">
        {header}
        <div className="pinnwand-empty">
          <Megaphone className="pinnwand-empty-icon" aria-hidden="true" />
          <div className="pinnwand-empty-title">{filteredOut ? 'Keine wichtigen Mitteilungen' : 'Keine Mitteilungen'}</div>
          <div className="pinnwand-empty-hint">
            {filteredOut
              ? 'Weitere Mitteilungen sind ausgeblendet (Einstellung «Nur wichtige»).'
              : 'Mitteilungen erfassen Sie in der Fernsteuerung (Inhalte → Pinnwand).'}
          </div>
        </div>
      </div>
    );
  }

  if (settings.mode === 'rotation') {
    return (
      <div className="pinnwand pinnwand--rotation">
        {header}
        <RotationView items={shown} rotateSeconds={settings.rotateSeconds} paused={editMode} renderCard={renderCard} />
      </div>
    );
  }

  return (
    <div className="pinnwand">
      {header}
      <ul className="pinnwand-list">
        {shown.map((item) => (
          <li key={item.id}>{renderCard(item)}</li>
        ))}
      </ul>
      {hiddenCount > 0 && (
        <div className="pinnwand-more">
          +{hiddenCount} {hiddenCount === 1 ? 'weitere Mitteilung' : 'weitere Mitteilungen'}
        </div>
      )}
    </div>
  );
}
