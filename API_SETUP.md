# SlateDesk – Datenquellen und Integrationen

SlateDesk braucht **keine API-Schlüssel zur Build-Zeit** und keine `.env`-Datei. Jede Datenquelle wird zur
Laufzeit eingerichtet:

- **Widget-Einstellungen** – am Kiosk im Bearbeiten-Modus über das Zahnrad am Widget oder in der
  Fernsteuerung unter **Widgets** (siehe [docs/FERNSTEUERUNG.md](docs/FERNSTEUERUNG.md)).
- **lagra und planbar** – auf ihren eigenen Seiten der Fernsteuerung; die Verbindung gilt für alle Widgets
  dieser Integration.

Fast alle Abfragen laufen über das Rust-Backend der App (keine CORS-Probleme, Zugangsdaten bleiben im
Backend). Einzige Ausnahme: der KI-Assistent spricht OpenAI direkt aus der Kiosk-Ansicht an.

| Quelle | Widget | Schlüssel nötig | Einrichten unter |
|---|---|---|---|
| Open-Meteo / MeteoSwiss | Wetter | nein | Widget-Einstellungen |
| RSS-/Atom-Feeds | Nachrichten | nein | Widget-Einstellungen |
| ICS-Kalender (Office 365, Google, iCloud) | Kalender | nein, aber geheimer Link | Widget-Einstellungen |
| Volumio | Volumio | nein | Widget-Einstellungen |
| eigene Geräte im LAN | Host-Monitor | nein | Widget-Einstellungen |
| Cloudflare Speedtest | Speedtest | nein | Widget-Einstellungen |
| OpenAI oder Ollama / LM Studio | KI-Assistent | OpenAI: ja; lokal: nein | Widget-Einstellungen (+ Modell am Kiosk) |
| lagra | lagra Übersicht, lagra Aufgaben, lagra: Neu im DAM | Token | Fernsteuerung → lagra |
| planbar | planbar Aufgaben, Projekte, News, Zeit | API-Schlüssel | Fernsteuerung → planbar |

**Zugangsdaten** (Felder, deren Name auf `apiKey`, `token`, `password` oder `secret` endet) speichert der
Kiosk in `~/.config/com.slatedesk.app/state.json` (Rechte 0600). Über die Fernsteuerung und im Export
erscheinen sie nur als «gesetzt». Wird über die Fernsteuerung die Adresse daneben geändert, löscht der Kiosk
den gespeicherten Zugang – deshalb immer **zuerst die Adresse, dann den Zugang** eintragen.

**Firewall:** Der Kiosk braucht ausgehend HTTPS (Port 443) zu den genannten Diensten; für Volumio, den
Host-Monitor und lokale KI-Server zusätzlich die jeweiligen Ports im LAN.

---

## Wetter (Open-Meteo, MeteoSwiss)

