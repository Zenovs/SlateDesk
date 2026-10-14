//! `SystemInfo` for the kiosk and the web UI, read from /proc, /sys and `df`.

use crate::remote::{RemoteAuth, RemoteSummary};
use serde::Serialize;
use std::fs;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;
use tokio::process::Command;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Interfaces that are never reachable from the office LAN (containers, VM bridges).
const VIRTUAL_IF_PREFIXES: [&str; 11] = [
    "docker", "veth", "br-", "virbr", "lxcbr", "lxdbr", "cni", "flannel", "vmnet", "vboxnet",
    "podman",
];
/// VPN and overlay interfaces (Tailscale, WireGuard, OpenVPN, ZeroTier, …): reachable only
/// for peers of that network, so they come after every LAN address.
const VPN_IF_PREFIXES: [&str; 8] = [
    "tailscale",
    "wg",
    "tun",
    "tap",
    "zt",
    "ppp",
    "ipsec",
    "nebula",
];
/// Thermal zone / hwmon names that describe the CPU, best first.
const CPU_SENSOR_NAMES: [&str; 8] = [
    "x86_pkg_temp",
    "cpu-thermal",
    "cpu_thermal",
    "soc_thermal",
    "coretemp",
    "k10temp",
    "zenpower",
    "acpitz",
];

/// Build-time git hash from build.rs; `None` when the build had no git checkout.
pub fn commit() -> Option<&'static str> {
    option_env!("SLATEDESK_GIT_HASH").filter(|h| !h.is_empty() && *h != "unbekannt")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Viewport {
    pub width: u32,
    pub height: u32,
}

pub struct SystemContext {
    started: Instant,
    viewport: Mutex<Option<Viewport>>,
}

impl Default for SystemContext {
    fn default() -> Self {
        SystemContext {
            started: Instant::now(),
            viewport: Mutex::new(None),
        }
    }
}

impl SystemContext {
    pub fn viewport(&self) -> Option<Viewport> {
        *self.viewport.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn set_viewport(&self, viewport: Viewport) {
        *self.viewport.lock().unwrap_or_else(|p| p.into_inner()) = Some(viewport);
    }

    pub fn app_uptime(&self) -> Duration {
        self.started.elapsed()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub hostname: String,
    pub ips: Vec<String>,
    pub version: String,
    pub commit: Option<String>,
    pub uptime_seconds: u64,
    pub app_uptime_seconds: u64,
    pub load: [f64; 3],
    pub cpu_count: usize,
    pub mem_total: u64,
    pub mem_available: u64,
    pub disk_total: u64,
    pub disk_available: u64,
    pub cpu_temp_c: Option<f64>,
    pub session_type: String,
    pub desktop: String,
    pub viewport: Option<Viewport>,
    pub remote: RemoteSummary,
}

fn is_virtual_interface(name: &str) -> bool {
    VIRTUAL_IF_PREFIXES.iter().any(|p| name.starts_with(p))
}

fn is_vpn_interface(name: &str) -> bool {
    VPN_IF_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Interface of the main table's default route (lowest metric) from `/proc/net/route`.
fn default_route_interface(table: &str) -> Option<String> {
    table
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let (iface, destination, flags, metric, mask) = (
                fields.first()?,
                fields.get(1)?,
                fields.get(3)?,
                fields.get(6)?,
                fields.get(7)?,
            );
            let up = u32::from_str_radix(flags, 16).ok()? & 0x1 != 0;
            (*destination == "00000000" && *mask == "00000000" && up)
                .then(|| (metric.parse::<u32>().unwrap_or(u32::MAX), iface.to_string()))
        })
        .min()
        .map(|(_, iface)| iface)
}

/// Lower is better: the default route's interface (what the office LAN reaches), then other
/// private addresses, other addresses, and VPN interfaces last.
fn address_rank(interface: &str, ip: &IpAddr, default_interface: Option<&str>) -> u8 {
    let private = match ip {
        IpAddr::V4(v4) => v4.is_private(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00,
    };
    if is_vpn_interface(interface) {
        3
    } else if Some(interface) == default_interface {
        0
    } else if private {
        1
    } else {
        2
    }
}

/// Non-loopback addresses of LAN-facing interfaces, IPv4 first and best reachable first (the
/// wall QR code uses the first); IPv6 link-local is skipped.
pub fn lan_addresses() -> Vec<IpAddr> {
    let default_interface = fs::read_to_string("/proc/net/route")
        .ok()
        .and_then(|table| default_route_interface(&table));
    let mut addrs: Vec<(u8, IpAddr)> = match if_addrs::get_if_addrs() {
        Ok(ifaces) => ifaces
            .into_iter()
            .filter(|iface| !iface.is_loopback() && !is_virtual_interface(&iface.name))
            .map(|iface| {
                let ip = iface.ip();
                (
                    address_rank(&iface.name, &ip, default_interface.as_deref()),
                    ip,
                )
            })
            .filter(|(_, ip)| match ip {
                IpAddr::V4(_) => true,
                IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) != 0xfe80,
            })
            .collect(),
        Err(e) => {
            log::warn!("Netzwerkadressen nicht lesbar: {e}");
            Vec::new()
        }
    };
    addrs.sort_by_key(|(rank, ip)| (ip.is_ipv6(), *rank, *ip));
    let mut seen = std::collections::HashSet::new();
    addrs
        .into_iter()
        .map(|(_, ip)| ip)
        .filter(|ip| seen.insert(*ip))
        .collect()
}

/// Web UI addresses for the kiosk (IPv4 only – that is what people type or scan).
pub fn remote_urls(port: u16) -> Vec<String> {
    lan_addresses()
        .into_iter()
        .filter(IpAddr::is_ipv4)
        .map(|ip| format!("http://{ip}:{port}"))
        .collect()
}

pub fn session_type() -> String {
    match std::env::var("XDG_SESSION_TYPE") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ if std::env::var_os("WAYLAND_DISPLAY").is_some() => "wayland".to_string(),
        _ if std::env::var_os("DISPLAY").is_some() => "x11".to_string(),
        _ => "unbekannt".to_string(),
    }
}

