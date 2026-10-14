# SlateDesk – Betrieb

Anleitung für Installation, Migration, Updates und Fehlersuche auf dem Kiosk-Gerät.
Zielsysteme: Ubuntu Desktop 24.04/26.04 (GNOME) und Raspberry Pi OS Bookworm (64 Bit).

Weitere Anleitungen: [FERNSTEUERUNG.md](FERNSTEUERUNG.md) (Web-Oberfläche) und
[API_SETUP.md](../API_SETUP.md) (Datenquellen, lagra, planbar).

## Überblick

SlateDesk läuft vollständig unter dem Benutzer **`slatedesk`** – ohne Root-Rechte, ohne `sudo`, ohne
`.deb`-Paket. Das Gerät baut neue Versionen selbst aus dem Git-Repository und installiert sie in
das Home-Verzeichnis.

| Was | Wo (im Home von `slatedesk`) |
|---|---|
| Git-Checkout | `~/SlateDesk` |
| Installierte Versionen | `~/.local/opt/slatedesk/releases/<kurz-commit>/slate-desk` |
| Aktive Version | `~/.local/opt/slatedesk/current` (Symlink auf ein Release) |
| Dashboard-Zustand | `~/.config/com.slatedesk.app/state.json` (+ `state.json.bak`, Rechte 0600) |
| Fernsteuerung (Port, PIN) | `~/.config/com.slatedesk.app/remote.json` (Rechte 0600) |
| Update-Status und -Protokoll | `~/.local/state/slatedesk/update-status.json`, `update.log` |
| Dienste und Timer | `~/.config/systemd/user/slatedesk*.service`, `*.timer` |
| Logdateien der App | `~/.local/share/com.slatedesk.app/logs/` (zusätzlich im Journal) |
| WebKit-Daten (alter localStorage) | `~/.local/share/com.slatedesk.app` |

Admin-Befehle in dieser Anleitung laufen mit `sudo` von einem Admin-Konto aus (z. B. per SSH).
Für den systemd-User-Manager von `slatedesk` dient `systemctl --user -M slatedesk@ …`.

## Installation

Der unterstützte Weg ist `scripts/setup.sh`. Das Script ist idempotent und kann jederzeit erneut
ausgeführt werden (Reparatur, Rust-Update, Aufräumen).

```bash
curl -fsSL https://raw.githubusercontent.com/Zenovs/SlateDesk/main/scripts/setup.sh -o /tmp/slatedesk-setup.sh
sudo bash /tmp/slatedesk-setup.sh --autologin
```

Liegt der Checkout schon auf dem Gerät, geht auch `sudo bash /home/slatedesk/SlateDesk/scripts/setup.sh`.

Das Script

1. installiert `git`, `curl` und `ca-certificates`, legt den Benutzer `slatedesk` an (ohne Passwort,
   ohne sudo) und klont bzw. aktualisiert `~slatedesk/SlateDesk` auf den Update-Branch (Standard `main`,
   siehe `--branch`); ist die `setup.sh`
   im Repository neuer als die laufende, macht es mit dieser weiter,
2. installiert die Pakete: Build-Abhängigkeiten von Tauri/WebKitGTK, `iputils-ping`, `iproute2` und –
   soweit in den Paketquellen vorhanden – `x11-xserver-utils`, `wlr-randr` und `libglib2.0-bin` für
   das Schalten des Bildschirms,
3. aktiviert *Linger* für `slatedesk`, damit seine Dienste und Timer auch ohne Anmeldung laufen, und
   installiert Node.js 22 mit npm (falls nötig über NodeSource) sowie Rust per `rustup` **für
   `slatedesk`**,
