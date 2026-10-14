//! Network commands: speed test, NAS ping and the multi-target reachability check.

use crate::http::{describe_error, USER_AGENT};
use crate::proc::{output_with_timeout, run_with_timeout};
use futures_util::future::join_all;
use reqwest::header::{HeaderMap, CONTENT_LENGTH, CONTENT_TYPE};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::process::Output;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpStream;
use tokio::process::Command;

const MAX_TARGETS: usize = 32;
const TCP_TIMEOUT: Duration = Duration::from_secs(3);
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const PING_TIMEOUT: Duration = Duration::from_secs(12);

const SPEED_SERVER: &str = "https://speed.cloudflare.com";
const DOWNLOAD_BYTES: usize = 25_000_000;
const UPLOAD_BYTES_MAX: usize = 10_000_000;
const UPLOAD_BYTES_MIN: usize = 1_000_000;
/// Upload size target: what the measured downlink moves in this time. Uplinks are rarely
/// faster than downlinks, so the upload ends well within the transfer timeout.
const UPLOAD_TARGET_SECS: f64 = 8.0;
const UPLOAD_CHUNK: usize = 64 * 1024;
/// Short first upload that sizes the real one. The downlink says little about the uplink (a
/// 20/1 line), and only an upload that finishes is measured exactly.
const UPLOAD_PROBE_BYTES: usize = 256 * 1024;
/// On timeout, bytes handed over before this point are left out: they fill hyper's and the
/// kernel's send buffers within the first seconds and have not crossed the line yet.
const UPLOAD_SETTLE: Duration = Duration::from_secs(10);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30);
const LATENCY_SAMPLES: usize = 10;
const LATENCY_TIMEOUT: Duration = Duration::from_secs(5);
/// Less than this is no measurement, just connection noise.
const MIN_MEASURED_BYTES: usize = 256 * 1024;

static UPLOAD_ZEROS: [u8; UPLOAD_CHUNK] = [0; UPLOAD_CHUNK];
static SPEEDTEST_RUNNING: AtomicBool = AtomicBool::new(false);

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

/// Hostname or IP literal; the first character can never be '-', so it is never read as a
/// command-line option.
pub fn is_valid_host(host: &str) -> bool {
    let mut chars = host.chars();
    host.len() <= 253
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '[' | ']'))
}

/// `[fe80::1]` → `fe80::1` for socket APIs and ping.
fn bare_host(host: &str) -> &str {
    host.trim_start_matches('[').trim_end_matches(']')
}

/// Packet loss and average RTT from the ping summary (iputils and BusyBox).
fn parse_ping(stdout: &str) -> (Option<f64>, Option<f64>) {
    let loss = stdout
        .lines()
        .find(|l| l.contains("packet loss"))
        .and_then(|l| {
            l.split_whitespace()
                .find(|w| w.ends_with('%'))
                .and_then(|w| w.trim_end_matches('%').parse::<f64>().ok())
        });
    let avg = stdout
        .lines()
        .find(|l| l.starts_with("rtt ") || l.starts_with("round-trip"))
        .and_then(|l| l.split('=').nth(1))
        .and_then(|vals| vals.trim().split('/').nth(1))
        .and_then(|v| v.parse::<f64>().ok());
    (loss, avg)
}

/// Why ping produced no summary (unknown host, missing permission, no network).
fn ping_error(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let lower = stderr.to_ascii_lowercase();
    // getaddrinfo EAI_AGAIN: the DNS server did not answer – an outage, the name may be fine.
    if lower.contains("temporary failure in name resolution") {
        "DNS nicht erreichbar".to_string()
    } else if [
        "name or service not known",
        "unknown host",
        "bad address",
        "no address associated",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        "Hostname nicht auflösbar".to_string()
    } else if lower.contains("operation not permitted") || lower.contains("permission denied") {
        "ping nicht erlaubt (fehlende Berechtigung)".to_string()
    } else if lower.contains("network is unreachable") {
        "Netzwerk nicht erreichbar".to_string()
    } else {
        match stderr.lines().map(str::trim).find(|l| !l.is_empty()) {
            Some(line) => format!("ping: {line}"),
            None => match output.status.code() {
                Some(code) => format!("ping ohne Ergebnis (Exit-Code {code})"),
                None => "ping ohne Ergebnis".to_string(),
            },
        }
    }
}

fn ping_command(host: &str, count: &str) -> Command {
    let mut cmd = Command::new("ping");
    // `--` ends option parsing: whatever the host is, it can never become a flag.
    cmd.args(["-c", count, "-W", "2", "--", bare_host(host)])
        .env("LC_ALL", "C");
    cmd
}

