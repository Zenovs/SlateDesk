//! lagra integration. lagra's `/api/v1` needs a bearer token and sends no CORS headers, so
//! every call (kiosk commands and the web UI proxy) goes through here; the token never
//! leaves Rust.

use crate::http::{content_type, describe_error, read_body_limited, ProxyResponse};
use crate::state::StateStore;
use base64::Engine;
use reqwest::header::{ACCEPT, CACHE_CONTROL};
use reqwest::{Client, StatusCode, Url};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::State;

pub const DEFAULT_LAGRA_URL: &str = "https://lagra.schnyder-werbung.ch";
const API_PREFIX: &str = "/api/v1/";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const JSON_CACHE_TTL: Duration = Duration::from_secs(15);
const JSON_CACHE_MAX: usize = 64;
const IMAGE_CACHE_MAX: usize = 50;
const IMAGE_MAX_BYTES: usize = 8 * 1024 * 1024;
const PROXY_MAX_BYTES: usize = 15 * 1024 * 1024;
const JSON_MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_PATH_LEN: usize = 512;
const MAX_QUERY_PARAMS: usize = 32;
const MAX_ASSET_ID_LEN: usize = 64;
const PLAIN_TEXT: &str = "text/plain; charset=utf-8";
/// The routes the web UI reads through `/api/lagra/…` (besides `assets/<id>/vorschau`). lagra
/// tokens have no scopes, so everything else – customers, folders, original files – stays
/// out of reach of a web UI session (CONTRACT §8: the dashboard shows counts).
const PROXY_ROUTES: [&str; 3] = ["uebersicht", "jobs", "pruefen"];
/// Image types the proxy passes on; anything else (SVG, HTML pages) never renders on the
/// web UI's origin.
const PROXY_IMAGE_TYPES: [&str; 5] = [
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "image/avif",
];

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LagraError {
    NotConfigured,
    InvalidBaseUrl,
    InvalidPath(String),
    /// A path the web UI proxy does not forward.
    NotAllowed(String),
    ForeignImage,
    Unauthorized,
    EndpointMissing,
    ImageMissing,
    NotAnImage,
    Status(u16, Option<String>),
    /// A redirect away from `{url}/api/v1/` – not followed, the token stays with lagra.
    Redirected(u16),
    Unreachable(String),
    InvalidResponse(String),
}

impl fmt::Display for LagraError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LagraError::NotConfigured => f.write_str("lagra ist nicht eingerichtet"),
            LagraError::InvalidBaseUrl => f.write_str("Die lagra-Adresse ist ungültig"),
            LagraError::InvalidPath(p) => write!(f, "Ungültiger lagra-Pfad: {p}"),
            LagraError::NotAllowed(p) => {
                write!(
                    f,
                    "lagra: «{p}» ist über die Fernsteuerung nicht freigegeben"
                )
            }
            LagraError::ForeignImage => f.write_str("Die Bildadresse gehört nicht zu lagra"),
            LagraError::Unauthorized => f.write_str("lagra: Token ungültig (401)"),
            LagraError::EndpointMissing => {
                f.write_str("lagra: Endpunkt fehlt (404) – lagra-Update nötig")
            }
            LagraError::ImageMissing => f.write_str("lagra: Bild nicht gefunden (404)"),
            LagraError::NotAnImage => f.write_str("lagra: Antwort ist kein Bild"),
            LagraError::Status(status, Some(msg)) => write!(f, "lagra: Fehler {status} – {msg}"),
            LagraError::Status(status, None) => write!(f, "lagra: Fehler {status}"),
            LagraError::Redirected(status) => write!(
                f,
                "lagra: Weiterleitung auf eine andere Adresse ({status}) – lagra-Adresse prüfen"
            ),
            LagraError::Unreachable(detail) => write!(f, "lagra nicht erreichbar: {detail}"),
            LagraError::InvalidResponse(detail) => write!(f, "lagra: ungültige Antwort ({detail})"),
        }
    }
}

impl std::error::Error for LagraError {}

