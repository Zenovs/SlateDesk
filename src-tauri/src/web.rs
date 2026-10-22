//! Embedded web server for the Fernsteuerung: JSON API, SSE and the web UI, PIN-protected,
//! served by axum on Tauri's tokio runtime. Tauri-specific bits (assets, kiosk actions) sit
//! behind [`KioskHost`] so the router can be tested without a running app.

use crate::fans::{FanService, FanSetting};
use crate::http::ProxyResponse;
use crate::lagra::{LagraError, LagraService};
use crate::planbar::{PlanbarError, PlanbarService};
use crate::remote::{PinCheck, RemoteAuth, PIN_RULE_MESSAGE, SESSION_COOKIE, SESSION_MAX_AGE};
use crate::state::{redact, redacted_event_json, StateError, StateOp, StateStore};
use crate::system::{self, SystemContext};
use axum::body::{Body, Bytes};
use axum::extract::{
    ConnectInfo, DefaultBodyLimit, Path as UrlPath, Query, RawQuery, Request, State,
};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use futures_util::future::{self, BoxFuture};
use futures_util::stream::{self, StreamExt};
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;
use tower::{Service, ServiceExt};

/// CSP of the web UI (the kiosk CSP from tauri.conf.json is not used here). Vite inlines
/// small font files (the Lato `latin-ext` woff fallbacks) as `data:` URLs.
pub const WEB_CSP: &str = "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'";
/// lagra/planbar answers passed through the proxy are data, never a document of the web UI.
const PROXY_CSP: &str = "sandbox; default-src 'none'";
const REMOTE_ENTRY: &str = "remote.html";
const KIOSK_ENTRY: &str = "index.html";
const CSRF_HEADER: &str = "x-slatedesk";
const UPSTREAM_HEADER: &str = "x-slatedesk-upstream";
/// Selects the planbar Unternehmen (id in `planbar.unternehmen`) of a `/api/planbar/…` call.
const PLANBAR_ORG_HEADER: &str = "x-slatedesk-planbar-org";
const SSE_PING: Duration = Duration::from_secs(20);
const BODY_LIMIT: usize = 4 * 1024 * 1024;
/// `{ "pin": … }` / `{ "current": …, "next": … }` – login is reachable without a session.
const AUTH_BODY_LIMIT: usize = 1024;
/// Reading a login or PIN change (body included) must not hold a connection longer.
const AUTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Open connections at once – the server shares the kiosk process and its file descriptors.
const MAX_CONNECTIONS: usize = 256;
/// A client must send a complete request head within this time (also on idle keep-alive).
const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(30);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(250);
/// Host names that only resolve inside the LAN (mDNS, router DNS, reserved names). DNS
/// rebinding needs a public name, so these, IP literals and single-label names are safe.
const LAN_HOST_SUFFIXES: [&str; 6] = [
    ".local",
    ".lan",
    ".home.arpa",
    ".internal",
    ".localdomain",
    ".localhost",
];
/// Extra host names the web UI is reached under (comma-separated), e.g. a DNS name set up
/// for the kiosk.
const HOSTS_ENV: &str = "SLATEDESK_REMOTE_HOSTS";
const ASSET_CACHE_BUDGET: usize = 64 * 1024 * 1024;
const BIND_ATTEMPTS: u32 = 15;
const BIND_RETRY: Duration = Duration::from_secs(2);
const DEV_PAGE: &str = "<!doctype html><html lang=\"de\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>SlateDesk Fernsteuerung</title></head>\
<body style=\"font-family:system-ui,sans-serif;margin:2rem;line-height:1.5\">\
<h1>SlateDesk Fernsteuerung</h1>\
<p>Dev-Modus: Web-UI unter <a href=\"http://localhost:5173/remote.html\">http://localhost:5173/remote.html</a></p>\
</body></html>";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KioskAction {
    Reload,
    Identify,
    EditMode,
    Restart,
    DisplaySleep,
    DisplayWake,
    UpdateCheck,
    UpdateRun,
}

impl KioskAction {
    pub const ALL: [KioskAction; 8] = [
        KioskAction::Reload,
        KioskAction::Identify,
        KioskAction::EditMode,
        KioskAction::Restart,
        KioskAction::DisplaySleep,
        KioskAction::DisplayWake,
        KioskAction::UpdateCheck,
        KioskAction::UpdateRun,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            KioskAction::Reload => "reload",
            KioskAction::Identify => "identify",
            KioskAction::EditMode => "edit-mode",
            KioskAction::Restart => "restart",
            KioskAction::DisplaySleep => "display-sleep",
            KioskAction::DisplayWake => "display-wake",
            KioskAction::UpdateCheck => "update-check",
            KioskAction::UpdateRun => "update-run",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|a| a.as_str() == name)
    }
}

pub struct WebAsset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

pub trait KioskHost: Send + Sync + 'static {
    /// Lookup in the app's asset resolver – which answers unknown paths with index.html.
    fn asset(&self, path: &str) -> Option<WebAsset>;
    /// Runs a web UI action on the kiosk; `Ok(Some(_))` becomes `result` in the response.
    fn perform(
        &self,
        action: KioskAction,
        value: Option<Value>,
    ) -> BoxFuture<'static, Result<Option<Value>, String>>;
}

struct CachedAsset {
    bytes: Bytes,
    mime_type: String,
}

#[derive(Default)]
struct AssetCache {
    entries: HashMap<String, Arc<CachedAsset>>,
    bytes: usize,
}

pub struct WebContext {
    pub store: Arc<StateStore>,
    pub remote: Arc<RemoteAuth>,
    pub system: Arc<SystemContext>,
    pub lagra: Arc<LagraService>,
    pub planbar: Arc<PlanbarService>,
    pub fans: Arc<FanService>,
    pub host: Arc<dyn KioskHost>,
    assets: Mutex<AssetCache>,
    /// Public-looking host names accepted besides LAN names: the machine's hostname and
    /// [`HOSTS_ENV`].
    extra_hosts: Vec<String>,
}

pub type WebState = Arc<WebContext>;

impl WebContext {
    pub fn new(
        store: Arc<StateStore>,
        remote: Arc<RemoteAuth>,
        system: Arc<SystemContext>,
        lagra: Arc<LagraService>,
        planbar: Arc<PlanbarService>,
        fans: Arc<FanService>,
        host: Arc<dyn KioskHost>,
    ) -> WebState {
        Arc::new(WebContext {
            store,
            remote,
            system,
            lagra,
            planbar,
            fans,
            host,
            assets: Mutex::new(AssetCache::default()),
            extra_hosts: configured_hosts(),
        })
    }

    fn asset_cache(&self) -> MutexGuard<'_, AssetCache> {
        self.assets.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[derive(Clone)]
struct Session(String);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

fn ok_response() -> Response {
    Json(json!({ "ok": true })).into_response()
}

/// `{ "error": "<German>" }` with a status – the error side of every API handler.
#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        error_response(self.status, self.message)
    }
}

impl From<StateError> for ApiError {
    fn from(error: StateError) -> Self {
        let status = match error {
            StateError::Invalid(_) => StatusCode::BAD_REQUEST,
            StateError::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        ApiError::new(status, error.to_string())
    }
}

type ApiResult = Result<Response, ApiError>;

fn parse_body<T: DeserializeOwned>(body: &Bytes) -> Result<T, ApiError> {
    serde_json::from_slice(body)
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, format!("Ungültige Anfrage: {e}")))
}

fn lagra_error_status(error: &LagraError) -> StatusCode {
    match error {
        LagraError::NotConfigured | LagraError::InvalidBaseUrl => StatusCode::SERVICE_UNAVAILABLE,
        LagraError::InvalidPath(_) | LagraError::ForeignImage => StatusCode::BAD_REQUEST,
        LagraError::NotAllowed(_) => StatusCode::FORBIDDEN,
        _ => StatusCode::BAD_GATEWAY,
    }
}

/// Only SlateDesk's own planbar errors land here – planbar's answers are passed through.
fn planbar_error_status(error: &PlanbarError) -> StatusCode {
    match error {
        PlanbarError::NotConfigured | PlanbarError::InvalidBaseUrl => {
            StatusCode::SERVICE_UNAVAILABLE
        }
        PlanbarError::OrgNotConfigured(_) => StatusCode::SERVICE_UNAVAILABLE,
        PlanbarError::InvalidPath(_)
        | PlanbarError::WriteNotAllowed
        | PlanbarError::InvalidBody
        | PlanbarError::OrgRequired => StatusCode::BAD_REQUEST,
        PlanbarError::ReadNotAllowed(_) => StatusCode::FORBIDDEN,
        _ => StatusCode::BAD_GATEWAY,
    }
}

/// An upstream answer passed through to the web UI. `X-SlateDesk-Upstream` tells it that a
/// 401 is about the service's token/key, not its own session, and that an `{ error }` body is
/// the service's text, not SlateDesk's.
fn upstream_response(upstream: ProxyResponse, source: &'static str) -> Response {
    let status = StatusCode::from_u16(upstream.status).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut res = Response::new(Body::from(upstream.body));
    *res.status_mut() = status;
    let headers = res.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&upstream.content_type) {
        if !upstream.content_type.is_empty() {
            headers.insert(header::CONTENT_TYPE, value);
        }
    }
    let cache = upstream
        .cache_control
        .unwrap_or_else(|| "no-store".to_string());
    if let Ok(value) = HeaderValue::from_str(&cache) {
        headers.insert(header::CACHE_CONTROL, value);
    }
    headers.insert(UPSTREAM_HEADER, HeaderValue::from_static(source));
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PROXY_CSP),
    );
    res
}

