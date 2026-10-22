//! Display power (screen off/on) for the Sleeper widget, the schedule and the web UI.
//!
//! Cascade, first success wins and is tried first next time: GNOME Mutter (D-Bus
//! `PowerSaveMode`) → wlr-randr (wlroots compositors, Raspberry Pi OS) → kscreen-doctor (KDE)
//! → xset (real X11 only – Xwayland has no DPMS) → vcgencmd (Raspberry Pi firmware).
//! Every tool's exit status is checked: a backend that "ran" without effect must not count.

use crate::proc::{find_in_path, output_with_timeout};
use serde::Serialize;
use std::process::Output;
use std::sync::Mutex;
use std::time::Duration;
use tokio::process::Command;

const TOOL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Power {
    Off,
    On,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Backend {
    GnomeMutter,
    WlrRandr,
    KscreenDoctor,
    Xset,
    Vcgencmd,
}

impl Backend {
    const CASCADE: [Backend; 5] = [
        Backend::GnomeMutter,
        Backend::WlrRandr,
        Backend::KscreenDoctor,
        Backend::Xset,
        Backend::Vcgencmd,
    ];

    fn name(self) -> &'static str {
        match self {
            Backend::GnomeMutter => "gnome-mutter",
            Backend::WlrRandr => "wlr-randr",
            Backend::KscreenDoctor => "kscreen-doctor",
            Backend::Xset => "xset",
            Backend::Vcgencmd => "vcgencmd",
        }
    }
}

/// Why a backend did not switch the display.
#[derive(Debug, PartialEq)]
enum Attempt {
    /// Not present in this session (tool missing, other desktop).
    Unavailable,
    Failed(String),
}

/// The backend that worked last – tried first on the next call.
static WORKING: Mutex<Option<Backend>> = Mutex::new(None);
/// wlroots outputs this app switched off, so wake only turns those back on.
static WLR_OUTPUTS_OFF: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// DPMS state before `xset dpms force off` (which enables DPMS as a side effect).
static XSET_DPMS_WAS_ENABLED: Mutex<Option<bool>> = Mutex::new(None);
/// Sleep and wake from Sleeper, schedule and web UI must not interleave.
static SWITCHING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

fn desktop_is(desktop: &str, name: &str) -> bool {
    desktop
        .split(':')
        .any(|part| part.trim().eq_ignore_ascii_case(name))
}

fn env_set(name: &str) -> bool {
    std::env::var_os(name).is_some_and(|v| !v.is_empty())
}

fn is_wayland() -> bool {
    env_set("WAYLAND_DISPLAY") || crate::system::session_type().eq_ignore_ascii_case("wayland")
}

fn first_line(text: &[u8]) -> Option<String> {
    String::from_utf8_lossy(text)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(200).collect())
}

/// Runs a display tool; a missing binary is "unavailable", not a failure.
async fn tool(program: &str, args: &[&str]) -> Result<Output, Attempt> {
    if find_in_path(program).is_none() {
        return Err(Attempt::Unavailable);
    }
    let mut cmd = Command::new(program);
    cmd.args(args).env("LC_ALL", "C");
    output_with_timeout(cmd, program, TOOL_TIMEOUT)
        .await
        .map_err(Attempt::Failed)
}

fn check_status(output: &Output) -> Result<(), Attempt> {
    if output.status.success() {
        return Ok(());
    }
    let reason = first_line(&output.stderr)
        .or_else(|| first_line(&output.stdout))
        .unwrap_or_else(|| match output.status.code() {
            Some(code) => format!("Exit-Code {code}"),
            None => "abgebrochen".to_string(),
        });
    Err(Attempt::Failed(reason))
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/// Whether Mutter's DisplayConfig service is on the session bus (GNOME on Wayland and X11).
async fn mutter_display_config_available() -> bool {
    tool(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.freedesktop.DBus",
            "--object-path",
            "/org/freedesktop/DBus",
            "--method",
            "org.freedesktop.DBus.NameHasOwner",
            "org.gnome.Mutter.DisplayConfig",
        ],
    )
    .await
    .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("true"))
    .unwrap_or(false)
}

