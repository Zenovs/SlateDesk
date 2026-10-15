#!/usr/bin/env bash
#
# SlateDesk installieren – in einem Schritt:
#
#   curl -fsSL https://raw.githubusercontent.com/Zenovs/SlateDesk/main/install.sh | sudo bash
#
# Optionen gehen an scripts/setup.sh weiter (Übersicht: --help), z. B.:
#
#   curl -fsSL …/install.sh | sudo bash -s -- --ufw --autologin
#
# Lädt scripts/setup.sh des gewählten Branches von GitHub und startet es; setup.sh
# klont das Repository, baut SlateDesk und richtet die Dienste ein. Rückfragen
# kommen über das Terminal, auch wenn dieses Script über eine Pipe läuft.
# Unter zenOS wird für das Anzeige-Konto «anzeige» installiert, sonst für den
# aufrufenden Benutzer (zenOS hat genau einen Benutzer); anderswo legt setup.sh
# den Benutzer «slatedesk» an.
#
# Alles steckt in main(): bei «curl | bash» liest bash das Script erst ganz ein.
set -Eeuo pipefail

die() { printf 'SlateDesk: %s\n' "$*" >&2; exit 1; }
info() { printf '› %s\n' "$*"; }

usage() {
    cat <<'EOF'
Verwendung:
  curl -fsSL https://raw.githubusercontent.com/Zenovs/SlateDesk/main/install.sh | sudo bash
  curl -fsSL …/install.sh | sudo bash -s -- [Optionen]

Optionen dieses Scripts:
  --branch NAME   Branch, aus dem installiert und später aktualisiert wird
                  (Standard: main)
  --dry-run       Nur anzeigen, was ausgeführt würde
  -h, --help      Diese Hilfe anzeigen

Alle übrigen Optionen gehen an scripts/setup.sh, zum Beispiel:
  --user NAME     Kiosk-Benutzer (Standard: slatedesk; unter zenOS «anzeige»
                  bzw. der aufrufende Benutzer)
  --ufw           Port 7380 der Fernsteuerung im lokalen Netz freigeben
  --autologin     Automatische Anmeldung (GDM/LightDM, nicht unter zenOS)
EOF
}

# Wie setup.sh: kein Optionsstart, keine «..», kein .lock am Ende.
valid_branch() {
    [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && $1 != *..* && $1 != *.lock && $1 != */ ]]
}

main() {
    local repo=${SLATEDESK_REPO:-Zenovs/SlateDesk}
    local branch=${SLATEDESK_BRANCH:-main}
    local dry_run=0 has_user=0 help=0 url tmp rc
    local -a args=()

    while [ $# -gt 0 ]; do
        case "$1" in
            --branch) branch=${2:?--branch braucht einen Namen}; shift ;;
            --branch=*) branch=${1#*=} ;;
            --dry-run) dry_run=1 ;;
            -h | --help) help=1 ;;
            --user | --user=*)
                has_user=1
                args+=("$1")
                if [ "$1" = --user ]; then args+=("${2:?--user braucht einen Namen}"); shift; fi
                ;;
            *) args+=("$1") ;;
        esac
        shift
    done
    if [ "$help" -eq 1 ]; then usage; return 0; fi
    valid_branch "$branch" || die "Ungültiger Branch-Name: $branch"
    [[ $repo =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "Ungültiges Repository: $repo"
    args+=(--branch "$branch")
    if [ -n "${SLATEDESK_REPO:-}" ]; then args+=(--repo "https://github.com/$repo.git"); fi

    if [ "$has_user" -eq 0 ] && [ -d /opt/zenos ]; then
        if id anzeige >/dev/null 2>&1; then
            info "zenOS erkannt: SlateDesk wird für das Anzeige-Konto «anzeige» installiert."
            args+=(--user anzeige)
        elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
            info "zenOS erkannt, kein Anzeige-Konto: SlateDesk wird für «$SUDO_USER» installiert."
            info "Die automatische Sperre von zenOS gilt dann weiter (Anzeige-Profil fehlt)."
            args+=(--user "$SUDO_USER")
        fi
    fi

    url="https://raw.githubusercontent.com/$repo/$branch/scripts/setup.sh"
    if [ "$dry_run" -eq 1 ]; then
        info "Würde laden: $url"
        info "Würde ausführen: bash setup.sh ${args[*]}"
        return 0
    fi

    [ "$(id -u)" -eq 0 ] || die "Bitte mit sudo starten: curl -fsSL …/install.sh | sudo bash"
    command -v apt-get >/dev/null 2>&1 || die "Nur für Debian/Ubuntu/Raspberry Pi OS (apt) vorgesehen."
    command -v curl >/dev/null 2>&1 || die "curl fehlt (sudo apt-get install curl)."

    tmp=$(mktemp /tmp/slatedesk-setup.XXXXXX)
    info "Lade setup.sh ($repo, Branch $branch)…"
    if ! curl -fsSL --retry 3 --connect-timeout 15 "$url" -o "$tmp"; then
        rm -f "$tmp"
        die "Download fehlgeschlagen: $url"
    fi
    if ! head -n 1 "$tmp" | grep -q '^#!/usr/bin/env bash'; then
        rm -f "$tmp"
        die "Unerwartete Antwort von $url (kein setup.sh)."
    fi

    # Rückfragen von setup.sh brauchen das Terminal, nicht die Pipe von curl.
    set +e
    if (: </dev/tty) 2>/dev/null; then
        bash "$tmp" "${args[@]}" </dev/tty
    else
        bash "$tmp" "${args[@]}"
    fi
    rc=$?
    set -e
    rm -f "$tmp"
    return "$rc"
}

main "$@"; exit
