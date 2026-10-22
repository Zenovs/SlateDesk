//! Mail over SMTP: the Host-Monitor's outage alerts and the test mail of the web UI.
//! Settings live in `state.mail`; the password never leaves Rust (`…password` is redacted
//! over HTTP and cleared there when `mail.host` changes, see state.rs).
//!
//! Alerts go through an outbox: the kiosk queues them (`mail_alert`) and a background task
//! sends them, retrying while the network or the mail server is away – an outage of the
//! router is exactly when the first attempt fails.

use lettre::message::header::ContentType;
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::error::Error as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

use crate::state::StateStore;

const DEFAULT_PORT: u16 = 587;
/// Implicit TLS (SMTPS); every other port uses STARTTLS – credentials never go out unencrypted.
const TLS_PORT: u16 = 465;
/// Per SMTP command (lettre); the whole delivery gets twice that.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const RETRY_EVERY: Duration = Duration::from_secs(60);
/// An alert that could not be sent for this long is no news any more.
const GIVE_UP_AFTER: Duration = Duration::from_secs(24 * 3600);
const MAX_QUEUED: usize = 50;
const MAX_SUBJECT_CHARS: usize = 200;
const MAX_BODY_CHARS: usize = 10_000;
const MAX_RECIPIENTS: usize = 10;
/// Display name of the sender when the address has none.
const SENDER_NAME: &str = "SlateDesk";
const TIMEOUT_MESSAGE: &str = "Der Mail-Server antwortet nicht (Zeitüberschreitung)";

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

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct MailConfig {
    host: String,
    port: u16,
    user: String,
    password: String,
    from: Mailbox,
    to: Vec<Mailbox>,
}

