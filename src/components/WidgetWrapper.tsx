/**
 * WidgetWrapper – Wraps every widget with a consistent shell:
 * header bar (edit mode: drag handle, settings, remove), error boundary and
 * the settings dialog.
 *
 * Widgets with a `settingsSchema` get the generic SettingsForm (plus their
 * kiosk-only `settingsExtra`), owned here so it also opens when the widget
 * itself crashed. Heavy widgets are registered as React.lazy components
 * (src/widgets/index.ts) – the Suspense boundaries for them live here too.
 */
import React, { memo, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, GripHorizontal, Loader2, RotateCcw, Settings, Trash2, X } from 'lucide-react';
import { useLayoutStore } from '../store/layoutStore';
import { useAppState } from '../state/appState';
import { widgetSettingsActions } from '../state/dataActions';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import type { WidgetDefinition, WidgetManifest } from '../types/widget';
import { getWidget } from '../utils/widgetRegistry';
import { SettingsForm } from './settings/SettingsForm';
import { WidgetIcon } from './settings/WidgetIcon';
import { WidgetSettingsDialog } from './WidgetSettingsDialog';
import '../styles/widgets.css';

interface Props {
  instanceId: string;
  widgetId: string;
  /** Grid units. */
  w: number;
  h: number;
}

const NO_DEFAULTS: Record<string, unknown> = Object.freeze({}) as Record<string, unknown>;
const REMOVE_CONFIRM_MS = 5000;
const FIRST_RETRY_MS = 60_000;
const MAX_RETRY_MS = 30 * 60_000;
/** Running this long without a crash counts as recovered: the next crash retries after FIRST_RETRY_MS again. */
const STABLE_RESET_MS = 15 * 60_000;

// ── Error boundary ───────────────────────────────────────────────────────────

/** «Einstellungen zurücksetzen» deletes every source, URL and secret of the instance – only on a second tap. */
function ResetSettingsButton({ onReset }: { onReset: () => void }) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), REMOVE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)}>
        Einstellungen zurücksetzen
      </button>
    );
  }
  return (
    <>
      <button type="button" className="danger" onClick={onReset}>
        <Trash2 size={14} />
        Wirklich zurücksetzen?
      </button>
      <button type="button" onClick={() => setConfirming(false)}>
        Abbrechen
      </button>
    </>
  );
}

interface BoundaryProps {
  label: string;
  /** A change (e.g. new settings) clears the error. */
  resetKey: unknown;
  /** Offered in the fallback when set (edit mode, stored settings exist). */
  onResetSettings?: () => void;
  children: React.ReactNode;
}

interface BoundaryState {
  error: Error | null;
  resetKey: unknown;
  attempt: number;
}

class WidgetErrorBoundary extends React.Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, resetKey: this.props.resetKey, attempt: 0 };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return Object.is(props.resetKey, state.resetKey) ? null : { resetKey: props.resetKey, error: null, attempt: 0 };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error(`Widget «${this.props.label}» ist abgestürzt:`, error, info.componentStack);
    // 24/7 kiosk: retry on its own (transient API payloads), with backoff.
    this.clearRetry();
    this.clearStable();
    const delay = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** this.state.attempt);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
    }, delay);
  }

  componentDidUpdate(_prev: BoundaryProps, prevState: BoundaryState): void {
    if (prevState.error && !this.state.error) {
      this.clearRetry();
      // Recovered: once it has run fine for a while, the backoff starts over
      // (otherwise a few crashes over the days leave every later one at 30 min).
      this.clearStable();
      if (this.state.attempt > 0) {
        this.stableTimer = setTimeout(() => {
          this.stableTimer = null;
          this.setState({ attempt: 0 });
        }, STABLE_RESET_MS);
      }
    }
  }

  componentWillUnmount(): void {
    this.clearRetry();
    this.clearStable();
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private clearStable(): void {
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private reload = (): void => {
    this.clearRetry();
    this.setState({ error: null, attempt: 0 });
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="widget-fallback" role="alert">
        <div className="widget-fallback-title">
          <AlertTriangle size={16} />
          Widget-Fehler
        </div>
        {error.message && <div className="widget-fallback-detail">{error.message}</div>}
        <div className="widget-fallback-actions">
          <button type="button" onClick={this.reload}>
            <RotateCcw size={14} />
            Neu laden
          </button>
          {this.props.onResetSettings && <ResetSettingsButton onReset={this.props.onResetSettings} />}
        </div>
      </div>
    );
  }
}

function WidgetLoading() {
  return (
    <div className="widget-loading" role="status" aria-label="Wird geladen…">
      <Loader2 size={20} className="spin" aria-hidden="true" />
    </div>
  );
}

// ── Settings ─────────────────────────────────────────────────────────────────

interface SchemaSettingsProps {
  instanceId: string;
  manifest: WidgetManifest & { settingsSchema: NonNullable<WidgetManifest['settingsSchema']> };
  extra?: WidgetDefinition['settingsExtra'];
}

