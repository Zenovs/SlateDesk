//! Fernsteuerung access: `remote.json` (port, PIN), login sessions and the login rate limiter.
//! `remote.json` is Rust-owned (mode 0600) and never sent to HTTP clients.

use rand::rngs::OsRng;
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::net::IpAddr;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::State;

pub const DEFAULT_PORT: u16 = 7380;
pub const SESSION_COOKIE: &str = "sd_session";
pub const SESSION_MAX_AGE: Duration = Duration::from_secs(2_592_000);
pub const LOGIN_MAX_FAILURES: usize = 5;
pub const LOGIN_WINDOW: Duration = Duration::from_secs(300);
/// Wrong PINs from all clients together within [`LOGIN_WINDOW`] before every PIN login is
/// locked – an attacker in the LAN can use many source addresses.
pub const GLOBAL_MAX_FAILURES: usize = 20;
/// First global lockout; every further one within [`GLOBAL_STRIKE_RESET`] doubles it.
pub const GLOBAL_LOCKOUT: Duration = Duration::from_secs(15 * 60);
const GLOBAL_LOCKOUT_MAX: Duration = Duration::from_secs(4 * 60 * 60);
/// Without a new lockout for this long, the next one starts again at [`GLOBAL_LOCKOUT`].
const GLOBAL_STRIKE_RESET: Duration = Duration::from_secs(24 * 60 * 60);
/// New PINs (a million combinations); [`LEGACY_MIN_PIN_LEN`] still opens older setups.
pub const MIN_PIN_LEN: usize = 6;
const LEGACY_MIN_PIN_LEN: usize = 4;
const MAX_PIN_LEN: usize = 12;
const REMOTE_FILE: &str = "remote.json";
const MAX_SESSIONS: usize = 256;
const MAX_TRACKED_IPS: usize = 4096;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteConfig {
    pub enabled: bool,
    pub port: u16,
    pub pin: String,
}

/// Lenient on-disk shape: missing fields fall back to defaults instead of failing.
#[derive(Deserialize)]
struct StoredConfig {
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    pin: String,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EnvOverrides {
    pub port: Option<u16>,
    pub disabled: bool,
}

impl EnvOverrides {
    /// `SLATEDESK_REMOTE_PORT` overrides the port, `SLATEDESK_REMOTE_DISABLED=1` turns it off.
    pub fn from_env() -> Self {
        let port = std::env::var("SLATEDESK_REMOTE_PORT")
            .ok()
            .and_then(|v| v.trim().parse::<u16>().ok())
            .filter(|p| *p != 0);
        let disabled = std::env::var("SLATEDESK_REMOTE_DISABLED")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);
        EnvOverrides { port, disabled }
    }
}

