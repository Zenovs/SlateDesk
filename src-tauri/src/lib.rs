use serde::Serialize;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![check_for_updates, trigger_update, run_speed_test])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
