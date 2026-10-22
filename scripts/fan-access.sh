#!/bin/sh
# SlateDesk – gibt die Lüfter-Ausgänge (pwmN, pwmN_enable) eines hwmon-Geräts für das
# Kiosk-Konto frei, damit SlateDesk sie über die Fernsteuerung regeln kann.
#
# Aufruf: fan-access <hwmon-Verzeichnis> <Gruppe>
# Installiert von scripts/setup.sh nach /usr/local/lib/slatedesk/fan-access (root), aufgerufen
# von /etc/udev/rules.d/90-slatedesk-fans.rules für jedes hwmon-Gerät, also bei jedem Start.
dir=$1
group=$2
[ -d "$dir" ] && [ -n "$group" ] || exit 0
for f in "$dir"/pwm[0-9] "$dir"/pwm[0-9]_enable "$dir"/pwm[0-9][0-9] "$dir"/pwm[0-9][0-9]_enable \
    "$dir"/device/pwm[0-9] "$dir"/device/pwm[0-9]_enable; do
    [ -f "$f" ] || continue
    chgrp "$group" "$f" && chmod g+w "$f"
done
exit 0
