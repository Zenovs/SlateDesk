#!/usr/bin/env bash
#
# SlateDesk Auto-Update Script
# Wird per Cronjob (01:00 Uhr) oder beim Boot ausgeführt.
# Prüft auf neue Commits, baut neu, installiert und startet SlateDesk.
#
# Exit-Codes:
#   0 = Erfolg (Update durchgeführt oder kein Update nötig)
#   1 = Fehler (Rollback wurde versucht)
#   2 = Fataler Fehler (kein Rollback möglich)
#
set -euo pipefail

# ─── PATH sicherstellen (für Cron/systemd ohne Login-Shell) ─────────────────
export PATH="/usr/local/bin:/usr/bin:/bin:/home/slatedesk/.cargo/bin"
[ -s "/home/slatedesk/.nvm/nvm.sh" ] && source "/home/slatedesk/.nvm/nvm.sh"
[ -f "/home/slatedesk/.cargo/env" ] && source "/home/slatedesk/.cargo/env"

# ─── Konfiguration ───────────────────────────────────────────────────────────
SLATEDESK_HOME="${SLATEDESK_HOME:-/home/slatedesk/SlateDesk}"
LOG_FILE="${SLATEDESK_LOG:-/home/slatedesk/slatedesk-update.log}"
BACKUP_DIR="/home/slatedesk/.slatedesk-backups"
DEB_PATH="src-tauri/target/release/bundle/deb"
PACKAGE_NAME="slate-desk"
MAX_BACKUPS=5
LOCK_FILE="/tmp/slatedesk-update.lock"

# ─── Logging ─────────────────────────────────────────────────────────────────
log() {
    local level="$1"
    shift
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*" | tee -a "$LOG_FILE"
}

log_info()  { log "INFO"  "$@"; }
log_warn()  { log "WARN"  "$@"; }
log_error() { log "ERROR" "$@"; }

# ─── Lock-Mechanismus (verhindert parallele Ausführung) ─────────────────────
cleanup() {
    rm -f "$LOCK_FILE"
}
trap cleanup EXIT

if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
        log_warn "Update läuft bereits (PID: $LOCK_PID). Abbruch."
        exit 0
    else
        log_warn "Verwaiste Lock-Datei gefunden. Wird entfernt."
        rm -f "$LOCK_FILE"
    fi
fi
echo $$ > "$LOCK_FILE"

# ─── Netzwerk-Check ──────────────────────────────────────────────────────────
wait_for_network() {
    local retries=30
    local wait_sec=10
    log_info "Warte auf Netzwerkverbindung..."
    for i in $(seq 1 $retries); do
        if ping -c 1 -W 3 github.com &>/dev/null; then
            log_info "Netzwerk verfügbar."
            return 0
        fi
        log_warn "Netzwerk nicht erreichbar (Versuch $i/$retries). Warte ${wait_sec}s..."
        sleep $wait_sec
    done
    log_error "Netzwerk nach $((retries * wait_sec))s nicht verfügbar. Abbruch."
    return 1
}

# ─── Backup erstellen ────────────────────────────────────────────────────────
create_backup() {
    log_info "Erstelle Backup..."
    mkdir -p "$BACKUP_DIR"

    # Finde aktuelle .deb Datei
    local deb_file
    deb_file=$(find "$SLATEDESK_HOME/$DEB_PATH" -name "*.deb" -type f 2>/dev/null | head -1)

    if [ -n "$deb_file" ]; then
        local timestamp
        timestamp=$(date '+%Y%m%d_%H%M%S')
        local backup_name="slatedesk_backup_${timestamp}.deb"
        cp "$deb_file" "$BACKUP_DIR/$backup_name"
        log_info "Backup erstellt: $BACKUP_DIR/$backup_name"

        # Speichere aktuellen Commit-Hash für Rollback
        cd "$SLATEDESK_HOME"
        git rev-parse HEAD > "$BACKUP_DIR/${backup_name}.commit"
    else
        log_warn "Keine bestehende .deb Datei gefunden. Kein Backup möglich."
    fi

    # Alte Backups aufräumen (behalte nur MAX_BACKUPS)
    local count
    count=$(find "$BACKUP_DIR" -name "*.deb" -type f | wc -l)
    if [ "$count" -gt "$MAX_BACKUPS" ]; then
        log_info "Räume alte Backups auf (behalte letzte $MAX_BACKUPS)..."
        find "$BACKUP_DIR" -name "*.deb" -type f -printf '%T+ %p\n' | \
            sort | head -n -"$MAX_BACKUPS" | awk '{print $2}' | \
            while read -r old_deb; do
                rm -f "$old_deb" "${old_deb}.commit"
                log_info "Altes Backup entfernt: $old_deb"
            done
    fi
}

