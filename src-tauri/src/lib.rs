use serde::Serialize;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
use webkit2gtk::{WebViewExt, PermissionRequestExt};

#[derive(Serialize)]
struct UpdateInfo {
    available: bool,
    current_commit: String,
    remote_commit: String,
    short_current: String,
    short_remote: String,
}

fn project_dir() -> String {
    std::env::var("SLATEDESK_HOME").unwrap_or_else(|_| "/home/slatedesk/SlateDesk".to_string())
}

#[tauri::command]
fn check_for_updates() -> Result<UpdateInfo, String> {
    let dir = project_dir();

    // git fetch origin main
    let fetch = Command::new("git")
        .args(["fetch", "origin", "main"])
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("git fetch fehlgeschlagen: {e}"))?;

    if !fetch.status.success() {
        let stderr = String::from_utf8_lossy(&fetch.stderr);
        return Err(format!("git fetch: {stderr}"));
    }

    let current_commit = String::from_utf8_lossy(
        &Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(&dir)
            .output()
            .map_err(|e| format!("git rev-parse HEAD: {e}"))?
            .stdout,
    )
    .trim()
    .to_string();

    let remote_commit = String::from_utf8_lossy(
        &Command::new("git")
            .args(["rev-parse", "origin/main"])
            .current_dir(&dir)
            .output()
            .map_err(|e| format!("git rev-parse origin/main: {e}"))?
            .stdout,
    )
    .trim()
    .to_string();

    Ok(UpdateInfo {
        available: current_commit != remote_commit,
        short_current: current_commit.chars().take(7).collect(),
        short_remote: remote_commit.chars().take(7).collect(),
        current_commit,
        remote_commit,
    })
}

#[derive(Serialize)]
struct SpeedResult {
    download_mbps: f64,
    upload_mbps: f64,
    interface: String,
    interface_type: String,
    timestamp: u64,
}

#[tauri::command]
fn run_speed_test() -> Result<SpeedResult, String> {
    // Aktives Netzwerk-Interface ermitteln
    let route = Command::new("ip")
        .args(["route", "get", "8.8.8.8"])
        .output()
        .map_err(|e| format!("ip route fehlgeschlagen: {e}"))?;
    let route_str = String::from_utf8_lossy(&route.stdout);
    let interface = route_str
        .split_whitespace()
        .skip_while(|&s| s != "dev")
        .nth(1)
        .unwrap_or("unknown")
        .to_string();

    // LAN oder WLAN?
    let wireless_path = format!("/sys/class/net/{}/wireless", interface);
    let interface_type = if std::path::Path::new(&wireless_path).exists() {
        "WLAN".to_string()
    } else {
        "LAN".to_string()
    };

    // Download-Speed messen (10 MB via curl)
    let dl = Command::new("curl")
        .args([
            "-o", "/dev/null", "-s", "-w", "%{speed_download}",
            "--max-time", "20",
            "https://speed.cloudflare.com/__down?bytes=10000000",
        ])
        .output()
        .map_err(|e| format!("curl Download fehlgeschlagen: {e}"))?;
    let dl_bps: f64 = String::from_utf8_lossy(&dl.stdout)
        .trim().parse().unwrap_or(0.0);
    let download_mbps = (dl_bps * 8.0 / 1_000_000.0 * 10.0).round() / 10.0;

    // Upload-Speed messen (5 MB Nullbytes via curl)
    let ul = Command::new("sh")
        .args(["-c",
            "dd if=/dev/zero bs=1M count=5 2>/dev/null | curl -o /dev/null -s -w '%{speed_upload}' -X POST --data-binary @- --max-time 20 https://speed.cloudflare.com/__up"
        ])
        .output()
        .map_err(|e| format!("curl Upload fehlgeschlagen: {e}"))?;
    let ul_str = String::from_utf8_lossy(&ul.stdout);
    let ul_bps: f64 = ul_str.trim().trim_matches('\'').parse().unwrap_or(0.0);
    let upload_mbps = (ul_bps * 8.0 / 1_000_000.0 * 10.0).round() / 10.0;

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();

    Ok(SpeedResult { download_mbps, upload_mbps, interface, interface_type, timestamp })
}

