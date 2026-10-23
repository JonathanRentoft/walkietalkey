//! End-to-end tests: this crate as the computer, the TypeScript scripted phone
//! (`packages/protocol/scripts/scripted-phone.ts`, run with bun) as the phone, and a relay.
//!
//! They need a relay and bun, so they are `#[ignore]`d. Run them with the local relay:
//!
//!     crates/wt-relay-client/scripts/integration.sh
//!
//! or against any relay:
//!
//!     WT_TEST_RELAY_URL=wss://walkietalkey-relay.jonathan0912.workers.dev \
//!       cargo test --test integration -- --ignored pairing_streaming_and_result

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use tokio::time::timeout;
use wt_relay_client::wt_protocol::consts::{close_code, BLOCK_BYTES};
use wt_relay_client::wt_protocol::{
    ComputerOs, DeviceId, ResultOutcome, ResultReason, RoomId, Salt,
};
use wt_relay_client::{
    ClientConfig, JsonFileKeyStore, KeyStore, RejectReason, RelayClient, RelayEvent, StoredRoom,
};

fn relay_url() -> String {
    std::env::var("WT_TEST_RELAY_URL").expect("set WT_TEST_RELAY_URL (see the module docs)")
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "wt-it-{}-{}-{}",
        name,
        std::process::id(),
        rand_u32()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn rand_u32() -> u32 {
    let mut b = [0u8; 4];
    getrandom(&mut b);
    u32::from_le_bytes(b)
}

fn getrandom(buf: &mut [u8]) {
    // Good enough for unique test names; no extra dependency.
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    for (i, b) in buf.iter_mut().enumerate() {
        *b = (t >> (i * 8)) as u8 ^ (i as u8).wrapping_mul(97);
    }
}

// ---------------------------------------------------------------- WAV

/// Deterministic test audio: `blocks` full 200 ms blocks plus a short last block of 20 ms.
fn test_pcm(blocks: usize) -> Vec<u8> {
    let samples = blocks * 3200 + 320;
    let mut out = Vec::with_capacity(samples * 2);
    let mut x: u32 = 12345;
    for i in 0..samples {
        x = x.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        let tone =
            ((i as f64 * 2.0 * std::f64::consts::PI * 440.0 / 16000.0).sin() * 9000.0) as i32;
        let noise = ((x >> 16) as i32 % 2000) - 1000;
        out.extend_from_slice(&((tone + noise) as i16).to_le_bytes());
    }
    out
}

fn wav_bytes(pcm: &[u8]) -> Vec<u8> {
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + pcm.len() as u32).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&16000u32.to_le_bytes());
    w.extend_from_slice(&32000u32.to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

fn write_wav(dir: &Path, name: &str, pcm: &[u8]) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, wav_bytes(pcm)).unwrap();
    path
}

// ---------------------------------------------------------------- scripted phone process

struct Phone {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::UnboundedReceiver<Value>,
    events: Vec<Value>,
    next_id: u64,
}

impl Phone {
    async fn spawn(name: &str) -> Phone {
        let script = repo_root().join("packages/protocol/scripts/scripted-phone.ts");
        let mut child = Command::new("bun")
            .arg(script)
            .arg("--stdio")
            .arg("--insecure-localhost")
            .arg("--name")
            .arg(name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("bun must be installed");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, lines) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut r = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = r.next_line().await {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    let _ = tx.send(v);
                }
            }
        });
        let mut p = Phone {
            child,
            stdin,
            lines,
            events: Vec::new(),
            next_id: 1,
        };
        p.event("ready", 20).await;
        p
    }

    async fn cmd(&mut self, mut v: Value, secs: u64) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        v["id"] = json!(id);
        let line = format!("{}\n", v);
        self.stdin.write_all(line.as_bytes()).await.unwrap();
        self.stdin.flush().await.unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let v = timeout(
                deadline.saturating_duration_since(tokio::time::Instant::now()),
                self.lines.recv(),
            )
            .await
            .unwrap_or_else(|_| panic!("phone did not answer {line}"))
            .expect("phone exited");
            if v.get("reply").is_some() && v["id"] == json!(id) {
                return v;
            }
            self.events.push(v);
        }
    }

    async fn event(&mut self, name: &str, secs: u64) -> Value {
        if let Some(i) = self.events.iter().position(|e| e["event"] == name) {
            return self.events.remove(i);
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let v = timeout(
                deadline.saturating_duration_since(tokio::time::Instant::now()),
                self.lines.recv(),
            )
            .await
            .unwrap_or_else(|_| panic!("phone event {name} did not come"))
            .expect("phone exited");
            if v["event"] == name {
                return v;
            }
            self.events.push(v);
        }
    }

    async fn quit(mut self) {
        let _ = self.cmd(json!({"cmd": "quit"}), 5).await;
        let _ = self.child.wait().await;
    }
}