# ─── Rollback ────────────────────────────────────────────────────────────────
rollback() {
    log_error "Fehler aufgetreten! Starte Rollback..."

    # Finde neuestes Backup
    local latest_backup
    latest_backup=$(find "$BACKUP_DIR" -name "*.deb" -type f -printf '%T+ %p\n' 2>/dev/null | \
                    sort -r | head -1 | awk '{print $2}')

    if [ -n "$latest_backup" ] && [ -f "$latest_backup" ]; then
        log_info "Rollback mit Backup: $latest_backup"

        # Deinstalliere fehlerhaftes Paket
        sudo /usr/bin/dpkg -r "$PACKAGE_NAME" 2>/dev/null || true

        # Installiere Backup
        if sudo /usr/bin/dpkg -i "$latest_backup"; then
            log_info "Rollback erfolgreich. Backup installiert."

            # Git auf alten Commit zurücksetzen
            local commit_file="${latest_backup}.commit"
            if [ -f "$commit_file" ]; then
                local old_commit
                old_commit=$(cat "$commit_file")
                cd "$SLATEDESK_HOME"
                git reset --hard "$old_commit" 2>/dev/null || true
                log_info "Git auf Commit $old_commit zurückgesetzt."
            fi

            # SlateDesk neu starten
            start_slatedesk
            return 0
        else
            log_error "Rollback fehlgeschlagen! Backup konnte nicht installiert werden."
            return 1
        fi
    else
        log_error "Kein Backup für Rollback gefunden!"
        return 1
    fi
}

# ─── DBUS für systemctl --user in System-Service-Kontext ────────────────────
setup_dbus() {
    local uid
    uid=$(id -u)
    export XDG_RUNTIME_DIR="/run/user/${uid}"
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
        export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
    fi
}

# ─── SlateDesk stoppen ───────────────────────────────────────────────────────
stop_slatedesk() {
    log_info "Stoppe SlateDesk..."
    setup_dbus
    if systemctl --user is-active slatedesk.service &>/dev/null; then
        systemctl --user stop slatedesk.service 2>/dev/null || true
    fi
    if systemctl is-active slatedesk.service &>/dev/null; then
        systemctl stop slatedesk.service 2>/dev/null || true
    fi
    killall slatedesk 2>/dev/null || true
    killall slate-desk 2>/dev/null || true
    killall app 2>/dev/null || true
    sleep 2
    log_info "SlateDesk gestoppt."
}

# ─── SlateDesk starten ───────────────────────────────────────────────────────
start_slatedesk() {
    log_info "Starte SlateDesk..."
    setup_dbus
    if systemctl is-enabled slatedesk.service &>/dev/null; then
        systemctl start slatedesk.service 2>/dev/null || true
    elif systemctl --user is-enabled slatedesk.service &>/dev/null; then
        systemctl --user start slatedesk.service 2>/dev/null || true
    else
        # Fallback: Binary direkt starten
        local bin=""
        for candidate in /usr/bin/slate-desk /usr/bin/app; do
            if [ -x "$candidate" ]; then
                bin="$candidate"
                break
            fi
        done
        if [ -n "$bin" ]; then
            DISPLAY=:0 nohup "$bin" &>/dev/null &
            log_info "SlateDesk direkt gestartet: $bin"
        else
            log_warn "Keine SlateDesk-Binary gefunden."
        fi
    fi
    sleep 2
    log_info "SlateDesk gestartet."
}

# ─── Stündlichen Neustart-Cron einrichten ────────────────────────────────────
setup_hourly_restart() {
    local script="$SLATEDESK_HOME/scripts/hourly-restart.sh"
    chmod +x "$script" 2>/dev/null || true

    local cron_marker="slatedesk-hourly-restart"
    local cron_entry="0 * * * * DISPLAY=:0 $script >> /home/slatedesk/slatedesk-restart.log 2>&1 # $cron_marker"

    if crontab -l 2>/dev/null | grep -q "$cron_marker"; then
        log_info "Stündlicher Neustart-Cron bereits vorhanden."
    else
        ( crontab -l 2>/dev/null; echo "$cron_entry" ) | crontab -
        log_info "Stündlicher Neustart-Cron eingerichtet (jede volle Stunde)."
    fi
}