async fn gnome_mutter(power: Power) -> Result<(), Attempt> {
    if !mutter_display_config_available().await {
        return Err(Attempt::Unavailable);
    }
    // 0 = on, 3 = off (DPMS levels); Mutter wakes the screen on input by itself.
    let mode = match power {
        Power::Off => "<int32 3>",
        Power::On => "<int32 0>",
    };
    let output = tool(
        "gdbus",
        &[
            "call",
            "--session",
            "--dest",
            "org.gnome.Mutter.DisplayConfig",
            "--object-path",
            "/org/gnome/Mutter/DisplayConfig",
            "--method",
            "org.freedesktop.DBus.Properties.Set",
            "org.gnome.Mutter.DisplayConfig",
            "PowerSaveMode",
            mode,
        ],
    )
    .await?;
    check_status(&output)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WlrOutput {
    name: String,
    enabled: bool,
}

/// Heads from plain `wlr-randr` output: unindented lines start a head ("HDMI-A-1 \"…\""),
/// its indented "Enabled: yes|no" line follows.
fn parse_wlr_outputs(text: &str) -> Vec<WlrOutput> {
    let mut outputs: Vec<WlrOutput> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            if let Some(name) = line.split_whitespace().next() {
                outputs.push(WlrOutput {
                    name: name.to_string(),
                    enabled: true,
                });
            }
        } else if let Some(state) = line.trim().strip_prefix("Enabled:") {
            if let Some(current) = outputs.last_mut() {
                current.enabled = state.trim().eq_ignore_ascii_case("yes");
            }
        }
    }
    outputs
}

/// Outputs to switch: on sleep every enabled one; on wake the ones switched off here, or –
/// after a restart while dark – every disabled one.
fn wlr_targets(outputs: &[WlrOutput], power: Power, switched_off: &[String]) -> Vec<String> {
    match power {
        Power::Off => outputs
            .iter()
            .filter(|o| o.enabled)
            .map(|o| o.name.clone())
            .collect(),
        Power::On if !switched_off.is_empty() => outputs
            .iter()
            .filter(|o| switched_off.contains(&o.name))
            .map(|o| o.name.clone())
            .collect(),
        Power::On => outputs
            .iter()
            .filter(|o| !o.enabled)
            .map(|o| o.name.clone())
            .collect(),
    }
}

async fn wlr_randr(power: Power) -> Result<(), Attempt> {
    if !is_wayland() {
        return Err(Attempt::Unavailable);
    }
    let listing = tool("wlr-randr", &[]).await?;
    // Not a wlroots compositor (GNOME, KDE): the protocol is missing.
    if !listing.status.success() {
        return Err(Attempt::Unavailable);
    }
    let outputs = parse_wlr_outputs(&String::from_utf8_lossy(&listing.stdout));
    if outputs.is_empty() {
        return Err(Attempt::Failed(
            "keine Bildschirmausgänge gefunden".to_string(),
        ));
    }
    let remembered = lock(&WLR_OUTPUTS_OFF).clone();
    let targets = wlr_targets(&outputs, power, &remembered);
    let flag = match power {
        Power::Off => "--off",
        Power::On => "--on",
    };
    let mut switched = Vec::new();
    for name in &targets {
        let output = tool("wlr-randr", &["--output", name, flag]).await?;
        check_status(&output)?;
        switched.push(name.clone());
    }
    match power {
        Power::Off => lock(&WLR_OUTPUTS_OFF).extend(switched),
        Power::On => lock(&WLR_OUTPUTS_OFF).clear(),
    }
    Ok(())
}

async fn kscreen_doctor(power: Power) -> Result<(), Attempt> {
    let desktop = crate::system::desktop();
    if !desktop_is(&desktop, "KDE") && desktop != "unbekannt" {
        return Err(Attempt::Unavailable);
    }
    let state = match power {
        Power::Off => "off",
        Power::On => "on",
    };
    let output = tool("kscreen-doctor", &["--dpms", state]).await?;
    check_status(&output)
}

/// `Some(enabled)` when the X server has the DPMS extension.
fn parse_xset_dpms(query: &str) -> Option<bool> {
    if query.contains("does not have the DPMS") {
        return None;
    }
    if query.contains("DPMS is Enabled") {
        Some(true)
    } else if query.contains("DPMS is Disabled") {
        Some(false)
    } else {
        None
    }
}

