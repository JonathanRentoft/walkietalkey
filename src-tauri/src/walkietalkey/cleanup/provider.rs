//! Cleanup providers (DESK-81, DESK-83, DESK-87). OpenAI-compatible endpoints
//! (OpenAI, Groq, Cerebras, OpenRouter, Custom: Azure OpenAI, LM Studio,
//! Ollama), Anthropic's Messages API, and Apple Intelligence on the device.
//! HTTP clients are kept per endpoint with a connection pool, so a warm-up
//! request while the user talks leaves an open TLS connection for the call
//! after release, and the connection stays alive between dictations.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::Duration;

use once_cell::sync::Lazy;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// A cleanup provider: one system prompt, one user message, one answer.
pub trait Provider: Send + Sync {
    /// The provider's name for "Vis hvad der blev sendt" (DESK-85).
    fn label(&self) -> String;
    /// Whether the text leaves this computer (consent, DESK-82).
    fn is_cloud(&self) -> bool;
    fn complete<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<String, String>>;
    /// Opens the connection ahead of the call (DESK-87). Best effort.
    fn warm(&self) {}
}

/// Wire format of an HTTP provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    OpenAi,
    Anthropic,
}

#[derive(Debug, Clone)]
pub struct HttpProvider {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
    pub format: Format,
}

static CLIENTS: Lazy<Mutex<HashMap<String, reqwest::Client>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// The pooled client for an endpoint, created once and reused (DESK-87).
fn client_for(base_url: &str) -> reqwest::Client {
    let mut clients = CLIENTS.lock().unwrap();
    clients
        .entry(base_url.to_string())
        .or_insert_with(|| {
            reqwest::Client::builder()
                .pool_idle_timeout(Duration::from_secs(300))
                .pool_max_idle_per_host(2)
                .tcp_keepalive(Duration::from_secs(30))
                .connect_timeout(Duration::from_secs(5))
                .build()
                .expect("HTTP client")
        })
        .clone()
}

/// Reasoning models reject a temperature; everything else gets 0 (DESK-83).
fn takes_temperature(model: &str) -> bool {
    let m = model.to_ascii_lowercase();
    !(m.starts_with("o1") || m.starts_with("o3") || m.starts_with("o4") || m.starts_with("gpt-5"))
}

impl HttpProvider {
    fn headers(&self) -> Result<HeaderMap, String> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(key) = self.api_key.as_deref().filter(|k| !k.is_empty()) {
            match self.format {
                Format::OpenAi => {
                    let value = HeaderValue::from_str(&format!("Bearer {key}"))
                        .map_err(|e| e.to_string())?;
                    headers.insert(AUTHORIZATION, value);
                }
                Format::Anthropic => {
                    headers.insert(
                        "x-api-key",
                        HeaderValue::from_str(key).map_err(|e| e.to_string())?,
                    );
                }
            }
        }
        if self.format == Format::Anthropic {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }
        Ok(headers)
    }

    /// The request body; `reasoning_off` adds the field that turns
    /// reasoning off where the endpoint understands it (Handy's rule).
    pub fn body(&self, system: &str, user: &str, reasoning_off: bool) -> Value {
        match self.format {
            Format::Anthropic => json!({
                "model": self.model,
                "max_tokens": 2048,
                "temperature": 0,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            }),
            Format::OpenAi => {
                let mut body = json!({
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                });
                if takes_temperature(&self.model) {
                    body["temperature"] = json!(0);
                }
                if reasoning_off {
                    if self.id == "openrouter" {
                        body["reasoning"] = json!({"effort": "none", "exclude": true});
                    } else {
                        body["reasoning_effort"] = json!("none");
                    }
                }
                body
            }
        }
    }

    fn url(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        match self.format {
            Format::OpenAi => format!("{base}/chat/completions"),
            Format::Anthropic => format!("{base}/messages"),
        }
    }

    async fn post(&self, body: &Value) -> Result<(u16, Value), String> {
        let response = client_for(&self.base_url)
            .post(self.url())
            .headers(self.headers()?)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("request failed: {e}"))?;
        let status = response.status().as_u16();
        let value = response.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, value))
    }

    fn answer(&self, value: &Value) -> Option<String> {
        match self.format {
            Format::OpenAi => value["choices"][0]["message"]["content"]
                .as_str()
                .map(str::to_string),
            Format::Anthropic => value["content"].as_array().map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            }),
        }
    }
}