fn is_digits(pin: &str, min_len: usize) -> bool {
    (min_len..=MAX_PIN_LEN).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

/// Rule for a new PIN: 6 to 12 digits.
pub fn is_valid_pin(pin: &str) -> bool {
    is_digits(pin, MIN_PIN_LEN)
}

/// A PIN already in `remote.json`: setups from before the 6-digit rule keep their 4- or
/// 5-digit PIN until it is changed.
fn is_usable_stored_pin(pin: &str) -> bool {
    is_digits(pin, LEGACY_MIN_PIN_LEN)
}

pub const PIN_RULE_MESSAGE: &str = "Der neue PIN muss aus 6 bis 12 Ziffern bestehen";

pub fn generate_pin() -> String {
    format!("{:06}", OsRng.gen_range(0..1_000_000u32))
}

/// Compares SHA-256 digests so neither content nor length leaks through timing.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let (ha, hb) = (Sha256::digest(a), Sha256::digest(b));
    ha.iter()
        .zip(hb.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

fn session_key(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

fn write_config(path: &Path, config: &RemoteConfig) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(config).map_err(std::io::Error::other)?;
    let temp = path.with_extension("json.tmp");
    crate::state::write_private(&temp, &bytes)?;
    fs::rename(&temp, path)
}

/// Failed logins per client IP within a sliding window, plus a global budget across all
/// clients with a lockout that grows on repetition.
#[derive(Debug, Default)]
pub struct LoginLimiter {
    failures: HashMap<IpAddr, Vec<Instant>>,
    /// Failures of all clients within [`LOGIN_WINDOW`].
    recent: VecDeque<Instant>,
    locked_until: Option<Instant>,
    strikes: u32,
    last_lockout: Option<Instant>,
}

impl LoginLimiter {
    fn prune(&mut self, ip: IpAddr, now: Instant) -> usize {
        let Some(times) = self.failures.get_mut(&ip) else {
            return 0;
        };
        times.retain(|t| now.saturating_duration_since(*t) < LOGIN_WINDOW);
        let count = times.len();
        if count == 0 {
            self.failures.remove(&ip);
        }
        count
    }

    /// `Err(retry_after)` while PIN logins are locked globally or the client used up its
    /// attempts.
    pub fn check(&mut self, ip: IpAddr, now: Instant) -> Result<(), Duration> {
        if let Some(until) = self.locked_until {
            if until > now {
                return Err(until.saturating_duration_since(now));
            }
            self.locked_until = None;
        }
        if self.prune(ip, now) < LOGIN_MAX_FAILURES {
            return Ok(());
        }
        let oldest = self.failures[&ip].iter().min().copied().unwrap_or(now);
        Err(LOGIN_WINDOW.saturating_sub(now.saturating_duration_since(oldest)))
    }

    pub fn record_failure(&mut self, ip: IpAddr, now: Instant) {
        if self.failures.len() >= MAX_TRACKED_IPS && !self.failures.contains_key(&ip) {
            self.failures.retain(|_, times| {
                times.retain(|t| now.saturating_duration_since(*t) < LOGIN_WINDOW);
                !times.is_empty()
            });
        }
        self.failures.entry(ip).or_default().push(now);

        while self
            .recent
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= LOGIN_WINDOW)
        {
            self.recent.pop_front();
        }
        self.recent.push_back(now);
        if self.recent.len() >= GLOBAL_MAX_FAILURES {
            self.lock_all(now);
        }
    }

    fn lock_all(&mut self, now: Instant) {
        if self
            .last_lockout
            .is_some_and(|at| now.saturating_duration_since(at) >= GLOBAL_STRIKE_RESET)
        {
            self.strikes = 0;
        }
        self.strikes = self.strikes.saturating_add(1);
        let factor = 1u32 << self.strikes.saturating_sub(1).min(8);
        let lockout = GLOBAL_LOCKOUT
            .saturating_mul(factor)
            .min(GLOBAL_LOCKOUT_MAX);
        self.locked_until = Some(now + lockout);
        self.last_lockout = Some(now);
        self.recent.clear();
        log::warn!(
            "Fernsteuerung: {GLOBAL_MAX_FAILURES} falsche PINs in {} Min. – Anmeldung für {} Min. gesperrt",
            LOGIN_WINDOW.as_secs() / 60,
            lockout.as_secs() / 60
        );
    }

    pub fn reset(&mut self, ip: IpAddr) {
        self.failures.remove(&ip);
    }
}

/// `SystemInfo.remote`.
/// Outcome of [`RemoteAuth::attempt_pin`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinCheck {
    Accepted,
    Rejected,
    /// Too many failures – try again after this long; the PIN was not checked.
    Blocked(Duration),
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteSummary {
    pub enabled: bool,
    pub port: u16,
    pub urls: Vec<String>,
}

pub struct RemoteAuth {
    path: PathBuf,
    config: Mutex<RemoteConfig>,
    env: EnvOverrides,
    sessions: Mutex<HashMap<String, Instant>>,
    limiter: Mutex<LoginLimiter>,
    server_error: Mutex<Option<String>>,
}

impl RemoteAuth {
    /// Reads `remote.json`, creating it (random PIN) when missing or unusable.
    pub fn load(dir: &Path, env: EnvOverrides) -> Self {
        let path = dir.join(REMOTE_FILE);
        let stored = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<StoredConfig>(&bytes) {
                Ok(stored) => Some(stored),
                Err(e) => {
                    log::error!("remote.json ist ungültig ({e}) – wird neu angelegt");
                    None
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                log::error!("remote.json nicht lesbar: {e}");
                None
            }
        };

        let mut dirty = stored.is_none();
        let mut config = match stored {
            Some(s) => RemoteConfig {
                enabled: s.enabled,
                port: s.port,
                pin: s.pin.trim().to_string(),
            },
            None => RemoteConfig {
                enabled: true,
                port: DEFAULT_PORT,
                pin: String::new(),
            },
        };
        if config.port == 0 {
            config.port = DEFAULT_PORT;
            dirty = true;
        }
        if !is_usable_stored_pin(&config.pin) {
            config.pin = generate_pin();
            dirty = true;
        } else if !is_valid_pin(&config.pin) {
            log::warn!(
                "Fernsteuerung: der PIN hat weniger als {MIN_PIN_LEN} Ziffern – bitte in der Fernsteuerung ändern"
            );
        }

        if dirty {
            if let Err(e) = fs::create_dir_all(dir).and_then(|_| write_config(&path, &config)) {
                log::error!("remote.json konnte nicht gespeichert werden: {e}");
            }
        } else if let Ok(meta) = fs::metadata(&path) {
            if meta.permissions().mode() & 0o077 != 0 {
                if let Err(e) = fs::set_permissions(&path, fs::Permissions::from_mode(0o600)) {
                    log::warn!("Rechte von remote.json nicht korrigierbar: {e}");
                }
            }
        }

        RemoteAuth {
            path,
            config: Mutex::new(config),
            env,
            sessions: Mutex::new(HashMap::new()),
            limiter: Mutex::new(LoginLimiter::default()),
            server_error: Mutex::new(None),
        }
    }

    pub fn enabled(&self) -> bool {
        !self.env.disabled && lock(&self.config).enabled
    }

    pub fn port(&self) -> u16 {
        self.env.port.unwrap_or_else(|| lock(&self.config).port)
    }

    pub fn pin(&self) -> String {
        lock(&self.config).pin.clone()
    }

    pub fn verify_pin(&self, candidate: &str) -> bool {
        let pin = self.pin();
        constant_time_eq(candidate.trim().as_bytes(), pin.as_bytes())
    }

    pub fn change_pin(&self, next: &str) -> Result<(), String> {
        let next = next.trim();
        if !is_valid_pin(next) {
            return Err(PIN_RULE_MESSAGE.to_string());
        }
        let mut config = lock(&self.config);
        let updated = RemoteConfig {
            pin: next.to_string(),
            ..config.clone()
        };
        write_config(&self.path, &updated)
            .map_err(|e| format!("PIN konnte nicht gespeichert werden: {e}"))?;
        *config = updated;
        Ok(())
    }

    pub fn create_session(&self) -> String {
        let mut raw = [0u8; 32];
        OsRng.fill_bytes(&mut raw);
        let token = hex::encode(raw);
        let now = Instant::now();
        let mut sessions = lock(&self.sessions);
        sessions.retain(|_, created| now.saturating_duration_since(*created) < SESSION_MAX_AGE);
        if sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, created)| **created)
                .map(|(key, _)| key.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(session_key(&token), now);
        token
    }

    pub fn session_valid(&self, token: &str) -> bool {
        let key = session_key(token);
        let mut sessions = lock(&self.sessions);
        match sessions.get(&key) {
            Some(created) if created.elapsed() < SESSION_MAX_AGE => true,
            Some(_) => {
                sessions.remove(&key);
                false
            }
            None => false,
        }
    }

    pub fn end_session(&self, token: &str) {
        lock(&self.sessions).remove(&session_key(token));
    }

    /// After a PIN change only the session that changed it stays logged in.
    pub fn end_other_sessions(&self, keep: &str) {
        let keep = session_key(keep);
        lock(&self.sessions).retain(|key, _| *key == keep);
    }

    /// Checks `candidate` against the PIN within the rate limits. Check, verification and
    /// bookkeeping happen under one lock, so parallel requests cannot all pass the check
    /// before their failures are counted.
    pub fn attempt_pin(&self, ip: IpAddr, candidate: &str, now: Instant) -> PinCheck {
        let mut limiter = lock(&self.limiter);
        if let Err(retry_after) = limiter.check(ip, now) {
            return PinCheck::Blocked(retry_after);
        }
        if self.verify_pin(candidate) {
            limiter.reset(ip);
            PinCheck::Accepted
        } else {
            limiter.record_failure(ip, now);
            PinCheck::Rejected
        }
    }

    pub fn set_server_error(&self, error: Option<String>) {
        *lock(&self.server_error) = error;
    }

    pub fn server_error(&self) -> Option<String> {
        lock(&self.server_error).clone()
    }

    /// URLs are only advertised while the server is meant to be reachable.
    pub fn summary(&self) -> RemoteSummary {
        let enabled = self.enabled();
        let port = self.port();
        let urls = if enabled && self.server_error().is_none() {
            crate::system::remote_urls(port)
        } else {
            Vec::new()
        };
        RemoteSummary {
            enabled,
            port,
            urls,
        }
    }
}

