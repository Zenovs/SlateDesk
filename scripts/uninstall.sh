#!/usr/bin/env bash
#
# SlateDesk deinstallieren
#
#   sudo bash scripts/uninstall.sh [--user NAME] [--purge] [-y]
#   bash scripts/uninstall.sh            (als Kiosk-Benutzer, ohne root)
#
# Standard: Dienste und Timer stoppen und entfernen, ~/.local/opt/slatedesk und
# das Update-Protokoll löschen. Dashboard-Daten (~/.config/com.slatedesk.app),
# die vor der Migration angelegte Sicherung der WebKit-Daten
# (~/.local/state/slatedesk/backup) und der Git-Checkout bleiben erhalten. Als
# root zusätzlich: Reste des alten Setups (dpkg-Paket, sudoers, Cron,
# Systemdienste) und die ufw-Regel.
#
# --purge löscht ausserdem alle Daten (auch die Sicherung) und – als root – den
# Kiosk-Benutzer samt Home-Verzeichnis und Autologin-Eintrag.
#
set -Eeuo pipefail

usage() {
    cat <<'EOF'
Verwendung: sudo bash uninstall.sh [Optionen]
       bash uninstall.sh [Optionen]      (als Kiosk-Benutzer)

Entfernt SlateDesk (Dienste, Timer, installierte Versionen, Update-Protokoll).
Die Dashboard-Daten (~/.config/com.slatedesk.app) und die Sicherung der
WebKit-Daten von der Migration (~/.local/state/slatedesk/backup) bleiben erhalten.

Optionen:
  --user NAME   Kiosk-Benutzer (Standard: slatedesk; nur als root)
  --purge       Zusätzlich alle Daten löschen (Dashboard-Zustand, PIN,
                WebKit-Daten und deren Sicherung); als root auch den Benutzer
                samt Home-Verzeichnis
  -y, --yes     Ohne Rückfrage ausführen
  -h, --help    Diese Hilfe anzeigen
EOF
}

init_globals() {
    SD_USER=""
    OPT_PURGE=0
    OPT_YES=0
    IS_ROOT=0
    USER_EXISTS=0
    SD_HOME=""
    SD_UID=""
    UNITS=(slatedesk-update.timer slatedesk-restart.timer slatedesk-update.service slatedesk-restart.service slatedesk.service)
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --user) SD_USER=${2:?--user braucht einen Namen}; shift ;;
            --user=*) SD_USER=${1#*=} ;;
            --purge) OPT_PURGE=1 ;;
            -y | --yes) OPT_YES=1 ;;
            -h | --help) usage; exit 0 ;;
            *) printf 'Unbekannte Option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
        esac
        shift
    done
}

init_colors() {
    if [ -t 1 ]; then
        C_RED=$'\033[0;31m' C_GREEN=$'\033[0;32m' C_YELLOW=$'\033[1;33m'
        C_BLUE=$'\033[0;34m' C_BOLD=$'\033[1m' C_OFF=$'\033[0m'
    else
        C_RED="" C_GREEN="" C_YELLOW="" C_BLUE="" C_BOLD="" C_OFF=""
    fi
}

info() { printf '%s•%s %s\n' "$C_BLUE" "$C_OFF" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

confirm() {
    local answer=""
    [ "$OPT_YES" -eq 1 ] && return 0
    if [ -t 0 ] || (: </dev/tty) 2>/dev/null; then
        printf '%s? %s [j/N] ' "$C_BOLD" "$1$C_OFF" >/dev/tty
        read -r answer </dev/tty || return 1
        case "$answer" in [jJyY]*) return 0 ;; esac
        return 1
    fi
    die "Kein Terminal für die Rückfrage – zum Bestätigen --yes angeben."
}

