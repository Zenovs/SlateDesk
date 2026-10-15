//! Self-update: compares the running build with the update branch (`origin/<branch>`, see
//! [`update_branch`]), starts the update unit and
//! reports progress from the status file the update script writes
//! (`~/.local/state/slatedesk/update-status.json`, see scripts/auto-update.sh).

use crate::proc::output_with_timeout;
use chrono::{Local, NaiveDateTime, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(60);
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const START_TIMEOUT: Duration = Duration::from_secs(15);
/// Repeated checks (kiosk start, web UI, timer) within this window reuse the last result.
const CHECK_CACHE: Duration = Duration::from_secs(30);
/// Prefixes of the error texts. The kiosk's update button adds them itself; the web UI shows
/// the server's text, so the web actions add them there (lib.rs).
pub const CHECK_FAILED: &str = "Update-Prüfung fehlgeschlagen";
pub const TRIGGER_FAILED: &str = "Update konnte nicht gestartet werden";
const UPDATE_UNIT: &str = "slatedesk-update.service";
const MANUAL_UNIT: &str = "slatedesk-update-manual";
/// After a trigger the status file still describes the previous run until the new one
/// writes its first status.
const START_GRACE_MS: i64 = 120_000;
/// A run that has not written a status for this long was killed (power loss, OOM killer) –
/// the script's exit trap could not mark it as failed.
const STALE_STATUS_MS: i64 = 30 * 60_000;
/// Old log format: the build phase runs from 35 % to 81 % in about 12 minutes.
const LEGACY_BUILD_SECS: f64 = 720.0;

static TRIGGERED_AT_MS: AtomicI64 = AtomicI64::new(0);
static LAST_CHECK: tokio::sync::Mutex<Option<(Instant, UpdateInfo)>> =
    tokio::sync::Mutex::const_new(None);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Git checkout of SlateDesk: `SLATEDESK_HOME`, else `~/SlateDesk`, else the classic kiosk
/// path `/home/slatedesk/SlateDesk`.
pub fn project_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("SLATEDESK_HOME").filter(|d| !d.is_empty()) {
        return PathBuf::from(dir);
    }
    let candidates: Vec<PathBuf> = home_dir()
        .map(|home| home.join("SlateDesk"))
        .into_iter()
        .chain([PathBuf::from("/home/slatedesk/SlateDesk")])
        .collect();
    candidates
        .iter()
        .find(|dir| dir.join(".git").exists())
        .or(candidates.first())
        .cloned()
        .unwrap_or_default()
}

/// Same directory as STATE_DIR in scripts/auto-update.sh.
fn state_dir() -> Option<PathBuf> {
    home_dir().map(|home| home.join(".local/state/slatedesk"))
}

fn first_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .chars()
        .take(300)
        .collect()
}

fn short(commit: &str) -> String {
    commit.chars().take(7).collect()
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    available: bool,
    current_commit: String,
    remote_commit: String,
    short_current: String,
    short_remote: String,
    behind: u32,
}

