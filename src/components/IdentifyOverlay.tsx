/**
 * IdentifyOverlay – "Welcher Bildschirm ist das?" Triggered from the web UI
 * (kiosk://action identify): kiosk name, host name and IP addresses in large
 * type. The parent closes it after 10 s; a tap closes it earlier.
 */
import React, { useEffect, useState } from 'react';
import { isTauri, systemInfo, type SystemInfo } from '../utils/backend';

interface Props {
  name: string;
  onClose: () => void;
}

export const IdentifyOverlay: React.FC<Props> = ({ name, onClose }) => {
  const [info, setInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    systemInfo().then(
      (result) => {
        if (!cancelled) setInfo(result);
      },
      (err: unknown) => console.warn('Systeminfo nicht verfügbar:', err),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="identify-overlay" role="alertdialog" aria-label={`Bildschirm ${name}`} onClick={onClose}>
      <div className="identify-name">{name}</div>
      {info && <div className="identify-host">{info.hostname}</div>}
      {info && info.ips.length > 0 && (
        <div className="identify-ips">
          {info.ips.map((ip) => (
            <span key={ip}>{ip}</span>
          ))}
        </div>
      )}
    </div>
  );
};
