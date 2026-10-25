//! The app's side of the recorder's local API (`training/wt_train/recorder/server.py`).
//!
//! The recorder (`wt-train record`) serves a page on 127.0.0.1 and hands the running app
//! `http://127.0.0.1:<port>/app/v1#<token>` through `--training-session`. The app connects
//! out to that address only (it opens no socket of its own) and sends the token as a bearer
//! token on every request:
//!
//! | Request                  | Body                                  | Answer                         |
//! | ------------------------ | ------------------------------------- | ------------------------------ |
//! | `POST hello`             | version, OS, paired phones, input     | training id, device, style, phone |
//! | `GET next?after=N`       |                                       | commands numbered above N      |
//! | `POST takes`             | 16 kHz mono PCM16 LE; `X-WT-Take` meta | saved, check                   |
//! | `POST events`            | `{"type": ...}`                       | `{}`                           |
//!
//! Only `http://127.0.0.1:<port>/app/v1` is accepted, and the HTTP client never uses a
//! system proxy for it.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The recorder holds a long poll this long; the client waits a little more.
pub const LONG_POLL_S: u32 = 20;
const LONG_POLL_SLACK: Duration = Duration::from_secs(10);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
pub const TAKE_HEADER: &str = "X-WT-Take";
const PATH: &str = "/app/v1";

/// Where the recorder's session is and its token.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionUrl {
    /// `http://127.0.0.1:<port>/app/v1`
    pub base: String,
    token: String,
}

impl std::fmt::Debug for SessionUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the token.
        f.debug_struct("SessionUrl")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