async fn xset(power: Power) -> Result<(), Attempt> {
    if !env_set("DISPLAY") || env_set("WAYLAND_DISPLAY") {
        return Err(Attempt::Unavailable);
    }
    let query = tool("xset", &["q"]).await?;
    check_status(&query)?;
    let Some(dpms_enabled) = parse_xset_dpms(&String::from_utf8_lossy(&query.stdout)) else {
        return Err(Attempt::Unavailable);
    };
    match power {
        Power::Off => {
            check_status(&tool("xset", &["dpms", "force", "off"]).await?)?;
            let mut was_enabled = lock(&XSET_DPMS_WAS_ENABLED);
            if was_enabled.is_none() {
                *was_enabled = Some(dpms_enabled);
            }
        }
        Power::On => {
            check_status(&tool("xset", &["dpms", "force", "on"]).await?)?;
            let was_enabled = lock(&XSET_DPMS_WAS_ENABLED).take();
            // "force off" switched DPMS on; left that way, X would blank the kiosk after its
            // idle timeouts.
            if was_enabled == Some(false) {
                if let Err(Attempt::Failed(e)) = tool("xset", &["-dpms"])
                    .await
                    .and_then(|o| check_status(&o))
                {
                    log::warn!("xset -dpms fehlgeschlagen: {e}");
                }
            }
            let _ = tool("xset", &["s", "reset"]).await;
        }
    }
    Ok(())
}

async fn vcgencmd(power: Power) -> Result<(), Attempt> {
    let value = match power {
        Power::Off => "0",
        Power::On => "1",
    };
    let output = tool("vcgencmd", &["display_power", value]).await?;
    check_status(&output)?;
    if String::from_utf8_lossy(&output.stdout).contains("display_power=") {
        Ok(())
    } else {
        Err(Attempt::Failed(
            first_line(&output.stdout).unwrap_or_else(|| "keine Antwort".to_string()),
        ))
    }
}

async fn apply(backend: Backend, power: Power) -> Result<(), Attempt> {
    match backend {
        Backend::GnomeMutter => gnome_mutter(power).await,
        Backend::WlrRandr => wlr_randr(power).await,
        Backend::KscreenDoctor => kscreen_doctor(power).await,
        Backend::Xset => xset(power).await,
        Backend::Vcgencmd => vcgencmd(power).await,
    }
}

fn failure_message(power: Power, failures: &[(Backend, String)]) -> String {
    let what = match power {
        Power::Off => "ausgeschaltet",
        Power::On => "eingeschaltet",
    };
    if failures.is_empty() {
        return format!(
            "Bildschirm kann nicht {what} werden: kein unterstütztes Verfahren gefunden \
             (GNOME, wlroots, KDE, X11 oder Raspberry Pi)"
        );
    }
    let details: Vec<String> = failures
        .iter()
        .map(|(backend, reason)| format!("{}: {reason}", backend.name()))
        .collect();
    format!(
        "Bildschirm konnte nicht {what} werden ({})",
        details.join("; ")
    )
}

/// Switches the display; returns the name of the backend that worked.
async fn switch(power: Power) -> Result<String, String> {
    let _serial = SWITCHING.lock().await;
    let remembered = *lock(&WORKING);
    let order = remembered.into_iter().chain(
        Backend::CASCADE
            .into_iter()
            .filter(|b| Some(*b) != remembered),
    );

    let mut failures = Vec::new();
    for backend in order {
        match apply(backend, power).await {
            Ok(()) => {
                *lock(&WORKING) = Some(backend);
                let state = if power == Power::Off { "aus" } else { "an" };
                crate::health::event(
                    crate::health::Level::Info,
                    format!("Bildschirm {state} ({})", backend.name()),
                );
                return Ok(backend.name().to_string());
            }
            Err(Attempt::Unavailable) => {}
            Err(Attempt::Failed(reason)) => failures.push((backend, reason)),
        }
    }
    *lock(&WORKING) = None;
    let message = failure_message(power, &failures);
    crate::health::event(crate::health::Level::Warn, message.clone());
    Err(message)
}

pub async fn sleep() -> Result<String, String> {
    switch(Power::Off).await
}

pub async fn wake() -> Result<String, String> {
    switch(Power::On).await
}

/// Schaltet den Bildschirm aus; liefert das verwendete Verfahren.
#[tauri::command]
pub async fn sleep_display() -> Result<String, String> {
    sleep().await
}

/// Schaltet den Bildschirm wieder ein; liefert das verwendete Verfahren.
#[tauri::command]
pub async fn wake_display() -> Result<String, String> {
    wake().await
}

