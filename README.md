# SlateDesk

> Minimalistisches Smart Office Dashboard für Ubuntu – gebaut mit Tauri + React.

![Phase](https://img.shields.io/badge/Phase-4a%20Widget--Settings-blue)
![License](https://img.shields.io/badge/License-Open%20Source-green)
![Platform](https://img.shields.io/badge/Platform-Ubuntu-orange)

## 📊 Übersicht

SlateDesk ist ein erweiterbares Desktop-Dashboard für den Office-Einsatz. Es läuft als native Tauri-App auf Ubuntu und bietet ein Widget-basiertes Grid-Layout mit Dark/Light Theme.

### Phase 1 Features

- ✅ **Grid-Layout Dashboard** – Widgets per Drag & Drop positionieren und skalieren
- ✅ **Dark/Light Theme** – Zwei Themes inspiriert von modernem Dashboard-Design
- ✅ **Kalender-Widget** – Office 365 Termine (Mock-Daten)
- ✅ **Uhr-Widget** – Aktuelle Zeit und Datum
- ✅ **Wetter-Widget** – Wettervorhersage (Mock-Daten)
- ✅ **Nachrichten-Widget** – Ungelesene Nachrichten (Mock-Daten)
- ✅ **Aufgaben-Widget** – Todo-Liste mit Kategorien
- ✅ **Widget-Architektur** – Einfach erweiterbar mit Registry-Pattern
- ✅ **Event Bus** – Inter-Widget Kommunikation
- ✅ **Layout Persistenz** – Widget-Positionen werden in localStorage gespeichert

### Widget-Settings-System (Erweitert)

- ✅ **Generisches Settings-System** – Jedes Widget kann eigene Einstellungen haben
- ✅ **Settings-Button** – Zahnrad-Icon im Widget-Header (nur bei Widgets mit Settings)
- ✅ **Erweiterter Settings-Dialog** – 600px Modal mit Scroll, Sektionen und Validierung
- ✅ **Persistente Settings** – Widget-Einstellungen in localStorage (Widget-ID basiert)
- ✅ **Event-basiert** – WidgetWrapper kommuniziert über EventBus mit Widgets
- ✅ **Uhr-Widget Settings** – Zeitformat (12h/24h), Zeitzone, Sekunden, Datumsformat
- ✅ **Kalender-Widget Settings** – Quelle, Zeitbereich, max. Termine
- ✅ **Wetter-Widget Settings** – Standort, Temperatur-Einheit (°C/°F), API-Key, Update-Intervall
- ✅ **News-Widget Settings** – Kategorie, Land, Sprache, Artikelanzahl, API-Key
- ✅ **Aufgaben-Widget Settings** – Sortierung, Filter (Alle/Offen/Erledigt), Quelle
- ✅ **Kamera-Widget Settings** – Verbesserte Permission-Anleitung, Schritt-für-Schritt Guide
- ✅ **Sofortige Aktualisierung** – Widgets reagieren sofort auf Settings-Änderungen

### Gesichtserkennung (verbessert)

- ✅ **Kamera-Widget** – Live-Kamera-Feed via WebRTC (getUserMedia)
- ✅ **Gesichtserkennung** – Browser-basiert mit face-api.js (TinyFaceDetector)
- ✅ **Kamera-Auswahl** – Dropdown aller verfügbaren Kameras
- ✅ **Kamera starten/stoppen** – Button im Widget und in den Einstellungen
- ✅ **Gesichtserkennung an/aus** – Toggle in den Einstellungen
- ✅ **Erkennungs-Schwellenwert** – Slider für Score Threshold
- ✅ **Auto-Start** – Kamera kann beim Widget-Laden automatisch starten
- ✅ **Verbesserte Permission-UI** – Schritt-für-Schritt Anleitung, Info-Boxen, Auto-Retry
- ✅ **Error-Handling** – Klare Fehlermeldungen mit Tipps zur Fehlerbehebung
- ✅ **Status-Anzeige** – "Gesicht erkannt ✅" / "Kein Gesicht ❌" + Anzahl
- ✅ **Bounding Boxes** – Visuelle Markierung erkannter Gesichter mit Konfidenz
- ✅ **Privatsphäre** – 100% lokale Verarbeitung, keine Daten werden übertragen

### Phase 2a Features

- ✅ **Wetter-Widget Live** – OpenWeatherMap API-Integration mit Echtzeit-Wetterdaten
- ✅ **Nachrichten-Widget** – NewsAPI-Integration mit Top-Schlagzeilen
- ✅ **API-Konfigurationssystem** – Sichere Verwaltung von API-Keys über `.env`-Datei
- ✅ **Fallback auf Mock-Daten** – App funktioniert auch ohne API-Keys
- ✅ **Error-Handling** – Netzwerkfehler, API-Fehler und fehlende Keys werden abgefangen
- ✅ **Status-Anzeige** – Widgets zeigen Live/Offline-Status an

## 🚀 Installation (Ubuntu / Kiosk-Gerät)

### Schritt 1 – Voraussetzungen installieren

```bash
sudo apt update
sudo apt install -y git curl build-essential libwebkit2gtk-4.1-dev \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

Node.js installieren (falls noch nicht vorhanden):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Rust installieren (falls noch nicht vorhanden):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

### Schritt 2 – Nutzer anlegen & Repo klonen

```bash
sudo useradd -m -s /bin/bash slatedesk
sudo -u slatedesk git clone https://github.com/Zenovs/SlateDesk.git /home/slatedesk/SlateDesk
```

### Schritt 3 – Abhängigkeiten & Build

```bash
cd /home/slatedesk/SlateDesk
sudo -u slatedesk npm install
sudo -u slatedesk npx tauri build
```

> Der Build dauert **10–20 Minuten** (Rust-Kompilierung).

### Schritt 4 – App installieren

```bash
sudo dpkg -i /home/slatedesk/SlateDesk/src-tauri/target/release/bundle/deb/*.deb
```

### Schritt 5 – Autostart beim Boot einrichten

```bash
sudo mkdir -p /etc/systemd/system
sudo tee /etc/systemd/system/slatedesk.service > /dev/null << 'EOF'
[Unit]
Description=SlateDesk Dashboard
After=graphical.target

[Service]
Type=simple
User=slatedesk
Environment=DISPLAY=:0
ExecStart=/usr/bin/slate-desk
Restart=always
RestartSec=5

[Install]
WantedBy=graphical.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable slatedesk.service
sudo systemctl start slatedesk.service
```

### Schritt 6 – Auto-Update-System einrichten

```bash
sudo bash /home/slatedesk/SlateDesk/scripts/setup-auto-update.sh
```

---

### Manuelles Update (sofort, ohne zu warten)

```bash
bash /home/slatedesk/SlateDesk/scripts/auto-update.sh
```

Fortschritt verfolgen:

```bash
tail -f /home/slatedesk/slatedesk-update.log
```

---

### Entwicklung (macOS / lokal)

```bash
git clone https://github.com/Zenovs/SlateDesk.git
cd SlateDesk
npm install
npx tauri dev
```

### API-Keys konfigurieren (optional)

```bash
cp .env.example .env
nano .env
```

👉 **Ausführliche Anleitung:** [API_SETUP.md](./API_SETUP.md)

> Ohne API-Keys funktioniert die App mit Mock-Daten.

## 📁 Projektstruktur

```
slatedesk/
├── src/
│   ├── components/     # UI-Komponenten (TopBar, Dashboard, WidgetWrapper)
│   ├── widgets/        # Widget-Implementierungen
│   ├── styles/         # CSS (Design Tokens, Global, Widgets)
│   ├── store/          # Zustand State Management (Theme, Layout, Widget Settings)
│   ├── types/          # TypeScript Type Definitions
│   ├── utils/          # Widget Registry, Event Bus, Mock Data
│   ├── App.tsx         # Haupt-App Komponente
│   └── main.tsx        # Entry Point
├── src-tauri/          # Tauri (Rust) Backend
└── public/             # Statische Assets
```

## 🧩 Neues Widget erstellen

1. **Erstelle eine Datei** in `src/widgets/MeinWidget.tsx`:

```tsx
import { WidgetProps, WidgetDefinition } from '../types/widget';

const MeinWidget: React.FC<WidgetProps> = ({ instanceId, width, height }) => {
  return <div>Mein Widget Inhalt</div>;
};

export const meinWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'mein-widget',
    name: 'Mein Widget',
    description: 'Beschreibung',
    version: '1.0.0',
    author: 'Dein Name',
    minWidth: 2,
    minHeight: 2,
    defaultWidth: 4,
    defaultHeight: 3,
    permissions: [],
  },
  component: MeinWidget,
};
```

2. **Registriere es** in `src/widgets/index.ts`:

```tsx
import { meinWidgetDef } from './MeinWidget';
registerWidget(meinWidgetDef);
```

3. Fertig! Das Widget erscheint im Widget-Picker.

### Widget mit Einstellungen erstellen

Um ein Widget mit Settings zu versehen:

1. **Setze `hasSettings: true`** im Manifest:
```tsx
manifest: {
  ...
  hasSettings: true,
},
```

2. **Importiere den Settings-Store und EventBus:**
```tsx
import { useWidgetSettingsStore } from '../store/widgetSettingsStore';
import { eventBus } from '../utils/eventBus';
```

3. **Höre auf das Settings-Event im Widget:**
```tsx
useEffect(() => {
  const handler = () => setSettingsOpen(true);
  eventBus.on(`widget:openSettings:${instanceId}`, handler);
  return () => eventBus.off(`widget:openSettings:${instanceId}`, handler);
}, [instanceId]);
```

4. **Verwende den WidgetSettingsDialog:**
```tsx
<WidgetSettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Mein Widget – Einstellungen">
  {/* Settings-Formular */}
</WidgetSettingsDialog>
```

Siehe `CameraWidget.tsx` als Referenz-Implementierung.

## 🔄 Auto-Update

SlateDesk verfügt über ein vollautomatisches Update-System:

- **Täglicher Check** um 01:00 Uhr per Cronjob
- **Boot-Check** falls der Rechner um 01:00 aus war (systemd Service)
- **Automatischer Rollback** bei Fehlern mit Backup
- **Kein manueller Eingriff** nötig (sudo ohne Passwort für dpkg)

### Setup

```bash
sudo bash scripts/setup-auto-update.sh
```

📖 Vollständige Dokumentation: [AUTO_UPDATE.md](AUTO_UPDATE.md)

## 🎨 Design System

- **Spacing:** 8px-Raster
- **Border Radius:** 8px (Standard)
- **Animationen:** 150–250ms ease
- **Font:** Lato / Roboto
- **Dark Theme:** Dunkles Grau + Orange Akzente
- **Light Theme:** Türkis/Teal + Graue Karten

## 📍 Roadmap

| Phase | Features |
|-------|----------|
| **1 (MVP)** ✅ | Grid-Layout, Themes, Kalender-Widget (Mock), Widget-Architektur |
| **2a** ✅ | Wetter-API (OpenWeatherMap), News-API (NewsAPI), API-Key-Verwaltung |
| **2b** | Office 365 OAuth, Live-Kalender, Synology NAS Widget |
| **3** | Lokale AI (Mistral/Phi-3), Sprachsteuerung |
| **4a** ✅ | Gesichtserkennung Phase 1 (Face Detection, Kamera-Widget) |
| **4b** | Gesichtserkennung Phase 2 (Face Recognition), Kiosk-Modus, .deb Installer |
| **5** | Widget-Marketplace, erweiterte Sicherheit |

## 🛡️ Sicherheitskonzept

- **Zero Trust:** Neue Widgets sind standardmässig deaktiviert
- **Sandbox:** Widgets haben keinen direkten Systemzugriff
- **Deklarative Permissions:** Im Widget-Manifest definiert
- **Lokale Datenhaltung:** Keine Cloud-Abhängigkeit

## 📝 Lizenz

Open Source – Details folgen.