// ---------------------------------------------------------------------------
// Speed test
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct SpeedResult {
    download_mbps: f64,
    upload_mbps: f64,
    ping_ms: Option<f64>,
    jitter_ms: Option<f64>,
    interface: String,
    interface_type: String,
    timestamp: u64,
}

/// Only one measurement at a time: two parallel runs would halve each other's result.
struct SpeedTestGuard;

impl SpeedTestGuard {
    fn acquire() -> Option<Self> {
        SPEEDTEST_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| SpeedTestGuard)
    }
}

impl Drop for SpeedTestGuard {
    fn drop(&mut self) {
        SPEEDTEST_RUNNING.store(false, Ordering::Release);
    }
}

fn speed_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        // Compressed zeros would measure the CPU instead of the line.
        .no_gzip()
        .connect_timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP-Client konnte nicht erstellt werden: {e}"))
}

/// Interface name from `ip route get` ("8.8.8.8 via 192.168.1.1 dev wlan0 src …").
fn route_interface(route: &str) -> Option<&str> {
    route
        .split_whitespace()
        .skip_while(|&s| s != "dev")
        .nth(1)
        .filter(|name| !name.is_empty() && !name.contains('/') && *name != "." && *name != "..")
}

fn interface_type(interface: &str) -> &'static str {
    let dir = std::path::Path::new("/sys/class/net").join(interface);
    if dir.join("wireless").exists() || dir.join("phy80211").exists() {
        "WLAN"
    } else {
        "LAN"
    }
}

/// Active interface and LAN/WLAN; Err when there is no route to the internet at all.
async fn detect_interface() -> Result<(String, String), String> {
    match run_with_timeout("ip", ["route", "get", "8.8.8.8"], Duration::from_secs(5)).await {
        Ok(output) if output.status.success() => {
            let route = String::from_utf8_lossy(&output.stdout);
            Ok(match route_interface(&route) {
                Some(name) => (name.to_string(), interface_type(name).to_string()),
                None => ("unbekannt".to_string(), "LAN".to_string()),
            })
        }
        Ok(_) => Err("Keine Internetverbindung (keine Netzwerkroute)".to_string()),
        // Without iproute2 the measurement itself still works.
        Err(e) => {
            log::warn!("Speedtest: Netzwerk-Interface nicht ermittelt: {e}");
            Ok(("unbekannt".to_string(), "LAN".to_string()))
        }
    }
}

/// Server think time from `Server-Timing` – not part of the round trip. Cloudflare reports it
/// as `cfSpeedEdge;dur=5, cfSpeedWorker;dur=25` (formerly `cfRequestDuration;dur=30`); the
/// worker alone often takes longer than the network round trip.
fn server_duration(headers: &HeaderMap) -> Option<Duration> {
    let durations: Vec<f64> = headers
        .get_all("server-timing")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .filter_map(|metric| {
            let mut parts = metric.split(';').map(str::trim);
            let name = parts.next()?;
            if !name.get(..2).is_some_and(|p| p.eq_ignore_ascii_case("cf")) {
                return None;
            }
            parts
                .find_map(|p| p.strip_prefix("dur="))
                .and_then(|d| d.parse::<f64>().ok())
                .filter(|ms| ms.is_finite() && *ms >= 0.0)
        })
        .collect();
    (!durations.is_empty()).then(|| Duration::from_secs_f64(durations.iter().sum::<f64>() / 1000.0))
}

/// Median round trip and jitter (mean difference of consecutive samples), as
/// speed.cloudflare.com reports them.
fn latency_stats(samples: &[f64]) -> (Option<f64>, Option<f64>) {
    if samples.is_empty() {
        return (None, None);
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    let median = if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    };
    let jitter = (samples.len() >= 2).then(|| {
        samples.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / (samples.len() - 1) as f64
    });
    (Some(round1(median)), jitter.map(round1))
}

