//! Decrypted device frame payloads (Appendix C.2).

use serde::Serialize;
use serde_json::{Map, Value};

use crate::bytes::SessionId;
use crate::consts::{frame_type as ft, *};
use crate::error::{ProtocolError, Result};

/// Why a phone dictation produced no text (DESK-64). Never the text itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ResultReason {
    NoSpeech,
    ModelNotReady,
    TooLong,
    Paused,
    Error,
}

impl ResultReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ResultReason::NoSpeech => "no_speech",
            ResultReason::ModelNotReady => "model_not_ready",
            ResultReason::TooLong => "too_long",
            ResultReason::Paused => "paused",
            ResultReason::Error => "error",
        }
    }

    /// Unknown reasons from a newer peer read as `Error`.
    pub fn parse_lenient(s: &str) -> Self {
        match s {
            "no_speech" => ResultReason::NoSpeech,
            "model_not_ready" => ResultReason::ModelNotReady,
            "too_long" => ResultReason::TooLong,
            "paused" => ResultReason::Paused,
            _ => ResultReason::Error,
        }
    }
}

/// The outcome carried by a `result` frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResultOutcome {
    Ok,
    Failed(ResultReason),
}

/// How a training take is spoken (the session's condition, with the device).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TrainingStyle {
    Normal,
    Whisper,
}

impl TrainingStyle {
    pub fn as_str(self) -> &'static str {
        match self {
            TrainingStyle::Normal => "normal",
            TrainingStyle::Whisper => "whisper",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "normal" => Some(TrainingStyle::Normal),
            "whisper" => Some(TrainingStyle::Whisper),
            _ => None,
        }
    }
}

/// How the computer judged a training take (shown on the phone with a redo).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TrainingCheck {
    Ok,
    Quiet,
    Clipped,
    Short,
    Silent,
    Gaps,
    Error,
}

impl TrainingCheck {
    pub fn as_str(self) -> &'static str {
        match self {
            TrainingCheck::Ok => "ok",
            TrainingCheck::Quiet => "quiet",
            TrainingCheck::Clipped => "clipped",
            TrainingCheck::Short => "short",
            TrainingCheck::Silent => "silent",
            TrainingCheck::Gaps => "gaps",
            TrainingCheck::Error => "error",
        }
    }

    /// Unknown checks from a newer peer read as `Error`.
    pub fn parse_lenient(s: &str) -> Self {
        match s {
            "ok" => TrainingCheck::Ok,
            "quiet" => TrainingCheck::Quiet,
            "clipped" => TrainingCheck::Clipped,
            "short" => TrainingCheck::Short,
            "silent" => TrainingCheck::Silent,
            "gaps" => TrainingCheck::Gaps,
            _ => TrainingCheck::Error,
        }
    }
}

/// A sentence (or paragraph) of a training session: its prompt id and the text to read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TrainingItem {
    pub prompt: String,
    pub text: String,
}

/// The take just made of a prompt, and how the computer judged it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrainingLast {
    pub prompt: String,
    pub text: String,
    pub check: TrainingCheck,
}

/// Which way a payload type travels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    PhoneToComputer,
    ComputerToPhone,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DevicePayload {
    DeviceInfo {
        name: String,
        platform: String,
    },
    Presence {
        seconds_since_input: u32,
        locked: bool,
    },
    PresenceQuery,
    AudioStart {
        session_id: SessionId,
    },
    AudioChunk {
        session_id: SessionId,
        first_index: u32,
        pcm: Vec<u8>,
    },
    AudioEnd {
        session_id: SessionId,
        chunks: u32,
        duration_ms: u32,
    },
    AudioCancel {
        session_id: SessionId,
    },
    /// audio_start for a training take; `training` is the session's id (16 random bytes, like
    /// a session id) and `prompt` the prompt this take reads.
    AudioStartTraining {
        session_id: SessionId,
        training: SessionId,
        prompt: String,
    },
    Result {
        session_id: SessionId,
        outcome: ResultOutcome,
    },
    TrainingPrompt {
        training: SessionId,
        style: TrainingStyle,
        done: u32,
        total: u32,
        /// What to read now; `None` when the session's condition is complete.
        next: Option<TrainingItem>,
        /// The take just made; `None` before the first.
        last: Option<TrainingLast>,
    },
    TrainingEnd {
        training: SessionId,
    },
}