/// lagra error bodies are `{ "fehler": "…" }`.
fn lagra_message(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let msg = value
        .get("fehler")
        .or_else(|| value.get("error"))
        .and_then(Value::as_str)?
        .trim();
    (!msg.is_empty()).then(|| msg.chars().take(200).collect())
}

/// A JSON 404 is lagra saying "not found"; a non-JSON 404 (Next.js page) means the route
/// itself does not exist in this lagra version.
fn status_error(status: StatusCode, body: &[u8]) -> LagraError {
    let message = lagra_message(body);
    match (status.as_u16(), message) {
        (401, _) => LagraError::Unauthorized,
        (404, None) => LagraError::EndpointMissing,
        (code, message) => LagraError::Status(code, message),
    }
}

fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.' | '~')
}

fn check_path(path: &str) -> Result<(), LagraError> {
    let ok = path.len() <= MAX_PATH_LEN
        && path.chars().all(is_path_char)
        && !path.contains("..")
        && !path.contains("//");
    if ok {
        Ok(())
    } else {
        Err(LagraError::InvalidPath(path.chars().take(80).collect()))
    }
}

/// Paths for `lagra_get`: `/api/v1/…`, no traversal, no query or fragment.
pub fn validate_api_path(path: &str) -> Result<(), LagraError> {
    if !path.starts_with(API_PREFIX) || path.len() == API_PREFIX.len() {
        return Err(LagraError::InvalidPath(path.chars().take(80).collect()));
    }
    check_path(path)
}

fn is_asset_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ASSET_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Sub-paths (below `/api/v1/`) the web UI proxy forwards: the dashboard routes and the
/// preview images of `uebersicht`'s `neu` list. The kiosk's own `lagra_get` stays generic.
pub fn validate_proxy_path(sub_path: &str) -> Result<(), LagraError> {
    let allowed = PROXY_ROUTES.contains(&sub_path)
        || sub_path
            .strip_prefix("assets/")
            .and_then(|rest| rest.strip_suffix("/vorschau"))
            .is_some_and(is_asset_id);
    if allowed {
        Ok(())
    } else {
        Err(LagraError::NotAllowed(sub_path.chars().take(80).collect()))
    }
}

fn mime_essence(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase()
}

/// JSON (lagra's answers and errors) and raster previews pass the proxy; any other body –
/// an SVG, Next's HTML pages – is dropped, so it never renders on the web UI's origin. An
/// empty non-JSON 404 still reads as «Endpunkt fehlt» in the web UI.
fn proxy_passes(content_type: &str) -> bool {
    let essence = mime_essence(content_type);
    essence == "application/json"
        || essence.ends_with("+json")
        || PROXY_IMAGE_TYPES.contains(&essence.as_str())
}

#[derive(Debug, Clone)]
pub struct LagraConfig {
    base: Url,
    token: String,
}

