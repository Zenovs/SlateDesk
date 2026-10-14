#!/bin/sh
#
# SlateDesk – Start beim Anmelden (XDG-Autostart, installiert von setup.sh)
#
# Startet den User-Dienst slatedesk.service auch auf Desktops, die
# graphical-session.target nicht aktivieren (z. B. Raspberry Pi OS mit labwc
# oder wayfire). Die grafischen Variablen werden dem systemd-User-Manager
# übergeben, damit die App das Display findet. Unter GNOME läuft der Dienst
# bereits – der Aufruf ändert dann nichts.
#
vars=""
for v in DISPLAY WAYLAND_DISPLAY XAUTHORITY XDG_SESSION_TYPE XDG_CURRENT_DESKTOP XDG_SESSION_DESKTOP; do
    if printenv "$v" >/dev/null 2>&1; then
        vars="$vars $v"
    fi
done
if [ -n "$vars" ]; then
    # shellcheck disable=SC2086 # Variablennamen absichtlich einzeln übergeben
    systemctl --user import-environment $vars
fi
exec systemctl --user start --no-block slatedesk.service