pub fn direction_of(frame_type: u8) -> Option<Direction> {
    match frame_type {
        ft::DEVICE_INFO
        | ft::PRESENCE_QUERY
        | ft::AUDIO_START
        | ft::AUDIO_CHUNK
        | ft::AUDIO_END
        | ft::AUDIO_CANCEL
        | ft::AUDIO_START_TRAINING => Some(Direction::PhoneToComputer),
        ft::PRESENCE | ft::RESULT | ft::TRAINING_PROMPT | ft::TRAINING_END => {
            Some(Direction::ComputerToPhone)
        }
        _ => None,
    }
}

fn bad<T>(msg: impl Into<String>) -> Result<T> {
    Err(ProtocolError::BadPayload(msg.into()))
}

fn check_str(s: &str, max: usize, what: &str) -> Result<()> {
    if s.len() > max {
        return bad(format!("{what} longer than {max} bytes"));
    }
    Ok(())
}

fn check_non_empty(s: &str, max: usize, what: &str) -> Result<()> {
    if s.is_empty() {
        return bad(format!("{what} must not be empty"));
    }
    check_str(s, max, what)
}

fn check_item(prompt: &str, text: &str, what: &str) -> Result<()> {
    check_non_empty(prompt, MAX_PROMPT_ID_BYTES, &format!("{what}.prompt"))?;
    check_non_empty(text, MAX_TRAINING_TEXT_BYTES, &format!("{what}.text"))
}

fn check_pcm(pcm: &[u8]) -> Result<()> {
    if pcm.is_empty() || pcm.len() % 2 != 0 {
        return bad("PCM16 needs a whole, non-zero number of samples");
    }
    if pcm.len() > BLOCK_BYTES * MAX_BLOCKS_PER_FRAME {
        return bad("more than 10 blocks in one frame");
    }
    Ok(())
}

fn to_json<T: Serialize>(v: &T) -> Vec<u8> {
    serde_json::to_vec(v).expect("payload structs serialize")
}

#[derive(Serialize)]
struct DeviceInfoJson<'a> {
    name: &'a str,
    platform: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PresenceJson {
    seconds_since_input: u32,
    locked: bool,
}

#[derive(Serialize)]
struct Empty {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioStartJson {
    session_id: SessionId,
    sample_rate: u32,
    codec: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioEndJson {
    session_id: SessionId,
    chunks: u32,
    duration_ms: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionOnlyJson {
    session_id: SessionId,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioStartTrainingJson<'a> {
    session_id: SessionId,
    sample_rate: u32,
    codec: &'static str,
    training: SessionId,
    prompt: &'a str,
}

#[derive(Serialize)]
struct TrainingLastJson<'a> {
    prompt: &'a str,
    text: &'a str,
    check: &'static str,
}

#[derive(Serialize)]
struct TrainingPromptJson<'a> {
    training: SessionId,
    style: &'static str,
    done: u32,
    total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    next: Option<&'a TrainingItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last: Option<TrainingLastJson<'a>>,
}

#[derive(Serialize)]
struct TrainingOnlyJson {
    training: SessionId,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultJson {
    session_id: SessionId,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<&'static str>,
}

impl DevicePayload {
    pub fn frame_type(&self) -> u8 {
        match self {
            DevicePayload::DeviceInfo { .. } => ft::DEVICE_INFO,
            DevicePayload::Presence { .. } => ft::PRESENCE,
            DevicePayload::PresenceQuery => ft::PRESENCE_QUERY,
            DevicePayload::AudioStart { .. } => ft::AUDIO_START,
            DevicePayload::AudioChunk { .. } => ft::AUDIO_CHUNK,
            DevicePayload::AudioEnd { .. } => ft::AUDIO_END,
            DevicePayload::AudioCancel { .. } => ft::AUDIO_CANCEL,
            DevicePayload::AudioStartTraining { .. } => ft::AUDIO_START_TRAINING,
            DevicePayload::Result { .. } => ft::RESULT,
            DevicePayload::TrainingPrompt { .. } => ft::TRAINING_PROMPT,
            DevicePayload::TrainingEnd { .. } => ft::TRAINING_END,
        }
    }

