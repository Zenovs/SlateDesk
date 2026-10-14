#!/usr/bin/env bash
#
# VERALTET – Weiterleitung auf scripts/setup.sh (Installation, Updates und
# Migration vom alten dpkg/sudo-Setup). Bleibt für alte Anleitungen bestehen.
#
echo "Hinweis: setup-auto-update.sh ist veraltet – es wird scripts/setup.sh ausgeführt." >&2
exec bash "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/setup.sh" "$@"