fn session_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, value)| {
            *name == SESSION_COOKIE
                && value.len() == 64
                && value.bytes().all(|b| b.is_ascii_hexdigit())
        })
        .map(|(_, value)| value.to_string())
}

fn session_cookie(token: &str, max_age: u64) -> HeaderValue {
    let cookie =
        format!("{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age}");
    HeaderValue::from_str(&cookie).unwrap_or_else(|_| HeaderValue::from_static(""))
}

fn kiosk_name(store: &StateStore) -> String {
    store
        .snapshot()
        .state
        .pointer("/kiosk/name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("SlateDesk")
        .to_string()
}

fn configured_hosts() -> Vec<String> {
    let hostname = ["/proc/sys/kernel/hostname", "/etc/hostname"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let extra = std::env::var(HOSTS_ENV).unwrap_or_default();
    std::iter::once(hostname.as_str())
        .chain(extra.split(','))
        .map(|h| h.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .collect()
}

/// `Host` values the server answers: IP literals, single-label and LAN names, and the
/// configured names (port ignored). A page of a public domain rebound to the kiosk's IP
/// (DNS rebinding) is refused, so it can never use the API with the browser's help.
fn host_allowed(value: &str, extra_hosts: &[String]) -> bool {
    let Ok(authority) = value.trim().parse::<axum::http::uri::Authority>() else {
        return false;
    };
    let host = authority.host().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    bare.parse::<IpAddr>().is_ok()
        || !host.contains('.')
        || LAN_HOST_SUFFIXES
            .iter()
            .any(|suffix| host.ends_with(suffix))
        || extra_hosts.contains(&host)
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

async fn security_headers(req: Request, next: Next) -> Response {
    let is_api = req.uri().path().starts_with("/api");
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    // The proxy sets its own, stricter policy.
    headers
        .entry(header::CONTENT_SECURITY_POLICY)
        .or_insert(HeaderValue::from_static(WEB_CSP));
    if is_api && !headers.contains_key(header::CACHE_CONTROL) {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    res
}

/// Refuses requests for a host name that is not the kiosk's (see [`host_allowed`]). Browsers
/// always send `Host`; a request without one comes from no web page.
async fn host_guard(State(ctx): State<WebState>, req: Request, next: Next) -> Response {
    let host = req.headers().get(header::HOST).map(HeaderValue::to_str);
    match host {
        None => next.run(req).await,
        Some(Ok(value)) if host_allowed(value, &ctx.extra_hosts) => next.run(req).await,
        Some(_) => error_response(
            StatusCode::MISDIRECTED_REQUEST,
            "Unbekannte Adresse – die Fernsteuerung über die IP-Adresse des Kiosks öffnen",
        ),
    }
}

/// Login and PIN change: a client that trickles its (tiny) body loses the connection.
async fn auth_deadline(req: Request, next: Next) -> Response {
    match tokio::time::timeout(AUTH_REQUEST_TIMEOUT, next.run(req)).await {
        Ok(res) => res,
        Err(_) => error_response(
            StatusCode::REQUEST_TIMEOUT,
            "Zeitüberschreitung der Anfrage",
        ),
    }
}

/// CSRF header for every mutating API call (forces a CORS preflight that is never answered),
/// then the session cookie for everything but health, status and login/logout.
async fn api_guard(State(ctx): State<WebState>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    if path != "/api" && !path.starts_with("/api/") {
        return next.run(req).await;
    }
    let safe_method = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if !safe_method && req.headers().get(CSRF_HEADER).map(HeaderValue::as_bytes) != Some(b"1") {
        return error_response(
            StatusCode::FORBIDDEN,
            "Anfrage abgelehnt (X-SlateDesk-Header fehlt)",
        );
    }
    let session = session_token(req.headers()).filter(|t| ctx.remote.session_valid(t));
    let public = matches!(
        path.as_str(),
        "/api/health" | "/api/auth/status" | "/api/auth/login" | "/api/auth/logout"
    );
    match session {
        Some(token) => {
            req.extensions_mut().insert(Session(token));
        }
        None if !public => return error_response(StatusCode::UNAUTHORIZED, "Nicht angemeldet"),
        None => {}
    }
    next.run(req).await
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

/// Public: the web UI also uses `commit` to notice that the kiosk now runs a
/// newer build than the page was loaded from (and reloads itself).
async fn health() -> Response {
    Json(json!({ "ok": true, "version": system::VERSION, "commit": system::commit() }))
        .into_response()
}

async fn auth_status(State(ctx): State<WebState>, session: Option<Extension<Session>>) -> Response {
    Json(json!({ "authenticated": session.is_some(), "name": kiosk_name(&ctx.store) }))
        .into_response()
}

fn pin_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    }
}

fn too_many_attempts(retry_after: Duration) -> Response {
    let minutes = retry_after.as_secs().div_ceil(60).max(1);
    let mut res = error_response(
        StatusCode::TOO_MANY_REQUESTS,
        format!("Zu viele Fehlversuche – bitte in {minutes} Min. erneut versuchen"),
    );
    if let Ok(value) = HeaderValue::from_str(&retry_after.as_secs().max(1).to_string()) {
        res.headers_mut().insert(header::RETRY_AFTER, value);
    }
    res
}

#[derive(Deserialize)]
struct LoginBody {
    pin: Value,
}

async fn login(
    State(ctx): State<WebState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> ApiResult {
    let ip = peer.ip().to_canonical();
    let body: LoginBody = parse_body(&body)?;
    match ctx
        .remote
        .attempt_pin(ip, &pin_text(&body.pin), Instant::now())
    {
        PinCheck::Accepted => {}
        PinCheck::Blocked(retry_after) => return Ok(too_many_attempts(retry_after)),
        PinCheck::Rejected => {
            log::warn!("Fernsteuerung: falscher PIN von {ip}");
            return Err(ApiError::new(StatusCode::UNAUTHORIZED, "Falscher PIN"));
        }
    }
    let token = ctx.remote.create_session();
    let mut res = ok_response();
    res.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie(&token, SESSION_MAX_AGE.as_secs()),
    );
    Ok(res)
}

async fn logout(State(ctx): State<WebState>, session: Option<Extension<Session>>) -> Response {
    if let Some(Extension(Session(token))) = session {
        ctx.remote.end_session(&token);
    }
    let mut res = ok_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, session_cookie("", 0));
    res
}

#[derive(Deserialize)]
struct PinChangeBody {
    current: Value,
    next: Value,
}

async fn change_pin(
    State(ctx): State<WebState>,
    Extension(Session(token)): Extension<Session>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> ApiResult {
    let ip = peer.ip().to_canonical();
    let body: PinChangeBody = parse_body(&body)?;
    match ctx
        .remote
        .attempt_pin(ip, &pin_text(&body.current), Instant::now())
    {
        PinCheck::Accepted => {}
        PinCheck::Blocked(retry_after) => return Ok(too_many_attempts(retry_after)),
        PinCheck::Rejected => {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "Der aktuelle PIN ist falsch",
            ))
        }
    }
    let next = pin_text(&body.next);
    if !crate::remote::is_valid_pin(&next) {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, PIN_RULE_MESSAGE));
    }
    ctx.remote
        .change_pin(&next)
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    ctx.remote.end_other_sessions(&token);
    log::info!("Fernsteuerung: PIN geändert von {ip}");
    Ok(ok_response())
}

async fn get_state(State(ctx): State<WebState>) -> Response {
    let snapshot = ctx.store.snapshot();
    Json(json!({ "rev": snapshot.rev, "state": redact(&snapshot.state) })).into_response()
}

#[derive(Deserialize)]
struct OpsBody {
    ops: Vec<StateOp>,
}

async fn post_ops(State(ctx): State<WebState>, body: Bytes) -> ApiResult {
    let body: OpsBody = parse_body(&body)?;
    let rev = ctx.store.apply_ops(body.ops, "remote", true).await?;
    Ok(Json(json!({ "rev": rev })).into_response())
}

fn state_event(rev: u64, json: &str) -> Event {
    Event::default()
        .event("state")
        .id(rev.to_string())
        .data(json)
}

/// Starts with the current state (origin "sync") so a reconnecting client converges; a
/// lagging client gets the current state instead of the dropped events. The stream ends
/// with the session (logout, PIN change).
async fn events(
    State(ctx): State<WebState>,
    Extension(Session(token)): Extension<Session>,
) -> Response {
    let receiver = ctx.store.subscribe();
    let snapshot = ctx.store.snapshot();
    let initial = state_event(
        snapshot.rev,
        &redacted_event_json(snapshot.rev, &snapshot.state, "sync"),
    );

    let store = Arc::clone(&ctx.store);
    let updates = BroadcastStream::new(receiver).map(move |item| match item {
        Ok(event) => state_event(event.rev, &event.json),
        Err(BroadcastStreamRecvError::Lagged(_)) => {
            let current = store.snapshot();
            state_event(
                current.rev,
                &redacted_event_json(current.rev, &current.state, "sync"),
            )
        }
    });
    let remote = Arc::clone(&ctx.remote);
    let stream = stream::once(future::ready(initial))
        .chain(updates)
        .take_while(move |_| future::ready(remote.session_valid(&token)))
        .map(Ok::<Event, Infallible>);

    Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(SSE_PING)
                .event(Event::default().event("ping").data("{}")),
        )
        .into_response()
}

