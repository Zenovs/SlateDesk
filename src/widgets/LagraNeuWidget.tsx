/**
 * lagra: Neu im DAM – die zuletzt aufgenommenen Dateien als Diashow oder Raster.
 *
 * Zeigt Kundenarbeit, auch Besuchern: ohne Dateinamen, solange sie nicht
 * ausdrücklich eingeschaltet sind, und am besten aus einem kuratierten Ordner.
 * Die Vorschauen verlangen das Token – der Kiosk holt sie über Rust
 * (lagraImageUrl, data:-URL mit Zwischenspeicher).
 */
import { useEffect, useEffectEvent, useReducer, useRef, useState } from 'react';
import { FolderLock, ImageOff, Images } from 'lucide-react';
import { useElementSize } from '../hooks/useElementSize';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import { fetchUebersicht, lagraImageUrl, readSection } from '../lagra/client';
import type { LagraNeuesAsset } from '../lagra/types';
import type { WidgetProps } from '../types/widget';
import {
  LAGRA_NEU_ARTEN,
  LAGRA_NEU_DEFAULTS,
  LAGRA_NEU_MODES,
  type LagraNeuSettings,
} from './manifests/lagra-neu';
import { formatAgo, parseTime } from './shared/format';
import { useLagraPolling, useNow } from './shared/hooks';
import { LagraErrorMessage, LagraSetupMessage, LagraStaleBanner } from './shared/LagraParts';
import { WidgetMessage } from './shared/WidgetParts';
import { readBoolean, readChoice, readNumber, readString } from './shared/values';
import './styles/lagra-neu.css';

const NO_IDS: ReadonlySet<string> = new Set();

/** Loads one preview; `onFailed` runs once when it cannot be loaded. */
function usePreview(path: string, onFailed?: () => void): { src: string | null; failed: boolean } {
  const [result, setResult] = useState<{ path: string; src: string | null } | null>(null);
  const reportFailure = useEffectEvent(() => onFailed?.());

  useEffect(() => {
    let active = true;
    lagraImageUrl(path).then(
      (src) => {
        if (active) setResult({ path, src });
      },
      () => {
        if (!active) return;
        setResult({ path, src: null });
        reportFailure();
      },
    );
    return () => {
      active = false;
    };
  }, [path]);

  const current = result?.path === path ? result : null;
  return { src: current?.src ?? null, failed: current !== null && current.src === null };
}

function Caption({ asset, showName, now }: { asset: LagraNeuesAsset; showName: boolean; now: number }) {
  const added = parseTime(asset.hinzugefuegt);
  const name = showName ? asset.name : null;
  if (!name && added === null) return null;
  return (
    <figcaption className="ln-caption">
      {name && <span className="ln-name">{name}</span>}
      {added !== null && <span className="ln-added">hinzugefügt {formatAgo(added, now)}</span>}
    </figcaption>
  );
}

// ── Slideshow ────────────────────────────────────────────────────────────────

type SlideRole = 'current' | 'previous' | 'next';

interface SlideProps {
  asset: LagraNeuesAsset;
  role: SlideRole;
  showName: boolean;
  now: number;
  onReady: (id: string) => void;
  onGone: (id: string) => void;
  onFailed: (id: string) => void;
}

function Slide({ asset, role, showName, now, onReady, onGone, onFailed }: SlideProps) {
  const { src } = usePreview(asset.vorschauPfad, () => onFailed(asset.id));
  const [loaded, setLoaded] = useState(false);
  const gone = useEffectEvent(() => onGone(asset.id));

  useEffect(() => () => gone(), []);

  return (
    <figure className={`ln-slide ln-slide-${role}${loaded ? ' ln-slide-loaded' : ''}`} aria-hidden={role !== 'current'}>
      {src && (
        <>
          <img className="ln-backdrop" src={src} alt="" aria-hidden="true" />
          <img
            className="ln-image"
            src={src}
            alt={showName && asset.name ? asset.name : 'Neue Datei aus lagra'}
            onLoad={() => {
              setLoaded(true);
              onReady(asset.id);
            }}
            onError={() => onFailed(asset.id)}
          />
        </>
      )}
      {loaded && <Caption asset={asset} showName={showName} now={now} />}
    </figure>
  );
}

