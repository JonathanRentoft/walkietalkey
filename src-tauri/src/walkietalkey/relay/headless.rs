//! `--phone-receive`: the desktop side of the end-to-end phone test, without
//! a window. A fresh room on the given relay; the pairing URL is printed as a
//! JSON line; each phone dictation runs through the same live decode and text
//! steps as in the app (side stream, replacements, cleanup) and its
//! transcript is printed with the wait after the phone's `audio_end`; the
//! phone gets its result. Clipboard, notification and history are left out.

use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager};
use wt_relay_client::wt_protocol::{ResultOutcome, ResultReason};
use wt_relay_client::{ClientConfig, JsonFileKeyStore, RelayClient, RelayEvent};

use super::session::{SessionAudio, RESEND_WAIT};
use crate::managers::transcription::{SideStream, TranscriptionManager};

fn print(value: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{value}");
    let _ = out.flush();
}

/// Runs until `count` dictations were transcribed or `timeout` passed.
/// Returns the process exit code.
pub fn run(app: &AppHandle, relay_url: &str, phone_app_url: &str, count: usize, timeout: Duration) -> i32 {
    let Some(tm) = app.try_state::<Arc<TranscriptionManager>>().map(|tm| Arc::clone(&tm)) else {
        eprintln!("error: no transcription manager");
        return 1;
    };
    // A fresh room every run: the keys live in a throwaway folder.
    let dir = std::env::temp_dir().join(format!("walkietalkey-e2e-{}", std::process::id()));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("error: {e}");
        return 1;
    }
    let store = match JsonFileKeyStore::open(dir.join("keys.json")) {
        Ok(store) => Arc::new(store),
        Err(e) => {
            eprintln!("error: key store: {e}");
            return 1;
        }
    };
    let mut config = ClientConfig::new(relay_url, phone_app_url, "WalkieTalkey e2e", super::computer_os());
    config.allow_insecure_localhost = relay_url.starts_with("ws://localhost") || relay_url.starts_with("ws://127.0.0.1");
    let app = app.clone();
    let dir_for_loop = dir.clone();
    tauri::async_runtime::block_on(async move {
        let dir = dir_for_loop;
        let (client, mut events) = match RelayClient::start(config, store) {
            Ok(started) => started,
            Err(e) => {
                eprintln!("error: relay client: {e}");
                return 1;
            }
        };
        let deadline = tokio::time::Instant::now() + timeout;
        let mut done = 0usize;
        let mut pairing_shown = false;
        let mut current: Option<(SessionAudio, Option<SideStream>)> = None;
        loop {
            let event = match tokio::time::timeout_at(deadline, events.recv()).await {
                Ok(Some(event)) => event,
                Ok(None) => return 1,
                Err(_) => {
                    print(json!({"event": "timeout", "transcribed": done}));
                    return 1;
                }
            };
            match event {
                RelayEvent::Connected { .. } if !pairing_shown => {
                    match client.start_pairing().await {
                        Ok(ticket) => {
                            pairing_shown = true;
                            print(json!({"event": "pairing", "url": ticket.url}));
                        }
                        Err(e) => {
                            eprintln!("error: pairing: {e}");
                            return 1;
                        }
                    }
                }
                RelayEvent::PhonePaired { name, .. } => {
                    print(json!({"event": "paired", "name": name}));
                }
                RelayEvent::AudioStart { .. } => {
                    tm.initiate_model_load();
                    current = Some((SessionAudio::new(), Some(tm.start_side_stream())));
                    print(json!({"event": "audio_start"}));
                }
                RelayEvent::AudioChunk { index, pcm, .. } => {
                    if let Some((audio, Some(side))) = current.as_mut() {
                        let ready = audio.add(index, &pcm);
                        if !ready.is_empty() {
                            side.feed(ready);
                        }
                    }
                }
                RelayEvent::AudioEnd {
                    phone,
                    session,
                    chunks,
                    missing,
                    ..
                } => {
                    let ended = Instant::now();
                    let Some((mut audio, side)) = current.take() else {
                        continue;
                    };
                    audio.end(chunks);
                    if !missing.is_empty() {
                        print(json!({"event": "missing", "blocks": missing.len()}));
                        tokio::time::sleep(RESEND_WAIT.min(Duration::from_millis(500))).await;
                    }
                    let rest = audio.give_up_on_gaps();
                    if let (Some(side), false) = (&side, rest.is_empty()) {
                        side.feed(rest);
                    }
                    let samples = audio.audio().to_vec();
                    let seconds = samples.len() as f64 / 16_000.0;
                    let tm2 = Arc::clone(&tm);
                    let text = tauri::async_runtime::spawn_blocking(move || match side {
                        Some(side) => tm2.transcribe_side(side, samples),
                        None => tm2.transcribe(samples),
                    })
                    .await
                    .ok()
                    .and_then(|r| r.ok());
                    let outcome = match &text {
                        Some(text) => {
                            let finished = crate::walkietalkey::dictation::process(&app, text, false).await;
                            print(json!({
                                "event": "transcript",
                                "text": finished.final_text,
                                "audio_secs": seconds,
                                "wait_after_end_ms": ended.elapsed().as_millis() as u64,
                            }));
                            if finished.final_text.trim().is_empty() {
                                ResultOutcome::Failed(ResultReason::NoSpeech)
                            } else {
                                ResultOutcome::Ok
                            }
                        }
                        None => ResultOutcome::Failed(ResultReason::Error),
                    };
                    if let Err(e) = client.send_result(phone, session, outcome).await {
                        eprintln!("error: result: {e}");
                    }
                    done += 1;
                    if done >= count {
                        // Let the result frame leave before closing.
                        tokio::time::sleep(Duration::from_millis(500)).await;
                        let _ = client.delete_room().await;
                        client.shutdown().await;
                        let _ = std::fs::remove_dir_all(&dir);
                        return 0;
                    }
                }
                RelayEvent::RelayError { code, message } => {
                    eprintln!("relay error {code}: {message}");
                }
                _ => {}
            }
        }
    })
}
