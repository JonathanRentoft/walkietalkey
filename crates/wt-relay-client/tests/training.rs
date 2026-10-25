//! Training takes through the relay client (PROTOCOL.md 8.4, PRIV-05): a phone's
//! `audio_start_training` becomes its own event, its blocks and end arrive like a dictation's
//! but never as an `AudioStart`, and the computer can send a phone the training prompt and the
//! end of a session. A fake relay on localhost plays the phone.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use wt_relay_client::wt_protocol::{
    AgreementKeyPair, Challenge, ComputerOs, ControlMessage, DeviceId, DevicePayload, MemberInfo,
    MemoryCounterStore, PairChannel, PairKeys, PairRole, Role, RoomId, Salt, SessionId,
    SigningKeyPair, TrainingItem, TrainingStyle,
};
use wt_relay_client::{
    ClientConfig, ClientError, KeyStore, MemoryKeyStore, RelayClient, RelayEvent, StoredPhone,
    StoredRoom,
};
use zeroize::Zeroizing;

const P2C: [u8; 32] = [1; 32];
const C2P: [u8; 32] = [2; 32];

/// The phone's end of the fake relay: frames to send to the computer, and the frames it got.
struct FakePhone {
    to_computer: mpsc::UnboundedSender<Vec<u8>>,
    from_computer: mpsc::UnboundedReceiver<Vec<u8>>,
}

/// A relay with one paired phone: the handshake, then `to_computer` frames go to the client and
/// every binary message from the client is handed back.
async fn fake_relay(phone: DeviceId) -> (String, FakePhone) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let (to_computer, mut outgoing) = mpsc::unbounded_channel::<Vec<u8>>();
    let (incoming, from_computer) = mpsc::unbounded_channel::<Vec<u8>>();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let challenge = ControlMessage::Challenge {
            n: Challenge([1; 32]),
        };
        ws.send(Message::Text(challenge.to_json().into()))
            .await
            .unwrap();
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(_))) => break,
                Some(Ok(_)) => continue,
                other => panic!("no answer to the challenge: {other:?}"),
            }
        }
        let ok = ControlMessage::Ok {
            role: Role::Owner,
            members: vec![MemberInfo {
                id: phone,
                role: Role::Phone,
                online: true,
                last_seen_day: 0,
            }],
        };
        ws.send(Message::Text(ok.to_json().into())).await.unwrap();
        loop {
            tokio::select! {
                frame = outgoing.recv() => match frame {
                    Some(f) => ws.send(Message::Binary(f.into())).await.unwrap(),
                    None => break,
                },
                msg = ws.next() => match msg {
                    Some(Ok(Message::Binary(b))) => { let _ = incoming.send(b.to_vec()); }
                    Some(Ok(m)) if m.is_close() => break,
                    Some(Ok(_)) => {}
                    _ => break,
                },
            }
        }
    });
    (
        url,
        FakePhone {
            to_computer,
            from_computer,
        },
    )
}

struct Setup {
    client: RelayClient,
    events: mpsc::UnboundedReceiver<RelayEvent>,
    phone: FakePhone,
    /// The phone's side of the pair channel.
    channel: PairChannel,
    counters: MemoryCounterStore,
    phone_id: DeviceId,
}

async fn setup() -> Setup {
    let signing = SigningKeyPair::generate().unwrap();
    let phone_id = signing.device_id();
    let store = Arc::new(MemoryKeyStore::new());
    let (url, phone) = fake_relay(phone_id).await;
    store
        .save_room(&StoredRoom {
            relay_url: url.clone(),
            room_id: RoomId([7; 16]),
            salt: Salt([8; 16]),
            created: true,
        })
        .unwrap();
    store
        .save_phone(&StoredPhone {
            id: phone_id,
            signing_spki: signing.spki().clone(),
            agreement_spki: AgreementKeyPair::generate().unwrap().spki().clone(),
            key_p2c: Zeroizing::new(P2C),
            key_c2p: Zeroizing::new(C2P),
            name: Some("iPhone".into()),
            platform: Some("ios".into()),
            paired_at: 1,
        })
        .unwrap();
    let mut cfg = ClientConfig::new(&url, "https://app.example", "Test Mac", ComputerOs::Mac);
    cfg.allow_insecure_localhost = true;
    let (client, mut events) = RelayClient::start(cfg, store).unwrap();
    loop {
        let e = timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("connected")
            .expect("client running");
        if matches!(e, RelayEvent::Connected { .. }) {
            break;
        }
    }
    let counters = MemoryCounterStore::default();
    let channel = PairChannel::new(
        PairRole::Phone,
        phone_id,
        client.device_id(),
        PairKeys {
            p2c: Zeroizing::new(P2C),
            c2p: Zeroizing::new(C2P),
        },
        &counters,
    )
    .unwrap();
    Setup {
        client,
        events,
        phone,
        channel,
        counters,
        phone_id,
    }
}

