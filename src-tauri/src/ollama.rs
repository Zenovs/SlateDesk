//! Ollama status for the AI widget, read from Ollama's HTTP API (`/api/version`, `/api/tags`).
//! Installing or starting Ollama is not the app's job (it would need root) – the widget shows
//! instructions instead.

use crate::http::{describe_error, parse_web_url, read_body_limited, HttpClient};
use crate::proc::find_in_path;
use reqwest::{Client, Url};
use serde::Serialize;
use serde_json::Value;
use std::net::IpAddr;
use std::time::Duration;
use tauri::State;

const DEFAULT_BASE_URL: &str = "http://localhost:11434";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
pub struct OllamaStatus {
    installed: bool,
    running: bool,
    version: Option<String>,
    models: Vec<String>,
}

/// API root of an Ollama server. The widget stores the OpenAI-compatible endpoint
/// (`http://host:11434/v1`), so a trailing `/v1` or `/api` is dropped.
fn api_root(base_url: Option<&str>) -> Result<Url, String> {
    let raw = base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_BASE_URL);
    let mut url = parse_web_url(raw)?;
    let path = url.path().trim_end_matches('/').to_string();
    let path = path
        .strip_suffix("/v1")
        .or_else(|| path.strip_suffix("/api"))
        .unwrap_or(&path)
        .to_string();
    url.set_path(&format!("{path}/"));
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn is_local(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

async fn get_json(client: &Client, root: &Url, endpoint: &str) -> Result<Value, String> {
    let url = root
        .join(endpoint)
        .map_err(|_| format!("Ungültige Ollama-Adresse: {root}"))?;
    let response = client
        .get(url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| describe_error(&e))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    let body = read_body_limited(response, MAX_BODY_BYTES).await?;
    serde_json::from_slice(&body).map_err(|_| "keine gültige JSON-Antwort".to_string())
}

/// Model names from `/api/tags` (`{ "models": [{ "name": "llama3.2:3b", … }] }`), sorted.
fn model_names(tags: &Value) -> Vec<String> {
    let mut names: Vec<String> = tags
        .get("models")
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m.get("name").or_else(|| m.get("model")))
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names.dedup();
    names
}

pub async fn check(client: &Client, base_url: Option<&str>) -> Result<OllamaStatus, String> {
    let root = api_root(base_url)?;
    let (version, tags) = tokio::join!(
        get_json(client, &root, "api/version"),
        get_json(client, &root, "api/tags")
    );
    let running = version.is_ok() || tags.is_ok();
    if let (Err(version_err), Err(_)) = (&version, &tags) {
        log::debug!("Ollama unter {root} nicht erreichbar: {version_err}");
    }
    let version = version
        .ok()
        .and_then(|v| v.get("version")?.as_str().map(str::to_string));
    let models = tags.as_ref().map(model_names).unwrap_or_default();
    // A remote server can only be judged by its answer; locally the binary counts too.
    let installed = running || (is_local(&root) && find_in_path("ollama").is_some());
    Ok(OllamaStatus {
        installed,
        running,
        version,
        models,
    })
}

/// Prüft, ob Ollama erreichbar ist, und liest Version und installierte Modelle.
#[tauri::command]
pub async fn check_ollama(
    base_url: Option<String>,
    http: State<'_, HttpClient>,
) -> Result<OllamaStatus, String> {
    check(&http.0, base_url.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;
    use axum::Json;
    use serde_json::json;

    #[test]
    fn api_root_strips_openai_suffix() {
        assert_eq!(api_root(None).unwrap().as_str(), "http://localhost:11434/");
        assert_eq!(
            api_root(Some("http://localhost:11434/v1"))
                .unwrap()
                .as_str(),
            "http://localhost:11434/"
        );
        assert_eq!(
            api_root(Some(" http://192.168.1.50:11434/v1/ "))
                .unwrap()
                .as_str(),
            "http://192.168.1.50:11434/"
        );
        assert_eq!(
            api_root(Some("https://ki.example.ch/ollama/api?x=1"))
                .unwrap()
                .as_str(),
            "https://ki.example.ch/ollama/"
        );
        assert!(api_root(Some("file:///etc/passwd")).is_err());
    }

    #[test]
    fn local_hosts_are_recognized() {
        for local in [
            "http://localhost:11434/",
            "http://127.0.0.1:11434/",
            "http://[::1]:11434/",
        ] {
            assert!(is_local(&Url::parse(local).unwrap()), "{local}");
        }
        assert!(!is_local(
            &Url::parse("http://192.168.1.50:11434/").unwrap()
        ));
    }

    #[test]
    fn model_names_are_sorted_and_unique() {
        let tags = json!({ "models": [
            { "name": "qwen2.5:7b", "model": "qwen2.5:7b" },
            { "name": "llama3.2:3b" },
            { "model": "mistral:latest" },
            { "name": "llama3.2:3b" }
        ]});
        assert_eq!(
            model_names(&tags),
            vec!["llama3.2:3b", "mistral:latest", "qwen2.5:7b"]
        );
        assert!(model_names(&json!({})).is_empty());
    }

    #[tokio::test]
    async fn reads_version_and_models_from_a_running_server() {
        let app = axum::Router::new()
            .route(
                "/api/version",
                get(|| async { Json(json!({ "version": "0.12.3" })) }),
            )
            .route(
                "/api/tags",
                get(|| async { Json(json!({ "models": [{ "name": "llama3.2:3b" }] })) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let client = crate::http::build_client().unwrap();

        let status = check(&client, Some(&format!("http://{addr}/v1")))
            .await
            .unwrap();
        assert_eq!(
            status,
            OllamaStatus {
                installed: true,
                running: true,
                version: Some("0.12.3".into()),
                models: vec!["llama3.2:3b".into()],
            }
        );

        let closed = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_addr = closed.local_addr().unwrap();
        drop(closed);
        let offline = check(&client, Some(&format!("http://{closed_addr}")))
            .await
            .unwrap();
        assert!(!offline.running);
        assert_eq!(offline.version, None);
        assert!(offline.models.is_empty());
    }
}