async fn system_info(State(ctx): State<WebState>) -> Response {
    Json(system::collect(&ctx.system, ctx.remote.summary()).await).into_response()
}

/// The body is the action value; `{ "value": x }` is unwrapped to `x`.
fn action_value(body: &Bytes) -> Result<Option<Value>, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let value: Value = parse_body(body)?;
    Ok(Some(match value {
        Value::Object(mut map) if map.len() == 1 && map.contains_key("value") => {
            map.remove("value").unwrap_or(Value::Null)
        }
        other => other,
    }))
}

async fn run_action(
    State(ctx): State<WebState>,
    UrlPath(name): UrlPath<String>,
    body: Bytes,
) -> ApiResult {
    let action = KioskAction::parse(&name).ok_or_else(|| {
        ApiError::new(StatusCode::NOT_FOUND, format!("Unbekannte Aktion: {name}"))
    })?;
    let value = action_value(&body)?;
    log::info!("Fernsteuerung: Aktion {}", action.as_str());
    let result = ctx
        .host
        .perform(action, value)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(match result {
        Some(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        None => ok_response(),
    })
}

async fn update_progress() -> Response {
    Json(crate::update::progress().await).into_response()
}

async fn lagra_proxy(
    State(ctx): State<WebState>,
    UrlPath(path): UrlPath<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let snapshot = ctx.store.snapshot();
    match ctx
        .lagra
        .proxy_get(&snapshot.state, &path, query.as_deref())
        .await
    {
        Ok(upstream) => upstream_response(upstream, "lagra"),
        Err(e) => ApiError::new(lagra_error_status(&e), e.to_string()).into_response(),
    }
}

async fn lagra_test(State(ctx): State<WebState>) -> Response {
    let snapshot = ctx.store.snapshot();
    Json(ctx.lagra.test(&snapshot.state).await).into_response()
}

/// Sends a test mail with the stored settings (they may still be switched off).
async fn mail_test(State(ctx): State<WebState>) -> Response {
    let snapshot = ctx.store.snapshot();
    let name = kiosk_name(&ctx.store);
    Json(crate::mail::send_test(&snapshot.state, &name).await).into_response()
}

/// Waiting alerts and the last delivery attempt.
async fn mail_status() -> Response {
    Json(crate::mail::status()).into_response()
}

/// Fans with speed, PWM duty and their setting (sysfs reads, off the async threads).
async fn fans_report(State(ctx): State<WebState>) -> Response {
    let fans = Arc::clone(&ctx.fans);
    match tokio::task::spawn_blocking(move || fans.report(system::read_cpu_temp())).await {
        Ok(report) => Json(report).into_response(),
        Err(e) => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct FanUpdate {
    id: String,
    setting: FanSetting,
}

/// `{ "id": …, "setting": { "mode": "auto" | "fixed" | "curve", … } }` – applied at once.
async fn fans_update(State(ctx): State<WebState>, body: Bytes) -> ApiResult {
    let update: FanUpdate = parse_body(&body)?;
    let fans = Arc::clone(&ctx.fans);
    let result = tokio::task::spawn_blocking(move || {
        let temp = system::read_cpu_temp();
        fans.set(&update.id, update.setting, temp)
            .map(|()| fans.report(temp))
    })
    .await
    .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    match result {
        Ok(report) => Ok(Json(report).into_response()),
        Err(message) => Err(ApiError::new(StatusCode::BAD_REQUEST, message)),
    }
}

/// The Unternehmen named by [`PLANBAR_ORG_HEADER`]; an unreadable value names none that
/// exists (planbar.rs answers «nicht eingerichtet»).
fn planbar_org(headers: &HeaderMap) -> Option<String> {
    headers
        .get(PLANBAR_ORG_HEADER)
        .map(|value| value.to_str().unwrap_or("?").trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn planbar_proxy_get(
    State(ctx): State<WebState>,
    UrlPath(path): UrlPath<String>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
) -> Response {
    let snapshot = ctx.store.snapshot();
    let org = planbar_org(&headers);
    match ctx
        .planbar
        .proxy_get(&snapshot.state, &path, query.as_deref(), org.as_deref())
        .await
    {
        Ok(upstream) => upstream_response(upstream, "planbar"),
        Err(e) => ApiError::new(planbar_error_status(&e), e.to_string()).into_response(),
    }
}

/// `PATCH /api/planbar/arbeitsliste/{id}` – ticks off a task; planbar.rs rejects every other
/// path and body.
async fn planbar_proxy_patch(
    State(ctx): State<WebState>,
    UrlPath(path): UrlPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let snapshot = ctx.store.snapshot();
    let org = planbar_org(&headers);
    match ctx
        .planbar
        .proxy_patch(&snapshot.state, &path, &body, org.as_deref())
        .await
    {
        Ok(upstream) => {
            if (200..300).contains(&upstream.status) {
                log::info!("Fernsteuerung: planbar-Aufgabe geändert");
            }
            upstream_response(upstream, "planbar")
        }
        Err(e) => ApiError::new(planbar_error_status(&e), e.to_string()).into_response(),
    }
}

#[derive(Deserialize)]
struct PlanbarTestQuery {
    org: Option<String>,
}

/// `?org=<id>` tests one Unternehmen, without it every one with a key.
async fn planbar_test(
    State(ctx): State<WebState>,
    Query(query): Query<PlanbarTestQuery>,
) -> Response {
    let snapshot = ctx.store.snapshot();
    Json(
        ctx.planbar
            .test(&snapshot.state, query.org.as_deref())
            .await,
    )
    .into_response()
}

async fn export_state(State(ctx): State<WebState>) -> Response {
    let snapshot = ctx.store.snapshot();
    let document = json!({
        "rev": snapshot.rev,
        "exportedAt": unix_ms(),
        "state": redact(&snapshot.state),
    });
    let body = serde_json::to_vec_pretty(&document).unwrap_or_default();
    (
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=slatedesk-state.json",
            ),
        ],
        body,
    )
        .into_response()
}

#[derive(Deserialize)]
struct ImportBody {
    state: Value,
}

async fn import_state(State(ctx): State<WebState>, body: Bytes) -> ApiResult {
    let body: ImportBody = parse_body(&body)?;
    let ops = vec![StateOp::Set {
        path: Vec::new(),
        value: body.state,
    }];
    let rev = ctx.store.apply_ops(ops, "remote", true).await?;
    log::info!("Fernsteuerung: Zustand importiert (rev {rev})");
    Ok(Json(json!({ "rev": rev })).into_response())
}

async fn api_not_found() -> Response {
    error_response(StatusCode::NOT_FOUND, "Unbekannter Endpunkt")
}

async fn api_method_not_allowed() -> Response {
    error_response(StatusCode::METHOD_NOT_ALLOWED, "Methode nicht erlaubt")
}

// ---------------------------------------------------------------------------
// Static web UI
// ---------------------------------------------------------------------------

fn looks_like_html(bytes: &[u8]) -> bool {
    let start = bytes.trim_ascii_start();
    let head = &start[..start.len().min(16)];
    let lower = head.to_ascii_lowercase();
    lower.starts_with(b"<!doctype html") || lower.starts_with(b"<html")
}

/// Tauri injects fresh CSP nonces (digits) into every HTML it returns, so two answers for
/// index.html only agree once the digits are ignored.
fn same_ignoring_digits(a: &[u8], b: &[u8]) -> bool {
    a.iter()
        .filter(|c| !c.is_ascii_digit())
        .eq(b.iter().filter(|c| !c.is_ascii_digit()))
}

fn is_safe_asset_path(path: &str) -> bool {
    !path.contains("..")
        && !path.contains("//")
        && !path.contains('\\')
        && !path.contains('%')
        && !path.chars().any(char::is_control)
}

impl WebContext {
    /// Resolves `path` and rejects the resolver's index.html fallback, so the kiosk page is
    /// never served as the web UI and missing files are real 404s. Release assets are
    /// decompressed on every resolver call, so non-HTML files are kept in memory; HTML stays
    /// uncached because it is small and must follow a rebuilt dist in dev mode.
    fn lookup_asset(&self, path: &str) -> Option<Arc<CachedAsset>> {
        if path == KIOSK_ENTRY {
            return None;
        }
        if let Some(hit) = self.asset_cache().entries.get(path) {
            return Some(Arc::clone(hit));
        }
        let asset = self.host.asset(path)?;
        let is_html = looks_like_html(&asset.bytes);
        if is_html {
            if let Some(index) = self.host.asset(KIOSK_ENTRY) {
                if same_ignoring_digits(&index.bytes, &asset.bytes) {
                    return None;
                }
            }
        }
        let cached = Arc::new(CachedAsset {
            bytes: Bytes::from(asset.bytes),
            mime_type: asset.mime_type,
        });
        let mut cache = self.asset_cache();
        if !is_html && cache.bytes + cached.bytes.len() <= ASSET_CACHE_BUDGET {
            cache.bytes += cached.bytes.len();
            cache.entries.insert(path.to_string(), Arc::clone(&cached));
        }
        Some(cached)
    }
}

fn asset_response(asset: &CachedAsset, cache_control: &'static str, head: bool) -> Response {
    let body = if head {
        Body::empty()
    } else {
        Body::from(asset.bytes.clone())
    };
    let mut res = Response::new(body);
    let headers = res.headers_mut();
    if let Ok(value) = HeaderValue::from_str(&asset.mime_type) {
        headers.insert(header::CONTENT_TYPE, value);
    }
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    res
}

fn not_found_page() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "Nicht gefunden",
    )
        .into_response()
}

fn serve_entry(ctx: &WebContext, head: bool) -> Response {
    match ctx.lookup_asset(REMOTE_ENTRY) {
        Some(asset) => asset_response(&asset, "no-cache", head),
        None => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            if head { "" } else { DEV_PAGE },
        )
            .into_response(),
    }
}