interface ShowState {
  current: string | null;
  previous: string | null;
}

/** Next slide – only once its image is decoded, so the crossfade never shows a gap. */
function advance(state: ShowState, action: { order: readonly string[]; ready: ReadonlySet<string> }): ShowState {
  const { order, ready } = action;
  if (order.length < 2) return state;
  const index = Math.max(0, order.indexOf(state.current ?? ''));
  const next = order[(index + 1) % order.length];
  return ready.has(next) ? { current: next, previous: order[index] } : state;
}

interface ShowProps {
  assets: LagraNeuesAsset[];
  intervalMs: number;
  showNames: boolean;
  now: number;
}

function Slideshow({ assets, intervalMs, showNames, now }: ShowProps) {
  const [show, dispatch] = useReducer(advance, { current: null, previous: null });
  const listKey = assets.map((asset) => asset.id).join(',');
  const [failed, setFailed] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: '', ids: NO_IDS });
  // A new list retries images that failed before.
  const failedIds = failed.key === listKey ? failed.ids : NO_IDS;
  const visible = assets.filter((asset) => !failedIds.has(asset.id));
  const order = visible.map((asset) => asset.id);

  // Read by the interval callback – the timer must not restart on every image.
  const orderRef = useRef<readonly string[]>(order);
  const readyRef = useRef(new Set<string>());
  useEffect(() => {
    orderRef.current = order;
  });

  const cycling = order.length > 1;
  useEffect(() => {
    if (!cycling) return;
    const timer = setInterval(() => dispatch({ order: orderRef.current, ready: new Set(readyRef.current) }), intervalMs);
    return () => clearInterval(timer);
  }, [cycling, intervalMs]);

  const markFailed = (id: string) => {
    readyRef.current.delete(id);
    setFailed((prev) => {
      const ids = prev.key === listKey ? prev.ids : NO_IDS;
      return ids.has(id) ? prev : { key: listKey, ids: new Set([...ids, id]) };
    });
  };
  const markReady = (id: string) => readyRef.current.add(id);
  const markGone = (id: string) => readyRef.current.delete(id);

  if (visible.length === 0) {
    return <WidgetMessage icon={ImageOff} tone="warn" title="Vorschauen nicht ladbar" detail="Neuer Versuch bei der nächsten Aktualisierung." />;
  }

  const currentIndex = Math.max(0, order.indexOf(show.current ?? ''));
  const currentId = order[currentIndex];
  const nextId = cycling ? order[(currentIndex + 1) % order.length] : null;
  const previousId = show.previous !== currentId && show.previous !== null && order.includes(show.previous) ? show.previous : null;
  const roleOf = (id: string): SlideRole | null =>
    id === currentId ? 'current' : id === previousId ? 'previous' : id === nextId ? 'next' : null;

  return (
    <div className="ln-show">
      {visible.map((asset) => {
        const role = roleOf(asset.id);
        return (
          role && (
            <Slide
              key={asset.id}
              asset={asset}
              role={role}
              showName={showNames}
              now={now}
              onReady={markReady}
              onGone={markGone}
              onFailed={markFailed}
            />
          )
        );
      })}
    </div>
  );
}

// ── Raster ───────────────────────────────────────────────────────────────────

/** Columns × rows that give the largest cells for `count` items in w × h. */
function bestGrid(count: number, width: number, height: number): { cols: number; rows: number } {
  if (count <= 0) return { cols: 1, rows: 1 };
  if (width <= 0 || height <= 0) {
    const cols = Math.ceil(Math.sqrt(count));
    return { cols, rows: Math.ceil(count / cols) };
  }
  let best = { cols: 1, rows: count, size: 0 };
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const size = Math.min(width / cols, height / rows);
    if (size > best.size) best = { cols, rows, size };
  }
  return { cols: best.cols, rows: best.rows };
}

function RasterCell({ asset, showName, now }: { asset: LagraNeuesAsset; showName: boolean; now: number }) {
  const { src, failed } = usePreview(asset.vorschauPfad);
  return (
    <figure className="ln-cell">
      {src ? (
        <img className="ln-cell-image" src={src} alt={showName && asset.name ? asset.name : 'Neue Datei aus lagra'} />
      ) : (
        failed && <ImageOff className="ln-cell-missing" aria-label="Vorschau nicht ladbar" />
      )}
      {src && <Caption asset={asset} showName={showName} now={now} />}
    </figure>
  );
}

