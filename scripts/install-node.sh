#!/usr/bin/env bash
#
# SlateDesk – Node.js für den Kiosk-Benutzer installieren (ohne root, ohne apt)
#
# Lädt das offizielle Archiv der aktuellen Node.js-22-Version von nodejs.org,
# prüft es gegen SHASUMS256.txt und legt es unter ~/.local/opt/nodejs/<version>
# ab; ~/.local/bin/{node,npm,npx} zeigen auf die aktive Version. setup.sh ruft
# das als Kiosk-Benutzer auf, auto-update.sh findet Node über ~/.local/bin.
#
# Warum nicht apt/NodeSource: jeder apt-Lauf startet die apt-Hooks des Systems
# (needrestart, Hooks der Distribution) – hängt einer davon, hängt die ganze
# Installation. Rust kommt aus demselben Grund per rustup ins Benutzerkonto.
#
# Alles steckt in main(): das Script kann während eines Laufs ersetzt werden.
set -Eeuo pipefail

MAJOR=22
BASE_URL="https://nodejs.org/dist/latest-v$MAJOR.x"
TMP_DIR=""

die() { printf 'install-node: %s\n' "$*" >&2; exit 1; }

node_arch() {
    case "$(uname -m)" in
        x86_64 | amd64) echo x64 ;;
        aarch64 | arm64) echo arm64 ;;
        armv7l) echo armv7l ;;
        *) die "Prozessor $(uname -m) wird von Node.js nicht unterstützt." ;;
    esac
}

main() {
    local arch sums file sha version opt
    trap 'rm -rf "${TMP_DIR:-}"' EXIT
    command -v curl >/dev/null 2>&1 || die "curl fehlt."
    command -v sha256sum >/dev/null 2>&1 || die "sha256sum fehlt."
    arch=$(node_arch)
    opt="$HOME/.local/opt/nodejs"

    sums=$(curl -fsSL --retry 3 --connect-timeout 15 "$BASE_URL/SHASUMS256.txt") ||
        die "Versionsliste von nodejs.org nicht erreichbar."
    file=$(awk -v suffix="-linux-$arch.tar.xz" '
        $2 ~ /^node-v[0-9]+\.[0-9]+\.[0-9]+-linux-/ && substr($2, length($2) - length(suffix) + 1) == suffix { print $2; exit }
    ' <<<"$sums")
    [ -n "$file" ] || die "Kein Node.js-$MAJOR-Archiv für linux-$arch gefunden."
    sha=$(awk -v f="$file" '$2 == f { print $1; exit }' <<<"$sums")
    [[ $sha =~ ^[0-9a-f]{64}$ ]] || die "Prüfsumme für $file fehlt."
    version=${file%-linux-*}
    version=${version#node-}

    if [ -x "$opt/$version/bin/node" ]; then
        printf 'Node.js %s ist bereits installiert.\n' "$version"
    else
        printf 'Lade Node.js %s (linux-%s)…\n' "$version" "$arch"
        mkdir -p "$opt"
        TMP_DIR=$(mktemp -d "$opt/.download.XXXXXX")
        curl -fsSL --retry 3 --connect-timeout 15 "$BASE_URL/$file" -o "$TMP_DIR/$file" ||
            die "Download von $file fehlgeschlagen."
        (cd "$TMP_DIR" && printf '%s  %s\n' "$sha" "$file" | sha256sum -c --quiet -) ||
            die "Prüfsumme von $file stimmt nicht – Download verworfen."
        mkdir "$TMP_DIR/x"
        tar -xJf "$TMP_DIR/$file" -C "$TMP_DIR/x" --strip-components=1 || die "Entpacken von $file fehlgeschlagen."
        [ -x "$TMP_DIR/x/bin/node" ] || die "Archiv ohne bin/node."
        rm -rf "${opt:?}/$version"
        mv "$TMP_DIR/x" "$opt/$version"
    fi

    # Aktive Version atomar umstellen, dann die Befehle in ~/.local/bin verlinken.
    ln -sfn "$version" "$opt/current.tmp"
    mv -Tf "$opt/current.tmp" "$opt/current"
    mkdir -p "$HOME/.local/bin"
    local cmd
    for cmd in node npm npx; do
        ln -sfn "$opt/current/bin/$cmd" "$HOME/.local/bin/$cmd"
    done

    # Ältere Versionen entfernen (die aktive bleibt).
    local old
    for old in "$opt"/v*; do
        [ -d "$old" ] && [ "${old##*/}" != "$version" ] && rm -rf "$old"
    done

    # npm und npx starten über «env node» – ~/.local/bin muss im Suchpfad stehen.
    export PATH="$HOME/.local/bin:$PATH"
    node -v >/dev/null || die "Node.js startet nicht."
    npm -v >/dev/null || die "npm startet nicht."
    printf 'Node.js %s und npm %s bereit (%s).\n' "$(node -v)" "$(npm -v)" "$HOME/.local/bin"
}

main "$@"; exit
