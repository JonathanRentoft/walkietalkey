//! Verifies packages/protocol/test-vectors.json (SEC-05) and that it is reproducible.

use serde_json::Value;
use wt_protocol::consts::*;
use wt_protocol::frame::seal_frame_with_nonce;
use wt_protocol::test_vectors::{describe_payload, generate};
use wt_protocol::*;

fn load() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-vectors.json");
    let text = std::fs::read_to_string(path).expect("test-vectors.json exists (run the generator)");
    serde_json::from_str(&text).unwrap()
}

fn h(v: &Value) -> Vec<u8> {
    hex::decode(v.as_str().expect("hex string")).expect("valid hex")
}

fn arr<const N: usize>(v: &Value) -> [u8; N] {
    h(v).try_into().expect("length")
}

struct Dev {
    signing: SigningKeyPair,
    agreement: AgreementKeyPair,
}

fn dev(v: &Value) -> Dev {
    let signing = SigningKeyPair::from_pkcs8_der(&h(&v["signingPkcs8"])).unwrap();
    let agreement = AgreementKeyPair::from_pkcs8_der(&h(&v["agreementPkcs8"])).unwrap();
    // Scalar and PKCS#8 forms are the same key.
    assert_eq!(
        SigningKeyPair::from_scalar_bytes(&h(&v["signingScalar"]))
            .unwrap()
            .spki(),
        signing.spki()
    );
    assert_eq!(
        AgreementKeyPair::from_scalar_bytes(&h(&v["agreementScalar"]))
            .unwrap()
            .spki(),
        agreement.spki()
    );
    assert_eq!(signing.spki().as_bytes(), h(&v["signingSpki"]).as_slice());
    assert_eq!(
        agreement.spki().as_bytes(),
        h(&v["agreementSpki"]).as_slice()
    );
    assert_eq!(signing.device_id().as_bytes(), h(&v["deviceId"]).as_slice());
    Dev { signing, agreement }
}

#[test]
fn committed_vectors_are_reproducible() {
    assert_eq!(load(), generate(), "test-vectors.json is stale: run `cargo run --example gen_test_vectors --features test-utils`");
}

#[test]
fn keys_and_room_id() {
    let v = load();
    let computer = dev(&v["devices"]["computer"]);
    let _phone = dev(&v["devices"]["phone"]);
    let salt = Salt::from_slice(&h(&v["room"]["salt"])).unwrap();
    let mut pre = LABEL_ROOM.as_bytes().to_vec();
    pre.extend_from_slice(computer.signing.spki().as_bytes());
    pre.extend_from_slice(salt.as_bytes());
    assert_eq!(pre, h(&v["room"]["preimage"]));
    let room = compute_room_id(computer.signing.spki(), &salt);
    assert_eq!(
        room.as_bytes().as_slice(),
        h(&v["room"]["roomId"]).as_slice()
    );
    assert_eq!(
        room.to_b64u(),
        v["room"]["roomIdBase64url"].as_str().unwrap()
    );
}

#[test]
fn signatures() {
    let v = load();
    for s in v["signatures"].as_array().unwrap() {
        let spki = Spki::parse(&h(&s["signerSpki"])).unwrap();
        let label = ChallengeLabel::parse(s["label"].as_str().unwrap()).unwrap();
        let room = RoomId(arr(&s["roomId"]));
        let ch = Challenge(arr(&s["challenge"]));
        assert_eq!(challenge_message(label, &room, &ch), h(&s["message"]));
        let ok = verify_challenge(&spki, label, &room, &ch, &h(&s["signature"]));
        assert_eq!(ok, s["valid"].as_bool().unwrap(), "{}", s["name"]);
    }
}

