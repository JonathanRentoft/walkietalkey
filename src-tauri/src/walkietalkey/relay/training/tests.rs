//! A training session end to end on the app's side: a fake recorder on 127.0.0.1 (the
//! recorder's API, `training/wt_train/recorder/server.py`) and fake effects for the relay and
//! the microphone.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use wt_relay_client::wt_protocol::{
    DeviceId, DevicePayload, ResultOutcome, ResultReason, SessionId, TrainingCheck,
};

use super::link::tests::{fake_recorder, Responder, Seen, TOKEN};
use super::*;

const PHONE: DeviceId = DeviceId([3; 16]);
const TRAINING: SessionId = SessionId([9; 16]);

#[derive(Debug, Clone, PartialEq)]
enum Did {
    Phone(DeviceId, DevicePayload),
    Result(DeviceId, SessionId, ResultOutcome),
    MacStart,
    MacStop,
    MacCancel,
}

#[derive(Default)]
struct Fake {
    did: Arc<Mutex<Vec<Did>>>,
    mac_fails: bool,
}

impl Effects for Fake {
    fn phones(&self) -> BoxFuture<'static, Vec<HelloPhone>> {
        Box::pin(async {
            vec![HelloPhone {
                id: PHONE.to_b64u(),
                name: "Jonathans iPhone".into(),
                platform: Some("ios".into()),
                online: true,
            }]
        })
    }
    fn input(&self) -> Option<String> {
        Some("MacBook Pro-mikrofon".into())
    }
    fn version(&self) -> String {
        "0.3.0".into()
    }
    fn send_phone(&self, phone: DeviceId, payload: DevicePayload) -> BoxFuture<'static, ()> {
        self.did.lock().unwrap().push(Did::Phone(phone, payload));
        Box::pin(async {})
    }
    fn send_result(
        &self,
        phone: DeviceId,
        session: SessionId,
        outcome: ResultOutcome,
    ) -> BoxFuture<'static, ()> {
        self.did
            .lock()
            .unwrap()
            .push(Did::Result(phone, session, outcome));
        Box::pin(async {})
    }
    fn mac_start(&self) -> BoxFuture<'static, Result<(), String>> {
        self.did.lock().unwrap().push(Did::MacStart);
        let fails = self.mac_fails;
        Box::pin(async move {
            if fails {
                Err("Already recording".into())
            } else {
                Ok(())
            }
        })
    }
    fn mac_stop(&self) -> BoxFuture<'static, Option<(Vec<f32>, Option<String>)>> {
        self.did.lock().unwrap().push(Did::MacStop);
        Box::pin(async { Some((vec![0.25; 3200], Some("MacBook Pro-mikrofon".into()))) })
    }
    fn mac_cancel(&self) -> BoxFuture<'static, ()> {
        self.did.lock().unwrap().push(Did::MacCancel);
        Box::pin(async {})
    }
}

/// The recorder's side: a queue of command batches for the long poll, and fixed answers.
struct Recorder {
    commands: Mutex<VecDeque<String>>,
    seq: Mutex<u64>,
    device: &'static str,
    take_answer: Mutex<String>,
}