Kein Konto, kein Schlüssel. Das Widget nutzt die freie API von [Open-Meteo](https://open-meteo.com):
Vorhersage (`api.open-meteo.com`), Ortssuche (`geocoding-api.open-meteo.com`) und – falls eingeschaltet –
Luftqualität und Pollen (`air-quality-api.open-meteo.com`).

| Einstellung | Hinweis |
|---|---|
| **Ort** | Ortsname oder Postleitzahl, z. B. «Sion», «Zürich», «3930». Mehrdeutige Namen ergänzen («Freiburg, Deutschland»). **Leer** = Standort einmalig über die öffentliche IP-Adresse bestimmen (ipapi.co, ersatzweise ipwho.is). Das Ergebnis wird gespeichert und erst bei einem neuen Ort erneut gesucht. |
| **Wettermodell** | *MeteoSwiss ICON-CH2* (2 km Raster, Alpenraum, 5 Tage) – spätere Tage, UV-Index und Orte ausserhalb ergänzt Open-Meteo automatisch. *Automatisch* nimmt das beste Modell von Open-Meteo. |
| **Tage**, **Stundenverlauf**, **Details**, **Luftqualität und Pollen** | Umfang der Anzeige; Luftqualität und Pollen gibt es nur in Europa. |
| **Aktualisieren alle** | 10 Minuten bis 2 Stunden (Standard 30 Minuten). |

Die freie Open-Meteo-API ist für nicht-kommerzielle Nutzung mit bis zu 10'000 Abfragen pro Tag gedacht; es
gelten die [Nutzungsbedingungen](https://open-meteo.com/en/terms). Mehrere Wetter-Widgets und kurze
Intervalle zählen entsprechend mehrfach.

## Nachrichten (RSS- und Atom-Feeds)

Kein Schlüssel. Das Backend lädt die Feeds, führt sie zusammen, entfernt Doppelte und sortiert nach Datum.

- **Feeds:** Name, Feed-Adresse, Aktiv. Voreingestellt sind *SRF News*
  (`https://www.srf.ch/news/bnf/rss/1646`) und *NZZ Neueste* (`https://www.nzz.ch/recent.rss`). Weitere
  Beispiele: 20 Minuten (`https://partner-feeds.20min.ch/rss/20minuten`), watson
  (`https://www.watson.ch/api/1.0/rss/index.xml`), SRF Schweiz (`https://www.srf.ch/news/bnf/rss/1890`).
- **Ansicht:** Liste, wechselnde Schlagzeile oder Laufband; Anzahl, Bilder, Kurztext, Quelle.
- **Filter:** Höchstalter der Meldungen und «Ausblenden bei Stichwort» (Titel und Kurztext, Gross-/Kleinschreibung egal).

Liefert ein Feed einen Fehler, zeigt das Widget die übrigen weiter an und nennt den fehlerhaften.

## Kalender (ICS, Office 365)

Das Widget liest Kalender im ICS-Format (`https://…` oder `webcal://…`). Das Backend wertet Serientermine,
Ausnahmen und Windows-Zeitzonen aus; als privat markierte Termine erscheinen immer nur als «Privat».

### Office 365 / Outlook

1. In **Outlook im Web** (outlook.office.com) **Einstellungen → Kalender → Freigegebene Kalender** öffnen.
2. Unter **Kalender veröffentlichen** den Kalender und die Berechtigung wählen:
   *Kann alle Details anzeigen* (Titel und Ort) oder *Kann nur Verfügbarkeit anzeigen* (nur «Beschäftigt»),
   dann **Veröffentlichen**.
3. Den **ICS-Link** kopieren (nicht den HTML-Link) – er sieht etwa so aus:
   `https://outlook.office365.com/owa/calendar/…/calendar.ics`.
4. Im Kalender-Widget **Kalender hinzufügen**: Name (z. B. «Team» oder «Sitzungszimmer»), ICS-Link, Farbe.

Je nach Organisation muss die IT das Veröffentlichen von Kalendern erst erlauben. Microsoft aktualisiert
veröffentlichte Kalender mit Verzögerung; neue Termine erscheinen deshalb nicht sofort.

### Google und iCloud

- **Google Kalender:** Einstellungen des Kalenders → *Kalender integrieren* → **Privatadresse im iCal-Format**.
- **iCloud:** Kalender teilen → *Öffentlicher Kalender* → Link kopieren (`webcal://…`).

### Datenschutz

- Ein veröffentlichter ICS-Link ist ein **geheimer Link**: Wer ihn kennt, kann den Kalender lesen. SlateDesk
  behandelt ihn als normale Adresse – er ist in der Fernsteuerung sichtbar und steht im Export. Bei
  Verdacht in Outlook die Veröffentlichung zurücksetzen und den neuen Link eintragen.
- Für Bildschirme, die Besucher sehen: **Termintitel → Nur «Besetzt»** zeigt nur Zeiten, ohne Titel und Ort.

## Volumio

- **Volumio-Adresse:** IP-Adresse oder Hostname, optional mit Port, z. B. `192.168.19.50`, `volumio.local`
  oder `http://volumio.local:3000`. Zu finden in Volumio unter *Einstellungen → Netzwerk*.
- Das Widget nutzt die REST-Schnittstelle von Volumio (`/api/v1/getState`, `/api/v1/commands/?cmd=…`);
  ein Schlüssel ist nicht nötig. Am Kiosk prüft **Verbindung testen** im Einstellungsdialog die Adresse.
- Einstellbar sind Aktualisierung, Fortschritt, Audio-Details, Wiedergabe- und Lautstärke-Tasten sowie eine
  **maximale Lautstärke**, über die «Lauter» nie hinausgeht.
- `.local`-Namen brauchen mDNS (Avahi) auf dem Kiosk – unter Ubuntu Standard. Sonst die IP-Adresse nehmen.

## Host-Monitor

Prüft die Erreichbarkeit von Geräten im Netz; jeder Host hat Name, Adresse und Prüfung:

| Prüfung | Funktion |
|---|---|
| **Ping (ICMP)** | `ping` vom Kiosk aus (Paket `iputils-ping`, installiert `setup.sh`) |
| **TCP-Port** | Verbindungsaufbau zum Port, z. B. 445 (Dateifreigabe), 5000/5001 (Synology DSM), 9100 (Drucker) |
| **Webseite (HTTP/HTTPS)** | GET auf Port und Pfad; Port 443 = HTTPS, jeder andere Port = HTTP. Jede Antwort zählt als erreichbar, ausser Serverfehlern (5xx). |

Für HTTPS auf einem anderen Port als 443 (z. B. Synology DSM auf 5001) die Prüfung **TCP-Port** verwenden.
Einstellbar sind Intervall, «Als ausgefallen melden nach» (Fehlversuche in Folge), Schwellen für die
Antwortzeit und der Verlauf.

## Speedtest

Misst Download, Upload und Ping gegen `speed.cloudflare.com`, ohne Schlüssel. Automatisch (alle 15 Minuten
bis 4 Stunden), beim Start oder nur manuell. «Erwartete Geschwindigkeit» skaliert die Anzeigen, «Warnung
Internet langsam» setzt Schwellen. Jede Messung lädt 25 MB herunter und bis zu 10 MB hoch – bei knappem
Datenvolumen das Intervall gross wählen.

## KI-Assistent (OpenAI, Ollama, LM Studio)

### OpenAI (Cloud)

1. Auf [platform.openai.com](https://platform.openai.com) unter **API keys** einen Schlüssel erstellen
   (`sk-…`). Ein eigenes Projekt mit Ausgabenlimit für SlateDesk ist empfehlenswert.
2. Im Widget **Anbieter: OpenAI (Cloud)**, **OpenAI API-Key** eintragen und ein **Modell** wählen.

Spracheingabe (Spracherkennung) und Sprachausgabe (Vorlesen) laufen immer über OpenAI und brauchen den
Schlüssel. Die Anfragen gehen direkt vom Kiosk an `api.openai.com`; die Kosten richten sich nach dem Verbrauch.

### Lokal (Ollama oder LM Studio)

1. Ollama als Administrator installieren (auf dem Kiosk oder einem anderen Rechner im LAN) und ein Modell
   laden:

   ```bash
   curl -fsSL https://ollama.com/install.sh | sh
   ollama pull llama3.2
   ```

2. Im Widget **Anbieter: Lokal (Ollama / LM Studio)** und die **Server-Adresse** eintragen:
   Ollama `http://localhost:11434`, LM Studio `http://localhost:1234`, oder die Adresse eines Rechners im LAN.
3. Das **Modell** am Kiosk im Einstellungsdialog aus der Liste der installierten Modelle wählen (die
   Fernsteuerung kennt diese Liste nicht).

Ohne OpenAI-Schlüssel funktioniert lokal nur die Texteingabe. Ein eingetragener OpenAI-Schlüssel wird nie an
den lokalen Server geschickt. Auf schwachen Kiosk-Rechnern antworten lokale Modelle langsam – ein Rechner
mit Grafikkarte im LAN ist dann die bessere Wahl.

### Mikrofon und Gesprächsverlauf

- Das Mikrofon gibt die Kiosk-App automatisch frei. Es funktioniert nur, wenn `slatedesk` die aktive
  Sitzung am Gerät hat (Autologin, siehe [docs/BETRIEB.md](docs/BETRIEB.md)).
- **Gespräch leeren nach** löscht die Unterhaltung nach der eingestellten Zeit ohne Aktivität (Standard
  5 Minuten).

---

## lagra

Die lagra-Widgets zeigen den Zustand des lagra-Servers am Bildschirm:

| Widget | lagra-Endpunkt |
|---|---|
| **lagra Übersicht** – Server, Aufgaben, Virenscanner, DAM, Archiv, NAS und mehr | `GET /api/v1/uebersicht` |
| **lagra Aufgaben** – Hintergrundaufgaben mit letztem und nächstem Lauf | `GET /api/v1/jobs` |
| **lagra: Neu im DAM** – zuletzt aufgenommene Bilder | `GET /api/v1/uebersicht?teile=neu…` und `/api/v1/assets/<id>/vorschau` |

### Voraussetzung: lagra-Version

`/api/v1/uebersicht` und `/api/v1/jobs` gibt es erst mit dem lagra-Branch **`slatedesk-uebersicht`**. Solange
dieser nicht auf dem lagra-Server läuft, melden die Widgets «lagra: Endpunkt fehlt (404) – lagra-Update
nötig». Der Verbindungstest prüft das Token dann über einen älteren Endpunkt und meldet bei gültigem Token
«Verbunden, aber lagra-Update nötig (Übersicht fehlt)». lagra wird bei einem Push auf seinen Hauptzweig
automatisch produktiv ausgerollt – das Mergen ist deshalb ein bewusster Schritt im lagra-Repository.

### 1. Token in lagra erstellen

1. In lagra (`https://lagra.schnyder-werbung.ch`) als Admin **/schnittstellen** öffnen.
2. Ein neues Token mit dem Namen **`slatedesk`** anlegen und kopieren.

lagra-Tokens kennen keine Rechtestufen: Ein Token darf alles, was die API kann, auch schreiben. SlateDesk
liest nur (GET) – trotzdem das Token ausschliesslich für diesen Kiosk verwenden und es bei Verlust oder
Austausch des Geräts unter /schnittstellen widerrufen. Auf /schnittstellen sind auch die letzten Aufrufe
des Tokens zu sehen.

### 2. Namensauflösung im Büro

Solange die Firewall im Büro kein NAT-Loopback macht, muss der Kiosk den Namen von lagra auf die interne
Adresse auflösen:

```bash
echo '192.168.19.185 lagra.schnyder-werbung.ch' | sudo tee -a /etc/hosts
getent hosts lagra.schnyder-werbung.ch      # → 192.168.19.185
```

So bleibt die Verbindung per HTTPS mit gültigem Zertifikat. **Nicht** `http://<IP>:3000` als Adresse
eintragen – das umgeht TLS und schickt das Token im Klartext durchs Netz. Den Eintrag wieder entfernen,
sobald NAT-Loopback aktiv ist.

### 3. In SlateDesk einrichten

1. Fernsteuerung → **lagra**: «lagra verwenden» einschalten.
2. **Adresse** leer lassen (Standard `https://lagra.schnyder-werbung.ch`) oder anpassen – vor dem Token.
3. **API-Token** einfügen und **Verbindung testen**.
4. Darunter erscheinen Übersicht und Hintergrundaufgaben als Vorschau. Danach die Widgets im Layout hinzufügen.

Das Token verlässt das Backend des Kiosks nie; auch die Vorschau der Fernsteuerung holt die Daten über den
Kiosk. Bilder lädt der Kiosk nur von der eingetragenen lagra-Adresse.

### Besucherbereich

Der Bildschirm steht dort, wo auch Besuch steht:

- **lagra Übersicht** und **lagra Aufgaben** zeigen nur Zahlen und Zustände – keine Kunden- oder
  Dateinamen, keine Pfade.
- **lagra: Neu im DAM** zeigt Kundenarbeit. Unbedingt einen **Ordner** eintragen, dessen Inhalt bewusst
  gezeigt werden darf (z. B. `/daten/Intern/Schaufenster`); leer heisst alle Ordner, die lagra für die
  Schnittstelle freigibt. **Dateinamen anzeigen** ist standardmässig aus.

### Meldungen

| Meldung | Ursache |
|---|---|
| «lagra ist nicht eingerichtet» | «lagra verwenden» aus, Adresse oder Token fehlen |
| «Die lagra-Adresse ist ungültig» | Adresse ist keine `http(s)://`-Adresse |
| «lagra: Token ungültig (401)» | Token falsch oder widerrufen |
| «lagra: Endpunkt fehlt (404) – lagra-Update nötig» | lagra-Server ohne Branch `slatedesk-uebersicht` |
| «lagra nicht erreichbar: …» | DNS bzw. `/etc/hosts`, Netzwerk oder lagra-Server |

---

## planbar

Die planbar-Widgets machen den Kiosk zum persönlichen Arbeits-Dashboard – mit Namen und Projekten:

| Widget | planbar-Endpunkt | benötigtes Recht |
|---|---|---|
| **planbar Aufgaben** – offene Aufgaben und Projekte ausgewählter Personen, nach Fälligkeit | `GET /api/v1/arbeitsliste` | Aufgaben & Zeiten – Lesen |
| … mit «Abhaken erlauben» | `PATCH /api/v1/arbeitsliste/<id>` | Aufgaben & Zeiten – **Schreiben** |
| **planbar Projekte** – Fortschritt, Termin, Stunden, Meilenstein, Beteiligte | `GET /api/v1/projektuebersicht` | Projekte – Lesen |
| **planbar News** – Beiträge der Infowand | `GET /api/v1/news` | News – Lesen |
| **planbar Zeit** – Stunden heute und diese Woche, laufender Timer | `GET /api/v1/zeiten/zusammenfassung` | Aufgaben & Zeiten – Lesen |
| Personen-Auswahl in den Einstellungen | `GET /api/v1/mitglieder` | Aufgaben & Zeiten oder Projekte – Lesen |
| Projekt-Auswahl in den Einstellungen | `GET /api/v1/projektuebersicht` | Projekte – Lesen |

### Voraussetzung: planbar-Version

Die Endpunkte für SlateDesk (`/arbeitsliste`, `/projektuebersicht`, `/news`, `/zeiten/zusammenfassung`) und
das Recht *News – Lesen* gibt es erst mit dem planbar-Branch **`slatedesk-dashboard`**. Solange dieser nicht
auf planbar.dev läuft, melden Verbindungstest und Widgets «planbar-Update nötig». planbar wird bei einem Push
auf den Auslieferungszweig automatisch produktiv ausgerollt – das Mergen ist ein bewusster Schritt im
planbar-Repository.

### 1. API-Schlüssel in planbar erstellen

1. In planbar als **Admin Unternehmen** anmelden (nur diese Rolle sieht die Seite).
2. **Unternehmen → API-Schlüssel** (`https://planbar.dev/api-keys`) → **Schlüssel erstellen**.
3. Name z. B. `SlateDesk Büro`; unter *Rechte* ankreuzen:
   - *Aufgaben & Zeiten* – **Lesen**, oder **Schreiben**, wenn Aufgaben am Kiosk abgehakt werden sollen
     (Schreiben schliesst Lesen ein),
   - *Projekte* – **Lesen**,
   - *News* – **Lesen**.

   Optional ein Ablaufdatum setzen.
4. **Erstellen**: planbar zeigt den Schlüssel (`pk_live_…`) **nur einmal** an – gleich kopieren.

Mit «Schreiben» könnte der Schlüssel über die planbar-API auch Tickets und Zeiteinträge anlegen. SlateDesk
leitet ausschliesslich das Abhaken einer Aufgabe weiter (`PATCH /api/v1/arbeitsliste/<id>` mit genau
`{ "completed": true | false }`) und lehnt alles andere ab. Wer nicht abhaken will, gibt nur «Lesen».
Bei Verlust oder Austausch des Geräts den Schlüssel in planbar widerrufen.

### 2. In SlateDesk einrichten

1. Fernsteuerung → **planbar**: zuerst die **Adresse** (leer = `https://planbar.dev`), dann den
   **API-Schlüssel** eintragen – eine geänderte Adresse löscht den gespeicherten Schlüssel.
2. «planbar verwenden» einschalten und **Verbindung testen**. Der Test zeigt die Anzahl Personen und welche
   Rechte der Schlüssel hat; fehlende Rechte sind markiert.
3. In der **Vorschau** eine Person wählen: So sieht ihre Arbeitsliste im Widget aus; dazu die neusten News.
4. Widgets im Layout hinzufügen und in ihren Einstellungen **Personen** bzw. **Projekte** auswählen. Die
   Auswahllisten laden die Daten live aus planbar (zwischengespeichert 60 Sekunden, «Neu laden» holt sie
   sofort).

Der Schlüssel verlässt das Backend des Kiosks nie; Antworten speichert der Kiosk 15 Sekunden zwischen.

### Abhaken am Kiosk

«Abhaken erlauben» im Widget **planbar Aufgaben** ist standardmässig aus. Ein Tipp hakt die Aufgabe am
Bildschirm sofort ab; planbar erfährt es erst nach 5 Sekunden – bis dahin lässt es sich rückgängig machen.
Danach wirkt es wie in planbar selbst (Tagesrapport, nächste Instanz einer wiederkehrenden Aufgabe, ein
laufender Timer auf der Aufgabe stoppt). Fehlt das Recht «Schreiben», meldet das Widget das.

**planbar News** zeigt standardmässig nur Beiträge, die alle sehen dürfen (Einstellung «Sichtbarkeit»).

### Meldungen

| Meldung | Ursache |
|---|---|
| «planbar ist ausgeschaltet» / «planbar ist nicht eingerichtet» | «planbar verwenden» aus oder API-Schlüssel fehlt |
| «planbar: API-Schlüssel ungültig (401) – …» | Schlüssel falsch, widerrufen oder abgelaufen (planbar nennt den Grund) |
| «planbar: Berechtigung fehlt – Fehlende Berechtigung: …» | dem Schlüssel fehlt das genannte Recht – in planbar einen neuen Schlüssel mit dem Recht erstellen |
| «planbar-Update nötig» | planbar.dev ohne Branch `slatedesk-dashboard` |
| «planbar nicht erreichbar: …» | Netzwerk, DNS oder planbar-Server |