/// First usable display-power backend in cascade order, without switching anything.
pub async fn detect_backend(session_type: &str, desktop: &str) -> Option<&'static str> {
    let wayland = session_type.eq_ignore_ascii_case("wayland");
    let x11 = session_type.eq_ignore_ascii_case("x11");
    if desktop_is(desktop, "GNOME") && mutter_display_config_available().await {
        return Some(Backend::GnomeMutter.name());
    }
    if wayland && find_in_path("wlr-randr").is_some() && !desktop_is(desktop, "GNOME") {
        return Some(Backend::WlrRandr.name());
    }
    if desktop_is(desktop, "KDE") && find_in_path("kscreen-doctor").is_some() {
        return Some(Backend::KscreenDoctor.name());
    }
    if x11 && find_in_path("xset").is_some() {
        return Some(Backend::Xset.name());
    }
    if find_in_path("vcgencmd").is_some() {
        return Some(Backend::Vcgencmd.name());
    }
    None
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayCapabilities {
    backend: Option<String>,
    session_type: String,
    desktop: String,
}

#[tauri::command]
pub async fn display_capabilities() -> Result<DisplayCapabilities, String> {
    let session_type = crate::system::session_type();
    let desktop = crate::system::desktop();
    let proven = *lock(&WORKING);
    let backend = match proven {
        Some(backend) => Some(backend.name()),
        None => detect_backend(&session_type, &desktop).await,
    };
    Ok(DisplayCapabilities {
        backend: backend.map(str::to_string),
        session_type,
        desktop,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    #[test]
    fn desktop_matching_handles_lists() {
        assert!(desktop_is("ubuntu:GNOME", "GNOME"));
        assert!(desktop_is("KDE", "kde"));
        assert!(!desktop_is("GNOME-Flashback", "GNOME"));
        assert!(!desktop_is("unbekannt", "KDE"));
    }

    const WLR: &str = "HDMI-A-1 \"Samsung Electric Company S24D300 (HDMI-A-1)\"
  Make: Samsung Electric Company
  Enabled: yes
  Modes:
    1920x1080 px, 60.000000 Hz (preferred, current)
HDMI-A-2 \"Unknown (HDMI-A-2)\"
  Enabled: no
";

    #[test]
    fn parses_wlr_randr_heads() {
        let outputs = parse_wlr_outputs(WLR);
        assert_eq!(
            outputs,
            vec![
                WlrOutput {
                    name: "HDMI-A-1".into(),
                    enabled: true
                },
                WlrOutput {
                    name: "HDMI-A-2".into(),
                    enabled: false
                },
            ]
        );
        assert!(parse_wlr_outputs("").is_empty());
    }

    #[test]
    fn wlr_wake_only_restores_what_sleep_switched_off() {
        let outputs = parse_wlr_outputs(WLR);
        assert_eq!(wlr_targets(&outputs, Power::Off, &[]), vec!["HDMI-A-1"]);
        let asleep = vec![
            WlrOutput {
                name: "HDMI-A-1".into(),
                enabled: false,
            },
            outputs[1].clone(),
        ];
        assert_eq!(
            wlr_targets(&asleep, Power::On, &["HDMI-A-1".to_string()]),
            vec!["HDMI-A-1"]
        );
        // Restart while dark: nothing remembered, every disabled head comes back.
        assert_eq!(
            wlr_targets(&asleep, Power::On, &[]),
            vec!["HDMI-A-1", "HDMI-A-2"]
        );
    }

    #[test]
    fn xset_dpms_detection() {
        assert_eq!(
            parse_xset_dpms("DPMS (Energy Star):\n  Standby: 600\n  DPMS is Enabled\n"),
            Some(true)
        );
        assert_eq!(parse_xset_dpms("  DPMS is Disabled\n"), Some(false));
        assert_eq!(
            parse_xset_dpms("Server does not have the DPMS Extension\n"),
            None
        );
    }

    #[test]
    fn failed_tools_report_their_reason() {
        let failed = Output {
            status: ExitStatus::from_raw(1 << 8),
            stdout: Vec::new(),
            stderr: b"\nError: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied\n".to_vec(),
        };
        assert_eq!(
            check_status(&failed),
            Err(Attempt::Failed(
                "Error: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied".into()
            ))
        );
        let silent = Output {
            status: ExitStatus::from_raw(3 << 8),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        assert_eq!(
            check_status(&silent),
            Err(Attempt::Failed("Exit-Code 3".into()))
        );
        let ok = Output {
            status: ExitStatus::from_raw(0),
            stdout: Vec::new(),
            stderr: Vec::new(),
        };
        assert_eq!(check_status(&ok), Ok(()));
    }

    #[test]
    fn failure_messages_are_german() {
        assert!(failure_message(Power::Off, &[]).contains("kein unterstütztes Verfahren"));
        assert_eq!(
            failure_message(Power::On, &[(Backend::Xset, "Exit-Code 1".into())]),
            "Bildschirm konnte nicht eingeschaltet werden (xset: Exit-Code 1)"
        );
    }
}
