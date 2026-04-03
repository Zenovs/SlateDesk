use serde::Serialize;
use std::process::Command;

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
        .invoke_handler(tauri::generate_handler![check_for_updates, trigger_update])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