impl LagraConfig {
    /// Reads `state.lagra`. Rust must not assume the frontend's defaults are stored, so it
    /// applies the same ones (`src/state/defaults.ts`): a missing `url` means the default
    /// host, a missing `enabled` means switched off.
    pub fn from_state(state: &Value, require_enabled: bool) -> Result<Self, LagraError> {
        let lagra = state.get("lagra");
        let field = |name: &str| {
            lagra
                .and_then(|l| l.get(name))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        };
        let enabled = lagra
            .and_then(|l| l.get("enabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if require_enabled && !enabled {
            return Err(LagraError::NotConfigured);
        }
        let token = field("token").ok_or(LagraError::NotConfigured)?.to_string();
        let raw_url = field("url").unwrap_or(DEFAULT_LAGRA_URL);
        let base = Url::parse(raw_url).map_err(|_| LagraError::InvalidBaseUrl)?;
        if !matches!(base.scheme(), "http" | "https") || base.host_str().is_none() {
            return Err(LagraError::InvalidBaseUrl);
        }
        Ok(LagraConfig { base, token })
    }

    /// `{base}/api/v1/` – everything the token may be sent to lives below it.
    fn api_root(&self) -> String {
        let mut root = self.base.clone();
        root.set_query(None);
        root.set_fragment(None);
        format!("{}{}", root.as_str().trim_end_matches('/'), API_PREFIX)
    }

    fn api_url(&self, path: &str) -> Result<Url, LagraError> {
        let relative = path.strip_prefix(API_PREFIX).unwrap_or(path);
        Url::parse(&format!("{}{relative}", self.api_root()))
            .map_err(|_| LagraError::InvalidBaseUrl)
    }

    /// Cache key part: changes when url or token change, without keeping the token around.
    fn fingerprint(&self) -> String {
        let digest = Sha256::digest(self.token.as_bytes());
        format!("{}#{}", self.api_root(), hex::encode(&digest[..8]))
    }

    /// Absolute URL below the API root, or a `/api/v1/…` path (lagra's `vorschauPfad`).
    fn resolve_image_url(&self, url: &str) -> Result<Url, LagraError> {
        let url = url.trim();
        if url.starts_with('/') {
            let (path, query) = url.split_once('?').unwrap_or((url, ""));
            validate_api_path(path)?;
            let mut target = self.api_url(path)?;
            if !query.is_empty() {
                target.set_query(Some(query));
            }
            return Ok(target);
        }
        let target = Url::parse(url).map_err(|_| LagraError::ForeignImage)?;
        if target.as_str().starts_with(&self.api_root()) {
            Ok(target)
        } else {
            Err(LagraError::ForeignImage)
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LagraTestResult {
    pub ok: bool,
    pub status: u16,
    pub message: String,
    pub uebersicht: bool,
}

#[derive(Default)]
struct ImageCache {
    order: VecDeque<String>,
    entries: HashMap<String, Arc<str>>,
}

impl ImageCache {
    fn get(&mut self, key: &str) -> Option<Arc<str>> {
        let value = self.entries.get(key).cloned()?;
        if let Some(pos) = self.order.iter().position(|k| k == key) {
            if let Some(k) = self.order.remove(pos) {
                self.order.push_back(k);
            }
        }
        Some(value)
    }

    fn insert(&mut self, key: String, value: Arc<str>) {
        if self.entries.insert(key.clone(), value).is_none() {
            self.order.push_back(key);
        }
        while self.order.len() > IMAGE_CACHE_MAX {
            if let Some(old) = self.order.pop_front() {
                self.entries.remove(&old);
            }
        }
    }
}

pub struct LagraService {
    client: Client,
    json_cache: Mutex<HashMap<String, (Instant, Value)>>,
    images: Mutex<ImageCache>,
}

impl LagraService {
    /// `client` must not follow redirects away from the API root (`http::build_api_client`).
    pub fn new(client: Client) -> Self {
        LagraService {
            client,
            json_cache: Mutex::new(HashMap::new()),
            images: Mutex::new(ImageCache::default()),
        }
    }

    async fn send(
        &self,
        config: &LagraConfig,
        url: Url,
        accept: &str,
    ) -> Result<reqwest::Response, LagraError> {
        let response = self
            .client
            .get(url)
            .bearer_auth(&config.token)
            .header(ACCEPT, accept)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(|e| LagraError::Unreachable(describe_error(&e)))?;
        // The client stops at redirects that leave the API root; such an answer is never
        // passed on.
        if response.status().is_redirection() {
            return Err(LagraError::Redirected(response.status().as_u16()));
        }
        Ok(response)
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

    /// `lagra_get`: JSON from `{lagra.url}/api/v1/…`, cached 15 s per url+token.
    pub async fn get_json(
        &self,
        state: &Value,
        path: &str,
        query: &BTreeMap<String, String>,
    ) -> Result<Value, LagraError> {
        let config = LagraConfig::from_state(state, true)?;
        validate_api_path(path)?;
        if query.len() > MAX_QUERY_PARAMS {
            return Err(LagraError::InvalidPath("zu viele Parameter".to_string()));
        }
        let mut url = config.api_url(path)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter());
        }
        let key = format!("{}|{url}", config.fingerprint());
        if let Some(hit) = self.cached_json(&key) {
            return Ok(hit);
        }

        let response = self.send(&config, url, "application/json").await?;
        let status = response.status();
        let body = read_body_limited(response, JSON_MAX_BYTES)
            .await
            .map_err(LagraError::Unreachable)?;
        if !status.is_success() {
            return Err(status_error(status, &body));
        }
        let value: Value = serde_json::from_slice(&body)
            .map_err(|_| LagraError::InvalidResponse("kein JSON".to_string()))?;
        self.store_json(key, value.clone());
        Ok(value)
    }

    /// `lagra_image`: an authenticated preview as `data:` URL (an `<img>` cannot send the token).
    pub async fn image_data_url(&self, state: &Value, url: &str) -> Result<String, LagraError> {
        let config = LagraConfig::from_state(state, true)?;
        let target = config.resolve_image_url(url)?;
        let key = format!("{}|{target}", config.fingerprint());
        if let Some(hit) = lock(&self.images).get(&key) {
            return Ok(hit.to_string());
        }

        let response = self.send(&config, target, "image/*").await?;
        let status = response.status();
        let mime = content_type(response.headers());
        let body = read_body_limited(response, IMAGE_MAX_BYTES)
            .await
            .map_err(LagraError::Unreachable)?;
        if status == StatusCode::NOT_FOUND {
            return Err(LagraError::ImageMissing);
        }
        if !status.is_success() {
            return Err(status_error(status, &body));
        }
        let mime = mime_essence(&mime);
        if !mime.starts_with("image/") || body.is_empty() {
            return Err(LagraError::NotAnImage);
        }
        let data_url: Arc<str> = format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&body)
        )
        .into();
        lock(&self.images).insert(key, Arc::clone(&data_url));
        Ok(data_url.to_string())
    }

    /// Web UI proxy: `GET {lagra.url}/api/v1/{sub_path}?{query}` for the dashboard routes
    /// ([`validate_proxy_path`]), with status passed through and only JSON or raster images
    /// as body.
    pub async fn proxy_get(
        &self,
        state: &Value,
        sub_path: &str,
        raw_query: Option<&str>,
    ) -> Result<ProxyResponse, LagraError> {
        let sub_path = sub_path.trim_start_matches('/');
        let path = format!("{API_PREFIX}{sub_path}");
        validate_api_path(&path)?;
        validate_proxy_path(sub_path)?;
        let config = LagraConfig::from_state(state, true)?;
        let mut url = config.api_url(&path)?;
        if let Some(query) = raw_query.filter(|q| !q.is_empty()) {
            if query
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '#')
            {
                return Err(LagraError::InvalidPath("ungültige Parameter".to_string()));
            }
            url.set_query(Some(query));
        }

        let response = self
            .send(&config, url, "application/json, image/*;q=0.9, */*;q=0.5")
            .await?;
        let status = response.status().as_u16();
        let content_type = content_type(response.headers());
        let cache_control = response
            .headers()
            .get(CACHE_CONTROL)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body = read_body_limited(response, PROXY_MAX_BYTES)
            .await
            .map_err(LagraError::Unreachable)?;
        if !proxy_passes(&content_type) {
            return Ok(ProxyResponse {
                status,
                content_type: PLAIN_TEXT.to_string(),
                cache_control: None,
                body: Vec::new(),
            });
        }
        Ok(ProxyResponse {
            status,
            content_type,
            cache_control,
            body,
        })
    }

