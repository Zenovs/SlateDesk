//! Protokoll of the kiosk: every 60 s a sample (memory, swap, load, CPU temperature, memory of
//! the app and its WebKit processes) and events (start, end, display, mail, warnings) as JSON
//! lines in `~/.local/state/slatedesk/health.log`, each line synced to disk at once – after a
//! hang the log shows what happened before it.
//!
//! A run that ends without a clean exit (the app hung or crashed, the device hung or lost
//! power) is reported by the next start: with the last values, after a device restart with the
//! system journal of the previous boot (when readable), and by mail.
//!
//! Memory guard: when memory is almost full and SlateDesk (with WebKit) holds a large part of
//! it, SlateDesk restarts itself – before the device swaps itself into a hang.

use crate::proc::output_with_timeout;
use crate::system;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

const SAMPLE_EVERY: Duration = Duration::from_secs(60);
const LOG_FILE: &str = "health.log";
const OLD_LOG_FILE: &str = "health.log.1";
const MARKER_FILE: &str = "run.json";
/// Moved to `health.log.1` above this size – together about two weeks of samples.
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 200;
const REPORT_MS: u64 = 24 * 3_600_000;
/// The last REPORT_MS go to the web UI as at most this many points.
const MAX_POINTS: usize = 288;
const LOW_MEMORY_PERCENT: u64 = 8;
const HOT_CPU_C: f64 = 85.0;
/// A warning that holds is repeated at most this often.
const WARN_EVERY_MS: u64 = 30 * 60_000;
const MAX_DETAIL_CHARS: usize = 8_000;
/// Memory guard: less than this share free …
const CRITICAL_FREE_PERCENT: u64 = 5;
/// … while SlateDesk holds more than this share.
const CRITICAL_APP_PERCENT: u64 = 40;
/// No guard restart in the first half hour – a restart loop would be worse than the problem.
const GUARD_AFTER_MS: u64 = 30 * 60_000;
const JOURNAL_TIMEOUT: Duration = Duration::from_secs(10);
/// Last part of the app log offered for download.
const APP_LOG_TAIL_BYTES: u64 = 1024 * 1024;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// «22.10.2026 12:03:15» in local time.
fn format_time(ms: u64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms as i64)
        .single()
        .map(|t| t.format("%d.%m.%Y %H:%M:%S").to_string())
        .unwrap_or_else(|| "unbekannt".to_string())
}

/// `$XDG_STATE_HOME/slatedesk`, else `~/.local/state/slatedesk` – next to the update log.
pub fn state_dir() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .unwrap_or_else(std::env::temp_dir)
        .join("slatedesk")
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub mem_total_mb: u64,
    pub mem_available_mb: u64,
    pub swap_used_mb: u64,
    pub load1: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_temp_c: Option<f64>,
    /// Resident memory of the app and all its child processes (WebKit).
    pub app_mb: u64,
}

