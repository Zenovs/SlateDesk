import { describe, expect, it } from 'vitest';
import { escapeWifiField, normalizeLink, QR_CODE_DEFAULTS, qrContent, wifiPayload } from './qrcode';

describe('wifiPayload', () => {
  it('builds the WIFI: string phone cameras understand', () => {
    expect(wifiPayload('Gast', 'geheim123', 'WPA', false)).toBe('WIFI:T:WPA;S:Gast;P:geheim123;;');
    expect(wifiPayload('Gast', 'geheim123', 'WPA', true)).toBe('WIFI:T:WPA;S:Gast;P:geheim123;H:true;;');
  });

  it('leaves the password out of open networks', () => {
    expect(wifiPayload('Café', 'ignoriert', 'nopass', false)).toBe('WIFI:T:nopass;S:Café;;');
  });

  it('escapes backslash, semicolon, comma, colon and double quote', () => {
    expect(escapeWifiField('a\\b;c,d:e"f')).toBe('a\\\\b\\;c\\,d\\:e\\"f');
    expect(wifiPayload('Büro;5G', 'p:w,"x"\\', 'WPA', false)).toBe('WIFI:T:WPA;S:Büro\\;5G;P:p\\:w\\,\\"x\\"\\\\;;');
  });
});

describe('normalizeLink', () => {
  it('adds https:// to bare domains only', () => {
    expect(normalizeLink(' www.beispiel.ch/kontakt ')).toBe('https://www.beispiel.ch/kontakt');
    expect(normalizeLink('beispiel.ch:8080')).toBe('https://beispiel.ch:8080');
    expect(normalizeLink('http://192.168.1.20:7380')).toBe('http://192.168.1.20:7380');
    expect(normalizeLink('mailto:info@beispiel.ch')).toBe('mailto:info@beispiel.ch');
    expect(normalizeLink('   ')).toBe('');
  });
});

describe('qrContent', () => {
  it('names what is missing', () => {
    expect(qrContent(QR_CODE_DEFAULTS)).toEqual({ ok: false, missing: 'WLAN-Name in den Einstellungen eintragen' });
    expect(qrContent({ ...QR_CODE_DEFAULTS, wlanSsid: 'Gast' })).toEqual({
      ok: false,
      missing: 'WLAN-Passwort in den Einstellungen eintragen',
    });
    expect(qrContent({ ...QR_CODE_DEFAULTS, mode: 'url' }).ok).toBe(false);
    expect(qrContent({ ...QR_CODE_DEFAULTS, mode: 'text', text: '  ' }).ok).toBe(false);
  });

  it('encodes the active mode only', () => {
    const settings = { ...QR_CODE_DEFAULTS, wlanSsid: 'Gast', wlanPassword: 'pw12345678', link: 'beispiel.ch' };
    expect(qrContent(settings)).toEqual({ ok: true, payload: 'WIFI:T:WPA;S:Gast;P:pw12345678;;' });
    expect(qrContent({ ...settings, mode: 'url' })).toEqual({ ok: true, payload: 'https://beispiel.ch' });
    expect(qrContent({ ...settings, wlanEncryption: 'nopass', wlanPassword: '' })).toEqual({
      ok: true,
      payload: 'WIFI:T:nopass;S:Gast;;',
    });
  });
});