async fn git(dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .args(args)
        // Never wait for credentials on a kiosk without a terminal.
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null());
    let label = format!("git {}", args.first().copied().unwrap_or_default());
    let output = output_with_timeout(cmd, &label, limit).await?;
    if !output.status.success() {
        let reason = first_line(&output.stderr);
        return Err(if reason.is_empty() {
            format!("{label} fehlgeschlagen")
        } else {
            format!("{label}: {reason}")
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Simplified `git check-ref-format`: no option-like start, no `..`, no `.lock` suffix.
fn valid_branch(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-'))
        && !name.contains("..")
        && !name.ends_with(".lock")
        && !name.ends_with('/')
}

/// Update branch, resolved like scripts/auto-update.sh: `SLATEDESK_BRANCH`, else
/// `git config slatedesk.branch` in the checkout (set by `setup.sh --branch`), else `main`.
async fn update_branch(dir: &Path) -> String {
    let configured = match std::env::var("SLATEDESK_BRANCH") {
        Ok(env) if !env.trim().is_empty() => Some(env.trim().to_string()),
        _ => git(dir, &["config", "--get", "slatedesk.branch"], GIT_TIMEOUT)
            .await
            .ok(),
    };
    configured
        .filter(|b| valid_branch(b))
        .unwrap_or_else(|| "main".to_string())
}

async fn resolve_commit(dir: &Path, rev: &str) -> Option<String> {
    git(
        dir,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
        GIT_TIMEOUT,
    )
    .await
    .ok()
    .filter(|c| !c.is_empty())
}

async fn count_behind(dir: &Path, from: &str, to: &str) -> Result<u32, String> {
    let count = git(
        dir,
        &["rev-list", "--count", &format!("{from}..{to}")],
        GIT_TIMEOUT,
    )
    .await?;
    count
        .parse()
        .map_err(|_| format!("git rev-list: unerwartete Ausgabe «{count}»"))
}

async fn run_check() -> Result<UpdateInfo, String> {
    let dir = project_dir();
    if !dir.join(".git").exists() {
        return Err(format!(
            "Kein Git-Checkout unter {} gefunden (SLATEDESK_HOME setzen)",
            dir.display()
        ));
    }
    let branch = update_branch(&dir).await;
    let remote_ref = format!("origin/{branch}");
    let refspec = format!("+refs/heads/{branch}:refs/remotes/{remote_ref}");
    git(
        &dir,
        &["fetch", "--quiet", "origin", &refspec],
        GIT_FETCH_TIMEOUT,
    )
    .await?;
    let remote = resolve_commit(&dir, &remote_ref)
        .await
        .ok_or_else(|| format!("{remote_ref} nicht gefunden"))?;

    // The running binary counts, not HEAD: after a failed build HEAD already is the remote head.
    let build = crate::system::commit();
    let build_full = match build {
        Some(hash) => resolve_commit(&dir, hash).await,
        None => None,
    };
    let (current, behind) = match (build, build_full) {
        (_, Some(full)) => {
            let behind = count_behind(&dir, &full, &remote).await?;
            (full, behind)
        }
        // Built from a commit this checkout no longer knows (rewritten history).
        (Some(hash), None) if !remote.starts_with(hash) => {
            let head = resolve_commit(&dir, "HEAD").await.unwrap_or_default();
            let behind = if head.is_empty() {
                1
            } else {
                count_behind(&dir, &head, &remote).await?.max(1)
            };
            (hash.to_string(), behind)
        }
        _ => {
            let head = resolve_commit(&dir, "HEAD")
                .await
                .ok_or_else(|| "HEAD nicht lesbar".to_string())?;
            let behind = count_behind(&dir, &head, &remote).await?;
            (head, behind)
        }
    };

    Ok(UpdateInfo {
        available: behind > 0,
        short_current: short(&current),
        short_remote: short(&remote),
        current_commit: current,
        remote_commit: remote,
        behind,
    })
}

/// Errors are bare reasons («git fetch: …»); the callers put «Update-Prüfung
/// fehlgeschlagen» in front ([`CHECK_FAILED`]).
pub async fn check() -> Result<UpdateInfo, String> {
    // Serialized: concurrent callers wait for the running fetch and share its result.
    let mut last = LAST_CHECK.lock().await;
    if let Some((at, info)) = last.as_ref() {
        if at.elapsed() < CHECK_CACHE {
            return Ok(info.clone());
        }
    }
    let info = run_check().await?;
    *last = Some((Instant::now(), info.clone()));
    Ok(info)
}

#[tauri::command]
pub async fn check_for_updates() -> Result<UpdateInfo, String> {
    check().await
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

async fn run_quiet(mut cmd: Command, label: &str) -> Result<Output, String> {
    cmd.stdin(Stdio::null());
    output_with_timeout(cmd, label, START_TIMEOUT).await
}

fn failure(label: &str, output: &Output) -> String {
    let reason = first_line(&output.stderr);
    match (reason.is_empty(), output.status.code()) {
        (false, _) => format!("{label}: {reason}"),
        (true, Some(code)) => format!("{label}: Exit-Code {code}"),
        (true, None) => format!("{label}: abgebrochen"),
    }
}

/// How long a fresh start may take to show up (unit running or a new status from the script).
const START_CONFIRM: Duration = Duration::from_secs(6);

/// systemd may accept a start job without the update ever running (or the script may stop
/// before its first status). Only a run that shows up counts as started: its unit is running,
/// or the status file was written after `since_ms` (a quick «aktuell» run is already over).
async fn run_started(unit: Option<&str>, since_ms: i64) -> bool {
    let deadline = Instant::now() + START_CONFIRM;
    loop {
        if read_status()
            .await
            .is_some_and(|s| s.updated_at.or(s.started_at).unwrap_or(0) >= since_ms)
        {
            return true;
        }
        if let Some(unit) = unit {
            if unit_running(unit).await {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn unit_running(unit: &str) -> bool {
    let mut cmd = Command::new("systemctl");
    cmd.args(["--user", "show", "--property=ActiveState", "--value", unit]);
    match run_quiet(cmd, "systemctl").await {
        Ok(output) if output.status.success() => matches!(
            String::from_utf8_lossy(&output.stdout).trim(),
            "active" | "activating" | "reloading"
        ),
        _ => false,
    }
}

/// «Result» of a unit that did not run, for the error message (e.g. «exit-code», «resources»).
async fn unit_result(unit: &str) -> String {
    let mut cmd = Command::new("systemctl");
    cmd.args(["--user", "show", "--property=Result", "--value", unit]);
    match run_quiet(cmd, "systemctl").await {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        }
        _ => String::new(),
    }
}

/// The update must never run as a child of the app: stopping the app's unit would kill the
/// update with it. Order: installed user unit → transient unit → detached session. Errors are
/// the bare reasons of all attempts; callers prefix [`TRIGGER_FAILED`].
pub async fn trigger() -> Result<(), String> {
    let dir = project_dir();
    let script = dir.join("scripts/auto-update.sh");
    let mut errors = Vec::new();

    // Its progress is what the caller wants to see; a second start would only merge into it.
    if read_status()
        .await
        .is_some_and(|s| run_active(&s, now_ms()))
    {
        log::info!("Update läuft bereits");
        return Ok(());
    }

    let since = now_ms();
    let mut systemctl = Command::new("systemctl");
    systemctl.args(["--user", "start", "--no-block", UPDATE_UNIT]);
    match run_quiet(systemctl, "systemctl").await {
        Ok(output) if output.status.success() => {
            if run_started(Some(UPDATE_UNIT), since).await {
                log::info!("Update gestartet über {UPDATE_UNIT}");
                TRIGGERED_AT_MS.store(since, Ordering::Relaxed);
                return Ok(());
            }
            let result = unit_result(UPDATE_UNIT).await;
            log::warn!("{UPDATE_UNIT} angenommen, aber nicht angelaufen (Result: {result})");
            errors.push(format!(
                "{UPDATE_UNIT} lief nicht an{}",
                if result.is_empty() || result == "success" {
                    String::new()
                } else {
                    format!(" ({result})")
                }
            ));
        }
        Ok(output) => errors.push(failure("systemctl", &output)),
        Err(e) => errors.push(e),
    }

    if !script.is_file() {
        errors.push(format!("Update-Script fehlt: {}", script.display()));
        return Err(errors.join("; "));
    }

    let mut systemd_run = Command::new("systemd-run");
    systemd_run
        .args(["--user", "--collect", "--quiet"])
        .arg(format!("--unit={MANUAL_UNIT}"))
        .arg(format!("--setenv=SLATEDESK_HOME={}", dir.display()))
        .args(["/bin/bash", "-l"])
        .arg(&script);
    let since = now_ms();
    match run_quiet(systemd_run, "systemd-run").await {
        Ok(output) if output.status.success() => {
            if run_started(Some(&format!("{MANUAL_UNIT}.service")), since).await {
                log::info!("Update gestartet über {MANUAL_UNIT}.service");
                TRIGGERED_AT_MS.store(since, Ordering::Relaxed);
                return Ok(());
            }
            log::warn!("{MANUAL_UNIT}.service angenommen, aber nicht angelaufen");
            errors.push(format!("{MANUAL_UNIT}.service lief nicht an"));
        }
        // The previous manual run is still active – the script's lock allows only one anyway.
        Ok(output) if String::from_utf8_lossy(&output.stderr).contains("already") => {
            log::info!("Update läuft bereits ({MANUAL_UNIT}.service)");
            return Ok(());
        }
        Ok(output) => errors.push(failure("systemd-run", &output)),
        Err(e) => errors.push(e),
    }

    // Without systemd: own session, so the script survives the app's restart. Its output must
    // not go to our pipes, or waiting for setsid would wait for the whole update.
    let mut setsid = Command::new("setsid");
    setsid
        .args(["-f", "/bin/bash", "-l"])
        .arg(&script)
        .env("SLATEDESK_HOME", &dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let since = now_ms();
    match run_quiet(setsid, "setsid").await {
        Ok(output) if output.status.success() => {
            if run_started(None, since).await {
                log::info!("Update gestartet (setsid)");
                TRIGGERED_AT_MS.store(since, Ordering::Relaxed);
                return Ok(());
            }
            errors.push("setsid: Update-Script schrieb keinen Status".to_string());
        }
        Ok(output) => errors.push(failure("setsid", &output)),
        Err(e) => errors.push(e),
    }
    Err(errors.join("; "))
}

#[tauri::command]
pub async fn trigger_update() -> Result<(), String> {
    trigger().await
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct UpdateProgress {
    percent: u8,
    message: String,
    done: bool,
    error: bool,
    /// Phase from the status file (`uptodate`, `build`, `done`, …); `null` for the old log.
    phase: Option<String>,
}

fn step(percent: u8, message: &str) -> UpdateProgress {
    UpdateProgress {
        percent,
        message: message.to_string(),
        done: false,
        error: false,
        phase: None,
    }
}

fn starting() -> UpdateProgress {
    UpdateProgress {
        phase: Some("start".to_string()),
        ..step(0, "Update wird gestartet…")
    }
}

/// `update-status.json` as written by the update script.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StatusFile {
    percent: Option<f64>,
    message: Option<String>,
    phase: Option<String>,
    done: Option<bool>,
    error: Option<Value>,
    started_at: Option<i64>,
    updated_at: Option<i64>,
}

fn is_truthy(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        _ => false,
    }
}

fn progress_from_status(status: &StatusFile, now: i64, triggered_at: i64) -> UpdateProgress {
    let done = status.done.unwrap_or(false);
    let started = status.started_at.unwrap_or(0);
    let updated = status.updated_at.unwrap_or(started);
    // The file still holds the previous, finished run; the triggered one has not started yet.
    if done && triggered_at > started && now - triggered_at < START_GRACE_MS {
        return starting();
    }
    let percent = status
        .percent
        .filter(|p| p.is_finite())
        .map(|p| p.clamp(0.0, 100.0).round() as u8)
        .unwrap_or(0);
    if !done && updated > 0 && now - updated > STALE_STATUS_MS {
        return UpdateProgress {
            percent,
            message: "Update wurde unterbrochen – Details im Update-Log".to_string(),
            done: true,
            error: true,
            phase: Some("error".to_string()),
        };
    }
    UpdateProgress {
        percent,
        message: status.message.clone().unwrap_or_default(),
        done,
        error: is_truthy(status.error.as_ref()),
        phase: status.phase.clone(),
    }
}

/// Seconds since the "[YYYY-MM-DD HH:MM:SS]" stamp of a log line. The old script logged local
/// wall-clock time, so it is read in the local zone (not as UTC).
fn seconds_since_stamp(line: &str, now: i64) -> Option<i64> {
    let stamp = line.trim_start().strip_prefix('[')?.get(..19)?;
    let naive = NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M:%S").ok()?;
    let at = Local.from_local_datetime(&naive).earliest()?;
    Some((now / 1000 - at.timestamp()).max(0))
}

/// Progress of the old update script, scraped from its log (only the last run counts).
fn progress_from_log(content: &str, now: i64) -> UpdateProgress {
    let start_idx = content.rfind("Auto-Update gestartet").unwrap_or(0);
    let run = &content[start_idx..];
    let has = |needle: &str| run.contains(needle);
    let finished = |message: &str| UpdateProgress {
        percent: 100,
        message: message.to_string(),
        done: true,
        error: false,
        phase: None,
    };

    if has("Update erfolgreich abgeschlossen") {
        return finished("Abgeschlossen!");
    }
    if has("Kein Update verfügbar") {
        return finished("SlateDesk ist aktuell");
    }
    if has("Rollback") || run.lines().any(|l| l.contains("[ERROR]")) {
        return UpdateProgress {
            percent: 0,
            message: "Fehler – siehe Log".into(),
            done: true,
            error: true,
            phase: None,
        };
    }
    if has("Starte SlateDesk") {
        return step(95, "Starte SlateDesk…");
    }
    if has("Installiere neues Paket") {
        return step(88, "Installiere Paket…");
    }
    if has("Deinstalliere altes Paket") {
        return step(84, "Deinstalliere altes Paket…");
    }
    if has("Stoppe SlateDesk") {
        return step(82, "Stoppe SlateDesk…");
    }
    if let Some(line) = run.lines().find(|l| l.contains("Baue SlateDesk neu")) {
        let ratio = seconds_since_stamp(line, now)
            .map(|secs| (secs as f64 / LEGACY_BUILD_SECS).min(1.0))
            .unwrap_or(0.0);
        let percent = 35 + (ratio * 46.0) as u8;
        let minutes_left = ((1.0 - ratio) * LEGACY_BUILD_SECS / 60.0).ceil() as u32;
        return step(percent, &format!("Build läuft… (~{minutes_left} Min)"));
    }
    if has("npm install") {
        return step(28, "npm install…");
    }
    if has("Lade neue Änderungen") {
        return step(20, "git pull…");
    }
    if has("Erstelle Backup") {
        return step(15, "Backup erstellen…");
    }
    if has("Neues Update gefunden") {
        return step(12, "Update gefunden…");
    }
    if has("Prüfe auf Updates") {
        return step(8, "Prüfe auf Updates…");
    }
    if has("Netzwerk verfügbar") {
        return step(5, "Netzwerk verbunden…");
    }
    step(2, "Update gestartet…")
}

fn legacy_logs() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("SLATEDESK_LOG").filter(|p| !p.is_empty()) {
        paths.push(PathBuf::from(path));
    }
    if let Some(home) = home_dir() {
        paths.push(home.join("slatedesk-update.log"));
    }
    paths
}

async fn read_status() -> Option<StatusFile> {
    let path = state_dir()?.join("update-status.json");
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            // Written atomically by the script; unreadable means a foreign or broken file.
            .map_err(|e| log::warn!("update-status.json nicht lesbar: {e}"))
            .ok(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            log::warn!("update-status.json nicht lesbar: {e}");
            None
        }
    }
}

/// A run that is still writing its status (the timer's, or one started from the other UI).
fn run_active(status: &StatusFile, now: i64) -> bool {
    let updated = status.updated_at.or(status.started_at).unwrap_or(0);
    !status.done.unwrap_or(false) && updated > 0 && now - updated <= STALE_STATUS_MS
}

pub async fn progress() -> UpdateProgress {
    let now = now_ms();
    let triggered_at = TRIGGERED_AT_MS.load(Ordering::Relaxed);

    if let Some(status) = read_status().await {
        return progress_from_status(&status, now, triggered_at);
    }
    if triggered_at > 0 && now - triggered_at < START_GRACE_MS {
        return starting();
    }
    for path in legacy_logs() {
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            return progress_from_log(&content, now);
        }
    }
    UpdateProgress {
        percent: 0,
        message: "Noch kein Update ausgeführt".to_string(),
        done: true,
        error: false,
        phase: None,
    }
}

#[tauri::command]
pub async fn get_update_progress() -> UpdateProgress {
    progress().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn branch_names_are_validated_like_the_update_script() {
        for ok in ["main", "grosses-update", "feature/x", "v0.2.1", "a_b"] {
            assert!(valid_branch(ok), "{ok}");
        }
        for bad in [
            "",
            "-evil",
            "--upload-pack=x",
            "a..b",
            "x.lock",
            "x/",
            "/x",
            "a b",
            "ä",
        ] {
            assert!(!valid_branch(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn update_branch_reads_the_checkout_config() {
        let dir = std::env::temp_dir().join(format!("sd-branch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            assert!(std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .status()
                .unwrap()
                .success());
        };
        run(&["init", "-q"]);
        // SLATEDESK_BRANCH would override the checkout; the test relies on it being unset.
        if std::env::var_os("SLATEDESK_BRANCH").is_none() {
            assert_eq!(update_branch(&dir).await, "main");
            run(&["config", "slatedesk.branch", "grosses-update"]);
            assert_eq!(update_branch(&dir).await, "grosses-update");
            run(&["config", "slatedesk.branch", "-evil"]);
            assert_eq!(update_branch(&dir).await, "main");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn status(json: &str) -> StatusFile {
        serde_json::from_str(json).unwrap()
    }

    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn status_file_is_passed_through() {
        let running = status(&format!(
            r#"{{"percent":42,"message":"Baue SlateDesk… (noch ca. 7 Min.)","phase":"build","done":false,"error":false,"startedAt":{},"updatedAt":{},"fromCommit":"abc","toCommit":"def"}}"#,
            NOW - 300_000,
            NOW - 5_000
        ));
        assert_eq!(
            progress_from_status(&running, NOW, 0),
            UpdateProgress {
                percent: 42,
                message: "Baue SlateDesk… (noch ca. 7 Min.)".into(),
                done: false,
                error: false,
                phase: Some("build".into()),
            }
        );
        let failed =
            status(r#"{"percent":30,"message":"npm ci fehlgeschlagen.","done":true,"error":true}"#);
        let p = progress_from_status(&failed, NOW, 0);
        assert!(p.done && p.error);
        assert_eq!(p.percent, 30);
        assert!(progress_from_status(&status(r#"{"error":"kaputt"}"#), NOW, 0).error);
    }

    #[test]
    fn previous_run_is_not_reported_right_after_a_trigger() {
        let previous = status(&format!(
            r#"{{"percent":100,"message":"SlateDesk ist aktuell","phase":"uptodate","done":true,"error":false,"startedAt":{0},"updatedAt":{0}}}"#,
            NOW - 3_600_000
        ));
        let triggered = NOW - 3_000;
        assert_eq!(progress_from_status(&previous, NOW, triggered), starting());
        // Long after the trigger without a new run: show what the file says.
        assert!(progress_from_status(&previous, NOW + START_GRACE_MS, triggered).done);
        // A run that is still active when triggered (timer run) is the current one.
        let active = status(&format!(
            r#"{{"percent":40,"message":"Build","done":false,"startedAt":{0},"updatedAt":{1}}}"#,
            NOW - 600_000,
            NOW - 1_000
        ));
        assert_eq!(progress_from_status(&active, NOW, triggered).percent, 40);
    }

    #[test]
    fn active_runs_are_detected() {
        let active = status(&format!(
            r#"{{"done":false,"startedAt":{},"updatedAt":{}}}"#,
            NOW - 600_000,
            NOW - 10_000
        ));
        assert!(run_active(&active, NOW));
        assert!(!run_active(&status(r#"{"done":true,"updatedAt":1}"#), NOW));
        assert!(!run_active(&status(r#"{"done":false}"#), NOW));
        let stuck = status(&format!(
            r#"{{"done":false,"updatedAt":{}}}"#,
            NOW - STALE_STATUS_MS - 1
        ));
        assert!(!run_active(&stuck, NOW));
    }

    #[test]
    fn killed_run_is_reported_as_interrupted() {
        let stuck = status(&format!(
            r#"{{"percent":55,"message":"Build","done":false,"error":false,"startedAt":{0},"updatedAt":{0}}}"#,
            NOW - STALE_STATUS_MS - 60_000
        ));
        let p = progress_from_status(&stuck, NOW, 0);
        assert!(p.done && p.error);
        assert!(p.message.contains("unterbrochen"));
    }

    #[test]
    fn log_fallback_reads_only_the_last_run() {
        let log = "[2024-01-01 10:00:00] Auto-Update gestartet\nUpdate erfolgreich abgeschlossen\n[2024-01-02 10:00:00] Auto-Update gestartet\nPrüfe auf Updates\n";
        let p = progress_from_log(log, NOW);
        assert_eq!(p.percent, 8);
        assert!(!p.done);
        let failed = progress_from_log("Auto-Update gestartet\n[ERROR] kaputt\n", NOW);
        assert!(failed.error && failed.done);
        assert!(progress_from_log("Auto-Update gestartet\nKein Update verfügbar\n", NOW).done);
        assert_eq!(progress_from_log("", NOW).percent, 2);
    }

    #[test]
    fn log_build_time_is_local_time() {
        // Six minutes into the twelve-minute build: halfway from 35 % to 81 %. Read as UTC, a
        // Swiss timestamp would lie one or two hours in the future and stay at 35 %.
        let now = Local::now();
        let started = (now - chrono::Duration::minutes(6)).format("%Y-%m-%d %H:%M:%S");
        let log = format!(
            "[{started}] Auto-Update gestartet\n[{started}] Baue SlateDesk neu (tauri build)\n"
        );
        let p = progress_from_log(&log, now.timestamp_millis());
        assert!((57..=59).contains(&p.percent), "{p:?}");
        assert_eq!(p.message, "Build läuft… (~6 Min)");
    }
}
