/**
 * RemoteInfoDialog – how to reach the web UI (Fernsteuerung): address(es),
 * QR code and PIN. Kiosk only; the PIN never leaves the Tauri side.
 */
import React, { useEffect, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { qrSvg, remoteInfo, type RemoteInfo } from '../utils/backend';
import { WidgetSettingsDialog } from './WidgetSettingsDialog';

interface Props {
  onClose: () => void;
}

type QrState = { url: string; src: string | null; failed: boolean };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const RemoteInfoDialog: React.FC<Props> = ({ onClose }) => {
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [qr, setQr] = useState<QrState | null>(null);
  const [showPin, setShowPin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    remoteInfo().then(
      (result) => {
        if (!cancelled) setInfo(result);
      },
      (err: unknown) => {
        if (!cancelled) setLoadError(errorText(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const urls = info?.urls ?? [];
  const url = urls[Math.min(selected, urls.length - 1)] ?? null;

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    qrSvg(url).then(
      (svg) => {
        // As <img>: the SVG can't run anything and currentColor resolves to black.
        if (!cancelled) setQr({ url, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, failed: false });
      },
      (err: unknown) => {
        console.warn('QR-Code konnte nicht erzeugt werden:', err);
        if (!cancelled) setQr({ url, src: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [url]);

  const qrForUrl = qr && qr.url === url ? qr : null;

  let content: React.ReactNode;
  if (loadError) {
    content = <div className="settings-info-box error">Fernsteuerung nicht verfügbar: {loadError}</div>;
  } else if (!info) {
    content = (
      <div className="remote-info-hint" role="status">
        Wird geladen…
      </div>
    );
  } else if (!info.enabled) {
    content = (
      <div className="settings-info-box warning">
        Die Fernsteuerung ist auf diesem Gerät ausgeschaltet (in remote.json oder mit SLATEDESK_REMOTE_DISABLED).
      </div>
    );
  } else if (info.error) {
    // The web server did not start (e.g. port taken): no address, QR code or
    // network hint would help – they would send the user after the cable.
    content = (
      <div className="remote-info">
        <div className="settings-info-box error">Der Webserver der Fernsteuerung läuft nicht: {info.error}</div>
        <div className="remote-info-hint">
          Ist Port {info.port} von einem anderen Programm belegt, in remote.json («port») oder mit
          SLATEDESK_REMOTE_PORT einen freien Port wählen. Danach SlateDesk neu starten.
        </div>
      </div>
    );
  } else {
    content = (
      <div className="remote-info">
        <div className="remote-info-main">
          <div className="remote-info-qr">
            {qrForUrl?.src ? (
              <img src={qrForUrl.src} alt={`QR-Code für ${url}`} />
            ) : qrForUrl?.failed || !url ? (
              <span>QR-Code nicht verfügbar – Adresse bitte von Hand eingeben.</span>
            ) : (
              <span>QR-Code wird erzeugt…</span>
            )}
          </div>
          <div className="remote-info-details">
            <div>
              <div className="remote-info-label">{urls.length > 1 ? 'Adressen' : 'Adresse'}</div>
              {urls.length === 0 ? (
                <div className="remote-info-hint">
                  Keine Netzwerkadresse gefunden – ist das Gerät mit dem Netzwerk verbunden?
                </div>
              ) : (
                <div className="remote-info-urls">
                  {urls.map((entry, index) => (
                    <button
                      key={entry}
                      type="button"
                      className={`remote-info-url${entry === url ? ' selected' : ''}`}
                      onClick={() => setSelected(index)}
                      aria-pressed={entry === url}
                    >
                      {entry}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="remote-info-label">PIN</div>
              <div className="remote-info-pin">
                <span className="remote-info-pin-value">{showPin ? info.pin : '•'.repeat(Math.max(info.pin.length, 6))}</span>
                <button
                  type="button"
                  className="settings-icon-btn"
                  onClick={() => setShowPin((v) => !v)}
                  title={showPin ? 'PIN verbergen' : 'PIN anzeigen'}
                  aria-label={showPin ? 'PIN verbergen' : 'PIN anzeigen'}
                >
                  {showPin ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="remote-info-hint">
          QR-Code mit dem Handy scannen oder die Adresse im Browser öffnen (gleiches Netzwerk) und mit der PIN
          anmelden. Die PIN lässt sich in der Fernsteuerung unter «System» ändern.
        </div>
      </div>
    );
  }

  return (
    <WidgetSettingsDialog open onClose={onClose} title="Fernsteuerung">
      {content}
    </WidgetSettingsDialog>
  );
};
