//! planbar integration – the work dashboard (tasks, projects, news, booked time). planbar's
//! `/api/v1` needs an API key and sends no CORS headers, so every call (kiosk commands and
//! the web UI proxy) goes through here; the key never leaves Rust.

use crate::http::{content_type, describe_error, read_body_limited, ProxyResponse};
use crate::state::StateStore;
use reqwest::header::ACCEPT;
use reqwest::{Client, Method, StatusCode, Url};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::State;

pub const DEFAULT_PLANBAR_URL: &str = "https://planbar.dev";
const API_PREFIX: &str = "/api/v1/";
/// The only writable resource. A key with `aufgaben:write` could also create tickets or time
/// entries through other routes – SlateDesk only ever ticks off tasks.
const WORK_ITEM_PREFIX: &str = "/api/v1/arbeitsliste/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const JSON_CACHE_TTL: Duration = Duration::from_secs(15);
const JSON_CACHE_MAX: usize = 64;
const JSON_MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_PATH_LEN: usize = 512;
const MAX_QUERY_PARAMS: usize = 32;
const MAX_ID_LEN: usize = 64;
const PLAIN_TEXT: &str = "text/plain; charset=utf-8";
/// Unknown task id for the write probe of the connection test (the request changes nothing).
const PROBE_ITEM_PATH: &str = "/api/v1/arbeitsliste/slatedesk-verbindungstest";
/// What the web UI reads through `/api/planbar/…` (below `/api/v1/`). Invoices, offers,
/// customers or time entries stay out of reach of a web UI session even when the key may
/// read them; the kiosk's own `planbar_get` stays generic.
const PROXY_ROUTES: [&str; 5] = [
    "mitglieder",
    "arbeitsliste",
    "projektuebersicht",
    "news",
    "zeiten/zusammenfassung",
];
/// The list routes SlateDesk reads. planbar answers them with 404 only when it lacks them.
const LIST_ROUTES: [&str; 4] = [
    "/api/v1/arbeitsliste",
    "/api/v1/projektuebersicht",
    "/api/v1/news",
    "/api/v1/zeiten/zusammenfassung",
];

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanbarError {
    NotConfigured,
    InvalidBaseUrl,
    InvalidPath(String),
    /// A path the web UI proxy does not read.
    ReadNotAllowed(String),
    WriteNotAllowed,
    InvalidBody,
    /// 401 – planbar's reason (missing, revoked, expired key) when it sent one.
    Unauthorized(Option<String>),
    /// 403 – planbar names the missing right («Fehlende Berechtigung: news:read»).
    Forbidden(Option<String>),
    /// Non-JSON 404: this planbar version lacks the route (Next.js answers with its HTML page).
    EndpointMissing,
    /// JSON 404: the route exists, the item does not.
    NotFound(Option<String>),
    Status(u16, Option<String>),
    /// A redirect away from `{url}/api/v1/` – not followed, the key stays with planbar.
    Redirected(u16),
    Unreachable(String),
    InvalidResponse(String),
}

impl fmt::Display for PlanbarError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PlanbarError::NotConfigured => f.write_str("planbar ist nicht eingerichtet"),
            PlanbarError::InvalidBaseUrl => f.write_str("Die planbar-Adresse ist ungültig"),
            PlanbarError::InvalidPath(p) => write!(f, "Ungültiger planbar-Pfad: {p}"),
            PlanbarError::ReadNotAllowed(p) => {
                write!(
                    f,
                    "planbar: «{p}» ist über die Fernsteuerung nicht freigegeben"
                )
            }
            PlanbarError::WriteNotAllowed => {
                f.write_str("planbar: Ändern ist nur für Aufgaben der Arbeitsliste erlaubt")
            }
            PlanbarError::InvalidBody => f.write_str(
                "planbar: ungültige Änderung (erwartet { \"completed\": true oder false })",
            ),
            PlanbarError::Unauthorized(Some(msg)) => {
                write!(f, "planbar: API-Schlüssel ungültig (401) – {msg}")
            }
            PlanbarError::Unauthorized(None) => {
                f.write_str("planbar: API-Schlüssel ungültig (401)")
            }
            PlanbarError::Forbidden(Some(msg)) => write!(f, "planbar: Berechtigung fehlt – {msg}"),
            PlanbarError::Forbidden(None) => f.write_str("planbar: Berechtigung fehlt (403)"),
            PlanbarError::EndpointMissing => {
                f.write_str("planbar: Endpunkt fehlt (404) – planbar-Update nötig")
            }
            PlanbarError::NotFound(Some(msg)) => write!(f, "planbar: nicht gefunden – {msg}"),
            PlanbarError::NotFound(None) => f.write_str("planbar: nicht gefunden"),
            PlanbarError::Status(status, Some(msg)) => {
                write!(f, "planbar: Fehler {status} – {msg}")
            }
            PlanbarError::Status(status, None) => write!(f, "planbar: Fehler {status}"),
            PlanbarError::Redirected(status) => write!(
                f,
                "planbar: Weiterleitung auf eine andere Adresse ({status}) – planbar-Adresse prüfen"
            ),
            PlanbarError::Unreachable(detail) => write!(f, "planbar nicht erreichbar: {detail}"),
            PlanbarError::InvalidResponse(detail) => {
                write!(f, "planbar: ungültige Antwort ({detail})")
            }
        }
    }
}

impl std::error::Error for PlanbarError {}

fn is_json_type(content_type: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    essence == "application/json" || essence.ends_with("+json")
}

/// The body when planbar sent JSON. All of planbar's own answers (errors too) are JSON;
/// anything else is Next's HTML page for a route this planbar version does not have.
fn json_body(content_type: &str, body: &[u8]) -> Option<Value> {
    if !content_type.trim().is_empty() && !is_json_type(content_type) {
        return None;
    }
    serde_json::from_slice(body).ok()
}

/// planbar error bodies are `{ "error": "…" }`.
fn error_message(json: Option<&Value>) -> Option<String> {
    let msg = json?.get("error")?.as_str()?.trim();
    (!msg.is_empty()).then(|| msg.chars().take(200).collect())
}

fn status_error(status: StatusCode, content_type: &str, body: &[u8]) -> PlanbarError {
    let json = json_body(content_type, body);
    let message = error_message(json.as_ref());
    match status.as_u16() {
        401 => PlanbarError::Unauthorized(message),
        403 => PlanbarError::Forbidden(message),
        404 if json.is_none() => PlanbarError::EndpointMissing,
        404 => PlanbarError::NotFound(message),
        code => PlanbarError::Status(code, message),
    }
}

fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | '~')
}

