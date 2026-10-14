//! Shared HTTP client and the generic `http_fetch` command. External requests run in Rust so
//! widgets are not limited by CORS or the webview CSP.

use base64::Engine;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use reqwest::{Client, Method, Response};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::State;

pub const USER_AGENT: &str = concat!("SlateDesk/", env!("CARGO_PKG_VERSION"));
const FETCH_MAX_BYTES: usize = 15 * 1024 * 1024;
const FETCH_DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);
const FETCH_MAX_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_REDIRECTS: usize = 5;

/// Managed wrapper around the one reqwest client of the app (connection pool, TLS config).
#[derive(Clone)]
pub struct HttpClient(pub Client);

pub fn build_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(8))
        .pool_idle_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
        .build()
        .map_err(|e| format!("HTTP-Client konnte nicht erstellt werden: {e}"))
}

/// `/api/v1/` – lagra's and planbar's API root below their base URL.
const API_ROOT_MARKER: &str = "/api/v1/";

/// Redirects the lagra/planbar client may follow: same scheme, host and port as the first
/// request and still below its `…/api/v1/`. Anything else (another host, a router page, a
/// loopback service) is not followed, so a web UI session can never read it through the proxy.
fn stays_below_api_root(next: &reqwest::Url, first: &reqwest::Url) -> bool {
    let first_path = first.path();
    let Some(root_end) = first_path
        .find(API_ROOT_MARKER)
        .map(|i| i + API_ROOT_MARKER.len())
    else {
        return false;
    };
    next.scheme() == first.scheme()
        && next.host_str() == first.host_str()
        && next.port_or_known_default() == first.port_or_known_default()
        && next.path().starts_with(&first_path[..root_end])
}

/// Client for lagra and planbar: the credentials are attached by the services, and the web
/// UI proxies pass answers through, so redirects must not leave the configured API root.
pub fn build_api_client() -> Result<Client, String> {
    Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(8))
        .pool_idle_timeout(Duration::from_secs(60))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let allowed = attempt.previous().len() <= MAX_REDIRECTS
                && attempt
                    .previous()
                    .first()
                    .is_some_and(|first| stays_below_api_root(attempt.url(), first));
            if allowed {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .build()
        .map_err(|e| format!("HTTP-Client konnte nicht erstellt werden: {e}"))
}

/// Short German description of a transport error (without the URL, which may carry queries).
pub fn describe_error(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        return "Zeitüberschreitung".to_string();
    }
    let mut root: &dyn std::error::Error = error;
    while let Some(source) = root.source() {
        root = source;
    }
    let detail = root.to_string();
    if error.is_connect() {
        format!("keine Verbindung ({detail})")
    } else if error.is_redirect() {
        "zu viele Weiterleitungen".to_string()
    } else if error.is_body() || error.is_decode() {
        format!("Antwort unvollständig ({detail})")
    } else {
        detail
    }
}