impl Recorder {
    fn new(device: &'static str) -> Arc<Self> {
        Arc::new(Self {
            commands: Mutex::new(VecDeque::new()),
            seq: Mutex::new(0),
            device,
            take_answer: Mutex::new(r#"{"saved":true,"check":"ok","problems":[]}"#.into()),
        })
    }

    /// Queues one command (JSON without its number).
    fn push(&self, command: &str) {
        let mut seq = self.seq.lock().unwrap();
        *seq += 1;
        let numbered = format!(r#"{{"seq":{},{}"#, *seq, &command[1..]);
        self.commands.lock().unwrap().push_back(numbered);
    }

    fn responder(self: &Arc<Self>) -> Responder {
        let me = Arc::clone(self);
        Arc::new(move |r: &Seen| {
            let path = r.path.as_str();
            if path == "/app/v1/hello" {
                let phone = if me.device == "phone" {
                    format!(r#""{}""#, PHONE.to_b64u())
                } else {
                    "null".into()
                };
                return Some((
                    200,
                    format!(
                        r#"{{"training":"{}","device":"{}","style":"whisper","phone":{phone}}}"#,
                        TRAINING.to_b64u(),
                        me.device
                    ),
                ));
            }
            if path.starts_with("/app/v1/next") {
                let after: u64 = path
                    .split("after=")
                    .nth(1)
                    .and_then(|v| v.split('&').next())
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let queue = me.commands.lock().unwrap();
                let fresh: Vec<&String> = queue
                    .iter()
                    .filter(|c| {
                        let n: u64 = c[7..c.find(',').unwrap()].parse().unwrap();
                        n > after
                    })
                    .collect();
                if fresh.is_empty() {
                    return None;
                }
                let joined = fresh
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(",");
                return Some((200, format!(r#"{{"commands":[{joined}]}}"#)));
            }
            if path == "/app/v1/takes" {
                return Some((200, me.take_answer.lock().unwrap().clone()));
            }
            Some((200, "{}".into()))
        })
    }
}

async fn eventually(what: &str, mut ok: impl FnMut() -> bool) {
    for _ in 0..300 {
        if ok() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

async fn started(
    device: &'static str,
    fake: Fake,
) -> (
    Arc<Trainer<Fake>>,
    Arc<Recorder>,
    Arc<Mutex<Vec<Seen>>>,
    Arc<Mutex<Vec<Did>>>,
) {
    let recorder = Recorder::new(device);
    let (url, seen) = fake_recorder(recorder.responder()).await;
    let did = Arc::clone(&fake.did);
    let trainer = Trainer::new(fake);
    trainer.start(&format!("{}#{TOKEN}", url.base)).unwrap();
    let t = Arc::clone(&trainer);
    eventually("the session", || t.is_active()).await;
    (trainer, recorder, seen, did)
}

fn block(value: i16) -> Vec<u8> {
    std::iter::repeat_n(value.to_le_bytes(), 3200)
        .flatten()
        .collect()
}

fn prompts(did: &Mutex<Vec<Did>>) -> Vec<DevicePayload> {
    did.lock()
        .unwrap()
        .iter()
        .filter_map(|d| match d {
            Did::Phone(_, p @ DevicePayload::TrainingPrompt { .. }) => Some(p.clone()),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn a_phone_take_goes_to_the_recorder_and_its_result_to_the_phone() {
    let (trainer, recorder, seen, did) = started("phone", Fake::default()).await;
    // The hello listed the paired phone.
    let hello = seen.lock().unwrap()[0].clone();
    let v: serde_json::Value = serde_json::from_slice(&hello.body).unwrap();
    assert_eq!(v["phones"][0]["name"], "Jonathans iPhone");
    assert_eq!(v["version"], "0.3.0");

    // The recorder's prompt reaches the phone as a training_prompt.
    recorder.push(r#"{"type":"prompt","next":{"prompt":"s0001","text":"Vi merger PR'en i dag."},"last":null,"done":0,"total":3}"#);
    eventually("the prompt on the phone", || !prompts(&did).is_empty()).await;
    let DevicePayload::TrainingPrompt { training, next, .. } = &prompts(&did)[0] else {
        unreachable!()
    };
    assert_eq!(*training, TRAINING);
    assert_eq!(next.as_ref().unwrap().text, "Vi merger PR'en i dag.");

    // The phone records it: start, two blocks, end.
    let session = SessionId([5; 16]);
    let key = (PHONE, session);
    trainer.on_start(
        PHONE,
        session,
        TRAINING,
        "s0001".into(),
        Some("iPhone-mikrofon".into()),
    );
    assert!(trainer.on_chunk(&key, 0, &block(100)));
    assert!(trainer.on_chunk(&key, 1, &block(200)));
    assert!(trainer.on_end(key, 2));
    let d = Arc::clone(&did);
    eventually("the result", move || {
        d.lock()
            .unwrap()
            .iter()
            .any(|x| matches!(x, Did::Result(_, s, ResultOutcome::Ok) if *s == session))
    })
    .await;
    let take = seen
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.path == "/app/v1/takes")
        .cloned()
        .unwrap();
    assert_eq!(
        take.body,
        [block(100), block(200)].concat(),
        "the audio exactly as it came"
    );
    let meta: serde_json::Value = serde_json::from_slice(
        &wt_relay_client::wt_protocol::b64u_decode(take.header("x-wt-take").unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(meta["prompt"], "s0001");
    assert_eq!(meta["microphone"], "iPhone-mikrofon");
    assert_eq!(meta["missing"], 0);
    // The page heard that the phone was recording.
    assert!(seen
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.path == "/app/v1/events"
            && String::from_utf8_lossy(&r.body).contains("\"recording\"")));

    // The next prompt carries the last take's check.
    recorder.push(r#"{"type":"prompt","next":{"prompt":"s0002","text":"Det regner."},"last":{"prompt":"s0001","text":"Vi merger PR'en i dag.","check":"quiet"},"done":1,"total":3}"#);
    eventually("the second prompt", || prompts(&did).len() >= 2).await;
    assert!(
        matches!(&prompts(&did)[1], DevicePayload::TrainingPrompt { last: Some(l), .. } if l.check == TrainingCheck::Quiet)
    );

    // The phone comes back online: it gets the prompt again.
    trainer.on_phone(PHONE, true);
    eventually("the prompt again", || prompts(&did).len() >= 3).await;

    // The recorder ends the session: the phone leaves the training screen.
    recorder.push(r#"{"type":"end"}"#);
    let t = Arc::clone(&trainer);
    eventually("the end", move || !t.is_active()).await;
    let ends = did
        .lock()
        .unwrap()
        .iter()
        .filter(|d| matches!(d, Did::Phone(PHONE, DevicePayload::TrainingEnd { training }) if *training == TRAINING))
        .count();
    assert_eq!(ends, 1, "one training_end");
}

#[tokio::test]
async fn a_silent_take_is_no_speech_for_the_phone() {
    let (trainer, recorder, _, did) = started("phone", Fake::default()).await;
    *recorder.take_answer.lock().unwrap() =
        r#"{"saved":false,"check":"silent","problems":["silent"]}"#.into();
    let session = SessionId([6; 16]);
    trainer.on_start(PHONE, session, TRAINING, "s0001".into(), None);
    trainer.on_chunk(&(PHONE, session), 0, &block(0));
    trainer.on_end((PHONE, session), 1);
    let d = Arc::clone(&did);
    eventually("no_speech", move || {
        d.lock().unwrap().iter().any(|x| {
            matches!(x, Did::Result(_, s, ResultOutcome::Failed(ResultReason::NoSpeech)) if *s == session)
        })
    })
    .await;
}

#[tokio::test]
async fn a_take_for_no_session_is_never_a_dictation_and_ends_the_phones_training() {
    let trainer = Trainer::new(Fake::default());
    let did = Arc::clone(&trainer.effects.did);
    let session = SessionId([7; 16]);
    let key = (PHONE, session);
    trainer.on_start(PHONE, session, TRAINING, "s0001".into(), None);
    assert!(
        trainer.on_chunk(&key, 0, &block(1)),
        "consumed, not a dictation's"
    );
    assert!(trainer.on_end(key, 1));
    let d = Arc::clone(&did);
    eventually("the end and the error", move || {
        d.lock().unwrap().len() >= 2
    })
    .await;
    let did = did.lock().unwrap().clone();
    assert!(did.contains(&Did::Phone(
        PHONE,
        DevicePayload::TrainingEnd { training: TRAINING }
    )));
    assert!(did.contains(&Did::Result(
        PHONE,
        session,
        ResultOutcome::Failed(ResultReason::Error)
    )));
    // A dictation's events are left alone.
    let other = (PHONE, SessionId([8; 16]));
    assert!(!trainer.on_chunk(&other, 0, &block(1)));
    assert!(!trainer.on_end(other, 1));
    assert!(!trainer.on_cancel(&other));
}

#[tokio::test]
async fn a_cancelled_take_is_dropped() {
    let (trainer, _, seen, did) = started("phone", Fake::default()).await;
    let session = SessionId([10; 16]);
    trainer.on_start(PHONE, session, TRAINING, "s0001".into(), None);
    assert!(trainer.on_cancel(&(PHONE, session)));
    let s = Arc::clone(&seen);
    eventually("the cancel on the page", move || {
        s.lock()
            .unwrap()
            .iter()
            .any(|r| String::from_utf8_lossy(&r.body).contains("cancelled"))
    })
    .await;
    assert!(!did
        .lock()
        .unwrap()
        .iter()
        .any(|d| matches!(d, Did::Result(..))));
    assert!(!seen
        .lock()
        .unwrap()
        .iter()
        .any(|r| r.path == "/app/v1/takes"));
}

#[tokio::test]
async fn a_mac_take_is_started_and_stopped_by_the_recorder() {
    let (_trainer, recorder, seen, did) = started("mac", Fake::default()).await;
    recorder.push(r#"{"type":"prompt","next":{"prompt":"s0001","text":"Hej."},"last":null,"done":0,"total":1}"#);
    recorder.push(r#"{"type":"mac_start","prompt":"s0001"}"#);
    recorder.push(r#"{"type":"mac_stop"}"#);
    let s = Arc::clone(&seen);
    eventually("the Mac take", move || {
        s.lock().unwrap().iter().any(|r| r.path == "/app/v1/takes")
    })
    .await;
    assert_eq!(&did.lock().unwrap()[..2], &[Did::MacStart, Did::MacStop]);
    assert!(
        prompts(&did).is_empty(),
        "a Mac session sends the phone nothing"
    );
    let take = seen
        .lock()
        .unwrap()
        .iter()
        .find(|r| r.path == "/app/v1/takes")
        .cloned()
        .unwrap();
    assert_eq!(take.body.len(), 6400);
    let meta: serde_json::Value = serde_json::from_slice(
        &wt_relay_client::wt_protocol::b64u_decode(take.header("x-wt-take").unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(
        (meta["source"].as_str(), meta["prompt"].as_str()),
        (Some("mac"), Some("s0001"))
    );
    assert_eq!(meta["microphone"], "MacBook Pro-mikrofon");
}

#[tokio::test]
async fn a_busy_microphone_is_reported_to_the_page() {
    let fake = Fake {
        mac_fails: true,
        ..Fake::default()
    };
    let (_trainer, recorder, seen, _did) = started("mac", fake).await;
    recorder.push(r#"{"type":"mac_start","prompt":"s0001"}"#);
    let s = Arc::clone(&seen);
    eventually("mac_failed", move || {
        s.lock()
            .unwrap()
            .iter()
            .any(|r| String::from_utf8_lossy(&r.body).contains("Already recording"))
    })
    .await;
}

#[tokio::test]
async fn the_session_ends_when_the_recorder_is_gone() {
    // The recorder answers the hello, then refuses the token (it stopped and a new one runs).
    let recorder = Recorder::new("phone");
    let hello = recorder.responder();
    let respond: Responder = Arc::new(move |r: &Seen| {
        if r.path.starts_with("/app/v1/next") {
            Some((401, r#"{"error":"forbidden"}"#.into()))
        } else {
            hello(r)
        }
    });
    let (url, _) = fake_recorder(respond).await;
    let fake = Fake::default();
    let did = Arc::clone(&fake.did);
    let trainer = Trainer::new(fake);
    trainer.start(&format!("{}#{TOKEN}", url.base)).unwrap();
    let d = Arc::clone(&did);
    eventually("the phone told", move || {
        d.lock()
            .unwrap()
            .iter()
            .any(|x| matches!(x, Did::Phone(_, DevicePayload::TrainingEnd { .. })))
    })
    .await;
    assert!(!trainer.is_active());
}

#[test]
fn the_handoff_argument_is_found() {
    let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        session_arg(&args(&[
            "walkietalkey",
            "--training-session",
            "http://127.0.0.1:1/app/v1#x"
        ])),
        Some("http://127.0.0.1:1/app/v1#x")
    );
    assert_eq!(
        session_arg(&args(&["walkietalkey", "--training-session=http://a"])),
        Some("http://a")
    );
    assert_eq!(
        session_arg(&args(&["walkietalkey", "--toggle-transcription"])),
        None
    );
    assert_eq!(
        session_arg(&args(&["walkietalkey", "--training-session"])),
        None
    );
}

#[test]
fn a_bad_link_is_refused_before_anything_connects() {
    let trainer = Trainer::new(Fake::default());
    assert!(trainer
        .start("http://example.com:80/app/v1#tokentokentokentoken")
        .is_err());
    assert!(!trainer.is_active());
}