    pub fn direction(&self) -> Direction {
        direction_of(self.frame_type()).expect("known type")
    }

    /// Plaintext bytes. JSON keys follow the order of Appendix C.2, as in TypeScript.
    pub fn encode(&self) -> Result<Vec<u8>> {
        Ok(match self {
            DevicePayload::DeviceInfo { name, platform } => {
                check_str(name, MAX_DEVICE_NAME_BYTES, "name")?;
                check_str(platform, MAX_PLATFORM_BYTES, "platform")?;
                to_json(&DeviceInfoJson { name, platform })
            }
            DevicePayload::Presence {
                seconds_since_input,
                locked,
            } => to_json(&PresenceJson {
                seconds_since_input: *seconds_since_input,
                locked: *locked,
            }),
            DevicePayload::PresenceQuery => to_json(&Empty {}),
            DevicePayload::AudioStart { session_id } => to_json(&AudioStartJson {
                session_id: *session_id,
                sample_rate: SAMPLE_RATE,
                codec: "pcm16",
            }),
            DevicePayload::AudioChunk {
                session_id,
                first_index,
                pcm,
            } => {
                check_pcm(pcm)?;
                let mut out = Vec::with_capacity(AUDIO_CHUNK_HEADER_LEN + pcm.len());
                out.extend_from_slice(session_id.as_bytes());
                out.extend_from_slice(&first_index.to_be_bytes());
                out.extend_from_slice(pcm);
                out
            }
            DevicePayload::AudioEnd {
                session_id,
                chunks,
                duration_ms,
            } => to_json(&AudioEndJson {
                session_id: *session_id,
                chunks: *chunks,
                duration_ms: *duration_ms,
            }),
            DevicePayload::AudioCancel { session_id } => to_json(&SessionOnlyJson {
                session_id: *session_id,
            }),
            DevicePayload::AudioStartTraining {
                session_id,
                training,
                prompt,
            } => {
                check_non_empty(prompt, MAX_PROMPT_ID_BYTES, "prompt")?;
                to_json(&AudioStartTrainingJson {
                    session_id: *session_id,
                    sample_rate: SAMPLE_RATE,
                    codec: "pcm16",
                    training: *training,
                    prompt,
                })
            }
            DevicePayload::TrainingPrompt {
                training,
                style,
                done,
                total,
                next,
                last,
            } => {
                if let Some(n) = next {
                    check_item(&n.prompt, &n.text, "next")?;
                }
                if let Some(l) = last {
                    check_item(&l.prompt, &l.text, "last")?;
                }
                to_json(&TrainingPromptJson {
                    training: *training,
                    style: style.as_str(),
                    done: *done,
                    total: *total,
                    next: next.as_ref(),
                    last: last.as_ref().map(|l| TrainingLastJson {
                        prompt: &l.prompt,
                        text: &l.text,
                        check: l.check.as_str(),
                    }),
                })
            }
            DevicePayload::TrainingEnd { training } => to_json(&TrainingOnlyJson {
                training: *training,
            }),
            DevicePayload::Result {
                session_id,
                outcome,
            } => match outcome {
                ResultOutcome::Ok => to_json(&ResultJson {
                    session_id: *session_id,
                    ok: true,
                    reason: None,
                }),
                ResultOutcome::Failed(r) => to_json(&ResultJson {
                    session_id: *session_id,
                    ok: false,
                    reason: Some(r.as_str()),
                }),
            },
        })
    }

