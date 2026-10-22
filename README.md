# SlateDesk

Dashboard-Kiosk für das Büro – Tauri 2, React 19 und Rust, mit Fernsteuerung per Handy im LAN.

SlateDesk läuft rund um die Uhr im Vollbild auf einem Bildschirm-PC (Ubuntu mit GNOME, zenOS mit labwc
oder Raspberry Pi OS; Wayland oder X11, WebKitGTK)
und zeigt Widgets in einem frei einteilbaren Raster: Uhr, Kalender, Wetter, Nachrichten, Aufgaben,
Netzwerk-Status, KI-Assistent und die Arbeitsdaten aus **lagra** und **planbar**. Bedient wird der Kiosk
über die **Fernsteuerung**, eine Web-Oberfläche, die die App selbst im Büro-LAN bereitstellt (Port 7380,
Anmeldung mit PIN).

Den Zustand (Layout, Widget-Einstellungen, Inhalte, Zugangsdaten) verwaltet das Rust-Backend in einer
Datei auf dem Gerät. Kiosk und Fernsteuerung zeigen Änderungen sofort gegenseitig an.

## Installation

Ein Befehl im Terminal genügt – auf Ubuntu, Debian, Raspberry Pi OS und zenOS:

```bash
curl -fsSL https://raw.githubusercontent.com/Zenovs/SlateDesk/main/install.sh | sudo bash
```

Das Script holt SlateDesk von GitHub, installiert alles Nötige, baut die App (beim ersten Mal
10–30 Minuten) und startet sie im Vollbild – sofort oder nach der nächsten Anmeldung. Danach
aktualisiert sich SlateDesk jede Nacht selbst und kehrt bei einem Fehlstart automatisch zur
vorherigen Version zurück. Root-Rechte braucht es nur für diese Installation.

Optionen werden angehängt, z. B. automatische Anmeldung und Freigabe der Fernsteuerung im lokalen Netz:

```bash
curl -fsSL https://raw.githubusercontent.com/Zenovs/SlateDesk/main/install.sh | sudo bash -s -- --autologin --ufw
```

| Option | Wirkung |
|---|---|
| `--ufw` | Port 7380 der Fernsteuerung nur im lokalen Netz freigeben |
| `--autologin` | Kiosk-Benutzer meldet sich automatisch an (GDM/LightDM; unter zenOS regelt das zenOS) |
| `--user NAME` | Kiosk-Benutzer (Standard `slatedesk`; unter zenOS das Anzeige-Konto `anzeige` bzw. der eigene Benutzer) |
| `--branch NAME` | aus einem anderen Branch installieren und aktualisieren, z. B. auf einem Testrechner |
| `--dry-run` | nur anzeigen, was passieren würde |

Nach der Installation zeigt der Kiosk unter **Bearbeiten → Fernsteuerung** Adresse, QR-Code und PIN –
alles Weitere lässt sich vom Handy aus einrichten. Updates, Rollback, Logs, Datensicherung und Fehlersuche:
**[docs/BETRIEB.md](docs/BETRIEB.md)**. Läuft auf einem Gerät noch das alte `.deb`-Setup, vorher dort den
Abschnitt «Migration vom alten Setup» lesen.

## Funktionen

### Kiosk

- Vollbild ohne Fensterrahmen, startet nach der automatischen Anmeldung von selbst
- Raster mit frei wählbarer Spaltenzahl; Widgets per Ziehen frei platzieren (auch mitten auf dem Bildschirm)
  und in der Grösse ändern
  («Bearbeiten» in der oberen Leiste oder in der Fernsteuerung)
- Design Dunkel/Hell mit wählbarer Akzentfarbe
- obere Leiste ausblendbar (antippen der Ecke oben rechts blendet sie für 30 Sekunden ein),
  Mauszeiger verschwindet nach einstellbarer Zeit
- Bildschirmzeiten: Bildschirm z. B. nachts und am Wochenende aus, eine Berührung weckt ihn
- Update-Knopf in der oberen Leiste, nächtliche Updates mit automatischem Rollback

### Widgets