#[test]
fn pairing_derivations() {
    let v = load();
    let computer = dev(&v["devices"]["computer"]);
    let phone = dev(&v["devices"]["phone"]);
    let p = &v["pairing"];
    let room = RoomId(arr(&v["room"]["roomId"]));
    let s = Secret32(arr(&p["s"]));
    assert_eq!(sha256(&h(&p["a"])).as_slice(), h(&p["aSha256"]).as_slice());
    let computer_id = computer.signing.device_id();
    let phone_id = phone.signing.device_id();
    let ctx = PairContext {
        secret: &s,
        room_id: &room,
        computer_id: &computer_id,
        phone_id: &phone_id,
    };
    for (own, peer) in [
        (&phone.agreement, computer.agreement.spki()),
        (&computer.agreement, phone.agreement.spki()),
    ] {
        let sec = derive_pair_secrets(own, peer, &ctx);
        assert_eq!(sec.shared.as_slice(), h(&p["shared"]).as_slice());
        assert_eq!(sec.base.as_slice(), h(&p["base"]).as_slice());
        assert_eq!(sec.keys.p2c.as_slice(), h(&p["kP2c"]).as_slice());
        assert_eq!(sec.keys.c2p.as_slice(), h(&p["kC2p"]).as_slice());
    }
    let mut info = LABEL_PAIR.as_bytes().to_vec();
    info.extend_from_slice(room.as_bytes());
    info.extend_from_slice(computer_id.as_bytes());
    info.extend_from_slice(phone_id.as_bytes());
    assert_eq!(info, h(&p["pairInfo"]));
    assert_eq!(
        wt_protocol::derive::join_mac_key(&s).as_slice(),
        h(&p["macKey"]).as_slice()
    );
    let mac = compute_join_mac(&s, &room, phone.signing.spki(), phone.agreement.spki());
    assert_eq!(mac.as_bytes().as_slice(), h(&p["joinMac"]).as_slice());
    assert!(verify_join_mac(
        &s,
        &room,
        phone.signing.spki(),
        phone.agreement.spki(),
        mac.as_bytes()
    ));
    let mut input = room.as_bytes().to_vec();
    input.extend_from_slice(phone.signing.spki().as_bytes());
    input.extend_from_slice(phone.agreement.spki().as_bytes());
    assert_eq!(input, h(&p["macInput"]));
}

#[test]
fn pairing_url() {
    let v = load();
    let u = &v["pairingUrl"];
    let decoded = decode_pairing_url(u["url"].as_str().unwrap(), false).unwrap();
    assert_eq!(
        decoded.room_id.as_bytes().as_slice(),
        h(&v["room"]["roomId"]).as_slice()
    );
    assert_eq!(
        decoded.admission.as_bytes().as_slice(),
        h(&v["pairing"]["a"]).as_slice()
    );
    assert_eq!(
        decoded.secret.as_bytes().as_slice(),
        h(&v["pairing"]["s"]).as_slice()
    );
    assert_eq!(
        decoded.computer_agreement.as_bytes(),
        h(&v["devices"]["computer"]["agreementSpki"]).as_slice()
    );
    assert_eq!(decoded.relay_url, u["relayUrl"].as_str().unwrap());
    assert_eq!(decoded.computer_name, u["computerName"].as_str().unwrap());
    assert_eq!(decoded.os, ComputerOs::Mac);
    let again = encode_pairing_url(u["phoneAppUrl"].as_str().unwrap(), &decoded).unwrap();
    assert_eq!(again, u["url"].as_str().unwrap());
    let frag = again.split_once('#').unwrap().1;
    assert_eq!(
        String::from_utf8(b64u_decode(frag).unwrap()).unwrap(),
        u["json"].as_str().unwrap()
    );
}

fn ids(v: &Value) -> (DeviceId, DeviceId) {
    (
        DeviceId(arr(&v["devices"]["computer"]["deviceId"])),
        DeviceId(arr(&v["devices"]["phone"]["deviceId"])),
    )
}

