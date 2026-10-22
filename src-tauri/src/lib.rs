mod calendar;
mod display;
mod feeds;
mod http;
mod lagra;
mod mail;
mod net;
mod ollama;
mod planbar;
mod proc;
mod qr;
mod remote;
mod state;
mod system;
mod update;
mod web;

use futures_util::future::BoxFuture;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use web::{KioskAction, KioskHost, WebAsset};

const MAIN_WINDOW: &str = "main";
/// Exit code used to let systemd restart the unit (non-zero, so `Restart=on-failure` works too).
const SYSTEMD_RESTART_CODE: i32 = 75;

#[derive(Serialize, Clone)]
struct StateChangedEvent<'a> {
    rev: u64,
    state: &'a Value,
    origin: &'a str,
}

#[derive(Serialize, Clone)]
struct KioskActionEvent {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
}

/// Graphical session and SlateDesk settings a replacement started by systemd-run needs; the
/// user manager's environment may lack them (desktops without systemd integration).
const SESSION_ENV: [&str; 10] = [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "XDG_SESSION_DESKTOP",
    "SLATEDESK_HOME",
    "SLATEDESK_REMOTE_PORT",
    "SLATEDESK_REMOTE_DISABLED",
    "SLATEDESK_REMOTE_HOSTS",
];
/// Waits (at most 30 s) until the old process (`$1`) is gone – while it lives, the
/// single-instance lock would send the new one away – then becomes the app (`$0`).
const WAIT_THEN_EXEC: &str = r#"i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 60 ]; do sleep 0.5; i=$((i+1)); done; exec "$0""#;

/// Who restarts the app, from its cgroup.
#[derive(Debug, PartialEq, Eq)]
enum Supervisor {
    /// The installed `slatedesk.service` (Restart=always): exiting lets systemd restart it.
    SlateDeskUnit,
    /// Another service unit, e.g. the transient `slatedesk-legacy-<ts>.service` the update and
    /// setup scripts start. It has no Restart=, and when the main process exits systemd kills
    /// what is left in its cgroup – a self-spawned successor included.
    OtherService(String),
    /// A session scope or a terminal: a self-spawned successor survives.
    None,
}

/// `0::/user.slice/user-1000.slice/user@1000.service/app.slice/slatedesk.service` (cgroup v2;
/// v1 lists one line per hierarchy).
fn supervisor_from_cgroup(cgroups: &str) -> Supervisor {
    let units: Vec<&str> = cgroups
        .lines()
        .filter_map(|line| line.splitn(3, ':').nth(2))
        .filter_map(|path| path.rsplit('/').next())
        .filter(|leaf| leaf.ends_with(".service") && !leaf.starts_with("user@"))
        .collect();
    if units.contains(&"slatedesk.service") {
        Supervisor::SlateDeskUnit
    } else if let Some(unit) = units.first() {
        Supervisor::OtherService((*unit).to_string())
    } else {
        Supervisor::None
    }
}

fn supervisor() -> Supervisor {
    std::fs::read_to_string("/proc/self/cgroup")
        .map(|cgroups| supervisor_from_cgroup(&cgroups))
        .unwrap_or(Supervisor::None)
}

/// `systemd-run` arguments that start `exe` in a new transient unit once `pid` has exited.
fn transient_restart_args(
    exe: &str,
    pid: u32,
    unit: &str,
    env: &[(String, String)],
) -> Vec<String> {
    let mut args = vec![
        "--user".to_string(),
        "--collect".to_string(),
        "--quiet".to_string(),
        format!("--unit={unit}"),
    ];
    args.extend(
        env.iter()
            .map(|(name, value)| format!("--setenv={name}={value}")),
    );
    args.extend([
        "/bin/sh".to_string(),
        "-c".to_string(),
        WAIT_THEN_EXEC.to_string(),
        exe.to_string(),
        pid.to_string(),
    ]);
    args
}

/// Starts the replacement outside the current unit's cgroup, so it outlives this process.
async fn spawn_in_transient_unit() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("Programmpfad unbekannt: {e}"))?;
    // After an update replaced the binary, /proc/self/exe ends in " (deleted)".
    let exe = exe.to_string_lossy();
    let exe = exe.trim_end_matches(" (deleted)");
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let env: Vec<(String, String)> = SESSION_ENV
        .iter()
        .filter_map(|name| {
            std::env::var(name)
                .ok()
                .map(|value| (name.to_string(), value))
        })
        .collect();
    let args = transient_restart_args(
        exe,
        std::process::id(),
        &format!("slatedesk-legacy-{secs}"),
        &env,
    );
    let mut cmd = tokio::process::Command::new("systemd-run");
    cmd.args(&args).stdin(std::process::Stdio::null());
    let output = proc::output_with_timeout(cmd, "systemd-run", Duration::from_secs(10)).await?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("systemd-run fehlgeschlagen")
            .to_string())
    }
}

