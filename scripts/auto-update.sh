#!/usr/bin/env bash
#
# SlateDesk Auto-Update
#
# Läuft als systemd-User-Dienst slatedesk-update.service: per Timer täglich um
# 01:00 und 3 Minuten nach dem Systemstart, oder ausgelöst über "Update" im
# Kiosk bzw. in der Fernsteuerung. Ablauf:
#
#   git fetch → git reset --hard origin/<Update-Branch> → npm ci (nur bei Bedarf)
#   → npx tauri build --no-bundle → ~/.local/opt/slatedesk/releases/<commit>/
#   → Symlink "current" atomar umstellen → Neustart → Health-Check
#   → bei Fehlschlag: Symlink zurück auf die vorherige Version (Rollback)
#
# Ohne grafische Sitzung (oder mit --no-restart) wird nur installiert und die
# Version als ungeprüft vermerkt (pending-activation); der nächste Lauf mit
# Sitzung bzw. "--activate" holt den Health-Check samt Rollback nach.
#
# Fortschritt: ~/.local/state/slatedesk/update-status.json (liest die App)
# Protokoll:   ~/.local/state/slatedesk/update.log
#
# Altes Setup (dpkg-Paket + sudoers, neuer User-Dienst noch nicht installiert):
# baut weiterhin ein .deb und installiert es mit "sudo -n dpkg -i", bis
# scripts/setup.sh einmal ausgeführt wurde.
#
# Exit-Codes: 0 = erfolgreich, nichts zu tun oder läuft bereits
#             1 = Update fehlgeschlagen (laufende Version bleibt aktiv)
#             2 = Voraussetzungen fehlen (Netzwerk, Werkzeuge, Verzeichnisse)
#             3 = nur --activate: die neue Version startet nicht, die vorherige
#                 wurde wiederhergestellt und antwortet
#
# Alles steckt in Funktionen und wird über die letzte Zeile gestartet: der
# git reset ersetzt diese Datei während des Laufs, und bash darf danach nichts
# mehr aus ihr nachlesen.
#
set -Eeuo pipefail

usage() {
    cat <<'EOF'
Verwendung: auto-update.sh [Optionen]

Prüft den Update-Branch (Standard main) auf eine neue Version, baut SlateDesk
und installiert es. Der Branch kommt aus SLATEDESK_BRANCH, sonst aus
«git config slatedesk.branch» im Checkout (setzt setup.sh --branch).
Wird normalerweise von slatedesk-update.service ausgeführt.

Optionen:
  --force        Bauen und installieren, auch wenn die Version schon aktuell
                 ist (auch eine nach fehlgeschlagenem Start gesperrte Version)
  --no-restart   Nach der Installation nicht neu starten (die Version gilt
                 bis zum ersten geprüften Start als ungeprüft)
  --user-mode    Installation ins Benutzerverzeichnis erzwingen (für setup.sh)
  --activate     Nur die installierte Version neu starten und prüfen; startet
                 eine noch ungeprüfte Version nicht, wird die vorherige
                 wiederhergestellt (für setup.sh)
  --health       Nur prüfen, ob die laufende App antwortet
  -h, --help     Diese Hilfe anzeigen

Umgebung:
  SLATEDESK_HOME   Git-Checkout (Standard: ~/SlateDesk)
EOF
}

# ─── Konfiguration ───────────────────────────────────────────────────────────
# Gültiger Branch-Name (git check-ref-format, vereinfacht): kein Optionsstart, keine «..».
valid_branch() {
    [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && $1 != *..* && $1 != *.lock && $1 != */ ]]
}

# Update-Branch: SLATEDESK_BRANCH, sonst «git config slatedesk.branch» im Checkout
# (setzt setup.sh --branch; überlebt git reset), sonst main. Die App liest dieselbe Quelle.
resolve_branch() {
    local b="${SLATEDESK_BRANCH:-}"
    if [ -z "$b" ]; then
        b=$(git -C "$SLATEDESK_HOME" config --get slatedesk.branch 2>/dev/null || true)
    fi
    if [ -n "$b" ] && valid_branch "$b"; then printf '%s' "$b"; else printf 'main'; fi
}

init_globals() {
    KEEP_RELEASES=3
    HEALTH_TIMEOUT=60
    DEFAULT_PORT=7380
    MIN_FREE_KB=$((1536 * 1024))
    CLEAN_BELOW_KB=$((3 * 1024 * 1024))
    LOG_MAX_BYTES=$((1024 * 1024))

    SLATEDESK_HOME="${SLATEDESK_HOME:-$HOME/SlateDesk}"
    SLATEDESK_HOME="${SLATEDESK_HOME%/}"
    BRANCH=$(resolve_branch)
    TARGET_DIR="${CARGO_TARGET_DIR:-$SLATEDESK_HOME/src-tauri/target}"
    STATE_DIR="$HOME/.local/state/slatedesk"
    LOG_FILE="$STATE_DIR/update.log"
    STATUS_FILE="$STATE_DIR/update-status.json"
    STEP_OUTPUT="$STATE_DIR/last-step.out"
    INSTALLED_FILE="$STATE_DIR/installed-commit"
    FAILED_FILE="$STATE_DIR/failed-commit"
    # Installiert, aber noch nie mit Health-Check gestartet (--no-restart oder
    # keine Sitzung); Inhalt: Release für den Rollback (darf leer sein).
    PENDING_FILE="$STATE_DIR/pending-activation"
    BUILD_TIME_FILE="$STATE_DIR/last-build-seconds"
    BUILD_MARKER="$STATE_DIR/.build-started"
    OPT_DIR="$HOME/.local/opt/slatedesk"
    RELEASES_DIR="$OPT_DIR/releases"
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    APP_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/com.slatedesk.app"
    LEGACY_BIN="/usr/bin/slate-desk"
    # "--user-unit" filtert nach der UID des Aufrufers und findet unter sudo nichts.
    JOURNAL_HINT="sudo journalctl _SYSTEMD_USER_UNIT=slatedesk.service + USER_UNIT=slatedesk.service -n 100"

    MODE=""
    LOCK_FILE=""
    LOCK_HELD=0
    STATUS_FINAL=0
    STATUS_PHASE="start"
    STATUS_PERCENT=0
    RUN_STARTED_MS=0
    FROM_COMMIT=""
    TO_COMMIT=""
    TICKER_PID=""
    ROLLBACK_TARGET=""
    RESTART_SKIPPED=0
}