    /// Parses a decrypted payload. Unknown JSON keys are ignored; unknown result reasons
    /// become `Error`. Never panics.
    pub fn decode(frame_type: u8, bytes: &[u8]) -> Result<Self> {
        if direction_of(frame_type).is_none() {
            return bad(format!("unknown frame type 0x{frame_type:02x}"));
        }
        if frame_type == ft::AUDIO_CHUNK {
            if bytes.len() < AUDIO_CHUNK_HEADER_LEN {
                return bad("audio_chunk too short");
            }
            let pcm = bytes[AUDIO_CHUNK_HEADER_LEN..].to_vec();
            check_pcm(&pcm)?;
            return Ok(DevicePayload::AudioChunk {
                session_id: SessionId::from_slice(&bytes[..SESSION_ID_LEN])?,
                first_index: u32::from_be_bytes(
                    bytes[SESSION_ID_LEN..AUDIO_CHUNK_HEADER_LEN]
                        .try_into()
                        .expect("4"),
                ),
                pcm,
            });
        }
        let text = std::str::from_utf8(bytes)
            .map_err(|_| ProtocolError::BadPayload("not UTF-8".into()))?;
        let value: Value =
            serde_json::from_str(text).map_err(|_| ProtocolError::BadPayload("not JSON".into()))?;
        let Value::Object(o) = value else {
            return bad("not a JSON object");
        };
        Ok(match frame_type {
            ft::DEVICE_INFO => {
                let name = str_field(&o, "name")?;
                let platform = str_field(&o, "platform")?;
                check_str(&name, MAX_DEVICE_NAME_BYTES, "name")?;
                check_str(&platform, MAX_PLATFORM_BYTES, "platform")?;
                DevicePayload::DeviceInfo { name, platform }
            }
            ft::PRESENCE => DevicePayload::Presence {
                seconds_since_input: u32_field(&o, "secondsSinceInput")?,
                locked: bool_field(&o, "locked")?,
            },
            ft::PRESENCE_QUERY => DevicePayload::PresenceQuery,
            ft::AUDIO_START => {
                let session_id = session_field(&o)?;
                let rate_ok = matches!(o.get("sampleRate").and_then(as_uint), Some(r) if r == SAMPLE_RATE as u64);
                let codec_ok = o.get("codec").and_then(Value::as_str) == Some("pcm16");
                if !rate_ok || !codec_ok {
                    return bad("only 16 kHz pcm16 is supported");
                }
                DevicePayload::AudioStart { session_id }
            }
            ft::AUDIO_END => DevicePayload::AudioEnd {
                session_id: session_field(&o)?,
                chunks: u32_field(&o, "chunks")?,
                duration_ms: u32_field(&o, "durationMs")?,
            },
            ft::AUDIO_CANCEL => DevicePayload::AudioCancel {
                session_id: session_field(&o)?,
            },
            ft::AUDIO_START_TRAINING => {
                let session_id = session_field(&o)?;
                let rate_ok = matches!(o.get("sampleRate").and_then(as_uint), Some(r) if r == SAMPLE_RATE as u64);
                let codec_ok = o.get("codec").and_then(Value::as_str) == Some("pcm16");
                if !rate_ok || !codec_ok {
                    return bad("only 16 kHz pcm16 is supported");
                }
                let training = training_field(&o)?;
                let prompt = str_field(&o, "prompt")?;
                check_non_empty(&prompt, MAX_PROMPT_ID_BYTES, "prompt")?;
                DevicePayload::AudioStartTraining {
                    session_id,
                    training,
                    prompt,
                }
            }
            ft::TRAINING_PROMPT => {
                let training = training_field(&o)?;
                let style = o
                    .get("style")
                    .and_then(Value::as_str)
                    .and_then(TrainingStyle::parse)
                    .ok_or_else(|| {
                        ProtocolError::BadPayload("style must be normal or whisper".into())
                    })?;
                let done = u32_field(&o, "done")?;
                let total = u32_field(&o, "total")?;
                let next = match o.get("next") {
                    None => None,
                    Some(v) => Some(item_field(v, "next")?),
                };
                let last = match o.get("last") {
                    None => None,
                    Some(v) => {
                        let item = item_field(v, "last")?;
                        let check = match v.get("check") {
                            Some(Value::String(c)) => TrainingCheck::parse_lenient(c),
                            _ => return bad("last.check must be a string"),
                        };
                        Some(TrainingLast {
                            prompt: item.prompt,
                            text: item.text,
                            check,
                        })
                    }
                };
                DevicePayload::TrainingPrompt {
                    training,
                    style,
                    done,
                    total,
                    next,
                    last,
                }
            }
            ft::TRAINING_END => DevicePayload::TrainingEnd {
                training: training_field(&o)?,
            },
            ft::RESULT => {
                let session_id = session_field(&o)?;
                match o.get("ok") {
                    Some(Value::Bool(true)) => {
                        if o.contains_key("reason") {
                            return bad("a successful result has no reason");
                        }
                        DevicePayload::Result {
                            session_id,
                            outcome: ResultOutcome::Ok,
                        }
                    }
                    Some(Value::Bool(false)) => match o.get("reason") {
                        Some(Value::String(r)) => DevicePayload::Result {
                            session_id,
                            outcome: ResultOutcome::Failed(ResultReason::parse_lenient(r)),
                        },
                        _ => return bad("a failed result needs a reason"),
                    },
                    _ => return bad("ok must be a boolean"),
                }
            }
            _ => return bad("unknown frame type"),
        })
    }
}

/// Integer JSON numbers, including ones written as 12.0 (as JavaScript accepts them).
fn as_uint(v: &Value) -> Option<u64> {
    if let Some(u) = v.as_u64() {
        return Some(u);
    }
    let f = v.as_f64()?;
    if f >= 0.0 && f.fract() == 0.0 && f <= 9_007_199_254_740_991.0 {
        Some(f as u64)
    } else {
        None
    }
}

fn str_field(o: &Map<String, Value>, key: &str) -> Result<String> {
    match o.get(key) {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => bad(format!("{key} must be a string")),
    }
}

fn bool_field(o: &Map<String, Value>, key: &str) -> Result<bool> {
    match o.get(key) {
        Some(Value::Bool(b)) => Ok(*b),
        _ => bad(format!("{key} must be a boolean")),
    }
}

fn u32_field(o: &Map<String, Value>, key: &str) -> Result<u32> {
    o.get(key)
        .and_then(as_uint)
        .and_then(|u| u32::try_from(u).ok())
        .ok_or_else(|| ProtocolError::BadPayload(format!("{key} must be a uint32")))
}

fn training_field(o: &Map<String, Value>) -> Result<SessionId> {
    match o.get("training") {
        Some(Value::String(s)) => SessionId::from_b64u(s)
            .map_err(|_| ProtocolError::BadPayload("training must be 16 bytes".into())),
        _ => bad("training missing"),
    }
}

fn item_field(v: &Value, what: &str) -> Result<TrainingItem> {
    let Value::Object(o) = v else {
        return bad(format!("{what} must be an object"));
    };
    let prompt = str_field(o, "prompt")?;
    let text = str_field(o, "text")?;
    check_item(&prompt, &text, what)?;
    Ok(TrainingItem { prompt, text })
}

fn session_field(o: &Map<String, Value>) -> Result<SessionId> {
    match o.get("sessionId") {
        Some(Value::String(s)) => SessionId::from_b64u(s)
            .map_err(|_| ProtocolError::BadPayload("sessionId must be 16 bytes".into())),
        _ => bad("sessionId missing"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_key_order_matches_typescript() {
        let sid = SessionId([0xab; 16]);
        let s = sid.to_b64u();
        let cases = vec![
            (
                DevicePayload::DeviceInfo {
                    name: "Jonathans iPhone".into(),
                    platform: "ios".into(),
                },
                r#"{"name":"Jonathans iPhone","platform":"ios"}"#.to_string(),
            ),
            (
                DevicePayload::Presence {
                    seconds_since_input: 12,
                    locked: false,
                },
                r#"{"secondsSinceInput":12,"locked":false}"#.into(),
            ),
            (DevicePayload::PresenceQuery, "{}".into()),
            (
                DevicePayload::AudioStart { session_id: sid },
                format!(r#"{{"sessionId":"{s}","sampleRate":16000,"codec":"pcm16"}}"#),
            ),
            (
                DevicePayload::AudioEnd {
                    session_id: sid,
                    chunks: 75,
                    duration_ms: 15000,
                },
                format!(r#"{{"sessionId":"{s}","chunks":75,"durationMs":15000}}"#),
            ),
            (
                DevicePayload::AudioCancel { session_id: sid },
                format!(r#"{{"sessionId":"{s}"}}"#),
            ),
            (
                DevicePayload::Result {
                    session_id: sid,
                    outcome: ResultOutcome::Ok,
                },
                format!(r#"{{"sessionId":"{s}","ok":true}}"#),
            ),
            (
                DevicePayload::Result {
                    session_id: sid,
                    outcome: ResultOutcome::Failed(ResultReason::Paused),
                },
                format!(r#"{{"sessionId":"{s}","ok":false,"reason":"paused"}}"#),
            ),
        ];
        for (p, json) in cases {
            let bytes = p.encode().unwrap();
            assert_eq!(std::str::from_utf8(&bytes).unwrap(), json);
            assert_eq!(DevicePayload::decode(p.frame_type(), &bytes).unwrap(), p);
        }
    }

    #[test]
    fn training_payloads_match_typescript() {
        // PROTOCOL.md 8.4: the same bytes as packages/protocol/test/training.test.ts.
        let sid = SessionId([0xab; 16]);
        let tid = SessionId([0xcd; 16]);
        let (s, t) = (sid.to_b64u(), tid.to_b64u());
        let cases = vec![
            (
                DevicePayload::AudioStartTraining {
                    session_id: sid,
                    training: tid,
                    prompt: "s0042".into(),
                },
                format!(
                    r#"{{"sessionId":"{s}","sampleRate":16000,"codec":"pcm16","training":"{t}","prompt":"s0042"}}"#
                ),
            ),
            (
                DevicePayload::TrainingPrompt {
                    training: tid,
                    style: TrainingStyle::Whisper,
                    done: 12,
                    total: 416,
                    next: Some(TrainingItem {
                        prompt: "s0043".into(),
                        text: "Vi merger PR'en, når buildet er grønt.".into(),
                    }),
                    last: Some(TrainingLast {
                        prompt: "s0042".into(),
                        text: "Kan du deploye til staging?".into(),
                        check: TrainingCheck::Quiet,
                    }),
                },
                format!(
                    r#"{{"training":"{t}","style":"whisper","done":12,"total":416,"next":{{"prompt":"s0043","text":"Vi merger PR'en, når buildet er grønt."}},"last":{{"prompt":"s0042","text":"Kan du deploye til staging?","check":"quiet"}}}}"#
                ),
            ),
            (
                DevicePayload::TrainingPrompt {
                    training: tid,
                    style: TrainingStyle::Normal,
                    done: 0,
                    total: 3,
                    next: None,
                    last: None,
                },
                format!(r#"{{"training":"{t}","style":"normal","done":0,"total":3}}"#),
            ),
            (
                DevicePayload::TrainingEnd { training: tid },
                format!(r#"{{"training":"{t}"}}"#),
            ),
        ];
        for (p, json) in cases {
            let bytes = p.encode().unwrap();
            assert_eq!(std::str::from_utf8(&bytes).unwrap(), json);
            assert_eq!(DevicePayload::decode(p.frame_type(), &bytes).unwrap(), p);
        }
        assert_eq!(direction_of(0x24), Some(Direction::PhoneToComputer));
        assert_eq!(direction_of(0x31), Some(Direction::ComputerToPhone));
        assert_eq!(direction_of(0x32), Some(Direction::ComputerToPhone));
    }

    #[test]
    fn training_payloads_refuse_what_does_not_fit() {
        let s = SessionId([3; 16]).to_b64u();
        let t = SessionId([4; 16]).to_b64u();
        // Unknown checks from a newer computer read as error; unknown keys are ignored.
        let p = DevicePayload::decode(
            0x31,
            format!(r#"{{"total":5,"x":1,"done":5,"style":"normal","training":"{t}","last":{{"check":"later","text":"Hej","prompt":"e01"}}}}"#).as_bytes(),
        )
        .unwrap();
        assert!(matches!(
            p,
            DevicePayload::TrainingPrompt {
                last: Some(TrainingLast {
                    check: TrainingCheck::Error,
                    ..
                }),
                next: None,
                ..
            }
        ));
        let long_id = "x".repeat(MAX_PROMPT_ID_BYTES + 1);
        let long_text = "ø".repeat(MAX_TRAINING_TEXT_BYTES / 2 + 1);
        let bad = [
            (
                0x24,
                format!(
                    r#"{{"sessionId":"{s}","sampleRate":16000,"codec":"pcm16","prompt":"s1"}}"#
                ),
            ),
            (
                0x24,
                format!(
                    r#"{{"sessionId":"{s}","sampleRate":16000,"codec":"pcm16","training":"{t}","prompt":""}}"#
                ),
            ),
            (
                0x24,
                format!(
                    r#"{{"sessionId":"{s}","sampleRate":8000,"codec":"pcm16","training":"{t}","prompt":"s1"}}"#
                ),
            ),
            (
                0x24,
                format!(
                    r#"{{"sessionId":"{s}","sampleRate":16000,"codec":"pcm16","training":"{t}","prompt":"{long_id}"}}"#
                ),
            ),
            (
                0x31,
                format!(r#"{{"training":"{t}","style":"loud","done":0,"total":1}}"#),
            ),
            (
                0x31,
                format!(r#"{{"training":"{t}","style":"normal","done":0}}"#),
            ),
            (
                0x31,
                format!(r#"{{"training":"{t}","style":"normal","done":0,"total":1,"next":"s1"}}"#),
            ),
            (
                0x31,
                format!(
                    r#"{{"training":"{t}","style":"normal","done":0,"total":1,"next":{{"prompt":"s1"}}}}"#
                ),
            ),
            (
                0x31,
                format!(
                    r#"{{"training":"{t}","style":"normal","done":0,"total":1,"next":{{"prompt":"s1","text":""}}}}"#
                ),
            ),
            (
                0x31,
                format!(
                    r#"{{"training":"{t}","style":"normal","done":0,"total":1,"last":{{"prompt":"s1","text":"Hej"}}}}"#
                ),
            ),
            (
                0x31,
                format!(
                    r#"{{"training":"{t}","style":"normal","done":0,"total":1,"next":{{"prompt":"s1","text":"{long_text}"}}}}"#
                ),
            ),
            (0x32, "{}".to_string()),
        ];
        for (ty, json) in bad {
            assert!(
                DevicePayload::decode(ty, json.as_bytes()).is_err(),
                "{json}"
            );
        }
        let empty_prompt = DevicePayload::AudioStartTraining {
            session_id: SessionId([3; 16]),
            training: SessionId([4; 16]),
            prompt: String::new(),
        };
        assert!(empty_prompt.encode().is_err());
    }

    #[test]
    fn audio_chunk_layout() {
        let sid = SessionId([1; 16]);
        let p = DevicePayload::AudioChunk {
            session_id: sid,
            first_index: 0x01020304,
            pcm: vec![5; 6400],
        };
        let b = p.encode().unwrap();
        assert_eq!(b.len(), 6420);
        assert_eq!(&b[16..20], &[1, 2, 3, 4]);
        assert_eq!(DevicePayload::decode(0x21, &b).unwrap(), p);
        for len in [0usize, 1, 641, 64002] {
            let mut raw = vec![0u8; 20 + len];
            raw[..16].copy_from_slice(&[1; 16]);
            assert!(DevicePayload::decode(0x21, &raw).is_err(), "{len}");
        }
    }

    #[test]
    fn lenient_and_strict_parts() {
        let s = SessionId([2; 16]).to_b64u();
        let r = DevicePayload::decode(
            0x30,
            format!(r#"{{"sessionId":"{s}","ok":false,"reason":"later"}}"#).as_bytes(),
        )
        .unwrap();
        assert_eq!(
            r,
            DevicePayload::Result {
                session_id: SessionId([2; 16]),
                outcome: ResultOutcome::Failed(ResultReason::Error)
            }
        );
        assert!(DevicePayload::decode(
            0x30,
            format!(r#"{{"sessionId":"{s}","ok":false}}"#).as_bytes()
        )
        .is_err());
        assert!(DevicePayload::decode(
            0x22,
            format!(r#"{{"sessionId":"{s}","chunks":4294967296,"durationMs":1}}"#).as_bytes()
        )
        .is_err());
        assert!(DevicePayload::decode(
            0x22,
            format!(r#"{{"durationMs":1.0,"x":1,"chunks":1,"sessionId":"{s}"}}"#).as_bytes()
        )
        .is_ok());
        assert!(DevicePayload::decode(0x12, b"[]").is_err());
        assert!(DevicePayload::decode(0x99, b"{}").is_err());
        assert!(DevicePayload::decode(0x12, &[0x7b, 0xff, 0x7d]).is_err());
    }
}