async fn restart_app(app: &AppHandle) {
    match supervisor() {
        Supervisor::SlateDeskUnit => {
            log::info!("Neustart über systemd");
            app.exit(SYSTEMD_RESTART_CODE);
        }
        Supervisor::OtherService(unit) => match spawn_in_transient_unit().await {
            Ok(()) => {
                log::info!("Neustart in einer neuen systemd-Unit (bisher {unit})");
                app.exit(0);
            }
            Err(e) => {
                log::warn!("Neustart über systemd-run nicht möglich ({e}) – direkter Neustart");
                app.request_restart();
            }
        },
        Supervisor::None => {
            log::info!("Neustart");
            app.request_restart();
        }
    }
}

/// Delayed so the HTTP response / IPC reply still reaches the caller.
fn schedule_restart(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        restart_app(&app).await;
    });
}

#[tauri::command]
async fn app_restart(app: AppHandle) -> Result<(), String> {
    schedule_restart(app);
    Ok(())
}

/// Tauri side of the web server: bundled assets and actions on the kiosk.
struct TauriHost {
    app: AppHandle,
}

impl KioskHost for TauriHost {
    fn asset(&self, path: &str) -> Option<WebAsset> {
        self.app
            .asset_resolver()
            .get(path.to_string())
            .map(|asset| WebAsset {
                bytes: asset.bytes,
                mime_type: asset.mime_type,
            })
    }

    fn perform(
        &self,
        action: KioskAction,
        value: Option<Value>,
    ) -> BoxFuture<'static, Result<Option<Value>, String>> {
        let app = self.app.clone();
        Box::pin(async move {
            match action {
                KioskAction::Reload | KioskAction::Identify | KioskAction::EditMode => {
                    let event = KioskActionEvent {
                        action: action.as_str(),
                        value,
                    };
                    app.emit_to(MAIN_WINDOW, "kiosk://action", event)
                        .map_err(|e| format!("Kiosk nicht erreichbar: {e}"))?;
                    Ok(None)
                }
                KioskAction::Restart => {
                    schedule_restart(app);
                    Ok(None)
                }
                KioskAction::DisplaySleep | KioskAction::DisplayWake => {
                    let backend = if action == KioskAction::DisplaySleep {
                        display::sleep().await?
                    } else {
                        display::wake().await?
                    };
                    // The display schedule and the Ruhemodus must learn about the switch, or
                    // they would undo it (or miss the next touch). The switch itself succeeded,
                    // so a failed notification only gets logged.
                    let event = KioskActionEvent {
                        action: action.as_str(),
                        value: Some(Value::String(backend.clone())),
                    };
                    if let Err(e) = app.emit_to(MAIN_WINDOW, "kiosk://action", event) {
                        log::warn!("Bildschirm-Aktion nicht an den Kiosk gemeldet: {e}");
                    }
                    Ok(Some(Value::String(backend)))
                }
                KioskAction::UpdateCheck => {
                    let info = update::check()
                        .await
                        .map_err(|e| format!("{}: {e}", update::CHECK_FAILED))?;
                    serde_json::to_value(info)
                        .map(Some)
                        .map_err(|e| e.to_string())
                }
                KioskAction::UpdateRun => update::trigger()
                    .await
                    .map(|()| None)
                    .map_err(|e| format!("{}: {e}", update::TRIGGER_FAILED)),
            }
        })
    }
}

fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .max_file_size(2 * 1024 * 1024)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
        .build()
}

fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Camera/microphone (Sleeper, AI widget) and device labels only – geolocation,
/// notifications, pointer lock etc. are denied.
#[cfg(target_os = "linux")]
fn restrict_webview_permissions(app: &tauri::App) {
    use webkit2gtk::glib::prelude::{Cast, ObjectExt};
    use webkit2gtk::{
        DeviceInfoPermissionRequest, PermissionRequestExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };

    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        log::error!("Hauptfenster fehlt – Berechtigungen nicht eingeschränkt");
        return;
    };
    let result = window.with_webview(|webview| {
        webview.inner().connect_permission_request(
            |_view: &webkit2gtk::WebView, request: &webkit2gtk::PermissionRequest| {
                let media = request
                    .downcast_ref::<UserMediaPermissionRequest>()
                    .is_some_and(|m| m.is_for_audio_device() || m.is_for_video_device());
                if media || request.is::<DeviceInfoPermissionRequest>() {
                    request.allow();
                } else {
                    request.deny();
                }
                true
            },
        );
    });
    if let Err(e) = result {
        log::error!("WebView-Berechtigungen nicht eingerichtet: {e}");
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let config_dir = app.path().app_config_dir()?;

    let store = Arc::new(state::StateStore::load(config_dir.clone()));
    let remote = Arc::new(remote::RemoteAuth::load(
        &config_dir,
        remote::EnvOverrides::from_env(),
    ));
    let system = Arc::new(system::SystemContext::default());
    let http = http::HttpClient(http::build_client()?);
    // lagra and planbar get their own client: it never follows redirects off their API root.
    let api = http::build_api_client()?;
    let lagra = Arc::new(lagra::LagraService::new(api.clone()));
    let planbar = Arc::new(planbar::PlanbarService::new(api));

    let emitter = handle.clone();
    store.set_change_hook(move |change| {
        let event = StateChangedEvent {
            rev: change.rev,
            state: change.state,
            origin: change.origin,
        };
        if let Err(e) = emitter.emit_to(MAIN_WINDOW, "state://changed", event) {
            log::warn!("state://changed nicht gesendet: {e}");
        }
    });

    app.manage(Arc::clone(&store));
    app.manage(Arc::clone(&remote));
    app.manage(Arc::clone(&system));
    app.manage(Arc::clone(&lagra));
    app.manage(Arc::clone(&planbar));
    app.manage(http);

    tauri::async_runtime::spawn(mail::run_outbox(Arc::clone(&store)));

    if remote.enabled() {
        let host: Arc<dyn KioskHost> = Arc::new(TauriHost { app: handle });
        let ctx = web::WebContext::new(store, Arc::clone(&remote), system, lagra, planbar, host);
        tauri::async_runtime::spawn(web::serve(ctx));
    } else {
        log::info!("Fernsteuerung ist deaktiviert");
    }

    #[cfg(target_os = "linux")]
    restrict_webview_permissions(app);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be the first plugin: a second start only focuses the running kiosk.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(log_plugin())
        .setup(setup)
        .on_window_event(|window, event| {
            // The kiosk must not disappear through Alt+F4 or a compositor close; dev builds
            // stay closable.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW && !cfg!(debug_assertions) {
                    log::warn!("Schliessen des Kiosk-Fensters verhindert");
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            state::state_get,
            state::state_apply,
            remote::remote_info,
            system::system_info,
            system::report_viewport,
            http::http_fetch,
            feeds::feeds_fetch,
            calendar::calendar_events,
            lagra::lagra_get,
            lagra::lagra_image,
            planbar::planbar_get,
            planbar::planbar_patch,
            mail::mail_alert,
            net::net_check,
            net::run_speed_test,
            net::test_nas_connection,
            update::check_for_updates,
            update::trigger_update,
            update::get_update_progress,
            ollama::check_ollama,
            display::sleep_display,
            display::wake_display,
            display::display_capabilities,
            qr::qr_svg,
            app_restart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervisor_comes_from_the_cgroup() {
        let unit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/slatedesk.service\n";
        assert_eq!(supervisor_from_cgroup(unit), Supervisor::SlateDeskUnit);
        let legacy = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/slatedesk-legacy-1760000000.service\n";
        assert_eq!(
            supervisor_from_cgroup(legacy),
            Supervisor::OtherService("slatedesk-legacy-1760000000.service".into())
        );
        let scope = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-gnome-slatedesk-4242.scope\n";
        assert_eq!(supervisor_from_cgroup(scope), Supervisor::None);
        let v1 = "12:pids:/user.slice/user-1000.slice/user@1000.service\n1:name=systemd:/user.slice/user-1000.slice/session-2.scope\n";
        assert_eq!(supervisor_from_cgroup(v1), Supervisor::None);
        assert_eq!(supervisor_from_cgroup(""), Supervisor::None);
    }

    #[test]
    fn replacement_waits_for_the_old_process() {
        let env = vec![("WAYLAND_DISPLAY".to_string(), "wayland-0".to_string())];
        let args = transient_restart_args("/usr/bin/slate-desk", 4242, "slatedesk-legacy-1", &env);
        assert_eq!(
            args,
            [
                "--user",
                "--collect",
                "--quiet",
                "--unit=slatedesk-legacy-1",
                "--setenv=WAYLAND_DISPLAY=wayland-0",
                "/bin/sh",
                "-c",
                WAIT_THEN_EXEC,
                "/usr/bin/slate-desk",
                "4242",
            ]
        );
    }

    #[test]
    fn wait_script_execs_once_the_process_is_gone() {
        // A PID that cannot exist: the script must exec right away.
        let output = std::process::Command::new("/bin/sh")
            .args(["-c", WAIT_THEN_EXEC, "/bin/echo", "4194305"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "");
    }
}