parse_args() {
    ACTION="update"
    OPT_FORCE=0
    OPT_NO_RESTART=0
    OPT_USER_MODE=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --force) OPT_FORCE=1 ;;
            --no-restart) OPT_NO_RESTART=1 ;;
            --user-mode) OPT_USER_MODE=1 ;;
            --activate) ACTION="activate" ;;
            --health) ACTION="health" ;;
            -h | --help) usage; exit 0 ;;
            *) printf 'Unbekannte Option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
        esac
        shift
    done
}

# ─── Logging & Status ────────────────────────────────────────────────────────
# Log-Zeilen gehen nach stderr (Journal/Terminal) und ins Update-Log, nie nach
# stdout – so bleiben Command-Substitutions sauber.
log() {
    local level=$1
    shift
    local line
    line="[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $*"
    printf '%s\n' "$line" >&2
    if [ -n "$LOG_FILE" ]; then
        printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null || true
    fi
}
log_info()  { log INFO "$@"; }
log_warn()  { log WARN "$@"; }
log_error() { log ERROR "$@"; }

rotate_log() {
    local size
    size=$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)
    if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
        mv -f "$LOG_FILE" "$LOG_FILE.1"
    fi
}

# EPOCHREALTIME statt "date +%s%3N": uutils-date (Ubuntu 26.04) kennt %3N
# nicht; das Dezimaltrennzeichen hängt von der Locale ab.
now_ms() {
    local us=${EPOCHREALTIME:-}
    us=${us/[.,]/}
    if [[ $us =~ ^[0-9]{13,}$ ]]; then
        printf '%s' "${us:0:${#us}-3}"
    else
        printf '%s000' "$(date +%s)"
    fi
}