/// `http://127.0.0.1:<port>/app/v1#<token>`, nothing else: the recorder runs on this
/// computer, and the token (16 to 128 base64url characters) comes in the fragment, which
/// is never sent anywhere.
pub fn parse_session_url(url: &str) -> Result<SessionUrl, String> {
    let rest = url
        .strip_prefix("http://127.0.0.1:")
        .ok_or("a training session must be at http://127.0.0.1:<port>")?;
    let (address, token) = rest
        .split_once('#')
        .ok_or("the training session's link has no token")?;
    let (port, path) = address.split_at(address.find('/').unwrap_or(address.len()));
    let port: u16 = port
        .parse()
        .ok()
        .filter(|p| *p > 0)
        .ok_or("the training session's port is not a number")?;
    if path != PATH && path != "/app/v1/" {
        return Err(format!("the training session's path must be {PATH}"));
    }
    let token_ok = (16..=128).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !token_ok {
        return Err("the training session's token is not valid".into());
    }
    Ok(SessionUrl {
        base: format!("http://127.0.0.1:{port}{PATH}"),
        token: token.to_string(),
    })
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HelloPhone {
    pub id: String,
    pub name: String,
    pub platform: Option<String>,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hello {
    pub app: &'static str,
    pub version: String,
    pub os: &'static str,
    pub phones: Vec<HelloPhone>,
    pub input: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct HelloAnswer {
    /// The training session id, 16 bytes base64url.
    pub training: String,
    /// `phone` or `mac`.
    pub device: String,
    /// `normal` or `whisper`.
    pub style: String,
    /// The phone to record on (device id, base64url), for a phone condition.
    pub phone: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PromptItem {
    pub prompt: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct PromptLast {
    pub prompt: String,
    pub text: String,
    pub check: String,
}

/// One command from the recorder (`training/wt_train/recorder/session.py`).
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    Prompt {
        next: Option<PromptItem>,
        last: Option<PromptLast>,
        done: u32,
        total: u32,
    },
    MacStart {
        prompt: String,
    },
    MacStop,
    MacCancel,
    End,
    /// A command of a newer recorder.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Numbered {
    pub seq: u64,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Debug, Deserialize)]
struct Commands {
    commands: Vec<Numbered>,
}

/// What the recorder needs to know about a take (`X-WT-Take`, base64url JSON).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct TakeMeta {
    pub prompt: String,
    /// `phone` or `mac`.
    pub source: &'static str,
    /// The phone's audio session (base64url), for a phone take.
    pub session: Option<String>,
    /// The phone's device id (base64url).
    pub phone: Option<String>,
    pub microphone: Option<String>,
    /// 200 ms blocks the phone sent, and how many never arrived (DESK-61).
    pub chunks: Option<u32>,
    pub missing: u32,
    pub duration_ms: u32,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct TakeAnswer {
    pub saved: bool,
    pub check: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkError {
    /// The recorder is not there (it stopped, or never started).
    Unreachable(String),
    /// The token was refused: the session is over or another one replaced it.
    Unauthorized,
    /// The recorder refused, with its reason (for example `no_phone`).
    Refused {
        error: String,
        message: String,
    },
    Bad(String),
}

impl std::fmt::Display for LinkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LinkError::Unreachable(e) => write!(f, "the recorder is not reachable: {e}"),
            LinkError::Unauthorized => write!(f, "the recorder refused the session's token"),
            LinkError::Refused { error, message } => write!(f, "{error}: {message}"),
            LinkError::Bad(e) => write!(f, "{e}"),
        }
    }
}

/// HTTP to the recorder on 127.0.0.1.
pub struct RecorderLink {
    url: SessionUrl,
    http: reqwest::Client,
}

impl RecorderLink {
    pub fn new(url: SessionUrl) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            // 127.0.0.1 never goes through a proxy (reqwest's system-proxy feature is on).
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { url, http })
    }

    pub fn base(&self) -> &str {
        &self.url.base
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}/{path}", self.url.base))
            .bearer_auth(&self.url.token)
    }

    async fn answer<T: serde::de::DeserializeOwned>(
        sent: Result<reqwest::Response, reqwest::Error>,
    ) -> Result<T, LinkError> {
        let response = sent.map_err(|e| LinkError::Unreachable(e.to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(LinkError::Unauthorized);
        }
        let body = response
            .bytes()
            .await
            .map_err(|e| LinkError::Unreachable(e.to_string()))?;
        if !status.is_success() {
            let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            return Err(LinkError::Refused {
                error: v["error"].as_str().unwrap_or("http").to_string(),
                message: v["message"]
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| status.to_string()),
            });
        }
        serde_json::from_slice(&body).map_err(|e| LinkError::Bad(e.to_string()))
    }

    pub async fn hello(&self, hello: &Hello) -> Result<HelloAnswer, LinkError> {
        let sent = self
            .request(reqwest::Method::POST, "hello")
            .timeout(REQUEST_TIMEOUT)
            .json(hello)
            .send()
            .await;
        Self::answer(sent).await
    }

    /// The commands numbered above `after`, waiting up to `wait_s` seconds for one.
    pub async fn next(&self, after: u64, wait_s: u32) -> Result<Vec<Numbered>, LinkError> {
        let sent = self
            .request(
                reqwest::Method::GET,
                &format!("next?after={after}&wait={wait_s}"),
            )
            .timeout(Duration::from_secs(wait_s.into()) + LONG_POLL_SLACK)
            .send()
            .await;
        Ok(Self::answer::<Commands>(sent).await?.commands)
    }

    pub async fn take(&self, meta: &TakeMeta, pcm16: Vec<u8>) -> Result<TakeAnswer, LinkError> {
        let encoded = wt_relay_client::wt_protocol::b64u_encode(
            &serde_json::to_vec(meta).map_err(|e| LinkError::Bad(e.to_string()))?,
        );
        let sent = self
            .request(reqwest::Method::POST, "takes")
            .timeout(REQUEST_TIMEOUT)
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .header(TAKE_HEADER, encoded)
            .body(pcm16)
            .send()
            .await;
        Self::answer(sent).await
    }

    pub async fn event(&self, event: &serde_json::Value) -> Result<(), LinkError> {
        let sent = self
            .request(reqwest::Method::POST, "events")
            .timeout(REQUEST_TIMEOUT)
            .json(event)
            .send()
            .await;
        Self::answer::<serde_json::Value>(sent).await.map(|_| ())
    }
}