// ---------------------------------------------------------------- computer (this crate)

struct Computer {
    client: RelayClient,
    events: mpsc::UnboundedReceiver<RelayEvent>,
    backlog: Vec<RelayEvent>,
    store: Arc<JsonFileKeyStore>,
}

fn config() -> ClientConfig {
    let mut c = ClientConfig::new(
        relay_url(),
        "https://walkietalkey-app.pages.dev",
        "Integration Mac",
        ComputerOs::Mac,
    );
    c.allow_insecure_localhost = true;
    c.name_wait = Duration::from_secs(2);
    c
}

impl Computer {
    async fn start(store_path: &Path) -> Computer {
        Self::start_with(store_path, config()).await
    }

    async fn start_with(store_path: &Path, cfg: ClientConfig) -> Computer {
        let store = Arc::new(JsonFileKeyStore::open(store_path).unwrap());
        let (client, events) = RelayClient::start(cfg, store.clone()).unwrap();
        let mut c = Computer {
            client,
            events,
            backlog: Vec::new(),
            store,
        };
        c.until(20, |e| {
            matches!(e, RelayEvent::Connected { .. }).then_some(())
        })
        .await;
        c
    }

    /// Waits for the first event `f` accepts; other events are kept in order.
    async fn until<T>(&mut self, secs: u64, mut f: impl FnMut(&RelayEvent) -> Option<T>) -> T {
        if let Some(i) = self.backlog.iter().position(|e| f(e).is_some()) {
            let e = self.backlog.remove(i);
            return f(&e).unwrap();
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        loop {
            let e = timeout(
                deadline.saturating_duration_since(tokio::time::Instant::now()),
                self.events.recv(),
            )
            .await
            .expect("computer event did not come")
            .expect("client stopped");
            if let Some(v) = f(&e) {
                return v;
            }
            self.backlog.push(e);
        }
    }

    async fn pair(&mut self, phone: &mut Phone, knobs: Value) -> DeviceId {
        let ticket = self.client.start_pairing().await.unwrap();
        let mut cmd = json!({"cmd": "pair", "url": ticket.url});
        if let Value::Object(k) = knobs {
            for (key, v) in k {
                cmd[key] = v;
            }
        }
        let r = phone.cmd(cmd, 30).await;
        assert_eq!(r["ok"], json!(true), "pair failed: {r}");
        let id = DeviceId::from_b64u(r["deviceId"].as_str().unwrap()).unwrap();
        id
    }

    /// Collects one session's audio by block index; also returns the order indices arrived in.
    async fn receive_session(
        &mut self,
        secs: u64,
    ) -> (
        DeviceId,
        wt_relay_client::wt_protocol::SessionId,
        Vec<u8>,
        Vec<u32>,
    ) {
        let (phone, session) = self
            .until(secs, |e| match e {
                RelayEvent::AudioStart { phone, session, .. } => Some((*phone, *session)),
                _ => None,
            })
            .await;
        let mut blocks: BTreeMap<u32, Vec<u8>> = BTreeMap::new();
        let mut order = Vec::new();
        loop {
            let e = self
                .until(secs, |e| match e {
                    RelayEvent::AudioChunk { session: s, .. }
                    | RelayEvent::AudioEnd { session: s, .. }
                        if *s == session =>
                    {
                        Some(e.clone())
                    }
                    _ => None,
                })
                .await;
            match e {
                RelayEvent::AudioChunk { index, pcm, .. } => {
                    assert!(
                        blocks.insert(index, pcm).is_none(),
                        "block {index} delivered twice"
                    );
                    order.push(index);
                }
                RelayEvent::AudioEnd {
                    chunks, missing, ..
                } => {
                    if missing.is_empty() {
                        assert_eq!(blocks.len() as u32, chunks);
                        break;
                    }
                }
                _ => unreachable!(),
            }
        }
        let pcm: Vec<u8> = blocks.into_values().flatten().collect();
        (phone, session, pcm, order)
    }
}

fn assert_same_wav(dir: &Path, sent: &Path, received_pcm: &[u8]) {
    let got = write_wav(dir, "received.wav", received_pcm);
    let a = std::fs::read(sent).unwrap();
    let b = std::fs::read(&got).unwrap();
    assert_eq!(a.len(), b.len(), "WAV sizes differ");
    assert!(a == b, "received WAV differs from the sent WAV");
}

// ---------------------------------------------------------------- tests

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn pairing_streaming_and_result() {
    let dir = temp_dir("main");
    let mut computer = Computer::start(&dir.join("store.json")).await;
    let mut phone = Phone::spawn("Integration phone").await;
    let phone_id = computer.pair(&mut phone, json!({})).await;

    // DESK-62: announced with its name.
    let (paired, name) = computer
        .until(10, |e| match e {
            RelayEvent::PhonePaired { phone, name, .. } => Some((*phone, name.clone())),
            _ => None,
        })
        .await;
    assert_eq!(paired, phone_id);
    assert_eq!(name.as_deref(), Some("Integration phone"));
    assert_eq!(computer.store.load_phones().unwrap().len(), 1);

    // Stream 3 s in real time (5 frames per second).
    let pcm = test_pcm(15);
    let wav = write_wav(&dir, "sent.wav", &pcm);
    let stream = phone
        .cmd(json!({"cmd": "stream", "wav": wav.to_str().unwrap()}), 30)
        .await;
    assert_eq!(stream["ok"], json!(true), "{stream}");
    let (from, session, received, order) = computer.receive_session(15).await;
    assert_eq!(from, phone_id);
    assert_eq!(order, (0..16).collect::<Vec<u32>>());
    assert_same_wav(&dir, &wav, &received);

    // DESK-64: ok, never text.
    computer
        .client
        .send_result(phone_id, session, ResultOutcome::Ok)
        .await
        .unwrap();
    let r = phone
        .cmd(
            json!({"cmd": "wait_result", "sessionId": stream["sessionId"], "timeoutMs": 10000}),
            15,
        )
        .await;
    assert_eq!(r["result"], json!({"ok": true}), "{r}");

    // DESK-63: presence only as an answer.
    let query = tokio::spawn(async move {
        let r = phone
            .cmd(json!({"cmd": "presence", "timeoutMs": 5000}), 10)
            .await;
        (phone, r)
    });
    let q = computer
        .until(10, |e| match e {
            RelayEvent::PresenceQuery { query, .. } => Some(*query),
            _ => None,
        })
        .await;
    computer.client.answer_presence(q, 12, false).await.unwrap();
    assert!(
        computer.client.answer_presence(q, 12, false).await.is_err(),
        "only one answer per query"
    );
    let (mut phone, r) = query.await.unwrap();
    assert_eq!(
        r["presence"],
        json!({"secondsSinceInput": 12, "locked": false}),
        "{r}"
    );

    // Leave nothing behind on the relay: delete_room closes the phone with 4404.
    computer.client.delete_room().await.unwrap();
    computer
        .until(10, |e| matches!(e, RelayEvent::RoomDeleted).then_some(()))
        .await;
    let closed = phone.cmd(json!({"cmd": "wait_closed"}), 15).await;
    assert_eq!(
        closed["code"],
        json!(close_code::ROOM_NOT_FOUND),
        "{closed}"
    );
    assert!(computer.store.load_phones().unwrap().is_empty());
    computer.client.shutdown().await;
    phone.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn a_paired_phone_can_pair_again_and_still_dictate() {
    let dir = temp_dir("repair");
    let mut computer = Computer::start(&dir.join("store.json")).await;
    let mut phone = Phone::spawn("Re-pair phone").await;
    let phone_id = computer.pair(&mut phone, json!({})).await;
    computer
        .until(10, |e| {
            matches!(e, RelayEvent::PhonePaired { .. }).then_some(())
        })
        .await;

    // The same phone (same device keys) scans a new code: new pair keys and
    // counters on both sides, announced again (SEC-01, spec 5.3 step 6).
    assert_eq!(computer.pair(&mut phone, json!({})).await, phone_id);
    computer
        .until(10, |e| {
            matches!(e, RelayEvent::PhonePaired { phone, .. } if *phone == phone_id).then_some(())
        })
        .await;
    assert_eq!(computer.store.load_phones().unwrap().len(), 1);

    let pcm = test_pcm(10);
    let wav = write_wav(&dir, "sent.wav", &pcm);
    let stream = phone
        .cmd(json!({"cmd": "stream", "wav": wav.to_str().unwrap()}), 30)
        .await;
    assert_eq!(stream["ok"], json!(true), "{stream}");
    let (from, session, received, _) = computer.receive_session(15).await;
    assert_eq!(from, phone_id);
    assert_same_wav(&dir, &wav, &received);
    computer
        .client
        .send_result(phone_id, session, ResultOutcome::Ok)
        .await
        .unwrap();
    let r = phone
        .cmd(
            json!({"cmd": "wait_result", "sessionId": stream["sessionId"], "timeoutMs": 10000}),
            15,
        )
        .await;
    assert_eq!(r["result"], json!({"ok": true}), "{r}");
    computer.client.delete_room().await.unwrap();
    computer.client.shutdown().await;
    phone.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn offline_computer_gets_buffered_audio_in_order() {
    let dir = temp_dir("offline");
    let store_path = dir.join("store.json");
    let mut computer = Computer::start(&store_path).await;
    let mut phone = Phone::spawn("Offline phone").await;
    let phone_id = computer.pair(&mut phone, json!({})).await;
    computer
        .until(10, |e| {
            matches!(e, RelayEvent::PhonePaired { .. }).then_some(())
        })
        .await;

    // The computer goes away (sleep, quit); the phone dictates anyway.
    computer.client.shutdown().await;
    drop(computer);
    let pcm = test_pcm(12);
    let wav = write_wav(&dir, "sent.wav", &pcm);
    let stream = phone
        .cmd(
            json!({"cmd": "stream", "wav": wav.to_str().unwrap(), "fps": 20}),
            30,
        )
        .await;
    assert_eq!(stream["ok"], json!(true), "{stream}");
    tokio::time::sleep(Duration::from_millis(500)).await;

    // Back within 10 minutes, from the persisted store: everything, in order.
    let mut computer = Computer::start(&store_path).await;
    let (from, session, received, order) = computer.receive_session(15).await;
    assert_eq!(from, phone_id);
    assert_eq!(
        order,
        (0..13).collect::<Vec<u32>>(),
        "buffered blocks out of order"
    );
    assert_same_wav(&dir, &wav, &received);
    computer
        .client
        .send_result(
            phone_id,
            session,
            ResultOutcome::Failed(ResultReason::Paused),
        )
        .await
        .unwrap();
    let r = phone
        .cmd(
            json!({"cmd": "wait_result", "sessionId": stream["sessionId"], "timeoutMs": 10000}),
            15,
        )
        .await;
    assert_eq!(r["result"], json!({"ok": false, "reason": "paused"}), "{r}");
    computer.client.shutdown().await;
    phone.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn resend_after_the_phone_drops_mid_session_is_deduplicated() {
    let dir = temp_dir("resend");
    let mut computer = Computer::start(&dir.join("store.json")).await;
    let mut phone = Phone::spawn("Flaky phone").await;
    let phone_id = computer.pair(&mut phone, json!({})).await;
    computer
        .until(10, |e| {
            matches!(e, RelayEvent::PhonePaired { .. }).then_some(())
        })
        .await;

    // 20 blocks; the socket drops after block 6, the rest (and audio_end) are lost.
    let pcm = test_pcm(19);
    let wav = write_wav(&dir, "sent.wav", &pcm);
    let stream = phone
        .cmd(
            json!({"cmd": "stream", "wav": wav.to_str().unwrap(), "fps": 10, "dropAfter": 6}),
            30,
        )
        .await;
    assert_eq!(stream["ok"], json!(true), "{stream}");
    // Reconnect: PHONE-32 resends the whole session, 10 blocks per frame.
    let re = phone
        .cmd(json!({"cmd": "reconnect", "resend": true}), 30)
        .await;
    assert_eq!(re["ok"], json!(true), "{re}");
    let (from, session, received, order) = computer.receive_session(20).await;
    assert_eq!(from, phone_id);
    let mut sorted = order.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        (0..20).collect::<Vec<u32>>(),
        "every block exactly once"
    );
    assert_same_wav(&dir, &wav, &received);
    computer
        .client
        .send_result(phone_id, session, ResultOutcome::Ok)
        .await
        .unwrap();
    let r = phone
        .cmd(
            json!({"cmd": "wait_result", "sessionId": stream["sessionId"], "timeoutMs": 10000}),
            15,
        )
        .await;
    assert_eq!(r["result"], json!({"ok": true}), "{r}");
    computer.client.shutdown().await;
    phone.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn revoke_shuts_the_phone_out() {
    let dir = temp_dir("revoke");
    let mut computer = Computer::start(&dir.join("store.json")).await;
    let mut phone = Phone::spawn("Lost phone").await;
    let phone_id = computer.pair(&mut phone, json!({})).await;
    computer
        .until(10, |e| {
            matches!(e, RelayEvent::PhonePaired { .. }).then_some(())
        })
        .await;

    computer.client.revoke_phone(phone_id).await.unwrap();
    computer
        .until(10, |e| {
            matches!(e, RelayEvent::PhoneRemoved { phone } if *phone == phone_id).then_some(())
        })
        .await;
    let closed = phone.cmd(json!({"cmd": "wait_closed"}), 15).await;
    assert_eq!(
        closed["code"],
        json!(close_code::NOT_AUTHORISED),
        "{closed}"
    );
    let again = phone.cmd(json!({"cmd": "connect"}), 15).await;
    assert_eq!(again["ok"], json!(false));
    assert_eq!(again["code"], json!(close_code::NOT_AUTHORISED), "{again}");
    assert!(
        computer.store.load_phones().unwrap().is_empty(),
        "SEC-04: pair keys deleted"
    );
    computer.client.shutdown().await;
    phone.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn leave_tells_the_computer() {
    let dir = temp_dir("leave");
    let mut computer = Computer::start(&dir.join("store.json")).await;
    let mut phone = Phone::spawn("Leaving phone").await;
    let phone_id = computer.pair(&mut phone, json!({})).await;
    computer
        .until(10, |e| {
            matches!(e, RelayEvent::PhonePaired { .. }).then_some(())
        })
        .await;
    let r = phone.cmd(json!({"cmd": "leave"}), 15).await;
    assert_eq!(r["ok"], json!(true), "{r}");
    computer
        .until(10, |e| {
            matches!(e, RelayEvent::PhoneLeft { phone } if *phone == phone_id).then_some(())
        })
        .await;
    assert!(computer.store.load_phones().unwrap().is_empty());
    computer.client.shutdown().await;
    phone.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn a_bad_join_mac_is_refused_and_revoked() {
    let dir = temp_dir("badmac");
    let mut computer = Computer::start(&dir.join("store.json")).await;
    let mut phone = Phone::spawn("Swapped phone").await;
    let ticket = computer.client.start_pairing().await.unwrap();
    let r = phone
        .cmd(
            json!({"cmd": "pair", "url": ticket.url, "corruptMac": true}),
            30,
        )
        .await;
    assert_eq!(r["ok"], json!(true), "the relay itself lets it in: {r}");
    let reason = computer
        .until(10, |e| match e {
            RelayEvent::PhoneRejected { reason, .. } => Some(*reason),
            _ => None,
        })
        .await;
    assert_eq!(reason, RejectReason::BadMac);
    let closed = phone.cmd(json!({"cmd": "wait_closed"}), 15).await;
    assert_eq!(
        closed["code"],
        json!(close_code::NOT_AUTHORISED),
        "{closed}"
    );
    assert!(computer.store.load_phones().unwrap().is_empty());
    computer.client.shutdown().await;
    phone.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn a_phone_without_a_name_is_still_announced() {
    let dir = temp_dir("noname");
    let mut computer = Computer::start(&dir.join("store.json")).await;
    let mut phone = Phone::spawn("unused").await;
    let phone_id = computer
        .pair(&mut phone, json!({"skipDeviceInfo": true}))
        .await;
    let (paired, name) = computer
        .until(10, |e| match e {
            RelayEvent::PhonePaired { phone, name, .. } => Some((*phone, name.clone())),
            _ => None,
        })
        .await;
    assert_eq!(paired, phone_id);
    assert_eq!(name, None, "DESK-62: en telefon uden navn");
    computer.client.shutdown().await;
    phone.quit().await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore]
async fn a_room_the_relay_forgot_is_replaced() {
    let dir = temp_dir("reset");
    let path = dir.join("store.json");
    {
        // A room this computer "created" long ago that the relay no longer has.
        let store = JsonFileKeyStore::open(&path).unwrap();
        store
            .save_room(&StoredRoom {
                relay_url: relay_url(),
                room_id: RoomId([7; 16]),
                salt: Salt([7; 16]),
                created: true,
            })
            .unwrap();
    }
    let store = Arc::new(JsonFileKeyStore::open(&path).unwrap());
    let (client, mut events) = RelayClient::start(config(), store.clone()).unwrap();
    let mut saw_reset = false;
    let mut created = None;
    loop {
        let e = timeout(Duration::from_secs(20), events.recv())
            .await
            .unwrap()
            .unwrap();
        match e {
            RelayEvent::RoomReset { code, .. } => {
                assert!(code == close_code::ROOM_NOT_FOUND || code == close_code::NOT_AUTHORISED);
                saw_reset = true;
            }
            RelayEvent::RoomCreated { room_id } => created = Some(room_id),
            RelayEvent::Connected { room_id, .. } => {
                assert_eq!(Some(room_id), created);
                break;
            }
            _ => {}
        }
    }
    assert!(saw_reset);
    assert_ne!(created, Some(RoomId([7; 16])));
    assert!(store.load_room().unwrap().unwrap().created);
    client.shutdown().await;
    let _ = BLOCK_BYTES;
}
