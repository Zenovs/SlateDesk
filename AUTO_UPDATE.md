# SlateDesk – Auto-Update

Diese Anleitung ist veraltet. Das frühere Update-System (`.deb`-Paket, sudo-Regel für `dpkg`, Cronjob um
01:00, `slatedesk-boot-update.service`, stündlicher Neustart) gibt es nicht mehr; auch `AUTO_UPDATE.pdf`
beschreibt noch diesen alten Stand.

Heute aktualisiert sich SlateDesk als Benutzer `slatedesk` ohne Root-Rechte: systemd-User-Timer täglich um
01:00 und kurz nach dem Systemstart, Build ins Home-Verzeichnis, Neustart mit Health-Check und
automatischem Rollback. Eingerichtet wird das mit `scripts/setup.sh`, das auch ein altes Setup migriert.

**Alles Weitere: [docs/BETRIEB.md](docs/BETRIEB.md)** – Abschnitte «Installation», «Migration vom alten
Setup», «Update und Rollback» und «Fehlersuche».