/// Round trips in ms of empty requests on an already open connection.
async fn measure_latency(client: &Client, base: &str) -> Result<Vec<f64>, String> {
    let url = format!("{base}/__down?bytes=0");
    // Warm-up: DNS, TCP and TLS setup are no round trip. Failing here means offline.
    let warmup = client
        .get(&url)
        .timeout(LATENCY_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Keine Internetverbindung ({})", describe_error(&e)))?;
    if !warmup.status().is_success() {
        return Err(format!(
            "Speedtest-Server antwortet mit HTTP {}",
            warmup.status().as_u16()
        ));
    }
    let _ = warmup.bytes().await;

    let mut samples = Vec::with_capacity(LATENCY_SAMPLES);
    for _ in 0..LATENCY_SAMPLES {
        let started = Instant::now();
        let Ok(response) = client.get(&url).timeout(LATENCY_TIMEOUT).send().await else {
            continue;
        };
        let elapsed = started.elapsed();
        let server = server_duration(response.headers()).unwrap_or_default();
        let ok = response.status().is_success();
        // Drained so the connection goes back to the pool for the next sample.
        let _ = response.bytes().await;
        // A server time above the measured time is a clock artefact, not a round trip.
        if let Some(rtt) = elapsed.checked_sub(server).filter(|d| ok && !d.is_zero()) {
            samples.push(rtt.as_secs_f64() * 1000.0);
        }
    }
    Ok(samples)
}

fn mbps(bytes: usize, secs: f64) -> f64 {
    round1(bytes as f64 * 8.0 / secs / 1_000_000.0)
}

/// Throughput from the first to the last body chunk: connection setup and server think time
/// are no line speed. On slow lines the bytes received until the deadline still give the rate.
async fn measure_download(client: &Client, base: &str, bytes: usize) -> Result<f64, String> {
    let deadline = tokio::time::Instant::now() + TRANSFER_TIMEOUT;
    let url = format!("{base}/__down?bytes={bytes}");
    let mut response = tokio::time::timeout_at(deadline, client.get(&url).send())
        .await
        .map_err(|_| "Download: Zeitüberschreitung".to_string())?
        .map_err(|e| format!("Download fehlgeschlagen: {}", describe_error(&e)))?;
    if !response.status().is_success() {
        return Err(format!(
            "Download fehlgeschlagen: HTTP {}",
            response.status().as_u16()
        ));
    }

    let mut first: Option<(Instant, usize)> = None;
    let mut last = Instant::now();
    let mut received = 0usize;
    loop {
        match tokio::time::timeout_at(deadline, response.chunk()).await {
            Err(_) | Ok(Ok(None)) => break,
            Ok(Ok(Some(chunk))) => {
                last = Instant::now();
                first.get_or_insert((last, chunk.len()));
                received += chunk.len();
            }
            Ok(Err(e)) => {
                return Err(format!("Download abgebrochen: {}", describe_error(&e)));
            }
        }
    }
    let Some((first_at, first_len)) = first else {
        return Err("Download fehlgeschlagen: keine Daten empfangen".to_string());
    };
    let measured = received - first_len;
    let secs = last.duration_since(first_at).as_secs_f64();
    if measured < MIN_MEASURED_BYTES || secs <= 0.0 {
        return Err("Download: zu wenig Daten für eine Messung".to_string());
    }
    Ok(mbps(measured, secs))
}

fn upload_size(download_mbps: f64) -> usize {
    let bytes = download_mbps * 1_000_000.0 / 8.0 * UPLOAD_TARGET_SECS;
    if bytes.is_finite() {
        (bytes as usize).clamp(UPLOAD_BYTES_MIN, UPLOAD_BYTES_MAX)
    } else {
        UPLOAD_BYTES_MIN
    }
}

/// Upload of `bytes` zeros, measured until the server's answer minus one round trip. On
/// timeout only the bytes handed over after [`UPLOAD_SETTLE`] count – the ones before mostly
/// sat in send buffers.
async fn measure_upload(
    client: &Client,
    base: &str,
    bytes: usize,
    rtt_ms: Option<f64>,
) -> Result<f64, String> {
    let handed_over = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&handed_over);
    let chunks = bytes.div_ceil(UPLOAD_CHUNK);
    let stream = futures_util::stream::iter((0..chunks).map(move |i| {
        let len = UPLOAD_CHUNK.min(bytes - i * UPLOAD_CHUNK);
        counter.fetch_add(len, Ordering::Relaxed);
        Ok::<&'static [u8], std::io::Error>(&UPLOAD_ZEROS[..len])
    }));
    let request = client
        .post(format!("{base}/__up"))
        .header(CONTENT_TYPE, "application/octet-stream")
        .header(CONTENT_LENGTH, bytes)
        .body(reqwest::Body::wrap_stream(stream));

    let started = Instant::now();
    let send = request.send();
    tokio::pin!(send);
    let deadline = tokio::time::sleep(TRANSFER_TIMEOUT);
    tokio::pin!(deadline);
    let settle = tokio::time::sleep(UPLOAD_SETTLE);
    tokio::pin!(settle);
    let mut settled: Option<(Instant, usize)> = None;
    let outcome = loop {
        tokio::select! {
            result = &mut send => break Some(result),
            () = &mut settle, if settled.is_none() => {
                settled = Some((Instant::now(), handed_over.load(Ordering::Relaxed)));
            }
            () = &mut deadline => break None,
        }
    };
    let (sent, elapsed) = match outcome {
        Some(Ok(response)) => {
            let elapsed = started.elapsed().as_secs_f64();
            if !response.status().is_success() {
                return Err(format!(
                    "Upload fehlgeschlagen: HTTP {}",
                    response.status().as_u16()
                ));
            }
            let rtt = rtt_ms.unwrap_or(0.0) / 1000.0;
            (bytes, (elapsed - rtt).max(elapsed * 0.5))
        }
        Some(Err(e)) => return Err(format!("Upload fehlgeschlagen: {}", describe_error(&e))),
        None => match settled {
            Some((at, before)) => (
                handed_over.load(Ordering::Relaxed).saturating_sub(before),
                at.elapsed().as_secs_f64(),
            ),
            None => (0, 0.0),
        },
    };
    if sent < MIN_MEASURED_BYTES || elapsed <= 0.0 {
        return Err("Upload: Zeitüberschreitung ohne verwertbare Messung".to_string());
    }
    Ok(mbps(sent, elapsed))
}

