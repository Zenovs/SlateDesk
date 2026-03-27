# SlateDesk Auto-Update System

> Vollautomatisches Update-System für SlateDesk auf Ubuntu.

## 📋 Übersicht

Das Auto-Update System sorgt dafür, dass SlateDesk immer auf dem neuesten Stand ist – ohne manuelle Eingriffe.

### Funktionsweise

1. **Täglicher Check um 01:00 Uhr** (Cronjob)
   - Prüft auf neue Commits im GitHub-Repository
   - Falls vorhanden: Pull → Build → Deinstall → Install → Restart

2. **Boot-Check** (systemd Service)
   - Falls der Rechner um 01:00 Uhr aus war
   - Prüft beim Hochfahren auf Updates
   - Wartet auf Netzwerkverbindung

3. **Sicherheit**
   - Backup der alten Version vor jedem Update
   - Automatischer Rollback bei Fehlern
   - Nur spezifische `dpkg`-Befehle ohne Passwort erlaubt
   - Lock-Mechanismus verhindert parallele Ausführung

## 🚀 Installation

### Voraussetzungen

- SlateDesk ist unter `/home/slatedesk/SlateDesk` geklont
- Node.js, npm und Rust/Cargo sind installiert
- Der Nutzer `slatedesk` existiert

### Setup ausführen

```bash
cd /home/slatedesk/SlateDesk
sudo bash scripts/setup-auto-update.sh
```

Das Setup-Script erledigt automatisch:
- ✅ Scripts ausführbar machen
- ✅ Sudo-Konfiguration (nur `dpkg`-Befehle)
- ✅ Cronjob einrichten (01:00 Uhr)
- ✅ Systemd Boot-Service installieren
- ✅ Backup-Verzeichnis erstellen
- ✅ Log-Datei vorbereiten

## 📁 Dateien

| Datei | Beschreibung |
|-------|-------------|
| `scripts/auto-update.sh` | Haupt-Update-Script |
| `scripts/setup-auto-update.sh` | Installations-Script |
| `scripts/slatedesk-update-sudoers` | Sudoers-Template |
| `scripts/slatedesk-boot-update.service` | Systemd-Service-Template |

## 📊 Logs prüfen

### Update-Log

```bash
# Live-Log anzeigen
tail -f /home/slatedesk/slatedesk-update.log

# Letzte 50 Zeilen
tail -n 50 /home/slatedesk/slatedesk-update.log

# Nach Fehlern suchen
grep "ERROR" /home/slatedesk/slatedesk-update.log
```

### Systemd-Service-Log

```bash
# Boot-Update-Service Log
journalctl -u slatedesk-boot-update.service

# Letzte Ausführung
journalctl -u slatedesk-boot-update.service -n 50
```

### Cronjob prüfen

```bash
# Cronjobs des Nutzers anzeigen
sudo crontab -u slatedesk -l
```

## 🔧 Manuell testen

```bash
# Update manuell ausführen
sudo -u slatedesk /home/slatedesk/SlateDesk/scripts/auto-update.sh

# Boot-Service manuell testen
sudo systemctl start slatedesk-boot-update.service
sudo systemctl status slatedesk-boot-update.service
```

## ⏸️ Deaktivieren

### Cronjob deaktivieren

```bash
# Cronjob entfernen
sudo crontab -u slatedesk -r

# Oder nur Update-Zeile entfernen
sudo crontab -u slatedesk -e
# Zeile mit auto-update.sh löschen
```

### Boot-Service deaktivieren

```bash
sudo systemctl disable slatedesk-boot-update.service
sudo systemctl stop slatedesk-boot-update.service
```

### Sudo-Konfiguration entfernen

```bash
sudo rm /etc/sudoers.d/slatedesk-update
```

### Alles auf einmal deaktivieren

```bash
sudo systemctl disable slatedesk-boot-update.service
sudo crontab -u slatedesk -r
sudo rm /etc/sudoers.d/slatedesk-update
```

## 🔄 Update-Ablauf im Detail

```
┌─────────────────────────────────────────┐
│           Update gestartet              │
│  (Cronjob 01:00 oder Boot-Service)     │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  Netzwerk prüfen (max. 5 Min warten)   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  git fetch origin main                  │
│  Vergleiche HEAD mit origin/main        │
└──────────────┬──────────────────────────┘
               │
        ┌──────┴──────┐
        │ Gleich?     │
        │   → EXIT 0  │
        └──────┬──────┘
               │ Unterschiedlich
               ▼
┌─────────────────────────────────────────┐
│  Backup der aktuellen .deb erstellen    │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  git pull origin main                   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  npm install (falls package.json neu)   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  npx tauri build                        │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│  SlateDesk stoppen                      │
│  dpkg -r slate-desk                     │
│  dpkg -i neue_version.deb               │
│  SlateDesk starten                      │
└──────────────┬──────────────────────────┘
               │
        ┌──────┴──────┐
        │ Fehler?     │──→ ROLLBACK
        │   → EXIT 1  │    (Backup installieren)
        └──────┬──────┘
               │ Erfolg
               ▼
┌─────────────────────────────────────────┐
│  ✅ Update erfolgreich!                 │
│     EXIT 0                              │
└─────────────────────────────────────────┘
```

## 🛠️ Troubleshooting

### Problem: "Netzwerk nicht erreichbar"

- Prüfe Netzwerkverbindung: `ping github.com`
- Prüfe DNS: `nslookup github.com`
- Prüfe ob `network-online.target` aktiv ist

### Problem: "Git pull fehlgeschlagen"

- Lokale Änderungen? `cd /home/slatedesk/SlateDesk && git status`
- Merge-Konflikte? `git reset --hard origin/main` (Vorsicht!)
- SSH-Key konfiguriert? `ssh -T git@github.com`

### Problem: "Build fehlgeschlagen"

- Node.js/npm Version prüfen: `node -v && npm -v`
- Rust/Cargo Version prüfen: `rustc --version && cargo --version`
- Dependencies prüfen: `npm install && cargo build`
- Genug Speicherplatz? `df -h`

### Problem: "dpkg Installation fehlgeschlagen"

- Sudo konfiguriert? `sudo -l -U slatedesk`
- .deb Datei vorhanden? `ls -la ~/SlateDesk/src-tauri/target/release/bundle/deb/`
- Abhängigkeiten fehlen? `sudo apt-get -f install`

### Problem: "Update läuft bereits (Lock-Datei)"

- Prüfe ob Prozess noch läuft: `ps aux | grep auto-update`
- Falls nicht: `rm /tmp/slatedesk-update.lock`

### Problem: "Rollback fehlgeschlagen"

- Backups prüfen: `ls -la /home/slatedesk/.slatedesk-backups/`
- Manuell installieren: `sudo dpkg -i /home/slatedesk/.slatedesk-backups/<backup>.deb`

## 🔒 Sicherheit

- **Sudo:** Nur `dpkg -r slate-desk` und `dpkg -i <spezifischer_pfad>` erlaubt
- **Keine Wildcards** in Sudo-Konfiguration für unsichere Pfade
- **Lock-Datei** verhindert parallele Ausführung
- **Backups** ermöglichen Rollback (max. 5 gespeichert)
- **Logging** für vollständige Nachvollziehbarkeit
