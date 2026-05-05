#!/usr/bin/env bash
#
# SlateDesk Auto-Update Setup Script
# Installiert das vollautomatische Update-System auf dem Nutzer-Rechner.
#
# Ausführung: sudo bash scripts/setup-auto-update.sh
#
set -euo pipefail

# ─── Farben ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── Root-Check ──────────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    error "Dieses Script muss als root ausgeführt werden."
    echo "  Bitte mit: sudo bash $0"
    exit 1
fi

# ─── Konfiguration ───────────────────────────────────────────────────────────
SLATEDESK_USER="slatedesk"
SLATEDESK_HOME="/home/$SLATEDESK_USER/SlateDesk"
SCRIPTS_DIR="$SLATEDESK_HOME/scripts"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║        SlateDesk Auto-Update Setup                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ─── Prüfe Voraussetzungen ───────────────────────────────────────────────────
info "Prüfe Voraussetzungen..."

# Prüfe ob Nutzer existiert
if ! id "$SLATEDESK_USER" &>/dev/null; then
    error "Nutzer '$SLATEDESK_USER' existiert nicht!"
    exit 1
fi
ok "Nutzer '$SLATEDESK_USER' gefunden."

# Prüfe ob Projektverzeichnis existiert
if [ ! -d "$SLATEDESK_HOME" ]; then
    error "Projektverzeichnis nicht gefunden: $SLATEDESK_HOME"
    exit 1
fi
ok "Projektverzeichnis gefunden."

# Prüfe ob Scripts vorhanden sind
if [ ! -f "$SCRIPTS_DIR/auto-update.sh" ]; then
    error "auto-update.sh nicht gefunden in $SCRIPTS_DIR"
    exit 1
fi
ok "Update-Script gefunden."

# ─── Schritt 1: Scripts ausführbar machen ────────────────────────────────────
info "Schritt 1: Mache Scripts ausführbar..."
chmod +x "$SCRIPTS_DIR/auto-update.sh"
ok "auto-update.sh ist ausführbar."

# ─── Schritt 2: Sudo-Konfiguration ──────────────────────────────────────────
info "Schritt 2: Konfiguriere sudo-Berechtigungen..."

SUDOERS_FILE="/etc/sudoers.d/slatedesk-update"