    async fn probe(
        &self,
        config: &LagraConfig,
        path: &str,
        query: &str,
    ) -> Result<(StatusCode, Vec<u8>), LagraError> {
        let mut url = config.api_url(path)?;
        url.set_query(Some(query).filter(|q| !q.is_empty()));
        let response = self.send(config, url, "application/json").await?;
        let status = response.status();
        let body = read_body_limited(response, JSON_MAX_BYTES)
            .await
            .map_err(LagraError::Unreachable)?;
        Ok((status, body))
    }

    /// Connection test for the settings page; works before lagra is switched on and falls
    /// back to `/pruefen` to tell "old lagra" from "wrong token".
    pub async fn test(&self, state: &Value) -> LagraTestResult {
        let fail = |status: u16, error: LagraError| LagraTestResult {
            ok: false,
            status,
            message: error.to_string(),
            uebersicht: false,
        };
        let config = match LagraConfig::from_state(state, false) {
            Ok(config) => config,
            Err(e) => return fail(0, e),
        };
        let (status, body) = match self.probe(&config, "/api/v1/uebersicht", "teile=api").await {
            Ok(result) => result,
            Err(e) => return fail(0, e),
        };
        if status.is_success() {
            return LagraTestResult {
                ok: true,
                status: status.as_u16(),
                message: "Verbindung zu lagra hergestellt".to_string(),
                uebersicht: true,
            };
        }
        if status != StatusCode::NOT_FOUND {
            return fail(status.as_u16(), status_error(status, &body));
        }
        match self.probe(&config, "/api/v1/pruefen", "").await {
            Ok((fallback, _)) if fallback.is_success() => LagraTestResult {
                ok: true,
                status: fallback.as_u16(),
                message: "Verbunden, aber lagra-Update nötig (Übersicht fehlt)".to_string(),
                uebersicht: false,
            },
            Ok((fallback, body)) if fallback == StatusCode::UNAUTHORIZED => {
                fail(fallback.as_u16(), status_error(fallback, &body))
            }
            Ok(_) => fail(404, LagraError::EndpointMissing),
            Err(e) => fail(0, e),
        }
    }
}