function SchemaSettings({ instanceId, manifest, extra: Extra }: SchemaSettingsProps) {
  const [values, update] = useWidgetSettings(instanceId, manifest.defaultSettings ?? NO_DEFAULTS);
  return (
    <>
      <SettingsForm schema={manifest.settingsSchema} values={values} onChange={update} context="kiosk" />
      {Extra && (
        <div className="settings-extra">
          <Suspense fallback={<WidgetLoading />}>
            <Extra instanceId={instanceId} />
          </Suspense>
        </div>
      )}
    </>
  );
}

const hasSchema = (manifest: WidgetManifest | undefined): manifest is SchemaSettingsProps['manifest'] =>
  Array.isArray(manifest?.settingsSchema) && manifest.settingsSchema.length > 0;

// ── Wrapper ──────────────────────────────────────────────────────────────────

export const WidgetWrapper = memo(function WidgetWrapper({ instanceId, widgetId, w, h }: Props) {
  const editMode = useLayoutStore((s) => s.editMode);
  const removeWidget = useLayoutStore((s) => s.removeWidget);
  const storedSettings = useAppState((s) => s.state.widgetSettings[instanceId]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Settings dialog and remove confirmation belong to an edit session: leaving
  // edit mode (button, auto-exit, web UI) ends them for good – the dialog must
  // not stay on the wall with its URLs, and a stale «Ja» must not greet the
  // next session where the gear usually is. Drafts are flushed on unmount.
  const [editSession, setEditSession] = useState(editMode);
  if (editSession !== editMode) {
    setEditSession(editMode);
    if (!editMode) {
      setSettingsOpen(false);
      setConfirmingRemove(false);
    }
  }

  const definition = getWidget(widgetId);
  const manifest = definition?.manifest;
  const title = manifest?.name ?? 'Unbekanntes Widget';
  const schemaManifest = hasSchema(manifest) ? manifest : null;
  const confirming = confirmingRemove && editMode;

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirmingRemove(false), REMOVE_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  // Just added from the picker: it may have landed below the visible area.
  useEffect(() => {
    if (useLayoutStore.getState().revealId !== instanceId) return;
    const frame = requestAnimationFrame(() => {
      useLayoutStore.getState().clearReveal(instanceId);
      containerRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [instanceId]);

  const openSettings = useCallback(() => setSettingsOpen(true), []);

  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const resetSettings = useCallback(() => {
    void widgetSettingsActions.remove(instanceId);
  }, [instanceId]);

  const Component = definition?.component;

  return (
    <div ref={containerRef} className={`widget-container${editMode ? ' edit-mode' : ''}`}>
      {editMode && (
        <div className="widget-header">
          <div className="widget-header-title">
            <GripHorizontal size={14} />
            <WidgetIcon name={manifest?.icon} size={14} />
            <span>{title}</span>
          </div>
          <div className={`widget-header-actions no-drag${confirming ? ' confirming' : ''}`}>
            {confirming ? (
              <>
                <span className="widget-header-confirm">Wirklich entfernen?</span>
                <button type="button" className="widget-header-action danger" onClick={() => removeWidget(instanceId)}>
                  <Trash2 size={14} />
                  Ja
                </button>
                <button type="button" className="widget-header-action" onClick={() => setConfirmingRemove(false)}>
                  Nein
                </button>
              </>
            ) : (
              <>
                {schemaManifest && (
                  <button
                    type="button"
                    className="widget-header-action"
                    onClick={openSettings}
                    title="Einstellungen"
                    aria-label={`Einstellungen: ${title}`}
                  >
                    <Settings size={16} />
                  </button>
                )}
                <button
                  type="button"
                  className="widget-header-action"
                  onClick={() => setConfirmingRemove(true)}
                  title="Widget entfernen"
                  aria-label={`Widget entfernen: ${title}`}
                >
                  <X size={16} />
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <div className="widget-body">
        {Component ? (
          <WidgetErrorBoundary
            label={title}
            resetKey={storedSettings}
            onResetSettings={editMode && storedSettings !== undefined ? resetSettings : undefined}
          >
            <Suspense fallback={<WidgetLoading />}>
              <Component instanceId={instanceId} width={w} height={h} />
            </Suspense>
          </WidgetErrorBoundary>
        ) : (
          <div className="widget-fallback" role="alert">
            <div className="widget-fallback-title">
              <AlertTriangle size={16} />
              Unbekanntes Widget
            </div>
            <div className="widget-fallback-detail">
              «{widgetId}» ist in dieser Version nicht verfügbar.
              {editMode ? '' : ' Im Bearbeiten-Modus entfernen.'}
            </div>
          </div>
        )}
      </div>
      {schemaManifest && settingsOpen && editMode && (
        <WidgetSettingsDialog open onClose={closeSettings} title={`${title} – Einstellungen`}>
          <SchemaSettings instanceId={instanceId} manifest={schemaManifest} extra={definition?.settingsExtra} />
        </WidgetSettingsDialog>
      )}
    </div>
  );
});
