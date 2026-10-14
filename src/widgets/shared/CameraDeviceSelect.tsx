/**
 * CameraDeviceSelect – camera picker for the kiosk settings of the camera and
 * Ruhemodus widgets. Only the kiosk knows its cameras, so it lives in their
 * settingsExtra instead of the (web UI) schema. '' = default camera.
 */
import { useEffect, useId, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { listCameras, onCameraDevicesChange, type CameraDevice } from '../../services/cameraService';

interface CameraDeviceSelectProps {
  value: string;
  onChange: (deviceId: string) => void;
}

export function CameraDeviceSelect({ value, onChange }: CameraDeviceSelectProps) {
  const id = useId();
  const [devices, setDevices] = useState<CameraDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      listCameras().then(
        (list) => {
          if (cancelled) return;
          setDevices(list);
          setError(null);
        },
        (err: unknown) => {
          if (cancelled) return;
          console.warn('Kameras konnten nicht aufgelistet werden:', err);
          setError('Die Kameras konnten nicht aufgelistet werden.');
        },
      );
    };
    load();
    const unsubscribe = onCameraDevicesChange(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [reloadTick]);

  const missing = value !== '' && devices !== null && !devices.some((d) => d.deviceId === value);

  return (
    <div className="settings-field">
      <label className="settings-label" htmlFor={id}>
        Kamera
      </label>
      <div className="settings-input-row">
        <select id={id} className="settings-select" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Standardkamera (automatisch)</option>
          {devices?.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
          {missing && <option value={value}>Gewählte Kamera (nicht angeschlossen)</option>}
        </select>
        <button
          type="button"
          className="settings-icon-btn"
          onClick={() => setReloadTick((tick) => tick + 1)}
          title="Kameraliste neu laden"
          aria-label="Kameraliste neu laden"
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error ? (
        <div className="settings-field-error">{error}</div>
      ) : (
        <p className="settings-description">
          {devices !== null && devices.length === 0
            ? 'Keine Kamera gefunden – Kamera anschliessen, die Liste aktualisiert sich selbst.'
            : 'Die Standardkamera nutzt eine bereits laufende Kamera mit, so teilen sich Gesichtserkennung und Ruhemodus ein Bild.'}
        </p>
      )}
    </div>
  );
}