/// 16 kHz samples in [-1, 1] as PCM16 little-endian (the phone's blocks come back exactly).
pub fn pcm16_bytes(samples: &[f32]) -> Vec<u8> {
    samples
        .iter()
        .flat_map(|s| ((s * 32768.0).round().clamp(-32768.0, 32767.0) as i16).to_le_bytes())
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    pub const TOKEN: &str = "dGVzdC10b2tlbi1mb3ItdGhlLXJlY29yZGVyLWFwcA";

    /// One request as the fake recorder saw it.
    #[derive(Debug, Clone)]
    pub struct Seen {
        pub method: String,
        pub path: String,
        pub headers: Vec<(String, String)>,
        pub body: Vec<u8>,
    }

    impl Seen {
        pub fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str())
        }
    }

    /// The answer to a request, or `None` to hold it (a long poll with nothing to say yet).
    pub type Responder = Arc<dyn Fn(&Seen) -> Option<(u16, String)> + Send + Sync>;

    /// A recorder on 127.0.0.1: answers each request with `respond`, one per connection. A
    /// held request is asked again every 20 ms, and answered with no commands after 2 s.
    pub async fn fake_recorder(respond: Responder) -> (SessionUrl, Arc<Mutex<Vec<Seen>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            loop {
                let Ok((mut tcp, _)) = listener.accept().await else {
                    return;
                };
                let (log, respond) = (Arc::clone(&log), Arc::clone(&respond));
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 8192];
                    let head_end = loop {
                        let n = tcp.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let mut lines = head.split("\r\n");
                    let mut first = lines.next().unwrap_or("").split(' ');
                    let method = first.next().unwrap_or("").to_string();
                    let path = first.next().unwrap_or("").to_string();
                    let headers: Vec<(String, String)> = lines
                        .filter_map(|l| l.split_once(": "))
                        .map(|(k, v)| (k.to_string(), v.to_string()))
                        .collect();
                    let length: usize = headers
                        .iter()
                        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                        .and_then(|(_, v)| v.parse().ok())
                        .unwrap_or(0);
                    let mut body = buf[head_end..].to_vec();
                    while body.len() < length {
                        let n = tcp.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        body.extend_from_slice(&chunk[..n]);
                    }
                    let request = Seen {
                        method,
                        path,
                        headers,
                        body,
                    };
                    log.lock().unwrap().push(request.clone());
                    let mut held = 0;
                    let (status, answer) = loop {
                        if let Some(a) = respond(&request) {
                            break a;
                        }
                        held += 1;
                        if held > 100 {
                            break (200, r#"{"commands":[]}"#.to_string());
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                    };
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{answer}",
                        answer.len()
                    );
                    let _ = tcp.write_all(reply.as_bytes()).await;
                    let _ = tcp.shutdown().await;
                });
            }
        });
        let url = parse_session_url(&format!("http://127.0.0.1:{port}/app/v1#{TOKEN}")).unwrap();
        (url, seen)
    }

    #[test]
    fn only_a_recorder_on_this_computer_is_accepted() {
        let ok = parse_session_url(&format!("http://127.0.0.1:8765/app/v1#{TOKEN}")).unwrap();
        assert_eq!(ok.base, "http://127.0.0.1:8765/app/v1");
        assert!(
            !format!("{ok:?}").contains(TOKEN),
            "the token is never logged"
        );
        for bad in [
            format!("https://127.0.0.1:8765/app/v1#{TOKEN}"),
            format!("http://localhost:8765/app/v1#{TOKEN}"),
            format!("http://127.0.0.2:8765/app/v1#{TOKEN}"),
            format!("http://127.0.0.1.evil.example:8765/app/v1#{TOKEN}"),
            format!("http://user@127.0.0.1:8765/app/v1#{TOKEN}"),
            format!("http://127.0.0.1:8765/other#{TOKEN}"),
            format!("http://127.0.0.1:0/app/v1#{TOKEN}"),
            format!("http://127.0.0.1:99999/app/v1#{TOKEN}"),
            "http://127.0.0.1:8765/app/v1".to_string(),
            "http://127.0.0.1:8765/app/v1#short".to_string(),
            format!("http://127.0.0.1:8765/app/v1#{TOKEN}?x=1"),
        ] {
            assert!(parse_session_url(&bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn hello_next_take_and_event_carry_the_token() {
        let respond: Responder = Arc::new(|r: &Seen| {
            Some(match r.path.as_str() {
            "/app/v1/hello" => (
                200,
                r#"{"training":"AAAAAAAAAAAAAAAAAAAAAA","device":"phone","style":"whisper","phone":"cGhvbmU"}"#.into(),
            ),
            p if p.starts_with("/app/v1/next") => (
                200,
                r#"{"commands":[{"seq":1,"type":"prompt","next":{"prompt":"s0001","text":"Hej."},"last":null,"done":0,"total":3},{"seq":2,"type":"mac_start","prompt":"s0001"},{"seq":3,"type":"later_thing"}]}"#.into(),
            ),
            "/app/v1/takes" => (200, r#"{"saved":true,"check":"quiet","problems":["quiet"]}"#.into()),
            _ => (200, "{}".into()),
        })
        });
        let (url, seen) = fake_recorder(respond).await;
        let link = RecorderLink::new(url).unwrap();
        let answer = link
            .hello(&Hello {
                app: "walkietalkey",
                version: "0.3.0".into(),
                os: "mac",
                phones: vec![],
                input: None,
            })
            .await
            .unwrap();
        assert_eq!(answer.style, "whisper");
        let commands = link.next(0, 0).await.unwrap();
        assert_eq!(commands.len(), 3);
        assert!(
            matches!(&commands[0].command, Command::Prompt { next: Some(n), .. } if n.prompt == "s0001")
        );
        assert_eq!(
            commands[1].command,
            Command::MacStart {
                prompt: "s0001".into()
            }
        );
        assert_eq!(commands[2].command, Command::Unknown);
        let meta = TakeMeta {
            prompt: "s0001".into(),
            source: "phone",
            session: Some("c2Vzc2lvbg".into()),
            phone: Some("cGhvbmU".into()),
            microphone: Some("iPhone-mikrofon".into()),
            chunks: Some(2),
            missing: 0,
            duration_ms: 400,
        };
        let answer = link.take(&meta, vec![1, 0, 2, 0]).await.unwrap();
        assert!(answer.saved && answer.check == "quiet");
        link.event(&serde_json::json!({"type": "bye"}))
            .await
            .unwrap();

        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 4);
        let methods: Vec<&str> = seen.iter().map(|r| r.method.as_str()).collect();
        assert_eq!(methods, ["POST", "GET", "POST", "POST"]);
        for r in &seen {
            assert_eq!(
                r.header("authorization"),
                Some(format!("Bearer {TOKEN}").as_str())
            );
            assert_eq!(
                r.header("origin"),
                None,
                "the recorder refuses browsers by their Origin"
            );
        }
        assert_eq!(seen[1].path, "/app/v1/next?after=0&wait=0");
        let take = &seen[2];
        assert_eq!(take.body, vec![1, 0, 2, 0]);
        let meta_json =
            wt_relay_client::wt_protocol::b64u_decode(take.header(TAKE_HEADER).unwrap()).unwrap();
        let v: serde_json::Value = serde_json::from_slice(&meta_json).unwrap();
        assert_eq!(v["prompt"], "s0001");
        assert_eq!(v["microphone"], "iPhone-mikrofon");
        assert_eq!(v["source"], "phone");
    }

    #[tokio::test]
    async fn refusals_and_a_missing_recorder_are_told_apart() {
        let respond: Responder = Arc::new(|r: &Seen| {
            Some(match r.path.as_str() {
                "/app/v1/hello" => (
                    409,
                    r#"{"error":"no_phone","message":"no phone is paired"}"#.into(),
                ),
                _ => (401, r#"{"error":"forbidden"}"#.into()),
            })
        });
        let (url, _) = fake_recorder(respond).await;
        let link = RecorderLink::new(url).unwrap();
        let hello = Hello {
            app: "walkietalkey",
            version: "0".into(),
            os: "mac",
            phones: vec![],
            input: None,
        };
        assert!(matches!(
            link.hello(&hello).await,
            Err(LinkError::Refused { ref error, .. }) if error == "no_phone"
        ));
        assert_eq!(link.next(0, 0).await, Err(LinkError::Unauthorized));

        // Nobody listens on this port any more.
        let gone = {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            l.local_addr().unwrap().port()
        };
        let link = RecorderLink::new(
            parse_session_url(&format!("http://127.0.0.1:{gone}/app/v1#{TOKEN}")).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            link.next(0, 0).await,
            Err(LinkError::Unreachable(_))
        ));
    }

    #[test]
    fn phone_audio_goes_back_to_the_same_bytes() {
        let pcm: Vec<u8> = [0i16, 1, -1, 12345, -32768, 32767]
            .iter()
            .flat_map(|s| s.to_le_bytes())
            .collect();
        let samples: Vec<f32> = pcm
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| f32::from(i16::from_le_bytes(*b)) / 32768.0)
            .collect();
        assert_eq!(pcm16_bytes(&samples), pcm);
        assert_eq!(pcm16_bytes(&[1.5, -1.5]), [0xff, 0x7f, 0x00, 0x80]);
    }
}
