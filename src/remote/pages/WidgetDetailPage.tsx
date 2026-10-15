/**
 * Settings of one widget instance: the manifest's schema rendered by the
 * shared SettingsForm (remote context), bound to
 * state.widgetSettings[instanceId] over the manifest defaults. Every change
 * is written right away and shows up on the kiosk live.
 */
import { useCallback, useMemo } from 'react';
import { LayoutGrid, Puzzle, RotateCcw, SlidersHorizontal, Trash2, Wrench } from 'lucide-react';
import { SettingsForm } from '../../components/settings/SettingsForm';
import { WidgetIcon } from '../../components/settings/WidgetIcon';
import { configuredOrgs } from '../../planbar/orgs';
import { useAppState } from '../../state/appState';
import { widgetSettingsActions } from '../../state/dataActions';
import type { AppStateData } from '../../state/types';
import type { SettingsField } from '../../types/settings';
import type { WidgetCategory } from '../../types/widget';
import { getManifest } from '../../widgets/catalog';
import { useDisplayedWidgets } from '../hooks/useDisplayedWidgets';
import { href, navigate } from '../router';
import { hasSecretField, hasSecretNextToEndpoint, isSecretSet, secretsClearedBy } from '../secrets';
import { Card, ConfirmButton, EmptyState, LinkButton, Notice, PageHeader, toast } from '../ui';
import { removeWidget } from '../widgetActions';
import { positionText, sizeText } from '../widgetInfo';

const EMPTY_SCHEMA: SettingsField[] = [];

const quoteList = (labels: string[]): string => labels.map((label) => `«${label}»`).join(', ');

/** Widgets of a service need its connection – set up on the service's own page. */
interface Service {
  route: 'lagra' | 'planbar';
  ready: (state: AppStateData) => boolean;
  /** Its widgets have pickers loaded from the service. */
  pickers?: boolean;
}

const SERVICES: Partial<Record<WidgetCategory, Service>> = {
  lagra: { route: 'lagra', ready: (state) => state.lagra.enabled && isSecretSet(state.lagra.token) },
  planbar: {
    route: 'planbar',
    ready: (state) => state.planbar.enabled && configuredOrgs(state.planbar).length > 0,
    pickers: true,
  },
};