#[derive(Debug)]
struct Measurement {
    ping_ms: Option<f64>,
    jitter_ms: Option<f64>,
    download_mbps: f64,
    upload_mbps: f64,
}

async fn speed_test(base: &str) -> Result<Measurement, String> {
    let client = speed_client()?;
    let samples = measure_latency(&client, base).await?;
    let (ping_ms, jitter_ms) = latency_stats(&samples);
    let download_mbps = measure_download(&client, base, DOWNLOAD_BYTES).await?;
    let probe_mbps = measure_upload(&client, base, UPLOAD_PROBE_BYTES, ping_ms).await?;
    // The probe underrates fast lines (TCP slow start), so the downlink still caps the size.
    let size = upload_size(probe_mbps).min(upload_size(download_mbps));
    let upload_mbps = measure_upload(&client, base, size, ping_ms).await?;
    if download_mbps <= 0.0 || upload_mbps <= 0.0 {
        return Err("Messung ergab 0 Mbit/s – Verbindung gestört".to_string());
    }
    Ok(Measurement {
        ping_ms,
        jitter_ms,
        download_mbps,
        upload_mbps,
    })
}

#[tauri::command]
pub async fn run_speed_test() -> Result<SpeedResult, String> {
    let Some(_guard) = SpeedTestGuard::acquire() else {
        return Err("Es läuft bereits ein Speedtest".to_string());
    };
    let (interface, interface_type) = detect_interface().await?;
    let measurement = speed_test(SPEED_SERVER).await?;
    Ok(SpeedResult {
        download_mbps: measurement.download_mbps,
        upload_mbps: measurement.upload_mbps,
        ping_ms: measurement.ping_ms,
        jitter_ms: measurement.jitter_ms,
        interface,
        interface_type,
        timestamp: unix_now(),
    })
}

// ---------------------------------------------------------------------------
// NAS
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct NasResult {
    reachable: bool,
    latency_ms: f64,
    packet_loss_pct: u8,
    timestamp: u64,
}

#[tauri::command]
pub async fn test_nas_connection(ip: String) -> Result<NasResult, String> {
    let ip = ip.trim();
    if ip.is_empty() {
        return Err("Keine IP-Adresse angegeben".to_string());
    }
    if !is_valid_host(ip) {
        return Err("Ungültige IP-Adresse oder ungültiger Hostname".to_string());
    }

    let output = output_with_timeout(ping_command(ip, "4"), "ping", Duration::from_secs(15))
        .await
        .map_err(|e| format!("ping fehlgeschlagen: {e}"))?;
    let (loss, avg) = parse_ping(&String::from_utf8_lossy(&output.stdout));
    // No summary: ping never got to send (unknown host, no permission) – an error, not "offline".
    let Some(loss) = loss else {
        return Err(ping_error(&output));
    };
    let packet_loss_pct = loss.clamp(0.0, 100.0).round() as u8;

    Ok(NasResult {
        reachable: packet_loss_pct < 100,
        latency_ms: avg.unwrap_or(0.0),
        packet_loss_pct,
        timestamp: unix_now(),
    })
}