/// Paths for `planbar_get`: `/api/v1/…`, no traversal, no query or fragment.
pub fn validate_api_path(path: &str) -> Result<(), PlanbarError> {
    let ok = path.starts_with(API_PREFIX)
        && path.len() > API_PREFIX.len()
        && path.len() <= MAX_PATH_LEN
        && path.chars().all(is_path_char)
        && !path.contains("..")
        && !path.contains("//");
    if ok {
        Ok(())
    } else {
        Err(PlanbarError::InvalidPath(path.chars().take(80).collect()))
    }
}

/// Sub-paths (below `/api/v1/`) the web UI proxy reads – the dashboard routes only.
pub fn validate_proxy_path(sub_path: &str) -> Result<(), PlanbarError> {
    if PROXY_ROUTES.contains(&sub_path) {
        Ok(())
    } else {
        Err(PlanbarError::ReadNotAllowed(
            sub_path.chars().take(80).collect(),
        ))
    }
}

/// Paths for `planbar_patch`: only `/api/v1/arbeitsliste/<id>`.
pub fn validate_patch_path(path: &str) -> Result<(), PlanbarError> {
    let id = path
        .strip_prefix(WORK_ITEM_PREFIX)
        .ok_or(PlanbarError::WriteNotAllowed)?;
    let ok = !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(PlanbarError::WriteNotAllowed)
    }
}

/// A work list change is exactly `{ "completed": true | false }` – nothing else is forwarded.
pub fn validate_patch_body(body: &Value) -> Result<(), PlanbarError> {
    match body.as_object() {
        Some(map) if map.len() == 1 && map.get("completed").is_some_and(Value::is_boolean) => {
            Ok(())
        }
        _ => Err(PlanbarError::InvalidBody),
    }
}

#[derive(Clone)]
pub struct PlanbarConfig {
    base: Url,
    api_key: String,
}

/// Without the key – a `{:?}` in a log line must not leak it.
impl fmt::Debug for PlanbarConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PlanbarConfig")
            .field("base", &self.base.as_str())
            .field("api_key", &"…")
            .finish()
    }
}