# Befehl als Kiosk-Benutzer (direkt, wenn das Script schon als dieser läuft).
as_user() {
    if [ "$IS_ROOT" -eq 0 ]; then
        "$@"
        return
    fi
    (cd / && runuser -u "$SD_USER" -- env -i "HOME=$SD_HOME" "USER=$SD_USER" "LOGNAME=$SD_USER" \
        "PATH=/usr/local/bin:/usr/bin:/bin" "XDG_RUNTIME_DIR=/run/user/$SD_UID" \
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$SD_UID/bus" "$@")
}

resolve_user() {
    if [ "$(id -u)" -eq 0 ]; then
        IS_ROOT=1
        SD_USER=${SD_USER:-slatedesk}
    else
        if [ -n "$SD_USER" ] && [ "$SD_USER" != "$(id -un)" ]; then
            die "--user geht nur als root."
        fi
        SD_USER=$(id -un)
    fi
    if id "$SD_USER" >/dev/null 2>&1; then
        USER_EXISTS=1
        SD_UID=$(id -u "$SD_USER")
        SD_HOME=$(getent passwd "$SD_USER" | cut -d : -f 6)
        [ "$SD_UID" -ne 0 ] || die "Der Kiosk-Benutzer darf nicht root sein."
        [[ $SD_HOME == /* ]] && [ "$SD_HOME" != "/" ] || die "Ungültiges Home-Verzeichnis für $SD_USER: '$SD_HOME'"
    elif [ "$IS_ROOT" -eq 1 ]; then
        warn "Benutzer $SD_USER existiert nicht – entferne nur systemweite Reste."
    fi
}

remove_user_install() {
    local unit_dir="$SD_HOME/.config/systemd/user" u
    if [ -d "/run/user/$SD_UID" ]; then
        as_user systemctl --user disable --now "${UNITS[@]}" >/dev/null 2>&1 || true
        as_user systemctl --user stop 'slatedesk-legacy-*' 'slatedesk-update-manual*' >/dev/null 2>&1 || true
    fi
    pkill -TERM -u "$SD_UID" -x slate-desk 2>/dev/null || true
    for u in "${UNITS[@]}"; do
        rm -f "${unit_dir:?}/$u"
        rm -rf "${unit_dir:?}/$u.d"
        rm -f "$unit_dir"/*.wants/"$u"
    done
    if [ -d "/run/user/$SD_UID" ]; then
        as_user systemctl --user daemon-reload >/dev/null 2>&1 || true
        as_user systemctl --user reset-failed >/dev/null 2>&1 || true
    fi
    ok "Dienste und Timer entfernt."

    rm -f "$SD_HOME/.config/autostart/slatedesk-session.desktop" "$SD_HOME/.config/autostart/slatedesk.desktop"
    rm -rf "${SD_HOME:?}/.local/opt/slatedesk"
    remove_state_dir
    ok "Installierte Versionen (~/.local/opt/slatedesk) und Update-Protokoll entfernt."
}

# ~/.local/state/slatedesk: Update-Protokoll, Status- und Markerdateien. Die
# Sicherung der WebKit-Daten (backup/, von setup.sh vor dem ersten Start der
# neuen Version angelegt) ist der einzige Weg zurück zum alten Layout und
# bleibt ohne --purge erhalten.
remove_state_dir() {
    local state="${SD_HOME:?}/.local/state/slatedesk" entry kept=0
    [ -d "$state" ] || return 0
    if [ "$OPT_PURGE" -eq 1 ]; then
        rm -rf "$state"
        return 0
    fi
    for entry in "$state"/* "$state"/.[!.]* "$state"/..?*; do
        [ -e "$entry" ] || [ -L "$entry" ] || continue
        if [ "${entry##*/}" = "backup" ] && [ -d "$entry" ] && [ ! -L "$entry" ]; then
            kept=1
            continue
        fi
        rm -rf -- "$entry"
    done
    if [ "$kept" -eq 1 ]; then
        info "Sicherung der WebKit-Daten bleibt erhalten: $state/backup"
    else
        rmdir "$state" 2>/dev/null || true
    fi
}

remove_legacy() {
    local f cron filtered tmp removed=0
    for f in /etc/systemd/system/slatedesk*.service /etc/systemd/system/slatedesk*.timer; do
        [ -f "$f" ] || continue
        systemctl disable --now "${f##*/}" >/dev/null 2>&1 || true
        rm -f "$f"
        removed=1
    done
    if [ "$removed" -eq 1 ]; then
        systemctl daemon-reload
        ok "Alte Systemdienste entfernt."
    fi
    if [ -f /etc/sudoers.d/slatedesk-update ]; then
        rm -f /etc/sudoers.d/slatedesk-update
        ok "sudo-Regel entfernt."
    fi
    if [ "$USER_EXISTS" -eq 1 ] && command -v crontab >/dev/null 2>&1; then
        if cron=$(crontab -u "$SD_USER" -l 2>/dev/null); then
            filtered=$(grep -Ev 'scripts/(auto-update|hourly-restart)\.sh|^# SlateDesk Auto-Update' <<<"$cron" || true)
            if [ "$filtered" != "$cron" ]; then
                if [ -z "${filtered//[[:space:]]/}" ]; then
                    crontab -u "$SD_USER" -r
                else
                    tmp=$(mktemp)
                    printf '%s\n' "$filtered" >"$tmp"
                    crontab -u "$SD_USER" "$tmp"
                    rm -f "$tmp"
                fi
                ok "Alte Cron-Einträge entfernt."
            fi
        fi
    fi
    if [ "$(dpkg-query -W -f='${Status}' slate-desk 2>/dev/null || true)" = "install ok installed" ]; then
        if dpkg -r slate-desk >/dev/null; then ok "Altes Paket slate-desk entfernt."; else warn "dpkg -r slate-desk fehlgeschlagen."; fi
    fi
    if [ "$USER_EXISTS" -eq 1 ] && [ -d "$SD_HOME/.slatedesk-backups" ]; then
        rm -rf "${SD_HOME:?}/.slatedesk-backups"
    fi
}

remove_ufw_rules() {
    local n
    command -v ufw >/dev/null 2>&1 || return 0
    # von hinten löschen, damit die Nummern stimmen
    for n in $(LC_ALL=C ufw status numbered 2>/dev/null |
        awk '/SlateDesk Fernsteuerung/ && match($0, /^\[ *[0-9]+\]/) { n = substr($0, RSTART, RLENGTH); gsub(/[^0-9]/, "", n); print n }' |
        sort -rn); do
        ufw --force delete "$n" >/dev/null && ok "ufw-Regel $n (SlateDesk Fernsteuerung) entfernt."
    done
}

# Lüftersteuerung (configure_fan_access in setup.sh); die Lüfter selbst gibt SlateDesk beim
# Beenden an das BIOS zurück.
remove_fan_access() {
    local removed=0
    if [ -f /etc/udev/rules.d/90-slatedesk-fans.rules ]; then
        rm -f /etc/udev/rules.d/90-slatedesk-fans.rules && removed=1
    fi
    if [ -f /usr/local/lib/slatedesk/fan-access ]; then
        rm -f /usr/local/lib/slatedesk/fan-access && removed=1
        rmdir /usr/local/lib/slatedesk 2>/dev/null || true
    fi
    [ "$removed" -eq 1 ] || return 0
    if command -v udevadm >/dev/null 2>&1; then udevadm control --reload >/dev/null 2>&1 || true; fi
    ok "Lüftersteuerung entfernt (udev-Regel; die Rechte gelten bis zum nächsten Neustart)."
}

# Watchdog (configure_watchdog in setup.sh); der Treiber bleibt bis zum Neustart geladen.
remove_watchdog() {
    local removed=0
    if [ -f /etc/systemd/system.conf.d/90-slatedesk-watchdog.conf ]; then
        rm -f /etc/systemd/system.conf.d/90-slatedesk-watchdog.conf && removed=1
    fi
    if [ -f /etc/systemd/system/slatedesk-watchdog.service ]; then
        systemctl disable slatedesk-watchdog.service >/dev/null 2>&1 || true
        rm -f /etc/systemd/system/slatedesk-watchdog.service && removed=1
        systemctl daemon-reload >/dev/null 2>&1 || true
    fi
    [ "$removed" -eq 1 ] || return 0
    systemctl daemon-reexec >/dev/null 2>&1 || true
    ok "Watchdog entfernt."
}

remove_autologin() {
    local conf tmp
    for conf in /etc/gdm3/custom.conf /etc/gdm/custom.conf; do
        [ -f "$conf" ] || continue
        grep -Eq "^[[:space:]]*AutomaticLogin[[:space:]]*=[[:space:]]*${SD_USER}[[:space:]]*$" "$conf" || continue
        tmp=$(mktemp)
        sed -E -e "/^[[:space:]]*AutomaticLogin[[:space:]]*=[[:space:]]*${SD_USER}[[:space:]]*$/d" \
            -e 's/^([[:space:]]*AutomaticLoginEnable[[:space:]]*=[[:space:]]*).*/\1false/' "$conf" >"$tmp"
        cat "$tmp" >"$conf"
        rm -f "$tmp"
        ok "GDM-Autologin für $SD_USER entfernt ($conf)."
    done
    for conf in /etc/lightdm/lightdm.conf /etc/lightdm/lightdm.conf.d/*.conf; do
        [ -f "$conf" ] || continue
        grep -Eq "^[[:space:]]*autologin-user[[:space:]]*=[[:space:]]*${SD_USER}[[:space:]]*$" "$conf" || continue
        if [ "${conf##*/}" = "50-slatedesk-autologin.conf" ]; then
            rm -f "$conf"
        else
            sed -i -E "/^[[:space:]]*autologin-user[[:space:]]*=[[:space:]]*${SD_USER}[[:space:]]*$/d" "$conf"
        fi
        ok "LightDM-Autologin für $SD_USER entfernt ($conf)."
    done
}

purge_data() {
    rm -rf "${SD_HOME:?}/.config/com.slatedesk.app" "${SD_HOME:?}/.local/share/com.slatedesk.app" \
        "${SD_HOME:?}/.cache/com.slatedesk.app"
    ok "Dashboard-Daten, PIN und WebKit-Daten gelöscht."
}

# Nur ein von setup.sh angelegtes Konto (Kommentar «SlateDesk Kiosk») darf gelöscht werden –
# läuft SlateDesk im persönlichen Konto (z. B. unter zenOS), bleibt das Konto samt Home stehen.
created_by_setup() {
    [ "$(getent passwd "$SD_USER" | cut -d : -f 5)" = "SlateDesk Kiosk" ]
}

purge_user() {
    local i
    if ! created_by_setup; then
        purge_data
        warn "Benutzer $SD_USER wurde nicht von setup.sh angelegt und bleibt erhalten (nur SlateDesk-Daten gelöscht)."
        return 0
    fi
    remove_autologin
    loginctl disable-linger "$SD_USER" 2>/dev/null || true
    loginctl terminate-user "$SD_USER" 2>/dev/null || true
    for ((i = 0; i < 20; i++)); do
        pgrep -u "$SD_UID" >/dev/null 2>&1 || break
        pkill -KILL -u "$SD_UID" 2>/dev/null || true
        sleep 0.5
    done
    userdel -r "$SD_USER" 2>/dev/null || userdel "$SD_USER" || die "Benutzer $SD_USER konnte nicht gelöscht werden (laufen noch Prozesse?)."
    [ -d "$SD_HOME" ] && rm -rf "${SD_HOME:?}"
    ok "Benutzer $SD_USER samt $SD_HOME gelöscht."
}

main() {
    init_globals
    init_colors
    parse_args "$@"
    trap 'printf "%s✗ Fehler in Zeile %s (Exit %s): %s%s\n" "$C_RED" "$LINENO" "$?" "$BASH_COMMAND" "$C_OFF" >&2' ERR
    resolve_user

    printf '%sSlateDesk entfernen%s (Benutzer: %s)\n' "$C_BOLD" "$C_OFF" "$SD_USER"
    if [ "$USER_EXISTS" -eq 1 ]; then
        info "Dienste/Timer stoppen und entfernen, ~/.local/opt/slatedesk und das Update-Protokoll (~/.local/state/slatedesk) löschen"
    fi
    if [ "$IS_ROOT" -eq 1 ]; then
        info "Reste des alten Setups (dpkg-Paket, sudoers, Cron, Systemdienste), ufw-Regel, Lüftersteuerung und Watchdog entfernen"
    fi
    if [ "$OPT_PURGE" -eq 1 ] && [ "$USER_EXISTS" -eq 1 ]; then
        info "--purge: ~/.config/com.slatedesk.app (Dashboard, PIN), WebKit-Daten samt Sicherung und Cache löschen"
        if [ "$IS_ROOT" -eq 1 ] && created_by_setup; then
            info "--purge: Benutzer $SD_USER mit Home-Verzeichnis $SD_HOME (inkl. Git-Checkout) löschen"
        elif [ "$IS_ROOT" -eq 1 ]; then
            info "--purge: Benutzer $SD_USER bleibt erhalten (nicht von setup.sh angelegt)"
        fi
    else
        info "Erhalten bleiben: ~/.config/com.slatedesk.app (Dashboard-Zustand, PIN), ~/.local/state/slatedesk/backup und ~/SlateDesk"
    fi
    confirm "Fortfahren" || die "Abgebrochen."

    if [ "$USER_EXISTS" -eq 1 ]; then
        remove_user_install
    fi
    if [ "$IS_ROOT" -eq 1 ]; then
        remove_legacy
        remove_ufw_rules
        remove_fan_access
        remove_watchdog
    fi
    if [ "$OPT_PURGE" -eq 1 ] && [ "$USER_EXISTS" -eq 1 ]; then
        if [ "$IS_ROOT" -eq 1 ]; then
            purge_user
        else
            purge_data
            info "Den Benutzer selbst kann nur root löschen: sudo bash uninstall.sh --purge"
        fi
    fi
    ok "SlateDesk wurde entfernt."
}

main "$@"; exit