#[tauri::command]
pub async fn lagra_get(
    path: String,
    query: Option<HashMap<String, String>>,
    store: State<'_, Arc<StateStore>>,
    lagra: State<'_, Arc<LagraService>>,
) -> Result<Value, String> {
    let query: BTreeMap<String, String> = query.unwrap_or_default().into_iter().collect();
    let snapshot = store.snapshot();
    lagra
        .get_json(&snapshot.state, &path, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn lagra_image(
    url: String,
    store: State<'_, Arc<StateStore>>,
    lagra: State<'_, Arc<LagraService>>,
) -> Result<String, String> {
    let snapshot = store.snapshot();
    lagra
        .image_data_url(&snapshot.state, &url)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(url: &str) -> LagraConfig {
        LagraConfig::from_state(
            &json!({ "lagra": { "enabled": true, "url": url, "token": "t" } }),
            true,
        )
        .unwrap()
    }

    #[test]
    fn config_requires_token_and_respects_enabled() {
        assert_eq!(
            LagraConfig::from_state(&json!({}), false).unwrap_err(),
            LagraError::NotConfigured
        );
        let disabled = json!({ "lagra": { "enabled": false, "token": "t" } });
        assert_eq!(
            LagraConfig::from_state(&disabled, true).unwrap_err(),
            LagraError::NotConfigured
        );
        assert!(LagraConfig::from_state(&disabled, false).is_ok());
        // Same defaults as the frontend: without `enabled` lagra is off, without `url` the
        // default host is used.
        let defaults = json!({ "lagra": { "token": "t" } });
        assert_eq!(
            LagraConfig::from_state(&defaults, true).unwrap_err(),
            LagraError::NotConfigured
        );
        let default_url = LagraConfig::from_state(&defaults, false).unwrap();
        assert_eq!(
            default_url.api_root(),
            "https://lagra.schnyder-werbung.ch/api/v1/"
        );
        let bad = json!({ "lagra": { "enabled": true, "token": "t", "url": "ftp://x" } });
        assert_eq!(
            LagraConfig::from_state(&bad, true).unwrap_err(),
            LagraError::InvalidBaseUrl
        );
    }

    #[test]
    fn api_paths_are_validated() {
        assert!(validate_api_path("/api/v1/uebersicht").is_ok());
        assert!(validate_api_path("/api/v1/assets/cmg1x0abc0001/vorschau").is_ok());
        for bad in [
            "/api/v2/x",
            "api/v1/x",
            "/api/v1/",
            "/api/v1/../admin",
            "/api/v1//x",
            "/api/v1/a?b=c",
            "/api/v1/a b",
            "/api/v1/%2e%2e",
        ] {
            assert!(validate_api_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn web_proxy_forwards_only_dashboard_routes() {
        for ok in [
            "uebersicht",
            "jobs",
            "pruefen",
            "assets/cmg1x0abc0001/vorschau",
        ] {
            assert!(validate_proxy_path(ok).is_ok(), "{ok}");
        }
        for denied in [
            "kunden",
            "dateien",
            "ordner",
            "potentiale",
            "assets",
            "assets/a1",
            "assets/a1/datei",
            "assets//vorschau",
            "assets/a.b/vorschau",
            "assets/a1/vorschau/x",
            "uebersicht/x",
        ] {
            assert_eq!(
                validate_proxy_path(denied),
                Err(LagraError::NotAllowed(denied.to_string())),
                "{denied}"
            );
        }
        assert!(proxy_passes("application/json; charset=utf-8"));
        assert!(proxy_passes("image/webp"));
        assert!(!proxy_passes("image/svg+xml"));
        assert!(!proxy_passes("text/html; charset=utf-8"));
        assert!(!proxy_passes(""));
    }

    #[test]
    fn urls_are_built_below_the_api_root() {
        let cfg = config("https://lagra.example.ch/");
        assert_eq!(
            cfg.api_url("/api/v1/jobs").unwrap().as_str(),
            "https://lagra.example.ch/api/v1/jobs"
        );
        let prefixed = config("https://example.ch/lagra");
        assert_eq!(
            prefixed.api_url("/api/v1/jobs").unwrap().as_str(),
            "https://example.ch/lagra/api/v1/jobs"
        );
    }

    #[test]
    fn image_urls_must_stay_on_lagra() {
        let cfg = config("https://lagra.example.ch");
        assert_eq!(
            cfg.resolve_image_url("/api/v1/assets/a1/vorschau?gross=1")
                .unwrap()
                .as_str(),
            "https://lagra.example.ch/api/v1/assets/a1/vorschau?gross=1"
        );
        assert!(cfg
            .resolve_image_url("https://lagra.example.ch/api/v1/assets/a1/vorschau")
            .is_ok());
        assert!(cfg
            .resolve_image_url("https://LAGRA.example.ch:443/api/v1/assets/a1/vorschau")
            .is_ok());
        for bad in [
            "https://evil.example.ch/api/v1/assets/a1/vorschau",
            "https://lagra.example.ch.evil.ch/api/v1/x",
            "http://lagra.example.ch/api/v1/x",
            "https://lagra.example.ch/admin",
            "https://lagra.example.ch/api/v1/../admin",
            "/admin",
            "/api/v1/../admin",
        ] {
            assert!(cfg.resolve_image_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn errors_match_contract_texts() {
        assert_eq!(
            LagraError::NotConfigured.to_string(),
            "lagra ist nicht eingerichtet"
        );
        assert_eq!(
            status_error(StatusCode::UNAUTHORIZED, b"").to_string(),
            "lagra: Token ungültig (401)"
        );
        assert_eq!(
            status_error(StatusCode::NOT_FOUND, b"<html>404</html>").to_string(),
            "lagra: Endpunkt fehlt (404) – lagra-Update nötig"
        );
        assert_eq!(
            status_error(
                StatusCode::NOT_FOUND,
                br#"{"fehler":"Asset nicht gefunden"}"#
            )
            .to_string(),
            "lagra: Fehler 404 – Asset nicht gefunden"
        );
        assert!(LagraError::Unreachable("Zeitüberschreitung".into())
            .to_string()
            .starts_with("lagra nicht erreichbar: "));
    }

    #[test]
    fn image_cache_evicts_least_recently_used() {
        let mut cache = ImageCache::default();
        for i in 0..IMAGE_CACHE_MAX {
            cache.insert(format!("k{i}"), Arc::from("v"));
        }
        assert!(cache.get("k0").is_some());
        cache.insert("new".to_string(), Arc::from("v"));
        assert!(cache.get("k0").is_some());
        assert!(cache.get("k1").is_none());
        assert_eq!(cache.entries.len(), IMAGE_CACHE_MAX);
    }

    #[tokio::test]
    async fn unconfigured_test_reports_without_network() {
        let service = LagraService::new(crate::http::build_api_client().unwrap());
        let result = service.test(&json!({})).await;
        assert!(!result.ok);
        assert_eq!(result.message, "lagra ist nicht eingerichtet");
        assert_eq!(
            service
                .get_json(&json!({}), "/api/v1/jobs", &BTreeMap::new())
                .await
                .unwrap_err(),
            LagraError::NotConfigured
        );
    }

    /// Minimal lagra stand-in on a random local port; `with_uebersicht = false` mimics an
    /// lagra version without the new endpoint.
    async fn fake_lagra(with_uebersicht: bool) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
        use axum::extract::RawQuery;
        use axum::http::{HeaderMap, StatusCode as AxStatus};
        use axum::response::Redirect;
        use axum::routing::get;
        use std::sync::atomic::{AtomicUsize, Ordering};

        fn authorized(headers: &HeaderMap) -> bool {
            headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer t")
        }

        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let mut app = axum::Router::new()
            .route(
                "/api/v1/assets/a1/vorschau",
                get(|headers: HeaderMap| async move {
                    if !authorized(&headers) {
                        return (
                            AxStatus::UNAUTHORIZED,
                            [("content-type", "application/json")],
                            b"{}".to_vec(),
                        );
                    }
                    (
                        AxStatus::OK,
                        [("content-type", "image/png")],
                        vec![137, 80, 78, 71],
                    )
                }),
            )
            .route(
                "/api/v1/pruefen",
                get(|headers: HeaderMap| async move {
                    if authorized(&headers) {
                        AxStatus::OK
                    } else {
                        AxStatus::UNAUTHORIZED
                    }
                }),
            )
            .route(
                "/api/v1/assets/svg/vorschau",
                get(|| async { ([("content-type", "image/svg+xml")], "<svg></svg>") }),
            )
            .route(
                "/api/v1/assets/innen/vorschau",
                get(|| async { Redirect::temporary("/api/v1/assets/a1/vorschau") }),
            )
            .route(
                "/api/v1/assets/aussen/vorschau",
                get(|| async { Redirect::temporary("/geheim") }),
            )
            .route(
                "/api/v1/kunden",
                get(|| async { axum::Json(json!({ "data": ["Kunde AG"] })) }),
            )
            .fallback(|| async {
                (
                    AxStatus::NOT_FOUND,
                    [("content-type", "text/html")],
                    "<html>404</html>",
                )
            });
        if with_uebersicht {
            app = app.route(
                "/api/v1/uebersicht",
                get(move |headers: HeaderMap, RawQuery(query): RawQuery| {
                    let counter = Arc::clone(&counter);
                    async move {
                        counter.fetch_add(1, Ordering::SeqCst);
                        if !authorized(&headers) {
                            return (
                                AxStatus::UNAUTHORIZED,
                                axum::Json(json!({ "fehler": "Ungültiges Token." })),
                            );
                        }
                        (AxStatus::OK, axum::Json(json!({ "query": query })))
                    }
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

    fn state_for(url: &str, token: &str) -> Value {
        json!({ "lagra": { "enabled": true, "url": url, "token": token } })
    }

    #[tokio::test]
    async fn talks_to_lagra_with_bearer_token_and_caches_json() {
        use std::sync::atomic::Ordering;
        let (url, hits) = fake_lagra(true).await;
        let service = LagraService::new(crate::http::build_api_client().unwrap());
        let state = state_for(&url, "t");
        let query = BTreeMap::from([("teile".to_string(), "server,jobs".to_string())]);

        let first = service
            .get_json(&state, "/api/v1/uebersicht", &query)
            .await
            .unwrap();
        assert_eq!(first["query"], json!("teile=server%2Cjobs"));
        let second = service
            .get_json(&state, "/api/v1/uebersicht", &query)
            .await
            .unwrap();
        assert_eq!(first, second);
        assert_eq!(hits.load(Ordering::SeqCst), 1);

        let wrong = state_for(&url, "falsch");
        assert_eq!(
            service
                .get_json(&wrong, "/api/v1/uebersicht", &query)
                .await
                .unwrap_err(),
            LagraError::Unauthorized
        );
        assert_eq!(
            service
                .get_json(&state, "/api/v1/jobs", &BTreeMap::new())
                .await
                .unwrap_err(),
            LagraError::EndpointMissing
        );

        let image = service
            .image_data_url(&state, "/api/v1/assets/a1/vorschau")
            .await
            .unwrap();
        assert_eq!(image, "data:image/png;base64,iVBORw==");
        let absolute = format!("{url}/api/v1/assets/a1/vorschau");
        assert_eq!(
            service.image_data_url(&state, &absolute).await.unwrap(),
            image
        );
        assert_eq!(
            service
                .image_data_url(&state, "/api/v1/assets/zz/vorschau")
                .await
                .unwrap_err(),
            LagraError::ImageMissing
        );

        let proxied = service
            .proxy_get(&state, "uebersicht", Some("teile=api"))
            .await
            .unwrap();
        assert_eq!(proxied.status, 200);
        assert!(proxied.content_type.starts_with("application/json"));
        let body: Value = serde_json::from_slice(&proxied.body).unwrap();
        assert_eq!(body["query"], json!("teile=api"));
        let passthrough = service.proxy_get(&wrong, "uebersicht", None).await.unwrap();
        assert_eq!(passthrough.status, 401);
        assert!(service.proxy_get(&state, "../geheim", None).await.is_err());

        // Customer data stays out of reach of the web UI, although the token could read it.
        assert_eq!(
            service.proxy_get(&state, "kunden", None).await.unwrap_err(),
            LagraError::NotAllowed("kunden".into())
        );
        let preview = service
            .proxy_get(&state, "assets/a1/vorschau", None)
            .await
            .unwrap();
        assert_eq!(
            (preview.content_type.as_str(), preview.body.as_slice()),
            ("image/png", [137, 80, 78, 71].as_slice())
        );
        // SVG and Next's HTML pages never render on the web UI's origin.
        let svg = service
            .proxy_get(&state, "assets/svg/vorschau", None)
            .await
            .unwrap();
        assert_eq!((svg.status, svg.body.len()), (200, 0));
        assert_eq!(svg.content_type, PLAIN_TEXT);
        let missing = service.proxy_get(&state, "jobs", None).await.unwrap();
        assert_eq!((missing.status, missing.body.len()), (404, 0));
        // Redirects are followed only below the API root.
        let inside = service
            .proxy_get(&state, "assets/innen/vorschau", None)
            .await
            .unwrap();
        assert_eq!(inside.body, vec![137, 80, 78, 71]);
        assert_eq!(
            service
                .proxy_get(&state, "assets/aussen/vorschau", None)
                .await
                .unwrap_err(),
            LagraError::Redirected(307)
        );

        let test = service.test(&state).await;
        assert_eq!(
            test,
            LagraTestResult {
                ok: true,
                status: 200,
                message: "Verbindung zu lagra hergestellt".into(),
                uebersicht: true
            }
        );
        let denied = service.test(&wrong).await;
        assert!(!denied.ok);
        assert_eq!(denied.status, 401);
        assert_eq!(denied.message, "lagra: Token ungültig (401)");
    }

    #[tokio::test]
    async fn test_detects_lagra_without_uebersicht() {
        let (url, _) = fake_lagra(false).await;
        let service = LagraService::new(crate::http::build_api_client().unwrap());
        let result = service.test(&state_for(&url, "t")).await;
        assert!(result.ok);
        assert!(!result.uebersicht);
        assert!(result.message.contains("lagra-Update nötig"));
        let unreachable = service.test(&state_for("http://127.0.0.1:9", "t")).await;
        assert!(!unreachable.ok);
        assert!(unreachable.message.starts_with("lagra nicht erreichbar: "));
    }
}