impl Sample {
    fn summary(&self) -> String {
        let mut text = format!(
            "Arbeitsspeicher frei {} von {} MB, Swap belegt {} MB, Last {:.1}, SlateDesk {} MB",
            self.mem_available_mb, self.mem_total_mb, self.swap_used_mb, self.load1, self.app_mb
        );
        if let Some(temp) = self.cpu_temp_c {
            text.push_str(&format!(", CPU {temp:.0} °C"));
        }
        text
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Entry {
    Sample {
        t: u64,
        #[serde(flatten)]
        sample: Sample,
    },
    Event {
        t: u64,
        level: Level,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

impl Entry {
    fn time(&self) -> u64 {
        match self {
            Entry::Sample { t, .. } | Entry::Event { t, .. } => *t,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    pid: u32,
    boot_id: String,
    started: u64,
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

fn meminfo_kb(text: &str, key: &str) -> Option<u64> {
    text.lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix(':'))
        .and_then(|rest| rest.split_whitespace().next()?.parse().ok())
}

/// Parent of every process, from `/proc/<pid>/stat` (the name may contain spaces and «)»).
fn parents(proc_root: &Path) -> HashMap<u32, u32> {
    let mut map = HashMap::new();
    let Ok(entries) = fs::read_dir(proc_root) else {
        return map;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(stat) = fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let ppid = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(1)?.parse().ok());
        if let Some(ppid) = ppid {
            map.insert(pid, ppid);
        }
    }
    map
}

/// Resident memory (kB) of `pid` and all its descendants.
fn tree_rss_kb(proc_root: &Path, pid: u32) -> u64 {
    let parents = parents(proc_root);
    let mut tree = vec![pid];
    let mut index = 0;
    while index < tree.len() {
        let parent = tree[index];
        tree.extend(
            parents
                .iter()
                .filter(|(_, p)| **p == parent)
                .map(|(child, _)| *child),
        );
        index += 1;
    }
    tree.iter()
        .filter_map(|pid| fs::read_to_string(proc_root.join(pid.to_string()).join("status")).ok())
        .filter_map(|status| meminfo_kb(&status, "VmRSS"))
        .sum()
}

fn measure(proc_root: &Path, pid: u32) -> Sample {
    let meminfo = fs::read_to_string(proc_root.join("meminfo")).unwrap_or_default();
    let mb = |key: &str| meminfo_kb(&meminfo, key).unwrap_or(0) / 1024;
    let load1 = fs::read_to_string(proc_root.join("loadavg"))
        .ok()
        .and_then(|text| text.split_whitespace().next()?.parse().ok())
        .unwrap_or(0.0);
    Sample {
        mem_total_mb: mb("MemTotal"),
        mem_available_mb: mb("MemAvailable"),
        swap_used_mb: mb("SwapTotal").saturating_sub(mb("SwapFree")),
        load1,
        cpu_temp_c: system::read_cpu_temp(),
        app_mb: tree_rss_kb(proc_root, pid) / 1024,
    }
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

#[derive(Default)]
struct Warned {
    memory: u64,
    heat: u64,
}

pub struct HealthLog {
    dir: PathBuf,
    app_log_dir: Option<PathBuf>,
    proc_root: PathBuf,
    pid: u32,
    started: u64,
    write: Mutex<()>,
    warned: Mutex<Warned>,
}

static LOG: OnceLock<Arc<HealthLog>> = OnceLock::new();
/// Restarts SlateDesk cleanly (set by lib.rs).
type Restart = Box<dyn Fn() + Send + Sync>;
static RESTART: OnceLock<Restart> = OnceLock::new();
static RESTARTING: AtomicBool = AtomicBool::new(false);

/// What the memory guard calls to restart SlateDesk.
pub fn on_memory_critical(restart: impl Fn() + Send + Sync + 'static) {
    let _ = RESTART.set(Box::new(restart));
}

fn memory_critical(sample: &Sample) -> bool {
    let total = sample.mem_total_mb;
    total > 0
        && sample.mem_available_mb * 100 < total * CRITICAL_FREE_PERCENT
        && sample.app_mb * 100 > total * CRITICAL_APP_PERCENT
}

/// The log of this run (`None` before [`start`], e.g. in tests).
pub fn current() -> Option<Arc<HealthLog>> {
    LOG.get().cloned()
}

/// Adds an event to the log of this run (no-op before [`start`]).
pub fn event(level: Level, text: impl Into<String>) {
    if let Some(log) = LOG.get() {
        log.append_event(level, text.into(), None);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventInfo {
    pub t: u64,
    pub level: Level,
    pub text: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplePoint {
    pub t: u64,
    #[serde(flatten)]
    pub sample: Sample,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthReport {
    /// Start of this run (unix ms).
    pub started: u64,
    /// Newest first.
    pub events: Vec<EventInfo>,
    /// The last 24 h, oldest first; buckets keep the worst values (least free memory).
    pub samples: Vec<SamplePoint>,
}

/// How the previous run ended without a clean exit.
#[derive(Debug, Clone, PartialEq, Eq)]
enum UnexpectedEnd {
    /// Same boot: the app crashed or was killed, the device kept running.
    App,
    /// New boot: the device hung or lost power.
    Device,
}

fn truncate_tail(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_string();
    }
    let tail: String = text.chars().skip(count - max).collect();
    format!("…{tail}")
}

impl HealthLog {
    fn new(dir: PathBuf, app_log_dir: Option<PathBuf>, proc_root: PathBuf, pid: u32) -> Self {
        HealthLog {
            dir,
            app_log_dir,
            proc_root,
            pid,
            started: now_ms(),
            write: Mutex::new(()),
            warned: Mutex::new(Warned::default()),
        }
    }

    fn append(&self, entry: &Entry) {
        let Ok(line) = serde_json::to_string(entry) else {
            return;
        };
        let _guard = lock(&self.write);
        let path = self.dir.join(LOG_FILE);
        if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
            let _ = fs::rename(&path, self.dir.join(OLD_LOG_FILE));
        }
        let result = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut file| {
                writeln!(file, "{line}")?;
                // On disk now: a hang a second later must not lose it.
                file.sync_data()
            });
        if let Err(e) = result {
            log::warn!("Protokoll {} nicht geschrieben: {e}", path.display());
        }
    }

    fn append_event(&self, level: Level, text: String, detail: Option<String>) {
        match level {
            Level::Info => log::info!("Protokoll: {text}"),
            Level::Warn | Level::Error => log::warn!("Protokoll: {text}"),
        }
        self.append(&Entry::Event {
            t: now_ms(),
            level,
            text,
            detail,
        });
    }

    fn entries(&self) -> Vec<Entry> {
        [OLD_LOG_FILE, LOG_FILE]
            .iter()
            .filter_map(|file| fs::read_to_string(self.dir.join(file)).ok())
            .flat_map(|text| {
                text.lines()
                    .filter_map(|line| serde_json::from_str::<Entry>(line).ok())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    fn write_marker(&self, boot_id: &str) {
        let marker = Marker {
            pid: self.pid,
            boot_id: boot_id.to_string(),
            started: self.started,
        };
        let path = self.dir.join(MARKER_FILE);
        if let Err(e) = serde_json::to_string(&marker)
            .map_err(std::io::Error::other)
            .and_then(|json| fs::write(&path, json))
        {
            log::warn!("{} nicht geschrieben: {e}", path.display());
        }
    }

    /// How the previous run ended – `None` when it exited cleanly (or there was none).
    fn previous_end(&self, boot_id: &str) -> Option<(UnexpectedEnd, Marker)> {
        let text = fs::read_to_string(self.dir.join(MARKER_FILE)).ok()?;
        let marker: Marker = serde_json::from_str(&text).ok()?;
        let end = if marker.boot_id == boot_id {
            UnexpectedEnd::App
        } else {
            UnexpectedEnd::Device
        };
        Some((end, marker))
    }

    /// Text and detail of the event about a run that ended without a clean exit.
    fn describe_end(&self, end: &UnexpectedEnd, marker: &Marker) -> (String, String) {
        let entries = self.entries();
        let last_seen = entries
            .iter()
            .map(Entry::time)
            .filter(|t| *t >= marker.started)
            .max()
            .unwrap_or(marker.started);
        let last_sample = entries.iter().rev().find_map(|entry| match entry {
            Entry::Sample { t, sample } if *t >= marker.started => Some(sample.clone()),
            _ => None,
        });
        let when = format_time(last_seen);
        let text = match end {
            UnexpectedEnd::App => format!(
                "SlateDesk wurde unerwartet beendet – letztes Lebenszeichen {when}. Die App ist abgestürzt oder wurde abgewürgt, das Gerät lief weiter."
            ),
            UnexpectedEnd::Device => format!(
                "Das Gerät wurde neu gestartet, ohne dass SlateDesk beendet wurde – letztes Lebenszeichen {when}. Das Gerät hing oder war ohne Strom."
            ),
        };
        let detail = match last_sample {
            Some(sample) => format!("Letzte Werte: {}", sample.summary()),
            None => "Keine Werte aus dem vorherigen Lauf.".to_string(),
        };
        (text, detail)
    }

    fn check_warnings(&self, sample: &Sample) {
        let now = now_ms();
        let mut warned = lock(&self.warned);
        let low_memory = sample.mem_total_mb > 0
            && sample.mem_available_mb * 100 < sample.mem_total_mb * LOW_MEMORY_PERCENT;
        if low_memory && now.saturating_sub(warned.memory) >= WARN_EVERY_MS {
            warned.memory = now;
            drop(warned);
            self.append_event(
                Level::Warn,
                format!("Wenig Arbeitsspeicher – {}", sample.summary()),
                None,
            );
            warned = lock(&self.warned);
        }
        let hot = sample.cpu_temp_c.is_some_and(|t| t >= HOT_CPU_C);
        if hot && now.saturating_sub(warned.heat) >= WARN_EVERY_MS {
            warned.heat = now;
            drop(warned);
            self.append_event(
                Level::Warn,
                format!("CPU sehr heiss – {}", sample.summary()),
                None,
            );
        }
    }

    fn take_sample(&self) {
        let sample = measure(&self.proc_root, self.pid);
        self.check_warnings(&sample);
        let critical =
            memory_critical(&sample) && now_ms().saturating_sub(self.started) >= GUARD_AFTER_MS;
        let summary = sample.summary();
        self.append(&Entry::Sample {
            t: now_ms(),
            sample,
        });
        if critical && !RESTARTING.swap(true, Ordering::SeqCst) {
            if let Some(restart) = RESTART.get() {
                self.append_event(
                    Level::Warn,
                    format!("Arbeitsspeicher fast voll – {summary}. SlateDesk startet neu, bevor das Gerät hängt."),
                    None,
                );
                restart();
            }
        }
    }

    pub fn report(&self) -> HealthReport {
        let entries = self.entries();
        let mut events: Vec<EventInfo> = entries
            .iter()
            .filter_map(|entry| match entry {
                Entry::Event {
                    t,
                    level,
                    text,
                    detail,
                } => Some(EventInfo {
                    t: *t,
                    level: *level,
                    text: text.clone(),
                    detail: detail.clone(),
                }),
                Entry::Sample { .. } => None,
            })
            .collect();
        events.reverse();
        events.truncate(MAX_EVENTS);
        let from = now_ms().saturating_sub(REPORT_MS);
        let points: Vec<SamplePoint> = entries
            .into_iter()
            .filter_map(|entry| match entry {
                Entry::Sample { t, sample } if t >= from => Some(SamplePoint { t, sample }),
                _ => None,
            })
            .collect();
        HealthReport {
            started: self.started,
            events,
            samples: downsample(points, MAX_POINTS),
        }
    }

    /// Both log files as one text (JSON lines), oldest first.
    pub fn export(&self) -> String {
        [OLD_LOG_FILE, LOG_FILE]
            .iter()
            .filter_map(|file| fs::read_to_string(self.dir.join(file)).ok())
            .collect()
    }

    /// The end of the newest app log (tauri-plugin-log).
    pub fn app_log(&self) -> Option<String> {
        use std::io::{Read, Seek, SeekFrom};
        let dir = self.app_log_dir.as_ref()?;
        let newest = fs::read_dir(dir)
            .ok()?
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "log"))
            .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())?;
        let mut file = fs::File::open(newest.path()).ok()?;
        let len = file.metadata().ok()?.len();
        file.seek(SeekFrom::Start(len.saturating_sub(APP_LOG_TAIL_BYTES)))
            .ok()?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// At most `max` points; each bucket keeps the worst values (least free memory, most swap,
/// highest load, temperature and app memory), so a short dip stays visible.
fn downsample(points: Vec<SamplePoint>, max: usize) -> Vec<SamplePoint> {
    if points.len() <= max || max == 0 {
        return points;
    }
    let size = points.len().div_ceil(max);
    points
        .chunks(size)
        .filter_map(|bucket| {
            let last = bucket.last()?;
            let mut worst = last.sample.clone();
            for point in bucket {
                let s = &point.sample;
                worst.mem_available_mb = worst.mem_available_mb.min(s.mem_available_mb);
                worst.swap_used_mb = worst.swap_used_mb.max(s.swap_used_mb);
                worst.load1 = worst.load1.max(s.load1);
                worst.app_mb = worst.app_mb.max(s.app_mb);
                worst.cpu_temp_c = match (worst.cpu_temp_c, s.cpu_temp_c) {
                    (Some(a), Some(b)) => Some(a.max(b)),
                    (a, b) => a.or(b),
                };
            }
            Some(SamplePoint {
                t: last.t,
                sample: worst,
            })
        })
        .collect()
}

fn boot_id() -> String {
    fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// The end of the previous boot's journal: its last messages and the kernel warnings. Without
/// read access to the system journal only the own (user) messages are visible.
async fn previous_boot_journal() -> String {
    async fn journal(args: &[&str]) -> Option<String> {
        let mut cmd = Command::new("journalctl");
        cmd.args(args).env("LC_ALL", "C");
        let output = output_with_timeout(cmd, "journalctl", JOURNAL_TIMEOUT)
            .await
            .ok()?;
        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        (output.status.success() && !text.is_empty()).then_some(text)
    }
    let last = journal(&[
        "-b",
        "-1",
        "-n",
        "40",
        "-q",
        "--no-pager",
        "-o",
        "short-iso",
    ])
    .await;
    let kernel = journal(&[
        "-b",
        "-1",
        "-k",
        "-p",
        "warning",
        "-n",
        "30",
        "-q",
        "--no-pager",
        "-o",
        "short-iso",
    ])
    .await;
    let mut text = String::new();
    match last {
        Some(lines) => text.push_str(&format!("Letzte Meldungen vor dem Neustart:\n{lines}")),
        None => text.push_str("Das Systemprotokoll des vorherigen Starts ist nicht lesbar (kein dauerhaftes Journal?)."),
    }
    match kernel {
        Some(lines) => text.push_str(&format!("\n\nKernel-Warnungen:\n{lines}")),
        None => text.push_str(
            "\n\nKernel-Meldungen: keine Warnungen sichtbar – ohne Leserecht auf das Systemprotokoll fehlen sie (Installation einmal erneut ausführen).",
        ),
    }
    text
}

/// Starts the log of this run and reports a previous run that ended without a clean exit.
pub fn start(app_log_dir: Option<PathBuf>) -> Arc<HealthLog> {
    let dir = state_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        log::warn!("{} nicht angelegt: {e}", dir.display());
    }
    let log = Arc::new(HealthLog::new(
        dir,
        app_log_dir,
        PathBuf::from("/proc"),
        std::process::id(),
    ));
    let _ = LOG.set(Arc::clone(&log));
    let boot = boot_id();
    let previous = log.previous_end(&boot);
    let commit = system::commit()
        .map(|c| format!(" ({c})"))
        .unwrap_or_default();
    log.append_event(
        Level::Info,
        format!("SlateDesk gestartet – Version {}{commit}", system::VERSION),
        None,
    );
    log.write_marker(&boot);
    if let Some((end, marker)) = previous {
        let report = Arc::clone(&log);
        tauri::async_runtime::spawn(async move {
            let (text, mut detail) = report.describe_end(&end, &marker);
            if end == UnexpectedEnd::Device {
                detail.push_str("\n\n");
                detail.push_str(&previous_boot_journal().await);
            }
            let detail = truncate_tail(&detail, MAX_DETAIL_CHARS);
            report.append_event(Level::Error, text.clone(), Some(detail.clone()));
            let host = fs::read_to_string("/proc/sys/kernel/hostname")
                .map(|h| h.trim().to_string())
                .unwrap_or_default();
            let subject = match end {
                UnexpectedEnd::App => format!("SlateDesk auf {host} wurde unerwartet beendet"),
                UnexpectedEnd::Device => format!("{host} hing und wurde neu gestartet"),
            };
            let body = format!(
                "{text}\n\n{detail}\n\nAlles weitere in der Fernsteuerung unter System → Protokoll."
            );
            let _ = crate::mail::mail_alert(subject, body);
        });
    }
    log
}

/// Clean exit: noted, and the next start reports nothing.
pub fn stop() {
    if let Some(log) = LOG.get() {
        log.append_event(Level::Info, "SlateDesk beendet".to_string(), None);
        let _ = fs::remove_file(log.dir.join(MARKER_FILE));
    }
}

/// Sample loop, started once at app start.
pub async fn run(log: Arc<HealthLog>) {
    loop {
        tokio::time::sleep(SAMPLE_EVERY).await;
        let step = Arc::clone(&log);
        let _ = tokio::task::spawn_blocking(move || step.take_sample()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Sandbox {
        dir: PathBuf,
    }

    impl Sandbox {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("slatedesk-health-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            let proc_root = dir.join("proc");
            let write = |file: &str, value: &str| {
                let path = proc_root.join(file);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, value).unwrap();
            };
            write(
                "meminfo",
                "MemTotal:        8000000 kB\nMemFree:          100000 kB\nMemAvailable:     409600 kB\nSwapTotal:       2097152 kB\nSwapFree:        1048576 kB\n",
            );
            write("loadavg", "3.25 2.00 1.50 2/400 1234\n");
            // The app (100), a WebKit process (101), its helper (102) and a stranger (200).
            write("100/stat", "100 (slate-desk) S 1 100 100 0");
            write("100/status", "Name:\tslate-desk\nVmRSS:\t  102400 kB\n");
            write("101/stat", "101 (WebKitWeb Process)) S 100 100 100 0");
            write(
                "101/status",
                "Name:\tWebKitWebProcess\nVmRSS:\t  512000 kB\n",
            );
            write("102/stat", "102 (helper) S 101 100 100 0");
            write("102/status", "VmRSS:\t  10240 kB\n");
            write("200/stat", "200 (other) S 1 200 200 0");
            write("200/status", "VmRSS:\t  999999 kB\n");
            fs::create_dir_all(dir.join("state")).unwrap();
            Sandbox { dir }
        }

        fn log(&self) -> HealthLog {
            HealthLog::new(self.dir.join("state"), None, self.dir.join("proc"), 100)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn measures_memory_of_the_app_and_its_children() {
        let sandbox = Sandbox::new("measure");
        let sample = measure(&sandbox.dir.join("proc"), 100);
        assert_eq!(sample.mem_total_mb, 7812);
        assert_eq!(sample.mem_available_mb, 400);
        assert_eq!(sample.swap_used_mb, 1024);
        assert_eq!(sample.load1, 3.25);
        assert_eq!(sample.app_mb, (102_400 + 512_000 + 10_240) / 1024);
    }

    #[test]
    fn samples_and_events_round_trip_and_warn_once() {
        let sandbox = Sandbox::new("roundtrip");
        let log = sandbox.log();
        log.append_event(Level::Info, "SlateDesk gestartet".into(), None);
        // 400 of 7812 MB free (5 %): a warning, then not again within the half hour.
        log.take_sample();
        log.take_sample();
        let report = log.report();
        assert_eq!(report.samples.len(), 2);
        assert_eq!(report.samples[0].sample.app_mb, 610);
        let texts: Vec<_> = report.events.iter().map(|e| e.text.as_str()).collect();
        assert_eq!(texts.len(), 2);
        assert!(
            texts[0].starts_with("Wenig Arbeitsspeicher – Arbeitsspeicher frei 400 von 7812 MB"),
            "{texts:?}"
        );
        assert_eq!(texts[1], "SlateDesk gestartet");
        assert!(log.export().lines().count() == 4);
    }

    #[test]
    fn reports_how_the_previous_run_ended() {
        let sandbox = Sandbox::new("previous");
        let log = sandbox.log();
        assert_eq!(log.previous_end("boot-a"), None);
        log.write_marker("boot-a");
        log.take_sample();
        let (end, marker) = log.previous_end("boot-a").unwrap();
        assert_eq!(end, UnexpectedEnd::App);
        assert_eq!(log.previous_end("boot-b").unwrap().0, UnexpectedEnd::Device);
        let (text, detail) = log.describe_end(&UnexpectedEnd::Device, &marker);
        assert!(
            text.starts_with("Das Gerät wurde neu gestartet, ohne dass SlateDesk beendet wurde"),
            "{text}"
        );
        assert!(
            detail.starts_with("Letzte Werte: Arbeitsspeicher frei 400 von 7812 MB"),
            "{detail}"
        );
        // A clean exit removes the marker.
        fs::remove_file(sandbox.dir.join("state").join(MARKER_FILE)).unwrap();
        assert_eq!(log.previous_end("boot-b"), None);
    }

    #[test]
    fn downsampling_keeps_the_worst_values() {
        let point = |t: u64, free: u64, app: u64| SamplePoint {
            t,
            sample: Sample {
                mem_available_mb: free,
                app_mb: app,
                ..Sample::default()
            },
        };
        let points = vec![
            point(1, 900, 100),
            point(2, 50, 300),
            point(3, 800, 200),
            point(4, 700, 150),
        ];
        let out = downsample(points, 2);
        assert_eq!(out.len(), 2);
        assert_eq!(
            (
                out[0].t,
                out[0].sample.mem_available_mb,
                out[0].sample.app_mb
            ),
            (2, 50, 300)
        );
        assert_eq!(
            (
                out[1].t,
                out[1].sample.mem_available_mb,
                out[1].sample.app_mb
            ),
            (4, 700, 200)
        );
    }

    #[test]
    fn memory_guard_needs_little_free_memory_and_a_large_slatedesk() {
        let sample = |free: u64, app: u64| Sample {
            mem_total_mb: 8000,
            mem_available_mb: free,
            app_mb: app,
            ..Sample::default()
        };
        assert!(memory_critical(&sample(300, 4000)));
        assert!(!memory_critical(&sample(500, 4000)), "enough free memory");
        assert!(
            !memory_critical(&sample(300, 2000)),
            "another program holds the memory"
        );
        assert!(!memory_critical(&Sample::default()));
    }

    #[test]
    fn long_details_keep_their_end() {
        assert_eq!(truncate_tail("abcdef", 3), "…def");
        assert_eq!(truncate_tail("abc", 3), "abc");
    }
}