/// Endpoints (`base_url|model`) that refused the reasoning field, as Handy
/// remembers them, so they are not asked twice per dictation.
static REJECTS_REASONING: once_cell::sync::Lazy<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = once_cell::sync::Lazy::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// Whether an endpoint is on this computer: its host is exactly `localhost`
/// or a loopback address. A prefix check would let `http://localhost@host`
/// or `http://localhost.example.com` through (DESK-102, PRIV-04).
pub fn is_local_url(url: &str) -> bool {
    let Ok(parsed) = tauri::Url::parse(url.trim()) else {
        return false;
    };
    parsed.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_start_matches('[')
                .trim_end_matches(']')
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    })
}

impl Provider for HttpProvider {
    fn label(&self) -> String {
        self.label.clone()
    }

    fn is_cloud(&self) -> bool {
        !is_local_url(&self.base_url)
    }

    fn complete<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<String, String>> {
        Box::pin(async move {
            let endpoint = format!("{}|{}", self.base_url, self.model);
            let reasoning_off = self.format == Format::OpenAi
                && !REJECTS_REASONING.lock().unwrap().contains(&endpoint);
            let (status, value) = self.post(&self.body(system, user, reasoning_off)).await?;
            // Some endpoints reject the reasoning field: retry once without
            // it, and remember, so later dictations make one call (DESK-87).
            let (status, value) = if reasoning_off && (status == 400 || status == 422) {
                let retried = self.post(&self.body(system, user, false)).await?;
                if (200..300).contains(&retried.0) {
                    REJECTS_REASONING.lock().unwrap().insert(endpoint);
                }
                retried
            } else {
                (status, value)
            };
            if !(200..300).contains(&status) {
                return Err(format!("HTTP {status}"));
            }
            self.answer(&value)
                .ok_or_else(|| "no answer in the response".to_string())
        })
    }

    fn warm(&self) {
        let provider = self.clone();
        tauri::async_runtime::spawn(async move { provider.warm_up().await });
    }
}

impl HttpProvider {
    /// The warm-up request that [`Provider::warm`] runs in the background.
    pub(crate) async fn warm_up(&self) {
        let client = client_for(&self.base_url);
        let url = match self.format {
            Format::OpenAi => format!("{}/models", self.base_url.trim_end_matches('/')),
            Format::Anthropic => self.base_url.trim_end_matches('/').to_string(),
        };
        let headers = self.headers().unwrap_or_default();
        // The answer does not matter; the pooled connection does. Reading the
        // body to the end returns the connection to the pool instead of
        // closing it.
        if let Ok(response) = client.get(url).headers(headers).send().await {
            let _ = response.bytes().await;
        }
    }
}

/// Apple Intelligence: on the device, no key (DESK-81).
pub struct AppleProvider;

impl Provider for AppleProvider {
    fn label(&self) -> String {
        "Apple Intelligence".to_string()
    }

    fn is_cloud(&self) -> bool {
        false
    }

