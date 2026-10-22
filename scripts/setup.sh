#!/usr/bin/env bash
#
# SlateDesk Setup – Installation und Migration auf dem Kiosk-Gerät
#
#   sudo bash ~slatedesk/SlateDesk/scripts/setup.sh [Optionen]
#
# oder ohne vorhandenen Checkout:
#
#   curl -fsSL https://raw.githubusercontent.com/Zenovs/SlateDesk/main/scripts/setup.sh -o /tmp/slatedesk-setup.sh
#   sudo bash /tmp/slatedesk-setup.sh
#
# Richtet alles ein, was der Kiosk braucht: Pakete, Benutzer "slatedesk",
# Node.js 22 und Rust (für diesen Benutzer), Repository, ersten Build in
# ~/.local/opt/slatedesk, systemd-User-Dienste und -Timer. Ein vorhandenes
# altes Setup (dpkg-Paket, sudoers-Regel, Cron, Systemdienste, Autostart) wird
# erst entfernt, wenn die neue Version läuft; startet sie nicht, bleibt das
# alte Setup aktiv. Kann jederzeit erneut ausgeführt werden: eine neue Version
# wird dann wie bei einem Update gestartet, per Health-Check geprüft und bei
# einem Fehlstart auf die vorherige zurückgesetzt.
#
# Alles steckt in Funktionen und wird über die letzte Zeile gestartet: das
# Aktualisieren des Repositorys kann diese Datei während des Laufs ersetzen.
#
set -Eeuo pipefail

usage() {
    cat <<'EOF'
Verwendung: sudo bash setup.sh [Optionen]

Installiert SlateDesk auf dem Kiosk-Gerät bzw. migriert ein altes Setup
(dpkg-Paket + sudoers + Cron) auf systemd-User-Dienste ohne sudo.

Optionen:
  --user NAME         Kiosk-Benutzer (Standard: slatedesk)
  --repo URL          Git-Repository für einen neuen Checkout
                      (Standard: https://github.com/Zenovs/SlateDesk.git)
  --branch NAME       Update-Branch, z. B. für einen Testrechner (Standard:
                      der bisher gespeicherte, sonst main). Wird im Checkout
                      gespeichert und von jedem späteren Update verwendet.
  --autologin         Automatische Anmeldung des Kiosk-Benutzers einrichten
                      (GDM oder LightDM)
  --ufw               Firewall-Regel für die Fernsteuerung (Port 7380, nur
                      lokales Subnetz) anlegen
  --ufw-subnet CIDR   Subnetz für die ufw-Regel, z. B. 192.168.19.0/24
                      (Standard: automatisch erkannt)
  --rebuild           SlateDesk neu bauen, auch wenn die Version aktuell ist
  --skip-apt          Paketprüfung und -installation überspringen
  -y, --yes           Rückfragen mit Ja beantworten (Autologin, Firewall)
  -h, --help          Diese Hilfe anzeigen

Ohne --autologin/--ufw fragt das Script nach, wenn es interaktiv läuft, und
gibt sonst nur einen Hinweis aus. Details: docs/BETRIEB.md
EOF
}

# ─── Konfiguration ───────────────────────────────────────────────────────────
init_globals() {
    SD_USER="slatedesk"
    REPO_URL="https://github.com/Zenovs/SlateDesk.git"
    BRANCH="main"
    OPT_BRANCH=""
    REMOTE_PORT=7380
    OPT_AUTOLOGIN=0
    OPT_UFW=0
    UFW_SUBNET=""
    OPT_REBUILD=0
    OPT_SKIP_APT=0
    OPT_YES=0

    APT_REQUIRED=(
        curl git ca-certificates build-essential pkg-config
        libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev
        librsvg2-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev libxdo-dev
        iputils-ping iproute2
    )
    # Display-Steuerung (xset, wlr-randr, gdbus) – nicht überall verfügbar
    APT_OPTIONAL=(x11-xserver-utils wlr-randr libglib2.0-bin)

    SD_HOME=""
    SD_UID=""
    SD_GROUP=""
    REPO_DIR=""
    AUTO_UPDATE=""
    SELF_SNAPSHOT=""
    RELEASE_CHANGED=0
    APP_HEALTHY=0
    SESSION_ACTIVE=0

    LEGACY_UNITS=()
    LEGACY_UNITS_RESTORE=()
    HAS_LEGACY_PKG=0
    HAS_LEGACY_AUTOSTART=0
    HAS_OLD_USER_UNIT=0
    HAS_LEGACY_CRON=0
    HAS_LEGACY_SUDOERS=0
    LEGACY_LAUNCHERS=0
    LEGACY_ANY=0
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --user) SD_USER=${2:?--user braucht einen Namen}; shift ;;
            --user=*) SD_USER=${1#*=} ;;
            --repo) REPO_URL=${2:?--repo braucht eine URL}; shift ;;
            --repo=*) REPO_URL=${1#*=} ;;
            --branch) OPT_BRANCH=${2:?--branch braucht einen Namen}; shift ;;
            --branch=*) OPT_BRANCH=${1#*=} ;;
            --autologin) OPT_AUTOLOGIN=1 ;;
            --ufw) OPT_UFW=1 ;;
            --ufw-subnet) OPT_UFW=1; UFW_SUBNET=${2:?--ufw-subnet braucht ein Subnetz}; shift ;;
            --ufw-subnet=*) OPT_UFW=1; UFW_SUBNET=${1#*=} ;;
            --rebuild) OPT_REBUILD=1 ;;
            --skip-apt) OPT_SKIP_APT=1 ;;
            -y | --yes) OPT_YES=1 ;;
            -h | --help) usage; exit 0 ;;
            *) printf 'Unbekannte Option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
        esac
        shift
    done
}

# ─── Ausgabe ─────────────────────────────────────────────────────────────────
init_colors() {
    if [ -t 1 ]; then
        C_RED=$'\033[0;31m' C_GREEN=$'\033[0;32m' C_YELLOW=$'\033[1;33m'
        C_BLUE=$'\033[0;34m' C_BOLD=$'\033[1m' C_OFF=$'\033[0m'
    else
        C_RED="" C_GREEN="" C_YELLOW="" C_BLUE="" C_BOLD="" C_OFF=""
    fi
}

step() { printf '\n%s== %s ==%s\n' "$C_BOLD" "$*" "$C_OFF"; }
info() { printf '%s•%s %s\n' "$C_BLUE" "$C_OFF" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$C_RED" "$*" "$C_OFF" >&2; exit 1; }

interactive() { [ -t 0 ] || (: </dev/tty) 2>/dev/null; }

# ask "Frage" → 0 = Ja. Standard ist Ja; ohne Terminal und ohne --yes: Nein.
ask() {
    local answer=""
    if [ "$OPT_YES" -eq 1 ]; then return 0; fi
    if ! interactive; then return 1; fi
    printf '%s? %s [J/n] ' "$C_BOLD" "$1$C_OFF" >/dev/tty
    read -r answer </dev/tty || return 1
    case "$answer" in
        "" | [jJyY]*) return 0 ;;
        *) return 1 ;;
    esac
}

