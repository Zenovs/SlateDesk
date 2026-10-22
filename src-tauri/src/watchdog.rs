//! systemd watchdog of the kiosk app. At start SlateDesk asks systemd for a watchdog
//! (`WATCHDOG_USEC`) and then confirms every few seconds that it lives – but only while the
//! kiosk page answers too (`kiosk_alive`, sent by the page every 15 s). If the page (WebKit) or
//! the backend hangs, the confirmations stop and systemd restarts SlateDesk.
//!
//! The unit only allows the notifications (`NotifyAccess=main`); the watchdog itself comes from
//! the app. A rollback to a version without this module is therefore never killed by it.

use crate::health::{self, Level};
use std::os::unix::net::UnixDatagram;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// systemd restarts SlateDesk when it has not confirmed for this long.
const TIMEOUT: Duration = Duration::from_secs(240);
const CONFIRM_EVERY: Duration = Duration::from_secs(20);
/// The page pings every 15 s; this long without a ping counts as hung. Generous: a page that
/// is not visible (display switched off) may get its timers throttled.
const PAGE_SILENT: Duration = Duration::from_secs(150);
/// Time for the page to load after the start.
const START_GRACE: Duration = Duration::from_secs(180);

static LAST_PING: Mutex<Option<Instant>> = Mutex::new(None);

fn last_ping() -> Option<Instant> {
    *LAST_PING.lock().unwrap_or_else(|p| p.into_inner())
}

/// The kiosk page lives (called by the page every 15 s).
#[tauri::command]
pub fn kiosk_alive() {
    *LAST_PING.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
}

/// `sd_notify` without libsystemd: one datagram to `$NOTIFY_SOCKET` (a path, or `@name` for
/// an abstract socket).
fn notify(socket: &str, message: &str) -> std::io::Result<()> {
    let sock = UnixDatagram::unbound()?;
    if let Some(name) = socket.strip_prefix('@') {
        use std::os::linux::net::SocketAddrExt;
        let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())?;
        sock.send_to_addr(message.as_bytes(), &addr)?;
    } else {
        sock.send_to(message.as_bytes(), socket)?;
    }
    Ok(())
}

fn page_alive(started: Instant, now: Instant, last_ping: Option<Instant>) -> bool {
    now.duration_since(started) < START_GRACE
        || last_ping.is_some_and(|ping| now.duration_since(ping) < PAGE_SILENT)
}

/// Confirmation loop, started once at app start; ends at once outside systemd.
pub async fn run() {
    let Some(socket) = std::env::var("NOTIFY_SOCKET")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        log::info!("Kein systemd-Watchdog (SlateDesk läuft nicht als Dienst mit NotifyAccess)");
        return;
    };
    let timeout = format!("WATCHDOG_USEC={}", TIMEOUT.as_micros());
    if let Err(e) = notify(&socket, &timeout) {
        log::warn!("systemd-Watchdog nicht eingerichtet: {e}");
        return;
    }
    log::info!("systemd-Watchdog aktiv ({} s)", TIMEOUT.as_secs());
    let started = Instant::now();
    let mut silent = false;
    loop {
        if page_alive(started, Instant::now(), last_ping()) {
            if let Err(e) = notify(&socket, "WATCHDOG=1") {
                log::warn!("systemd-Watchdog: {e}");
            }
            if silent {
                health::event(Level::Info, "Die Anzeige reagiert wieder");
                silent = false;
            }
        } else if !silent {
            silent = true;
            health::event(
                Level::Error,
                format!(
                    "Die Anzeige reagiert seit über {} s nicht – der Watchdog startet SlateDesk in spätestens {} s neu",
                    PAGE_SILENT.as_secs(),
                    TIMEOUT.as_secs()
                ),
            );
        }
        tokio::time::sleep(CONFIRM_EVERY).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_counts_as_alive_while_loading_and_while_it_pings() {
        let start = Instant::now();
        let at = |secs: u64| start + Duration::from_secs(secs);
        assert!(page_alive(start, at(60), None), "still loading");
        assert!(!page_alive(start, at(200), None), "never answered");
        assert!(page_alive(start, at(300), Some(at(200))));
        assert!(
            !page_alive(start, at(400), Some(at(200))),
            "silent for 200 s"
        );
    }

    #[test]
    fn notifications_reach_the_socket() {
        let path = std::env::temp_dir().join(format!("slatedesk-notify-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let server = UnixDatagram::bind(&path).unwrap();
        notify(path.to_str().unwrap(), "WATCHDOG=1").unwrap();
        let mut buf = [0u8; 64];
        let n = server.recv(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"WATCHDOG=1");
        let _ = std::fs::remove_file(&path);
    }
}
