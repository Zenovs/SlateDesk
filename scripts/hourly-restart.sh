#!/usr/bin/env bash
#
# VERALTET – macht absichtlich nichts mehr.
#
# Der stündliche Neustart (killall + Neustart) ist ersetzt durch
# slatedesk.service (Restart=always) und den nächtlichen Neustart
# slatedesk-restart.timer. Die Datei bleibt bestehen, damit alte Cron-Einträge
# bis zum Ausführen von setup.sh harmlos sind; setup.sh entfernt den Eintrag.
#
# Absoluter Pfad: "~" wäre beim Admin, der den Hinweis liest, sein eigenes Home.
self=$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null) || self=/home/slatedesk/SlateDesk/scripts/hourly-restart.sh
setup="$(dirname "$self")/setup.sh"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] hourly-restart.sh ist veraltet und tut nichts mehr – bitte »sudo bash $setup« ausführen (entfernt diesen Cron-Eintrag)."
exit 0