#[test]
fn frames() {
    let v = load();
    let (computer, phone) = ids(&v);
    let p2c: [u8; 32] = arr(&v["pairing"]["kP2c"]);
    let c2p: [u8; 32] = arr(&v["pairing"]["kC2p"]);
    let frames = v["frames"].as_array().unwrap();
    let mut seen_types = std::collections::BTreeSet::new();
    for f in frames {
        let key = if f["key"] == "p2c" { &p2c } else { &c2p };
        let (sender, recipient) = if f["sender"] == "phone" {
            (phone, computer)
        } else {
            (computer, phone)
        };
        let frame_type = f["frameType"].as_u64().unwrap() as u8;
        seen_types.insert(frame_type);
        let counter: u64 = f["counter"].as_str().unwrap().parse().unwrap();
        let plaintext = h(&f["plaintext"]);
        let sealed = seal_frame_with_nonce(
            key,
            &SealHeader {
                frame_type,
                sender,
                recipient,
                counter,
            },
            &plaintext,
            &arr(&f["nonce"]),
        )
        .unwrap();
        assert_eq!(
            hex::encode(&sealed),
            f["frame"].as_str().unwrap(),
            "{}",
            f["name"]
        );
        let (hdr, pt) = open_frame(key, &h(&f["frame"]), &recipient, Some(&sender)).unwrap();
        assert_eq!(hdr.counter, counter);
        assert_eq!(pt, plaintext);
        let decoded = DevicePayload::decode(frame_type, &pt).unwrap();
        assert_eq!(describe_payload(&decoded), f["decoded"], "{}", f["name"]);
        assert_eq!(decoded.encode().unwrap(), plaintext);
    }
    let all: std::collections::BTreeSet<u8> = [0x10, 0x11, 0x12, 0x20, 0x21, 0x22, 0x23, 0x30]
        .into_iter()
        .collect();
    assert_eq!(seen_types, all, "every frame type is covered");
}

#[test]
fn invalid_frames() {
    let v = load();
    let (computer, phone) = ids(&v);
    for f in v["invalidFrames"].as_array().unwrap() {
        let key: [u8; 32] = if f["key"] == "p2c" {
            arr(&v["pairing"]["kP2c"])
        } else {
            arr(&v["pairing"]["kC2p"])
        };
        let err = open_frame(&key, &h(&f["frame"]), &computer, Some(&phone)).unwrap_err();
        assert_eq!(err.code(), f["error"].as_str().unwrap(), "{}", f["name"]);
    }
}

#[test]
fn control_messages() {
    let v = load();
    let list = v["controlMessages"].as_array().unwrap();
    assert!(list.len() >= 18);
    for c in list {
        let json = c["json"].as_str().unwrap();
        let parsed = ControlMessage::parse(json).unwrap();
        assert_eq!(parsed.type_name(), c["t"].as_str().unwrap());
        assert_eq!(parsed.to_json(), json);
    }
}

#[test]
fn counters() {
    let v = load();
    let block = v["counters"]["blockSize"].as_u64().unwrap();
    assert_eq!(block, COUNTER_BLOCK);
    let store = MemoryCounterStore::default();
    let mut c = SendCounter::open(&store, "k").unwrap();
    for step in v["counters"]["steps"].as_array().unwrap() {
        let stored = |s: &Value| s.as_str().unwrap().parse::<u64>().unwrap();
        match step["op"].as_str().unwrap() {
            "open" => assert_eq!(
                store.load_send_reservation("k").unwrap(),
                stored(&step["storedBefore"])
            ),
            "next" => {
                assert_eq!(c.next(&store).unwrap(), stored(&step["expect"]));
                assert_eq!(
                    store.load_send_reservation("k").unwrap(),
                    stored(&step["storedAfter"])
                );
            }
            "nextMany" => {
                let mut last = 0;
                for _ in 0..step["count"].as_u64().unwrap() {
                    last = c.next(&store).unwrap();
                }
                assert_eq!(last, stored(&step["expectLast"]));
                assert_eq!(
                    store.load_send_reservation("k").unwrap(),
                    stored(&step["storedAfter"])
                );
            }
            "restart" => c = SendCounter::open(&store, "k").unwrap(),
            other => panic!("unknown op {other}"),
        }
    }
}