/// Reads the body up to `limit` bytes; larger responses are an error, not truncated.
pub async fn read_body_limited(mut response: Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|len| len > limit as u64)
    {
        return Err(format!(
            "Antwort zu gross (maximal {} MB)",
            limit / (1024 * 1024)
        ));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| describe_error(&e))? {
        if body.len() + chunk.len() > limit {
            return Err(format!(
                "Antwort zu gross (maximal {} MB)",
                limit / (1024 * 1024)
            ));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub fn content_type(headers: &HeaderMap) -> String {
    headers
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string()
}

/// An upstream answer the web UI proxy (`/api/lagra/…`, `/api/planbar/…`) passes through.
#[derive(Debug)]
pub struct ProxyResponse {
    pub status: u16,
    pub content_type: String,
    pub cache_control: Option<String>,
    pub body: Vec<u8>,
}

/// Accepts only absolute http(s) URLs.
pub fn parse_web_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| format!("Ungültige URL: {url}"))?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => Ok(parsed),
        _ => Err("Nur http- und https-Adressen sind erlaubt".to_string()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    response_type: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResponse {
    status: u16,
    content_type: String,
    body: String,
    final_url: String,
}

fn parse_method(method: Option<&str>) -> Result<Method, String> {
    let name = method.unwrap_or("GET").trim().to_ascii_uppercase();
    match name.as_str() {
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" => {
            Method::from_bytes(name.as_bytes()).map_err(|e| e.to_string())
        }
        _ => Err(format!("HTTP-Methode nicht erlaubt: {name}")),
    }
}

fn parse_headers(headers: Option<HashMap<String, String>>) -> Result<HeaderMap, String> {
    let mut map = HeaderMap::new();
    for (name, value) in headers.unwrap_or_default() {
        let header_name = HeaderName::from_bytes(name.trim().as_bytes())
            .map_err(|_| format!("Ungültiger Header-Name: {name}"))?;
        let header_value = HeaderValue::from_str(&value)
            .map_err(|_| format!("Ungültiger Wert für Header {name}"))?;
        map.insert(header_name, header_value);
    }
    Ok(map)
}

pub async fn fetch(client: &Client, req: FetchRequest) -> Result<FetchResponse, String> {
    let url = parse_web_url(&req.url)?;
    let method = parse_method(req.method.as_deref())?;
    let headers = parse_headers(req.headers)?;
    let as_base64 = match req.response_type.as_deref() {
        None | Some("text") => false,
        Some("base64") => true,
        Some(other) => return Err(format!("Unbekannter responseType: {other}")),
    };
    let timeout = req
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(FETCH_DEFAULT_TIMEOUT)
        .clamp(Duration::from_millis(500), FETCH_MAX_TIMEOUT);

    let mut builder = client
        .request(method, url)
        .headers(headers)
        .timeout(timeout);
    if let Some(body) = req.body {
        builder = builder.body(body);
    }
    let response = builder
        .send()
        .await
        .map_err(|e| format!("Anfrage fehlgeschlagen: {}", describe_error(&e)))?;
    let status = response.status().as_u16();
    let content_type = content_type(response.headers());
    let final_url = response.url().to_string();
    let bytes = tokio::time::timeout(timeout, read_body_limited(response, FETCH_MAX_BYTES))
        .await
        .map_err(|_| "Zeitüberschreitung beim Lesen der Antwort".to_string())??;
    let body = if as_base64 {
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(FetchResponse {
        status,
        content_type,
        body,
        final_url,
    })
}

#[tauri::command]
pub async fn http_fetch(
    req: FetchRequest,
    http: State<'_, HttpClient>,
) -> Result<FetchResponse, String> {
    fetch(&http.0, req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_urls_are_accepted() {
        assert!(parse_web_url("https://example.org/feed").is_ok());
        assert!(parse_web_url(" http://192.168.1.10:3000/api ").is_ok());
        assert!(parse_web_url("file:///etc/passwd").is_err());
        assert!(parse_web_url("ftp://x").is_err());
        assert!(parse_web_url("nonsense").is_err());
    }

    #[test]
    fn methods_and_headers_are_validated() {
        assert_eq!(parse_method(None).unwrap(), Method::GET);
        assert_eq!(parse_method(Some("post")).unwrap(), Method::POST);
        assert!(parse_method(Some("CONNECT")).is_err());
        let headers = parse_headers(Some(HashMap::from([(
            "Accept".to_string(),
            "application/json".to_string(),
        )])))
        .unwrap();
        assert_eq!(headers["accept"], "application/json");
        assert!(parse_headers(Some(HashMap::from([(
            "Bad Header".to_string(),
            "x".to_string()
        )])))
        .is_err());
        assert!(parse_headers(Some(HashMap::from([(
            "X-A".to_string(),
            "a\nb".to_string()
        )])))
        .is_err());
    }

    #[test]
    fn api_redirects_must_stay_below_the_api_root() {
        let url = |s: &str| reqwest::Url::parse(s).unwrap();
        let first = url("https://lagra.example.ch/pfad/api/v1/uebersicht");
        assert!(stays_below_api_root(
            &url("https://lagra.example.ch/pfad/api/v1/jobs"),
            &first
        ));
        for outside in [
            "https://lagra.example.ch/pfad/admin",
            "https://lagra.example.ch/api/v1/jobs",
            "http://lagra.example.ch/pfad/api/v1/jobs",
            "https://lagra.example.ch:8443/pfad/api/v1/jobs",
            "https://evil.example.ch/pfad/api/v1/jobs",
            "http://127.0.0.1:11434/api/tags",
        ] {
            assert!(!stays_below_api_root(&url(outside), &first), "{outside}");
        }
        assert!(!stays_below_api_root(
            &url("https://x.ch/a"),
            &url("https://x.ch/kein-api-pfad")
        ));
    }

    #[tokio::test]
    async fn api_client_stops_at_redirects_leaving_the_api_root() {
        use axum::response::Redirect;
        use axum::routing::get;

        let app = axum::Router::new()
            .route(
                "/api/v1/innen",
                get(|| async { Redirect::temporary("/api/v1/ziel") }),
            )
            .route(
                "/api/v1/aussen",
                get(|| async { Redirect::temporary("/intern/geheim") }),
            )
            .route("/api/v1/ziel", get(|| async { "ziel" }))
            .route("/intern/geheim", get(|| async { "geheim" }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let client = build_api_client().unwrap();

        let inside = client
            .get(format!("http://{addr}/api/v1/innen"))
            .send()
            .await
            .unwrap();
        assert_eq!(inside.status(), 200);
        assert_eq!(inside.text().await.unwrap(), "ziel");
        let outside = client
            .get(format!("http://{addr}/api/v1/aussen"))
            .send()
            .await
            .unwrap();
        assert_eq!(outside.status(), 307);
        assert_ne!(outside.text().await.unwrap(), "geheim");
    }

    fn request(url: String, response_type: Option<&str>) -> FetchRequest {
        FetchRequest {
            url,
            method: None,
            headers: None,
            body: None,
            timeout_ms: None,
            response_type: response_type.map(Into::into),
        }
    }

    #[tokio::test]
    async fn fetch_follows_at_most_five_redirects_and_caps_size() {
        use axum::extract::Path;
        use axum::response::{IntoResponse, Redirect};
        use axum::routing::get;

        let app = axum::Router::new()
            .route(
                "/r/{n}",
                get(|Path(n): Path<u32>| async move {
                    if n == 0 {
                        "ziel".into_response()
                    } else {
                        Redirect::temporary(&format!("/r/{}", n - 1)).into_response()
                    }
                }),
            )
            .route("/bin", get(|| async { vec![0u8, 1, 2, 255] }))
            .route("/gross", get(|| async { vec![b'x'; FETCH_MAX_BYTES + 1] }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let client = build_client().unwrap();

        let ok = fetch(&client, request(format!("http://{addr}/r/5"), None))
            .await
            .unwrap();
        assert_eq!((ok.status, ok.body.as_str()), (200, "ziel"));
        assert_eq!(ok.final_url, format!("http://{addr}/r/0"));
        let err = fetch(&client, request(format!("http://{addr}/r/6"), None))
            .await
            .unwrap_err();
        assert!(err.contains("zu viele Weiterleitungen"), "{err}");

        let bin = fetch(
            &client,
            request(format!("http://{addr}/bin"), Some("base64")),
        )
        .await
        .unwrap();
        assert_eq!(bin.body, "AAEC/w==");

        let err = fetch(&client, request(format!("http://{addr}/gross"), None))
            .await
            .unwrap_err();
        assert_eq!(err, "Antwort zu gross (maximal 15 MB)");
        assert!(
            fetch(&client, request(format!("http://{addr}/bin"), Some("blob")))
                .await
                .is_err()
        );
    }
}
