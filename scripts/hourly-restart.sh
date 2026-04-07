#!/usr/bin/env bash
#
# SlateDesk Stündlicher Neustart
# Läuft als Cron-Job zur vollen Stunde (0 * * * *)
# Beendet SlateDesk und startet es neu – verhindert Einfrieren nach langer Laufzeit.
#
export DISPLAY=:0
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"

LOG="/home/slatedesk/slatedesk-restart.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

log "--- Stündlicher Neustart ---"

# Prozesse beenden
killall slate-desk 2>/dev/null && log "slate-desk beendet" || true
killall app       2>/dev/null && log "app beendet"        || true
sleep 3

# Neustart via systemd (bevorzugt) oder direkt
if systemctl --user is-enabled slatedesk.service &>/dev/null 2>&1; then
    systemctl --user restart slatedesk.service
    log "Neustart via systemd --user"
elif systemctl is-enabled slatedesk.service &>/dev/null 2>&1; then
    systemctl restart slatedesk.service
    log "Neustart via systemd"
else
    for bin in /usr/bin/slate-desk /usr/bin/app; do
        if [ -x "$bin" ]; then
            nohup "$bin" &>/dev/null &
            log "Neustart direkt: $bin"
            break
        fi
    done
fi

log "Neustart abgeschlossen."
