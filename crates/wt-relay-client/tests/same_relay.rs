//! A room stored under another address of the same relay is kept (DESK-60, RELAY-01,
//! RELAY-03). v1 stored its room with the workers.dev address; run 2 connects to
//! relay.walkietalkey.com. Both are the same Worker, which finds a room by its id alone, so
//! the paired phones stay and the computer authenticates to its room instead of making a new
//! one. A different relay (a company's) still gets a new room.
//!
//! A fake relay on localhost answers the handshake and records how the client entered.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;
use wt_relay_client::wt_protocol::{
    AgreementKeyPair, Challenge, ComputerOs, ControlMessage, MemberInfo, Role, RoomId, Salt,
    SigningKeyPair,
};
use wt_relay_client::{
    ClientConfig, KeyStore, MemoryKeyStore, RelayClient, RelayEvent, StoredPhone, StoredRoom,
};
use zeroize::Zeroizing;

/// v1's relay address, as the owner's state file has it.
const V1_RELAY_URL: &str = "wss://walkietalkey-relay.jonathan0912.workers.dev";

/// How the client entered the fake relay.
struct Entry {
    /// The socket's path and query.
    path: String,
    /// The first message after the challenge: `auth` or `create`.
    hello: &'static str,
}

/// Accepts one connection, sends a challenge, records the answer and confirms it with `ok`
/// listing `members`; then holds the socket open until the client closes it.
// The handshake callback's error type is tungstenite's own.
#[allow(clippy::result_large_err)]
async fn fake_relay(members: Vec<MemberInfo>) -> (String, oneshot::Receiver<Entry>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let (entered, entry) = oneshot::channel();
    tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let path = Arc::new(Mutex::new(String::new()));
        let seen = Arc::clone(&path);
        let mut ws =
            tokio_tungstenite::accept_hdr_async(tcp, move |req: &Request, res: Response| {
                *seen.lock().unwrap() = req.uri().to_string();
                Ok(res)
            })
            .await
            .unwrap();
        let challenge = ControlMessage::Challenge {
            n: Challenge([1; 32]),
        };
        ws.send(Message::Text(challenge.to_json().into()))
            .await
            .unwrap();
        let hello = loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    break ControlMessage::parse(text.as_str()).unwrap().type_name()
                }
                Some(Ok(_)) => continue,
                other => panic!("no answer to the challenge: {other:?}"),
            }
        };
        let ok = ControlMessage::Ok {
            role: Role::Owner,
            members,
        };
        ws.send(Message::Text(ok.to_json().into())).await.unwrap();
        let path = path.lock().unwrap().clone();
        let _ = entered.send(Entry { path, hello });
        while let Some(Ok(msg)) = ws.next().await {
            if msg.is_close() {
                break;
            }
        }
    });
    (url, entry)
}

fn config(url: &str) -> ClientConfig {
    let mut c = ClientConfig::new(url, "https://app.example", "Test Mac", ComputerOs::Mac);
    c.allow_insecure_localhost = true;
    c
}

fn phone() -> StoredPhone {
    let signing = SigningKeyPair::generate().unwrap();
    StoredPhone {
        id: signing.device_id(),
        signing_spki: signing.spki().clone(),
        agreement_spki: AgreementKeyPair::generate().unwrap().spki().clone(),
        key_p2c: Zeroizing::new([1; 32]),
        key_c2p: Zeroizing::new([2; 32]),
        name: Some("iPhone".into()),
        platform: Some("ios".into()),
        paired_at: 1,
    }
}

/// A computer paired with one phone on a room stored with `relay_url`.
fn paired_state(relay_url: &str) -> (Arc<MemoryKeyStore>, StoredRoom, StoredPhone) {
    let store = Arc::new(MemoryKeyStore::new());
    let room = StoredRoom {
        relay_url: relay_url.into(),
        room_id: RoomId([7; 16]),
        salt: Salt([8; 16]),
        created: true,
    };
    store.save_room(&room).unwrap();
    let phone = phone();
    store.save_phone(&phone).unwrap();
    (store, room, phone)
}

