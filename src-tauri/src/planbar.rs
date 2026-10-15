//! planbar integration – the work dashboard (tasks, projects, news, booked time). planbar's
//! `/api/v1` needs an API key and sends no CORS headers, so every call (kiosk commands and
//! the web UI proxy) goes through here; the keys never leave Rust. A key belongs to exactly
//! one planbar organisation, so `planbar.unternehmen` holds one key per Unternehmen and every
//! request names the Unternehmen it is for.

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
const MAX_ORG_ID_LEN: usize = 40;
const MAX_ORG_NAME_LEN: usize = 60;
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
    /// Several Unternehmen have a key and the request names none.
    OrgRequired,
    /// The named Unternehmen does not exist or has no key (its name, else the id).
    OrgNotConfigured(String),
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
            PlanbarError::OrgRequired => f.write_str("planbar: bitte ein Unternehmen wählen"),
            PlanbarError::OrgNotConfigured(name) => {
                write!(f, "planbar: Unternehmen «{name}» ist nicht eingerichtet")
            }
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

fn is_org_id_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

/// Ids of `planbar.unternehmen` (keys of the object): `^[A-Za-z0-9_-]{1,40}$`.
pub fn is_valid_org_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ORG_ID_LEN && id.bytes().all(is_org_id_byte)
}

/// One Unternehmen (planbar organisation) – an API key always belongs to exactly one.
#[derive(Clone)]
pub struct PlanbarOrg {
    pub id: String,
    /// As entered, may be empty – see [`PlanbarOrg::label`].
    pub name: String,
    api_key: String,
}

/// Without the key – a `{:?}` in a log line must not leak it.
impl fmt::Debug for PlanbarOrg {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PlanbarOrg")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("api_key", &"…")
            .finish()
    }
}

impl PlanbarOrg {
    fn has_key(&self) -> bool {
        !self.api_key.is_empty()
    }

    /// Name for messages; the id when no name was entered.
    pub fn label(&self) -> &str {
        if self.name.is_empty() {
            &self.id
        } else {
            &self.name
        }
    }
}

fn planbar_section(state: &Value) -> Option<&Value> {
    state.get("planbar")
}