4. sichert vorhandene WebKit-Daten, solange es noch keine `state.json` gibt (siehe
   [Migration](#migration-vom-alten-setup)),
5. baut SlateDesk als `slatedesk` (`scripts/auto-update.sh`, beim ersten Mal 10–30 Minuten),
6. installiert die User-Dienste, startet die App (wenn `slatedesk` angemeldet ist) und prüft per
   Health-Check, ob sie antwortet. Bei einem erneuten Lauf wird eine neue Version wie bei einem
   Update gestartet, geprüft und bei einem Fehlstart auf die vorherige zurückgesetzt; eine nach
   einem Fehlstart gesperrte Version überspringt das Script und behält die laufende,
7. entfernt Reste eines alten Setups und aktiviert die Timer für Update (01:00) und Neustart (04:00),
8. schaltet für `slatedesk` Bildschirmschoner, Sperrbildschirm, Ruhezustand und
   Benachrichtigungsbanner ab (GNOME),
9. richtet auf Wunsch die automatische Anmeldung (GDM oder LightDM) und eine ufw-Regel ein und nennt
   am Ende die Adresse der Fernsteuerung sowie Status- und Log-Befehle.

| Option | Wirkung |
|---|---|
| `--autologin` | automatische Anmeldung von `slatedesk` einrichten (GDM/LightDM) |
| `--ufw`, `--ufw-subnet 192.168.19.0/24` | Port 7380 nur aus dem lokalen Subnetz freigeben (ohne `--ufw-subnet` erkennt das Script das Subnetz selbst) |
| `--rebuild` | neu bauen, auch wenn die Version aktuell ist |
| `--user NAME`, `--repo URL` | anderer Kiosk-Benutzer bzw. anderes Repository |
| `--skip-apt` | Paketinstallation überspringen |
| `--branch NAME` | Update-Branch, z. B. `grosses-update` für einen Testrechner; bleibt gespeichert (siehe [Update-Branch](#update-branch)) |
| `-y` | Rückfragen mit Ja beantworten |

Ohne `--autologin` bzw. `--ufw` fragt das Script im Terminal nach. Danach das Gerät neu starten:
`slatedesk` meldet sich automatisch an, SlateDesk startet im Vollbild.

## Migration vom alten Setup

Das alte Setup bestand aus dem `.deb`-Paket (`/usr/bin/slate-desk`), der sudo-Regel
`/etc/sudoers.d/slatedesk-update`, Cron-Einträgen (Update 01:00, stündlicher Neustart), dem
Systemdienst `slatedesk-boot-update.service` (je nach Installation auch `/etc/systemd/system/slatedesk.service`),
einem Autostart-Eintrag und einem alten User-Dienst. `setup.sh` erkennt und ersetzt all das.

> **Wichtig – Layout sichern: `setup.sh` direkt nach dem Merge ausführen und bis dahin am alten
> Kiosk nicht auf „Update möglich“ tippen.**
> Bis `setup.sh` gelaufen ist, startet jeder Update-Weg des alten Setups das **alte** Update-Script
> aus `~/SlateDesk/scripts`: das nächtliche Update um 01:00, das Boot-Update und der Knopf
> **„Update möglich“** in der Kopfleiste des alten Kiosks (die alte App prüft bei jedem Start auf
> Updates, und der alte stündliche Neustart startet sie jede Stunde neu). Dieses Script
>
> * löscht nach der Installation `~/.local/share/com.slatedesk.app/storage`. Je nach
>   WebKitGTK-Version liegt dort der localStorage mit Layout und Widget-Einstellungen, den die neue
>   Version beim ersten Start einmalig nach `state.json` übernimmt – das Layout kann dann verloren
>   sein und muss neu angelegt werden;
> * baut die neue Version selbst, obwohl sie neuere Node.js- und Rust-Versionen braucht. Schlägt
>   dieser Build fehl, deinstalliert sein Rollback das Paket (`dpkg -r`), und der Kiosk bleibt nach
>   dem nächsten Neustart schwarz.
>
> Deshalb `setup.sh` **am Tag des Merges auf `main`, gleich danach** ausführen – danach läuft das
> alte Script nie wieder.

**Empfohlen – vor dem Merge:** das alte nächtliche Update, das Boot-Update und den stündlichen
Neustart abschalten. Ohne den stündlichen Neustart prüft die alte App nicht mehr von selbst auf
Updates; „Update möglich“ erscheint dann erst nach einem Neustart oder nach einem Tipp auf „Auf
Updates prüfen“. Den Knopf trotzdem nicht verwenden.

```bash
sudo crontab -u slatedesk -l | grep -Ev 'scripts/(auto-update|hourly-restart)\.sh' | sudo crontab -u slatedesk -
sudo systemctl disable slatedesk-boot-update.service
```

**Direkt nach dem Merge** (per SSH auf dem Kiosk, die alte App läuft dabei weiter):

```bash
curl -fsSL https://raw.githubusercontent.com/Zenovs/SlateDesk/main/scripts/setup.sh -o /tmp/slatedesk-setup.sh
sudo bash /tmp/slatedesk-setup.sh
```

Was dabei passiert:

1. Die bisherigen WebKit-Daten werden gesichert:
   `~/.local/state/slatedesk/backup/webkit-daten-<datum>.tar.gz`.
2. Die neue Version wird gebaut, während die alte App weiterläuft.
3. Erst dann werden die alten Startwege gestoppt, die neue App gestartet und per Health-Check geprüft.
4. Antwortet sie, entfernt das Script Cron-Einträge, sudo-Regel, alte Systemdienste, den
   Autostart-Eintrag und zuletzt das Paket (`dpkg -r slate-desk`). Benutzerdaten bleiben erhalten.
5. Antwortet sie nicht, wird das alte Setup wiederhergestellt und das Script bricht mit Hinweisen ab.

Ist `slatedesk` während der Migration nicht angemeldet, wird das alte Setup trotzdem abgebaut, das
Paket bleibt aber installiert, bis die neue Version einmal lief. Nach dem nächsten Neustart
`setup.sh` erneut ausführen – dann wird auch das Paket entfernt.

**Layout fehlt nach der Migration?** Das Backup aus Schritt 1 lässt sich zurückspielen, solange es vor
dem ersten Start der neuen Version entstanden ist (`uninstall.sh` ohne `--purge` lässt es stehen):

```bash
sudo systemctl --user -M slatedesk@ stop slatedesk.service
sudo -u slatedesk tar -xzf /home/slatedesk/.local/state/slatedesk/backup/webkit-daten-<datum>.tar.gz \
     -C /home/slatedesk/.local/share
sudo -u slatedesk mv /home/slatedesk/.config/com.slatedesk.app/state.json \
     /home/slatedesk/.config/com.slatedesk.app/state.json.verworfen
sudo systemctl --user -M slatedesk@ start slatedesk.service
```

Ohne `state.json` übernimmt die App den localStorage beim Start erneut. Ist auch im Backup nichts
mehr vorhanden, das Layout in der Fernsteuerung unter **Layout** neu anlegen oder eine frühere
Sicherung wiederherstellen (siehe [Datensicherung](#datensicherung)).

**Altes Setup noch nicht migriert:** Das neue `auto-update.sh` erkennt das alte Setup und
aktualisiert es weiter per `.deb` (`sudo -n dpkg -i`, ohne `dpkg -r`, ohne WebKit-Daten zu löschen).
Im Update-Log steht dann jedes Mal der Hinweis, `setup.sh` auszuführen. Auf Ubuntu 25.10/26.04
(sudo-rs) hat das alte Setup nie eine gültige sudo-Regel erhalten – dort hilft nur `setup.sh`.

## Dienste und Timer

| Unit | Aufgabe | Wann |
|---|---|---|
| `slatedesk.service` | die App (`~/.local/opt/slatedesk/current/slate-desk`), `Restart=always` nach 5 s | mit der grafischen Sitzung |
| `slatedesk-update.timer` → `slatedesk-update.service` | Update: Git → Build → Installation → Neustart → Health-Check | täglich 01:00 und 3 Min. nach dem Systemstart; verpasste Läufe werden nachgeholt |
| `slatedesk-restart.timer` → `slatedesk-restart.service` | geordneter Neustart der App | täglich 04:00, nur wenn die App läuft und kein Update aktiv ist |
| `~/.config/autostart/slatedesk-session.desktop` | startet `slatedesk.service` auch auf Desktops ohne `graphical-session.target` (z. B. Raspberry Pi OS) | bei der Anmeldung |

```bash
sudo systemctl --user -M slatedesk@ status slatedesk.service
sudo systemctl --user -M slatedesk@ restart slatedesk.service
sudo systemctl --user -M slatedesk@ list-timers 'slatedesk*'
```

Direkt am Kiosk (Terminal als `slatedesk`) genügt `systemctl --user …`.

**Eigene Einstellungen** gehören in ein Drop-in – die Unit-Dateien selbst werden bei Updates aus dem
Repository übernommen:

```bash
sudo -u slatedesk mkdir -p /home/slatedesk/.config/systemd/user/slatedesk.service.d
sudo -u slatedesk tee /home/slatedesk/.config/systemd/user/slatedesk.service.d/lokal.conf >/dev/null <<'EOF'
[Service]
Environment=SLATEDESK_REMOTE_PORT=7381
EOF
sudo systemctl --user -M slatedesk@ daemon-reload
sudo systemctl --user -M slatedesk@ restart slatedesk.service
```

| Variable | Bedeutung |
|---|---|
| `SLATEDESK_HOME` | Git-Checkout (Standard `~/SlateDesk`), für Update-Prüfung und -Start |
| `SLATEDESK_REMOTE_PORT` | Port der Fernsteuerung (Standard 7380, hat Vorrang vor `remote.json`) |
| `SLATEDESK_REMOTE_DISABLED=1` | Fernsteuerung abschalten (auch `true` oder `yes`) |
| `SLATEDESK_REMOTE_HOSTS` | Zusätzliche Host-Namen der Fernsteuerung, durch Komma getrennt (z. B. `kiosk.schnyder-werbung.ch`). Nur nötig für einen DNS-Namen mit öffentlich aussehender Endung – IP-Adressen, Namen ohne Punkt, `.local`, `.lan`, `.home.arpa`, `.internal`, `.localdomain` und der Hostname des Kiosks gehen immer. Andere Namen weist die App mit «Unbekannte Adresse» ab (Schutz vor DNS-Rebinding). |
| `WEBKIT_DISABLE_DMABUF_RENDERER=1` | Abhilfe bei weissem/leerem Fenster mit manchen Grafiktreibern |

## Logs

```bash
# App und Updates (als Admin). Nicht »journalctl --user-unit …«: das filtert nach der UID des
# Aufrufers und zeigt unter sudo nie Einträge von slatedesk.
sudo journalctl _SYSTEMD_USER_UNIT=slatedesk.service + USER_UNIT=slatedesk.service -f
sudo journalctl _SYSTEMD_USER_UNIT=slatedesk-update.service + USER_UNIT=slatedesk-update.service -n 200

# alles vom Benutzer slatedesk (App, Updates, Sitzung)
sudo journalctl _UID="$(id -u slatedesk)" -f

# als slatedesk direkt am Kiosk
journalctl --user -u 'slatedesk*' -f

# Update-Protokoll (inkl. npm- und cargo-Ausgabe, wird ab 1 MB nach update.log.1 rotiert)
sudo tail -f /home/slatedesk/.local/state/slatedesk/update.log

# Logdateien der App (je höchstens 2 MB, die letzten 5 bleiben)
sudo ls -l /home/slatedesk/.local/share/com.slatedesk.app/logs/
```

Der Fortschritt des laufenden Updates steht in `update-status.json`; Kiosk und Fernsteuerung zeigen
ihn an:

| Feld | Inhalt |
|---|---|
| `percent` | 0–100 |
| `message` | Text für die Anzeige (Deutsch) |
| `phase` | `start`, `network`, `fetch`, `checkout`, `deps`, `build`, `install`, `restart`, `health`, `rollback`, `done`, `uptodate`, `skipped`, `error` |
| `done` | `true`, sobald der Lauf beendet ist (auch bei Fehler) |
| `error` | `true` bei Fehler, Rollback oder übersprungener Version |
| `startedAt`, `updatedAt` | Zeitstempel in Millisekunden (Unix-Epoche) |
| `fromCommit`, `toCommit` | installierter bzw. neuer Commit (oder `null`) |

## Update und Rollback

Ablauf von `scripts/auto-update.sh` (läuft als `slatedesk-update.service`):

1. Sperre (`flock` in `$XDG_RUNTIME_DIR`) – ein zweiter Lauf beendet sich sofort.
2. Verbindung zu GitHub per `git ls-remote` prüfen: bis zu 30 Versuche im Abstand von 10 s.
3. `git fetch`; ist `origin/<Update-Branch>` gleich der **installierten** Version, endet der Lauf („aktuell“).
   Ist es die Version, die zuletzt nicht startete, endet er ebenfalls („übersprungen“).
4. `git checkout`/`git reset --hard origin/<Update-Branch>` und `git clean` (`node_modules`, Build-Cache,
   `Cargo.lock` und `.env` bleiben).
5. Speicherplatz prüfen – unter 3 GB frei wird der Build-Cache `src-tauri/target` gelöscht, unter
   1,5 GB bricht der Lauf ab –, dann `npm ci`, aber nur, wenn sich `package-lock.json` oder die
   Node-Version geändert hat.
6. `tauri build --ci --no-bundle -- --locked` (Cargo.lock ist versioniert).
7. Binary nach `releases/<kurz-commit>/` kopieren, Symlink `current` atomar umstellen, geänderte
   Unit-Dateien aus `scripts/systemd/` übernehmen.
8. `systemctl --user restart slatedesk.service`, danach Health-Check
   `http://127.0.0.1:7380/api/health` (max. 60 s; ein anderer Port aus `remote.json` bzw.
   `SLATEDESK_REMOTE_PORT` wird berücksichtigt).
9. Antwortet die neue Version nicht: `current` zurück auf die vorherige Version, Neustart,
   Status „Rollback“. Die fehlerhafte Version wird nicht jede Nacht erneut versucht, sondern erst
   wieder, wenn ein neuer Commit auf `main` liegt.
10. Es bleiben drei Versionen in `releases/` erhalten.

Läuft gerade keine grafische Sitzung, wird die neue Version nur installiert und startet bei der
nächsten Anmeldung. Sie gilt bis dahin als ungeprüft (`~/.local/state/slatedesk/pending-activation`):
Der nächste Update-Lauf mit grafischer Sitzung – etwa 3 Minuten nach dem nächsten Systemstart – holt
den Health-Check nach und setzt bei einem Fehlstart wie in Schritt 9 auf die vorherige Version
zurück. Ein fehlgeschlagener Build ändert nichts an der laufenden Version; der nächste Lauf versucht
es erneut.

**Update sofort starten:** in der Fernsteuerung unter **System → Update**, am Kiosk über den
Update-Knopf in der oberen Leiste oder:

```bash
sudo systemctl --user -M slatedesk@ start --no-block slatedesk-update.service
sudo tail -f /home/slatedesk/.local/state/slatedesk/update.log
```

**Neu bauen erzwingen** (auch eine nach fehlgeschlagenem Start gesperrte Version):

```bash
sudo -iu slatedesk bash -l /home/slatedesk/SlateDesk/scripts/auto-update.sh --force
```

Mit grafischer Sitzung läuft das wie ein normales Update (Neustart, Health-Check, Rollback);
startet die Version wieder nicht, ist sie danach erneut gesperrt. Der Lauf hängt an der SSH-Sitzung –
diese bis zum Ende offen lassen (oder in `tmux`/`screen` starten).

`auto-update.sh` nie als root oder als Admin ausführen – root-eigene Dateien in `node_modules` oder
`target` blockieren sonst alle weiteren Builds (als root verweigert das Script den Start; `setup.sh`
repariert die Besitzrechte).

**Manuell auf eine frühere Version zurück:**

```bash
ls -lt /home/slatedesk/.local/opt/slatedesk/releases/
sudo -u slatedesk ln -sfn releases/<kurz-commit> /home/slatedesk/.local/opt/slatedesk/.current.tmp
sudo -u slatedesk mv -Tf /home/slatedesk/.local/opt/slatedesk/.current.tmp /home/slatedesk/.local/opt/slatedesk/current
sudo systemctl --user -M slatedesk@ restart slatedesk.service
```

Das nächste Update geht wieder auf `main`. Um auf einer Version zu bleiben, den Update-Timer
anhalten: `sudo systemctl --user -M slatedesk@ disable --now slatedesk-update.timer`.

### Update-Branch

Standardmässig folgt der Kiosk `main`. Ein Testrechner kann einem anderen Branch folgen:

```bash
sudo bash ~/SlateDesk/scripts/setup.sh --user "$USER" --branch grosses-update
```

Der Branch steht danach in der Git-Konfiguration des Checkouts (`git config slatedesk.branch`) und
übersteht jedes Update. Das nächtliche Update, der Knopf „Update möglich“ und die Fernsteuerung
verwenden ihn alle. Zurück auf `main`: `setup.sh --branch main` (oder
`git -C ~/SlateDesk config slatedesk.branch main`). Für einen einzelnen Lauf überschreibt die
Umgebungsvariable `SLATEDESK_BRANCH` die Einstellung.

## zenOS (labwc)

SlateDesk läuft auch unter zenOS (Ubuntu 26.04 Server mit labwc). Zu beachten:

* **Benutzer:** zenOS meldet über greetd an, ohne Autologin. Am einfachsten läuft SlateDesk im
  eigenen zenOS-Benutzer: `sudo bash ~/SlateDesk/scripts/setup.sh --user "$USER" --ufw`
  (ohne `--autologin` – greetd wird nicht verändert).
* **Start:** zenOS startet `zenos-sitzung.target`, das `graphical-session.target` mitzieht. Damit
  startet `slatedesk.service` nach der Anmeldung von selbst; der XDG-Autostart-Eintrag wird unter
  labwc nicht gebraucht.
* **Sperre:** Die automatische Sperre von zenOS (swayidle, 1–15 Minuten) legt sich über das
  Dashboard. Für eine Wandanzeige braucht zenOS dafür eine Ausnahme – das ist eine Einstellung in
  zenOS, nicht in SlateDesk.
* **Bildschirm aus/an:** über `wlr-randr` (installiert `setup.sh`, falls verfügbar).
* **Firewall:** zenOS blockiert eingehende Verbindungen; `--ufw` erlaubt Port 7380 aus dem
  lokalen Subnetz.

## Fernsteuerung

Die App enthält eine Web-Oberfläche für Smartphone, Tablet und PC im Büro-LAN. Bedienung:
[FERNSTEUERUNG.md](FERNSTEUERUNG.md).

* Adresse: `http://<IP-des-Kiosks>:7380` (die IP zeigt `hostname -I`; `setup.sh` gibt sie am Ende aus).
* PIN: am Kiosk unter **Bearbeiten → Fernsteuerung** (dort auch Adresse und QR-Code). Er wird beim
  ersten Start zufällig erzeugt (6 Ziffern) und kann in der Fernsteuerung unter **System** geändert
  werden (6–12 Ziffern; ein älterer 4- oder 5-stelliger PIN gilt weiter, bis er geändert wird – die App
  warnt dann im Log). Nach 5 Fehlversuchen innert 5 Minuten sperrt die Anmeldung für diese
  IP-Adresse, bis der Zeitraum abgelaufen ist. Zusätzlich gilt eine Sperre für alle Geräte: 20
  Fehlversuche innert 5 Minuten, egal von welchen Adressen, sperren jede PIN-Anmeldung für 15 Minuten;
  jede weitere solche Sperre innert 24 Stunden verdoppelt die Dauer (höchstens 4 Stunden). Bereits
  angemeldete Browser bleiben angemeldet. Ein Neustart der App hebt die Sperre auf.
* Anmeldungen hält die App nur im Arbeitsspeicher: Nach jedem Neustart (04:00, Update, «App neu
  starten») melden sich alle Browser neu an.
* Firewall: Die App lauscht auf allen IPv4-Schnittstellen. Ist ufw aktiv, Port 7380 nur für das
  Büro-Subnetz freigeben:

  ```bash
  sudo ufw allow from 192.168.19.0/24 to any port 7380 proto tcp comment 'SlateDesk Fernsteuerung'
  ```

  (oder `setup.sh --ufw`, erkennt das Subnetz automatisch).
* **Kein Port-Forwarding im Router einrichten.** Die Verbindung ist unverschlüsseltes HTTP und
  gehört nur ins vertrauenswürdige LAN; von ausserhalb nur über VPN.
* Port ändern bzw. abschalten: per Drop-in (`SLATEDESK_REMOTE_PORT`, `SLATEDESK_REMOTE_DISABLED=1`,
  siehe [Dienste und Timer](#dienste-und-timer)) oder in `remote.json` (`"port"`, `"enabled": false`;
  die App dafür stoppen). Bei einem anderen Port die ufw-Regel anpassen – `setup.sh --ufw` kennt nur
  7380. Ohne Fernsteuerung prüft das Update statt des Health-Checks, ob die App 20 s stabil läuft.

## Datensicherung

Der gesamte Dashboard-Zustand (Layout, Widget-Einstellungen, Design, Kiosk-Einstellungen, lagra,
planbar, Aufgaben, Pinnwand) liegt in `~/.config/com.slatedesk.app/state.json`. Bei jeder Änderung wird
atomar geschrieben und die vorherige Fassung als `state.json.bak` behalten; ist `state.json`
unbrauchbar, startet die App mit `state.json.bak`. Updates und `uninstall.sh` (ohne `--purge`) lassen
das Verzeichnis unangetastet.

```bash
# Sicherung (inkl. PIN und Tokens – vertraulich aufbewahren)
sudo tar -czf /root/slatedesk-config-$(date +%F).tar.gz -C /home/slatedesk/.config com.slatedesk.app

# Wiederherstellung
sudo systemctl --user -M slatedesk@ stop slatedesk.service
sudo tar -xzf /root/slatedesk-config-<datum>.tar.gz -C /home/slatedesk/.config
sudo chown -R slatedesk: /home/slatedesk/.config/com.slatedesk.app
sudo systemctl --user -M slatedesk@ start slatedesk.service
```

Alternativ in der Fernsteuerung unter **System → Sicherung**: «Sicherung herunterladen» speichert
`slatedesk-state.json`, «Sicherung wiederherstellen» ersetzt den gesamten Zustand. Diese Datei enthält
**keine Geheimnisse**: Tokens, Passwörter und API-Schlüssel stehen dort als `__gesetzt__`. Beim
Wiederherstellen auf demselben Gerät bleiben die gespeicherten Werte erhalten; auf einem neuen Gerät
müssen sie neu eingetragen werden (z. B. das lagra-Token und der planbar-API-Schlüssel). Adressen wie
die ICS-Links von Kalendern gelten nicht als Geheimnis und stehen im Klartext darin.

## Integrationen (lagra, planbar)

Token und API-Schlüssel werden in der Fernsteuerung auf den Seiten **lagra** bzw. **planbar**
eingetragen. Anleitung, benötigte Versionen von lagra und planbar, Rechte und Fehlermeldungen:
[API_SETUP.md](../API_SETUP.md#lagra).

Auf dem Kiosk selbst braucht nur lagra eine Einstellung: Solange die Firewall im Büro kein NAT-Loopback
macht, muss der Kiosk den Namen von lagra auf die interne Adresse auflösen:

```bash
echo '192.168.19.185 lagra.schnyder-werbung.ch' | sudo tee -a /etc/hosts
getent hosts lagra.schnyder-werbung.ch      # → 192.168.19.185
```

Den Eintrag wieder entfernen, sobald NAT-Loopback aktiv ist. Nicht `http://<IP>:3000` als lagra-Adresse
verwenden – das umgeht TLS und schickt das Token im Klartext durchs Netz.

Das lagra-Token hat volle API-Rechte und der planbar-Schlüssel je nach Recht auch Schreibrechte: Beide
nur für diesen Kiosk verwenden und bei Verlust oder Austausch des Geräts in lagra (/schnittstellen) bzw.
planbar (Unternehmen → API-Schlüssel) widerrufen.

## Bildschirm ein/aus

SlateDesk schaltet den Bildschirm nach dem Zeitplan (Fernsteuerung → **Kiosk → Bildschirmzeiten**),
über das Ruhemodus-Widget und auf Knopfdruck in der Fernsteuerung. Es probiert die Wege der Reihe nach –
GNOME Mutter, `wlr-randr`, `kscreen-doctor`, `xset` (nur echtes X11, nicht Xwayland), `vcgencmd` – und
merkt sich den ersten, der funktioniert. Welcher Weg greift, nennt die Meldung nach «Bildschirm aus» in
der Fernsteuerung (z. B. «Bildschirm ausgeschaltet (gnome-mutter)») und der Einstellungsdialog des
Ruhemodus-Widgets am Kiosk. Funktioniert keiner, deckt SlateDesk den Bildschirm schwarz ab; die
Hintergrundbeleuchtung bleibt dann an.

| Desktop | Weg | Paket |
|---|---|---|
| Ubuntu GNOME, Wayland (Standard) | Mutter D-Bus `PowerSaveMode` über `gdbus` | `libglib2.0-bin` |
| Ubuntu GNOME auf Xorg | Mutter D-Bus, sonst `xset dpms force off/on` | `x11-xserver-utils` |
| KDE Plasma | `kscreen-doctor --dpms` | `kscreen` |
| Raspberry Pi OS Bookworm (labwc/wayfire), sway | `wlr-randr --output … --off/--on` | `wlr-randr` |
| Raspberry Pi mit X11 | `xset dpms`, zuletzt `vcgencmd display_power` | `x11-xserver-utils` |

`vcgencmd display_power` wirkt mit dem KMS-Treiber (Standard seit Bullseye) nicht mehr. Die
automatische Bildschirmabschaltung des Desktops muss aus sein, sonst geht der Bildschirm ausserhalb
des Zeitplans aus: unter GNOME erledigt das `setup.sh`, auf dem Raspberry Pi
`sudo raspi-config` → *Display Options* → *Screen Blanking* → *No*.

Sitzungstyp prüfen:

```bash
loginctl show-session "$(loginctl list-sessions --no-legend | awk '$3 == "slatedesk" { print $1; exit }')" -p Type
```

## Fehlersuche

**Bildschirm schwarz, App startet nicht**

```bash
sudo systemctl --user -M slatedesk@ status slatedesk.service
sudo journalctl _SYSTEMD_USER_UNIT=slatedesk.service + USER_UNIT=slatedesk.service -n 100
ls -l /home/slatedesk/.local/opt/slatedesk/current/
sudo systemctl --user -M slatedesk@ show-environment | grep -E 'DISPLAY|WAYLAND'
```

Ist `slatedesk` nicht angemeldet, startet die App nicht – Autologin prüfen (`setup.sh --autologin`).
Fehlen `DISPLAY`/`WAYLAND_DISPLAY` in der Umgebung, kommt der Desktop ohne systemd-Integration aus;
dann startet der Autostart-Eintrag `slatedesk-session.desktop` den Dienst bei der Anmeldung.

**Weisses oder leeres Fenster:** Drop-in mit `Environment=WEBKIT_DISABLE_DMABUF_RENDERER=1` anlegen
(siehe [Dienste und Timer](#dienste-und-timer)).

**Update fehlgeschlagen:** Meldung in der Fernsteuerung (System → Update) bzw. am Ende von `update.log`.

| Meldung | Abhilfe |
|---|---|
| „Cargo.lock passt nicht zu Cargo.toml“ | Entwicklung: `Cargo.lock` aktualisieren und committen |
| „Tauri-Versionen von npm und Rust passen nicht zusammen“ | Entwicklung: `@tauri-apps/api`, `@tauri-apps/cli` und das Crate `tauri` auf dieselbe Minor-Version bringen |
| „Rust ist zu alt“ | `sudo bash /home/slatedesk/SlateDesk/scripts/setup.sh` (aktualisiert Rust) |
| „Node.js … ist zu alt“ | `setup.sh` ausführen (installiert Node.js 22) |
| „Netzwerkproblem beim Laden von Abhängigkeiten“ | wird beim nächsten Lauf erneut versucht |
| „Zu wenig Speicherplatz“ / „Kein Speicherplatz mehr frei“ | `df -h /home`; Build-Cache löschen: `sudo -u slatedesk rm -rf /home/slatedesk/SlateDesk/src-tauri/target` |
| „Keine Verbindung zu GitHub“ | Netzwerk/Proxy prüfen; `sudo -u slatedesk git -C /home/slatedesk/SlateDesk ls-remote origin` |
| „Version … wird erst mit einem neuen Commit erneut versucht“ | Fehler beheben und neu pushen, oder `auto-update.sh --force` (siehe oben) |
| „Installation per sudo/dpkg nicht möglich“ | altes Setup: `setup.sh` ausführen |

**Update hängt:** `sudo systemctl --user -M slatedesk@ status slatedesk-update.service`. Ein Lauf
wird nach 2 Stunden abgebrochen; der nächste Lauf startet neu.

**Fernsteuerung nicht erreichbar**

```bash
curl http://127.0.0.1:7380/api/health        # am Kiosk: {"ok":true,"version":"…"}
ss -ltnp | grep 7380                          # wer belegt den Port?
sudo ufw status                               # Regel für das Subnetz vorhanden?
```

Ist der Port belegt, versucht die App rund 30 Sekunden lang, ihn zu bekommen; danach nennt der Dialog
**Bearbeiten → Fernsteuerung** am Kiosk den Grund (z. B. «Port 7380 ist bereits belegt»).

**PIN vergessen:** am Kiosk unter **Bearbeiten → Fernsteuerung** ablesen, oder
`sudo grep '"pin"' /home/slatedesk/.config/com.slatedesk.app/remote.json`. Neuen PIN ohne
Fernsteuerung setzen: App stoppen, in `remote.json` den Wert von `"pin"` ändern (6–12 Ziffern; 4 oder
5 Ziffern nimmt die App noch an, warnt aber; ein ungültiger Wert oder eine gelöschte Datei ergibt beim
Start einen neuen Zufalls-PIN), App starten.

**Zwei Fenster, Port 7380 belegt:** Reste des alten Setups starten die App zusätzlich – `setup.sh`
ausführen (beendet und entfernt die alten Startwege).

**Bildschirm geht nach einigen Minuten aus:**
`sudo -u slatedesk dbus-run-session gsettings get org.gnome.desktop.session idle-delay` muss
`uint32 0` liefern, sonst `setup.sh` erneut ausführen.

**Kamera oder Mikrofon fehlen** (Gesichtserkennung, Ruhemodus, KI-Assistent): `slatedesk` muss die
aktive Sitzung am Gerät haben (Autologin); für Kameras unter WebKitGTK wird
`gstreamer1.0-plugins-good` benötigt.

**lagra, planbar und andere Datenquellen:** Meldungen und Abhilfe in [API_SETUP.md](../API_SETUP.md).

## Deinstallation

`--purge` löscht den Benutzer nur, wenn `setup.sh` ihn angelegt hat (Kommentar «SlateDesk Kiosk»).
Läuft SlateDesk im persönlichen Konto (z. B. unter zenOS), werden nur die SlateDesk-Daten entfernt.

```bash
# App, Dienste, Timer (samt Drop-ins), installierte Versionen, Update-Protokoll,
# Reste des alten Setups und ufw-Regel entfernen
sudo bash /home/slatedesk/SlateDesk/scripts/uninstall.sh

# zusätzlich alle Daten und den Benutzer slatedesk samt Home-Verzeichnis und Autologin löschen
sudo bash /home/slatedesk/SlateDesk/scripts/uninstall.sh --purge
```

Ohne `--purge` bleiben `~/.config/com.slatedesk.app` (Dashboard, PIN), die WebKit-Daten, die vor der
Migration angelegte Sicherung der WebKit-Daten (`~/.local/state/slatedesk/backup`), der Checkout und
die automatische Anmeldung erhalten. Als `slatedesk` ohne root ausgeführt, entfernt das Script nur
dessen eigene Installation (mit `--purge` auch dessen Daten, nicht aber den Benutzer).

## Dateien in `scripts/`

| Datei | Zweck |
|---|---|
| `setup.sh` | Installation, Reparatur und Migration (als root) |
| `auto-update.sh` | Update-Lauf (als `slatedesk`, über `slatedesk-update.service`) |
| `uninstall.sh` | Deinstallation |
| `session-start.sh` | Start des User-Dienstes bei der Anmeldung (Autostart) |
| `systemd/*.service`, `systemd/*.timer` | User-Units, werden bei Updates automatisch übernommen |
| `setup-auto-update.sh`, `hourly-restart.sh` | veraltet: Weiterleitung auf `setup.sh` bzw. wirkungslos, damit alte Aufrufe nicht stören |
