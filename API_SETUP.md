# SlateDesk – API-Konfiguration

Diese Anleitung erklärt, wie du die API-Keys für die Wetter- und Nachrichten-Widgets konfigurierst.

> **Hinweis:** SlateDesk funktioniert auch ohne API-Keys – in diesem Fall werden Mock-Daten angezeigt.

---

## 1. OpenWeatherMap API Key (Wetter-Widget)

### Schritt 1: Konto erstellen
1. Gehe zu [openweathermap.org](https://openweathermap.org/)
2. Klicke auf **Sign Up** und erstelle ein kostenloses Konto
3. Bestätige deine E-Mail-Adresse

### Schritt 2: API Key generieren
1. Nach dem Login, gehe zu **API Keys**: [https://home.openweathermap.org/api_keys](https://home.openweathermap.org/api_keys)
2. Dein Standard-API-Key wird automatisch erstellt
3. Kopiere den Key (z.B. `a1b2c3d4e5f6g7h8i9j0...`)

> ⏳ **Wichtig:** Ein neuer API-Key kann bis zu **2 Stunden** brauchen, bis er aktiviert ist.

### Kosten
- **Free Plan:** 1'000 API-Aufrufe/Tag, 60 Aufrufe/Minute – für SlateDesk ausreichend

---

## 2. NewsAPI Key (Nachrichten-Widget)

### Schritt 1: Konto erstellen
1. Gehe zu [newsapi.org](https://newsapi.org/)
2. Klicke auf **Get API Key**
3. Fülle das Registrierungsformular aus

### Schritt 2: API Key kopieren
1. Nach der Registrierung wird dein API-Key sofort angezeigt
2. Du findest ihn auch unter [https://newsapi.org/account](https://newsapi.org/account)
3. Kopiere den Key (z.B. `abcdef1234567890abcdef12...`)

### Kosten
- **Developer Plan (kostenlos):** 100 Anfragen/Tag – für SlateDesk ausreichend

> ⚠️ **Hinweis:** Der kostenlose NewsAPI-Plan erlaubt nur Anfragen von `localhost`. Im Produktionsbetrieb (Tauri-App) funktioniert es, da die Anfragen vom lokalen Rechner kommen.

---

## 3. API-Keys in SlateDesk konfigurieren

### Option A: `.env`-Datei (empfohlen)

1. Kopiere die Beispiel-Datei:
   ```bash
   cd /pfad/zu/slatedesk
   cp .env.example .env
   ```

2. Öffne `.env` in einem Texteditor:
   ```bash
   nano .env
   ```

3. Trage deine API-Keys ein:
   ```env
   VITE_OPENWEATHERMAP_API_KEY=dein_openweathermap_key_hier
   VITE_WEATHER_CITY=Zurich,CH
   VITE_NEWSAPI_KEY=dein_newsapi_key_hier
   VITE_NEWS_COUNTRY=ch
   ```

4. Speichere die Datei (`Ctrl+O`, dann `Ctrl+X` in nano)

### Option B: Umgebungsvariablen direkt setzen

```bash
export VITE_OPENWEATHERMAP_API_KEY=dein_key
export VITE_NEWSAPI_KEY=dein_key
```

---

## 4. App neu starten

Nach der Konfiguration der API-Keys muss die App neu gestartet werden:

### Entwicklungsmodus
```bash
npm run dev
```

### Produktions-Build
```bash
npm run build
# oder für Tauri:
npx tauri build
```

---

## 5. Konfigurationsoptionen

| Variable | Beschreibung | Standard |
|---|---|---|
| `VITE_OPENWEATHERMAP_API_KEY` | OpenWeatherMap API Key | _(leer = Mock-Daten)_ |
| `VITE_WEATHER_CITY` | Stadt für Wetter | `Zurich,CH` |
| `VITE_NEWSAPI_KEY` | NewsAPI Key | _(leer = Mock-Daten)_ |
| `VITE_NEWS_COUNTRY` | Ländercode für Nachrichten | `ch` |

### Unterstützte Ländercodes für Nachrichten
`ae ar at au be bg br ca ch cn co cu cz de eg fr gb gr hk hu id ie il in it jp kr lt lv ma mx my ng nl no nz ph pl pt ro rs ru sa se sg si sk th tr tw ua us ve za`

### Stadt-Format für Wetter
- `Zurich,CH` – Stadt, Ländercode
- `Berlin,DE` – Stadt, Ländercode
- `Vienna,AT` – Stadt, Ländercode

---

## 6. Fehlerbehebung

### Wetter-Widget zeigt "🔴 Offline (Mock-Daten)"
- API-Key nicht konfiguriert → Siehe Schritt 3
- API-Key noch nicht aktiviert → Bis zu 2 Stunden warten
- Überprüfe den Key in der `.env`-Datei

### Nachrichten-Widget zeigt "🔴 Offline (Mock-Daten)"
- API-Key nicht konfiguriert → Siehe Schritt 3
- Tägliches Limit erreicht (100 Anfragen) → Am nächsten Tag erneut versuchen

### Netzwerkfehler
- Internetverbindung prüfen
- Firewall-Einstellungen prüfen (Ports 80/443 müssen offen sein)

---

## 7. Sicherheit

- API-Keys werden **nur lokal** in der `.env`-Datei gespeichert
- Die `.env`-Datei ist in `.gitignore` eingetragen und wird **nicht** auf GitHub hochgeladen
- API-Keys werden zur Build-Zeit in die App eingebettet (Vite-Standard)
- Für maximale Sicherheit: Verwende separate API-Keys für SlateDesk