# ─── Hauptlogik ──────────────────────────────────────────────────────────────
main() {
    log_info "========================================"
    log_info "SlateDesk Auto-Update gestartet"
    log_info "========================================"

    # Netzwerk prüfen
    if ! wait_for_network; then
        exit 2
    fi

    # In Projektverzeichnis wechseln
    if [ ! -d "$SLATEDESK_HOME" ]; then
        log_error "Projektverzeichnis nicht gefunden: $SLATEDESK_HOME"
        exit 2
    fi
    cd "$SLATEDESK_HOME"

    # Aktuellen Commit speichern
    local current_commit
    current_commit=$(git rev-parse HEAD)
    log_info "Aktueller Commit: $current_commit"

    # Git fetch & prüfe auf neue Commits
    log_info "Prüfe auf Updates..."
    git fetch origin main 2>&1 | tee -a "$LOG_FILE"

    local remote_commit
    remote_commit=$(git rev-parse origin/main)
    log_info "Remote Commit: $remote_commit"

    if [ "$current_commit" = "$remote_commit" ]; then
        log_info "Kein Update verfügbar. SlateDesk ist aktuell."
        log_info "========================================"
        exit 0
    fi

    log_info "Neues Update gefunden! ($current_commit -> $remote_commit)"

    # Backup erstellen
    create_backup

    # Lokale Änderungen verwerfen (Kiosk-Gerät, kein Entwicklungsrechner)
    log_info "Verwerfe lokale Änderungen..."
    git reset --hard HEAD 2>&1 | tee -a "$LOG_FILE" || true
    git clean -fd 2>&1 | tee -a "$LOG_FILE" || true

    # Git pull
    log_info "Lade neue Änderungen..."
    if ! git pull origin main 2>&1 | tee -a "$LOG_FILE"; then
        log_error "Git pull fehlgeschlagen!"
        rollback || exit 1
        exit 1
    fi

    # Prüfe ob package.json geändert wurde
    if git diff "$current_commit" HEAD --name-only | grep -q "package.json"; then
        log_info "package.json geändert. Führe npm install aus..."
        if ! npm install 2>&1 | tee -a "$LOG_FILE"; then
            log_error "npm install fehlgeschlagen!"
            rollback || exit 1
            exit 1
        fi
    else
        log_info "package.json unverändert. Überspringe npm install."
    fi

    # Prüfe ob Cargo.toml geändert wurde
    if git diff "$current_commit" HEAD --name-only | grep -q "Cargo.toml"; then
        log_info "Cargo.toml geändert. Rust-Abhängigkeiten werden beim Build aktualisiert."
    fi

    # Build
    log_info "Baue SlateDesk neu..."
    if ! npx tauri build 2>&1 | tee -a "$LOG_FILE"; then
        log_error "Build fehlgeschlagen!"
        rollback || exit 1
        exit 1
    fi

    # Finde neue .deb Datei
    local new_deb
    new_deb=$(find "$SLATEDESK_HOME/$DEB_PATH" -name "*.deb" -type f -newer "$BACKUP_DIR" 2>/dev/null | head -1)
    if [ -z "$new_deb" ]; then
        # Fallback: nimm die neueste .deb
        new_deb=$(find "$SLATEDESK_HOME/$DEB_PATH" -name "*.deb" -type f -printf '%T+ %p\n' | sort -r | head -1 | awk '{print $2}')
    fi

    if [ -z "$new_deb" ]; then
        log_error "Keine .deb Datei nach Build gefunden!"
        rollback || exit 1
        exit 1
    fi
    log_info "Neue .deb Datei: $new_deb"

    # SlateDesk stoppen
    stop_slatedesk

    # Deinstallieren
    log_info "Deinstalliere altes Paket..."
    sudo /usr/bin/dpkg -r "$PACKAGE_NAME" 2>&1 | tee -a "$LOG_FILE" || true

    # Installieren
    log_info "Installiere neues Paket: $new_deb"
    if ! sudo /usr/bin/dpkg -i "$new_deb" 2>&1 | tee -a "$LOG_FILE"; then
        log_error "Installation fehlgeschlagen!"
        rollback || exit 1
        exit 1
    fi

    # Cache leeren (localStorage, WebKit-Cache)
    log_info "Leere App-Cache..."
    rm -rf "/home/slatedesk/.local/share/com.slatedesk.app/EBWebView" 2>/dev/null || true
    rm -rf "/home/slatedesk/.local/share/com.slatedesk.app/storage" 2>/dev/null || true
    log_info "Cache geleert."

    # Stündlichen Neustart-Cron sicherstellen
    setup_hourly_restart

    # SlateDesk starten
    start_slatedesk

    log_info "========================================"
    log_info "Update erfolgreich abgeschlossen!"
    log_info "Alter Commit: $current_commit"
    log_info "Neuer Commit: $remote_commit"
    log_info "========================================"
    exit 0
}

# ─── Script starten ──────────────────────────────────────────────────────────
main "$@"