export function WidgetDetailPage({ instanceId }: { instanceId: string }) {
  const { widgets, labels } = useDisplayedWidgets();
  const instance = widgets.find((w) => w.instanceId === instanceId) ?? null;
  const stored = useAppState((s) => s.state.widgetSettings[instanceId]);
  const widgetId = useAppState((s) => s.state.layout.widgets.find((w) => w.instanceId === instanceId)?.widgetId ?? null);
  const manifest = widgetId ? getManifest(widgetId) : undefined;
  const schema = manifest?.settingsSchema ?? EMPTY_SCHEMA;
  const label = labels.get(instanceId) ?? instanceId;
  const service = manifest?.category ? SERVICES[manifest.category] : undefined;
  const serviceReady = useAppState((s) => service?.ready(s.state) ?? true);

  // Keyed by widgetId (a string): manifests are module constants.
  const values = useMemo<Record<string, unknown>>(
    () => ({ ...((widgetId && getManifest(widgetId)?.defaultSettings) || {}), ...(stored ?? {}) }),
    [widgetId, stored],
  );

  const onChange = useCallback(
    (patch: Record<string, unknown>) => {
      const fields = (widgetId && getManifest(widgetId)?.settingsSchema) || EMPTY_SCHEMA;
      const cleared = secretsClearedBy(fields, values, patch);
      void widgetSettingsActions.update(instanceId, patch).then((ok) => {
        if (!ok || cleared.length === 0) return;
        toast.warning(
          `Adresse geändert – ${quoteList(cleared)} ${cleared.length === 1 ? 'wurde' : 'wurden'} aus Sicherheitsgründen gelöscht. Bitte neu eingeben.`,
        );
      });
    },
    [instanceId, widgetId, values],
  );

  const back = { href: href('widgets'), label: 'Alle Widgets' };

  if (!instance) {
    return (
      <div className="r-page">
        <PageHeader title="Widget nicht gefunden" back={back} />
        <EmptyState
          icon={Puzzle}
          title="Dieses Widget gibt es nicht mehr"
          description="Es wurde inzwischen vom Kiosk entfernt."
          action={
            <LinkButton href={href('widgets')} variant="primary">
              Zur Widget-Liste
            </LinkButton>
          }
        />
      </div>
    );
  }

  const hasSchema = schema.length > 0;
  const customized = stored !== undefined && Object.keys(stored).length > 0;
  const remove = () =>
    removeWidget(instance.instanceId, label).then((ok) => {
      if (ok) navigate(href('widgets'), { replace: true });
    });

  return (
    <div className="r-page">
      <PageHeader
        title={
          <span className="r-title-with-icon">
            <span className="r-title-icon" aria-hidden="true">
              <WidgetIcon name={manifest?.icon} size={22} />
            </span>
            {label}
          </span>
        }
        description={manifest?.description ?? `Unbekannter Widget-Typ «${instance.widgetId}» – dieser Kiosk kennt ihn nicht.`}
        back={back}
        actions={
          <LinkButton href={href('layout')} icon={LayoutGrid}>
            Im Layout
          </LinkButton>
        }
      />
      <p className="r-meta">
        {positionText(instance)} · Grösse {sizeText(instance)}
      </p>

      {service && !serviceReady && (
        <Notice
          tone="warning"
          title={`${service.route} ist nicht eingerichtet`}
          action={
            <LinkButton href={href(service.route)} size="sm">
              {service.route} einrichten
            </LinkButton>
          }
        >
          Das Widget zeigt erst Daten, wenn {service.route} unter «{service.route}» eingeschaltet und der Zugang eingetragen
          ist.{service.pickers ? ' Auch die Auswahl von Personen und Projekten unten lädt erst danach.' : ''}
        </Notice>
      )}

      {hasSchema && hasSecretField(schema) && (
        <Notice tone="info" title="Zugangsdaten">
          Passwörter, Tokens und Schlüssel werden nie angezeigt – «gesetzt» heisst, dass ein Wert gespeichert ist. Zum
          Ändern einfach den neuen Wert eingeben.
          {hasSecretNextToEndpoint(schema) &&
            ' Wird eine Adresse (URL oder Host) geändert, löscht der Kiosk das zugehörige Passwort bzw. den Schlüssel aus Sicherheitsgründen: zuerst die Adresse ändern, danach den Zugang neu eingeben.'}
        </Notice>
      )}

      <Card title="Einstellungen" icon={SlidersHorizontal}>
        {hasSchema ? (
          <div className="r-settings">
            <SettingsForm schema={schema} values={values} onChange={onChange} context="remote" />
          </div>
        ) : (
          <EmptyState
            icon={SlidersHorizontal}
            title="Keine Einstellungen"
            description="Dieses Widget hat keine Einstellungen."
            compact
          />
        )}
      </Card>

      <Card title="Verwalten" icon={Wrench}>
        <div className="r-manage">
          {hasSchema && (
            <div className="r-manage-row">
              <div className="r-manage-text">
                <p className="r-manage-title">Auf Standard zurücksetzen</p>
                <p className="r-manage-description">
                  {customized
                    ? 'Alle Einstellungen dieses Widgets inklusive gespeicherter Zugangsdaten werden gelöscht.'
                    : 'Es sind nur Standardwerte gesetzt.'}
                </p>
              </div>
              <ConfirmButton
                icon={RotateCcw}
                disabled={!customized}
                confirmTitle="Einstellungen zurücksetzen?"
                confirmMessage={`Alle Einstellungen von «${label}» inklusive gespeicherter Zugangsdaten werden gelöscht. Das Widget verwendet danach wieder die Standardwerte.`}
                confirmLabel="Zurücksetzen"
                onConfirm={() =>
                  widgetSettingsActions.remove(instance.instanceId).then((ok) => {
                    if (ok) toast.success('Einstellungen zurückgesetzt');
                  })
                }
              >
                Auf Standard zurücksetzen
              </ConfirmButton>
            </div>
          )}
          <div className="r-manage-row">
            <div className="r-manage-text">
              <p className="r-manage-title">Widget entfernen</p>
              <p className="r-manage-description">Entfernt das Widget vom Kiosk, samt seinen Einstellungen.</p>
            </div>
            <ConfirmButton
              icon={Trash2}
              variant="danger"
              confirmTitle="Widget entfernen?"
              confirmMessage={`«${label}» wird vom Kiosk entfernt. Seine Einstellungen werden ebenfalls gelöscht.`}
              confirmLabel="Entfernen"
              onConfirm={remove}
            >
              Entfernen
            </ConfirmButton>
          </div>
        </div>
      </Card>
    </div>
  );
}