pub fn desktop() -> String {
    std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unbekannt".to_string())
}

fn read_hostname() -> String {
    ["/proc/sys/kernel/hostname", "/etc/hostname"]
        .iter()
        .find_map(|p| fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unbekannt".to_string())
}

fn parse_uptime(text: &str) -> Option<u64> {
    let secs: f64 = text.split_whitespace().next()?.parse().ok()?;
    Some(secs.max(0.0) as u64)
}

fn parse_loadavg(text: &str) -> [f64; 3] {
    let mut load = [0.0; 3];
    for (slot, value) in load.iter_mut().zip(text.split_whitespace()) {
        *slot = value.parse().unwrap_or(0.0);
    }
    load
}

/// `(MemTotal, MemAvailable)` in bytes.
fn parse_meminfo(text: &str) -> (u64, u64) {
    let field = |name: &str| {
        text.lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|rest| rest.trim_start_matches(':').split_whitespace().next())
            .and_then(|kb| kb.parse::<u64>().ok())
            .map(|kb| kb * 1024)
            .unwrap_or(0)
    };
    (field("MemTotal"), field("MemAvailable"))
}

/// `df -P -k /` → `(total, available)` bytes. Columns are read from the right because the
/// filesystem name (first column) may contain spaces.
fn parse_df_output(text: &str) -> Option<(u64, u64)> {
    let line = text.lines().nth(1)?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    let n = fields.len();
    if n < 6 {
        return None;
    }
    let total: u64 = fields[n - 5].parse().ok()?;
    let available: u64 = fields[n - 3].parse().ok()?;
    Some((total * 1024, available * 1024))
}

/// std has no statvfs and rustix/nix are not in the dependency tree; `df -P` is POSIX and
/// present on every target (coreutils and busybox), so no `unsafe` libc call is needed.
async fn disk_usage() -> Option<(u64, u64)> {
    let mut cmd = Command::new("df");
    cmd.args(["-P", "-k", "/"])
        .env("LC_ALL", "C")
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(3), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_df_output(&String::from_utf8_lossy(&output.stdout))
}