async fn static_files(State(ctx): State<WebState>, method: Method, uri: Uri) -> Response {
    let head = method == Method::HEAD;
    if method != Method::GET && !head {
        return (StatusCode::METHOD_NOT_ALLOWED, "Methode nicht erlaubt").into_response();
    }
    let path = uri.path().trim_start_matches('/');
    if !is_safe_asset_path(path) {
        return not_found_page();
    }
    let file_name = path.rsplit('/').next().unwrap_or_default();
    if path.is_empty() || path == REMOTE_ENTRY || !file_name.contains('.') {
        return serve_entry(&ctx, head);
    }
    if file_name.ends_with(".html") {
        return not_found_page();
    }
    match ctx.lookup_asset(path) {
        Some(asset) => {
            let cache_control = if path.starts_with("assets/") {
                "public, max-age=31536000, immutable"
            } else {
                "public, max-age=3600"
            };
            asset_response(&asset, cache_control, head)
        }
        None => not_found_page(),
    }
}

// ---------------------------------------------------------------------------
// Router and server
// ---------------------------------------------------------------------------

pub fn router(ctx: WebState) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/auth/status", get(auth_status))
        .route("/auth/login", auth_route(post(login)))
        .route("/auth/logout", post(logout))
        .route("/auth/pin", auth_route(post(change_pin)))
        .route("/state", get(get_state))
        .route("/state/ops", post(post_ops))
        .route("/events", get(events))
        .route("/system", get(system_info))
        .route("/actions/{action}", post(run_action))
        .route("/update/progress", get(update_progress))
        .route("/lagra/{*path}", get(lagra_proxy))
        .route("/lagra-test", get(lagra_test))
        .route(
            "/planbar/{*path}",
            get(planbar_proxy_get).patch(planbar_proxy_patch),
        )
        .route("/planbar-test", get(planbar_test))
        .route("/mail-test", post(mail_test))
        .route("/mail-status", get(mail_status))
        .route("/fans", get(fans_report).post(fans_update))
        .route("/export", get(export_state))
        .route("/import", post(import_state))
        .fallback(api_not_found)
        .method_not_allowed_fallback(api_method_not_allowed);

    Router::new()
        .nest("/api", api)
        .fallback(static_files)
        .layer(middleware::from_fn_with_state(Arc::clone(&ctx), api_guard))
        .layer(middleware::from_fn_with_state(Arc::clone(&ctx), host_guard))
        .layer(middleware::from_fn(security_headers))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(ctx)
}

/// Small body and a deadline for the PIN routes (the inner limit overrides `BODY_LIMIT`).
fn auth_route(
    route: axum::routing::MethodRouter<WebState>,
) -> axum::routing::MethodRouter<WebState> {
    route
        .layer(DefaultBodyLimit::max(AUTH_BODY_LIMIT))
        .layer(middleware::from_fn(auth_deadline))
}

/// Accept loop instead of `axum::serve`, which runs hyper without a timer, so hyper's header
/// read timeout never fires. Here a client that sends no complete request head within
/// [`HEADER_READ_TIMEOUT`] loses its connection, and at most [`MAX_CONNECTIONS`] are open at
/// once, so idle clients can never use up the kiosk process's file descriptors.
async fn serve_connections(
    listener: TcpListener,
    app: Router,
    max_connections: usize,
    header_timeout: Duration,
) {
    let slots = Arc::new(Semaphore::new(max_connections));
    let mut make_service = app.into_make_service_with_connect_info::<SocketAddr>();
    loop {
        let Ok(slot) = Arc::clone(&slots).acquire_owned().await else {
            return;
        };
        let (stream, peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(e) => {
                // E.g. EMFILE – back off instead of spinning.
                log::warn!("Fernsteuerung: Verbindung nicht angenommen: {e}");
                tokio::time::sleep(ACCEPT_BACKOFF).await;
                continue;
            }
        };
        // SSE events are small writes that must not wait for Nagle.
        let _ = stream.set_nodelay(true);
        let service = match ServiceExt::<SocketAddr>::ready(&mut make_service).await {
            Ok(ready) => match ready.call(peer).await {
                Ok(service) => service,
                Err(never) => match never {},
            },
            Err(never) => match never {},
        };
        tokio::spawn(async move {
            let mut builder = hyper::server::conn::http1::Builder::new();
            builder
                .timer(TokioTimer::new())
                .header_read_timeout(header_timeout);
            let connection =
                builder.serve_connection(TokioIo::new(stream), TowerToHyperService::new(service));
            if let Err(e) = connection.await {
                log::debug!("Fernsteuerung: Verbindung beendet: {e}");
            }
            drop(slot);
        });
    }
}