function Raster({ assets, showNames, now }: { assets: LagraNeuesAsset[]; showNames: boolean; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(ref);
  const { cols, rows } = bestGrid(assets.length, width, height);
  return (
    <div
      ref={ref}
      className={`ln-raster${cols >= 4 ? ' ln-raster-dense' : ''}`}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
    >
      {assets.map((asset) => (
        <RasterCell key={asset.id} asset={asset} showName={showNames} now={now} />
      ))}
    </div>
  );
}

// ── Widget ───────────────────────────────────────────────────────────────────

export function LagraNeuWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings<LagraNeuSettings>(instanceId, LAGRA_NEU_DEFAULTS);
  const anzahl = readNumber(raw.anzahl, LAGRA_NEU_DEFAULTS.anzahl, 1, 30);
  const ordner = readString(raw.ordner, '').trim();
  const art = readChoice(raw.art, LAGRA_NEU_ARTEN, LAGRA_NEU_DEFAULTS.art);
  const showNames = readBoolean(raw.showNames, LAGRA_NEU_DEFAULTS.showNames);
  const mode = readChoice(raw.mode, LAGRA_NEU_MODES, LAGRA_NEU_DEFAULTS.mode);
  const intervalMs = readNumber(raw.intervalSeconds, LAGRA_NEU_DEFAULTS.intervalSeconds, 3, 300) * 1000;
  const refreshMs = readNumber(raw.refreshMinutes, LAGRA_NEU_DEFAULTS.refreshMinutes, 1, 60) * 60_000;
  const now = useNow(60_000);

  const poll = useLagraPolling(
    async (signal) => {
      const result = await fetchUebersicht(
        { teile: ['neu'], neuAnzahl: anzahl, neuArt: art, ordner: ordner || undefined, namen: showNames },
        { signal },
      );
      return result.neu ?? [];
    },
    refreshMs,
    [anzahl, art, ordner, showNames],
  );

  if (poll.setup !== 'ready') return <LagraSetupMessage setup={poll.setup} />;
  if (poll.data === null) {
    if (poll.error === null) return <WidgetMessage busy title="Neue Dateien werden geladen …" />;
    // lagra answers 400 for a folder outside its API roots – its text names folders, so it stays off the wall.
    if (poll.errorStatus === 400) {
      return (
        <WidgetMessage
          icon={FolderLock}
          tone="warn"
          title="Ordner nicht freigegeben"
          detail="lagra gibt diesen Ordner nicht für die Schnittstelle frei – in den Einstellungen prüfen."
        />
      );
    }
    return <LagraErrorMessage kind={poll.errorKind} status={poll.errorStatus} />;
  }

  const section = readSection(poll.data);
  if (section.error !== null) {
    return (
      <WidgetMessage
        icon={ImageOff}
        tone="warn"
        title="Neue Dateien nicht verfügbar"
        detail="lagra konnte die Liste nicht lesen – z. B. weil kein NAS verknüpft ist."
      />
    );
  }
  const assets = section.data ?? [];
  if (assets.length === 0) {
    return (
      <WidgetMessage
        icon={Images}
        title="Noch nichts Neues"
        detail={ordner ? 'Im gewählten Ordner gibt es noch keine Dateien mit Vorschau.' : 'lagra hat noch keine Dateien mit Vorschau aufgenommen.'}
      />
    );
  }

  return (
    <div className="ln">
      {mode === 'raster' ? (
        <Raster assets={assets} showNames={showNames} now={now} />
      ) : (
        <Slideshow assets={assets} intervalMs={intervalMs} showNames={showNames} now={now} />
      )}
      {poll.error !== null && (
        <div className="ln-stale">
          <LagraStaleBanner
            kind={poll.errorKind}
            status={poll.errorStatus}
            failingSince={poll.failingSince}
            lastUpdated={poll.lastUpdated}
          />
        </div>
      )}
    </div>
  );
}