#[derive(Serialize)]
struct UpdateProgress {
    percent: u8,
    message: String,
    done: bool,
    error: bool,
}

#[tauri::command]
fn get_update_progress() -> UpdateProgress {
    let log_path = std::env::var("SLATEDESK_LOG")
        .unwrap_or_else(|_| "/home/slatedesk/slatedesk-update.log".to_string());

    let content = std::fs::read_to_string(&log_path).unwrap_or_default();

    // Nur den letzten Update-Durchlauf betrachten
    let start_idx = content.rfind("Auto-Update gestartet").unwrap_or(0);
    let run = &content[start_idx..];

    let has = |needle: &str| run.contains(needle);

    if has("Update erfolgreich abgeschlossen") {
        return UpdateProgress { percent: 100, message: "Abgeschlossen!".into(), done: true, error: false };
    }
    if has("Rollback") || run.lines().any(|l| l.contains("[ERROR]")) {
        return UpdateProgress { percent: 0, message: "Fehler – siehe Log".into(), done: false, error: true };
    }
    if has("Starte SlateDesk") {
        return UpdateProgress { percent: 95, message: "Starte SlateDesk…".into(), done: false, error: false };
    }
    if has("Installiere neues Paket") {
        return UpdateProgress { percent: 88, message: "Installiere Paket…".into(), done: false, error: false };
    }
    if has("Deinstalliere altes Paket") {
        return UpdateProgress { percent: 84, message: "Deinstalliere altes Paket…".into(), done: false, error: false };
    }
    if has("Stoppe SlateDesk") {
        return UpdateProgress { percent: 82, message: "Stoppe SlateDesk…".into(), done: false, error: false };
    }

    // Build-Phase: zeitbasiert von 35% → 81% (ca. 12 Minuten)
    if has("Baue SlateDesk neu") {
        let build_pct = run.lines()
            .find(|l| l.contains("Baue SlateDesk neu"))
            .and_then(|line| {
                // Timestamp: [2024-01-15 14:32:05]
                let ts_str = line.trim_start_matches('[').get(..19)?;
                let dt = chrono_parse(ts_str)?;
                let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
                let elapsed_secs = now.saturating_sub(dt);
                // 12 Minuten = 720 Sekunden für 35%→81%
                let ratio = (elapsed_secs as f64 / 720.0).min(1.0);
                Some(35u8 + (ratio * 46.0) as u8)
            })
            .unwrap_or(35);
        return UpdateProgress {
            percent: build_pct,
            message: format!("Build läuft… (~{} Min)", (81u8.saturating_sub(build_pct) as f64 / 46.0 * 12.0).ceil() as u8),
            done: false,
            error: false,
        };
    }

    if has("npm install") {
        return UpdateProgress { percent: 28, message: "npm install…".into(), done: false, error: false };
    }
    if has("Lade neue Änderungen") {
        return UpdateProgress { percent: 20, message: "git pull…".into(), done: false, error: false };
    }
    if has("Erstelle Backup") {
        return UpdateProgress { percent: 15, message: "Backup erstellen…".into(), done: false, error: false };
    }
    if has("Neues Update gefunden") {
        return UpdateProgress { percent: 12, message: "Update gefunden…".into(), done: false, error: false };
    }
    if has("Prüfe auf Updates") {
        return UpdateProgress { percent: 8, message: "Prüfe auf Updates…".into(), done: false, error: false };
    }
    if has("Netzwerk verfügbar") {
        return UpdateProgress { percent: 5, message: "Netzwerk verbunden…".into(), done: false, error: false };
    }

    UpdateProgress { percent: 2, message: "Update gestartet…".into(), done: false, error: false }
}