on_err() {
    printf '%s✗ Abbruch: Fehler in Zeile %s (Exit %s): %s%s\n' "$C_RED" "$2" "$1" "$3" "$C_OFF" >&2
}

on_exit() {
    if [ -n "$SELF_SNAPSHOT" ]; then rm -f "$SELF_SNAPSHOT"; fi
}

# ─── Hilfsfunktionen ─────────────────────────────────────────────────────────
# Befehl als Kiosk-Benutzer, mit sauberer Umgebung und Zugriff auf dessen
# systemd-User-Manager.
as_user() {
    local -a envs=(
        "HOME=$SD_HOME" "USER=$SD_USER" "LOGNAME=$SD_USER" "SHELL=/bin/bash"
        "PATH=$SD_HOME/.cargo/bin:$SD_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
        "XDG_RUNTIME_DIR=/run/user/$SD_UID"
        "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$SD_UID/bus"
        "LANG=${LANG:-C.UTF-8}" "TERM=${TERM:-dumb}"
    )
    local v
    for v in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
        if [ -n "${!v:-}" ]; then envs+=("$v=${!v}"); fi
    done
    (cd "$SD_HOME" && runuser -u "$SD_USER" -- env -i "${envs[@]}" "$@")
}

user_systemctl() { as_user systemctl --user "$@"; }

pkg_installed() {
    [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)" = "install ok installed" ]
}

snapshot_self() {
    local src=${BASH_SOURCE[0]:-}
    if [ -n "$src" ] && [ -f "$src" ] && [ -r "$src" ]; then
        SELF_SNAPSHOT=$(mktemp)
        cat "$src" >"$SELF_SNAPSHOT"
    fi
}

