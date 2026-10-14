/** Actions on the kiosk: reload, identify, display off/on, restart the app. */
import { useState } from 'react';
import { Monitor, MonitorOff, Power, RefreshCw, ScanEye, Zap, type LucideIcon } from 'lucide-react';
import { actions } from '../../api';
import { Button, Card, ConfirmButton, toast, toastResult } from '../../ui';

type ActionKey = 'reload' | 'identify' | 'sleep' | 'wake';

export function ActionsCard() {
  const [busy, setBusy] = useState<ActionKey | null>(null);

  const button = <T,>(
    key: ActionKey,
    icon: LucideIcon,
    label: string,
    task: () => Promise<T>,
    success: string | ((result: T) => string),
  ) => (
    <Button
      icon={icon}
      busy={busy === key}
      disabled={busy !== null && busy !== key}
      onClick={() => {
        setBusy(key);
        void toastResult(task(), success).finally(() => setBusy(null));
      }}
    >
      {label}
    </Button>
  );

  return (
    <Card title="Aktionen" icon={Zap}>
      <div className="rs-actions">
        {button('reload', RefreshCw, 'Neu laden', actions.reload, 'Kiosk wird neu geladen')}
        {button('identify', ScanEye, 'Identifizieren', actions.identify, 'Der Kiosk zeigt 10 Sekunden lang Name und Adresse an')}
        {button('sleep', MonitorOff, 'Bildschirm aus', actions.displaySleep, (backend) =>
          backend ? `Bildschirm ausgeschaltet (${backend})` : 'Bildschirm ausgeschaltet',
        )}
        {button('wake', Monitor, 'Bildschirm an', actions.displayWake, 'Bildschirm eingeschaltet')}
        <ConfirmButton
          icon={Power}
          variant="danger"
          confirmTitle="App neu starten?"
          confirmMessage="Die SlateDesk-App auf dem Kiosk startet neu; der Bildschirm ist dabei einige Sekunden leer. Alle Sitzungen der Fernsteuerung enden – danach ist eine erneute Anmeldung nötig."
          confirmLabel="Neu starten"
          onConfirm={() =>
            actions.restart().then(() => {
              toast.info('Die App wird neu gestartet – danach bitte erneut anmelden');
            })
          }
        >
          App neu starten
        </ConfirmButton>
      </div>
      <p className="r-hint">«Neu laden» lädt nur die Anzeige neu, «App neu starten» das ganze Programm.</p>
    </Card>
  );
}
