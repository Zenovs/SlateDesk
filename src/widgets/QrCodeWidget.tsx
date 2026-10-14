/**
 * QR-Code – Gäste-WLAN, Webadresse oder Text.
 *
 * Der Code entsteht im Kiosk (qr_svg) und steht immer schwarz auf einer
 * weissen Karte, damit Handys ihn auch im dunklen Design lesen. Ausserhalb
 * des Kiosks zeigt das Widget den kodierten Inhalt – das Passwort verdeckt,
 * solange es nicht ausdrücklich als Text gezeigt werden soll.
 */
import { type ReactNode, useMemo, useRef } from 'react';
import { KeyRound, Link, QrCode, Wifi } from 'lucide-react';
import { useElementSize } from '../hooks/useElementSize';
import { useWidgetSettings } from '../hooks/useWidgetSettings';
import type { WidgetProps } from '../types/widget';
import { isTauri, KIOSK_ONLY_MESSAGE } from '../utils/backend';
import {
  DEFAULT_WLAN_TITLE,
  normalizeLink,
  QR_CODE_DEFAULTS,
  QR_MODES,
  qrContent,
  type QrCodeSettings,
  WLAN_ENCRYPTIONS,
} from './manifests/qrcode';
import { useQrImage } from './shared/hooks';
import { WidgetMessage } from './shared/WidgetParts';
import { readBoolean, readChoice, readNumber, readString } from './shared/values';
import './styles/qrcode.css';

const PASSWORD_MASK = '••••••••';

function readSettings(raw: QrCodeSettings): QrCodeSettings {
  const defaults = QR_CODE_DEFAULTS;
  return {
    mode: readChoice(raw.mode, QR_MODES, defaults.mode),
    link: readString(raw.link, defaults.link),
    text: readString(raw.text, defaults.text),
    wlanSsid: readString(raw.wlanSsid, defaults.wlanSsid),
    wlanPassword: readString(raw.wlanPassword, defaults.wlanPassword),
    wlanEncryption: readChoice(raw.wlanEncryption, WLAN_ENCRYPTIONS, defaults.wlanEncryption),
    wlanHidden: readBoolean(raw.wlanHidden, defaults.wlanHidden),
    title: readString(raw.title, defaults.title),
    caption: readString(raw.caption, defaults.caption),
    showSsid: readBoolean(raw.showSsid, defaults.showSsid),
    revealPasswordText: readBoolean(raw.revealPasswordText, defaults.revealPasswordText),
    size: readNumber(raw.size, defaults.size, 40, 100),
  };
}

/** Square white card as large as the free space allows (times `sizePercent`). */
function QrCard({ src, alt, sizePercent }: { src: string; alt: string; sizePercent: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(ref);
  const side = Math.floor((Math.min(width, height) * sizePercent) / 100);
  return (
    <div ref={ref} className="qr-stage">
      {side > 0 && (
        // White margin in px of the card itself (CSS % padding would follow the stage width).
        <div className="qr-card" style={{ width: side, height: side, padding: Math.round(side * 0.05) }}>
          <img src={src} alt={alt} />
        </div>
      )}
    </div>
  );
}

export function QrCodeWidget({ instanceId }: WidgetProps) {
  const [raw] = useWidgetSettings<QrCodeSettings>(instanceId, QR_CODE_DEFAULTS);
  const settings = useMemo(() => readSettings(raw), [raw]);
  const content = qrContent(settings);
  const inKiosk = isTauri();
  const qr = useQrImage(content.ok && inKiosk ? content.payload : null);

  const wlan = settings.mode === 'wlan';
  const title = settings.title.trim() || (wlan ? DEFAULT_WLAN_TITLE : '');
  const needsPassword = wlan && settings.wlanEncryption !== 'nopass';
  const showPassword = needsPassword && settings.revealPasswordText;
  const caption = settings.caption.trim();

  if (!content.ok) return <WidgetMessage icon={QrCode} title={title || 'QR-Code'} detail={content.missing} />;

  const alt =
    settings.mode === 'wlan'
      ? `QR-Code für das WLAN «${settings.wlanSsid}»`
      : settings.mode === 'url'
        ? `QR-Code für ${normalizeLink(settings.link)}`
        : 'QR-Code mit Text';

  let code: ReactNode;
  if (!inKiosk) {
    const shown = qrContent({ ...settings, wlanPassword: showPassword ? settings.wlanPassword : PASSWORD_MASK });
    code = (
      <div className="qr-preview">
        <span className="qr-preview-note">{KIOSK_ONLY_MESSAGE} – kodierter Inhalt:</span>
        <code className="qr-preview-text">{shown.ok ? shown.payload : ''}</code>
      </div>
    );
  } else if (qr.src) {
    code = <QrCard src={qr.src} alt={alt} sizePercent={settings.size} />;
  } else if (qr.error) {
    code = <WidgetMessage icon={QrCode} tone="error" title="QR-Code nicht möglich" detail={qr.error} />;
  } else {
    code = <WidgetMessage busy title="QR-Code wird erzeugt …" />;
  }

  return (
    <div className="qr">
      {title && <div className="qr-title">{title}</div>}
      {code}
      {caption && <div className="qr-caption">{caption}</div>}
      {settings.mode === 'url' && (
        <div className="qr-info">
          <span className="qr-info-item">
            <Link aria-hidden="true" />
            <span className="qr-info-value">{normalizeLink(settings.link).replace(/^https?:\/\//, '')}</span>
          </span>
        </div>
      )}
      {wlan && (settings.showSsid || showPassword) && (
        <div className="qr-info">
          {settings.showSsid && (
            <span className="qr-info-item">
              <Wifi aria-label="WLAN" />
              <span className="qr-info-value">{settings.wlanSsid}</span>
            </span>
          )}
          {showPassword && (
            <span className="qr-info-item">
              <KeyRound aria-label="Passwort" />
              <span className="qr-info-value qr-mono">{settings.wlanPassword}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