json_string() {
    local s=$1
    s=${s//\\/\\\\}
    s=${s//\"/\\\"}
    s=${s//$'\n'/\\n}
    s=${s//$'\r'/}
    s=${s//$'\t'/ }
    printf '"%s"' "$s"
}

json_commit() {
    if [ -n "${1:-}" ]; then json_string "$1"; else printf 'null'; fi
}

# write_status <phase> <percent> <message> [done] [error]
# Schreibt atomar (tmp + rename), damit die App nie eine halbe Datei liest.
write_status() {
    local phase=$1 percent=$2 message=$3 done=${4:-false} error=${5:-false}
    local tmp="$STATUS_FILE.$BASHPID.tmp"
    STATUS_PHASE=$phase
    STATUS_PERCENT=$percent
    if {
        printf '{"percent":%d,"message":%s,"phase":%s,"done":%s,"error":%s,' \
            "$percent" "$(json_string "$message")" "$(json_string "$phase")" "$done" "$error"
        printf '"startedAt":%s,"updatedAt":%s,"fromCommit":%s,"toCommit":%s}\n' \
            "$RUN_STARTED_MS" "$(now_ms)" "$(json_commit "$FROM_COMMIT")" "$(json_commit "$TO_COMMIT")"
    } >"$tmp" 2>/dev/null && mv -f "$tmp" "$STATUS_FILE" 2>/dev/null; then
        return 0
    fi
    rm -f "$tmp" 2>/dev/null || true
    log_warn "Statusdatei konnte nicht geschrieben werden: $STATUS_FILE"
}

status() {
    write_status "$1" "$2" "$3"
    log_info "$3"
}

finish_ok() {
    local phase=$1 message=$2
    STATUS_FINAL=1
    write_status "$phase" 100 "$message" true false
    log_info "$message"
    log_info "========================================"
    exit 0
}

# finish_fail <exit-code> <message> [phase]
finish_fail() {
    local code=$1 message=$2 phase=${3:-error}
    STATUS_FINAL=1
    write_status "$phase" "$STATUS_PERCENT" "$message" true true
    log_error "$message"
    log_info "========================================"
    exit "$code"
}

short() { printf '%s' "${1:0:7}"; }

# ─── Traps ───────────────────────────────────────────────────────────────────
on_err() {
    log_error "Fehler in Zeile $2 (Exit $1): $3"
}

on_signal() {
    log_error "Update durch Signal SIG$1 abgebrochen."
    exit "$2"
}

on_exit() {
    local rc=$?
    stop_build_ticker
    if [ "$LOCK_HELD" -eq 1 ] && [ "$STATUS_FINAL" -eq 0 ]; then
        log_error "Update abgebrochen (Exit $rc, Phase $STATUS_PHASE)."
        write_status error "$STATUS_PERCENT" "Update abgebrochen (Exit $rc) – Details im Update-Log." true true
    fi
}

install_traps() {
    trap 'on_err $? $LINENO "$BASH_COMMAND"' ERR
    trap on_exit EXIT
    trap 'on_signal TERM 143' TERM
    trap 'on_signal INT 130' INT
    trap 'on_signal HUP 129' HUP
}

# ─── Umgebung ────────────────────────────────────────────────────────────────
# Cron, systemd und "bash -l" liefern unterschiedliche Umgebungen; hier wird
# alles gesetzt, was git, npm, cargo und systemctl --user brauchen.
setup_env() {
    local uid
    uid=$(id -u)
    export PATH="$HOME/.cargo/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
    if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
        set +u
        # shellcheck disable=SC1091
        . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
        set -u
    fi
    if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$uid" ]; then
        export XDG_RUNTIME_DIR="/run/user/$uid"
    fi
    if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-/nonexistent}/bus" ]; then
        export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
    fi
    export GIT_TERMINAL_PROMPT=0
    export NO_COLOR=1 CARGO_TERM_COLOR=never
    export npm_config_fund=false npm_config_audit=false npm_config_update_notifier=false
}

open_lock() {
    local dir=${XDG_RUNTIME_DIR:-}
    if [ -n "$dir" ] && [ -d "$dir" ] && [ -w "$dir" ]; then
        LOCK_FILE="$dir/slatedesk-update.lock"
    else
        LOCK_FILE="/tmp/slatedesk-update-$(id -u).lock"
    fi
    if ! { exec 9>>"$LOCK_FILE"; } 2>/dev/null; then
        log_error "Sperrdatei kann nicht geöffnet werden: $LOCK_FILE"
        return 1
    fi
}

# Neuer User-Dienst installiert → Benutzerinstallation, sonst altes dpkg-Setup.
detect_mode() {
    if [ "$OPT_USER_MODE" -eq 1 ] || user_unit_installed; then
        MODE="user"
    else
        MODE="legacy"
    fi
}

user_unit_installed() {
    [ -f "$UNIT_DIR/slatedesk.service" ] && grep -q 'opt/slatedesk/current' "$UNIT_DIR/slatedesk.service"
}

check_tools() {
    local missing=() tool
    for tool in git curl flock timeout sha256sum od node npm cargo; do
        command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    if [ "$MODE" = "legacy" ]; then
        for tool in sudo dpkg; do
            command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
        done
    fi
    if [ ${#missing[@]} -gt 0 ]; then
        finish_fail 2 "Fehlende Programme: ${missing[*]} – bitte scripts/setup.sh ausführen."
    fi
    # Vite 8 verlangt Node ^20.19 oder >= 22.12
    if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===20&&b>=19)||(a===22&&b>=12)||a>22?0:1)' 2>/dev/null; then
        finish_fail 2 "Node.js $(node -v 2>/dev/null || echo '?') ist zu alt (benötigt 22.12 oder neuer) – bitte scripts/setup.sh ausführen."
    fi
}

# Führt einen Befehl aus, Ausgabe ins Journal/Terminal, ins Update-Log und in
# last-step.out (für Fehlerhinweise). Rückgabewert = der des Befehls.
run_logged() {
    : >"$STEP_OUTPUT"
    log_info "\$ $*"
    "$@" 2>&1 | tee -a "$LOG_FILE" "$STEP_OUTPUT" >&2
}

failure_hint() {
    local f=$STEP_OUTPUT
    [ -f "$f" ] || return 0
    if grep -q -- '--locked' "$f" && grep -qi 'lock file' "$f"; then
        printf ' Cargo.lock passt nicht zu Cargo.toml – Cargo.lock aktualisieren und committen.'
    elif grep -qi 'version mismatched Tauri packages' "$f"; then
        printf ' Tauri-Versionen von npm und Rust passen nicht zusammen.'
    elif grep -Eqi 'requires rustc|is not supported by the following package' "$f"; then
        printf ' Rust ist zu alt – scripts/setup.sh erneut ausführen (aktualisiert Rust).'
    elif grep -qi 'No space left on device' "$f"; then
        printf ' Kein Speicherplatz mehr frei.'
    elif grep -Eqi 'ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|Could not resolve host|failed to download|spurious network error' "$f"; then
        printf ' Netzwerkproblem beim Laden von Abhängigkeiten – wird beim nächsten Lauf erneut versucht.'
    fi
}

# ─── Commits ─────────────────────────────────────────────────────────────────
valid_commit() { [[ ${1:-} =~ ^[0-9a-f]{40}$ ]]; }

read_commit_file() {
    local c=""
    if [ -f "$1" ]; then
        c=$(head -n 1 "$1" 2>/dev/null || true)
    fi
    if valid_commit "$c"; then printf '%s' "$c"; fi
}

# Verglichen wird mit der installierten Version, nicht mit HEAD: ein
# abgebrochener Lauf lässt HEAD auf dem neuen Commit stehen und muss beim
# nächsten Mal trotzdem erneut bauen.
installed_commit() {
    if [ "$MODE" = "user" ]; then
        read_commit_file "$OPT_DIR/current/commit"
        return 0
    fi
    [ -x "$LEGACY_BIN" ] || return 0
    if [ -f "$INSTALLED_FILE" ]; then
        read_commit_file "$INSTALLED_FILE"
    else
        # Das alte Script hat nach erfolgreicher Installation HEAD == installiert
        # hinterlassen. Gilt nur, bis HEAD zum ersten Mal verschoben wird – davor
        # halten run_update (seed_legacy_installed) und setup.sh den Wert fest.
        git rev-parse --verify -q HEAD 2>/dev/null || true
    fi
}

# Altes Setup: checkout_target verschiebt HEAD vor Build und dpkg. Ohne
# installed-commit hielte der nächste Lauf nach einem Fehlschlag HEAD für
# installiert und meldete "aktuell", obwohl die alte Version weiterläuft.
seed_legacy_installed() {
    [ "$MODE" = "legacy" ] && [ -n "$FROM_COMMIT" ] && [ ! -f "$INSTALLED_FILE" ] || return 0
    printf '%s\n' "$FROM_COMMIT" >"$INSTALLED_FILE"
    log_info "Installierte Version festgehalten: $(short "$FROM_COMMIT")"
}

# ─── Netzwerk & Git ──────────────────────────────────────────────────────────
wait_for_network() {
    local attempt max=30
    for ((attempt = 1; attempt <= max; attempt++)); do
        if timeout 30 git ls-remote --exit-code origin "refs/heads/$BRANCH" >/dev/null 2>&1; then
            return 0
        fi
        write_status network 3 "Warte auf Verbindung zu GitHub (Versuch $attempt/$max)…"
        if [ "$attempt" -eq 1 ]; then
            log_warn "Repository nicht erreichbar – neuer Versuch alle 10 s (max. $max)."
        fi
        sleep 10
    done
    if curl -fsS -o /dev/null --max-time 10 https://github.com 2>/dev/null; then
        finish_fail 2 "GitHub ist erreichbar, das Repository aber nicht – Remote-URL bzw. Zugriff prüfen (git remote -v)."
    fi
    finish_fail 2 "Keine Verbindung zu GitHub – Netzwerk/Proxy prüfen. Nächster Versuch beim nächsten Lauf."
}

fetch_remote() {
    status fetch 6 "Prüfe auf Updates…"
    if ! run_logged timeout 600 git fetch --prune --no-tags origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"; then
        finish_fail 1 "git fetch fehlgeschlagen – Details im Update-Log."
    fi
    if ! TO_COMMIT=$(git rev-parse --verify -q "origin/$BRANCH^{commit}"); then
        TO_COMMIT=""
        finish_fail 1 "origin/$BRANCH nicht gefunden."
    fi
    log_info "Installiert: ${FROM_COMMIT:-keine}  |  origin/$BRANCH: $TO_COMMIT"
}

checkout_target() {
    status checkout 10 "Lade Version $(short "$TO_COMMIT")…"
    if ! run_logged git checkout -f -B "$BRANCH" "origin/$BRANCH" ||
        ! run_logged git reset --hard "origin/$BRANCH"; then
        finish_fail 1 "Git-Checkout fehlgeschlagen – Details im Update-Log."
    fi
    # Nur unversionierte, nicht ignorierte Dateien: node_modules, target und .env bleiben.
    if ! run_logged git clean -fd -e src-tauri/Cargo.lock -e .env -e .env.local; then
        log_warn "git clean fehlgeschlagen – fahre fort."
    fi
}

# ─── Build ───────────────────────────────────────────────────────────────────
free_kb() {
    df -Pk "$SLATEDESK_HOME" 2>/dev/null | awk 'NR == 2 { print $4 }' || true
}

ensure_disk_space() {
    local avail
    avail=$(free_kb)
    avail=${avail:-0}
    # Nur ein echtes Cargo-target-Verzeichnis wird gelöscht (CARGO_TARGET_DIR kann beliebig sein).
    if [ "$avail" -lt "$CLEAN_BELOW_KB" ] && [ -d "$TARGET_DIR" ] && [[ $TARGET_DIR == */target ]]; then
        log_warn "Nur noch $((avail / 1024)) MB frei – lösche den Build-Cache ($TARGET_DIR)."
        rm -rf "$TARGET_DIR"
        avail=$(free_kb)
        avail=${avail:-0}
    fi
    if [ "$avail" -lt "$MIN_FREE_KB" ]; then
        finish_fail 2 "Zu wenig Speicherplatz für den Build ($((avail / 1024)) MB frei, benötigt mindestens $((MIN_FREE_KB / 1024)) MB)."
    fi
}

install_dependencies() {
    local stamp="node_modules/.slatedesk-lock-stamp" want have=""
    want="$(sha256sum package-lock.json | cut -d ' ' -f 1) $(node -v)"
    if [ -f "$stamp" ]; then
        have=$(cat "$stamp" 2>/dev/null || true)
    fi
    if [ -d node_modules ] && [ "$want" = "$have" ]; then
        log_info "npm-Abhängigkeiten unverändert – npm ci übersprungen."
        return 0
    fi
    status deps 15 "Installiere npm-Abhängigkeiten…"
    if ! run_logged npm ci --include=dev --no-audit --no-fund; then
        finish_fail 1 "npm ci fehlgeschlagen.$(failure_hint) Details im Update-Log."
    fi
    printf '%s\n' "$want" >"$stamp"
}

# Schätzt den Build-Fortschritt anhand der Dauer des letzten Builds, damit
# die Fortschrittsanzeige nicht minutenlang stillsteht.
start_build_ticker() {
    local expected=$1
    local started=$SECONDS
    (
        trap - ERR EXIT INT HUP
        # sleep mitbeenden, sonst hält es die Journal-/Terminal-Pipe noch offen
        trap 'kill "$sleep_pid" 2>/dev/null; exit 0' TERM
        exec 9>&-
        set +e
        sleep_pid=""
        while :; do
            sleep 10 &
            sleep_pid=$!
            wait "$sleep_pid"
            elapsed=$((SECONDS - started))
            percent=$((25 + elapsed * 60 / expected))
            [ "$percent" -gt 84 ] && percent=84
            remaining=$(((expected - elapsed + 59) / 60))
            if [ "$remaining" -gt 0 ]; then
                write_status build "$percent" "Baue SlateDesk… (noch ca. $remaining Min.)"
            else
                write_status build "$percent" "Baue SlateDesk… (dauert länger als beim letzten Mal)"
            fi
        done
    ) &
    TICKER_PID=$!
}

stop_build_ticker() {
    if [ -n "${TICKER_PID:-}" ]; then
        kill "$TICKER_PID" 2>/dev/null || true
        wait "$TICKER_PID" 2>/dev/null || true
        TICKER_PID=""
    fi
}

build_app() {
    local expected=900 started=$SECONDS last
    last=$(cat "$BUILD_TIME_FILE" 2>/dev/null || true)
    if [[ $last =~ ^[0-9]+$ ]] && [ "$last" -ge 60 ]; then
        expected=$last
    fi

    local -a args
    if [ "$MODE" = "user" ]; then
        # Alte .deb/AppImage-Bundles werden nicht mehr gebraucht
        rm -rf "$TARGET_DIR/release/bundle"
        args=(build --ci --no-bundle -- --locked)
    else
        args=(build --ci --bundles deb -- --locked)
    fi

    : >"$BUILD_MARKER"
    status build 25 "Baue SlateDesk… (ca. $(((expected + 59) / 60)) Min.)"
    start_build_ticker "$expected"
    if ! run_logged "$SLATEDESK_HOME/node_modules/.bin/tauri" "${args[@]}"; then
        stop_build_ticker
        finish_fail 1 "Build fehlgeschlagen.$(failure_hint) Details im Update-Log."
    fi
    stop_build_ticker
    printf '%s\n' "$((SECONDS - started))" >"$BUILD_TIME_FILE"
    log_info "Build fertig nach $(((SECONDS - started) / 60)) Min. $(((SECONDS - started) % 60)) s."
}

is_elf() {
    [ -f "$1" ] && [ "$(od -An -tx1 -N4 "$1" 2>/dev/null | tr -d ' \n')" = "7f454c46" ]
}

# ─── App-Steuerung ───────────────────────────────────────────────────────────
# Grafische Variablen (DISPLAY, WAYLAND_DISPLAY, …) einer laufenden
# SlateDesk-Instanz, als KEY=VALUE-Zeilen.
capture_session_env() {
    local pid
    for pid in $(pgrep -u "$(id -u)" -x slate-desk 2>/dev/null || true); do
        [ -r "/proc/$pid/environ" ] || continue
        tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null |
            grep -E '^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|XDG_SESSION_DESKTOP)=' || true
        return 0
    done
}

# Desktops ohne systemd-Integration (z. B. labwc auf dem Raspberry Pi) geben
# dem User-Manager kein DISPLAY/WAYLAND_DISPLAY – dann aus der laufenden App übernehmen.
ensure_graphical_env() {
    local manager_env line
    local -a vars=()
    manager_env=$(systemctl --user show-environment 2>/dev/null || true)
    if grep -Eq '^(WAYLAND_DISPLAY|DISPLAY)=' <<<"$manager_env"; then
        return 0
    fi
    while IFS= read -r line; do
        [ -n "$line" ] && vars+=("$line")
    done < <(capture_session_env)
    if [ ${#vars[@]} -gt 0 ] && systemctl --user set-environment "${vars[@]}"; then
        log_info "Grafische Umgebung aus der laufenden App übernommen: ${vars[*]}"
    fi
}

# Beendet SlateDesk-Prozesse dieses Benutzers, die nicht vom User-Dienst
# stammen (alter Autostart-Eintrag, manuell gestartet) – sonst blockieren sie
# Port 7380 und die Single-Instance-Sperre.
kill_strays() {
    local uid pid cg i alive
    local -a strays=()
    uid=$(id -u)
    for pid in $(pgrep -u "$uid" -x slate-desk 2>/dev/null || true); do
        cg=$(cat "/proc/$pid/cgroup" 2>/dev/null || true)
        case $cg in
            *"/user@$uid.service/"*"/slatedesk.service"*) continue ;;
            *"/system.slice/slatedesk"*)
                log_warn "SlateDesk läuft zusätzlich als Systemdienst (altes Setup, PID $pid) – bitte scripts/setup.sh ausführen."
                continue
                ;;
        esac
        strays+=("$pid")
    done
    [ ${#strays[@]} -gt 0 ] || return 0
    log_info "Beende SlateDesk-Instanzen ausserhalb des Dienstes (PID ${strays[*]})."
    kill -TERM "${strays[@]}" 2>/dev/null || true
    for ((i = 0; i < 20; i++)); do
        alive=0
        for pid in "${strays[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then alive=1; fi
        done
        [ "$alive" -eq 0 ] && return 0
        sleep 0.5
    done
    kill -KILL "${strays[@]}" 2>/dev/null || true
}

app_session_available() {
    systemctl --user is-active --quiet slatedesk.service 2>/dev/null ||
        systemctl --user is-active --quiet graphical-session.target 2>/dev/null
}

restart_app() {
    ensure_graphical_env
    kill_strays
    systemctl --user reset-failed slatedesk.service >/dev/null 2>&1 || true
    if ! systemctl --user restart slatedesk.service; then
        log_error "systemctl --user restart slatedesk.service fehlgeschlagen."
        return 1
    fi
}

# env_lookup KEY TEXT – letzter Wert von KEY in einer Umgebungsliste
# (show-environment: eine Zeile je Variable; show -p Environment: durch
# Leerzeichen getrennt). Rückgabe 1, wenn KEY nicht vorkommt.
env_lookup() {
    local key=$1 text=$2 match
    match=$(grep -Eo "(^|[[:space:]\"'])$key=[^[:space:]\"']*" <<<"$text" | tail -n 1 || true)
    [ -n "$match" ] || return 1
    printf '%s' "${match#*"$key="}"
}

# Gültiger Port wie in der App (u16, nicht 0, führende Nullen und "+" erlaubt).
parse_port() {
    [[ ${1:-} =~ ^\+?0*([0-9]{1,5})$ ]] || return 1
    local port=$((10#${BASH_REMATCH[1]}))
    [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || return 1
    printf '%s' "$port"
}

# Wie EnvOverrides::from_env in remote.rs: 1, true oder yes (Gross-/Kleinschreibung egal).
env_flag_true() {
    case "${1,,}" in
        1 | true | yes) return 0 ;;
    esac
    return 1
}

# Port und Aktivierung der Fernsteuerung wie die App sie sieht:
# remote.json, überschrieben durch SLATEDESK_REMOTE_PORT/-DISABLED im Dienst.
health_settings() {
    local remote="$APP_CONFIG_DIR/remote.json" content="" src value port
    local env_port="" env_disabled=""
    HEALTH_PORT=$DEFAULT_PORT
    HEALTH_DISABLED=0
    if [ -r "$remote" ]; then
        content=$(cat "$remote" 2>/dev/null || true)
        value=$(grep -Eo '"port"[[:space:]]*:[[:space:]]*[0-9]+' <<<"$content" | grep -Eo '[0-9]+$' || true)
        if [ -n "$value" ] && port=$(parse_port "$value"); then
            HEALTH_PORT=$port
        fi
        if grep -Eq '"enabled"[[:space:]]*:[[:space:]]*false' <<<"$content"; then
            HEALTH_DISABLED=1
        fi
    fi
    # Die Environment= des Dienstes überschreiben die des User-Managers.
    for src in "$(systemctl --user show-environment 2>/dev/null || true)" \
        "$(systemctl --user show -p Environment --value slatedesk.service 2>/dev/null || true)"; do
        if value=$(env_lookup SLATEDESK_REMOTE_PORT "$src"); then env_port=$value; fi
        if value=$(env_lookup SLATEDESK_REMOTE_DISABLED "$src"); then env_disabled=$value; fi
    done
    if port=$(parse_port "$env_port"); then
        HEALTH_PORT=$port
    fi
    if env_flag_true "$env_disabled"; then
        HEALTH_DISABLED=1
    fi
}

# Ohne Fernsteuerung gibt es kein /api/health: dann muss der Prozess 20 s
# stabil laufen (kein Neustart durch Restart=always).
process_stable() {
    if [ "$MODE" = "legacy" ]; then
        sleep 20
        pgrep -u "$(id -u)" -x slate-desk >/dev/null 2>&1
        return
    fi
    local before after
    before=$(systemctl --user show -p NRestarts --value slatedesk.service 2>/dev/null || echo x)
    sleep 20
    after=$(systemctl --user show -p NRestarts --value slatedesk.service 2>/dev/null || echo y)
    systemctl --user is-active --quiet slatedesk.service && [ "$before" = "$after" ]
}

wait_for_health() {
    local timeout=${1:-$HEALTH_TIMEOUT} deadline body
    health_settings
    if [ "$HEALTH_DISABLED" -eq 1 ]; then
        log_info "Fernsteuerung deaktiviert – prüfe stattdessen, ob die App stabil läuft."
        if process_stable; then
            log_info "App läuft stabil."
            return 0
        fi
        log_error "App läuft nicht stabil."
        return 1
    fi
    deadline=$((SECONDS + timeout))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if body=$(curl -fsS --max-time 3 "http://127.0.0.1:$HEALTH_PORT/api/health" 2>/dev/null) &&
            [[ $body =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]; then
            log_info "Health-Check ok (Port $HEALTH_PORT): $body"
            return 0
        fi
        sleep 2
    done
    log_error "Keine Antwort von http://127.0.0.1:$HEALTH_PORT/api/health innerhalb von ${timeout} s."
    return 1
}

# ─── Benutzerinstallation (~/.local/opt/slatedesk) ───────────────────────────
current_release() {
    local target
    target=$(readlink "$OPT_DIR/current" 2>/dev/null || true)
    if [ -n "$target" ]; then printf '%s' "${target##*/}"; fi
}

switch_current() {
    local name=$1
    ln -sfn "releases/$name" "$OPT_DIR/.current.tmp"
    mv -Tf "$OPT_DIR/.current.tmp" "$OPT_DIR/current"
    log_info "Aktive Version: $name"
}

# Rollback-Ziel: die bisher aktive Version, bei einem Neubau desselben Commits
# die jüngste andere Version.
pick_rollback_target() {
    local new=$1 prev name
    prev=$(current_release)
    if [ -n "$prev" ] && [ "$prev" != "$new" ] && [ -x "$RELEASES_DIR/$prev/slate-desk" ]; then
        printf '%s' "$prev"
        return 0
    fi
    while IFS= read -r name; do
        if [ "$name" != "$new" ] && [ -x "$RELEASES_DIR/$name/slate-desk" ]; then
            printf '%s' "$name"
            return 0
        fi
    done < <(ls -1t "$RELEASES_DIR" 2>/dev/null || true)
}

install_release() {
    local built="$TARGET_DIR/release/slate-desk" name dir
    name=$(short "$TO_COMMIT")
    dir="$RELEASES_DIR/$name"
    status install 88 "Installiere Version $name…"
    if ! is_elf "$built"; then
        finish_fail 1 "Build-Ergebnis fehlt oder ist ungültig: $built"
    fi
    mkdir -p "$RELEASES_DIR"
    if [ -f "$PENDING_FILE" ]; then
        # Die bisher aktive Version wurde nie geprüft – zurück auf die zuletzt geprüfte.
        ROLLBACK_TARGET=$(pending_rollback_target "$name")
    else
        ROLLBACK_TARGET=$(pick_rollback_target "$name")
    fi
    mkdir -p "$dir"
    # rename statt Überschreiben: eine laufende Binary bleibt unangetastet
    cp -f "$built" "$dir/.slate-desk.tmp"
    chmod 0755 "$dir/.slate-desk.tmp"
    mv -f "$dir/.slate-desk.tmp" "$dir/slate-desk"
    printf '%s\n' "$TO_COMMIT" >"$dir/.commit.tmp"
    mv -f "$dir/.commit.tmp" "$dir/commit"
    switch_current "$name"
}

prune_releases() {
    local name kept=0
    local -a protected=()
    [ -d "$RELEASES_DIR" ] || return 0
    for name in "$@"; do
        [ -n "$name" ] && protected+=("$name")
    done
    kept=${#protected[@]}
    while IFS= read -r name; do
        [ -n "$name" ] || continue
        if [[ " ${protected[*]} " == *" $name "* ]]; then
            continue
        fi
        if [ "$kept" -lt "$KEEP_RELEASES" ]; then
            kept=$((kept + 1))
            continue
        fi
        rm -rf -- "${RELEASES_DIR:?}/$name"
        log_info "Alte Version entfernt: $name"
    done < <(ls -1t "$RELEASES_DIR" 2>/dev/null || true)
}

# Units aus dem Repository übernehmen, damit Änderungen daran mit dem Update ausgerollt werden.
sync_units() {
    local src dst base changed=0
    local -a new_timers=()
    [ -d "$SLATEDESK_HOME/scripts/systemd" ] || return 0
    mkdir -p "$UNIT_DIR"
    for src in "$SLATEDESK_HOME"/scripts/systemd/*.service "$SLATEDESK_HOME"/scripts/systemd/*.timer; do
        [ -f "$src" ] || continue
        base=${src##*/}
        dst="$UNIT_DIR/$base"
        if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
            continue
        fi
        if [ ! -f "$dst" ] && [[ $base == *.timer ]]; then
            new_timers+=("$base")
        fi
        install -m 0644 "$src" "$dst"
        changed=1
        log_info "Unit aktualisiert: $base"
    done
    [ "$changed" -eq 1 ] || return 0
    systemctl --user daemon-reload || log_warn "systemctl --user daemon-reload fehlgeschlagen."
    for base in "${new_timers[@]}"; do
        systemctl --user enable --now "$base" || log_warn "Timer $base konnte nicht aktiviert werden."
    done
}

rollback_release() {
    local failed=$1
    printf '%s\n' "$TO_COMMIT" >"$FAILED_FILE"
    rm -f "$PENDING_FILE"
    if [ -z "$ROLLBACK_TARGET" ]; then
        finish_fail 1 "Version $failed startet nicht, und es gibt keine vorherige Version – Details im Update-Log." rollback
    fi
    status rollback 96 "Version $failed startet nicht – stelle Version $ROLLBACK_TARGET wieder her…"
    switch_current "$ROLLBACK_TARGET"
    rm -rf -- "${RELEASES_DIR:?}/$failed"
    if restart_app && wait_for_health; then
        log_info "Rollback auf $ROLLBACK_TARGET erfolgreich."
    else
        log_error "Auch Version $ROLLBACK_TARGET antwortet nicht – bitte Journal prüfen ($JOURNAL_HINT)."
    fi
    finish_fail 1 "Update auf $failed fehlgeschlagen (App startete nicht) – Version $ROLLBACK_TARGET wiederhergestellt." rollback
}

# Merkt sich eine installierte, aber nicht gestartete Version samt Rollback-Ziel,
# damit "--activate" (setup.sh) bzw. der nächste Lauf sie bei einem Fehlstart
# zurückrollen kann.
mark_pending() {
    printf '%s\n' "$1" >"$PENDING_FILE.tmp" && mv -f "$PENDING_FILE.tmp" "$PENDING_FILE"
}

# Rollback-Ziel einer ungeprüften Version: das beim Installieren gemerkte,
# sonst die jüngste andere installierte Version.
pending_rollback_target() {
    local name=$1 target=""
    target=$(head -n 1 "$PENDING_FILE" 2>/dev/null || true)
    if [[ $target =~ ^[A-Za-z0-9._-]+$ ]] && [ "$target" != "$name" ] && [ -x "$RELEASES_DIR/$target/slate-desk" ]; then
        printf '%s' "$target"
        return 0
    fi
    pick_rollback_target "$name"
}

# Eine ohne Neustart installierte Version (keine Sitzung, setup.sh) hat noch
# keinen Health-Check bestanden. Läuft jetzt eine grafische Sitzung, wird das
# nachgeholt; startet sie nicht, folgt derselbe Rollback wie nach einem Update.
verify_pending() {
    local name
    [ "$MODE" = "user" ] && [ "$OPT_NO_RESTART" -eq 0 ] && [ -f "$PENDING_FILE" ] || return 0
    command -v curl >/dev/null 2>&1 || return 0
    name=$(current_release)
    if [ -z "$name" ] || [ ! -x "$OPT_DIR/current/slate-desk" ]; then
        rm -f "$PENDING_FILE"
        return 0
    fi
    if ! app_session_available; then
        log_info "Version $name wurde noch nicht geprüft – das folgt beim nächsten Lauf mit grafischer Sitzung."
        return 0
    fi
    TO_COMMIT=$(read_commit_file "$OPT_DIR/current/commit")
    ROLLBACK_TARGET=$(pending_rollback_target "$name")
    status health 2 "Prüfe den Start von Version $name…"
    if ! wait_for_health; then
        status restart 2 "Version $name antwortet nicht – starte SlateDesk neu…"
        if ! restart_app || ! wait_for_health; then
            rollback_release "$name"
        fi
    fi
    log_info "Version $name läuft."
    rm -f "$PENDING_FILE"
    if [ -n "$TO_COMMIT" ] && [ "$(read_commit_file "$FAILED_FILE")" = "$TO_COMMIT" ]; then
        rm -f "$FAILED_FILE"
    fi
    TO_COMMIT=""
    ROLLBACK_TARGET=""
}

activate_release() {
    local name
    name=$(short "$TO_COMMIT")
    if [ "$OPT_NO_RESTART" -eq 1 ]; then
        RESTART_SKIPPED=1
        log_info "Neustart übersprungen (--no-restart)."
        return 0
    fi
    status restart 92 "Starte SlateDesk neu…"
    if ! app_session_available; then
        RESTART_SKIPPED=1
        log_warn "Keine grafische Sitzung aktiv – Version $name startet bei der nächsten Anmeldung."
        return 0
    fi
    if ! restart_app; then
        rollback_release "$name"
    fi
    status health 95 "Prüfe den Start der neuen Version…"
    if ! wait_for_health; then
        rollback_release "$name"
    fi
}

update_user_mode() {
    local name
    name=$(short "$TO_COMMIT")
    install_release
    if user_unit_installed; then
        sync_units
    fi
    activate_release
    prune_releases "$name" "$ROLLBACK_TARGET"
    if [ "$RESTART_SKIPPED" -eq 1 ]; then
        # Noch nicht gestartet: eine Sperre (failed-commit) bleibt bestehen, bis
        # die Version einen Health-Check bestanden hat.
        mark_pending "$ROLLBACK_TARGET"
        finish_ok done "Version $name installiert – startet beim nächsten Start von SlateDesk."
    fi
    rm -f "$FAILED_FILE" "$PENDING_FILE"
    finish_ok done "Update auf Version $name abgeschlossen."
}

# ─── Altes Setup (dpkg + sudoers) ────────────────────────────────────────────
legacy_setup_hint() {
    log_warn "Altes Setup erkannt (dpkg/sudo). Bitte einmalig »sudo bash $SLATEDESK_HOME/scripts/setup.sh« ausführen:"
    log_warn "danach laufen Updates ohne sudo, mit Health-Check und automatischem Rollback."
}

legacy_find_deb() {
    local dir="$TARGET_DIR/release/bundle/deb"
    [ -d "$dir" ] || return 0
    find "$dir" -maxdepth 1 -type f -name '*.deb' -newer "$BUILD_MARKER" -printf '%T@ %p\n' 2>/dev/null |
        sort -nr | awk 'NR == 1 { sub(/^[^ ]+ /, ""); print }' || true
}

legacy_restart_app() {
    local uid line
    local -a setenv=()
    uid=$(id -u)
    if systemctl --user is-active --quiet slatedesk.service 2>/dev/null; then
        systemctl --user restart slatedesk.service || log_warn "Neustart von slatedesk.service fehlgeschlagen."
        return 0
    fi
    if systemctl is-active --quiet slatedesk.service 2>/dev/null; then
        # Der alte Systemdienst (Restart=always) startet die neue Binary selbst neu.
        log_info "Beende die App – der Systemdienst slatedesk.service startet sie neu."
        pkill -TERM -u "$uid" -x slate-desk 2>/dev/null || true
        return 0
    fi
    while IFS= read -r line; do
        [ -n "$line" ] && setenv+=("--setenv=$line")
    done < <(capture_session_env)
    pkill -TERM -u "$uid" -x slate-desk 2>/dev/null || true
    sleep 3
    pkill -KILL -u "$uid" -x slate-desk 2>/dev/null || true
    # KillMode=process: der Neustart in der App (Kiosk/Fernsteuerung) startet die
    # neue Instanz als Kindprozess und beendet sich mit 0 – ohne diese Option
    # beendet systemd mit der Unit auch die neue Instanz.
    if systemd-run --user --collect --unit="slatedesk-legacy-$(date +%s)" -p KillMode=process \
        "${setenv[@]}" "$LEGACY_BIN" >/dev/null 2>&1; then
        log_info "SlateDesk neu gestartet ($LEGACY_BIN)."
    else
        log_warn "SlateDesk konnte nicht gestartet werden – die neue Version startet bei der nächsten Anmeldung."
    fi
}

update_legacy_mode() {
    local deb name
    name=$(short "$TO_COMMIT")
    deb=$(legacy_find_deb)
    if [ -z "$deb" ]; then
        finish_fail 1 "Kein neues .deb-Paket gefunden in $TARGET_DIR/release/bundle/deb."
    fi
    status install 88 "Installiere Paket $(basename "$deb")…"
    # Genau der von der alten sudoers-Regel erlaubte Pfad; kein "dpkg -r",
    # dpkg -i aktualisiert an Ort und Stelle.
    if ! run_logged sudo -n /usr/bin/dpkg -i "$deb"; then
        legacy_setup_hint
        finish_fail 1 "Installation per sudo/dpkg nicht möglich – bitte einmalig »sudo bash $SLATEDESK_HOME/scripts/setup.sh« ausführen."
    fi
    printf '%s\n' "$TO_COMMIT" >"$INSTALLED_FILE"
    if [ "$OPT_NO_RESTART" -eq 0 ]; then
        status restart 92 "Starte SlateDesk neu…"
        legacy_restart_app
        status health 95 "Prüfe den Start der neuen Version…"
        if ! wait_for_health; then
            log_warn "Die neue Version antwortet (noch) nicht. Im alten Setup ist kein automatischer Rollback möglich."
        fi
    fi
    legacy_setup_hint
    finish_ok done "Update auf Version $name abgeschlossen (altes Setup – bitte setup.sh ausführen)."
}

# ─── Aktionen ────────────────────────────────────────────────────────────────
run_update() {
    if ! open_lock || ! flock -n 9; then
        log_info "Ein Update läuft bereits – nichts zu tun."
        exit 0
    fi
    LOCK_HELD=1
    rotate_log
    RUN_STARTED_MS=$(now_ms)
    install_traps
    detect_mode

    log_info "========================================"
    if [ "$MODE" = "user" ]; then
        log_info "SlateDesk Auto-Update gestartet (Benutzerinstallation, PID $$)"
    else
        log_info "SlateDesk Auto-Update gestartet (altes Setup mit dpkg, PID $$)"
    fi
    status start 1 "Update gestartet…"

    verify_pending
    check_tools
    if [ ! -d "$SLATEDESK_HOME/.git" ]; then
        finish_fail 2 "Kein Git-Checkout unter $SLATEDESK_HOME gefunden."
    fi
    cd "$SLATEDESK_HOME" || finish_fail 2 "Kein Zugriff auf $SLATEDESK_HOME."

    FROM_COMMIT=$(installed_commit)
    write_status network 3 "Prüfe Verbindung zu GitHub…"
    wait_for_network
    fetch_remote

    if [ "$OPT_FORCE" -eq 0 ]; then
        if [ "$FROM_COMMIT" = "$TO_COMMIT" ]; then
            finish_ok uptodate "SlateDesk ist aktuell (Version $(short "$TO_COMMIT"))."
        fi
        if [ "$(read_commit_file "$FAILED_FILE")" = "$TO_COMMIT" ]; then
            finish_fail 1 "Version $(short "$TO_COMMIT") startete nach dem letzten Update nicht und wird erst mit einem neuen Commit erneut versucht (oder auto-update.sh --force)." skipped
        fi
    fi
    local from_label="keine"
    if [ -n "$FROM_COMMIT" ]; then from_label=$(short "$FROM_COMMIT"); fi
    log_info "Neue Version: $from_label → $(short "$TO_COMMIT")"

    seed_legacy_installed
    checkout_target
    ensure_disk_space
    install_dependencies
    build_app

    if [ "$MODE" = "user" ]; then
        update_user_mode
    else
        update_legacy_mode
    fi
}

# Für setup.sh: installierte Version (neu) starten und prüfen. War sie noch
# nie gestartet (pending-activation) und antwortet nicht, wird sie wie bei
# einem Update gesperrt und die vorherige Version wiederhergestellt (Exit 3).
run_activate() {
    local name commit target
    MODE="user"
    if ! open_lock || ! flock -w 600 9; then
        log_error "Ein Update läuft gerade – bitte später erneut versuchen."
        exit 1
    fi
    if [ ! -x "$OPT_DIR/current/slate-desk" ]; then
        log_error "Keine installierte Version unter $OPT_DIR/current."
        exit 1
    fi
    name=$(current_release)
    commit=$(read_commit_file "$OPT_DIR/current/commit")
    log_info "Starte SlateDesk $name als Benutzerdienst…"
    if restart_app && wait_for_health; then
        rm -f "$PENDING_FILE"
        if [ -n "$commit" ] && [ "$(read_commit_file "$FAILED_FILE")" = "$commit" ]; then
            rm -f "$FAILED_FILE"
        fi
        exit 0
    fi
    if [ ! -f "$PENDING_FILE" ]; then
        log_error "SlateDesk $name startet nicht – bitte Journal prüfen ($JOURNAL_HINT)."
        exit 1
    fi

    RUN_STARTED_MS=$(now_ms)
    TO_COMMIT=$commit
    target=$(pending_rollback_target "$name")
    rm -f "$PENDING_FILE"
    if [ -n "$commit" ]; then
        printf '%s\n' "$commit" >"$FAILED_FILE"
    fi
    if [ -z "$target" ]; then
        write_status rollback 100 "Version $name startet nicht, und es gibt keine vorherige Version – Details im Update-Log." true true
        log_error "Version $name startet nicht, und es gibt keine vorherige Version."
        exit 1
    fi
    FROM_COMMIT=$(read_commit_file "$RELEASES_DIR/$target/commit")
    log_warn "Version $name startet nicht – stelle Version $target wieder her…"
    switch_current "$target"
    rm -rf -- "${RELEASES_DIR:?}/$name"
    if restart_app && wait_for_health; then
        write_status rollback 100 "Version $name startete nicht – Version $target wiederhergestellt." true true
        log_info "Rollback auf $target erfolgreich."
        exit 3
    fi
    write_status rollback 100 "Version $name startete nicht – auch die wiederhergestellte Version $target antwortet nicht." true true
    log_error "Auch Version $target antwortet nicht – bitte Journal prüfen ($JOURNAL_HINT)."
    exit 1
}

run_health() {
    if user_unit_installed; then MODE="user"; else MODE="legacy"; fi
    if wait_for_health 15; then
        exit 0
    fi
    exit 1
}

main() {
    parse_args "$@"
    init_globals
    if [ "$(id -u)" -eq 0 ]; then
        local owner
        # Der Checkout gehört dem Kiosk-Benutzer
        owner=$(stat -c %U "$(readlink -f "${BASH_SOURCE[0]}")" 2>/dev/null || true)
        if [ -z "$owner" ] || [ "$owner" = "root" ] || [ "$owner" = "UNKNOWN" ]; then owner=slatedesk; fi
        printf 'auto-update.sh nicht als root ausführen. Update als Kiosk-Benutzer starten:\n  sudo systemctl --user -M %s@ start slatedesk-update.service\n' "$owner" >&2
        exit 2
    fi
    setup_env
    mkdir -p "$STATE_DIR"
    case "$ACTION" in
        activate) run_activate ;;
        health) run_health ;;
        *) run_update ;;
    esac
}

main "$@"; exit
