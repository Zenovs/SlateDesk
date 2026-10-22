#!/bin/sh
# SlateDesk – gibt die Lüfter, die SlateDesk geregelt hat, an den Chip bzw. das BIOS zurück.
# ExecStopPost von slatedesk.service: greift auch nach einem Absturz.
#
# Die Datei schreibt src-tauri/src/fans.rs, bevor es einen Lüfter übernimmt – je Lüfter
# «<pwmN_enable> <Wert> <pwmN> <Wert> <id>». Sie liegt im Laufzeitverzeichnis
# ($XDG_RUNTIME_DIR) und ist nach einem Neustart weg; dann regelt der Chip ohnehin selbst.
file=${1:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/slatedesk-fans}
[ -f "$file" ] || exit 0
while read -r enable_path enable pwm_path pwm _id; do
    case "$enable_path" in /sys/*) ;; *) continue ;; esac
    case "$pwm_path" in /sys/*) ;; *) continue ;; esac
    printf '%s' "$enable" >"$enable_path" 2>/dev/null || continue
    if [ "$enable" = 1 ]; then printf '%s' "$pwm" >"$pwm_path" 2>/dev/null; fi
done <"$file"
rm -f "$file"
exit 0
