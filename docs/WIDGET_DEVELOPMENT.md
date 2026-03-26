# Widget-Entwicklung für SlateDesk

Dieses Dokument beschreibt, wie neue Widgets für SlateDesk erstellt werden.

## Architektur

Jedes Widget besteht aus:
1. **Manifest** – Metadaten (ID, Name, Grössen, Permissions)
2. **Component** – React-Komponente für die Darstellung

## WidgetProps

Jede Widget-Komponente erhält folgende Props:

```typescript
interface WidgetProps {
  instanceId: string;  // Eindeutige Instanz-ID
  width: number;       // Aktuelle Breite in Grid-Einheiten
  height: number;      // Aktuelle Höhe in Grid-Einheiten
}
```

## Event Bus

Widgets können über den Event Bus kommunizieren:

```typescript
import { eventBus } from '../utils/eventBus';

// Event senden
eventBus.emit('mein-widget:daten-aktualisiert', { data: ... });

// Event empfangen
eventBus.on('kalender:termin-hinzugefuegt', (data) => {
  // Reagieren...
});
```

## Manifest-Felder

| Feld | Typ | Beschreibung |
|------|-----|-------------|
| `id` | string | Eindeutige Widget-ID |
| `name` | string | Anzeigename |
| `description` | string | Kurzbeschreibung |
| `version` | string | Semver |
| `author` | string | Autor |
| `minWidth` | number | Minimale Breite (Grid-Einheiten) |
| `minHeight` | number | Minimale Höhe (Grid-Einheiten) |
| `defaultWidth` | number | Standard-Breite |
| `defaultHeight` | number | Standard-Höhe |
| `permissions` | string[] | Benötigte Berechtigungen |
| `refreshInterval` | number? | Auto-Refresh in Sekunden |

## Best Practices

- Widgets sollten eigenständig funktionieren
- Fehler müssen abgefangen werden (ErrorBoundary ist integriert)
- Daten lokal cachen wo möglich
- Responsives Design innerhalb der Widget-Grenzen
- CSS-Variablen aus dem Theme-System verwenden