/// Parst "[YYYY-MM-DD HH:MM:SS]"-Timestamps aus dem Log zu Unix-Sekunden.
fn chrono_parse(s: &str) -> Option<u64> {
    // s = "2024-01-15 14:32:05"
    let parts: Vec<&str> = s.splitn(2, ' ').collect();
    if parts.len() != 2 { return None; }
    let date_parts: Vec<u32> = parts[0].split('-').filter_map(|p| p.parse().ok()).collect();
    let time_parts: Vec<u32> = parts[1].split(':').filter_map(|p| p.parse().ok()).collect();
    if date_parts.len() != 3 || time_parts.len() != 3 { return None; }
    // Grobe Umrechnung (ignoriert Zeitzonen, reicht für Fortschrittsschätzung)
    let days_since_epoch = days_from_ymd(date_parts[0], date_parts[1], date_parts[2]);
    let secs = days_since_epoch * 86400
        + time_parts[0] as u64 * 3600
        + time_parts[1] as u64 * 60
        + time_parts[2] as u64;
    Some(secs)
}

fn days_from_ymd(y: u32, m: u32, d: u32) -> u64 {
    // Einfache Näherung: Tage seit 1970-01-01
    let y = y as u64;
    let m = m as u64;
    let d = d as u64;
    let leap = |yr: u64| (yr % 4 == 0 && yr % 100 != 0) || yr % 400 == 0;
    let month_days = [0u64, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut days = (y - 1970) * 365 + (y - 1969) / 4 - (y - 1901) / 100 + (y - 1601) / 400;
    for mo in 1..m {
        days += month_days[mo as usize];
        if mo == 2 && leap(y) { days += 1; }
    }
    days + d - 1
}

#[derive(Serialize)]
struct NasResult {
    reachable: bool,
    latency_ms: f64,
    packet_loss_pct: u8,
    timestamp: u64,
}

#[tauri::command]
fn test_nas_connection(ip: String) -> Result<NasResult, String> {
    let ip = ip.trim().to_string();
    if ip.is_empty() {
        return Err("Keine IP-Adresse angegeben".to_string());
    }
    // Einfache Validierung gegen Command-Injection (nur erlaubte Zeichen)
    if !ip.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == ':' || c == '-') {
        return Err("Ungültige IP-Adresse".to_string());
    }

    let output = Command::new("ping")
        .args(["-c", "4", "-W", "2", &ip])
        .output()
        .map_err(|e| format!("ping fehlgeschlagen: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Paketverlust parsen: "3 packets transmitted, 3 received, 0% packet loss"
    let packet_loss_pct = stdout
        .lines()
        .find(|l| l.contains("packet loss"))
        .and_then(|l| {
            l.split_whitespace()
                .find(|w| w.ends_with('%'))
                .and_then(|w| w.trim_end_matches('%').parse::<u8>().ok())
        })
        .unwrap_or(100);

    let reachable = packet_loss_pct < 100;

    // Durchschnittliche Latenz parsen: "rtt min/avg/max/mdev = 0.412/0.430/0.456/0.019 ms"
    let latency_ms = stdout
        .lines()
        .find(|l| l.starts_with("rtt "))
        .and_then(|l| l.split('=').nth(1))
        .and_then(|vals| vals.trim().split('/').nth(1))
        .and_then(|avg| avg.parse::<f64>().ok())
        .unwrap_or(0.0);

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    Ok(NasResult { reachable, latency_ms, packet_loss_pct, timestamp })
}

#[tauri::command]
fn trigger_update() -> Result<(), String> {
    let dir = project_dir();
    let script = format!("{dir}/scripts/auto-update.sh");

    Command::new("bash")
        .arg(&script)
        .env("SLATEDESK_HOME", &dir)
        .spawn()
        .map_err(|e| format!("Update-Script konnte nicht gestartet werden: {e}"))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Kamera-Zugriff auf Linux/WebKitGTK automatisch erlauben
            #[cfg(target_os = "linux")]
            {
                let window = app.get_webview_window("main")
                    .expect("Kein Hauptfenster gefunden");
                window.with_webview(|webview| {
                    webview.inner().connect_permission_request(|_, request| {
                        request.allow();
                        true
                    });
                }).ok();
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![check_for_updates, trigger_update, run_speed_test, get_update_progress, test_nas_connection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