impl Setup {
    fn send(&mut self, payload: DevicePayload) {
        let frame = self.channel.seal(&self.counters, &payload).unwrap();
        self.phone.to_computer.send(frame).unwrap();
    }

    async fn next_event(&mut self) -> RelayEvent {
        loop {
            let e = timeout(Duration::from_secs(5), self.events.recv())
                .await
                .expect("an event")
                .expect("client running");
            if !matches!(e, RelayEvent::PeerStatus { .. }) {
                return e;
            }
        }
    }

    async fn received(&mut self) -> DevicePayload {
        let frame = timeout(Duration::from_secs(5), self.phone.from_computer.recv())
            .await
            .expect("a frame for the phone")
            .expect("relay running");
        self.channel.open(&self.counters, &frame).unwrap().1
    }
}

fn block(value: i16) -> Vec<u8> {
    std::iter::repeat_n(value.to_le_bytes(), 3200)
        .flatten()
        .collect()
}

#[tokio::test]
async fn a_training_take_is_its_own_event_and_never_a_dictation() {
    let mut s = setup().await;
    let session = SessionId([5; 16]);
    let training = SessionId([6; 16]);
    s.send(DevicePayload::AudioStartTraining {
        session_id: session,
        training,
        prompt: "s0042".into(),
        microphone: Some("iPhone-mikrofon".into()),
    });
    s.send(DevicePayload::AudioChunk {
        session_id: session,
        first_index: 0,
        pcm: block(100),
    });
    s.send(DevicePayload::AudioEnd {
        session_id: session,
        chunks: 1,
        duration_ms: 200,
    });
    let phone = s.phone_id;
    assert_eq!(
        s.next_event().await,
        RelayEvent::TrainingStart {
            phone,
            session,
            training,
            prompt: "s0042".into(),
            microphone: Some("iPhone-mikrofon".into()),
        }
    );
    assert!(matches!(
        s.next_event().await,
        RelayEvent::AudioChunk { index: 0, session: got, .. } if got == session
    ));
    assert!(matches!(
        s.next_event().await,
        RelayEvent::AudioEnd { chunks: 1, ref missing, .. } if missing.is_empty()
    ));

    // A resend after a reconnect (PHONE-32) starts with audio_start_training again: no second
    // start, no duplicate blocks.
    s.send(DevicePayload::AudioStartTraining {
        session_id: session,
        training,
        prompt: "s0042".into(),
        microphone: Some("iPhone-mikrofon".into()),
    });
    s.send(DevicePayload::AudioChunk {
        session_id: session,
        first_index: 0,
        pcm: block(100),
    });
    s.send(DevicePayload::PresenceQuery);
    assert!(
        matches!(s.next_event().await, RelayEvent::PresenceQuery { .. }),
        "the resend added nothing"
    );
    s.client.shutdown().await;
}

#[tokio::test]
async fn the_computer_sends_prompts_and_the_end_to_the_phone() {
    let mut s = setup().await;
    let training = SessionId([9; 16]);
    let prompt = DevicePayload::TrainingPrompt {
        training,
        style: TrainingStyle::Whisper,
        done: 3,
        total: 416,
        next: Some(TrainingItem {
            prompt: "s0042".into(),
            text: "Vi merger PR'en, når buildet er grønt.".into(),
        }),
        last: None,
    };
    s.client
        .send_training(s.phone_id, prompt.clone())
        .await
        .unwrap();
    assert_eq!(s.received().await, prompt);
    let end = DevicePayload::TrainingEnd { training };
    s.client
        .send_training(s.phone_id, end.clone())
        .await
        .unwrap();
    assert_eq!(s.received().await, end);

    // Only training payloads go this way; results and presence have their own calls.
    let not_training = DevicePayload::PresenceQuery;
    assert!(matches!(
        s.client.send_training(s.phone_id, not_training).await,
        Err(ClientError::Protocol(_))
    ));
    let stranger = SigningKeyPair::generate().unwrap().device_id();
    assert_eq!(
        s.client
            .send_training(stranger, DevicePayload::TrainingEnd { training })
            .await,
        Err(ClientError::UnknownPhone)
    );
    s.client.shutdown().await;
}