# INI-Datei: in [section] alle Zeilen zu den Schlüsseln (auch auskommentierte)
# durch die übergebenen Zeilen ersetzen; Abschnitt notfalls anhängen.
ini_replace_keys() {
    local file=$1 section=$2 keys=$3
    shift 3
    local tmp
    tmp=$(mktemp)
    INI_SECTION="[$section]" INI_KEYS="$keys" INI_LINES="$(printf '%s\n' "$@")" awk '
        function emit(   n, i, arr) {
            n = split(ENVIRON["INI_LINES"], arr, "\n")
            for (i = 1; i <= n; i++) if (arr[i] != "") print arr[i]
            done = 1
        }
        /^[ \t]*\[/ {
            in_sec = ($0 == ENVIRON["INI_SECTION"])
            print
            if (in_sec && !done) emit()
            next
        }
        in_sec && $0 ~ ("^[#; \t]*(" ENVIRON["INI_KEYS"] ")[ \t]*=") { next }
        { print }
        END { if (!done) { print ""; print ENVIRON["INI_SECTION"]; emit() } }
    ' "$file" >"$tmp"
    cat "$tmp" >"$file"
    rm -f "$tmp"
}

# ─── Pakete, Benutzer, Werkzeuge ─────────────────────────────────────────────
ensure_bootstrap_packages() {
    local -a missing=()
    local p
    for p in git curl ca-certificates xz-utils; do
        pkg_installed "$p" || missing+=("$p")
    done
    [ ${#missing[@]} -gt 0 ] || return 0
    info "Installiere ${missing[*]}…"
    apt_get update -q || warn "apt-get update fehlgeschlagen."
    apt_get install -y -q "${missing[@]}" || die "Installation von ${missing[*]} fehlgeschlagen."
}

# apt ohne jede Rückfrage: keine Eingabe vom Terminal (install.sh hängt setup.sh
# an /dev/tty), needrestart ausgesetzt, vorhandene Konfigurationsdateien behalten.
apt_get() {
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l NEEDRESTART_SUSPEND=1 \
        apt-get -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@" </dev/null
}

install_packages() {
    local -a missing=() optional=()
    local p
    for p in "${APT_REQUIRED[@]}"; do
        pkg_installed "$p" || missing+=("$p")
    done
    for p in "${APT_OPTIONAL[@]}"; do
        pkg_installed "$p" || optional+=("$p")
    done
    if [ ${#missing[@]} -eq 0 ] && [ ${#optional[@]} -eq 0 ]; then
        ok "Alle benötigten Pakete sind installiert."
        return 0
    fi
    export DEBIAN_FRONTEND=noninteractive
    apt_get update -q || warn "apt-get update fehlgeschlagen – versuche es mit den vorhandenen Paketlisten."
    if [ ${#missing[@]} -gt 0 ]; then
        info "Installiere: ${missing[*]}"
        apt_get install -y -q "${missing[@]}" || die "Paketinstallation fehlgeschlagen."
    fi
    for p in "${optional[@]}"; do
        if apt-cache show "$p" >/dev/null 2>&1; then
            apt_get install -y -q "$p" || warn "Optionales Paket $p konnte nicht installiert werden."
        else
            info "Optionales Paket $p ist in den Paketquellen nicht verfügbar – übersprungen."
        fi
    done
    ok "Pakete installiert."
}

ensure_user() {
    if id "$SD_USER" >/dev/null 2>&1; then
        ok "Benutzer $SD_USER vorhanden."
    else
        useradd -m -s /bin/bash -c "SlateDesk Kiosk" "$SD_USER" || die "Benutzer $SD_USER konnte nicht angelegt werden."
        ok "Benutzer $SD_USER angelegt (ohne Passwort, ohne sudo)."
    fi
    SD_UID=$(id -u "$SD_USER")
    SD_GROUP=$(id -gn "$SD_USER")
    SD_HOME=$(getent passwd "$SD_USER" | cut -d : -f 6)
    REPO_DIR="$SD_HOME/SlateDesk"
    AUTO_UPDATE="$REPO_DIR/scripts/auto-update.sh"
    [ "$SD_UID" -ne 0 ] || die "Der Kiosk-Benutzer darf nicht root sein."
    [ -d "$SD_HOME" ] || die "Home-Verzeichnis $SD_HOME von $SD_USER fehlt."
}

# Linger: der User-Manager (Dienste, Timer) läuft auch ohne Anmeldung.
ensure_user_manager() {
    local i
    loginctl enable-linger "$SD_USER" || warn "loginctl enable-linger $SD_USER fehlgeschlagen."
    for ((i = 0; i < 40; i++)); do
        if [ -S "/run/user/$SD_UID/systemd/private" ]; then
            ok "systemd-User-Manager für $SD_USER läuft (Linger aktiv)."
            return 0
        fi
        sleep 0.5
    done
    systemctl start "user@$SD_UID.service" || true
    [ -S "/run/user/$SD_UID/systemd/private" ] || die "Der systemd-User-Manager von $SD_USER startet nicht."
}

# Vite 8 verlangt Node ^20.19 oder >= 22.12
node_version_ok() {
    local v=${1#v} major minor
    major=${v%%.*}
    minor=${v#*.}
    minor=${minor%%.*}
    [[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || return 1
    ((major > 22 || (major == 22 && minor >= 12) || (major == 20 && minor >= 19)))
}

# Node.js gehört wie Rust dem Kiosk-Benutzer (~/.local/opt/nodejs, Befehle in
# ~/.local/bin): offizielles Archiv von nodejs.org mit Prüfsumme, ohne apt –
# ein apt-Lauf startet die Hooks des Systems, und hängt einer, hängt alles.
ensure_node() {
    local current=""
    current=$(as_user node -v 2>/dev/null || true)
    if [ -n "$current" ] && node_version_ok "$current" && as_user npm -v >/dev/null 2>&1; then
        ok "Node.js $current und npm $(as_user npm -v 2>/dev/null) vorhanden."
        return 0
    fi
    [ -n "$current" ] && info "Node.js $current ist zu alt oder ohne npm."
    info "Installiere Node.js 22 für $SD_USER (nodejs.org, ohne apt)…"
    as_user bash "$REPO_DIR/scripts/install-node.sh" || die "Node.js-Installation fehlgeschlagen."
    current=$(as_user node -v 2>/dev/null || true)
    node_version_ok "$current" || die "Node.js ${current:-fehlt} – benötigt wird 22.12 oder neuer."
    ok "Node.js $current für $SD_USER bereit."
}

# Rust gehört dem Kiosk-Benutzer (rustup in ~/.cargo), denn er baut die Updates.
ensure_rust() {
    if [ -x "$SD_HOME/.cargo/bin/rustup" ]; then
        info "Aktualisiere Rust (stable) für $SD_USER…"
        if ! as_user "$SD_HOME/.cargo/bin/rustup" update stable --no-self-update; then
            warn "rustup update fehlgeschlagen – vorhandene Version wird verwendet."
        fi
        as_user "$SD_HOME/.cargo/bin/rustup" default stable >/dev/null || warn "rustup default stable fehlgeschlagen."
    else
        info "Installiere Rust (rustup) für $SD_USER…"
        # shellcheck disable=SC2016 # wird in der Shell des Kiosk-Benutzers ausgewertet
        as_user sh -c 'set -e
            tmp=$(mktemp)
            trap "rm -f \"$tmp\"" EXIT
            curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs -o "$tmp"
            sh "$tmp" -y --profile minimal --default-toolchain stable' ||
            die "Rust-Installation fehlgeschlagen."
    fi
    ok "$(as_user "$SD_HOME/.cargo/bin/cargo" --version 2>/dev/null || echo 'cargo ?') für $SD_USER bereit."
}

# ─── Repository ──────────────────────────────────────────────────────────────
# Altes Setup: auto-update.sh hält ohne installed-commit HEAD für die
# installierte Version. Bevor HEAD unten verschoben wird, den bisherigen Stand
# festhalten – sonst gilt ein abgebrochenes Setup als "aktuell", und das alte
# Paket würde nie mehr aktualisiert.
seed_legacy_installed_commit() {
    local state="$SD_HOME/.local/state/slatedesk" head
    pkg_installed slate-desk || return 0
    [ -e "$state/installed-commit" ] && return 0
    head=$(as_user git -C "$REPO_DIR" rev-parse --verify -q HEAD 2>/dev/null || true)
    [[ $head =~ ^[0-9a-f]{40}$ ]] || return 0
    as_user mkdir -p "$state"
    # shellcheck disable=SC2016 # $1/$2 wertet sh aus
    if as_user sh -c 'printf "%s\n" "$1" >"$2"' sh "$head" "$state/installed-commit"; then
        info "Installierte Version des alten Setups festgehalten: ${head:0:7}"
    else
        warn "Installierte Version des alten Setups konnte nicht festgehalten werden."
    fi
}

# Gültiger Branch-Name (git check-ref-format, vereinfacht): kein Optionsstart, keine «..».
valid_branch() {
    [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && $1 != *..* && $1 != *.lock && $1 != */ ]]
}

# Update-Branch: --branch, sonst der im Checkout gespeicherte (git config slatedesk.branch,
# liest auch auto-update.sh und die App), sonst main.
resolve_branch() {
    local stored=""
    if [ -n "$OPT_BRANCH" ]; then
        valid_branch "$OPT_BRANCH" || die "Ungültiger Branch-Name: $OPT_BRANCH"
        BRANCH=$OPT_BRANCH
        return
    fi
    if [ -d "$REPO_DIR/.git" ]; then
        stored=$(as_user git -C "$REPO_DIR" config --get slatedesk.branch 2>/dev/null || true)
    fi
    if [ -n "$stored" ] && valid_branch "$stored"; then BRANCH=$stored; fi
}

sync_repo() {
    local foreign origin
    resolve_branch
    if [ -d "$REPO_DIR/.git" ]; then
        # Reste von Läufen als root (target/, node_modules/) blockieren den Build
        foreign=$(find "$REPO_DIR" -xdev ! -user "$SD_USER" -print -quit 2>/dev/null || true)
        if [ -n "$foreign" ]; then
            info "Korrigiere Dateibesitzer in $REPO_DIR…"
            chown -R "$SD_USER:$SD_GROUP" "$REPO_DIR"
        fi
        seed_legacy_installed_commit
        origin=$(as_user git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)
        info "Aktualisiere $REPO_DIR (${origin:-ohne origin}) auf origin/$BRANCH…"
        as_user git -C "$REPO_DIR" fetch --prune --no-tags origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" ||
            die "git fetch fehlgeschlagen – Netzwerk bzw. Zugriff auf ${origin:-origin} prüfen."
        as_user git -C "$REPO_DIR" checkout -q -f -B "$BRANCH" "origin/$BRANCH" || die "git checkout fehlgeschlagen."
        as_user git -C "$REPO_DIR" clean -q -fd -e src-tauri/Cargo.lock -e .env -e .env.local || warn "git clean fehlgeschlagen."
    elif [ -e "$REPO_DIR" ]; then
        die "$REPO_DIR existiert, ist aber kein Git-Checkout – bitte verschieben und Setup erneut starten."
    else
        info "Klone $REPO_URL nach $REPO_DIR…"
        as_user git clone --branch "$BRANCH" "$REPO_URL" "$REPO_DIR" || die "git clone fehlgeschlagen."
    fi
    [ -f "$AUTO_UPDATE" ] || die "$AUTO_UPDATE fehlt – ist $REPO_DIR das SlateDesk-Repository?"
    as_user git -C "$REPO_DIR" config --replace-all slatedesk.branch "$BRANCH" || warn "Update-Branch konnte nicht gespeichert werden."
    ok "Repository auf $(as_user git -C "$REPO_DIR" rev-parse --short HEAD) (Update-Branch: $BRANCH)."
}

# Läuft gerade eine ältere Kopie dieses Scripts, die neue aus dem Repository starten.
maybe_reexec() {
    local new="$REPO_DIR/scripts/setup.sh"
    [ "${SLATEDESK_SETUP_REEXEC:-0}" = "1" ] && return 0
    [ -f "$new" ] || return 0
    if [ -n "$SELF_SNAPSHOT" ] && cmp -s "$SELF_SNAPSHOT" "$new"; then
        return 0
    fi
    info "Starte die aktuelle setup.sh aus dem Repository…"
    rm -f "$SELF_SNAPSHOT"
    SELF_SNAPSHOT=""
    SLATEDESK_SETUP_REEXEC=1 exec bash "$new" "${ORIG_ARGS[@]}"
}

# ─── Altes Setup erkennen ────────────────────────────────────────────────────
detect_legacy() {
    local f cron
    for f in /etc/systemd/system/slatedesk*.service /etc/systemd/system/slatedesk*.timer; do
        if [ -f "$f" ]; then LEGACY_UNITS+=("${f##*/}"); fi
    done
    if pkg_installed slate-desk; then HAS_LEGACY_PKG=1; fi
    if [ -f "$SD_HOME/.config/autostart/slatedesk.desktop" ]; then HAS_LEGACY_AUTOSTART=1; fi
    f="$SD_HOME/.config/systemd/user/slatedesk.service"
    if [ -f "$f" ] && ! grep -q 'opt/slatedesk/current' "$f"; then HAS_OLD_USER_UNIT=1; fi
    if [ -f /etc/sudoers.d/slatedesk-update ]; then HAS_LEGACY_SUDOERS=1; fi
    if command -v crontab >/dev/null 2>&1; then
        cron=$(crontab -u "$SD_USER" -l 2>/dev/null || true)
        if grep -Eq 'scripts/(auto-update|hourly-restart)\.sh' <<<"$cron"; then HAS_LEGACY_CRON=1; fi
    fi
    if [ ${#LEGACY_UNITS[@]} -gt 0 ] || [ "$HAS_LEGACY_AUTOSTART" -eq 1 ] || [ "$HAS_OLD_USER_UNIT" -eq 1 ]; then
        LEGACY_LAUNCHERS=1
    fi
    if [ "$LEGACY_LAUNCHERS" -eq 1 ] || [ "$HAS_LEGACY_PKG" -eq 1 ] || [ "$HAS_LEGACY_CRON" -eq 1 ] ||
        [ "$HAS_LEGACY_SUDOERS" -eq 1 ]; then
        LEGACY_ANY=1
    fi
    [ "$LEGACY_ANY" -eq 1 ] || return 0

    info "Altes Setup gefunden – wird nach erfolgreichem Start der neuen Version entfernt:"
    [ "$HAS_LEGACY_PKG" -eq 1 ] && info "  dpkg-Paket slate-desk (/usr/bin/slate-desk)"
    [ ${#LEGACY_UNITS[@]} -gt 0 ] && info "  Systemdienste: ${LEGACY_UNITS[*]}"
    [ "$HAS_OLD_USER_UNIT" -eq 1 ] && info "  alter User-Dienst slatedesk.service (/usr/bin/slate-desk)"
    [ "$HAS_LEGACY_AUTOSTART" -eq 1 ] && info "  Autostart-Eintrag ~/.config/autostart/slatedesk.desktop"
    [ "$HAS_LEGACY_CRON" -eq 1 ] && info "  Cron-Einträge (auto-update.sh, hourly-restart.sh)"
    [ "$HAS_LEGACY_SUDOERS" -eq 1 ] && info "  sudo-Regel /etc/sudoers.d/slatedesk-update"
    return 0
}

# Das alte Update-Script löschte WebKit-Daten; vor der Migration wird der
# Bestand (localStorage mit Layout und Widget-Einstellungen) gesichert.
backup_webkit_data() {
    local data="$SD_HOME/.local/share/com.slatedesk.app"
    local dest="$SD_HOME/.local/state/slatedesk/backup" file
    [ -d "$data" ] || return 0
    [ -f "$SD_HOME/.config/com.slatedesk.app/state.json" ] && return 0
    if compgen -G "$dest/webkit-daten-*.tar.gz" >/dev/null; then
        return 0
    fi
    file="$dest/webkit-daten-$(date +%Y%m%d-%H%M%S).tar.gz"
    as_user mkdir -p "$dest"
    if as_user tar -czf "$file" -C "$SD_HOME/.local/share" --exclude=WebKitCache --exclude=CacheStorage com.slatedesk.app; then
        ok "Bisherige WebKit-Daten (Layout im localStorage) gesichert: $file"
    else
        warn "Sicherung der WebKit-Daten fehlgeschlagen – fahre fort."
    fi
}

# ─── Build & Dienste ─────────────────────────────────────────────────────────
wait_for_running_update() {
    local lock="/run/user/$SD_UID/slatedesk-update.lock"
    if systemctl is-active --quiet slatedesk-boot-update.service 2>/dev/null; then
        info "Stoppe laufendes Boot-Update des alten Setups…"
        systemctl stop slatedesk-boot-update.service || true
    fi
    [ -e "$lock" ] || return 0
    if ! as_user flock -n "$lock" true; then
        info "Ein Update läuft gerade – warte, bis es fertig ist (max. 1 h)…"
        as_user flock -w 3600 "$lock" true || die "Das laufende Update wurde nicht fertig – Setup später erneut starten."
    fi
}

state_dir() { printf '%s' "$SD_HOME/.local/state/slatedesk"; }

journal_hint() { printf 'sudo journalctl _SYSTEMD_USER_UNIT=slatedesk.service + USER_UNIT=slatedesk.service -n 100'; }

# Ist das neue Setup schon in Betrieb und die App sichtbar, installiert
# auto-update.sh die neue Version wie ein normales Update: Neustart,
# Health-Check und Rollback in einem gesperrten Lauf.
can_update_in_place() {
    [ -n "$1" ] && [ "$LEGACY_LAUNCHERS" -eq 0 ] || return 1
    grep -qs 'opt/slatedesk/current' "$SD_HOME/.config/systemd/user/slatedesk.service" || return 1
    has_graphical_session
}

# Phase des letzten Update-Laufs, sofern er nach <Epoche> geschrieben wurde.
update_phase_since() {
    local file started=$1 mtime
    file="$(state_dir)/update-status.json"
    mtime=$(stat -c %Y "$file" 2>/dev/null || echo 0)
    [ "$mtime" -ge "$started" ] || return 0
    sed -n 's/.*"phase":"\([a-z]*\)".*/\1/p' "$file" 2>/dev/null | head -n 1 || true
}

update_message_since() {
    local file started=$1 mtime
    file="$(state_dir)/update-status.json"
    mtime=$(stat -c %Y "$file" 2>/dev/null || echo 0)
    [ "$mtime" -ge "$started" ] || return 0
    sed -n 's/.*"message":"\([^"]*\)".*/\1/p' "$file" 2>/dev/null | head -n 1 || true
}

build_release() {
    local before after started phase="" message="" in_place=0
    local -a args=(--user-mode)
    before=$(readlink "$SD_HOME/.local/opt/slatedesk/current" 2>/dev/null || true)
    if [ -z "$before" ] || [ "$OPT_REBUILD" -eq 1 ]; then
        args+=(--force)
    fi
    if can_update_in_place "$before"; then
        in_place=1
    else
        # Gestartet und geprüft wird erst in switch_over (--activate, mit Rollback)
        args+=(--no-restart)
    fi
    wait_for_running_update
    if [ -z "$before" ]; then
        info "Erster Build als $SD_USER – das dauert je nach Gerät 10–30 Minuten…"
    elif [ "$in_place" -eq 1 ]; then
        info "Prüfe/baue die aktuelle Version als $SD_USER (Neustart mit Health-Check und Rollback)…"
    else
        info "Prüfe/baue die aktuelle Version als $SD_USER…"
    fi
    started=$(date +%s)
    if ! as_user bash -l "$AUTO_UPDATE" "${args[@]}"; then
        phase=$(update_phase_since "$started")
        message=$(update_message_since "$started")
        case "$phase" in
            skipped)
                # Bewusst kein Hinweis auf --rebuild: die gesperrte Version startete nicht.
                warn "origin/$BRANCH startete nach dem letzten Update nicht und bleibt gesperrt, bis ein neuer Commit auf $BRANCH liegt."
                warn "Die installierte Version ${before##*/} bleibt aktiv; das Setup wird mit ihr fortgesetzt."
                ;;
            rollback)
                die "${message:-Die neue Version startet nicht.} Sie wird erst mit einem neuen Commit auf $BRANCH erneut versucht. Details: $(journal_hint) und $(state_dir)/update.log"
                ;;
            *)
                die "Build bzw. Installation fehlgeschlagen${message:+ (»$message«)} – Details oben bzw. in $(state_dir)/update.log. Die laufende Version bleibt unverändert aktiv."
                ;;
        esac
    fi
    after=$(readlink "$SD_HOME/.local/opt/slatedesk/current" 2>/dev/null || true)
    [ -n "$after" ] && [ -x "$SD_HOME/.local/opt/slatedesk/current/slate-desk" ] ||
        die "Keine installierte Version unter $SD_HOME/.local/opt/slatedesk gefunden."
    if [ "$before" != "$after" ] || [ "$OPT_REBUILD" -eq 1 ]; then
        RELEASE_CHANGED=1
    fi
    # Ohne pending-activation hat auto-update.sh die Version bereits neu gestartet und geprüft.
    if [ "$in_place" -eq 1 ] && [ "$RELEASE_CHANGED" -eq 1 ] && [ "$phase" != "skipped" ] &&
        [ ! -e "$(state_dir)/pending-activation" ]; then
        RELEASE_CHANGED=0
        ok "Neue Version gestartet und per Health-Check geprüft."
    fi
    ok "Installiert: $SD_HOME/.local/opt/slatedesk/current → $after"
}

legacy_backup_dir() { printf '%s' "$SD_HOME/.local/state/slatedesk/legacy-backup"; }

write_session_autostart() {
    # shellcheck disable=SC2016 # $1 wird von sh ausgewertet
    as_user sh -c 'cat >"$1"' sh "$SD_HOME/.config/autostart/slatedesk-session.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SlateDesk Sitzungsstart
Comment=Startet den SlateDesk-Benutzerdienst (auch auf Desktops ohne graphical-session.target)
Exec=/bin/sh "$REPO_DIR/scripts/session-start.sh"
NoDisplay=true
X-GNOME-Autostart-enabled=true
EOF
}

install_units() {
    local unit_dir="$SD_HOME/.config/systemd/user" backup f
    backup=$(legacy_backup_dir)
    as_user mkdir -p "$unit_dir" "$SD_HOME/.config/autostart"
    if [ "$HAS_OLD_USER_UNIT" -eq 1 ] || [ "$HAS_LEGACY_AUTOSTART" -eq 1 ]; then
        as_user mkdir -p "$backup"
    fi
    if [ "$HAS_OLD_USER_UNIT" -eq 1 ]; then
        as_user cp -f "$unit_dir/slatedesk.service" "$backup/slatedesk.service"
    fi
    if [ "$HAS_LEGACY_AUTOSTART" -eq 1 ]; then
        as_user mv -f "$SD_HOME/.config/autostart/slatedesk.desktop" "$backup/slatedesk.desktop"
    fi
    for f in "$REPO_DIR"/scripts/systemd/*.service "$REPO_DIR"/scripts/systemd/*.timer; do
        [ -f "$f" ] || continue
        as_user install -m 0644 "$f" "$unit_dir/${f##*/}"
    done
    write_session_autostart
    user_systemctl daemon-reload || die "systemctl --user daemon-reload fehlgeschlagen."
    user_systemctl enable slatedesk.service >/dev/null 2>&1 || die "slatedesk.service konnte nicht aktiviert werden."
    ok "User-Dienste installiert: $(cd "$REPO_DIR/scripts/systemd" && printf '%s ' *.service *.timer)"
}

has_graphical_session() {
    local sid type state
    for sid in $(loginctl list-sessions --no-legend 2>/dev/null | awk -v u="$SD_USER" '$3 == u { print $1 }'); do
        type=$(loginctl show-session "$sid" -p Type --value 2>/dev/null || true)
        state=$(loginctl show-session "$sid" -p State --value 2>/dev/null || true)
        case "$type" in
            x11 | wayland | mir) [ "$state" != "closing" ] && return 0 ;;
        esac
    done
    return 1
}

# Desktops ohne systemd-Integration (z. B. labwc auf dem Raspberry Pi) geben dem
# User-Manager kein DISPLAY/WAYLAND_DISPLAY. Solange die alte App noch läuft,
# lassen sich die Werte aus ihrer Umgebung übernehmen.
import_graphical_env() {
    local manager_env pid line
    local -a vars=()
    manager_env=$(user_systemctl show-environment 2>/dev/null || true)
    if grep -Eq '^(WAYLAND_DISPLAY|DISPLAY)=' <<<"$manager_env"; then
        return 0
    fi
    for pid in $(pgrep -u "$SD_UID" -x slate-desk 2>/dev/null || true); do
        [ -r "/proc/$pid/environ" ] || continue
        while IFS= read -r line; do
            [ -n "$line" ] && vars+=("$line")
        done < <(tr '\0' '\n' <"/proc/$pid/environ" |
            grep -E '^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP)=' || true)
        break
    done
    if [ ${#vars[@]} -gt 0 ] && user_systemctl set-environment "${vars[@]}"; then
        info "Grafische Umgebung aus der laufenden App übernommen (${vars[*]})."
    fi
}

stop_legacy_system_units() {
    local u
    for u in "${LEGACY_UNITS[@]}"; do
        if systemctl is-enabled --quiet "$u" 2>/dev/null || systemctl is-active --quiet "$u" 2>/dev/null; then
            LEGACY_UNITS_RESTORE+=("$u")
        fi
        systemctl disable --now "$u" >/dev/null 2>&1 || warn "Systemdienst $u konnte nicht gestoppt werden."
    done
}

remove_user_units() {
    local unit_dir="$SD_HOME/.config/systemd/user" f
    user_systemctl disable --now slatedesk-update.timer slatedesk-restart.timer slatedesk.service >/dev/null 2>&1 || true
    for f in "$REPO_DIR"/scripts/systemd/*.service "$REPO_DIR"/scripts/systemd/*.timer; do
        [ -f "$f" ] || continue
        rm -f "$unit_dir/${f##*/}"
    done
    rm -f "$SD_HOME/.config/autostart/slatedesk-session.desktop"
}

# Neue Version startet nicht: altes Setup wieder in Betrieb nehmen.
restore_legacy() {
    local backup u restored_launcher=0
    backup=$(legacy_backup_dir)
    warn "Stelle das bisherige Setup wieder her…"
    remove_user_units
    if [ -f "$backup/slatedesk.service" ]; then
        as_user cp -f "$backup/slatedesk.service" "$SD_HOME/.config/systemd/user/slatedesk.service"
    fi
    if [ -f "$backup/slatedesk.desktop" ]; then
        as_user cp -f "$backup/slatedesk.desktop" "$SD_HOME/.config/autostart/slatedesk.desktop"
    fi
    user_systemctl daemon-reload || true
    for u in "${LEGACY_UNITS_RESTORE[@]}"; do
        systemctl enable --now "$u" >/dev/null 2>&1 || warn "Systemdienst $u konnte nicht wieder gestartet werden."
        [[ $u == slatedesk.service ]] && restored_launcher=1
    done
    if [ "$restored_launcher" -eq 0 ] && [ -f "$backup/slatedesk.service" ]; then
        user_systemctl enable --now slatedesk.service >/dev/null 2>&1 && restored_launcher=1
    fi
    if [ "$restored_launcher" -eq 0 ] && [ -x /usr/bin/slate-desk ]; then
        # KillMode=process: ein Neustart aus der App heraus (neue Instanz als
        # Kindprozess, alte endet mit 0) darf die neue Instanz nicht mitbeenden.
        as_user systemd-run --user --collect --unit="slatedesk-legacy-$(date +%s)" -p KillMode=process \
            /usr/bin/slate-desk >/dev/null 2>&1 ||
            warn "Alte Version konnte nicht gestartet werden – sie startet bei der nächsten Anmeldung."
    fi
}

switch_over() {
    local need=0 rc=0 restored
    if ! has_graphical_session; then
        SESSION_ACTIVE=0
        warn "Keine grafische Sitzung von $SD_USER aktiv – SlateDesk startet bei der nächsten Anmeldung."
        stop_legacy_system_units
        return 0
    fi
    SESSION_ACTIVE=1
    [ "$LEGACY_LAUNCHERS" -eq 1 ] && need=1
    [ "$RELEASE_CHANGED" -eq 1 ] && need=1
    user_systemctl is-active --quiet slatedesk.service || need=1
    if [ "$need" -eq 0 ]; then
        if as_user bash -l "$AUTO_UPDATE" --health; then
            APP_HEALTHY=1
            ok "SlateDesk läuft und antwortet."
            return 0
        fi
    fi
    import_graphical_env
    stop_legacy_system_units
    info "Starte SlateDesk als Benutzerdienst…"
    # Exit 3: die neue Version startet nicht, die vorherige wurde wiederhergestellt
    as_user bash -l "$AUTO_UPDATE" --activate || rc=$?
    if [ "$rc" -eq 0 ]; then
        APP_HEALTHY=1
        ok "SlateDesk läuft als Benutzerdienst und antwortet."
        return 0
    fi
    if [ "$LEGACY_LAUNCHERS" -eq 1 ] && [ "$HAS_LEGACY_PKG" -eq 1 ]; then
        restore_legacy
        die "Die neue Version startet nicht – das bisherige Setup wurde wiederhergestellt. Details: $(journal_hint) und $(state_dir)/update.log"
    fi
    if [ "$rc" -eq 3 ]; then
        restored=$(readlink "$SD_HOME/.local/opt/slatedesk/current" 2>/dev/null || true)
        die "Die neue Version startet nicht – die vorherige Version ${restored##*/} wurde wiederhergestellt und läuft. Die neue Version wird erst mit einem neuen Commit auf $BRANCH erneut versucht. Details: $(journal_hint) und $(state_dir)/update.log"
    fi
    die "SlateDesk startet nicht. Details: $(journal_hint) und $(state_dir)/update.log"
}

# ─── Altes Setup entfernen ───────────────────────────────────────────────────
remove_legacy_cron() {
    local current filtered tmp
    command -v crontab >/dev/null 2>&1 || return 0
    current=$(crontab -u "$SD_USER" -l 2>/dev/null) || return 0
    filtered=$(grep -Ev 'scripts/(auto-update|hourly-restart)\.sh|^# SlateDesk Auto-Update' <<<"$current" || true)
    [ "$filtered" != "$current" ] || return 0
    if [ -z "${filtered//[[:space:]]/}" ]; then
        crontab -u "$SD_USER" -r
    else
        tmp=$(mktemp)
        printf '%s\n' "$filtered" >"$tmp"
        crontab -u "$SD_USER" "$tmp"
        rm -f "$tmp"
    fi
    ok "Alte Cron-Einträge (auto-update.sh, hourly-restart.sh) entfernt."
}

finalize_migration() {
    local u removed=0
    remove_legacy_cron
    for u in "${LEGACY_UNITS[@]}"; do
        systemctl disable --now "$u" >/dev/null 2>&1 || true
        rm -f "/etc/systemd/system/$u"
        removed=1
    done
    if [ "$removed" -eq 1 ]; then
        systemctl daemon-reload
        systemctl reset-failed >/dev/null 2>&1 || true
        ok "Alte Systemdienste entfernt: ${LEGACY_UNITS[*]}"
    fi
    if [ -f /etc/sudoers.d/slatedesk-update ]; then
        rm -f /etc/sudoers.d/slatedesk-update
        ok "sudo-Regel /etc/sudoers.d/slatedesk-update entfernt."
    fi
    rm -rf "$(legacy_backup_dir)"
    if pkg_installed slate-desk; then
        if [ "$APP_HEALTHY" -eq 1 ]; then
            if DEBIAN_FRONTEND=noninteractive dpkg -r slate-desk >/dev/null; then
                ok "Altes Paket slate-desk entfernt (Benutzerdaten bleiben erhalten)."
                rm -rf "${SD_HOME:?}/.slatedesk-backups"
            else
                warn "dpkg -r slate-desk fehlgeschlagen – bitte später von Hand entfernen."
            fi
        else
            warn "Das alte Paket slate-desk bleibt installiert, bis die neue Version einmal gelaufen ist – danach setup.sh erneut ausführen."
        fi
    fi
}

enable_timers() {
    user_systemctl enable --now slatedesk-update.timer slatedesk-restart.timer >/dev/null 2>&1 ||
        die "Timer konnten nicht aktiviert werden."
    ok "Timer aktiv: Update täglich 01:00 und 3 Min. nach dem Start, Neustart täglich 04:00."
}

# ─── Desktop, Autologin, Firewall ────────────────────────────────────────────
configure_desktop() {
    local -a runner=(as_user)
    local spec schema key value changed=0
    if ! command -v gsettings >/dev/null 2>&1; then
        info "gsettings fehlt (kein GNOME) – Bildschirmabschaltung bitte im Desktop deaktivieren (docs/BETRIEB.md)."
        return 0
    fi
    if [ ! -S "/run/user/$SD_UID/bus" ]; then
        if ! command -v dbus-run-session >/dev/null 2>&1; then
            warn "Kein D-Bus für $SD_USER – Bildschirmschoner-Einstellungen übersprungen."
            return 0
        fi
        runner=(as_user dbus-run-session --)
    fi
    for spec in \
        "org.gnome.desktop.session|idle-delay|uint32 0" \
        "org.gnome.desktop.screensaver|lock-enabled|false" \
        "org.gnome.desktop.screensaver|idle-activation-enabled|false" \
        "org.gnome.settings-daemon.plugins.power|sleep-inactive-ac-type|'nothing'" \
        "org.gnome.settings-daemon.plugins.power|idle-dim|false" \
        "org.gnome.desktop.notifications|show-banners|false"; do
        IFS='|' read -r schema key value <<<"$spec"
        "${runner[@]}" gsettings writable "$schema" "$key" >/dev/null 2>&1 || continue
        if "${runner[@]}" gsettings set "$schema" "$key" "$value" >/dev/null 2>&1; then
            changed=$((changed + 1))
        else
            warn "gsettings set $schema $key fehlgeschlagen."
        fi
    done
    if [ "$changed" -gt 0 ]; then
        ok "Bildschirmschoner, Sperre, Ruhezustand und Benachrichtigungen für $SD_USER deaktiviert."
    else
        info "Keine GNOME-Einstellungen gefunden – Bildschirmabschaltung bitte im Desktop deaktivieren."
    fi
}

# Massgeblich ist, was systemd als Anmeldedienst startet; /etc/X11/default-display-manager
# kann veraltet sein (zenOS startet greetd, die Datei nennt noch gdm3).
display_manager() {
    local dm=""
    if [ -L /etc/systemd/system/display-manager.service ]; then
        dm=$(basename "$(readlink -f /etc/systemd/system/display-manager.service)" .service)
    fi
    if [ -z "$dm" ] && [ -r /etc/X11/default-display-manager ]; then
        dm=$(basename "$(head -n 1 /etc/X11/default-display-manager)")
    fi
    printf '%s' "$dm"
}

gdm_config() {
    if [ -d /etc/gdm3 ]; then printf '/etc/gdm3/custom.conf'; else printf '/etc/gdm/custom.conf'; fi
}

autologin_configured() {
    local dm=$1 conf
    case "$dm" in
        gdm3 | gdm)
            conf=$(gdm_config)
            [ -f "$conf" ] &&
                grep -Eq "^[[:space:]]*AutomaticLogin[[:space:]]*=[[:space:]]*${SD_USER}[[:space:]]*$" "$conf" &&
                grep -Eq '^[[:space:]]*AutomaticLoginEnable[[:space:]]*=[[:space:]]*([Tt]rue|1)' "$conf"
            ;;
        lightdm)
            grep -rEqs "^[[:space:]]*autologin-user[[:space:]]*=[[:space:]]*${SD_USER}[[:space:]]*$" /etc/lightdm/lightdm.conf /etc/lightdm/lightdm.conf.d
            ;;
        *) return 1 ;;
    esac
}

configure_autologin() {
    local dm conf
    dm=$(display_manager)
    if autologin_configured "$dm"; then
        ok "Automatische Anmeldung von $SD_USER ist eingerichtet ($dm)."
        return 0
    fi
    case "$dm" in
        gdm3 | gdm | lightdm) ;;
        greetd)
            info "Anmeldedienst greetd: die automatische Anmeldung regelt das System (unter zenOS das Anzeige-Profil)."
            return 0
            ;;
        *)
            info "Display-Manager ${dm:-unbekannt}: automatische Anmeldung von $SD_USER bitte von Hand einrichten."
            return 0
            ;;
    esac
    if [ "$OPT_AUTOLOGIN" -ne 1 ] && ! ask "Automatische Anmeldung von $SD_USER einrichten ($dm)"; then
        info "Hinweis: Ohne automatische Anmeldung startet SlateDesk erst, wenn sich $SD_USER anmeldet (Option --autologin)."
        return 0
    fi
    case "$dm" in
        gdm3 | gdm)
            conf=$(gdm_config)
            mkdir -p "$(dirname "$conf")"
            [ -f "$conf" ] || printf '[daemon]\n' >"$conf"
            cp -n "$conf" "$conf.slatedesk-bak" || true
            ini_replace_keys "$conf" daemon 'AutomaticLoginEnable|AutomaticLogin' \
                "AutomaticLoginEnable=true" "AutomaticLogin=$SD_USER"
            ;;
        lightdm)
            conf=/etc/lightdm/lightdm.conf
            if [ -f "$conf" ]; then
                cp -n "$conf" "$conf.slatedesk-bak" || true
                ini_replace_keys "$conf" 'Seat:*' 'autologin-user|autologin-user-timeout' \
                    "autologin-user=$SD_USER" "autologin-user-timeout=0"
            else
                mkdir -p /etc/lightdm/lightdm.conf.d
                conf=/etc/lightdm/lightdm.conf.d/50-slatedesk-autologin.conf
                printf '[Seat:*]\nautologin-user=%s\nautologin-user-timeout=0\n' "$SD_USER" >"$conf"
            fi
            ;;
    esac
    ok "Automatische Anmeldung von $SD_USER eingerichtet ($conf) – wirkt ab dem nächsten Neustart."
}

detect_subnet() {
    local dev
    dev=$(ip -4 route show default 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
    [ -n "$dev" ] || return 0
    ip -4 -o route show dev "$dev" scope link 2>/dev/null | awk '$1 ~ /\// { print $1; exit }'
}

configure_ufw() {
    local status_out active=0 subnet
    if ! command -v ufw >/dev/null 2>&1; then
        info "ufw ist nicht installiert – keine Firewall-Regel angelegt."
        return 0
    fi
    status_out=$(LC_ALL=C ufw status 2>/dev/null || true)
    if grep -q '^Status: active' <<<"$status_out"; then active=1; fi
    if grep -q 'SlateDesk Fernsteuerung' <<<"$status_out"; then
        ok "ufw-Regel für die Fernsteuerung vorhanden."
        return 0
    fi
    if [ "$OPT_UFW" -ne 1 ]; then
        if [ "$active" -eq 0 ]; then
            info "ufw ist inaktiv – Port $REMOTE_PORT ist im LAN erreichbar (Regel bei Bedarf mit --ufw anlegen)."
            return 0
        fi
        if ! ask "ufw ist aktiv: Port $REMOTE_PORT für die Fernsteuerung im lokalen Subnetz freigeben"; then
            info "Hinweis: Ohne Freigabe ist die Fernsteuerung nur am Gerät selbst erreichbar (Option --ufw)."
            return 0
        fi
    fi
    subnet=${UFW_SUBNET:-$(detect_subnet)}
    if ! [[ $subnet =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
        warn "Lokales Subnetz nicht erkannt (${subnet:-leer}) – bitte mit --ufw-subnet 192.168.x.0/24 angeben."
        return 0
    fi
    ufw allow from "$subnet" to any port "$REMOTE_PORT" proto tcp comment 'SlateDesk Fernsteuerung' >/dev/null ||
        die "ufw-Regel konnte nicht angelegt werden."
    ok "ufw: Port $REMOTE_PORT/tcp aus $subnet erlaubt (kein Port-Forwarding im Router einrichten!)."
    [ "$active" -eq 1 ] || info "ufw ist inaktiv – die Regel greift erst nach »sudo ufw enable«."
}

# ─── Lüfter ──────────────────────────────────────────────────────────────────
FAN_HELPER=/usr/local/lib/slatedesk/fan-access
FAN_RULE=/etc/udev/rules.d/90-slatedesk-fans.rules

# Lüfter mit PWM-Ausgang (hwmon) darf das Kiosk-Konto über die Fernsteuerung regeln: pwmN und
# pwmN_enable gehören bei jedem Start seiner Gruppe. Vorhandene Lüfter werden gleich
# freigegeben – ohne neue Anmeldung. Gibt es keine, regelt weiterhin das BIOS.
configure_fan_access() {
    local dir count
    install -d -m 0755 "${FAN_HELPER%/*}"
    install -m 0755 -o root -g root "$REPO_DIR/scripts/fan-access.sh" "$FAN_HELPER"
    printf '# SlateDesk: Lüftersteuerung für das Kiosk-Konto %s (angelegt von scripts/setup.sh)\nACTION=="add", SUBSYSTEM=="hwmon", RUN+="%s /sys%%p %s"\n' \
        "$SD_USER" "$FAN_HELPER" "$SD_GROUP" >"$FAN_RULE"
    if command -v udevadm >/dev/null 2>&1; then udevadm control --reload >/dev/null 2>&1 || true; fi
    for dir in /sys/class/hwmon/hwmon*; do
        [ -d "$dir" ] && "$FAN_HELPER" "$(readlink -f "$dir")" "$SD_GROUP"
    done
    count=$(find -L /sys/class/hwmon/ -maxdepth 3 -name 'pwm[0-9]' -group "$SD_GROUP" 2>/dev/null | wc -l)
    if [ "$count" -gt 0 ]; then
        ok "Lüfter: $count Ausgänge für $SD_USER freigegeben (Fernsteuerung → System → Lüfter)."
    else
        info "Lüfter: keine steuerbaren Ausgänge gefunden – die Lüfter regelt das BIOS."
    fi
}

# ─── Systemprotokoll ─────────────────────────────────────────────────────────
# Nach einem Hänger zeigt SlateDesk unter System → Protokoll die letzten Meldungen des
# vorherigen Starts. Dafür muss das Journal einen Neustart überleben und das Kiosk-Konto es
# lesen dürfen (Gruppe systemd-journal – wirkt ab dem nächsten Neustart des Geräts).
configure_journal_access() {
    if [ ! -d /var/log/journal ]; then
        mkdir -p /var/log/journal
        systemd-tmpfiles --create --prefix /var/log/journal >/dev/null 2>&1 || true
        journalctl --flush >/dev/null 2>&1 || true
        ok "Systemprotokoll wird jetzt dauerhaft gespeichert (/var/log/journal)."
    fi
    getent group systemd-journal >/dev/null 2>&1 || return 0
    if id -nG "$SD_USER" | tr ' ' '\n' | grep -qx systemd-journal; then
        ok "$SD_USER darf das Systemprotokoll lesen."
    else
        usermod -aG systemd-journal "$SD_USER" || die "$SD_USER konnte nicht zur Gruppe systemd-journal hinzugefügt werden."
        ok "$SD_USER darf das Systemprotokoll lesen (ab dem nächsten Neustart des Geräts)."
    fi
}

# ─── Zusammenfassung ─────────────────────────────────────────────────────────
summary() {
    local ip release
    ip=$(hostname -I 2>/dev/null | awk '{ print $1 }')
    release=$(readlink "$SD_HOME/.local/opt/slatedesk/current" 2>/dev/null || true)
    step "SlateDesk ist eingerichtet"
    printf '  App:            %s/.local/opt/slatedesk/current → %s\n' "$SD_HOME" "${release:-?}"
    printf '  Dienste:        slatedesk.service, slatedesk-update.timer (01:00 + nach dem Start),\n'
    printf '                  slatedesk-restart.timer (04:00)\n'
    printf '  Fernsteuerung:  http://%s:%s  (PIN am Kiosk unter Bearbeiten → Fernsteuerung)\n' "${ip:-<IP-des-Geräts>}" "$REMOTE_PORT"
    printf '  Status:         sudo systemctl --user -M %s@ status slatedesk.service\n' "$SD_USER"
    printf '  Logs:           sudo journalctl _SYSTEMD_USER_UNIT=slatedesk.service _SYSTEMD_USER_UNIT=slatedesk-update.service -f\n'
    printf '  Update-Log:     %s/.local/state/slatedesk/update.log\n' "$SD_HOME"
    printf '  Update jetzt:   sudo systemctl --user -M %s@ start slatedesk-update.service\n' "$SD_USER"
    printf '  Betrieb:        %s/docs/BETRIEB.md\n' "$REPO_DIR"
    if [ "$SESSION_ACTIVE" -eq 0 ]; then
        printf '\n  %sSlateDesk startet, sobald sich %s grafisch anmeldet (oder nach einem Neustart mit Autologin).%s\n' "$C_YELLOW" "$SD_USER" "$C_OFF"
    fi
}

main() {
    ORIG_ARGS=("$@")
    init_globals
    init_colors
    snapshot_self
    parse_args "$@"
    trap 'on_err $? $LINENO "$BASH_COMMAND"' ERR
    trap on_exit EXIT
    [ "$(id -u)" -eq 0 ] || die "setup.sh muss als root laufen: sudo bash $0"
    command -v apt-get >/dev/null 2>&1 || die "Nur für Debian/Ubuntu/Raspberry Pi OS (apt) vorgesehen."
    cd / || exit 1

    step "Repository"
    ensure_bootstrap_packages
    ensure_user
    sync_repo
    maybe_reexec

    step "Pakete"
    if [ "$OPT_SKIP_APT" -eq 1 ]; then info "Übersprungen (--skip-apt)."; else install_packages; fi

    step "Benutzer & Werkzeuge"
    ensure_user_manager
    ensure_node
    ensure_rust

    step "Build"
    detect_legacy
    backup_webkit_data
    build_release

    step "Dienste & Start"
    install_units
    switch_over
    finalize_migration
    enable_timers

    step "Kiosk-Einstellungen"
    configure_desktop
    configure_autologin
    configure_fan_access
    configure_journal_access

    step "Fernsteuerung"
    configure_ufw

    summary
}

main "$@"; exit
