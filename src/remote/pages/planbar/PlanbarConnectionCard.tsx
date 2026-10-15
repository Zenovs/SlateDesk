/**
 * planbar settings for all Unternehmen (state.planbar: enabled, url). The
 * API keys are per Unternehmen (PlanbarOrgCard). The kiosk clears every key
 * when the address changes over HTTP – a key must not follow a new address.
 */
import { useCallback, useMemo } from 'react';
import { PlugZap, Unplug } from 'lucide-react';
import { SettingsForm } from '../../../components/settings/SettingsForm';
import { configuredOrgs } from '../../../planbar/orgs';
import { useAppState } from '../../../state/appState';
import { DEFAULT_PLANBAR_URL } from '../../../state/defaults';
import type { SettingsField } from '../../../types/settings';
import { plural } from '../../format';
import { Card, Notice, StatusDot, toast, type StatusTone } from '../../ui';
import { httpUrlOrNull } from '../../url';

const SCHEMA: SettingsField[] = [
  {
    type: 'boolean',
    key: 'enabled',
    label: 'planbar verwenden',
    description: 'Schaltet die planbar-Widgets am Kiosk und die Vorschau auf dieser Seite ein.',
  },
  {
    type: 'url',
    key: 'url',
    label: 'Adresse',
    placeholder: DEFAULT_PLANBAR_URL,
    description:
      'Adresse von planbar, gilt für alle Unternehmen. Leer lassen für die Standardadresse. Achtung: Eine neue Adresse löscht die API-Schlüssel aller Unternehmen.',
  },
];

export interface PlanbarConnectionCardProps {
  /** Address saved – data shown with the old one is outdated. */
  onConnectionChange: () => void;
}

export function PlanbarConnectionCard({ onConnectionChange }: PlanbarConnectionCardProps) {
  const enabled = useAppState((s) => s.state.planbar.enabled);
  const url = useAppState((s) => s.state.planbar.url);
  const keyCount = useAppState((s) => configuredOrgs(s.state.planbar).length);
  const values = useMemo<Record<string, unknown>>(() => ({ enabled, url }), [enabled, url]);

  const onChange = useCallback(
    (patch: Record<string, unknown>) => {
      const clean = { ...patch };
      if (typeof clean.url === 'string') {
        const text = clean.url.trim();
        const next = text === '' ? DEFAULT_PLANBAR_URL : httpUrlOrNull(text);
        if (next === null) {
          toast.error('Ungültige Adresse – bitte vollständig mit https:// eingeben');
          delete clean.url;
        } else {
          clean.url = next;
        }
      }
      const { apply, state } = useAppState.getState();
      const current: Record<string, unknown> = { enabled: state.planbar.enabled, url: state.planbar.url };
      const changed = Object.keys(clean).filter((key) => key in current && current[key] !== clean[key]);
      if (changed.length === 0) return;
      const update = Object.fromEntries(changed.map((key) => [key, clean[key]]));

      // Keys the kiosk drops with the new address (state.rs clears every secret below `planbar`).
      const lostKeys = changed.includes('url') ? configuredOrgs(state.planbar).length : 0;
      void apply([{ op: 'merge', path: ['planbar'], value: update }]).then((ok) => {
        if (!ok) return;
        if (changed.includes('url')) onConnectionChange();
        if (lostKeys > 0) {
          toast.warning(
            `Adresse geändert – ${plural(lostKeys, 'API-Schlüssel', 'API-Schlüssel')} aus Sicherheitsgründen gelöscht. Bitte bei den Unternehmen neu eingeben.`,
          );
        } else if (changed.includes('url')) {
          toast.success('Adresse gespeichert');
        } else if (changed.includes('enabled')) {
          toast.success(update.enabled ? 'planbar eingeschaltet' : 'planbar ausgeschaltet');
        }
      });
    },
    [onConnectionChange],
  );

  const tone: StatusTone = !enabled ? 'idle' : keyCount > 0 ? 'ok' : 'warn';
  const status = !enabled ? 'Ausgeschaltet' : keyCount > 0 ? 'Eingerichtet' : 'Schlüssel fehlt';

  return (
    <Card
      title="Verbindung"
      icon={enabled ? PlugZap : Unplug}
      subtitle="Gilt für die planbar-Widgets am Kiosk und für diese Seite."
      actions={
        <span className={`r-pill r-pill-${tone}`}>
          <StatusDot tone={tone} />
          {status}
        </span>
      }
    >
      <div className="r-settings">
        <SettingsForm schema={SCHEMA} values={values} onChange={onChange} context="remote" />
      </div>
      {keyCount > 0 && (
        <Notice tone="info">
          Wird die Adresse geändert, löscht der Kiosk die gespeicherten API-Schlüssel aller Unternehmen aus
          Sicherheitsgründen – deshalb zuerst die Adresse anpassen und danach die Schlüssel eintragen.
        </Notice>
      )}
    </Card>
  );
}