/// Binds `0.0.0.0:<port>` (retrying while a previous instance releases the port) and serves
/// until the app exits. Problems end up in `remote_info().error` instead of panicking.
pub async fn serve(ctx: WebState) {
    let port = ctx.remote.port();
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let mut attempt = 0;
    let listener = loop {
        match tokio::net::TcpListener::bind(addr).await {
            Ok(listener) => break listener,
            Err(e) => {
                attempt += 1;
                let message = if e.kind() == std::io::ErrorKind::AddrInUse {
                    format!("Port {port} ist bereits belegt")
                } else {
                    format!("Port {port} nicht verfügbar: {e}")
                };
                ctx.remote.set_server_error(Some(message.clone()));
                if attempt >= BIND_ATTEMPTS {
                    log::error!("Fernsteuerung nicht gestartet: {message}");
                    return;
                }
                log::warn!("Fernsteuerung: {message} – neuer Versuch");
                tokio::time::sleep(BIND_RETRY).await;
            }
        }
    };
    ctx.remote.set_server_error(None);
    log::info!("Fernsteuerung läuft auf Port {port}");

    serve_connections(
        listener,
        router(Arc::clone(&ctx)),
        MAX_CONNECTIONS,
        HEADER_READ_TIMEOUT,
    )
    .await;
    log::error!("Fernsteuerung beendet");
    ctx.remote
        .set_server_error(Some("Webserver beendet".to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::http::build_api_client;
    use crate::remote::EnvOverrides;
    use crate::state::tests::TestDir;
    use crate::state::SECRET_PLACEHOLDER;
    use axum::http::Request as HttpRequest;
    use std::net::{IpAddr, Ipv4Addr};
    use tower::ServiceExt;

    const INDEX_HTML: &str = "<!doctype html><html><head><script type=\"module\" nonce=\"{N}\" src=\"/assets/main-1.js\"></script></head><body>kiosk</body></html>";
    const REMOTE_HTML: &str = "<!doctype html><html><head><script type=\"module\" src=\"/assets/remote-1.js\"></script></head><body>remote</body></html>";

    /// Mimics Tauri's resolver: exact → `{p}.html` → `{p}/index.html` → index.html, with a
    /// fresh nonce in every HTML answer.
    struct FakeHost {
        files: HashMap<String, (String, String)>,
        actions: Mutex<Vec<(KioskAction, Option<Value>)>>,
    }

    impl FakeHost {
        fn new(with_remote: bool) -> Self {
            let mut files = HashMap::new();
            files.insert(
                "index.html".to_string(),
                (INDEX_HTML.to_string(), "text/html".to_string()),
            );
            if with_remote {
                files.insert(
                    "remote.html".to_string(),
                    (REMOTE_HTML.to_string(), "text/html".to_string()),
                );
            }
            files.insert(
                "assets/remote-1.js".to_string(),
                ("console.log(1)".to_string(), "text/javascript".to_string()),
            );
            files.insert(
                "favicon.svg".to_string(),
                (
                    "<!-- logo --><svg></svg>".to_string(),
                    "image/svg+xml".to_string(),
                ),
            );
            FakeHost {
                files,
                actions: Mutex::new(Vec::new()),
            }
        }
    }

    impl KioskHost for FakeHost {
        fn asset(&self, path: &str) -> Option<WebAsset> {
            let path = if path.is_empty() { "index.html" } else { path };
            let (body, mime) = [
                path.to_string(),
                format!("{path}.html"),
                format!("{path}/index.html"),
                "index.html".to_string(),
            ]
            .iter()
            .find_map(|candidate| self.files.get(candidate))?
            .clone();
            let nonce = rand::random::<u64>().to_string();
            Some(WebAsset {
                bytes: body.replace("{N}", &nonce).into_bytes(),
                mime_type: mime,
            })
        }

        fn perform(
            &self,
            action: KioskAction,
            value: Option<Value>,
        ) -> BoxFuture<'static, Result<Option<Value>, String>> {
            self.actions.lock().unwrap().push((action, value));
            Box::pin(async move {
                match action {
                    KioskAction::UpdateCheck => Ok(Some(json!({ "available": false }))),
                    KioskAction::DisplaySleep => Err("kein Backend".to_string()),
                    _ => Ok(None),
                }
            })
        }
    }

    struct Harness {
        _dir: TestDir,
        ctx: WebState,
        host: Arc<FakeHost>,
        pin: String,
    }

    fn harness(with_remote: bool) -> Harness {
        let dir = TestDir::new("web");
        let store = Arc::new(StateStore::load(dir.0.clone()));
        let remote = Arc::new(RemoteAuth::load(&dir.0, EnvOverrides::default()));
        let api = build_api_client().unwrap();
        let lagra = Arc::new(LagraService::new(api.clone()));
        let planbar = Arc::new(PlanbarService::new(api));
        // No hwmon chips in the test directory: the fan routes answer with an empty list.
        let fans = Arc::new(FanService::new(dir.0.join("hwmon"), &dir.0, None));
        let host = Arc::new(FakeHost::new(with_remote));
        let pin = remote.pin();
        let ctx = WebContext::new(
            store,
            remote,
            Arc::new(SystemContext::default()),
            lagra,
            planbar,
            fans,
            host.clone(),
        );
        Harness {
            _dir: dir,
            ctx,
            host,
            pin,
        }
    }

    struct Reply {
        status: StatusCode,
        headers: HeaderMap,
        body: Vec<u8>,
    }

    impl Reply {
        fn json(&self) -> Value {
            serde_json::from_slice(&self.body).unwrap_or(Value::Null)
        }
        fn text(&self) -> String {
            String::from_utf8_lossy(&self.body).into_owned()
        }
    }

    async fn call(
        h: &Harness,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        csrf: bool,
        body: Option<Value>,
    ) -> Reply {
        call_from(
            h,
            Ipv4Addr::new(192, 168, 1, 50),
            method,
            uri,
            cookie,
            csrf,
            body,
        )
        .await
    }

    async fn call_from(
        h: &Harness,
        ip: Ipv4Addr,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        csrf: bool,
        body: Option<Value>,
    ) -> Reply {
        let request = HttpRequest::builder().method(method).uri(uri);
        send(h, ip, request, cookie, csrf, body).await
    }

    /// `call` with the planbar Unternehmen header.
    async fn call_planbar_org(
        h: &Harness,
        method: &str,
        uri: &str,
        cookie: Option<&str>,
        org: &str,
        body: Option<Value>,
    ) -> Reply {
        let request = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header(PLANBAR_ORG_HEADER, org);
        let csrf = method != "GET";
        send(
            h,
            Ipv4Addr::new(192, 168, 1, 50),
            request,
            cookie,
            csrf,
            body,
        )
        .await
    }

    async fn send(
        h: &Harness,
        ip: Ipv4Addr,
        mut builder: axum::http::request::Builder,
        cookie: Option<&str>,
        csrf: bool,
        body: Option<Value>,
    ) -> Reply {
        if let Some(token) = cookie {
            builder = builder.header(
                header::COOKIE,
                format!("theme=dark; {SESSION_COOKIE}={token}"),
            );
        }
        if csrf {
            builder = builder.header(CSRF_HEADER, "1");
        }
        let body = match body {
            Some(v) => Body::from(serde_json::to_vec(&v).unwrap()),
            None => Body::empty(),
        };
        let mut req = builder.body(body).unwrap();
        req.extensions_mut()
            .insert(ConnectInfo(SocketAddr::new(IpAddr::V4(ip), 50000)));
        let res = router(Arc::clone(&h.ctx)).oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let body = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        Reply {
            status,
            headers,
            body,
        }
    }

    async fn login(h: &Harness) -> String {
        let reply = call(
            h,
            "POST",
            "/api/auth/login",
            None,
            true,
            Some(json!({ "pin": h.pin })),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        let cookie = reply.headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            cookie.contains("HttpOnly")
                && cookie.contains("SameSite=Strict")
                && cookie.contains("Max-Age=2592000")
        );
        cookie
            .split(';')
            .next()
            .and_then(|kv| kv.split_once('='))
            .map(|(_, v)| v.to_string())
            .unwrap()
    }

    #[tokio::test]
    async fn health_is_public_and_hardened() {
        let h = harness(true);
        let reply = call(&h, "GET", "/api/health", None, false, None).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json()["ok"], json!(true));
        assert_eq!(reply.json()["version"], json!(system::VERSION));
        assert_eq!(reply.json()["commit"], json!(system::commit()));
        assert_eq!(reply.headers[header::X_FRAME_OPTIONS], "DENY");
        assert_eq!(reply.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(reply.headers[header::CONTENT_SECURITY_POLICY], WEB_CSP);
        // Fonts are self-hosted files plus inlined `data:` fallbacks.
        assert!(WEB_CSP.contains("font-src 'self' data:"));
        assert_eq!(reply.headers[header::CACHE_CONTROL], "no-store");
        assert!(reply
            .headers
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[tokio::test]
    async fn api_requires_session_and_csrf_header() {
        let h = harness(true);
        let reply = call(&h, "GET", "/api/state", None, false, None).await;
        assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
        assert_eq!(reply.json(), json!({ "error": "Nicht angemeldet" }));
        assert_eq!(
            call(&h, "GET", "/api/gibts-nicht", None, false, None)
                .await
                .status,
            StatusCode::UNAUTHORIZED
        );

        let reply = call(
            &h,
            "POST",
            "/api/auth/login",
            None,
            false,
            Some(json!({ "pin": h.pin })),
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);

        let token = login(&h).await;
        let status = call(&h, "GET", "/api/auth/status", Some(&token), false, None).await;
        assert_eq!(
            status.json(),
            json!({ "authenticated": true, "name": "SlateDesk" })
        );
        let anonymous = call(&h, "GET", "/api/auth/status", None, false, None).await;
        assert_eq!(anonymous.json()["authenticated"], json!(false));

        let ops =
            json!({ "ops": [{ "op": "set", "path": ["kiosk", "name"], "value": "Empfang" }] });
        let reply = call(
            &h,
            "POST",
            "/api/state/ops",
            Some(&token),
            false,
            Some(ops.clone()),
        )
        .await;
        assert_eq!(reply.status, StatusCode::FORBIDDEN);
        let reply = call(&h, "POST", "/api/state/ops", Some(&token), true, Some(ops)).await;
        assert_eq!(reply.status, StatusCode::OK);
        assert_eq!(reply.json(), json!({ "rev": 1 }));
        assert_eq!(
            call(&h, "GET", "/api/auth/status", None, false, None)
                .await
                .json()["name"],
            json!("Empfang")
        );

        let missing = call(&h, "GET", "/api/gibts-nicht", Some(&token), false, None).await;
        assert_eq!(missing.status, StatusCode::NOT_FOUND);
        assert!(missing.json()["error"].is_string());
        let wrong_method = call(&h, "GET", "/api/state/ops", Some(&token), false, None).await;
        assert_eq!(wrong_method.status, StatusCode::METHOD_NOT_ALLOWED);

        let logout = call(&h, "POST", "/api/auth/logout", Some(&token), true, None).await;
        assert_eq!(logout.status, StatusCode::OK);
        assert!(logout.headers[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0"));
        assert_eq!(
            call(&h, "GET", "/api/state", Some(&token), false, None)
                .await
                .status,
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn login_is_rate_limited_per_ip() {
        let h = harness(true);
        let attacker = Ipv4Addr::new(10, 0, 0, 66);
        let wrong = if h.pin == "000000" {
            "111111"
        } else {
            "000000"
        };
        for _ in 0..5 {
            let reply = call_from(
                &h,
                attacker,
                "POST",
                "/api/auth/login",
                None,
                true,
                Some(json!({ "pin": wrong })),
            )
            .await;
            assert_eq!(reply.status, StatusCode::UNAUTHORIZED);
            assert_eq!(reply.json()["error"], json!("Falscher PIN"));
        }
        let blocked = call_from(
            &h,
            attacker,
            "POST",
            "/api/auth/login",
            None,
            true,
            Some(json!({ "pin": h.pin })),
        )
        .await;
        assert_eq!(blocked.status, StatusCode::TOO_MANY_REQUESTS);
        assert!(blocked.headers.contains_key(header::RETRY_AFTER));
        login(&h).await;
    }

    #[tokio::test]
    async fn state_is_redacted_and_secrets_survive_round_trips() {
        let h = harness(true);
        h.ctx
            .store
            .apply_ops(
                vec![StateOp::Set {
                    path: vec![crate::state::PathSeg::Key("lagra".into())],
                    value: json!({ "url": "https://lagra.example.ch", "token": "geheim", "enabled": true }),
                }],
                "kiosk",
                false,
            )
            .await
            .unwrap();
        let token = login(&h).await;

        let state = call(&h, "GET", "/api/state", Some(&token), false, None)
            .await
            .json();
        assert_eq!(state["state"]["lagra"]["token"], json!(SECRET_PLACEHOLDER));

        let ops = json!({ "ops": [{ "op": "merge", "path": ["lagra"], "value": { "enabled": false, "token": SECRET_PLACEHOLDER } }] });
        assert_eq!(
            call(&h, "POST", "/api/state/ops", Some(&token), true, Some(ops))
                .await
                .status,
            StatusCode::OK
        );
        assert_eq!(
            h.ctx.store.snapshot().state["lagra"]["token"],
            json!("geheim")
        );

        let export = call(&h, "GET", "/api/export", Some(&token), false, None).await;
        assert_eq!(export.status, StatusCode::OK);
        assert_eq!(
            export.headers[header::CONTENT_DISPOSITION],
            "attachment; filename=slatedesk-state.json"
        );
        let exported = export.json();
        assert_eq!(
            exported["state"]["lagra"]["token"],
            json!(SECRET_PLACEHOLDER)
        );

        let reply = call(
            &h,
            "POST",
            "/api/import",
            Some(&token),
            true,
            Some(json!({ "state": exported["state"] })),
        )
        .await;
        assert_eq!(reply.status, StatusCode::OK);
        let snapshot = h.ctx.store.snapshot();
        assert_eq!(reply.json()["rev"], json!(snapshot.rev));
        assert_eq!(snapshot.state["lagra"]["token"], json!("geheim"));

        let bad = call(
            &h,
            "POST",
            "/api/import",
            Some(&token),
            true,
            Some(json!({ "state": { "boese": {} } })),
        )
        .await;
        assert_eq!(bad.status, StatusCode::BAD_REQUEST);
        let garbage = call(
            &h,
            "POST",
            "/api/state/ops",
            Some(&token),
            true,
            Some(json!({ "nope": 1 })),
        )
        .await;
        assert_eq!(garbage.status, StatusCode::BAD_REQUEST);
        assert!(garbage.json()["error"]
            .as_str()
            .unwrap()
            .starts_with("Ungültige Anfrage"));
    }

    #[tokio::test]
    async fn pin_change_validates_and_ends_other_sessions() {
        let h = harness(true);
        let mine = login(&h).await;
        let other = login(&h).await;

        let wrong = call(
            &h,
            "POST",
            "/api/auth/pin",
            Some(&mine),
            true,
            Some(json!({ "current": "x", "next": "471147" })),
        )
        .await;
        assert_eq!(wrong.status, StatusCode::FORBIDDEN);
        let short = call(
            &h,
            "POST",
            "/api/auth/pin",
            Some(&mine),
            true,
            Some(json!({ "current": h.pin, "next": "12" })),
        )
        .await;
        assert_eq!(short.status, StatusCode::BAD_REQUEST);
        let four_digits = call(
            &h,
            "POST",
            "/api/auth/pin",
            Some(&mine),
            true,
            Some(json!({ "current": h.pin, "next": "4711" })),
        )
        .await;
        assert_eq!(four_digits.status, StatusCode::BAD_REQUEST);
        assert_eq!(four_digits.json()["error"], json!(PIN_RULE_MESSAGE));
        let ok = call(
            &h,
            "POST",
            "/api/auth/pin",
            Some(&mine),
            true,
            Some(json!({ "current": h.pin, "next": "471147" })),
        )
        .await;
        assert_eq!(ok.status, StatusCode::OK);

        assert_eq!(
            call(&h, "GET", "/api/state", Some(&other), false, None)
                .await
                .status,
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            call(&h, "GET", "/api/state", Some(&mine), false, None)
                .await
                .status,
            StatusCode::OK
        );
        assert!(h.ctx.remote.verify_pin("471147"));
    }

    #[tokio::test]
    async fn actions_reach_the_kiosk_host() {
        let h = harness(true);
        let token = login(&h).await;
        let reload = call(&h, "POST", "/api/actions/reload", Some(&token), true, None).await;
        assert_eq!(reload.json(), json!({ "ok": true }));
        let edit = call(
            &h,
            "POST",
            "/api/actions/edit-mode",
            Some(&token),
            true,
            Some(json!({ "value": true })),
        )
        .await;
        assert_eq!(edit.status, StatusCode::OK);
        let check = call(
            &h,
            "POST",
            "/api/actions/update-check",
            Some(&token),
            true,
            None,
        )
        .await;
        assert_eq!(
            check.json(),
            json!({ "ok": true, "result": { "available": false } })
        );
        let failed = call(
            &h,
            "POST",
            "/api/actions/display-sleep",
            Some(&token),
            true,
            None,
        )
        .await;
        assert_eq!(failed.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(failed.json(), json!({ "error": "kein Backend" }));
        let unknown = call(
            &h,
            "POST",
            "/api/actions/shutdown",
            Some(&token),
            true,
            None,
        )
        .await;
        assert_eq!(unknown.status, StatusCode::NOT_FOUND);

        let actions = h.host.actions.lock().unwrap();
        assert_eq!(actions[0], (KioskAction::Reload, None));
        assert_eq!(actions[1], (KioskAction::EditMode, Some(json!(true))));
        assert_eq!(actions.len(), 4);
    }

    #[tokio::test]
    async fn lagra_routes_report_missing_configuration() {
        let h = harness(true);
        let token = login(&h).await;
        let proxied = call(
            &h,
            "GET",
            "/api/lagra/uebersicht?teile=server",
            Some(&token),
            false,
            None,
        )
        .await;
        assert_eq!(proxied.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            proxied.json(),
            json!({ "error": "lagra ist nicht eingerichtet" })
        );
        let test = call(&h, "GET", "/api/lagra-test", Some(&token), false, None).await;
        assert_eq!(
            test.json(),
            json!({ "ok": false, "status": 0, "message": "lagra ist nicht eingerichtet", "uebersicht": false })
        );
        for denied in ["kunden", "assets/a1/datei", "ordner"] {
            let reply = call(
                &h,
                "GET",
                &format!("/api/lagra/{denied}"),
                Some(&token),
                false,
                None,
            )
            .await;
            assert_eq!(reply.status, StatusCode::FORBIDDEN, "{denied}");
            assert!(reply.headers.get(UPSTREAM_HEADER).is_none());
        }
    }

    #[tokio::test]
    async fn fan_routes_answer_without_fans() {
        let h = harness(true);
        let token = login(&h).await;
        let report = call(&h, "GET", "/api/fans", Some(&token), false, None).await;
        assert_eq!(report.status, StatusCode::OK);
        assert_eq!(report.json()["fans"], json!([]));
        assert_eq!(report.json()["minPercent"], json!(20));
        let unknown = call(
            &h,
            "POST",
            "/api/fans",
            Some(&token),
            true,
            Some(json!({ "id": "nct6798-x-1", "setting": { "mode": "fixed", "percent": 50 } })),
        )
        .await;
        assert_eq!(unknown.status, StatusCode::BAD_REQUEST);
        assert_eq!(unknown.json(), json!({ "error": "Lüfter nicht gefunden" }));
        let invalid = call(
            &h,
            "POST",
            "/api/fans",
            Some(&token),
            true,
            Some(json!({ "id": "x", "setting": { "mode": "fixed", "percent": 5 } })),
        )
        .await;
        assert_eq!(
            invalid.json(),
            json!({ "error": "Drehzahl zwischen 20 und 100 % wählen" })
        );
    }

    #[tokio::test]
    async fn mail_routes_report_missing_configuration() {
        let h = harness(true);
        let token = login(&h).await;
        let test = call(&h, "POST", "/api/mail-test", Some(&token), true, None).await;
        assert_eq!(
            test.json(),
            json!({ "ok": false, "message": "Kein Postausgangsserver eingetragen" })
        );
        let status = call(&h, "GET", "/api/mail-status", Some(&token), false, None).await;
        assert!(status.json()["pending"].is_u64());
    }

    #[test]
    fn only_kiosk_host_names_are_answered() {
        let extra = vec!["kiosk.example.ch".to_string()];
        for ok in [
            "192.168.19.181:7380",
            "192.168.19.181",
            "[fe80::1]:7380",
            "localhost:5173",
            "slatedesk:7380",
            "slatedesk.local:7380",
            "SlateDesk.fritz.lan:7380",
            "kiosk.home.arpa",
            "kiosk.example.ch:7380",
            "kiosk.example.ch.:7380",
        ] {
            assert!(host_allowed(ok, &extra), "{ok}");
        }
        for rebound in [
            "evil.example:7380",
            "192.168.19.181.nip.io:7380",
            "kiosk.example.ch.evil.example",
            "",
            "a b:7380",
        ] {
            assert!(!host_allowed(rebound, &extra), "{rebound}");
        }
    }

    #[tokio::test]
    async fn foreign_host_header_is_refused() {
        let h = harness(true);
        let request = |host: &str| {
            let mut req = HttpRequest::builder()
                .method("POST")
                .uri("/api/auth/login")
                .header(header::HOST, host)
                .header(CSRF_HEADER, "1")
                .body(Body::from(
                    serde_json::to_vec(&json!({ "pin": h.pin })).unwrap(),
                ))
                .unwrap();
            req.extensions_mut().insert(ConnectInfo(SocketAddr::new(
                IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)),
                50000,
            )));
            req
        };
        let rebound = router(Arc::clone(&h.ctx))
            .oneshot(request("evil.example:7380"))
            .await
            .unwrap();
        assert_eq!(rebound.status(), StatusCode::MISDIRECTED_REQUEST);
        assert!(rebound.headers().get(header::SET_COOKIE).is_none());
        let lan = router(Arc::clone(&h.ctx))
            .oneshot(request("192.168.1.10:7380"))
            .await
            .unwrap();
        assert_eq!(lan.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn login_body_is_small() {
        let h = harness(true);
        let padding = "x".repeat(AUTH_BODY_LIMIT);
        let reply = call(
            &h,
            "POST",
            "/api/auth/login",
            None,
            true,
            Some(json!({ "pin": h.pin, "padding": padding })),
        )
        .await;
        assert_eq!(reply.status, StatusCode::PAYLOAD_TOO_LARGE);
        login(&h).await;
    }

    #[tokio::test]
    async fn server_serves_over_tcp_and_drops_idle_connections() {
        use tokio::io::AsyncReadExt;

        let h = harness(true);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(serve_connections(
            listener,
            router(Arc::clone(&h.ctx)),
            MAX_CONNECTIONS,
            Duration::from_millis(300),
        ));

        // The peer address reaches the login handler (ConnectInfo).
        let client = reqwest::Client::new();
        let reply = client
            .post(format!("http://{addr}/api/auth/login"))
            .header(CSRF_HEADER, "1")
            .json(&json!({ "pin": h.pin }))
            .send()
            .await
            .unwrap();
        assert_eq!(reply.status(), 200);

        // A client that never sends a request head is disconnected.
        let mut idle = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut buf = [0u8; 1];
        let read = tokio::time::timeout(Duration::from_secs(5), idle.read(&mut buf))
            .await
            .expect("server closes the idle connection");
        assert!(matches!(read, Ok(0) | Err(_)), "{read:?}");
    }

    #[tokio::test]
    async fn event_stream_outlives_the_header_timeout() {
        let h = harness(true);
        let token = login(&h).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(serve_connections(
            listener,
            router(Arc::clone(&h.ctx)),
            MAX_CONNECTIONS,
            Duration::from_millis(200),
        ));
        let mut events = reqwest::Client::new()
            .get(format!("http://{addr}/api/events"))
            .header(header::COOKIE, format!("{SESSION_COOKIE}={token}"))
            .send()
            .await
            .unwrap();
        assert_eq!(events.status(), 200);
        let first = events.chunk().await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&first).contains("\"origin\":\"sync\""));

        // The client sends nothing while the stream runs – it must stay open.
        tokio::time::sleep(Duration::from_millis(700)).await;
        h.ctx
            .store
            .apply_ops(
                vec![StateOp::Set {
                    path: vec![crate::state::PathSeg::Key("theme".into())],
                    value: json!({ "mode": "light" }),
                }],
                "kiosk",
                false,
            )
            .await
            .unwrap();
        let next = tokio::time::timeout(Duration::from_secs(2), events.chunk())
            .await
            .expect("event arrives")
            .unwrap()
            .unwrap();
        assert!(String::from_utf8_lossy(&next).contains("\"origin\":\"kiosk\""));
    }

    #[tokio::test]
    async fn server_caps_open_connections() {
        let h = harness(true);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(serve_connections(
            listener,
            router(Arc::clone(&h.ctx)),
            2,
            Duration::from_millis(800),
        ));
        let _first = tokio::net::TcpStream::connect(addr).await.unwrap();
        let _second = tokio::net::TcpStream::connect(addr).await.unwrap();

        let health = || {
            reqwest::Client::new()
                .get(format!("http://{addr}/api/health"))
                .timeout(Duration::from_secs(5))
        };
        // Both slots are taken: the third connection waits …
        let waiting = health().timeout(Duration::from_millis(250)).send().await;
        assert!(waiting.is_err(), "{waiting:?}");
        // … until the idle ones time out.
        assert_eq!(health().send().await.unwrap().status(), 200);
    }

    async fn configure_planbar(h: &Harness, url: &str, key: &str) {
        let state = crate::planbar::tests::state_for(url, key);
        h.ctx
            .store
            .apply_ops(
                vec![StateOp::Set {
                    path: vec![crate::state::PathSeg::Key("planbar".into())],
                    value: state["planbar"].clone(),
                }],
                "kiosk",
                false,
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn planbar_routes_need_session_csrf_and_configuration() {
        let h = harness(true);
        let anonymous = call(&h, "GET", "/api/planbar/mitglieder", None, false, None).await;
        assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
        assert!(anonymous.headers.get(UPSTREAM_HEADER).is_none());

        let token = login(&h).await;
        let tick = json!({ "completed": true });
        let no_csrf = call(
            &h,
            "PATCH",
            "/api/planbar/arbeitsliste/a1",
            Some(&token),
            false,
            Some(tick.clone()),
        )
        .await;
        assert_eq!(no_csrf.status, StatusCode::FORBIDDEN);
        assert!(no_csrf.headers.get(UPSTREAM_HEADER).is_none());

        let unconfigured = call(
            &h,
            "PATCH",
            "/api/planbar/arbeitsliste/a1",
            Some(&token),
            true,
            Some(tick),
        )
        .await;
        assert_eq!(unconfigured.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            unconfigured.json(),
            json!({ "error": "planbar ist nicht eingerichtet" })
        );
        assert!(unconfigured.headers.get(UPSTREAM_HEADER).is_none());
        let read = call(
            &h,
            "GET",
            "/api/planbar/mitglieder",
            Some(&token),
            false,
            None,
        )
        .await;
        assert_eq!(read.status, StatusCode::SERVICE_UNAVAILABLE);

        let delete = call(
            &h,
            "DELETE",
            "/api/planbar/arbeitsliste/a1",
            Some(&token),
            true,
            None,
        )
        .await;
        assert_eq!(delete.status, StatusCode::METHOD_NOT_ALLOWED);

        let test = call(&h, "GET", "/api/planbar-test", Some(&token), false, None).await;
        assert_eq!(test.json(), json!({ "results": [] }));
        let one = call(
            &h,
            "GET",
            "/api/planbar-test?org=wireon",
            Some(&token),
            false,
            None,
        )
        .await;
        assert_eq!(
            one.json(),
            json!({ "results": [{
                "org": "wireon", "name": "wireon",
                "ok": false, "status": 0, "message": "planbar: Unternehmen «wireon» ist nicht eingerichtet",
                "dashboard": false, "members": null, "scopes": null
            }] })
        );
    }

    #[tokio::test]
    async fn planbar_proxy_marks_upstream_answers() {
        use crate::planbar::tests::{fake_planbar, KEY, READ_ONLY_KEY};
        let (url, _) = fake_planbar(true).await;
        let h = harness(true);
        configure_planbar(&h, &url, KEY).await;
        let token = login(&h).await;

        let state = call(&h, "GET", "/api/state", Some(&token), false, None)
            .await
            .json();
        assert_eq!(
            state["state"]["planbar"]["unternehmen"]["a"],
            json!({ "name": "Büro", "apiKey": SECRET_PLACEHOLDER })
        );

        let work = call(
            &h,
            "GET",
            "/api/planbar/arbeitsliste?benutzer=u1",
            Some(&token),
            false,
            None,
        )
        .await;
        assert_eq!(work.status, StatusCode::OK);
        assert_eq!(work.headers[UPSTREAM_HEADER], "planbar");
        assert_eq!(work.headers[header::CACHE_CONTROL], "no-store");
        assert!(work.headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("application/json"));
        assert_eq!(work.json()["query"], json!("benutzer=u1"));

        assert_eq!(work.headers[header::CONTENT_SECURITY_POLICY], PROXY_CSP);

        // Only the dashboard routes are read for the web UI – an own 403, not planbar's.
        let denied = call(
            &h,
            "GET",
            "/api/planbar/rechnungen",
            Some(&token),
            false,
            None,
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN);
        assert!(denied.headers.get(UPSTREAM_HEADER).is_none());
        assert_eq!(
            denied.json(),
            json!({ "error": "planbar: «rechnungen» ist über die Fernsteuerung nicht freigegeben" })
        );

        let ticked = call(
            &h,
            "PATCH",
            "/api/planbar/arbeitsliste/a1",
            Some(&token),
            true,
            Some(json!({ "completed": true })),
        )
        .await;
        assert_eq!(ticked.status, StatusCode::OK);
        assert_eq!(ticked.headers[UPSTREAM_HEADER], "planbar");
        assert_eq!(ticked.json()["data"]["done"], json!(true));

        for (path, body, error) in [
            (
                "/api/planbar/mitglieder",
                json!({ "completed": true }),
                "planbar: Ändern ist nur für Aufgaben der Arbeitsliste erlaubt",
            ),
            (
                "/api/planbar/arbeitsliste/a1",
                json!({ "completed": "ja" }),
                "planbar: ungültige Änderung (erwartet { \"completed\": true oder false })",
            ),
        ] {
            let rejected = call(&h, "PATCH", path, Some(&token), true, Some(body)).await;
            assert_eq!(rejected.status, StatusCode::BAD_REQUEST, "{path}");
            assert!(rejected.headers.get(UPSTREAM_HEADER).is_none(), "{path}");
            assert_eq!(rejected.json(), json!({ "error": error }));
        }

        let test = call(&h, "GET", "/api/planbar-test", Some(&token), false, None).await;
        assert_eq!(
            test.json(),
            json!({ "results": [{
                "org": "a", "name": "Büro",
                "ok": true, "status": 200, "message": "Verbindung zu planbar hergestellt",
                "dashboard": true, "members": 2,
                "scopes": { "aufgaben": true, "aufgabenSchreiben": true, "projekte": true, "news": true }
            }] })
        );

        configure_planbar(&h, &url, READ_ONLY_KEY).await;
        let forbidden = call(
            &h,
            "PATCH",
            "/api/planbar/arbeitsliste/a1",
            Some(&token),
            true,
            Some(json!({ "completed": true })),
        )
        .await;
        assert_eq!(forbidden.status, StatusCode::FORBIDDEN);
        assert_eq!(forbidden.headers[UPSTREAM_HEADER], "planbar");
        assert_eq!(
            forbidden.json(),
            json!({ "error": "Fehlende Berechtigung: aufgaben:write" })
        );

        // planbar's 401 is about the key – the web UI session stays valid.
        configure_planbar(&h, &url, "pk_live_alt").await;
        let revoked = call(
            &h,
            "GET",
            "/api/planbar/mitglieder",
            Some(&token),
            false,
            None,
        )
        .await;
        assert_eq!(revoked.status, StatusCode::UNAUTHORIZED);
        assert_eq!(revoked.headers[UPSTREAM_HEADER], "planbar");
        assert_eq!(
            call(&h, "GET", "/api/state", Some(&token), false, None)
                .await
                .status,
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn planbar_org_header_selects_the_unternehmen() {
        use crate::planbar::tests::{fake_planbar, state_with_orgs, KEY, SECOND_KEY};
        let (url, _) = fake_planbar(true).await;
        let h = harness(true);
        let state = state_with_orgs(
            &url,
            &[
                ("wireon", "wireon", KEY),
                ("sw", "Schnyder Werbung", SECOND_KEY),
            ],
        );
        h.ctx
            .store
            .apply_ops(
                vec![StateOp::Set {
                    path: vec![crate::state::PathSeg::Key("planbar".into())],
                    value: state["planbar"].clone(),
                }],
                "kiosk",
                false,
            )
            .await
            .unwrap();
        let token = login(&h).await;

        // Two keys: without the header the kiosk can't tell whose data is wanted.
        let unnamed = call(
            &h,
            "GET",
            "/api/planbar/mitglieder",
            Some(&token),
            false,
            None,
        )
        .await;
        assert_eq!(unnamed.status, StatusCode::BAD_REQUEST);
        assert!(unnamed.headers.get(UPSTREAM_HEADER).is_none());
        assert_eq!(
            unnamed.json(),
            json!({ "error": "planbar: bitte ein Unternehmen wählen" })
        );

        let wireon = call_planbar_org(
            &h,
            "GET",
            "/api/planbar/mitglieder",
            Some(&token),
            "wireon",
            None,
        )
        .await;
        assert_eq!(wireon.status, StatusCode::OK);
        assert_eq!(wireon.json()["data"].as_array().map(Vec::len), Some(2));
        let sw = call_planbar_org(
            &h,
            "GET",
            "/api/planbar/arbeitsliste?benutzer=u1",
            Some(&token),
            "sw",
            None,
        )
        .await;
        assert_eq!(sw.json()["org"], json!("zwei"));

        let unknown = call_planbar_org(
            &h,
            "GET",
            "/api/planbar/mitglieder",
            Some(&token),
            "<b>x",
            None,
        )
        .await;
        assert_eq!(unknown.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            unknown.json(),
            json!({ "error": "planbar: Unternehmen «bx» ist nicht eingerichtet" })
        );

        // The allowlist and the PATCH rules stay the same with the header.
        let denied = call_planbar_org(
            &h,
            "GET",
            "/api/planbar/rechnungen",
            Some(&token),
            "sw",
            None,
        )
        .await;
        assert_eq!(denied.status, StatusCode::FORBIDDEN);
        let ticked = call_planbar_org(
            &h,
            "PATCH",
            "/api/planbar/arbeitsliste/a1",
            Some(&token),
            "sw",
            Some(json!({ "completed": true })),
        )
        .await;
        assert_eq!(ticked.status, StatusCode::OK);
        assert_eq!(ticked.headers[UPSTREAM_HEADER], "planbar");
        let rejected = call_planbar_org(
            &h,
            "PATCH",
            "/api/planbar/mitglieder",
            Some(&token),
            "sw",
            Some(json!({ "completed": true })),
        )
        .await;
        assert_eq!(rejected.status, StatusCode::BAD_REQUEST);

        let all = call(&h, "GET", "/api/planbar-test", Some(&token), false, None)
            .await
            .json();
        let orgs: Vec<&str> = all["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["org"].as_str().unwrap())
            .collect();
        assert_eq!(orgs.len(), 2);
        assert!(orgs.contains(&"wireon") && orgs.contains(&"sw"));
        let one = call(
            &h,
            "GET",
            "/api/planbar-test?org=sw",
            Some(&token),
            false,
            None,
        )
        .await
        .json();
        assert_eq!(one["results"].as_array().map(Vec::len), Some(1));
        assert_eq!(one["results"][0]["name"], json!("Schnyder Werbung"));
        assert_eq!(one["results"][0]["ok"], json!(true));

        // Keys never leave the kiosk – not in the state, not in the test answer.
        let state = call(&h, "GET", "/api/state", Some(&token), false, None).await;
        assert!(!state.text().contains("pk_live"));
        assert!(!serde_json::to_string(&all).unwrap().contains("pk_live"));
    }

    #[tokio::test]
    async fn static_files_never_serve_the_kiosk_index() {
        let h = harness(true);
        let root = call(&h, "GET", "/", None, false, None).await;
        assert_eq!(root.status, StatusCode::OK);
        assert!(root.text().contains("remote"));
        assert_eq!(root.headers[header::CACHE_CONTROL], "no-cache");
        assert_eq!(root.headers[header::CONTENT_SECURITY_POLICY], WEB_CSP);

        assert!(call(&h, "GET", "/system", None, false, None)
            .await
            .text()
            .contains("remote"));
        assert!(call(&h, "GET", "/remote.html", None, false, None)
            .await
            .text()
            .contains("remote"));

        let script = call(&h, "GET", "/assets/remote-1.js", None, false, None).await;
        assert_eq!(script.status, StatusCode::OK);
        assert_eq!(script.headers[header::CONTENT_TYPE], "text/javascript");
        assert_eq!(
            script.headers[header::CACHE_CONTROL],
            "public, max-age=31536000, immutable"
        );

        let svg = call(&h, "GET", "/favicon.svg", None, false, None).await;
        assert_eq!(svg.status, StatusCode::OK);
        assert_eq!(svg.headers[header::CACHE_CONTROL], "public, max-age=3600");

        for missing in [
            "/assets/fehlt.js",
            "/index.html",
            "/fehlt.png",
            "/andere.html",
            "/assets/%2e%2e/x.js",
        ] {
            let reply = call(&h, "GET", missing, None, false, None).await;
            assert_eq!(reply.status, StatusCode::NOT_FOUND, "{missing}");
            assert!(!reply.text().contains("kiosk"), "{missing}");
        }
        assert_eq!(
            call(&h, "POST", "/", None, true, None).await.status,
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn dev_page_when_web_ui_is_not_bundled() {
        let h = harness(false);
        let root = call(&h, "GET", "/", None, false, None).await;
        assert_eq!(root.status, StatusCode::OK);
        assert!(root
            .text()
            .contains("Dev-Modus: Web-UI unter <a href=\"http://localhost:5173/remote.html\">"));
        assert!(!root.text().contains("kiosk"));
    }

    #[tokio::test]
    async fn events_stream_starts_with_current_state() {
        let h = harness(true);
        let token = login(&h).await;
        let mut req = HttpRequest::builder()
            .uri("/api/events")
            .header(header::COOKIE, format!("{SESSION_COOKIE}={token}"))
            .body(Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            1,
        )));
        let res = router(Arc::clone(&h.ctx)).oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "text/event-stream");

        let mut body = res.into_body().into_data_stream();
        let first = tokio::time::timeout(Duration::from_secs(2), body.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let first = String::from_utf8_lossy(&first).into_owned();
        assert!(first.starts_with("event: state\n"), "{first}");
        assert!(first.contains("\"origin\":\"sync\""));

        h.ctx
            .store
            .apply_ops(
                vec![StateOp::Set {
                    path: vec![crate::state::PathSeg::Key("theme".into())],
                    value: json!({ "mode": "light" }),
                }],
                "kiosk",
                false,
            )
            .await
            .unwrap();
        let second = tokio::time::timeout(Duration::from_secs(2), body.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let second = String::from_utf8_lossy(&second).into_owned();
        assert!(
            second.contains("\"rev\":1") && second.contains("\"origin\":\"kiosk\""),
            "{second}"
        );
    }

    #[test]
    fn helpers() {
        assert!(looks_like_html(b"  <!DOCTYPE html><html>"));
        assert!(!looks_like_html(b"<svg></svg>"));
        assert!(same_ignoring_digits(b"nonce=\"123\"", b"nonce=\"98765\""));
        assert!(!same_ignoring_digits(b"main-1.js", b"remote-1.js"));
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=b; sd_session=zz"),
        );
        assert_eq!(session_token(&headers), None);
        for action in KioskAction::ALL {
            assert_eq!(KioskAction::parse(action.as_str()), Some(action));
        }
        assert_eq!(
            action_value(&Bytes::from_static(b"{\"value\":3}"))
                .ok()
                .flatten(),
            Some(json!(3))
        );
        assert_eq!(
            action_value(&Bytes::from_static(b"{\"a\":1}"))
                .ok()
                .flatten(),
            Some(json!({ "a": 1 }))
        );
        assert_eq!(
            action_value(&Bytes::from_static(b"  ")).ok().flatten(),
            None
        );
    }
}