# Erstelle sudoers-Datei
cat > "$SUDOERS_FILE" << 'SUDOERS_EOF'
# SlateDesk Auto-Update: Erlaubt dpkg ohne Passwort
slatedesk ALL=(root) NOPASSWD: /usr/bin/dpkg -r slate-desk
slatedesk ALL=(root) NOPASSWD: /usr/bin/dpkg -i /home/slatedesk/SlateDesk/src-tauri/target/release/bundle/deb/*.deb
SUDOERS_EOF

# Setze korrekte Berechtigungen (WICHTIG für sudoers!)
chmod 0440 "$SUDOERS_FILE"
chown root:root "$SUDOERS_FILE"

# Validiere sudoers-Datei
if visudo -cf "$SUDOERS_FILE" &>/dev/null; then
    ok "Sudo-Konfiguration installiert und validiert."
else
    error "Sudo-Konfiguration ungültig! Wird entfernt."
    rm -f "$SUDOERS_FILE"
    exit 1
fi

# ─── Schritt 3: Cronjob einrichten (01:00 Uhr) ──────────────────────────────
info "Schritt 3: Richte Cronjob ein (täglich 01:00 Uhr)..."

# Entferne alten Cronjob falls vorhanden
crontab -u "$SLATEDESK_USER" -l 2>/dev/null | grep -v 'auto-update.sh' > /tmp/slatedesk_cron_tmp || true

# Füge neuen Cronjob hinzu
echo "# SlateDesk Auto-Update: Täglich um 01:00 Uhr" >> /tmp/slatedesk_cron_tmp
echo "0 1 * * * /home/slatedesk/SlateDesk/scripts/auto-update.sh >> /home/slatedesk/slatedesk-update.log 2>&1" >> /tmp/slatedesk_cron_tmp

crontab -u "$SLATEDESK_USER" /tmp/slatedesk_cron_tmp
rm -f /tmp/slatedesk_cron_tmp
ok "Cronjob eingerichtet: täglich um 01:00 Uhr."

# ─── Schritt 4: Systemd Boot-Service ────────────────────────────────────────
info "Schritt 4: Installiere systemd Boot-Update-Service..."

SERVICE_FILE="/etc/systemd/system/slatedesk-boot-update.service"

cat > "$SERVICE_FILE" << SERVICE_EOF
[Unit]
Description=SlateDesk Boot Update Check
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$SLATEDESK_USER
Group=$SLATEDESK_USER
ExecStart=$SCRIPTS_DIR/auto-update.sh
Environment=SLATEDESK_HOME=$SLATEDESK_HOME
Environment=SLATEDESK_LOG=/home/$SLATEDESK_USER/slatedesk-update.log
StandardOutput=journal
StandardError=journal
TimeoutStartSec=3600

[Install]
WantedBy=multi-user.target
SERVICE_EOF

systemctl daemon-reload
systemctl enable slatedesk-boot-update.service
ok "Boot-Update-Service installiert und aktiviert."

# ─── Schritt 5: Backup-Verzeichnis erstellen ────────────────────────────────
info "Schritt 5: Erstelle Backup-Verzeichnis..."
mkdir -p "/home/$SLATEDESK_USER/.slatedesk-backups"
chown "$SLATEDESK_USER:$SLATEDESK_USER" "/home/$SLATEDESK_USER/.slatedesk-backups"
ok "Backup-Verzeichnis erstellt."

# ─── Schritt 6: Log-Datei vorbereiten ────────────────────────────────────────
info "Schritt 6: Bereite Log-Datei vor..."
touch "/home/$SLATEDESK_USER/slatedesk-update.log"
chown "$SLATEDESK_USER:$SLATEDESK_USER" "/home/$SLATEDESK_USER/slatedesk-update.log"
ok "Log-Datei vorbereitet."

# ─── Schritt 7: SlateDesk Autostart einrichten ──────────────────────────────
info "Schritt 7: Richte SlateDesk Autostart ein..."

# Methode A: ~/.config/autostart (für grafische Sitzungen / GNOME)
AUTOSTART_DIR="/home/$SLATEDESK_USER/.config/autostart"
mkdir -p "$AUTOSTART_DIR"
cp "$SCRIPTS_DIR/slatedesk-autostart.desktop" "$AUTOSTART_DIR/slatedesk.desktop"
chown -R "$SLATEDESK_USER:$SLATEDESK_USER" "$AUTOSTART_DIR"
ok "Autostart-Desktop-Eintrag installiert: $AUTOSTART_DIR/slatedesk.desktop"

# Methode B: systemd user-service als Fallback
SYSTEMD_USER_DIR="/home/$SLATEDESK_USER/.config/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"
cp "$SCRIPTS_DIR/slatedesk.service" "$SYSTEMD_USER_DIR/slatedesk.service"
chown -R "$SLATEDESK_USER:$SLATEDESK_USER" "$SYSTEMD_USER_DIR"

# User-Lingering aktivieren (damit User-Services auch ohne Login laufen)
loginctl enable-linger "$SLATEDESK_USER" 2>/dev/null || true

# Service als slatedesk-User aktivieren
su -l "$SLATEDESK_USER" -c "
    export XDG_RUNTIME_DIR=/run/user/\$(id -u)
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user enable slatedesk.service 2>/dev/null || true
" 2>/dev/null || warn "systemd user-service konnte nicht aktiviert werden (Fallback: Desktop-Autostart übernimmt)."
ok "systemd User-Service installiert."

# ─── Zusammenfassung ─────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║        Setup abgeschlossen!                         ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  ✅ Update-Script:    $SCRIPTS_DIR/auto-update.sh"
echo "  ✅ Sudo-Config:      $SUDOERS_FILE"
echo "  ✅ Cronjob:          Täglich um 01:00 Uhr"
echo "  ✅ Boot-Service:     slatedesk-boot-update.service"
echo "  ✅ Autostart:        $AUTOSTART_DIR/slatedesk.desktop"
echo "  ✅ User-Service:     $SYSTEMD_USER_DIR/slatedesk.service"
echo "  ✅ Backup-Ordner:    /home/$SLATEDESK_USER/.slatedesk-backups"
echo "  ✅ Log-Datei:        /home/$SLATEDESK_USER/slatedesk-update.log"
echo ""
echo "  Manuell testen:"
echo "    sudo -u $SLATEDESK_USER $SCRIPTS_DIR/auto-update.sh"
echo ""
echo "  Logs prüfen:"
echo "    tail -f /home/$SLATEDESK_USER/slatedesk-update.log"
echo "    journalctl -u slatedesk-boot-update.service"
echo ""
echo "  Deaktivieren:"
echo "    sudo systemctl disable slatedesk-boot-update.service"
echo "    sudo crontab -u $SLATEDESK_USER -r"
echo ""