    fn complete<'a>(
        &'a self,
        system: &'a str,
        user: &'a str,
    ) -> BoxFuture<'a, Result<String, String>> {
        let (system, user) = (system.to_string(), user.to_string());
        Box::pin(async move {
            // Handy's Apple Intelligence bridge exists on Apple Silicon only
            // (`lib.rs`); an Intel Mac build has no such module.
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            {
                tauri::async_runtime::spawn_blocking(move || {
                    if !crate::apple_intelligence::check_apple_intelligence_availability() {
                        return Err("Apple Intelligence is not available".to_string());
                    }
                    crate::apple_intelligence::process_text_with_system_prompt(&system, &user, 2048)
                })
                .await
                .map_err(|e| e.to_string())?
            }
            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            {
                let _ = (system, user);
                Err("Apple Intelligence is only on Macs with Apple silicon".to_string())
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn openai(model: &str) -> HttpProvider {
        HttpProvider {
            id: "openai".into(),
            label: "OpenAI".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: model.into(),
            api_key: Some("sk-test".into()),
            format: Format::OpenAi,
        }
    }

    #[test]
    fn requests_ask_for_temperature_0_and_no_reasoning() {
        let body = openai("gpt-4o-mini").body("sys", "<dictation>\nhej\n</dictation>", true);
        assert_eq!(body["temperature"], json!(0));
        assert_eq!(body["reasoning_effort"], json!("none"));
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(
            body["messages"][1]["content"],
            "<dictation>\nhej\n</dictation>"
        );
    }

    #[test]
    fn reasoning_models_get_no_temperature() {
        let body = openai("gpt-5-mini").body("s", "u", true);
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn openrouter_uses_its_own_reasoning_field() {
        let mut p = openai("x");
        p.id = "openrouter".into();
        let body = p.body("s", "u", true);
        assert_eq!(body["reasoning"]["effort"], "none");
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn anthropic_requests_have_the_messages_shape() {
        let p = HttpProvider {
            format: Format::Anthropic,
            base_url: "https://api.anthropic.com/v1".into(),
            ..openai("claude-haiku-4-5")
        };
        let body = p.body("sys", "user", false);
        assert_eq!(body["system"], "sys");
        assert_eq!(body["messages"][0]["content"], "user");
        assert!(p.url().ends_with("/v1/messages"));
        assert!(p.headers().unwrap().contains_key("x-api-key"));
    }

    /// A fake OpenAI-compatible server: answers every request with a chat
    /// completion that echoes the dictation in upper case, records the
    /// requests, and counts TCP connections.
    async fn fake_server() -> (
        String,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{Arc, Mutex};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let connections = Arc::new(AtomicUsize::new(0));
        let (reqs, conns) = (Arc::clone(&requests), Arc::clone(&connections));
        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                conns.fetch_add(1, Ordering::SeqCst);
                let reqs = Arc::clone(&reqs);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    loop {
                        let mut chunk = [0u8; 8192];
                        let n = match socket.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => n,
                        };
                        buf.extend_from_slice(&chunk[..n]);
                        // One request per loop: headers, then Content-Length body.
                        let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                            continue;
                        };
                        let head = String::from_utf8_lossy(&buf[..end]).to_string();
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if buf.len() < end + 4 + len {
                            continue;
                        }
                        let body =
                            String::from_utf8_lossy(&buf[end + 4..end + 4 + len]).to_string();
                        buf.drain(..end + 4 + len);
                        reqs.lock().unwrap().push(format!("{head}\n\n{body}"));
                        let answer = if head.starts_with("POST") {
                            let value: Value = serde_json::from_str(&body).unwrap();
                            let user = value["messages"][1]["content"]
                                .as_str()
                                .unwrap_or("")
                                .to_string();
                            let text = user
                                .replace("<dictation>", "")
                                .replace("</dictation>", "")
                                .trim()
                                .to_uppercase();
                            json!({"choices": [{"message": {"content": text}}]}).to_string()
                        } else {
                            json!({"data": []}).to_string()
                        };
                        let response = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: keep-alive\r\n\r\n{}",
                            answer.len(),
                            answer
                        );
                        if socket.write_all(response.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (url, requests, connections)
    }

    #[tokio::test]
    async fn calls_reach_the_endpoint_with_the_key_and_reuse_the_warm_connection() {
        let (url, requests, connections) = fake_server().await;
        let provider = HttpProvider {
            id: "custom".into(),
            label: "Testudbyder".into(),
            base_url: url,
            model: "fake-model".into(),
            api_key: Some("sk-local".into()),
            format: Format::OpenAi,
        };
        // The warm-up as `warm` runs it, awaited here so its connection is
        // back in the pool before the calls.
        provider.warm_up().await;
        let first = provider
            .complete("sys", "<dictation>\nvi ses\n</dictation>")
            .await
            .unwrap();
        let second = provider
            .complete("sys", "<dictation>\nhej\n</dictation>")
            .await
            .unwrap();
        assert_eq!(first, "VI SES");
        assert_eq!(second, "HEJ");
        let requests = requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 3, "warm-up plus two calls");
        assert!(requests[0].starts_with("GET /v1/models"));
        assert!(requests[1].starts_with("POST /v1/chat/completions"));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("authorization: bearer sk-local"));
        assert!(requests[1].contains("\"temperature\":0"));
        assert_eq!(
            connections.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "the warm connection is reused (DESK-87)"
        );
    }

    #[test]
    fn localhost_endpoints_are_not_cloud() {
        let mut p = openai("llama3");
        p.base_url = "http://localhost:11434/v1".into();
        assert!(!p.is_cloud());
        assert!(openai("gpt-4o").is_cloud());
    }
}

#[cfg(test)]
mod local_url_tests {
    use super::is_local_url;

    #[test]
    fn only_this_computer_counts_as_local() {
        assert!(is_local_url("http://localhost:11434/v1"));
        assert!(is_local_url("http://127.0.0.1:8080/v1"));
        assert!(is_local_url("http://[::1]:11434/v1"));
        assert!(!is_local_url("http://localhost@api.example.com/v1"));
        assert!(!is_local_url("http://localhost.example.com/v1"));
        assert!(!is_local_url("http://127.0.0.1.nip.io/v1"));
        assert!(!is_local_url("https://api.openai.com/v1"));
        assert!(!is_local_url("not a url"));
    }
}