fn planbar_enabled(planbar: Option<&Value>) -> bool {
    planbar
        .and_then(|p| p.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Entries of `planbar.unternehmen` with a valid id, keys trimmed (empty = no key yet).
fn org_entries(planbar: Option<&Value>) -> Vec<PlanbarOrg> {
    let Some(orgs) = planbar
        .and_then(|p| p.get("unternehmen"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    orgs.iter()
        .filter(|(id, _)| is_valid_org_id(id))
        .filter_map(|(id, entry)| {
            let entry = entry.as_object()?;
            let text = |name: &str| {
                entry
                    .get(name)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default()
            };
            Some(PlanbarOrg {
                id: id.clone(),
                name: text("name").chars().take(MAX_ORG_NAME_LEN).collect(),
                api_key: text("apiKey").to_string(),
            })
        })
        .collect()
}

/// `planbar.url` (missing = planbar.dev), http(s) with a host.
fn base_url(planbar: Option<&Value>) -> Result<Url, PlanbarError> {
    let raw_url = planbar
        .and_then(|p| p.get("url"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_PLANBAR_URL);
    let base = Url::parse(raw_url).map_err(|_| PlanbarError::InvalidBaseUrl)?;
    if !matches!(base.scheme(), "http" | "https") || base.host_str().is_none() {
        return Err(PlanbarError::InvalidBaseUrl);
    }
    Ok(base)
}

#[derive(Clone, Debug)]
pub struct PlanbarConfig {
    base: Url,
    /// Every Unternehmen of the settings, also those without key (for their names).
    orgs: Vec<PlanbarOrg>,
}

impl PlanbarConfig {
    /// Reads `state.planbar`. Rust must not assume the frontend's defaults are stored, so it
    /// applies the same ones (`src/state/defaults.ts`): a missing `url` means planbar.dev, a
    /// missing `enabled` means switched off. Needs at least one Unternehmen with a key.
    pub fn from_state(state: &Value, require_enabled: bool) -> Result<Self, PlanbarError> {
        let planbar = planbar_section(state);
        if require_enabled && !planbar_enabled(planbar) {
            return Err(PlanbarError::NotConfigured);
        }
        let orgs = org_entries(planbar);
        if !orgs.iter().any(PlanbarOrg::has_key) {
            return Err(PlanbarError::NotConfigured);
        }
        Ok(PlanbarConfig {
            base: base_url(planbar)?,
            orgs,
        })
    }

    /// The Unternehmen a request is for: the requested one, or – when none is named – the
    /// only one with a key.
    pub fn select(&self, requested: Option<&str>) -> Result<&PlanbarOrg, PlanbarError> {
        match requested.map(str::trim).filter(|id| !id.is_empty()) {
            Some(id) => self
                .orgs
                .iter()
                .find(|org| org.id == id && org.has_key())
                .ok_or_else(|| PlanbarError::OrgNotConfigured(self.label_of(id))),
            None => {
                let mut keyed = self.orgs.iter().filter(|org| org.has_key());
                match (keyed.next(), keyed.next()) {
                    (Some(org), None) => Ok(org),
                    (None, _) => Err(PlanbarError::NotConfigured),
                    _ => Err(PlanbarError::OrgRequired),
                }
            }
        }
    }

    fn label_of(&self, id: &str) -> String {
        org_label(&self.orgs, id)
    }

    /// `{base}/api/v1/` – everything the key may be sent to lives below it.
    fn api_root(&self) -> String {
        api_root(&self.base)
    }

    fn api_url(&self, path: &str) -> Result<Url, PlanbarError> {
        api_url(&self.base, path)
    }

    /// Cache key part: changes with url, Unternehmen and key, without keeping the key around.
    fn fingerprint(&self, org: &PlanbarOrg) -> String {
        let digest = Sha256::digest(org.api_key.as_bytes());
        format!(
            "{}#{}#{}|",
            self.api_root(),
            org.id,
            hex::encode(&digest[..8])
        )
    }
}

/// Name of a requested Unternehmen for a message – never more than an id's characters of
/// what a client sent.
fn org_label(orgs: &[PlanbarOrg], id: &str) -> String {
    if let Some(org) = orgs.iter().find(|org| org.id == id) {
        return org.label().to_string();
    }
    let clean: String = id
        .chars()
        .filter(|c| c.is_ascii() && is_org_id_byte(*c as u8))
        .take(MAX_ORG_ID_LEN)
        .collect();
    if clean.is_empty() {
        "?".to_string()
    } else {
        clean
    }
}

fn api_root(base: &Url) -> String {
    let mut root = base.clone();
    root.set_query(None);
    root.set_fragment(None);
    format!("{}{}", root.as_str().trim_end_matches('/'), API_PREFIX)
}

fn api_url(base: &Url, path: &str) -> Result<Url, PlanbarError> {
    let relative = path.strip_prefix(API_PREFIX).unwrap_or(path);
    Url::parse(&format!("{}{relative}", api_root(base))).map_err(|_| PlanbarError::InvalidBaseUrl)
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

/// Connection test of one Unternehmen.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlanbarOrgTestResult {
    /// Id in `planbar.unternehmen`.
    pub org: String,
    pub name: String,
    #[serde(flatten)]
    pub result: PlanbarTestResult,
}

/// `GET /api/planbar-test`: one entry per tested Unternehmen.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PlanbarTestReport {
    pub results: Vec<PlanbarOrgTestResult>,
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
        api_key: &str,
        method: Method,
        url: Url,
        body: Option<&Value>,
    ) -> Result<Upstream, PlanbarError> {
        let mut builder = self
            .client
            .request(method, url)
            .bearer_auth(api_key)
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

    /// `planbar_get`: JSON from `{planbar.url}/api/v1/…` with the key of Unternehmen `org`,
    /// cached 15 s per url + Unternehmen + key.
    pub async fn get_json(
        &self,
        state: &Value,
        path: &str,
        query: &BTreeMap<String, String>,
        org: Option<&str>,
    ) -> Result<Value, PlanbarError> {
        let config = PlanbarConfig::from_state(state, true)?;
        let org = config.select(org)?;
        validate_api_path(path)?;
        if query.len() > MAX_QUERY_PARAMS {
            return Err(PlanbarError::InvalidPath("zu viele Parameter".to_string()));
        }
        let mut url = config.api_url(path)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter());
        }
        let key = format!("{}{url}", config.fingerprint(org));
        if let Some(hit) = self.cached_json(&key) {
            return Ok(hit);
        }
        let value = self
            .request(&org.api_key, Method::GET, url, None)
            .await?
            .for_route(path)
            .into_json()?;
        self.store_json(key, value.clone());
        Ok(value)
    }

    /// Ticks off / reopens a task. A change drops that Unternehmen's GET cache, so the next
    /// poll shows it (and the new instance of a recurring task) right away.
    async fn patch_work_item(
        &self,
        state: &Value,
        path: &str,
        body: &Value,
        org: Option<&str>,
    ) -> Result<Upstream, PlanbarError> {
        let config = PlanbarConfig::from_state(state, true)?;
        let org = config.select(org)?;
        validate_patch_path(path)?;
        validate_patch_body(body)?;
        let url = config.api_url(path)?;
        let upstream = self
            .request(&org.api_key, Method::PATCH, url, Some(body))
            .await?;
        if upstream.status.is_success() {
            let prefix = config.fingerprint(org);
            lock(&self.json_cache).retain(|key, _| !key.starts_with(&prefix));
        }
        Ok(upstream)
    }

    /// `planbar_patch`: `PATCH /api/v1/arbeitsliste/<id>` with `{ "completed": bool }`.
    pub async fn patch_json(
        &self,
        state: &Value,
        path: &str,
        body: &Value,
        org: Option<&str>,
    ) -> Result<Value, PlanbarError> {
        self.patch_work_item(state, path, body, org)
            .await?
            .into_json()
    }

    /// Web UI proxy: `GET {planbar.url}/api/v1/{sub_path}?{query}` for the dashboard routes
    /// ([`validate_proxy_path`]) with status and JSON passed through.
    pub async fn proxy_get(
        &self,
        state: &Value,
        sub_path: &str,
        raw_query: Option<&str>,
        org: Option<&str>,
    ) -> Result<ProxyResponse, PlanbarError> {
        let sub_path = sub_path.trim_start_matches('/');
        let path = format!("{API_PREFIX}{sub_path}");
        validate_api_path(&path)?;
        validate_proxy_path(sub_path)?;
        let config = PlanbarConfig::from_state(state, true)?;
        let org = config.select(org)?;
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
            .request(&org.api_key, Method::GET, url, None)
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
        org: Option<&str>,
    ) -> Result<ProxyResponse, PlanbarError> {
        let path = format!("{API_PREFIX}{}", sub_path.trim_start_matches('/'));
        validate_patch_path(&path)?;
        let body: Value = serde_json::from_slice(body).map_err(|_| PlanbarError::InvalidBody)?;
        Ok(self
            .patch_work_item(state, &path, &body, org)
            .await?
            .into_proxy())
    }

    async fn probe(
        &self,
        base: &Url,
        api_key: &str,
        method: Method,
        path: &str,
        query: &str,
        body: Option<&Value>,
    ) -> Result<Upstream, PlanbarError> {
        let mut url = api_url(base, path)?;
        url.set_query(Some(query).filter(|q| !q.is_empty()));
        Ok(self
            .request(api_key, method, url, body)
            .await?
            .for_route(path))
    }

    /// Connection test for the settings page; works before planbar is switched on. Tests the
    /// Unternehmen `org` (also one without key – that is the answer then), or every
    /// Unternehmen with a key at once.
    pub async fn test(&self, state: &Value, org: Option<&str>) -> PlanbarTestReport {
        let planbar = planbar_section(state);
        let entries = org_entries(planbar);
        let requested = org.map(str::trim).filter(|id| !id.is_empty());
        let targets: Vec<&PlanbarOrg> = match requested {
            Some(id) => entries.iter().filter(|entry| entry.id == id).collect(),
            None => entries.iter().filter(|entry| entry.has_key()).collect(),
        };
        if let (Some(id), true) = (requested, targets.is_empty()) {
            let name = org_label(&entries, id);
            let error = PlanbarError::OrgNotConfigured(name.clone());
            return PlanbarTestReport {
                results: vec![PlanbarOrgTestResult {
                    org: name.clone(),
                    name,
                    result: PlanbarTestResult::failed(0, &error),
                }],
            };
        }
        let base = base_url(planbar);
        let results = futures_util::future::join_all(targets.into_iter().map(|entry| {
            let base = base.clone();
            async move {
                let result = match base {
                    Err(error) => PlanbarTestResult::failed(0, &error),
                    Ok(_) if !entry.has_key() => PlanbarTestResult::failed(
                        0,
                        &PlanbarError::OrgNotConfigured(entry.label().to_string()),
                    ),
                    Ok(base) => self.test_org(&base, &entry.api_key).await,
                };
                PlanbarOrgTestResult {
                    org: entry.id.clone(),
                    name: entry.name.clone(),
                    result,
                }
            }
        }))
        .await;
        PlanbarTestReport { results }
    }

    /// Tells an old planbar («Update nötig») from a wrong key and reports the key's rights.
    /// The probes send no parameters (or an unknown task id), so they read and change nothing.
    async fn test_org(&self, base: &Url, api_key: &str) -> PlanbarTestResult {
        let empty = json!({});
        let (members, work, write, projects, news) = tokio::join!(
            self.probe(base, api_key, Method::GET, "/api/v1/mitglieder", "", None),
            self.probe(base, api_key, Method::GET, "/api/v1/arbeitsliste", "", None),
            self.probe(
                base,
                api_key,
                Method::PATCH,
                PROBE_ITEM_PATH,
                "",
                Some(&empty)
            ),
            self.probe(
                base,
                api_key,
                Method::GET,
                "/api/v1/projektuebersicht",
                "pageSize=1",
                None
            ),
            self.probe(base, api_key, Method::GET, "/api/v1/news", "limit=1", None),
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

/// `org` = id in `planbar.unternehmen`; may be left out while only one Unternehmen has a key.
#[tauri::command]
pub async fn planbar_get(
    path: String,
    query: Option<HashMap<String, String>>,
    org: Option<String>,
    store: State<'_, Arc<StateStore>>,
    planbar: State<'_, Arc<PlanbarService>>,
) -> Result<Value, String> {
    let query: BTreeMap<String, String> = query.unwrap_or_default().into_iter().collect();
    let snapshot = store.snapshot();
    planbar
        .get_json(&snapshot.state, &path, &query, org.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn planbar_patch(
    path: String,
    body: Value,
    org: Option<String>,
    store: State<'_, Arc<StateStore>>,
    planbar: State<'_, Arc<PlanbarService>>,
) -> Result<Value, String> {
    let snapshot = store.snapshot();
    planbar
        .patch_json(&snapshot.state, &path, &body, org.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// May read and write everything.
    pub(crate) const KEY: &str = "pk_live_voll";
    /// Full rights in a second organisation (other people).
    pub(crate) const SECOND_KEY: &str = "pk_live_zwei";
    /// Lacks `aufgaben:write` and `news:read`.
    pub(crate) const READ_ONLY_KEY: &str = "pk_live_lesen";

    /// planbar with one Unternehmen («a», named «Büro»).
    pub(crate) fn state_for(url: &str, key: &str) -> Value {
        state_with_orgs(url, &[("a", "Büro", key)])
    }

    /// planbar with the given Unternehmen: (id, name, key).
    pub(crate) fn state_with_orgs(url: &str, orgs: &[(&str, &str, &str)]) -> Value {
        let orgs: serde_json::Map<String, Value> = orgs
            .iter()
            .map(|(id, name, key)| (id.to_string(), json!({ "name": name, "apiKey": key })))
            .collect();
        json!({ "planbar": { "enabled": true, "url": url, "unternehmen": orgs } })
    }

    /// Test of the only Unternehmen with a key.
    async fn single_test(service: &PlanbarService, state: &Value) -> PlanbarTestResult {
        let report = service.test(state, None).await;
        assert_eq!(report.results.len(), 1, "{report:?}");
        report.results.into_iter().next().unwrap().result
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
            Second,
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
                Some(SECOND_KEY) => Caller::Second,
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
                    match caller(&headers) {
                        Caller::Unknown => unauthorized(),
                        Caller::Second => Json(json!({ "data": [
                            { "id": "u1", "name": "Anna Muster", "email": "anna@example.ch", "role": "member", "teams": [] },
                            { "id": "u3", "name": "Dora", "email": "dora@example.ch", "role": "member", "teams": [] },
                            { "id": "u4", "name": "Emil", "email": "emil@example.ch", "role": "member", "teams": [] }
                        ] }))
                        .into_response(),
                        _ => Json(json!({ "data": [
                            { "id": "u1", "name": "Anna Muster", "email": "anna@example.ch", "role": "member", "teams": [] },
                            { "id": "u2", "name": "", "email": "carla@example.ch", "role": "koordinator", "teams": [] }
                        ] }))
                        .into_response(),
                    }
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
                            let org = match caller(&headers) {
                                Caller::Unknown => return unauthorized(),
                                Caller::Second => "zwei",
                                _ => "eins",
                            };
                            let query = query.unwrap_or_default();
                            if !query.contains("benutzer=") {
                                return error(
                                    AxStatus::BAD_REQUEST,
                                    "Parameter \"benutzer\" ist erforderlich",
                                );
                            }
                            counter.fetch_add(1, Ordering::SeqCst);
                            Json(json!({ "data": [], "total": 0, "limit": 50, "today": "2026-10-13", "query": query, "org": org }))
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
                                Caller::Full | Caller::Second => {}
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
                            Caller::Full | Caller::Second => {
                                Json(json!({ "data": [], "total": 0, "limit": 1 })).into_response()
                            }
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
    fn config_requires_a_key_and_respects_enabled() {
        assert_eq!(
            PlanbarConfig::from_state(&json!({}), false).unwrap_err(),
            PlanbarError::NotConfigured
        );
        let org = json!({ "a": { "name": "A", "apiKey": "k" } });
        let disabled = json!({ "planbar": { "enabled": false, "unternehmen": org } });
        assert_eq!(
            PlanbarConfig::from_state(&disabled, true).unwrap_err(),
            PlanbarError::NotConfigured
        );
        assert!(PlanbarConfig::from_state(&disabled, false).is_ok());
        let blank_key =
            json!({ "planbar": { "enabled": true, "unternehmen": { "a": { "apiKey": "  " } } } });
        assert_eq!(
            PlanbarConfig::from_state(&blank_key, true).unwrap_err(),
            PlanbarError::NotConfigured
        );
        // The old single key is no Unternehmen (state.rs moves it on load), nor is the lagra token.
        for other in [
            json!({ "planbar": { "enabled": true, "apiKey": "k" } }),
            json!({ "lagra": { "enabled": true, "token": "t" }, "planbar": { "enabled": true } }),
            json!({ "planbar": { "enabled": true, "unternehmen": [{ "apiKey": "k" }] } }),
            json!({ "planbar": { "enabled": true, "unternehmen": { "a": "k" } } }),
            json!({ "planbar": { "enabled": true, "unternehmen": { "nicht gültig": { "apiKey": "k" } } } }),
            json!({ "planbar": { "enabled": true, "unternehmen": { "a".repeat(41): { "apiKey": "k" } } } }),
        ] {
            assert_eq!(
                PlanbarConfig::from_state(&other, true).unwrap_err(),
                PlanbarError::NotConfigured,
                "{other}"
            );
        }
        // Same defaults as the frontend: without `enabled` planbar is off, without `url` the
        // public host is used.
        let defaults = json!({ "planbar": { "unternehmen": org } });
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
            let state = json!({ "planbar": { "enabled": true, "unternehmen": org, "url": bad } });
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
        let org = cfg.select(None).unwrap();
        let other =
            PlanbarConfig::from_state(&state_for("https://planbar.example.ch", "anders"), true)
                .unwrap();
        assert_ne!(
            cfg.fingerprint(org),
            other.fingerprint(other.select(None).unwrap())
        );
        assert!(!cfg.fingerprint(org).contains(KEY));
        assert!(!format!("{cfg:?}").contains(KEY));
        assert!(!format!("{org:?}").contains(KEY));
    }

    #[test]
    fn requests_pick_their_unternehmen() {
        let state = state_with_orgs(
            "https://planbar.dev",
            &[
                ("wireon", "wireon", KEY),
                ("sw", "Schnyder Werbung", SECOND_KEY),
                ("neu", "Neu", ""),
            ],
        );
        let cfg = PlanbarConfig::from_state(&state, true).unwrap();
        assert_eq!(cfg.select(Some("wireon")).unwrap().api_key, KEY);
        assert_eq!(cfg.select(Some(" sw ")).unwrap().api_key, SECOND_KEY);
        assert_eq!(cfg.select(Some("sw")).unwrap().label(), "Schnyder Werbung");
        // Several keys and none named: the caller has to choose.
        assert_eq!(cfg.select(None).unwrap_err(), PlanbarError::OrgRequired);
        assert_eq!(cfg.select(Some("")).unwrap_err(), PlanbarError::OrgRequired);
        assert_eq!(
            cfg.select(None).unwrap_err().to_string(),
            "planbar: bitte ein Unternehmen wählen"
        );
        // Without key the name is known, an unknown id is echoed only as id characters.
        assert_eq!(
            cfg.select(Some("neu")).unwrap_err().to_string(),
            "planbar: Unternehmen «Neu» ist nicht eingerichtet"
        );
        assert_eq!(
            cfg.select(Some("<script>x")).unwrap_err(),
            PlanbarError::OrgNotConfigured("scriptx".into())
        );
        assert_eq!(
            cfg.select(Some("äö")).unwrap_err(),
            PlanbarError::OrgNotConfigured("?".into())
        );
        // One key: it is used without naming it, and an Unternehmen without name shows its id.
        let single = state_with_orgs("https://planbar.dev", &[("x1", " ", KEY), ("leer", "", "")]);
        let cfg = PlanbarConfig::from_state(&single, true).unwrap();
        assert_eq!(cfg.select(None).unwrap().id, "x1");
        assert_eq!(cfg.select(None).unwrap().label(), "x1");
        let long = "n".repeat(80);
        let named = state_with_orgs("https://planbar.dev", &[("x", &long, KEY)]);
        let cfg = PlanbarConfig::from_state(&named, true).unwrap();
        assert_eq!(cfg.select(None).unwrap().name.len(), MAX_ORG_NAME_LEN);
        assert!(is_valid_org_id("mgk3x1a2-9f3c2b7d1e0a4c55"));
        assert!(!is_valid_org_id("a.b"));
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
        let result = single_test(&service, &state_for(&page, KEY)).await;
        assert!(!result.ok);
        assert_eq!(result.status, 200);
        assert_eq!(result.message, "planbar: ungültige Antwort (kein JSON)");

        let missing = serve_everything_with(AxStatus::NOT_FOUND).await;
        let result = single_test(&service, &state_for(&missing, KEY)).await;
        assert!(!result.ok);
        assert_eq!(result.status, 404);
        assert_eq!(
            result.message,
            "Unter dieser Adresse antwortet kein planbar (404) – Adresse prüfen"
        );

        // A login redirect (SSO in front of planbar) is never followed with the key.
        let login = serve_everything_with(AxStatus::FOUND).await;
        let result = single_test(&service, &state_for(&login, KEY)).await;
        assert!(!result.ok);
        assert_eq!(
            result.message,
            "planbar: Weiterleitung auf eine andere Adresse (302) – planbar-Adresse prüfen"
        );
    }

    #[tokio::test]
    async fn unconfigured_planbar_needs_no_network() {
        let service = service();
        // Nothing to test without an Unternehmen with a key.
        let result = service.test(&json!({}), None).await;
        assert!(result.results.is_empty());
        assert_eq!(
            service
                .get_json(&json!({}), "/api/v1/mitglieder", &BTreeMap::new(), None)
                .await
                .unwrap_err(),
            PlanbarError::NotConfigured
        );
        assert_eq!(
            service
                .patch_json(
                    &json!({}),
                    "/api/v1/arbeitsliste/a1",
                    &json!({ "completed": true }),
                    None
                )
                .await
                .unwrap_err(),
            PlanbarError::NotConfigured
        );
        let state = state_for("http://127.0.0.1:9", KEY);
        assert_eq!(
            service
                .patch_json(
                    &state,
                    "/api/v1/tickets",
                    &json!({ "completed": true }),
                    None
                )
                .await
                .unwrap_err(),
            PlanbarError::WriteNotAllowed
        );
        assert_eq!(
            service
                .proxy_patch(&state, "arbeitsliste/a1", b"kein json", None)
                .await
                .unwrap_err(),
            PlanbarError::InvalidBody
        );
        let unreachable = single_test(&service, &state).await;
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
            .get_json(&state, "/api/v1/arbeitsliste", &query, None)
            .await
            .unwrap();
        assert_eq!(first["query"], json!("benutzer=u1%2Cu2&limit=5"));
        let second = service
            .get_json(&state, "/api/v1/arbeitsliste", &query, None)
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
                None,
            )
            .await
            .unwrap();
        assert_eq!(changed["data"], json!({ "id": "a1", "done": true }));
        service
            .get_json(&state, "/api/v1/arbeitsliste", &query, None)
            .await
            .unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        assert_eq!(
            service
                .patch_json(
                    &state,
                    "/api/v1/arbeitsliste/fehlt",
                    &json!({ "completed": false }),
                    None
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
                    &json!({ "completed": true }),
                    None
                )
                .await
                .unwrap_err()
                .to_string(),
            "planbar: Berechtigung fehlt – Fehlende Berechtigung: aufgaben:write"
        );
        let revoked = state_for(&url, "pk_live_alt");
        assert_eq!(
            service
                .get_json(&revoked, "/api/v1/mitglieder", &BTreeMap::new(), None)
                .await
                .unwrap_err(),
            PlanbarError::Unauthorized(Some("API-Schlüssel wurde widerrufen".into()))
        );
        assert_eq!(
            service
                .get_json(&state, "/api/v1/gibts-nicht", &BTreeMap::new(), None)
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

        let members = service
            .proxy_get(&state, "mitglieder", None, None)
            .await
            .unwrap();
        assert_eq!(members.status, 200);
        assert!(members.content_type.starts_with("application/json"));
        let body: Value = serde_json::from_slice(&members.body).unwrap();
        assert_eq!(body["data"].as_array().map(Vec::len), Some(2));

        let work = service
            .proxy_get(
                &state,
                "/arbeitsliste",
                Some("benutzer=u1&typ=aufgabe"),
                None,
            )
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&work.body).unwrap();
        assert_eq!(body["query"], json!("benutzer=u1&typ=aufgabe"));

        let denied = service
            .proxy_get(&state_for(&url, "falsch"), "mitglieder", None, None)
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
                service
                    .proxy_get(&state, denied, None, None)
                    .await
                    .unwrap_err(),
                PlanbarError::ReadNotAllowed(denied.into()),
                "{denied}"
            );
        }
        assert!(service
            .proxy_get(&state, "../geheim", None, None)
            .await
            .is_err());
        assert!(service
            .proxy_get(&state, "news", Some("a=b#c"), None)
            .await
            .is_err());

        let ticked = service
            .proxy_patch(&state, "arbeitsliste/a1", br#"{"completed":false}"#, None)
            .await
            .unwrap();
        assert_eq!(ticked.status, 200);
        let forbidden = service
            .proxy_patch(
                &state_for(&url, READ_ONLY_KEY),
                "arbeitsliste/a1",
                br#"{"completed":true}"#,
                None,
            )
            .await
            .unwrap();
        assert_eq!(forbidden.status, 403);
        assert_eq!(
            service
                .proxy_patch(&state, "mitglieder", br#"{"completed":true}"#, None)
                .await
                .unwrap_err(),
            PlanbarError::WriteNotAllowed
        );
        assert_eq!(
            service
                .proxy_patch(
                    &state,
                    "arbeitsliste/a1",
                    br#"{"completed":true,"title":"x"}"#,
                    None
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

        let full = single_test(&service, &state_for(&url, KEY)).await;
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

        let limited = single_test(&service, &state_for(&url, READ_ONLY_KEY)).await;
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

        let revoked = single_test(&service, &state_for(&url, "pk_live_alt")).await;
        assert!(!revoked.ok);
        assert_eq!(revoked.status, 401);
        assert_eq!(
            revoked.message,
            "planbar: API-Schlüssel ungültig (401) – API-Schlüssel wurde widerrufen"
        );

        // Switched off still tests (the settings page tests before switching on).
        let mut disabled = state_for(&url, KEY);
        disabled["planbar"]["enabled"] = json!(false);
        assert!(single_test(&service, &disabled).await.ok);

        let (old_url, _) = fake_planbar(false).await;
        let old = single_test(&service, &state_for(&old_url, KEY)).await;
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
                .get_json(&old, summary, &BTreeMap::new(), None)
                .await
                .unwrap_err(),
            PlanbarError::EndpointMissing
        );
        let proxied = service
            .proxy_get(&old, "zeiten/zusammenfassung", None, None)
            .await
            .unwrap();
        assert_eq!((proxied.status, proxied.body.len()), (404, 0));
        assert_eq!(proxied.content_type, PLAIN_TEXT);
        // Other routes keep planbar's «not found».
        assert_eq!(
            service
                .get_json(&old, "/api/v1/zeiten/z1", &BTreeMap::new(), None)
                .await
                .unwrap_err(),
            PlanbarError::NotFound(Some("Zeiteintrag nicht gefunden".into()))
        );

        let (url, _) = fake_planbar(true).await;
        let current = service
            .get_json(&state_for(&url, KEY), summary, &BTreeMap::new(), None)
            .await
            .unwrap();
        assert_eq!(current["weekStart"], json!("2026-10-12"));
    }

    #[tokio::test]
    async fn every_unternehmen_reads_with_its_own_key_and_cache() {
        let (url, hits) = fake_planbar(true).await;
        let service = service();
        let state = state_with_orgs(&url, &[("eins", "wireon", KEY), ("zwei", "SW", SECOND_KEY)]);
        let query = BTreeMap::from([("benutzer".to_string(), "u1".to_string())]);
        let work = "/api/v1/arbeitsliste";

        assert_eq!(
            service
                .get_json(&state, work, &query, None)
                .await
                .unwrap_err(),
            PlanbarError::OrgRequired
        );
        assert_eq!(
            service
                .get_json(&state, work, &query, Some("drei"))
                .await
                .unwrap_err()
                .to_string(),
            "planbar: Unternehmen «drei» ist nicht eingerichtet"
        );
        assert_eq!(hits.load(Ordering::SeqCst), 0);

        let first = service
            .get_json(&state, work, &query, Some("eins"))
            .await
            .unwrap();
        let second = service
            .get_json(&state, work, &query, Some("zwei"))
            .await
            .unwrap();
        assert_eq!(first["org"], json!("eins"));
        assert_eq!(second["org"], json!("zwei"));
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        // Cached per Unternehmen.
        for (org, tag) in [("eins", "eins"), ("zwei", "zwei")] {
            let again = service
                .get_json(&state, work, &query, Some(org))
                .await
                .unwrap();
            assert_eq!(again["org"], json!(tag));
        }
        assert_eq!(hits.load(Ordering::SeqCst), 2);

        // Ticking off in one Unternehmen drops only its cache.
        service
            .patch_json(
                &state,
                "/api/v1/arbeitsliste/a1",
                &json!({ "completed": true }),
                Some("zwei"),
            )
            .await
            .unwrap();
        service
            .get_json(&state, work, &query, Some("eins"))
            .await
            .unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 2);
        service
            .get_json(&state, work, &query, Some("zwei"))
            .await
            .unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 3);

        let members = service
            .proxy_get(&state, "mitglieder", None, Some("zwei"))
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&members.body).unwrap();
        assert_eq!(body["data"][1]["id"], json!("u3"));
        assert_eq!(
            service
                .proxy_get(&state, "mitglieder", None, None)
                .await
                .unwrap_err(),
            PlanbarError::OrgRequired
        );
        assert_eq!(
            service
                .proxy_patch(&state, "arbeitsliste/a1", br#"{"completed":true}"#, None)
                .await
                .unwrap_err(),
            PlanbarError::OrgRequired
        );
    }

    #[tokio::test]
    async fn test_covers_each_unternehmen() {
        let (url, _) = fake_planbar(true).await;
        let service = service();
        let state = state_with_orgs(
            &url,
            &[
                ("eins", "wireon", KEY),
                ("zwei", "SW", READ_ONLY_KEY),
                ("alt", "Alt", "pk_live_alt"),
                ("leer", "Leer", ""),
            ],
        );

        let all = service.test(&state, None).await;
        let by_org: HashMap<&str, &PlanbarOrgTestResult> =
            all.results.iter().map(|r| (r.org.as_str(), r)).collect();
        // Only Unternehmen with a key are tested.
        assert_eq!(all.results.len(), 3);
        assert!(!by_org.contains_key("leer"));
        assert_eq!(by_org["eins"].name, "wireon");
        assert!(by_org["eins"].result.ok);
        assert_eq!(by_org["eins"].result.members, Some(2));
        assert_eq!(
            by_org["zwei"].result.message,
            "Verbunden, aber dem API-Schlüssel fehlen Rechte: News lesen"
        );
        assert!(!by_org["alt"].result.ok);
        assert_eq!(by_org["alt"].result.status, 401);

        let json = serde_json::to_value(&all).unwrap();
        let first = &json["results"][0];
        for field in [
            "org",
            "name",
            "ok",
            "status",
            "message",
            "dashboard",
            "members",
            "scopes",
        ] {
            assert!(first.get(field).is_some(), "{field}: {first}");
        }

        let one = service.test(&state, Some("zwei")).await;
        assert_eq!(one.results.len(), 1);
        assert_eq!(one.results[0].org, "zwei");
        let empty = service.test(&state, Some("leer")).await;
        assert_eq!(
            empty.results[0].result,
            PlanbarTestResult::failed(0, &PlanbarError::OrgNotConfigured("Leer".into()))
        );
        let unknown = service.test(&state, Some("gibts/nicht")).await;
        assert_eq!(unknown.results[0].org, "gibtsnicht");
        assert!(!unknown.results[0].result.ok);

        let mut bad_url = state.clone();
        bad_url["planbar"]["url"] = json!("ftp://x");
        let failed = service.test(&bad_url, Some("eins")).await;
        assert_eq!(
            failed.results[0].result.message,
            "Die planbar-Adresse ist ungültig"
        );

        assert_eq!(service.test(&json!({}), None).await.results, vec![]);
    }
}