/// Events until `Connected`, which returns its room id.
async fn until_connected(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<RelayEvent>,
) -> (RoomId, Vec<RelayEvent>) {
    let mut before = Vec::new();
    loop {
        let event = timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("the client did not connect")
            .expect("the client stopped");
        if let RelayEvent::Connected { room_id, .. } = event {
            return (room_id, before);
        }
        before.push(event);
    }
}

#[tokio::test]
async fn a_room_made_on_v1s_address_is_kept_with_its_phone() {
    // DESK-60, RELAY-03: the owner's iPhone stays paired after the move.
    let (store, room, phone) = paired_state(V1_RELAY_URL);
    let (url, entry) = fake_relay(vec![MemberInfo {
        id: phone.id,
        role: Role::Phone,
        online: true,
        last_seen_day: 0,
    }])
    .await;
    let mut cfg = config(&url);
    cfg.relay_aliases = vec![V1_RELAY_URL.into()];
    assert!(cfg.is_same_relay(V1_RELAY_URL));

    let (client, mut events) = RelayClient::start(cfg, store.clone()).unwrap();
    let (room_id, before) = until_connected(&mut events).await;
    let entry = entry.await.unwrap();

    assert_eq!(entry.hello, "auth", "the existing room, not a new one");
    assert_eq!(
        entry.path,
        format!("/v1/rooms/{}/ws?intent=auth", room.room_id.to_b64u())
    );
    assert_eq!(room_id, room.room_id);
    assert!(
        !before.iter().any(|e| matches!(
            e,
            RelayEvent::RoomCreated { .. } | RelayEvent::PhoneRemoved { .. }
        )),
        "no new room, no phone removed"
    );
    let status = client.status().await.unwrap();
    assert_eq!(status.phones.len(), 1);
    assert_eq!(status.phones[0].id, phone.id);
    assert_eq!(store.load_phones().unwrap().len(), 1, "the pair keys stay");
    let saved = store.load_room().unwrap().unwrap();
    assert_eq!(saved.room_id, room.room_id);
    assert_eq!(saved.salt, room.salt);
    assert!(saved.created);
    assert_eq!(
        saved.relay_url, url,
        "the stored room moves to the new address"
    );
    client.shutdown().await;
}

#[tokio::test]
async fn a_room_on_another_relay_is_replaced_by_a_new_one() {
    // A company relay (managed RelayUrl changed): today's behaviour stays.
    let (store, room, _) = paired_state("wss://relae.firma.dk");
    let (url, entry) = fake_relay(Vec::new()).await;
    let cfg = config(&url);
    assert!(!cfg.is_same_relay("wss://relae.firma.dk"));

    let (client, mut events) = RelayClient::start(cfg, store.clone()).unwrap();
    let (room_id, before) = until_connected(&mut events).await;
    let entry = entry.await.unwrap();

    assert_eq!(entry.hello, "create");
    assert!(entry.path.ends_with("?intent=create"), "{}", entry.path);
    assert_ne!(room_id, room.room_id);
    assert!(before
        .iter()
        .any(|e| matches!(e, RelayEvent::RoomCreated { .. })));
    assert!(store.load_phones().unwrap().is_empty());
    assert_eq!(store.load_room().unwrap().unwrap().relay_url, url);
    client.shutdown().await;
}

#[test]
fn an_alias_matches_with_or_without_a_trailing_slash() {
    let mut cfg = ClientConfig::new(
        "wss://relay.walkietalkey.com/",
        "https://app.walkietalkey.com",
        "Mac",
        ComputerOs::Mac,
    );
    cfg.relay_aliases = vec![format!("{V1_RELAY_URL}/")];
    assert!(cfg.is_same_relay("wss://relay.walkietalkey.com"));
    assert!(cfg.is_same_relay("wss://relay.walkietalkey.com/"));
    assert!(cfg.is_same_relay(V1_RELAY_URL));
    assert!(!cfg.is_same_relay("wss://relae.firma.dk"));
    assert!(
        !ClientConfig::new("wss://relae.firma.dk", "", "Mac", ComputerOs::Mac)
            .is_same_relay(V1_RELAY_URL)
    );
}