// ---------------------------------------------------------------------------
// net_check
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckKind {
    Ping,
    Tcp,
    Http,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckScheme {
    Http,
    Https,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CheckTarget {
    host: String,
    port: Option<u16>,
    kind: CheckKind,
    path: Option<String>,
    /// For `http` checks: from the address the user entered (`https://nas:5001`). Without it,
    /// port 443 means https and a plain-HTTP attempt that the device breaks off is retried
    /// with https.
    #[serde(default)]
    scheme: Option<CheckScheme>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    host: String,
    port: Option<u16>,
    kind: CheckKind,
    reachable: bool,
    latency_ms: Option<f64>,
    packet_loss_pct: Option<f64>,
    status: Option<u16>,
    error: Option<String>,
    timestamp: u64,
}

impl CheckResult {
    fn new(target: &CheckTarget) -> Self {
        CheckResult {
            host: target.host.clone(),
            port: target.port,
            kind: target.kind,
            reachable: false,
            latency_ms: None,
            packet_loss_pct: None,
            status: None,
            error: None,
            timestamp: unix_now(),
        }
    }

    fn failed(mut self, error: impl Into<String>) -> Self {
        self.error = Some(error.into());
        self
    }
}

fn round_ms(d: Duration) -> f64 {
    round1(d.as_secs_f64() * 1000.0)
}

/// Device checks hit routers, NAS and printers with self-signed certificates; for "is it up"
/// the certificate does not matter, and a redirect already proves reachability.
fn probe_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .user_agent(USER_AGENT)
                .danger_accept_invalid_certs(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(HTTP_TIMEOUT)
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

async fn check_tcp(target: &CheckTarget, result: CheckResult) -> CheckResult {
    let Some(port) = target.port else {
        return result.failed("Port fehlt");
    };
    let started = Instant::now();
    match tokio::time::timeout(
        TCP_TIMEOUT,
        TcpStream::connect((bare_host(&target.host), port)),
    )
    .await
    {
        Ok(Ok(_stream)) => CheckResult {
            reachable: true,
            latency_ms: Some(round_ms(started.elapsed())),
            ..result
        },
        Ok(Err(e)) => result.failed(format!("Verbindung fehlgeschlagen: {e}")),
        Err(_) => result.failed("Zeitüberschreitung"),
    }
}

fn http_url(target: &CheckTarget, scheme: CheckScheme) -> Result<reqwest::Url, String> {
    let port = target.port.unwrap_or(match scheme {
        CheckScheme::Http => 80,
        CheckScheme::Https => 443,
    });
    let scheme = match scheme {
        CheckScheme::Http => "http",
        CheckScheme::Https => "https",
    };
    let path = target.path.as_deref().unwrap_or("/").trim();
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    if path
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '#')
    {
        return Err("Ungültiger Pfad".to_string());
    }
    // IPv6 literals need brackets in a URL.
    let host = bare_host(&target.host);
    let host = if host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    reqwest::Url::parse(&format!("{scheme}://{host}:{port}{path}"))
        .map_err(|_| "Ungültige Adresse".to_string())
}

/// The scheme to try first, and whether https is worth a second try when it fails.
fn http_schemes(target: &CheckTarget) -> (CheckScheme, bool) {
    match (target.scheme, target.port) {
        (Some(scheme), _) => (scheme, false),
        (None, Some(443)) => (CheckScheme::Https, false),
        (None, None | Some(80)) => (CheckScheme::Http, false),
        // E.g. Synology DSM on 5001, Proxmox on 8006, UniFi on 8443.
        (None, Some(_)) => (CheckScheme::Http, true),
    }
}

async fn check_http(target: &CheckTarget, result: CheckResult) -> CheckResult {
    let client = match probe_client() {
        Ok(client) => client,
        Err(e) => return result.failed(e),
    };
    let (first, try_https) = http_schemes(target);
    let url = match http_url(target, first) {
        Ok(url) => url,
        Err(e) => return result.failed(e),
    };
    let mut outcome = probe_http(client, url).await;
    // A TLS port drops plain HTTP; a closed port or a dead host is no reason to retry.
    if try_https && matches!(&outcome, Err(e) if !e.is_connect() && !e.is_timeout()) {
        if let Ok(url) = http_url(target, CheckScheme::Https) {
            outcome = probe_http(client, url).await;
        }
    }
    match outcome {
        Ok((status, latency)) => CheckResult {
            reachable: true,
            latency_ms: Some(round_ms(latency)),
            status: Some(status),
            ..result
        },
        Err(e) => result.failed(describe_error(&e)),
    }
}

async fn probe_http(client: &Client, url: reqwest::Url) -> Result<(u16, Duration), reqwest::Error> {
    let started = Instant::now();
    let response = client.get(url).send().await?;
    Ok((response.status().as_u16(), started.elapsed()))
}

async fn check_ping(target: &CheckTarget, result: CheckResult) -> CheckResult {
    let output =
        match output_with_timeout(ping_command(&target.host, "3"), "ping", PING_TIMEOUT).await {
            Ok(output) => output,
            Err(e) => return result.failed(e),
        };
    let (loss, avg) = parse_ping(&String::from_utf8_lossy(&output.stdout));
    match loss {
        Some(loss) => CheckResult {
            reachable: loss < 100.0,
            latency_ms: avg,
            packet_loss_pct: Some(loss),
            error: (loss >= 100.0).then(|| "Keine Antwort".to_string()),
            ..result
        },
        None => result.failed(ping_error(&output)),
    }
}

async fn check_one(target: CheckTarget) -> CheckResult {
    let result = CheckResult::new(&target);
    if !is_valid_host(&target.host) {
        return result.failed("Ungültiger Hostname");
    }
    match target.kind {
        CheckKind::Tcp => check_tcp(&target, result).await,
        CheckKind::Http => check_http(&target, result).await,
        CheckKind::Ping => check_ping(&target, result).await,
    }
}

#[tauri::command]
pub async fn net_check(targets: Vec<CheckTarget>) -> Result<Vec<CheckResult>, String> {
    if targets.len() > MAX_TARGETS {
        return Err(format!("Zu viele Ziele (maximal {MAX_TARGETS})"));
    }
    Ok(join_all(targets.into_iter().map(check_one)).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::Query;
    use axum::http::header;
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use std::collections::HashMap;
    use std::os::unix::process::ExitStatusExt;
    use std::process::ExitStatus;

    #[test]
    fn host_validation_blocks_options() {
        for ok in ["192.168.1.10", "nas.local", "fe80::1", "my-nas"] {
            assert!(is_valid_host(ok), "{ok}");
        }
        for bad in [
            "", "-c99999", "-I", "a b", "host;rm", "x/y", ".hidden", "[::1]",
        ] {
            assert!(!is_valid_host(bad), "{bad}");
        }
    }

    #[test]
    fn parses_ping_summary() {
        let out = "3 packets transmitted, 3 received, 0% packet loss, time 2003ms\nrtt min/avg/max/mdev = 0.412/0.430/0.456/0.019 ms\n";
        assert_eq!(parse_ping(out), (Some(0.0), Some(0.430)));
        let lost = "3 packets transmitted, 0 received, 100% packet loss, time 2050ms\n";
        assert_eq!(parse_ping(lost), (Some(100.0), None));
        let partial = "3 packets transmitted, 2 received, 33.3333% packet loss, time 2003ms\n";
        assert_eq!(parse_ping(partial).0, Some(33.3333));
        let busybox = "3 packets transmitted, 3 packets received, 0% packet loss\nround-trip min/avg/max = 0.1/0.2/0.3 ms\n";
        assert_eq!(parse_ping(busybox), (Some(0.0), Some(0.2)));
        assert_eq!(parse_ping("ping: unknown host"), (None, None));
    }

    fn output(code: i32, stderr: &str) -> Output {
        Output {
            status: ExitStatus::from_raw(code << 8),
            stdout: Vec::new(),
            stderr: stderr.as_bytes().to_vec(),
        }
    }

    #[test]
    fn ping_errors_are_german() {
        assert_eq!(
            ping_error(&output(2, "ping: nas.invalid: Name or service not known\n")),
            "Hostname nicht auflösbar"
        );
        assert_eq!(
            ping_error(&output(
                2,
                "ping: socktype: SOCK_RAW\nping: socket: Operation not permitted\n"
            )),
            "ping nicht erlaubt (fehlende Berechtigung)"
        );
        assert_eq!(
            ping_error(&output(
                2,
                "ping: nas.firma.lan: Temporary failure in name resolution\n"
            )),
            "DNS nicht erreichbar"
        );
        assert_eq!(
            ping_error(&output(2, "ping: connect: Network is unreachable\n")),
            "Netzwerk nicht erreichbar"
        );
        assert_eq!(
            ping_error(&output(2, "")),
            "ping ohne Ergebnis (Exit-Code 2)"
        );
    }

    #[tokio::test]
    async fn nas_rejects_option_injection() {
        assert!(test_nas_connection("-c99999".into()).await.is_err());
        assert!(test_nas_connection("   ".into()).await.is_err());
    }

    #[test]
    fn http_urls_use_port_and_path() {
        let target = |host: &str, port, path: Option<&str>| CheckTarget {
            host: host.into(),
            port,
            kind: CheckKind::Http,
            path: path.map(Into::into),
            scheme: None,
        };
        let url = |t: &CheckTarget| http_url(t, http_schemes(t).0).map(|u| u.to_string());
        assert_eq!(
            url(&target("nas.local", None, None)).unwrap(),
            "http://nas.local/"
        );
        assert_eq!(
            url(&target("nas.local", Some(5000), Some("status"))).unwrap(),
            "http://nas.local:5000/status"
        );
        assert_eq!(
            url(&target("nas.local", Some(443), Some("/"))).unwrap(),
            "https://nas.local/"
        );
        assert_eq!(
            url(&target("fe80::1", Some(8080), None)).unwrap(),
            "http://[fe80::1]:8080/"
        );
        assert!(url(&target("nas.local", None, Some("/a b"))).is_err());

        // `https://nas:5001` as entered by the user stays https.
        let dsm = CheckTarget {
            scheme: Some(CheckScheme::Https),
            ..target("nas", Some(5001), None)
        };
        assert_eq!(url(&dsm).unwrap(), "https://nas:5001/");
        assert_eq!(http_schemes(&dsm), (CheckScheme::Https, false));
        let plain = CheckTarget {
            scheme: Some(CheckScheme::Http),
            ..target("printer", Some(443), None)
        };
        assert_eq!(url(&plain).unwrap(), "http://printer:443/");
        let https_default = CheckTarget {
            scheme: Some(CheckScheme::Https),
            ..target("nas", None, None)
        };
        assert_eq!(url(&https_default).unwrap(), "https://nas/");
        // Unknown scheme on an unusual port: http first, https as second try.
        assert_eq!(
            http_schemes(&target("pve", Some(8006), None)),
            (CheckScheme::Http, true)
        );
        assert_eq!(
            http_schemes(&target("nas", Some(80), None)),
            (CheckScheme::Http, false)
        );
        let parsed: CheckTarget = serde_json::from_value(serde_json::json!({
            "host": "nas", "port": 5001, "kind": "http", "scheme": "https"
        }))
        .unwrap();
        assert_eq!(parsed.scheme, Some(CheckScheme::Https));
    }

    #[tokio::test]
    async fn http_check_retries_with_https_when_plain_http_is_dropped() {
        // Stands in for a TLS port: accepts and hangs up on whatever arrives.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let accepted = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&accepted);
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                counter.fetch_add(1, Ordering::SeqCst);
                drop(stream);
            }
        });
        let target = |scheme| CheckTarget {
            host: "127.0.0.1".into(),
            port: Some(port),
            kind: CheckKind::Http,
            path: None,
            scheme,
        };
        let unknown = check_one(target(None)).await;
        assert!(!unknown.reachable);
        assert_eq!(accepted.load(Ordering::SeqCst), 2, "http, then https");
        let explicit = check_one(target(Some(CheckScheme::Http))).await;
        assert!(!explicit.reachable);
        assert_eq!(accepted.load(Ordering::SeqCst), 3, "no second try");
    }

    #[tokio::test]
    async fn tcp_check_against_local_listener() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let results = net_check(vec![
            CheckTarget {
                host: "127.0.0.1".into(),
                port: Some(port),
                kind: CheckKind::Tcp,
                path: None,
                scheme: None,
            },
            CheckTarget {
                host: "127.0.0.1".into(),
                port: None,
                kind: CheckKind::Tcp,
                path: None,
                scheme: None,
            },
            CheckTarget {
                host: "-x".into(),
                port: Some(1),
                kind: CheckKind::Ping,
                path: None,
                scheme: None,
            },
        ])
        .await
        .unwrap();
        assert!(results[0].reachable);
        assert!(results[0].latency_ms.is_some());
        assert_eq!(results[1].error.as_deref(), Some("Port fehlt"));
        assert_eq!(results[2].error.as_deref(), Some("Ungültiger Hostname"));
    }

    #[test]
    fn route_and_latency_helpers() {
        assert_eq!(
            route_interface("8.8.8.8 via 192.168.1.1 dev wlp2s0 src 192.168.1.20 uid 1000\n"),
            Some("wlp2s0")
        );
        assert_eq!(route_interface("8.8.8.8 dev ../x src 1.2.3.4"), None);
        assert_eq!(route_interface(""), None);

        assert_eq!(latency_stats(&[]), (None, None));
        assert_eq!(latency_stats(&[10.0]), (Some(10.0), None));
        // Median (10 + 11) / 2, jitter (2 + 3 + 2) / 3
        assert_eq!(
            latency_stats(&[10.0, 12.0, 9.0, 11.0]),
            (Some(10.5), Some(2.3))
        );
        // Median 12, jitter (2 + 3 + 1 + 3) / 4
        assert_eq!(
            latency_stats(&[10.0, 12.0, 15.0, 14.0, 11.0]),
            (Some(12.0), Some(2.3))
        );

        let mut headers = HeaderMap::new();
        headers.insert(
            "server-timing",
            "cfL4;desc=\"x\", cfRequestDuration;dur=12.5"
                .parse()
                .unwrap(),
        );
        assert_eq!(
            server_duration(&headers),
            Some(Duration::from_secs_f64(0.0125))
        );
        let mut current = HeaderMap::new();
        current.append(
            "server-timing",
            "cfSpeedEdge;dur=5, cfSpeedWorker;dur=25".parse().unwrap(),
        );
        current.append(
            "server-timing",
            "cfL4;desc=\"?proto=TCP&rtt=7487\"".parse().unwrap(),
        );
        assert_eq!(
            server_duration(&current),
            Some(Duration::from_secs_f64(0.030))
        );
        assert_eq!(server_duration(&HeaderMap::new()), None);

        // 20/1 line: the probe measures ~1 Mbit/s, so 1 MB instead of 10 MB is uploaded and
        // the upload finishes within the timeout.
        assert_eq!(upload_size(0.9).min(upload_size(20.0)), UPLOAD_BYTES_MIN);
        assert_eq!(upload_size(0.0), UPLOAD_BYTES_MIN);
        assert_eq!(upload_size(4.0), 4_000_000);
        assert_eq!(upload_size(1000.0), UPLOAD_BYTES_MAX);
        assert_eq!(upload_size(f64::NAN), UPLOAD_BYTES_MIN);
    }

    async fn fake_speed_server(upload_status: u16) -> String {
        async fn down(Query(query): Query<HashMap<String, String>>) -> impl IntoResponse {
            let bytes: usize = query.get("bytes").and_then(|b| b.parse().ok()).unwrap_or(0);
            (
                [("server-timing", "cfRequestDuration;dur=0.1")],
                Body::from(vec![0u8; bytes]),
            )
        }
        let app = axum::Router::new()
            .route("/__down", get(down))
            .route(
                "/__up",
                post(move |body: axum::body::Bytes| async move {
                    assert!(body.len() >= UPLOAD_PROBE_BYTES);
                    (
                        axum::http::StatusCode::from_u16(upload_status).unwrap(),
                        [(header::CONTENT_TYPE, "text/plain")],
                        "ok",
                    )
                }),
            )
            .layer(axum::extract::DefaultBodyLimit::disable());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn speed_test_measures_against_fake_server() {
        let base = fake_speed_server(200).await;
        let m = speed_test(&base).await.unwrap();
        assert!(m.ping_ms.is_some_and(|p| p >= 0.0));
        assert!(m.jitter_ms.is_some());
        assert!(m.download_mbps > 0.0 && m.upload_mbps > 0.0, "{m:?}");
    }

    #[tokio::test]
    async fn speed_test_errors_instead_of_zero() {
        let base = fake_speed_server(500).await;
        let err = speed_test(&base).await.unwrap_err();
        assert_eq!(err, "Upload fehlgeschlagen: HTTP 500");

        // Nothing listens there: offline must be an error, never 0 Mbit/s.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let err = speed_test(&closed).await.unwrap_err();
        assert!(err.starts_with("Keine Internetverbindung"), "{err}");

        let client = speed_client().unwrap();
        let err = measure_download(&client, &base, 1000).await.unwrap_err();
        assert_eq!(err, "Download: zu wenig Daten für eine Messung");
    }

    #[test]
    fn only_one_speed_test_at_a_time() {
        let first = SpeedTestGuard::acquire().expect("free");
        assert!(SpeedTestGuard::acquire().is_none());
        drop(first);
        assert!(SpeedTestGuard::acquire().is_some());
    }
}
