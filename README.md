# SlateDesk

> Minimalistisches Smart Office Dashboard für Ubuntu – gebaut mit Tauri + React.

![Phase](https://img.shields.io/badge/Phase-2a%20APIs-blue)
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

### Phase 2a Features (NEU)

- ✅ **Wetter-Widget Live** – OpenWeatherMap API-Integration mit Echtzeit-Wetterdaten
- ✅ **Nachrichten-Widget** – NewsAPI-Integration mit Top-Schlagzeilen
- ✅ **API-Konfigurationssystem** – Sichere Verwaltung von API-Keys über `.env`-Datei
- ✅ **Fallback auf Mock-Daten** – App funktioniert auch ohne API-Keys
- ✅ **Error-Handling** – Netzwerkfehler, API-Fehler und fehlende Keys werden abgefangen
- ✅ **Status-Anzeige** – Widgets zeigen Live/Offline-Status an

## 🚀 Installation & Setup

### Voraussetzungen

- Node.js >= 18
- Rust & Cargo (via [rustup](https://rustup.rs))
- Linux-Abhängigkeiten:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget \
  libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
  libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
```

### Projekt starten

```bash
git clone https://github.com/Zenovs/SlateDesk.git
cd SlateDesk
npm install
npm run tauri dev
```

### API-Keys konfigurieren (optional)

Für Live-Wetterdaten und Nachrichten, kopiere die Beispiel-Konfiguration und trage deine API-Keys ein:

```bash
cp .env.example .env
nano .env
```

👉 **Ausführliche Anleitung:** [API_SETUP.md](./API_SETUP.md)

> Ohne API-Keys funktioniert die App mit Mock-Daten.

### Nur Frontend (ohne Tauri)

```bash
npm run dev
```

Öffne `http://localhost:5173` im Browser.

### Produktions-Build

```bash
npm run tauri build
```

Erstellt `.deb` und `.AppImage` in `src-tauri/target/release/bundle/`.

## 📁 Projektstruktur

```
slatedesk/
├── src/
│   ├── components/     # UI-Komponenten (TopBar, Dashboard, WidgetWrapper)
│   ├── widgets/        # Widget-Implementierungen
│   ├── styles/         # CSS (Design Tokens, Global, Widgets)
│   ├── store/          # Zustand State Management (Theme, Layout)
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
| **4** | Gesichtserkennung, Kiosk-Modus, .deb Installer |
| **5** | Widget-Marketplace, erweiterte Sicherheit |

## 🛡️ Sicherheitskonzept

- **Zero Trust:** Neue Widgets sind standardmässig deaktiviert
- **Sandbox:** Widgets haben keinen direkten Systemzugriff
- **Deklarative Permissions:** Im Widget-Manifest definiert
- **Lokale Datenhaltung:** Keine Cloud-Abhängigkeit

## 📝 Lizenz

Open Source – Details folgen.