/// Host name or IPv4 address – no scheme, port or path.
fn valid_host(host: &str) -> bool {
    host.len() <= 253
        && !host.starts_with(['-', '.'])
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

fn recipients(text: &str) -> Result<Vec<Mailbox>, String> {
    let parts: Vec<&str> = text
        .split([',', ';'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return Err("Kein Empfänger eingetragen".to_string());
    }
    if parts.len() > MAX_RECIPIENTS {
        return Err(format!("Höchstens {MAX_RECIPIENTS} Empfänger"));
    }
    parts
        .into_iter()
        .map(|part| {
            part.parse::<Mailbox>()
                .map_err(|_| format!("Ungültige Empfänger-Adresse «{part}»"))
        })
        .collect()
}

impl MailConfig {
    /// Reads `state.mail` with the frontend's defaults (`src/state/defaults.ts`): a missing
    /// `enabled` means switched off, a missing `port` 587, an empty sender the user name.
    pub fn from_state(state: &Value, require_enabled: bool) -> Result<Self, String> {
        let mail = state.get("mail");
        let field = |name: &str| mail.and_then(|m| m.get(name));
        let text = |name: &str| {
            field(name)
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("")
        };
        if require_enabled && !field("enabled").and_then(Value::as_bool).unwrap_or(false) {
            return Err("Mail-Versand ist ausgeschaltet".to_string());
        }
        let host = text("host");
        if host.is_empty() {
            return Err("Kein Postausgangsserver eingetragen".to_string());
        }
        if !valid_host(host) {
            return Err(format!("Ungültiger Postausgangsserver «{host}»"));
        }
        let port = match field("port") {
            None | Some(Value::Null) => DEFAULT_PORT,
            Some(value) => value
                .as_u64()
                .and_then(|port| u16::try_from(port).ok())
                .filter(|port| *port > 0)
                .ok_or_else(|| "Ungültiger Port".to_string())?,
        };
        let user = text("user");
        let sender = if text("from").is_empty() {
            user
        } else {
            text("from")
        };
        if sender.is_empty() {
            return Err("Absender fehlt – Absender-Adresse oder Benutzer eintragen".to_string());
        }
        let mut from = sender
            .parse::<Mailbox>()
            .map_err(|_| format!("Ungültige Absender-Adresse «{sender}»"))?;
        if from.name.is_none() {
            from.name = Some(SENDER_NAME.to_string());
        }
        Ok(MailConfig {
            host: host.to_string(),
            port,
            user: user.to_string(),
            // Not trimmed: spaces may belong to a password.
            password: field("password")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            from,
            to: recipients(text("to"))?,
        })
    }

    fn recipient_list(&self) -> String {
        self.to
            .iter()
            .map(|mailbox| mailbox.email.to_string())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/// One line without control characters – a line break in a subject would start a header.
fn clean_subject(subject: &str) -> String {
    let flat: String = subject
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    flat.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_SUBJECT_CHARS)
        .collect()
}

fn clean_body(body: &str) -> String {
    body.replace("\r\n", "\n")
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(MAX_BODY_CHARS)
        .collect()
}

fn describe_error(e: &lettre::transport::smtp::Error) -> String {
    let detail = e.source().map(|source| source.to_string());
    if e.is_timeout() {
        return TIMEOUT_MESSAGE.to_string();
    }
    if e.is_tls() {
        return format!(
            "Verschlüsselte Verbindung fehlgeschlagen – Server und Port prüfen (587 oder 465){}",
            detail.map(|d| format!(": {d}")).unwrap_or_default()
        );
    }
    if let Some(code) = e.status() {
        let code = code.to_string();
        if matches!(code.as_str(), "534" | "535") {
            return "Anmeldung abgelehnt – Benutzer und Passwort prüfen".to_string();
        }
        // 530, or e.g. Hostpoint's 550 «You are not authenticated» when no user is set.
        if code == "530"
            || detail
                .as_deref()
                .is_some_and(|d| d.to_ascii_lowercase().contains("not authenticated"))
        {
            return "Der Mail-Server verlangt eine Anmeldung – Benutzer und Passwort eintragen"
                .to_string();
        }
        return format!(
            "Der Mail-Server lehnt ab ({code}){}",
            detail
                .map(|d| format!(": {}", d.trim()))
                .unwrap_or_default()
        );
    }
    match detail {
        Some(detail) => format!("Mail-Server nicht erreichbar: {detail}"),
        None => format!("Mail-Server nicht erreichbar: {e}"),
    }
}

pub async fn send(config: &MailConfig, subject: &str, body: &str) -> Result<(), String> {
    let mut builder = Message::builder()
        .from(config.from.clone())
        .subject(clean_subject(subject))
        .header(ContentType::TEXT_PLAIN);
    for to in &config.to {
        builder = builder.to(to.clone());
    }
    let message = builder
        .body(clean_body(body))
        .map_err(|e| format!("Mail konnte nicht erstellt werden: {e}"))?;
    let relay = if config.port == TLS_PORT {
        AsyncSmtpTransport::<Tokio1Executor>::relay(&config.host)
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host)
    }
    .map_err(|e| describe_error(&e))?
    .port(config.port)
    .timeout(Some(COMMAND_TIMEOUT));
    let relay = if config.user.is_empty() {
        relay
    } else {
        relay.credentials(Credentials::new(
            config.user.clone(),
            config.password.clone(),
        ))
    };
    let transport: AsyncSmtpTransport<Tokio1Executor> = relay.build();
    match tokio::time::timeout(COMMAND_TIMEOUT * 2, transport.send(message)).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(describe_error(&e)),
        Err(_) => Err(TIMEOUT_MESSAGE.to_string()),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct MailTestResult {
    pub ok: bool,
    pub message: String,
}

/// Test mail of the web UI with the stored settings; works before mail is switched on.
pub async fn send_test(state: &Value, kiosk_name: &str) -> MailTestResult {
    let config = match MailConfig::from_state(state, false) {
        Ok(config) => config,
        Err(message) => return MailTestResult { ok: false, message },
    };
    let body = format!(
        "Diese Test-Mail kommt vom SlateDesk-Bildschirm «{kiosk_name}».\n\n\
         Der Mail-Versand ist richtig eingerichtet: Fällt ein Host im Host-Monitor aus, \
         kommt eine Mail an diese Adresse – und eine zweite, sobald er wieder erreichbar ist."
    );
    match send(
        &config,
        &format!("SlateDesk: Test-Mail von «{kiosk_name}»"),
        &body,
    )
    .await
    {
        Ok(()) => {
            log::info!("Test-Mail gesendet");
            MailTestResult {
                ok: true,
                message: format!("Test-Mail an {} gesendet", config.recipient_list()),
            }
        }
        Err(message) => {
            log::warn!("Test-Mail nicht gesendet: {message}");
            MailTestResult { ok: false, message }
        }
    }
}

// ---------------------------------------------------------------------------
// Outbox
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailAttempt {
    /// Unix ms.
    pub at: u64,
    pub subject: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MailStatus {
    /// Alerts waiting for the next attempt.
    pub pending: usize,
    pub last: Option<MailAttempt>,
}

struct Queued {
    id: u64,
    subject: String,
    body: String,
    queued_at: SystemTime,
}

#[derive(Default)]
struct Outbox {
    queue: Mutex<VecDeque<Queued>>,
    last: Mutex<Option<MailAttempt>>,
    next_id: AtomicU64,
    wake: Notify,
}

static OUTBOX: LazyLock<Outbox> = LazyLock::new(Outbox::default);

impl Outbox {
    fn push(&self, subject: String, body: String) {
        let mut queue = lock(&self.queue);
        if queue.len() >= MAX_QUEUED {
            if let Some(old) = queue.pop_front() {
                log::warn!("Mail-Warteschlange voll – «{}» verworfen", old.subject);
            }
        }
        queue.push_back(Queued {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            subject,
            body,
            queued_at: SystemTime::now(),
        });
        drop(queue);
        self.wake.notify_one();
    }

    fn record(&self, subject: &str, result: &Result<(), String>) {
        *lock(&self.last) = Some(MailAttempt {
            at: now_ms(),
            subject: subject.to_string(),
            ok: result.is_ok(),
            error: result.as_ref().err().cloned(),
        });
    }

    fn status(&self) -> MailStatus {
        MailStatus {
            pending: lock(&self.queue).len(),
            last: lock(&self.last).clone(),
        }
    }

    /// The oldest alert that is still worth sending; older ones are dropped.
    fn next(&self) -> Option<(u64, String, String)> {
        let mut queue = lock(&self.queue);
        while let Some(front) = queue.front() {
            if front.queued_at.elapsed().unwrap_or_default() <= GIVE_UP_AFTER {
                return Some((front.id, front.subject.clone(), front.body.clone()));
            }
            log::warn!("Mail «{}» nach 24 Stunden verworfen", front.subject);
            queue.pop_front();
        }
        None
    }

    fn remove(&self, id: u64) {
        lock(&self.queue).retain(|queued| queued.id != id);
    }

    fn clear(&self) -> usize {
        let mut queue = lock(&self.queue);
        let count = queue.len();
        queue.clear();
        count
    }
}

/// Sends queued alerts in order until the queue is empty or one fails (the rest waits for
/// the next attempt). Switched off or not set up: the alerts are dropped – nobody wants a
/// pile of old outages once mail is configured.
async fn deliver(outbox: &Outbox, config: impl Fn() -> Result<MailConfig, String>) {
    while let Some((id, subject, body)) = outbox.next() {
        let config = match config() {
            Ok(config) => config,
            Err(reason) => {
                let dropped = outbox.clear();
                log::info!("{dropped} Mail(s) nicht gesendet: {reason}");
                outbox.record(&subject, &Err(reason));
                return;
            }
        };
        let result = send(&config, &subject, &body).await;
        outbox.record(&subject, &result);
        match result {
            Ok(()) => {
                log::info!("Mail gesendet: {subject}");
                outbox.remove(id);
            }
            Err(e) => {
                log::warn!("Mail «{subject}» nicht gesendet, neuer Versuch in einer Minute: {e}");
                return;
            }
        }
    }
}

/// Background task of the outbox, started once at app start.
pub async fn run_outbox(store: Arc<StateStore>) {
    loop {
        deliver(&OUTBOX, || {
            MailConfig::from_state(&store.snapshot().state, true)
        })
        .await;
        // A new alert wakes the task right away (a notification while sending is kept).
        let _ = tokio::time::timeout(RETRY_EVERY, OUTBOX.wake.notified()).await;
    }
}

pub fn status() -> MailStatus {
    OUTBOX.status()
}

/// Queues an alert of the kiosk (Host-Monitor); [`run_outbox`] sends it.
#[tauri::command]
pub fn mail_alert(subject: String, body: String) -> Result<(), String> {
    let subject = clean_subject(&subject);
    if subject.is_empty() {
        return Err("Betreff fehlt".to_string());
    }
    OUTBOX.push(subject, clean_body(&body));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(mail: Value) -> Result<MailConfig, String> {
        MailConfig::from_state(&json!({ "mail": mail }), true)
    }

    #[test]
    fn settings_need_server_sender_and_recipient() {
        assert_eq!(
            MailConfig::from_state(&json!({}), false).unwrap_err(),
            "Kein Postausgangsserver eingetragen"
        );
        assert_eq!(
            config(json!({ "host": "smtp.example.ch", "to": "a@example.ch" })).unwrap_err(),
            "Mail-Versand ist ausgeschaltet"
        );
        assert_eq!(
            config(json!({ "enabled": true, "host": "smtp.example.ch", "to": "a@example.ch" }))
                .unwrap_err(),
            "Absender fehlt – Absender-Adresse oder Benutzer eintragen"
        );
        assert_eq!(
            config(json!({ "enabled": true, "host": "smtp.example.ch", "user": "me@example.ch" }))
                .unwrap_err(),
            "Kein Empfänger eingetragen"
        );
        for host in [
            "https://smtp.example.ch",
            "smtp.example.ch:587",
            "-x",
            "smtp example",
        ] {
            assert!(
                config(json!({ "enabled": true, "host": host, "user": "me@example.ch", "to": "a@example.ch" }))
                    .unwrap_err()
                    .starts_with("Ungültiger Postausgangsserver"),
                "{host}"
            );
        }
    }

    #[test]
    fn settings_apply_the_frontend_defaults() {
        let config = config(json!({
            "enabled": true,
            "host": " asmtp.mail.hostpoint.ch ",
            "user": "info@example.ch",
            "password": " geheim ",
            "to": "dario@example.ch; Team <team@example.ch>,",
        }))
        .unwrap();
        assert_eq!(config.host, "asmtp.mail.hostpoint.ch");
        assert_eq!(config.port, 587);
        assert_eq!(config.password, " geheim ");
        assert_eq!(config.from.to_string(), "SlateDesk <info@example.ch>");
        assert_eq!(config.recipient_list(), "dario@example.ch, team@example.ch");
    }

    #[test]
    fn invalid_addresses_and_ports_are_named() {
        let base = json!({ "enabled": true, "host": "smtp.example.ch", "user": "me@example.ch", "to": "a@example.ch" });
        let with = |key: &str, value: Value| {
            let mut mail = base.clone();
            mail[key] = value;
            config(mail).unwrap_err()
        };
        assert_eq!(
            with("to", json!("a@example.ch, kaputt")),
            "Ungültige Empfänger-Adresse «kaputt»"
        );
        assert_eq!(
            with("from", json!("niemand")),
            "Ungültige Absender-Adresse «niemand»"
        );
        assert_eq!(with("port", json!(70000)), "Ungültiger Port");
        assert_eq!(with("port", json!(0)), "Ungültiger Port");
        let mut named = base.clone();
        named["from"] = json!("Büro <buero@example.ch>");
        named["port"] = json!(465);
        let named = config(named).unwrap();
        assert_eq!(named.port, 465);
        assert_eq!(named.from.name.as_deref(), Some("Büro"));
    }

    #[test]
    fn subject_is_one_line_and_body_keeps_its_lines() {
        assert_eq!(
            clean_subject(" NAS\r\nBcc: x@y \t nicht erreichbar "),
            "NAS Bcc: x@y nicht erreichbar"
        );
        assert_eq!(clean_subject(&"x".repeat(500)).len(), MAX_SUBJECT_CHARS);
        assert_eq!(clean_body("a\r\nb\u{0}\tc\n"), "a\nb\tc\n");
        assert!(mail_alert(" \n ".to_string(), String::new()).is_err());
    }

    #[test]
    fn outbox_keeps_the_newest_alerts() {
        let outbox = Outbox::default();
        for i in 0..MAX_QUEUED + 2 {
            outbox.push(format!("Meldung {i}"), String::new());
        }
        assert_eq!(outbox.status().pending, MAX_QUEUED);
        let (id, subject, _) = outbox.next().unwrap();
        assert_eq!(subject, "Meldung 2");
        outbox.remove(id);
        assert_eq!(outbox.next().unwrap().1, "Meldung 3");
    }

    #[tokio::test]
    async fn outbox_drops_alerts_while_mail_is_not_set_up() {
        let outbox = Outbox::default();
        outbox.push("NAS nicht erreichbar".to_string(), "Text".to_string());
        outbox.push("NAS wieder erreichbar".to_string(), "Text".to_string());
        deliver(
            &outbox,
            || Err("Mail-Versand ist ausgeschaltet".to_string()),
        )
        .await;
        let status = outbox.status();
        assert_eq!(status.pending, 0);
        let last = status.last.unwrap();
        assert_eq!(last.subject, "NAS nicht erreichbar");
        assert!(!last.ok);
        assert_eq!(
            last.error.as_deref(),
            Some("Mail-Versand ist ausgeschaltet")
        );
    }

    #[tokio::test]
    async fn test_mail_reports_missing_settings() {
        assert_eq!(
            send_test(&json!({ "mail": { "enabled": false } }), "Büro").await,
            MailTestResult {
                ok: false,
                message: "Kein Postausgangsserver eingetragen".to_string()
            }
        );
    }
}