#[derive(Serialize)]
pub struct RemoteInfo {
    enabled: bool,
    port: u16,
    urls: Vec<String>,
    pin: String,
    /// Why the server is not reachable (e.g. port in use); `null` when fine.
    error: Option<String>,
}

#[tauri::command]
pub async fn remote_info(remote: State<'_, Arc<RemoteAuth>>) -> Result<RemoteInfo, String> {
    let summary = remote.summary();
    let error = if remote.enabled() {
        remote.server_error()
    } else {
        None
    };
    Ok(RemoteInfo {
        enabled: summary.enabled,
        port: summary.port,
        urls: summary.urls,
        pin: remote.pin(),
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::tests::TestDir;
    use std::net::Ipv4Addr;

    #[test]
    fn pin_rules() {
        assert!(is_valid_pin("000000"));
        assert!(is_valid_pin("123456789012"));
        assert!(!is_valid_pin("1234"));
        assert!(!is_valid_pin("12345"));
        assert!(!is_valid_pin("123"));
        assert!(!is_valid_pin("1234567890123"));
        assert!(!is_valid_pin("12a456"));
        assert!(!is_valid_pin(" 123456"));
        assert!(is_usable_stored_pin("1234"));
        assert!(!is_usable_stored_pin("123"));
        for _ in 0..50 {
            let pin = generate_pin();
            assert_eq!(pin.len(), 6);
            assert!(is_valid_pin(&pin));
        }
    }

    #[test]
    fn constant_time_compare() {
        assert!(constant_time_eq(b"123456", b"123456"));
        assert!(!constant_time_eq(b"123456", b"123457"));
        assert!(!constant_time_eq(b"123456", b"1234567"));
        assert!(!constant_time_eq(b"", b"1"));
    }

    #[test]
    fn limiter_blocks_after_five_failures_per_ip() {
        let mut limiter = LoginLimiter::default();
        let ip = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let other = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 21));
        let start = Instant::now();
        for i in 0..LOGIN_MAX_FAILURES {
            assert!(limiter.check(ip, start).is_ok(), "attempt {i}");
            limiter.record_failure(ip, start + Duration::from_secs(i as u64));
        }
        let wait = limiter
            .check(ip, start + Duration::from_secs(10))
            .unwrap_err();
        assert_eq!(wait, Duration::from_secs(290));
        assert!(limiter.check(other, start).is_ok());
        assert!(limiter
            .check(ip, start + LOGIN_WINDOW + Duration::from_secs(1))
            .is_ok());

        limiter.record_failure(other, start);
        limiter.reset(other);
        assert!(!limiter.failures.contains_key(&other));
    }

    #[test]
    fn many_addresses_hit_the_global_lockout_which_grows() {
        let mut limiter = LoginLimiter::default();
        let ip = |i: usize| IpAddr::V4(Ipv4Addr::new(10, 0, (i / 250) as u8, (i % 250) as u8));
        let start = Instant::now();
        let fail_from_many = |limiter: &mut LoginLimiter, at: Instant, first: usize| {
            for i in first..first + GLOBAL_MAX_FAILURES {
                assert!(limiter.check(ip(i), at).is_ok(), "attempt {i}");
                limiter.record_failure(ip(i), at);
            }
        };

        fail_from_many(&mut limiter, start, 0);
        let fresh = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 99));
        assert_eq!(limiter.check(fresh, start), Err(GLOBAL_LOCKOUT));
        let later = start + GLOBAL_LOCKOUT;
        assert!(limiter.check(fresh, later).is_ok());

        // The next wave within a day locks twice as long.
        fail_from_many(&mut limiter, later, 100);
        assert_eq!(limiter.check(fresh, later), Err(GLOBAL_LOCKOUT * 2));

        // A day without lockout starts over.
        let next_day = later + GLOBAL_STRIKE_RESET + GLOBAL_LOCKOUT * 2;
        fail_from_many(&mut limiter, next_day, 200);
        assert_eq!(limiter.check(fresh, next_day), Err(GLOBAL_LOCKOUT));
    }

    #[test]
    fn global_lockout_is_capped() {
        let mut limiter = LoginLimiter::default();
        let ip = IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1));
        let start = Instant::now();
        let mut last = start;
        for minute in 0..12 {
            last = start + Duration::from_secs(minute * 60);
            limiter.lock_all(last);
        }
        assert_eq!(limiter.strikes, 12);
        assert_eq!(limiter.check(ip, last), Err(GLOBAL_LOCKOUT_MAX));
    }

    #[test]
    fn pin_attempts_are_checked_and_counted_together() {
        let dir = TestDir::new("remote-attempts");
        let auth = RemoteAuth::load(&dir.0, EnvOverrides::default());
        let pin = auth.pin();
        let ip = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 30));
        let now = Instant::now();
        for _ in 0..LOGIN_MAX_FAILURES {
            assert_eq!(auth.attempt_pin(ip, "x", now), PinCheck::Rejected);
        }
        // Blocked before the PIN is even compared – the right one does not help either.
        assert!(matches!(
            auth.attempt_pin(ip, &pin, now),
            PinCheck::Blocked(_)
        ));
        let other = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 31));
        assert_eq!(auth.attempt_pin(other, &pin, now), PinCheck::Accepted);
    }

    #[test]
    fn config_is_created_private_and_reused() {
        let dir = TestDir::new("remote");
        let auth = RemoteAuth::load(&dir.0, EnvOverrides::default());
        assert!(auth.enabled());
        assert_eq!(auth.port(), DEFAULT_PORT);
        let pin = auth.pin();
        assert!(is_valid_pin(&pin));
        let mode = fs::metadata(dir.0.join(REMOTE_FILE))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);

        let again = RemoteAuth::load(&dir.0, EnvOverrides::default());
        assert_eq!(again.pin(), pin);
        assert!(again.verify_pin(&pin));
        assert!(!again.verify_pin("x"));

        again.change_pin("471147").unwrap();
        assert!(again.change_pin("12").is_err());
        assert_eq!(again.change_pin("4711").unwrap_err(), PIN_RULE_MESSAGE);
        assert_eq!(
            RemoteAuth::load(&dir.0, EnvOverrides::default()).pin(),
            "471147"
        );

        let overridden = RemoteAuth::load(
            &dir.0,
            EnvOverrides {
                port: Some(9000),
                disabled: true,
            },
        );
        assert_eq!(overridden.port(), 9000);
        assert!(!overridden.enabled());
        assert!(overridden.summary().urls.is_empty());
    }

    #[test]
    fn invalid_stored_pin_is_replaced() {
        let dir = TestDir::new("remote-bad");
        fs::write(
            dir.0.join(REMOTE_FILE),
            br#"{ "enabled": false, "port": 8080, "pin": "12" }"#,
        )
        .unwrap();
        let auth = RemoteAuth::load(&dir.0, EnvOverrides::default());
        assert!(!auth.enabled());
        assert_eq!(auth.port(), 8080);
        assert!(is_valid_pin(&auth.pin()));
    }

    #[test]
    fn short_pin_of_an_older_setup_is_kept() {
        let dir = TestDir::new("remote-legacy");
        fs::write(
            dir.0.join(REMOTE_FILE),
            br#"{ "enabled": true, "port": 7380, "pin": "4711" }"#,
        )
        .unwrap();
        let auth = RemoteAuth::load(&dir.0, EnvOverrides::default());
        assert_eq!(auth.pin(), "4711");
        assert!(auth.verify_pin("4711"));
    }

    #[test]
    fn sessions_lifecycle() {
        let dir = TestDir::new("sessions");
        let auth = RemoteAuth::load(&dir.0, EnvOverrides::default());
        let a = auth.create_session();
        let b = auth.create_session();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(auth.session_valid(&a) && auth.session_valid(&b));
        assert!(!auth.session_valid("deadbeef"));
        auth.end_other_sessions(&a);
        assert!(auth.session_valid(&a));
        assert!(!auth.session_valid(&b));
        auth.end_session(&a);
        assert!(!auth.session_valid(&a));
    }
}