impl PlanbarConfig {
    /// Reads `state.planbar`. Rust must not assume the frontend's defaults are stored, so it
    /// applies the same ones (`src/state/defaults.ts`): a missing `url` means planbar.dev, a
    /// missing `enabled` means switched off.
    pub fn from_state(state: &Value, require_enabled: bool) -> Result<Self, PlanbarError> {
        let planbar = state.get("planbar");
        let field = |name: &str| {
            planbar
                .and_then(|p| p.get(name))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let enabled = planbar
            .and_then(|p| p.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if require_enabled && !enabled {
            return Err(PlanbarError::NotConfigured);
        }
        let api_key = field("apiKey")
            .ok_or(PlanbarError::NotConfigured)?
            .to_string();
        let raw_url = field("url").unwrap_or(DEFAULT_PLANBAR_URL);
        let base = Url::parse(raw_url).map_err(|_| PlanbarError::InvalidBaseUrl)?;
        if !matches!(base.scheme(), "http" | "https") || base.host_str().is_none() {
            return Err(PlanbarError::InvalidBaseUrl);
        }
        Ok(PlanbarConfig { base, api_key })
    }

    /// `{base}/api/v1/` – everything the key may be sent to lives below it.
    fn api_root(&self) -> String {
        let mut root = self.base.clone();
        root.set_query(None);
        root.set_fragment(None);
        format!("{}{}", root.as_str().trim_end_matches('/'), API_PREFIX)
    }

    fn api_url(&self, path: &str) -> Result<Url, PlanbarError> {
        let relative = path.strip_prefix(API_PREFIX).unwrap_or(path);
        Url::parse(&format!("{}{relative}", self.api_root()))
            .map_err(|_| PlanbarError::InvalidBaseUrl)
    }

    /// Cache key part: changes when url or key change, without keeping the key around.
    fn fingerprint(&self) -> String {
        let digest = Sha256::digest(self.api_key.as_bytes());
        format!("{}#{}", self.api_root(), hex::encode(&digest[..8]))
    }
}

/// What planbar answered, before it is interpreted.
struct Upstream {
    status: StatusCode,
    content_type: String,
    body: Vec<u8>,
}

impl Upstream {
    /// A 404 from a list route means this planbar lacks it, even with planbar's JSON body: an
    /// old planbar hands `/zeiten/zusammenfassung` to its `/zeiten/{id}` route («Zeiteintrag
    /// nicht gefunden»). Such an answer becomes the body-less 404 of a missing route.
    fn for_route(self, path: &str) -> Self {
        if self.status == StatusCode::NOT_FOUND && LIST_ROUTES.contains(&path) {
            return Upstream {
                status: self.status,
                content_type: String::new(),
                body: Vec::new(),
            };
        }
        self
    }

    fn into_json(self) -> Result<Value, PlanbarError> {
        if !self.status.is_success() {
            return Err(status_error(self.status, &self.content_type, &self.body));
        }
        json_body(&self.content_type, &self.body)
            .ok_or_else(|| PlanbarError::InvalidResponse("kein JSON".to_string()))
    }

    /// For the web UI: JSON passes unchanged, anything else (Next's HTML pages) is dropped so
    /// planbar's pages never render on the web UI's origin. An empty non-JSON 404 still reads
    /// as «Endpunkt fehlt» there.
    fn into_proxy(self) -> ProxyResponse {
        let status = self.status.as_u16();
        if json_body(&self.content_type, &self.body).is_none() {
            return ProxyResponse {
                status,
                content_type: PLAIN_TEXT.to_string(),
                cache_control: None,
                body: Vec::new(),
            };
        }
        let content_type = if is_json_type(&self.content_type) {
            self.content_type
        } else {
            "application/json".to_string()
        };
        ProxyResponse {
            status,
            content_type,
            cache_control: None,
            body: self.body,
        }
    }
}

/// Rights of the key, as far as the connection test could tell.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanbarScopes {
    /// `aufgaben:read` – Arbeitsliste and booked time.
    pub aufgaben: bool,
    /// `aufgaben:write` – ticking off tasks.
    pub aufgaben_schreiben: bool,
    /// `projekte:read` – Projektübersicht.
    pub projekte: bool,
    /// `news:read` – Infowand.
    pub news: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlanbarTestResult {
    pub ok: bool,
    /// HTTP status of planbar, 0 when it was not reached.
    pub status: u16,
    pub message: String,
    /// planbar has the SlateDesk endpoints (false → «planbar-Update nötig»).
    pub dashboard: bool,
    /// People in the organisation; null when `/mitglieder` is not readable with this key.
    pub members: Option<usize>,
    /// null when planbar lacks the endpoints (or was not reached).
    pub scopes: Option<PlanbarScopes>,
}

impl PlanbarTestResult {
    fn failed(status: u16, error: &PlanbarError) -> Self {
        PlanbarTestResult {
            ok: false,
            status,
            message: error.to_string(),
            dashboard: false,
            members: None,
            scopes: None,
        }
    }
}

/// Outcome of one probe of the connection test.
#[derive(Debug, PartialEq, Eq)]
enum Access {
    Granted,
    Denied,
    Missing,
    Failed(u16, PlanbarError),
}

impl Access {
    fn of(upstream: &Upstream) -> Self {
        if upstream.status.is_success() {
            // A web server that answers every path (wrong address) is no planbar.
            return match json_body(&upstream.content_type, &upstream.body) {
                Some(_) => Access::Granted,
                None => Access::Failed(
                    upstream.status.as_u16(),
                    PlanbarError::InvalidResponse("kein JSON".to_string()),
                ),
            };
        }
        match status_error(upstream.status, &upstream.content_type, &upstream.body) {
            PlanbarError::Forbidden(_) => Access::Denied,
            PlanbarError::EndpointMissing => Access::Missing,
            // planbar validates parameters and looks items up only after the key passed the
            // scope check, so these answers prove the right without reading or changing data.
            PlanbarError::Status(400, _) | PlanbarError::NotFound(_) => Access::Granted,
            error => Access::Failed(upstream.status.as_u16(), error),
        }
    }
}

pub struct PlanbarService {
    client: Client,
    json_cache: Mutex<HashMap<String, (Instant, Value)>>,
}

impl PlanbarService {
    /// `client` must not follow redirects away from the API root (`http::build_api_client`).
    pub fn new(client: Client) -> Self {
        PlanbarService {
            client,
            json_cache: Mutex::new(HashMap::new()),
        }
    }

    async fn request(
        &self,
        config: &PlanbarConfig,
        method: Method,
        url: Url,
        body: Option<&Value>,
    ) -> Result<Upstream, PlanbarError> {
        let mut builder = self
            .client
            .request(method, url)
            .bearer_auth(&config.api_key)
            .header(ACCEPT, "application/json")
            .timeout(REQUEST_TIMEOUT);
        if let Some(body) = body {
            builder = builder.json(body);
        }
        let response = builder
            .send()
            .await
            .map_err(|e| PlanbarError::Unreachable(describe_error(&e)))?;
        let status = response.status();
        // The client stops at redirects that leave the API root; such an answer is never
        // passed on.
        if status.is_redirection() {
            return Err(PlanbarError::Redirected(status.as_u16()));
        }
        let content_type = content_type(response.headers());
        let body = read_body_limited(response, JSON_MAX_BYTES)
            .await
            .map_err(PlanbarError::Unreachable)?;
        Ok(Upstream {
            status,
            content_type,
            body,
        })
    }

    fn cached_json(&self, key: &str) -> Option<Value> {
        let cache = lock(&self.json_cache);
        cache
            .get(key)
            .filter(|(at, _)| at.elapsed() < JSON_CACHE_TTL)
            .map(|(_, v)| v.clone())
    }

    fn store_json(&self, key: String, value: Value) {
        let mut cache = lock(&self.json_cache);
        cache.retain(|_, (at, _)| at.elapsed() < JSON_CACHE_TTL);
        if cache.len() >= JSON_CACHE_MAX {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache.insert(key, (Instant::now(), value));
    }

    /// `planbar_get`: JSON from `{planbar.url}/api/v1/…`, cached 15 s per url+key.
    pub async fn get_json(
        &self,
        state: &Value,
        path: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<Value, PlanbarError> {
        let config = PlanbarConfig::from_state(state, true)?;
        validate_api_path(path)?;
        if query.len() > MAX_QUERY_PARAMS {
            return Err(PlanbarError::InvalidPath("zu viele Parameter".to_string()));
        }
        let mut url = config.api_url(path)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter());
        }
        let key = format!("{}|{url}", config.fingerprint());
        if let Some(hit) = self.cached_json(&key) {
            return Ok(hit);
        }
        let value = self
            .request(&config, Method::GET, url, None)
            .await?
            .for_route(path)
            .into_json()?;
        self.store_json(key, value.clone());
        Ok(value)
    }

    /// Ticks off / reopens a task. A change drops the GET cache, so the next poll shows it
    /// (and the new instance of a recurring task) right away.
    async fn patch_work_item(
        &self,
        state: &Value,
        path: &str,
        body: &Value,
    ) -> Result<Upstream, PlanbarError> {
        let config = PlanbarConfig::from_state(state, true)?;
        validate_patch_path(path)?;
        validate_patch_body(body)?;
        let url = config.api_url(path)?;
        let upstream = self
            .request(&config, Method::PATCH, url, Some(body))
            .await?;
        if upstream.status.is_success() {
            lock(&self.json_cache).clear();
        }
        Ok(upstream)
    }

    /// `planbar_patch`: `PATCH /api/v1/arbeitsliste/<id>` with `{ "completed": bool }`.
    pub async fn patch_json(
        &self,
        state: &Value,
        path: &str,
        body: &Value,
    ) -> Result<Value, PlanbarError> {
        self.patch_work_item(state, path, body).await?.into_json()
    }

    /// Web UI proxy: `GET {planbar.url}/api/v1/{sub_path}?{query}` for the dashboard routes
    /// ([`validate_proxy_path`]) with status and JSON passed through.
    pub async fn proxy_get(
        &self,
        state: &Value,
        sub_path: &str,
        raw_query: Option<&str>,
    ) -> Result<ProxyResponse, PlanbarError> {
        let sub_path = sub_path.trim_start_matches('/');
        let path = format!("{API_PREFIX}{sub_path}");
        validate_api_path(&path)?;
        validate_proxy_path(sub_path)?;
        let config = PlanbarConfig::from_state(state, true)?;
        let mut url = config.api_url(&path)?;
        if let Some(query) = raw_query.filter(|q| !q.is_empty()) {
            if query
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '#')
            {
                return Err(PlanbarError::InvalidPath("ungültige Parameter".to_string()));
            }
            url.set_query(Some(query));
        }
        Ok(self
            .request(&config, Method::GET, url, None)
            .await?
            .for_route(&path)
            .into_proxy())
    }

    /// Web UI proxy for `PATCH /api/planbar/arbeitsliste/{id}` – same rules as `planbar_patch`.
    pub async fn proxy_patch(
        &self,
        state: &Value,
        sub_path: &str,
        body: &[u8],
    ) -> Result<ProxyResponse, PlanbarError> {
        let path = format!("{API_PREFIX}{}", sub_path.trim_start_matches('/'));
        validate_patch_path(&path)?;
        let body: Value = serde_json::from_slice(body).map_err(|_| PlanbarError::InvalidBody)?;
        Ok(self
            .patch_work_item(state, &path, &body)
            .await?
            .into_proxy())
    }

    async fn probe(
        &self,
        config: &PlanbarConfig,
        method: Method,
        path: &str,
        query: &str,
        body: Option<&Value>,
    ) -> Result<Upstream, PlanbarError> {
        let mut url = config.api_url(path)?;
        url.set_query(Some(query).filter(|q| !q.is_empty()));
        Ok(self
            .request(config, method, url, body)
            .await?
            .for_route(path))
    }

    /// Connection test for the settings page; works before planbar is switched on. Tells an
    /// old planbar («Update nötig») from a wrong key and reports the key's rights. The probes
    /// send no parameters (or an unknown task id), so they read and change nothing.
    pub async fn test(&self, state: &Value) -> PlanbarTestResult {
        let config = match PlanbarConfig::from_state(state, false) {
            Ok(config) => config,
            Err(e) => return PlanbarTestResult::failed(0, &e),
        };
        let empty = json!({});
        let (members, work, write, projects, news) = tokio::join!(
            self.probe(&config, Method::GET, "/api/v1/mitglieder", "", None),
            self.probe(&config, Method::GET, "/api/v1/arbeitsliste", "", None),
            self.probe(&config, Method::PATCH, PROBE_ITEM_PATH, "", Some(&empty)),
            self.probe(
                &config,
                Method::GET,
                "/api/v1/projektuebersicht",
                "pageSize=1",
                None
            ),
            self.probe(&config, Method::GET, "/api/v1/news", "limit=1", None),
        );

        let members = match members {
            Ok(members) => members,
            Err(e) => return PlanbarTestResult::failed(0, &e),
        };
        let member_count = match Access::of(&members) {
            Access::Granted => json_body(&members.content_type, &members.body)
                .as_ref()
                .and_then(|v| v.get("data"))
                .and_then(Value::as_array)
                .map(Vec::len),
            // An old planbar wants `kunden:read` for `/mitglieder`; the dashboard does not.
            Access::Denied => None,
            // `/mitglieder` exists in every planbar version.
            Access::Missing => {
                return PlanbarTestResult {
                    message: "Unter dieser Adresse antwortet kein planbar (404) – Adresse prüfen"
                        .to_string(),
                    ..PlanbarTestResult::failed(404, &PlanbarError::EndpointMissing)
                }
            }
            Access::Failed(status, error) => return PlanbarTestResult::failed(status, &error),
        };

        let mut access = Vec::with_capacity(4);
        for result in [work, write, projects, news] {
            match result.map(|upstream| Access::of(&upstream)) {
                Ok(Access::Failed(status, error)) => {
                    return PlanbarTestResult::failed(status, &error)
                }
                Ok(outcome) => access.push(outcome),
                Err(e) => return PlanbarTestResult::failed(0, &e),
            }
        }
        let status = members.status.as_u16();
        if access[0] == Access::Missing {
            return PlanbarTestResult {
                ok: true,
                status,
                message: "Verbunden, aber planbar-Update nötig (Arbeitsliste fehlt)".to_string(),
                dashboard: false,
                members: member_count,
                scopes: None,
            };
        }

        let scopes = PlanbarScopes {
            aufgaben: access[0] == Access::Granted,
            aufgaben_schreiben: access[1] == Access::Granted,
            projekte: access[2] == Access::Granted,
            news: access[3] == Access::Granted,
        };
        let missing: Vec<&str> = [
            (scopes.aufgaben, "Aufgaben & Zeiten lesen"),
            (scopes.projekte, "Projekte lesen"),
            (scopes.news, "News lesen"),
        ]
        .into_iter()
        .filter(|(granted, _)| !granted)
        .map(|(_, label)| label)
        .collect();
        let message = if missing.is_empty() {
            "Verbindung zu planbar hergestellt".to_string()
        } else {
            format!(
                "Verbunden, aber dem API-Schlüssel fehlen Rechte: {}",
                missing.join(", ")
            )
        };
        PlanbarTestResult {
            ok: true,
            status,
            message,
            dashboard: true,
            members: member_count,
            scopes: Some(scopes),
        }
    }
}

#[tauri::command]
pub async fn planbar_get(
    path: String,
    query: Option<HashMap<String, String>>,
    store: State<'_, Arc<StateStore>>,
    planbar: State<'_, Arc<PlanbarService>>,
) -> Result<Value, String> {
    let query: BTreeMap<String, String> = query.unwrap_or_default().into_iter().collect();
    let snapshot = store.snapshot();
    planbar
        .get_json(&snapshot.state, &path, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn planbar_patch(
    path: String,
    body: Value,
    store: State<'_, Arc<StateStore>>,
    planbar: State<'_, Arc<PlanbarService>>,
) -> Result<Value, String> {
    let snapshot = store.snapshot();
    planbar
        .patch_json(&snapshot.state, &path, &body)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// May read and write everything.
    pub(crate) const KEY: &str = "pk_live_voll";
    /// Lacks `aufgaben:write` and `news:read`.
    pub(crate) const READ_ONLY_KEY: &str = "pk_live_lesen";

    pub(crate) fn state_for(url: &str, key: &str) -> Value {
        json!({ "planbar": { "enabled": true, "url": url, "apiKey": key } })
    }

    fn service() -> PlanbarService {
        PlanbarService::new(crate::http::build_api_client().unwrap())
    }

    fn config(url: &str) -> PlanbarConfig {
        PlanbarConfig::from_state(&state_for(url, KEY), true).unwrap()
    }

    /// Minimal planbar stand-in on a random local port. Without `dashboard` it mimics a
    /// planbar version without the SlateDesk endpoints (Next's HTML 404 – except for
    /// `/zeiten/zusammenfassung`, which `/zeiten/{id}` answers there). Counts the
    /// Arbeitsliste requests that reached it.
    pub(crate) async fn fake_planbar(dashboard: bool) -> (String, Arc<AtomicUsize>) {
        use axum::extract::{Path, RawQuery};
        use axum::http::{HeaderMap, StatusCode as AxStatus};
        use axum::response::{IntoResponse, Response};
        use axum::routing::get;
        use axum::Json;

        enum Caller {
            Full,
            ReadOnly,
            Unknown,
        }

        fn caller(headers: &HeaderMap) -> Caller {
            let key = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "));
            match key {
                Some(KEY) => Caller::Full,
                Some(READ_ONLY_KEY) => Caller::ReadOnly,
                _ => Caller::Unknown,
            }
        }

        fn error(status: AxStatus, message: &str) -> Response {
            (status, Json(json!({ "error": message }))).into_response()
        }

        fn unauthorized() -> Response {
            error(AxStatus::UNAUTHORIZED, "API-Schlüssel wurde widerrufen")
        }

        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let mut app = axum::Router::new()
            .route(
                "/api/v1/mitglieder",
                get(|headers: HeaderMap| async move {
                    if let Caller::Unknown = caller(&headers) {
                        return unauthorized();
                    }
                    Json(json!({ "data": [
                        { "id": "u1", "name": "Anna Muster", "email": "anna@example.ch", "role": "member", "teams": [] },
                        { "id": "u2", "name": "", "email": "carla@example.ch", "role": "koordinator", "teams": [] }
                    ] }))
                    .into_response()
                }),
            )
            .route(
                "/api/v1/zeiten/{id}",
                get(|headers: HeaderMap| async move {
                    if let Caller::Unknown = caller(&headers) {
                        return unauthorized();
                    }
                    error(AxStatus::NOT_FOUND, "Zeiteintrag nicht gefunden")
                }),
            )
            .fallback(|| async {
                (
                    AxStatus::NOT_FOUND,
                    [("content-type", "text/html; charset=utf-8")],
                    "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>",
                )
            });
        if dashboard {
            app = app
                .route(
                    "/api/v1/arbeitsliste",
                    get(move |headers: HeaderMap, RawQuery(query): RawQuery| {
                        let counter = Arc::clone(&counter);
                        async move {
                            if let Caller::Unknown = caller(&headers) {
                                return unauthorized();
                            }
                            let query = query.unwrap_or_default();
                            if !query.contains("benutzer=") {
                                return error(
                                    AxStatus::BAD_REQUEST,
                                    "Parameter \"benutzer\" ist erforderlich",
                                );
                            }
                            counter.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "data": [], "total": 0, "limit": 50, "today": "2026-10-13", "query": query }))
                                .into_response()
                        }
                    }),
                )
                .route(
                    "/api/v1/arbeitsliste/{id}",
                    axum::routing::patch(
                        |headers: HeaderMap, Path(id): Path<String>, body: String| async move {
                            match caller(&headers) {
                                Caller::Unknown => return unauthorized(),
                                Caller::ReadOnly => {
                                    return error(
                                        AxStatus::FORBIDDEN,
                                        "Fehlende Berechtigung: aufgaben:write",
                                    )
                                }
                                Caller::Full => {}
                            }
                            let body: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
                            let Some(completed) = body.get("completed").and_then(Value::as_bool)
                            else {
                                return error(
                                    AxStatus::BAD_REQUEST,
                                    "Feld \"completed\" (true oder false) ist erforderlich",
                                );
                            };
                            if id != "a1" {
                                return error(AxStatus::NOT_FOUND, "Aufgabe nicht gefunden");
                            }
                            Json(json!({ "data": { "id": id, "done": completed }, "nextInstanceId": null }))
                                .into_response()
                        },
                    ),
                )
                .route(
                    "/api/v1/projektuebersicht",
                    get(|headers: HeaderMap| async move {
                        if let Caller::Unknown = caller(&headers) {
                            return unauthorized();
                        }
                        Json(json!({ "data": [], "page": 1, "pageSize": 1, "total": 0 }))
                            .into_response()
                    }),
                )
                .route(
                    "/api/v1/news",
                    get(|headers: HeaderMap| async move {
                        match caller(&headers) {
                            Caller::Unknown => unauthorized(),
                            Caller::ReadOnly => {
                                error(AxStatus::FORBIDDEN, "Fehlende Berechtigung: news:read")
                            }
                            Caller::Full => Json(json!({ "data": [], "total": 0, "limit": 1 }))
                                .into_response(),
                        }
                    }),
                )
                .route(
                    "/api/v1/zeiten/zusammenfassung",
                    get(|headers: HeaderMap| async move {
                        if let Caller::Unknown = caller(&headers) {
                            return unauthorized();
                        }
                        Json(json!({ "data": [], "today": "2026-10-13", "weekStart": "2026-10-12" }))
                            .into_response()
                    }),
                );
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (format!("http://{addr}"), hits)
    }

    #[test]
    fn config_requires_key_and_respects_enabled() {
        assert_eq!(
            PlanbarConfig::from_state(&json!({}), false).unwrap_err(),
            PlanbarError::NotConfigured
        );
        let disabled = json!({ "planbar": { "enabled": false, "apiKey": "k" } });
        assert_eq!(
            PlanbarConfig::from_state(&disabled, true).unwrap_err(),
            PlanbarError::NotConfigured
        );
        assert!(PlanbarConfig::from_state(&disabled, false).is_ok());
        let blank_key = json!({ "planbar": { "enabled": true, "apiKey": "  " } });
        assert_eq!(
            PlanbarConfig::from_state(&blank_key, true).unwrap_err(),
            PlanbarError::NotConfigured
        );
        // The lagra token is no planbar key.
        let other =
            json!({ "lagra": { "enabled": true, "token": "t" }, "planbar": { "enabled": true } });
        assert_eq!(
            PlanbarConfig::from_state(&other, true).unwrap_err(),
            PlanbarError::NotConfigured
        );
        // Same defaults as the frontend: without `enabled` planbar is off, without `url` the
        // public host is used.
        let defaults = json!({ "planbar": { "apiKey": "k" } });
        assert_eq!(
            PlanbarConfig::from_state(&defaults, true).unwrap_err(),
            PlanbarError::NotConfigured
        );
        assert_eq!(
            PlanbarConfig::from_state(&defaults, false)
                .unwrap()
                .api_root(),
            "https://planbar.dev/api/v1/"
        );
        for bad in ["ftp://planbar.dev", "planbar.dev", "https://"] {
            let state = json!({ "planbar": { "enabled": true, "apiKey": "k", "url": bad } });
            assert_eq!(
                PlanbarConfig::from_state(&state, true).unwrap_err(),
                PlanbarError::InvalidBaseUrl,
                "{bad}"
            );
        }
        let cfg = config("https://planbar.example.ch/?x=1#y");
        assert_eq!(
            cfg.api_url("/api/v1/arbeitsliste").unwrap().as_str(),
            "https://planbar.example.ch/api/v1/arbeitsliste"
        );
        assert_ne!(
            cfg.fingerprint(),
            PlanbarConfig::from_state(&state_for("https://planbar.example.ch", "anders"), true)
                .unwrap()
                .fingerprint()
        );
        assert!(!cfg.fingerprint().contains(KEY));
        assert!(!format!("{cfg:?}").contains(KEY));
    }

    #[test]
    fn api_paths_are_validated() {
        for good in [
            "/api/v1/arbeitsliste",
            "/api/v1/zeiten/zusammenfassung",
            "/api/v1/mitglieder",
        ] {
            assert!(validate_api_path(good).is_ok(), "{good}");
        }
        for bad in [
            "/api/v2/x",
            "api/v1/x",
            "/api/v1/",
            "/api/v1/../admin",
            "/api/v1//x",
            "/api/v1/a?b=c",
            "/api/v1/a#b",
            "/api/v1/a b",
            "/api/v1/%2e%2e",
            "/api/v1/ü",
        ] {
            assert!(validate_api_path(bad).is_err(), "{bad}");
        }
        assert!(validate_api_path(&format!("/api/v1/{}", "a".repeat(MAX_PATH_LEN))).is_err());
        for route in PROXY_ROUTES {
            assert!(validate_proxy_path(route).is_ok(), "{route}");
        }
        for denied in ["offerten", "abos", "zeiten", "zeiten/zusammenfassung/x", ""] {
            assert!(validate_proxy_path(denied).is_err(), "{denied}");
        }
    }

    #[test]
    fn only_work_list_items_may_be_changed() {
        for good in [
            "/api/v1/arbeitsliste/cmv6tqqdj0014vtinkfhznupr",
            "/api/v1/arbeitsliste/a_b-1",
        ] {
            assert!(validate_patch_path(good).is_ok(), "{good}");
        }
        for bad in [
            "/api/v1/arbeitsliste",
            "/api/v1/arbeitsliste/",
            "/api/v1/arbeitsliste/a/b",
            "/api/v1/arbeitsliste/a.b",
            "/api/v1/arbeitsliste/..",
            "/api/v1/arbeitsliste/a?completed=1",
            "/api/v1/projekte/p1/aufgaben/a1",
            "/api/v1/tickets",
            "/api/v1/zeiten",
        ] {
            assert_eq!(
                validate_patch_path(bad),
                Err(PlanbarError::WriteNotAllowed),
                "{bad}"
            );
        }
        assert!(validate_patch_path(&format!("{WORK_ITEM_PREFIX}{}", "a".repeat(65))).is_err());

        assert!(validate_patch_body(&json!({ "completed": true })).is_ok());
        assert!(validate_patch_body(&json!({ "completed": false })).is_ok());
        for bad in [
            json!({}),
            json!({ "completed": "true" }),
            json!({ "completed": 1 }),
            json!({ "completed": true, "title": "Neu" }),
            json!([{ "completed": true }]),
            json!(true),
        ] {
            assert_eq!(
                validate_patch_body(&bad),
                Err(PlanbarError::InvalidBody),
                "{bad}"
            );
        }
    }

    #[test]
    fn html_404_means_missing_endpoint() {
        let html = b"<!DOCTYPE html><html><body>404</body></html>";
        let json_type = "application/json; charset=utf-8";
        assert_eq!(
            status_error(StatusCode::NOT_FOUND, "text/html; charset=utf-8", html),
            PlanbarError::EndpointMissing
        );
        // Even a JSON-looking body does not count when planbar says it is HTML.
        assert_eq!(
            status_error(StatusCode::NOT_FOUND, "text/html", br#"{"error":"x"}"#),
            PlanbarError::EndpointMissing
        );
        assert_eq!(
            status_error(StatusCode::NOT_FOUND, "", b""),
            PlanbarError::EndpointMissing
        );
        assert_eq!(
            status_error(
                StatusCode::NOT_FOUND,
                json_type,
                br#"{"error":"Aufgabe nicht gefunden"}"#
            ),
            PlanbarError::NotFound(Some("Aufgabe nicht gefunden".into()))
        );
        // Without a content type the body decides.
        assert_eq!(
            status_error(StatusCode::NOT_FOUND, "", br#"{"error":"weg"}"#),
            PlanbarError::NotFound(Some("weg".into()))
        );
        assert_eq!(
            status_error(StatusCode::NOT_FOUND, "application/problem+json", b"{}"),
            PlanbarError::NotFound(None)
        );
    }

    #[test]
    fn errors_carry_planbar_reasons_in_german() {
        let json_type = "application/json";
        assert_eq!(
            PlanbarError::NotConfigured.to_string(),
            "planbar ist nicht eingerichtet"
        );
        assert_eq!(
            status_error(StatusCode::UNAUTHORIZED, json_type, b"{}").to_string(),
            "planbar: API-Schlüssel ungültig (401)"
        );
        assert_eq!(
            status_error(
                StatusCode::UNAUTHORIZED,
                json_type,
                r#"{"error":"API-Schlüssel ist abgelaufen"}"#.as_bytes()
            )
            .to_string(),
            "planbar: API-Schlüssel ungültig (401) – API-Schlüssel ist abgelaufen"
        );
        assert_eq!(
            status_error(
                StatusCode::FORBIDDEN,
                json_type,
                br#"{"error":"Fehlende Berechtigung: news:read"}"#
            )
            .to_string(),
            "planbar: Berechtigung fehlt – Fehlende Berechtigung: news:read"
        );
        assert_eq!(
            status_error(StatusCode::FORBIDDEN, "text/html", b"<html>").to_string(),
            "planbar: Berechtigung fehlt (403)"
        );
        assert_eq!(
            PlanbarError::EndpointMissing.to_string(),
            "planbar: Endpunkt fehlt (404) – planbar-Update nötig"
        );
        assert_eq!(
            PlanbarError::NotFound(None).to_string(),
            "planbar: nicht gefunden"
        );
        assert_eq!(
            status_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                json_type,
                br#"{"error":"Interner Serverfehler"}"#
            )
            .to_string(),
            "planbar: Fehler 500 – Interner Serverfehler"
        );
        assert_eq!(
            status_error(StatusCode::BAD_GATEWAY, "text/html", b"<html>").to_string(),
            "planbar: Fehler 502"
        );
        assert!(PlanbarError::Unreachable("Zeitüberschreitung".into())
            .to_string()
            .starts_with("planbar nicht erreichbar: "));
        let long = format!(r#"{{"error":"{}"}}"#, "x".repeat(500));
        let PlanbarError::Status(_, Some(msg)) =
            status_error(StatusCode::BAD_REQUEST, json_type, long.as_bytes())
        else {
            panic!("Status mit Text erwartet");
        };
        assert_eq!(msg.len(), 200);
    }

    #[test]
    fn proxy_passes_json_and_drops_html() {
        let html = Upstream {
            status: StatusCode::NOT_FOUND,
            content_type: "text/html".into(),
            body: b"<html><script>alert(1)</script></html>".to_vec(),
        }
        .into_proxy();
        assert_eq!(html.status, 404);
        assert_eq!(html.content_type, PLAIN_TEXT);
        assert!(html.body.is_empty());

        let json = Upstream {
            status: StatusCode::FORBIDDEN,
            content_type: "application/json; charset=utf-8".into(),
            body: br#"{"error":"Fehlende Berechtigung: news:read"}"#.to_vec(),
        }
        .into_proxy();
        assert_eq!(json.status, 403);
        assert_eq!(json.content_type, "application/json; charset=utf-8");
        assert_eq!(
            json.body,
            br#"{"error":"Fehlende Berechtigung: news:read"}"#
        );

        let untyped = Upstream {
            status: StatusCode::OK,
            content_type: String::new(),
            body: b"[]".to_vec(),
        }
        .into_proxy();
        assert_eq!(untyped.content_type, "application/json");
        assert_eq!(untyped.body, b"[]");
        assert!(json.cache_control.is_none());
    }

    #[test]
    fn probes_read_rights_from_the_answer() {
        let answer = |status: u16, content_type: &str, body: &str| Upstream {
            status: StatusCode::from_u16(status).unwrap(),
            content_type: content_type.into(),
            body: body.as_bytes().to_vec(),
        };
        let json_type = "application/json";
        assert_eq!(Access::of(&answer(200, json_type, "{}")), Access::Granted);
        assert_eq!(
            Access::of(&answer(200, "text/html", "<html>")),
            Access::Failed(200, PlanbarError::InvalidResponse("kein JSON".into()))
        );
        assert_eq!(
            Access::of(&answer(400, json_type, r#"{"error":"Parameter fehlt"}"#)),
            Access::Granted
        );
        assert_eq!(
            Access::of(&answer(
                404,
                json_type,
                r#"{"error":"Aufgabe nicht gefunden"}"#
            )),
            Access::Granted
        );
        assert_eq!(
            Access::of(&answer(
                403,
                json_type,
                r#"{"error":"Fehlende Berechtigung"}"#
            )),
            Access::Denied
        );
        assert_eq!(
            Access::of(&answer(404, "text/html", "<html>")),
            Access::Missing
        );
        assert!(matches!(
            Access::of(&answer(401, json_type, "{}")),
            Access::Failed(401, PlanbarError::Unauthorized(None))
        ));
        assert!(matches!(
            Access::of(&answer(500, json_type, "{}")),
            Access::Failed(500, PlanbarError::Status(500, None))
        ));
    }

    #[tokio::test]
    async fn test_tells_a_wrong_address() {
        use axum::http::StatusCode as AxStatus;

        async fn serve_everything_with(status: AxStatus) -> String {
            let app = axum::Router::new().fallback(move || async move {
                (
                    status,
                    [("content-type", "text/html")],
                    "<html>Anmelden</html>",
                )
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            format!("http://{addr}")
        }

        let service = service();
        let page = serve_everything_with(AxStatus::OK).await;
        let result = service.test(&state_for(&page, KEY)).await;
        assert!(!result.ok);
        assert_eq!(result.status, 200);
        assert_eq!(result.message, "planbar: ungültige Antwort (kein JSON)");

        let missing = serve_everything_with(AxStatus::NOT_FOUND).await;
        let result = service.test(&state_for(&missing, KEY)).await;
        assert!(!result.ok);
        assert_eq!(result.status, 404);
        assert_eq!(
            result.message,
            "Unter dieser Adresse antwortet kein planbar (404) – Adresse prüfen"
        );

        // A login redirect (SSO in front of planbar) is never followed with the key.
        let login = serve_everything_with(AxStatus::FOUND).await;
        let result = service.test(&state_for(&login, KEY)).await;
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "planbar: Weiterleitung auf eine andere Adresse (302) – planbar-Adresse prüfen"
        );
    }

    #[tokio::test]
    async fn unconfigured_planbar_needs_no_network() {
        let service = service();
        let result = service.test(&json!({})).await;
        assert_eq!(
            result,
            PlanbarTestResult::failed(0, &PlanbarError::NotConfigured)
        );
        assert_eq!(
            service
                .get_json(&json!({}), "/api/v1/mitglieder", &BTreeMap::new())
                .await
                .unwrap_err(),
            PlanbarError::NotConfigured
        );
        assert_eq!(
            service
                .patch_json(
                    &json!({}),
                    "/api/v1/arbeitsliste/a1",
                    &json!({ "completed": true })
                )
                .await
                .unwrap_err(),
            PlanbarError::NotConfigured
        );
        let state = state_for("http://127.0.0.1:9", KEY);
        assert_eq!(
            service
                .patch_json(&state, "/api/v1/tickets", &json!({ "completed": true }))
                .await
                .unwrap_err(),
            PlanbarError::WriteNotAllowed
        );
        assert_eq!(
            service
                .proxy_patch(&state, "arbeitsliste/a1", b"kein json")
                .await
                .unwrap_err(),
            PlanbarError::InvalidBody
        );
        let unreachable = service.test(&state).await;
        assert!(!unreachable.ok);
        assert_eq!(unreachable.status, 0);
        assert!(unreachable
            .message
            .starts_with("planbar nicht erreichbar: "));
    }

    #[tokio::test]
    async fn talks_to_planbar_with_the_key_and_caches_reads() {
        let (url, hits) = fake_planbar(true).await;
        let service = service();
        let state = state_for(&url, KEY);
        let query = BTreeMap::from([
            ("benutzer".to_string(), "u1,u2".to_string()),
            ("limit".to_string(), "5".to_string()),
        ]);

        let first = service
            .get_json(&state, "/api/v1/arbeitsliste", &query)
            .await
            .unwrap();
        assert_eq!(first["query"], json!("benutzer=u1%2Cu2&limit=5"));
        let second = service
            .get_json(&state, "/api/v1/arbeitsliste", &query)
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        // A change drops the cache: the next read goes to planbar again.
        let changed = service
            .patch_json(
                &state,
                "/api/v1/arbeitsliste/a1",
                &json!({ "completed": true }),
            )
            .await
            .unwrap();
        assert_eq!(changed["data"], json!({ "id": "a1", "done": true }));
        service
            .get_json(&state, "/api/v1/arbeitsliste", &query)
            .await
            .unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        assert_eq!(
            service
                .patch_json(
                    &state,
                    "/api/v1/arbeitsliste/fehlt",
                    &json!({ "completed": false })
                )
                .await
                .unwrap_err(),
            PlanbarError::NotFound(Some("Aufgabe nicht gefunden".into()))
        );
        let read_only = state_for(&url, READ_ONLY_KEY);
        assert_eq!(
            service
                .patch_json(
                    &read_only,
                    "/api/v1/arbeitsliste/a1",
                    &json!({ "completed": true })
                )
                .await
                .unwrap_err()
                .to_string(),
            "planbar: Berechtigung fehlt – Fehlende Berechtigung: aufgaben:write"
        );
        let revoked = state_for(&url, "pk_live_alt");
        assert_eq!(
            service
                .get_json(&revoked, "/api/v1/mitglieder", &BTreeMap::new())
                .await
                .unwrap_err(),
            PlanbarError::Unauthorized(Some("API-Schlüssel wurde widerrufen".into()))
        );
        assert_eq!(
            service
                .get_json(&state, "/api/v1/gibts-nicht", &BTreeMap::new())
                .await
                .unwrap_err(),
            PlanbarError::EndpointMissing
        );
    }

    #[tokio::test]
    async fn proxy_passes_planbar_answers_through() {
        let (url, _) = fake_planbar(true).await;
        let service = service();
        let state = state_for(&url, KEY);

        let members = service.proxy_get(&state, "mitglieder", None).await.unwrap();
        assert_eq!(members.status, 200);
        assert!(members.content_type.starts_with("application/json"));
        let body: Value = serde_json::from_slice(&members.body).unwrap();
        assert_eq!(body["data"].as_array().map(Vec::len), Some(2));

        let work = service
            .proxy_get(&state, "/arbeitsliste", Some("benutzer=u1&typ=aufgabe"))
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&work.body).unwrap();
        assert_eq!(body["query"], json!("benutzer=u1&typ=aufgabe"));

        let denied = service
            .proxy_get(&state_for(&url, "falsch"), "mitglieder", None)
            .await
            .unwrap();
        assert_eq!(denied.status, 401);
        // Only the dashboard routes are read for the web UI, whatever the key may read.
        for denied in [
            "gibts-nicht",
            "rechnungen",
            "kunden",
            "zeiten",
            "arbeitsliste/a1",
        ] {
            assert_eq!(
                service.proxy_get(&state, denied, None).await.unwrap_err(),
                PlanbarError::ReadNotAllowed(denied.into()),
                "{denied}"
            );
        }
        assert!(service.proxy_get(&state, "../geheim", None).await.is_err());
        assert!(service
            .proxy_get(&state, "news", Some("a=b#c"))
            .await
            .is_err());

        let ticked = service
            .proxy_patch(&state, "arbeitsliste/a1", br#"{"completed":false}"#)
            .await
            .unwrap();
        assert_eq!(ticked.status, 200);
        let forbidden = service
            .proxy_patch(
                &state_for(&url, READ_ONLY_KEY),
                "arbeitsliste/a1",
                br#"{"completed":true}"#,
            )
            .await
            .unwrap();
        assert_eq!(forbidden.status, 403);
        assert_eq!(
            service
                .proxy_patch(&state, "mitglieder", br#"{"completed":true}"#)
                .await
                .unwrap_err(),
            PlanbarError::WriteNotAllowed
        );
        assert_eq!(
            service
                .proxy_patch(
                    &state,
                    "arbeitsliste/a1",
                    br#"{"completed":true,"title":"x"}"#
                )
                .await
                .unwrap_err(),
            PlanbarError::InvalidBody
        );
    }

    #[tokio::test]
    async fn test_reports_rights_and_old_planbar_versions() {
        let (url, _) = fake_planbar(true).await;
        let service = service();

        let full = service.test(&state_for(&url, KEY)).await;
        assert_eq!(
            full,
            PlanbarTestResult {
                ok: true,
                status: 200,
                message: "Verbindung zu planbar hergestellt".into(),
                dashboard: true,
                members: Some(2),
                scopes: Some(PlanbarScopes {
                    aufgaben: true,
                    aufgaben_schreiben: true,
                    projekte: true,
                    news: true,
                }),
            }
        );
        assert_eq!(
            serde_json::to_value(&full).unwrap()["scopes"]["aufgabenSchreiben"],
            json!(true)
        );

        let limited = service.test(&state_for(&url, READ_ONLY_KEY)).await;
        assert!(limited.ok && limited.dashboard);
        assert_eq!(
            limited.message,
            "Verbunden, aber dem API-Schlüssel fehlen Rechte: News lesen"
        );
        assert_eq!(
            limited.scopes,
            Some(PlanbarScopes {
                aufgaben: true,
                aufgaben_schreiben: false,
                projekte: true,
                news: false,
            })
        );

        let revoked = service.test(&state_for(&url, "pk_live_alt")).await;
        assert!(!revoked.ok);
        assert_eq!(revoked.status, 401);
        assert_eq!(
            revoked.message,
            "planbar: API-Schlüssel ungültig (401) – API-Schlüssel wurde widerrufen"
        );

        // Switched off still tests (the settings page tests before switching on).
        let mut disabled = state_for(&url, KEY);
        disabled["planbar"]["enabled"] = json!(false);
        assert!(service.test(&disabled).await.ok);

        let (old_url, _) = fake_planbar(false).await;
        let old = service.test(&state_for(&old_url, KEY)).await;
        assert!(old.ok);
        assert!(!old.dashboard);
        assert_eq!(old.members, Some(2));
        assert_eq!(old.scopes, None);
        assert!(old.message.contains("planbar-Update nötig"));
    }

    #[tokio::test]
    async fn old_planbar_lacks_the_time_summary_despite_its_json_404() {
        let service = service();
        let summary = "/api/v1/zeiten/zusammenfassung";

        let (old_url, _) = fake_planbar(false).await;
        let old = state_for(&old_url, KEY);
        assert_eq!(
            service
                .get_json(&old, summary, &BTreeMap::new())
                .await
                .unwrap_err(),
            PlanbarError::EndpointMissing
        );
        let proxied = service
            .proxy_get(&old, "zeiten/zusammenfassung", None)
            .await
            .unwrap();
        assert_eq!((proxied.status, proxied.body.len()), (404, 0));
        assert_eq!(proxied.content_type, PLAIN_TEXT);
        // Other routes keep planbar's «not found».
        assert_eq!(
            service
                .get_json(&old, "/api/v1/zeiten/z1", &BTreeMap::new())
                .await
                .unwrap_err(),
            PlanbarError::NotFound(Some("Zeiteintrag nicht gefunden".into()))
        );

        let (url, _) = fake_planbar(true).await;
        let current = service
            .get_json(&state_for(&url, KEY), summary, &BTreeMap::new())
            .await
            .unwrap();
        assert_eq!(current["weekStart"], json!("2026-10-12"));
    }
}