fn read_millidegrees(path: &Path) -> Option<f64> {
    let raw: f64 = fs::read_to_string(path).ok()?.trim().parse().ok()?;
    let celsius = raw / 1000.0;
    (-40.0..=150.0)
        .contains(&celsius)
        .then(|| (celsius * 10.0).round() / 10.0)
}

fn sensor_rank(name: &str) -> usize {
    CPU_SENSOR_NAMES
        .iter()
        .position(|n| *n == name)
        .unwrap_or(CPU_SENSOR_NAMES.len())
}

/// Best CPU sensor among thermal zones and hwmon chips; an unknown zone only as last resort.
fn read_cpu_temp() -> Option<f64> {
    let mut best: Option<(usize, f64)> = None;
    let mut consider = |rank: usize, value: Option<f64>| {
        if let Some(v) = value {
            if best.is_none_or(|(r, _)| rank < r) {
                best = Some((rank, v));
            }
        }
    };
    if let Ok(entries) = fs::read_dir("/sys/class/thermal") {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !entry
                .file_name()
                .to_string_lossy()
                .starts_with("thermal_zone")
            {
                continue;
            }
            let name = fs::read_to_string(dir.join("type")).unwrap_or_default();
            consider(
                sensor_rank(name.trim()),
                read_millidegrees(&dir.join("temp")),
            );
        }
    }
    if let Ok(entries) = fs::read_dir("/sys/class/hwmon") {
        for entry in entries.flatten() {
            let dir = entry.path();
            let name = fs::read_to_string(dir.join("name")).unwrap_or_default();
            let rank = sensor_rank(name.trim());
            if rank < CPU_SENSOR_NAMES.len() {
                consider(rank, read_millidegrees(&dir.join("temp1_input")));
            }
        }
    }
    best.map(|(_, v)| v)
}

struct ProcInfo {
    hostname: String,
    uptime_seconds: u64,
    load: [f64; 3],
    mem_total: u64,
    mem_available: u64,
    cpu_temp_c: Option<f64>,
}

fn read_proc_info() -> ProcInfo {
    let read = |p: &str| fs::read_to_string(p).unwrap_or_default();
    let (mem_total, mem_available) = parse_meminfo(&read("/proc/meminfo"));
    ProcInfo {
        hostname: read_hostname(),
        uptime_seconds: parse_uptime(&read("/proc/uptime")).unwrap_or(0),
        load: parse_loadavg(&read("/proc/loadavg")),
        mem_total,
        mem_available,
        cpu_temp_c: read_cpu_temp(),
    }
}

pub async fn collect(ctx: &SystemContext, remote: RemoteSummary) -> SystemInfo {
    let (proc_info, disk) = tokio::join!(tokio::task::spawn_blocking(read_proc_info), disk_usage());
    let proc_info = proc_info.unwrap_or_else(|_| ProcInfo {
        hostname: "unbekannt".to_string(),
        uptime_seconds: 0,
        load: [0.0; 3],
        mem_total: 0,
        mem_available: 0,
        cpu_temp_c: None,
    });
    let (disk_total, disk_available) = disk.unwrap_or((0, 0));
    SystemInfo {
        hostname: proc_info.hostname,
        ips: lan_addresses().iter().map(ToString::to_string).collect(),
        version: VERSION.to_string(),
        commit: commit().map(str::to_string),
        uptime_seconds: proc_info.uptime_seconds,
        app_uptime_seconds: ctx.app_uptime().as_secs(),
        load: proc_info.load,
        cpu_count: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        mem_total: proc_info.mem_total,
        mem_available: proc_info.mem_available,
        disk_total,
        disk_available,
        cpu_temp_c: proc_info.cpu_temp_c,
        session_type: session_type(),
        desktop: desktop(),
        viewport: ctx.viewport(),
        remote,
    }
}

#[tauri::command]
pub async fn system_info(
    ctx: State<'_, Arc<SystemContext>>,
    remote: State<'_, Arc<RemoteAuth>>,
) -> Result<SystemInfo, String> {
    Ok(collect(&ctx, remote.summary()).await)
}