| Kategorie | Widget | Inhalt |
|---|---|---|
| Zeit & Kalender | Uhr | digital oder analog, Datum, Kalenderwoche, Weltzeituhren |
| | Kalender | ICS-Kalender (Office 365, Google, iCloud) als Agenda, Tagesansicht oder Raumbelegung; Option «Nur Besetzt» |
| Information | Wetter | MeteoSwiss ICON-CH2 bzw. Open-Meteo, Stundenverlauf, Vorhersage, Luftqualität und Pollen – ohne API-Schlüssel |
| | Nachrichten | RSS-/Atom-Feeds (z. B. SRF, NZZ) als Liste, wechselnde Schlagzeile oder Laufband |
| Büro | Pinnwand | Mitteilungen, erfasst in der Fernsteuerung, mit Sichtbarkeitszeitraum |
| | Aufgaben | gemeinsame Aufgabenlisten mit Fälligkeit, Priorität und Zuständigkeit |
| | QR-Code | Gäste-WLAN, Webadresse oder Text |
| Medien | Volumio | aktueller Titel mit Wiedergabe- und Lautstärke-Tasten |
| Netzwerk | Speedtest | Download, Upload und Ping (Cloudflare), Verlauf |
| | Host-Monitor | Erreichbarkeit von NAS, Servern, Druckern (Ping, TCP-Port, HTTP) mit Verlauf; bei Ausfall grosser Hinweis auf dem Bildschirm und Mail |
| | Kiosk-Status | Laufzeit, Temperatur, Auslastung und QR-Code zur Fernsteuerung |
| | Lifetime | Ein Punkt kreist ruhig, solange Kiosk und Dienst laufen – steht er still, hängt etwas |
| Sensorik & KI | Gesichtserkennung | Kamerabild mit lokaler Gesichtserkennung (face-api.js), auch nur als Personenzahl |
| | Ruhemodus | schaltet den Bildschirm aus, wenn niemand da ist, und weckt ihn per Kamera |
| | KI-Assistent | Sprach- und Textassistent mit OpenAI oder lokal mit Ollama / LM Studio |
| lagra | lagra Übersicht | Server, Aufgaben, Virenscanner, DAM und mehr – nur Zahlen und Zustände |
| | lagra Aufgaben | Hintergrundaufgaben: letzter Lauf, Fortschritt, nächster Lauf |
| | lagra: Neu im DAM | Diashow oder Raster der zuletzt aufgenommenen Bilder |
| planbar | planbar Aufgaben | Arbeitsliste ausgewählter Personen, nach Fälligkeit gruppiert, optional abhaken – auch aus mehreren Unternehmen (ein API-Schlüssel pro Unternehmen) |
| | planbar Projekte | Fortschritt, Termin, Stunden, Meilenstein und Beteiligte |
| | planbar News | Beiträge der planbar-Infowand |
| | planbar Zeit | erfasste Stunden von heute und dieser Woche, laufender Timer |

Einrichtung der Datenquellen: [API_SETUP.md](API_SETUP.md).

### Fernsteuerung

Web-Oberfläche für Handy, Tablet und PC im selben Netzwerk: `http://<IP-des-Kiosks>:7380`, Anmeldung mit dem
PIN, den der Kiosk unter **Bearbeiten → Fernsteuerung** anzeigt – dort steht auch die Adresse als QR-Code.

- **Übersicht** – Zustand des Geräts, Schnellaktionen (neu laden, identifizieren, Bildschirm aus/an,
  Bearbeiten-Modus, Design), Live-Vorschau des Bildschirms
- **Layout** – Widgets hinzufügen, verschieben, skalieren, duplizieren, entfernen
- **Widgets** – Einstellungen jedes Widgets, dasselbe Formular wie am Kiosk
- **Inhalte** – Pinnwand und Aufgaben pflegen
- **lagra**, **planbar** – Verbindung einrichten, testen und Daten in der Vorschau prüfen
- **Kiosk** – Name, Bedienung am Kiosk, Bildschirmzeiten, Design, Raster
- **System** – Geräteinfo, Update mit Fortschritt, Neustart, PIN ändern, Sicherung herunterladen und
  wiederherstellen

Anleitung: [docs/FERNSTEUERUNG.md](docs/FERNSTEUERUNG.md).

## Schnellstart (Entwicklung)

Voraussetzungen:

- Node.js 22.12 oder neuer (20.19 geht auch; Vite 8 verlangt eine dieser Versionen)
- Rust 1.90 oder neuer über [rustup](https://rustup.rs)
- unter Ubuntu/Debian die Build-Abhängigkeiten von Tauri:

  ```bash
  sudo apt install build-essential pkg-config curl git libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libxdo-dev
  ```

```bash
git clone https://github.com/Zenovs/SlateDesk.git
cd SlateDesk
npm ci

npm run dev       # nur die Oberfläche im Browser (Vite, http://localhost:5173)
npx tauri dev     # die ganze App: Rust-Backend, Kiosk-Fenster und Fernsteuerung auf Port 7380
```

- `npm run dev` startet nur Vite. Der Kiosk unter `http://localhost:5173` speichert dann im localStorage des
  Browsers; Widgets, die das Rust-Backend brauchen (Wetter, Kalender, Netzwerk, lagra, planbar …), melden
  «Nur im Kiosk verfügbar». Die Fernsteuerung unter `http://localhost:5173/remote.html` leitet `/api` an
  `127.0.0.1:7380` weiter und braucht deshalb eine laufende App (`npx tauri dev`).
- `npx tauri dev` startet Vite selbst (`beforeDevCommand`) und öffnet das Kiosk-Fenster im Vollbild und
  immer im Vordergrund. Im Dev-Build lässt es sich mit Alt+F4 schliessen, im Release-Build nicht. Die App
  legt ihren Zustand wie im Betrieb unter `~/.config/com.slatedesk.app/` an und startet die Fernsteuerung
  auf Port 7380 (abschalten mit `SLATEDESK_REMOTE_DISABLED=1 npx tauri dev`). Es läuft immer nur eine
  Instanz – ein zweiter Start holt das vorhandene Fenster nach vorne.
- Ein Skript `npm run tauri` gibt es nicht; die Tauri-CLI ist als Abhängigkeit installiert und läuft über `npx tauri`.

### Prüfen

```bash
npm test            # Unit-Tests (Vitest)
npm run lint        # ESLint
npm run build       # TypeScript-Prüfung und Produktions-Build der Oberfläche (dist/)
cd src-tauri && cargo test && cargo clippy
```

`src/widgets/catalog.test.ts` prüft die Widget-Manifeste (Icons, Einstellungen, Geheimnis-Felder) –
Details in [docs/WIDGET_DEVELOPMENT.md](docs/WIDGET_DEVELOPMENT.md).

## Konfiguration

Es gibt keine `.env`-Datei und keine API-Schlüssel zur Build-Zeit. Eingestellt wird alles zur Laufzeit:
Widgets in ihren Einstellungen (am Kiosk über das Zahnrad im Bearbeiten-Modus oder in der Fernsteuerung
unter **Widgets**), lagra und planbar auf ihren eigenen Seiten der Fernsteuerung.

| Datei (im Home des Kiosk-Benutzers) | Inhalt |
|---|---|
| `~/.config/com.slatedesk.app/state.json` | Layout, Widget-Einstellungen, Design, Kiosk-Einstellungen, lagra, planbar, Aufgaben, Pinnwand (Rechte 0600, vorherige Fassung als `state.json.bak`) |
| `~/.config/com.slatedesk.app/remote.json` | Fernsteuerung: `enabled`, `port`, `pin` (Rechte 0600, nie über HTTP lesbar) |

Umgebungsvariablen der App (im Betrieb per systemd-Drop-in, siehe BETRIEB.md):

| Variable | Wirkung |
|---|---|
| `SLATEDESK_REMOTE_PORT` | Port der Fernsteuerung (Standard 7380) |
| `SLATEDESK_REMOTE_DISABLED=1` | Fernsteuerung abschalten |
| `SLATEDESK_REMOTE_HOSTS` | Zusätzliche Host-Namen der Fernsteuerung (kommagetrennt), z. B. ein DNS-Name mit öffentlicher Endung |
| `SLATEDESK_HOME` | Git-Checkout für Update-Prüfung und -Start (Standard `~/SlateDesk`) |
| `WEBKIT_DISABLE_DMABUF_RENDERER=1` | Abhilfe bei weissem Fenster mit manchen Grafiktreibern |

## Sicherheit

- **PIN:** Beim ersten Start erzeugt die App einen zufälligen 6-stelligen PIN; ändern lässt er sich in der
  Fernsteuerung unter **System** (6 bis 12 Ziffern). Nach 5 Fehlversuchen innert 5 Minuten sperrt die
  Anmeldung für diese IP-Adresse; 20 Fehlversuche aller Geräte zusammen sperren jede PIN-Anmeldung für
  15 Minuten (bei Wiederholung länger). Eine Anmeldung gilt 30 Tage, endet aber mit jedem Neustart der App
  (täglich 04:00, nach Updates); eine PIN-Änderung meldet alle anderen Browser ab.
- **Nur im LAN:** Die Fernsteuerung spricht unverschlüsseltes HTTP und lauscht auf allen Netzwerkschnittstellen.
  Kein Port-Forwarding im Router einrichten; von ausserhalb nur über VPN. Mit ufw den Port auf das
  Büro-Subnetz beschränken (`setup.sh --ufw` oder
  `sudo ufw allow from 192.168.19.0/24 to any port 7380 proto tcp`).
- **Zugangsdaten:** Felder, deren Name auf `apiKey`, `token`, `password` oder `secret` endet, gibt das Backend
  über HTTP nie heraus – die Fernsteuerung und der Export zeigen nur «gesetzt». Wird über die Fernsteuerung
  eine Adresse (`…url`, `…host`) geändert, löscht der Kiosk die Geheimnisse daneben und darunter (bei planbar
  die Schlüssel aller Unternehmen), damit niemand ein Token auf einen fremden Server umleiten kann. Das
  lagra-Token und die planbar-Schlüssel verlassen das Rust-Backend nie; der Browser fragt lagra und planbar
  nur über den Kiosk ab.
- **Nicht geheim:** ICS-Links von Kalendern und andere Adressen gelten nicht als Geheimnis und stehen im
  Klartext in der Fernsteuerung und im Export.
- **Webschutz:** Änderungen über die API verlangen den Header `X-SlateDesk: 1`; das Sitzungs-Cookie ist
  `HttpOnly` und `SameSite=Strict`; die Web-Oberfläche läuft mit strikter Content-Security-Policy und darf
  nicht eingebettet werden. Ohne Anmeldung liefert die API nur den Health-Check (`/api/health`, mit
  Versionsnummer) und den Namen des Kiosks.
- **Kiosk:** Das Fenster lässt sich im Release-Build nicht schliessen. Die Webansicht erhält nur Kamera und
  Mikrofon (Gesichtserkennung, Ruhemodus, KI-Assistent); alle anderen Berechtigungen werden abgelehnt.
- **Besucherbereich:** lagra-Widgets zeigen standardmässig nur Zahlen und Zustände, der Kalender kann Termine
  als «Besetzt» anonymisieren, der Kiosk-Status zeigt den PIN nie.

## Projektstruktur

```
SlateDesk/
├── index.html, remote.html   Einstiegsseiten: Kiosk und Fernsteuerung
├── src/
│   ├── App.tsx, main.tsx     Kiosk-Oberfläche
│   ├── components/           Kiosk-Shell: Dashboard, obere Leiste, Widget-Rahmen, Dialoge
│   │   └── settings/         SettingsForm (Einstellungen für Kiosk und Fernsteuerung), Icons, Auswahllisten
│   ├── widgets/              Widgets: <Name>Widget.tsx, manifests/, styles/, shared/, catalog.ts, index.ts
│   ├── remote/               Fernsteuerung: Seiten, UI-Bausteine, Sitzung, API-Client
│   ├── state/                gemeinsamer Zustand: Typen, Standardwerte, Operationen, Transport (Tauri, HTTP, localStorage)
│   ├── hooks/                useWidgetSettings, usePolling, useElementSize, Bildschirmzeiten, Mauszeiger
│   ├── lagra/, planbar/      Clients und Typen der Integrationen
│   ├── services/             Kamera und Gesichtserkennung
│   ├── store/                Kiosk-Stores über dem gemeinsamen Zustand (Bearbeiten-Modus, Design)
│   ├── styles/               Design-Tokens und globale Styles
│   ├── types/                Widget-, Einstellungs- und Raster-Typen
│   └── utils/                backend.ts (Tauri-Befehle), Widget-Registry, Event-Bus
├── src-tauri/src/            Rust-Backend
│   ├── state.rs              state.json, Operationen, Schwärzen von Geheimnissen
│   ├── web.rs, remote.rs     Webserver der Fernsteuerung, PIN, Sitzungen
│   ├── http.rs, feeds.rs, calendar.rs, net.rs, ollama.rs   externe Abfragen der Widgets
│   ├── lagra.rs, planbar.rs  Integrationen (Token bzw. Schlüssel bleiben im Backend)
│   └── display.rs, system.rs, update.rs, qr.rs
├── install.sh                Installation in einem Schritt (curl … | sudo bash)
├── scripts/                  setup.sh, auto-update.sh, uninstall.sh, systemd/ (User-Dienste und Timer)
├── public/models/            Modell der Gesichtserkennung
└── docs/                     BETRIEB.md, FERNSTEUERUNG.md, WIDGET_DEVELOPMENT.md
```

## Dokumentation

| Dokument | Inhalt |
|---|---|
| [docs/BETRIEB.md](docs/BETRIEB.md) | Installation, Migration, Updates, Logs, Sicherung, Fehlersuche |
| [docs/FERNSTEUERUNG.md](docs/FERNSTEUERUNG.md) | Anleitung zur Web-Oberfläche |
| [API_SETUP.md](API_SETUP.md) | Datenquellen und Integrationen einrichten (Wetter, Feeds, Kalender, Volumio, KI, lagra, planbar) |
| [docs/WIDGET_DEVELOPMENT.md](docs/WIDGET_DEVELOPMENT.md) | eigene Widgets entwickeln |

## Lizenz

Noch nicht festgelegt.