#[tauri::command]
pub async fn report_viewport(
    width: f64,
    height: f64,
    ctx: State<'_, Arc<SystemContext>>,
) -> Result<(), String> {
    let valid = |v: f64| v.is_finite() && (1.0..=100_000.0).contains(&v);
    if !valid(width) || !valid(height) {
        return Err("Ungültige Bildschirmgrösse".to_string());
    }
    ctx.set_viewport(Viewport {
        width: width.round() as u32,
        height: height.round() as u32,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_proc_files() {
        assert_eq!(parse_uptime("12345.67 54321.00\n"), Some(12345));
        assert_eq!(parse_uptime(""), None);
        assert_eq!(
            parse_loadavg("0.52 0.58 0.59 1/467 12345\n"),
            [0.52, 0.58, 0.59]
        );
        let meminfo =
            "MemTotal:       16303428 kB\nMemFree:         1234 kB\nMemAvailable:   8151714 kB\n";
        assert_eq!(parse_meminfo(meminfo), (16303428 * 1024, 8151714 * 1024));
    }

    #[test]
    fn parses_df_output_from_the_right() {
        let gnu = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/nvme0n1p2   959786032 412345678 498765432      46% /\n";
        assert_eq!(
            parse_df_output(gnu),
            Some((959786032 * 1024, 498765432 * 1024))
        );
        let spaced =
            "Filesystem 1024-blocks Used Available Capacity Mounted on\nmy disk 100 40 60 40% /\n";
        assert_eq!(parse_df_output(spaced), Some((100 * 1024, 60 * 1024)));
        assert_eq!(parse_df_output("Filesystem\n"), None);
    }

    #[test]
    fn default_route_interface_comes_first() {
        let table =
            "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n\
wlp4s0\t00000000\t0113A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n\
eno1\t00000000\t0113A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n\
eno1\t0013A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n";
        assert_eq!(default_route_interface(table).as_deref(), Some("eno1"));
        assert_eq!(default_route_interface("Iface\tDestination\n"), None);

        let lan: IpAddr = "192.168.19.181".parse().unwrap();
        let tailscale: IpAddr = "100.101.1.2".parse().unwrap();
        let wireguard: IpAddr = "10.8.0.2".parse().unwrap();
        let other_lan: IpAddr = "192.168.19.183".parse().unwrap();
        let mut ranked = vec![
            (
                address_rank("tailscale0", &tailscale, Some("eno1")),
                tailscale,
            ),
            (address_rank("wg0", &wireguard, Some("eno1")), wireguard),
            (address_rank("wlp4s0", &other_lan, Some("eno1")), other_lan),
            (address_rank("eno1", &lan, Some("eno1")), lan),
        ];
        ranked.sort();
        let order: Vec<IpAddr> = ranked.into_iter().map(|(_, ip)| ip).collect();
        assert_eq!(order[0], lan);
        assert_eq!(order[1], other_lan);
        assert!(order[2..].contains(&tailscale) && order[2..].contains(&wireguard));
        // Without a default route a private address still beats a CGNAT/VPN one.
        assert!(address_rank("eth0", &lan, None) < address_rank("tailscale0", &tailscale, None));
    }

    #[test]
    fn virtual_interfaces_are_filtered() {
        assert!(is_virtual_interface("podman0"));
        assert!(is_virtual_interface("docker0"));
        assert!(is_virtual_interface("br-1a2b"));
        assert!(!is_virtual_interface("eth0"));
        assert!(!is_virtual_interface("wlan0"));
        assert!(!is_virtual_interface("enp3s0"));
    }

    #[test]
    fn sensor_ranking_prefers_cpu_package() {
        assert!(sensor_rank("x86_pkg_temp") < sensor_rank("acpitz"));
        assert!(sensor_rank("cpu-thermal") < sensor_rank("acpitz"));
        assert_eq!(sensor_rank("iwlwifi_1"), CPU_SENSOR_NAMES.len());
    }

    #[test]
    fn urls_use_ipv4_and_port() {
        for url in remote_urls(7380) {
            assert!(url.starts_with("http://") && url.ends_with(":7380"));
            assert!(!url.contains('['));
        }
    }
}
