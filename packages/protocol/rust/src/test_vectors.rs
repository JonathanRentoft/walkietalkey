//! TEST ONLY: deterministic generator for `packages/protocol/test-vectors.json` (SEC-05).
//!
//! Every input is fixed: private keys are SHA-256 of a label used as the P-256 scalar,
//! secrets and nonces are SHA-256 of labels, ECDSA signatures are RFC 6979 deterministic.
//! Regenerate with `cargo run --example gen_test_vectors --features test-utils`.

use p256::ecdsa::Signature;
use serde_json::{json, Value};

use crate::bytes::{Challenge, Salt, Secret32, SessionId};
use crate::consts::*;
use crate::control::{AckOp, ControlMessage, MemberInfo, Role};
use crate::derive::{
    compute_join_mac, compute_room_id, derive_pair_secrets, join_mac_key, PairContext,
};
use crate::frame::{seal_frame_with_nonce, SealHeader};
use crate::keys::{challenge_message, AgreementKeyPair, ChallengeLabel, SigningKeyPair};
use crate::pairing::{encode_pairing_url, ComputerOs, PairingPayload};
use crate::payload::{DevicePayload, ResultOutcome, ResultReason};
use crate::sha256;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn fixed(label: &str) -> [u8; 32] {
    sha256(format!("wt-test-vectors/{label}").as_bytes())
}

fn nonce(i: usize) -> [u8; 12] {
    fixed(&format!("nonce/{i}"))[..12].try_into().unwrap()
}

/// Deterministic PCM16 little-endian test signal.
pub fn test_pcm(samples: usize, offset: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(samples * 2);
    for n in 0..samples {
        let v = (((n + offset) as i64 * 1103) % 32768 - 16384) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub struct FixedDevice {
    pub signing: SigningKeyPair,
    pub agreement: AgreementKeyPair,
}

pub fn fixed_device(name: &str) -> FixedDevice {
    FixedDevice {
        signing: SigningKeyPair::from_scalar_bytes(&fixed(&format!("{name}/signing")))
            .expect("valid scalar"),
        agreement: AgreementKeyPair::from_scalar_bytes(&fixed(&format!("{name}/agreement")))
            .expect("valid scalar"),
    }
}

fn device_json(d: &FixedDevice) -> Value {
    json!({
        "signingScalar": hex(d.signing.to_scalar_bytes().as_ref()),
        "signingPkcs8": hex(&d.signing.to_pkcs8_der().unwrap()),
        "signingSpki": hex(d.signing.spki().as_bytes()),
        "deviceId": hex(d.signing.device_id().as_bytes()),
        "agreementScalar": hex(d.agreement.to_scalar_bytes().as_ref()),
        "agreementPkcs8": hex(&d.agreement.to_pkcs8_der().unwrap()),
        "agreementSpki": hex(d.agreement.spki().as_bytes()),
    })
}

/// Canonical description of a payload: camelCase fields, binary values as hex.
pub fn describe_payload(p: &DevicePayload) -> Value {
    match p {
        DevicePayload::DeviceInfo { name, platform } => {
            json!({"type": "device_info", "name": name, "platform": platform})
        }
        DevicePayload::Presence {
            seconds_since_input,
            locked,
        } => {
            json!({"type": "presence", "secondsSinceInput": seconds_since_input, "locked": locked})
        }
        DevicePayload::PresenceQuery => json!({"type": "presence_query"}),
        DevicePayload::AudioStart { session_id } => {
            json!({"type": "audio_start", "sessionId": hex(session_id.as_bytes()), "sampleRate": 16000, "codec": "pcm16"})
        }
        DevicePayload::AudioChunk {
            session_id,
            first_index,
            pcm,
        } => json!({
            "type": "audio_chunk", "sessionId": hex(session_id.as_bytes()), "firstIndex": first_index, "pcm": hex(pcm)
        }),
        DevicePayload::AudioEnd {
            session_id,
            chunks,
            duration_ms,
        } => json!({
            "type": "audio_end", "sessionId": hex(session_id.as_bytes()), "chunks": chunks, "durationMs": duration_ms
        }),
        DevicePayload::AudioCancel { session_id } => {
            json!({"type": "audio_cancel", "sessionId": hex(session_id.as_bytes())})
        }
        DevicePayload::Result {
            session_id,
            outcome,
        } => match outcome {
            ResultOutcome::Ok => {
                json!({"type": "result", "sessionId": hex(session_id.as_bytes()), "ok": true})
            }
            ResultOutcome::Failed(r) => {
                json!({"type": "result", "sessionId": hex(session_id.as_bytes()), "ok": false, "reason": r.as_str()})
            }
        },
    }
}

fn negate_s(sig: &[u8]) -> Vec<u8> {
    let s = Signature::from_slice(sig).unwrap();
    let (r, s_val) = s.split_scalars();
    let neg = Signature::from_scalars(r, -*s_val).unwrap();
    neg.to_bytes().to_vec()
}

pub fn generate() -> Value {
    let computer = fixed_device("computer");
    let phone = fixed_device("phone");
    let computer_id = computer.signing.device_id();
    let phone_id = phone.signing.device_id();

    let salt = Salt::from_slice(&fixed("salt")[..16]).unwrap();
    let room_id = compute_room_id(computer.signing.spki(), &salt);
    let mut room_preimage = LABEL_ROOM.as_bytes().to_vec();
    room_preimage.extend_from_slice(computer.signing.spki().as_bytes());
    room_preimage.extend_from_slice(salt.as_bytes());

    // Signatures.
    let challenge = Challenge(fixed("challenge"));
    let mut signatures = Vec::new();
    let mut sig_entry = |name: &str,
                         signer: &FixedDevice,
                         signer_name: &str,
                         label: ChallengeLabel,
                         checked_as: ChallengeLabel,
                         sig: Vec<u8>,
                         valid: bool| {
        signatures.push(json!({
            "name": name,
            "signer": signer_name,
            "signerSpki": hex(signer.signing.spki().as_bytes()),
            "label": checked_as.as_str(),
            "roomId": hex(room_id.as_bytes()),
            "challenge": hex(challenge.as_bytes()),
            "message": hex(&challenge_message(checked_as, &room_id, &challenge)),
            "signature": hex(&sig),
            "valid": valid,
            "signedLabel": label.as_str(),
        }));
    };
    let auth = computer
        .signing
        .sign_challenge(ChallengeLabel::Auth, &room_id, &challenge)
        .0
        .to_vec();
    let create = computer
        .signing
        .sign_challenge(ChallengeLabel::Create, &room_id, &challenge)
        .0
        .to_vec();
    let join = phone
        .signing
        .sign_challenge(ChallengeLabel::Join, &room_id, &challenge)
        .0
        .to_vec();
    let phone_auth = phone
        .signing
        .sign_challenge(ChallengeLabel::Auth, &room_id, &challenge)
        .0
        .to_vec();
    let mut tampered = auth.clone();
    tampered[10] ^= 0x01;
    sig_entry(
        "owner auth",
        &computer,
        "computer",
        ChallengeLabel::Auth,
        ChallengeLabel::Auth,
        auth.clone(),
        true,
    );
    sig_entry(
        "owner create",
        &computer,
        "computer",
        ChallengeLabel::Create,
        ChallengeLabel::Create,
        create,
        true,
    );
    sig_entry(
        "phone join",
        &phone,
        "phone",
        ChallengeLabel::Join,
        ChallengeLabel::Join,
        join,
        true,
    );
    sig_entry(
        "phone auth",
        &phone,
        "phone",
        ChallengeLabel::Auth,
        ChallengeLabel::Auth,
        phone_auth.clone(),
        true,
    );
    sig_entry(
        "phone auth with s negated (the other of low-S/high-S)",
        &phone,
        "phone",
        ChallengeLabel::Auth,
        ChallengeLabel::Auth,
        negate_s(&phone_auth),
        true,
    );
    sig_entry(
        "auth signature checked as create",
        &computer,
        "computer",
        ChallengeLabel::Auth,
        ChallengeLabel::Create,
        auth.clone(),
        false,
    );
    sig_entry(
        "auth signature checked as join",
        &computer,
        "computer",
        ChallengeLabel::Auth,
        ChallengeLabel::Join,
        auth,
        false,
    );
    sig_entry(
        "tampered signature",
        &computer,
        "computer",
        ChallengeLabel::Auth,
        ChallengeLabel::Auth,
        tampered,
        false,
    );

    // Pairing derivations.
    let a = Secret32(fixed("a"));
    let s = Secret32(fixed("s"));
    let ctx = PairContext {
        secret: &s,
        room_id: &room_id,
        computer_id: &computer_id,
        phone_id: &phone_id,
    };
    let on_phone = derive_pair_secrets(&phone.agreement, computer.agreement.spki(), &ctx);
    let on_computer = derive_pair_secrets(&computer.agreement, phone.agreement.spki(), &ctx);
    assert!(on_phone.keys == on_computer.keys);
    let mut pair_info = LABEL_PAIR.as_bytes().to_vec();
    pair_info.extend_from_slice(room_id.as_bytes());
    pair_info.extend_from_slice(computer_id.as_bytes());
    pair_info.extend_from_slice(phone_id.as_bytes());
    let mut mac_input = room_id.as_bytes().to_vec();
    mac_input.extend_from_slice(phone.signing.spki().as_bytes());
    mac_input.extend_from_slice(phone.agreement.spki().as_bytes());
    let join_mac = compute_join_mac(&s, &room_id, phone.signing.spki(), phone.agreement.spki());
    let keys = on_phone.keys.clone();

    // Pairing URL.
    let payload = PairingPayload {
        room_id,
        admission: a.clone(),
        secret: s.clone(),
        computer_agreement: computer.agreement.spki().clone(),
        relay_url: "wss://relay.walkietalkey.com".into(),
        computer_name: "Jonathans MacBook Pro".into(),
        os: ComputerOs::Mac,
    };
    let url = encode_pairing_url("https://app.walkietalkey.com", &payload).unwrap();
    let fragment = url.split_once('#').unwrap().1;
    let pairing_json = String::from_utf8(crate::b64u_decode(fragment).unwrap()).unwrap();

    // Frames.
    let session = SessionId::from_slice(&fixed("session")[..16]).unwrap();
    let full0 = test_pcm(BLOCK_SAMPLES, 0);
    let mut multi = test_pcm(BLOCK_SAMPLES * 2, BLOCK_SAMPLES);
    multi.extend_from_slice(&test_pcm(320, BLOCK_SAMPLES * 3));
    let p2c: Vec<(&str, u64, DevicePayload)> = vec![
        (
            "device_info",
            1,
            DevicePayload::DeviceInfo {
                name: "Jonathans iPhone".into(),
                platform: "ios".into(),
            },
        ),
        ("presence_query", 2, DevicePayload::PresenceQuery),
        (
            "audio_start",
            3,
            DevicePayload::AudioStart {
                session_id: session,
            },
        ),
        (
            "audio_chunk one full block",
            4,
            DevicePayload::AudioChunk {
                session_id: session,
                first_index: 0,
                pcm: full0,
            },
        ),
        (
            "audio_chunk two full blocks and the short last block",
            5,
            DevicePayload::AudioChunk {
                session_id: session,
                first_index: 1,
                pcm: multi,
            },
        ),
        (
            "audio_end",
            6,
            DevicePayload::AudioEnd {
                session_id: session,
                chunks: 4,
                duration_ms: 620,
            },
        ),
        (
            "audio_cancel",
            7,
            DevicePayload::AudioCancel {
                session_id: session,
            },
        ),
        (
            "presence_query with a large counter",
            (1u64 << 40) + 5,
            DevicePayload::PresenceQuery,
        ),
    ];
    let c2p: Vec<(&str, u64, DevicePayload)> = vec![
        (
            "presence",
            1,
            DevicePayload::Presence {
                seconds_since_input: 42,
                locked: false,
            },
        ),
        (
            "result ok",
            2,
            DevicePayload::Result {
                session_id: session,
                outcome: ResultOutcome::Ok,
            },
        ),
        (
            "result no_speech",
            3,
            DevicePayload::Result {
                session_id: session,
                outcome: ResultOutcome::Failed(ResultReason::NoSpeech),
            },
        ),
        (
            "result model_not_ready",
            4,
            DevicePayload::Result {
                session_id: session,
                outcome: ResultOutcome::Failed(ResultReason::ModelNotReady),
            },
        ),
        (
            "result too_long",
            5,
            DevicePayload::Result {
                session_id: session,
                outcome: ResultOutcome::Failed(ResultReason::TooLong),
            },
        ),
        (
            "result paused",
            6,
            DevicePayload::Result {
                session_id: session,
                outcome: ResultOutcome::Failed(ResultReason::Paused),
            },
        ),
        (
            "result error",
            7,
            DevicePayload::Result {
                session_id: session,
                outcome: ResultOutcome::Failed(ResultReason::Error),
            },
        ),
    ];
    let mut frames = Vec::new();
    let mut i = 0usize;
    let mut audio_start_frame = Vec::new();
    for (dir, list) in [("p2c", &p2c), ("c2p", &c2p)] {
        for (name, counter, p) in list.iter() {
            let (sender, recipient, key, sname, rname) = if dir == "p2c" {
                (phone_id, computer_id, &keys.p2c, "phone", "computer")
            } else {
                (computer_id, phone_id, &keys.c2p, "computer", "phone")
            };
            let plaintext = p.encode().unwrap();
            let n = nonce(i);
            i += 1;
            let frame = seal_frame_with_nonce(
                key,
                &SealHeader {
                    frame_type: p.frame_type(),
                    sender,
                    recipient,
                    counter: *counter,
                },
                &plaintext,
                &n,
            )
            .unwrap();
            if *name == "audio_start" {
                audio_start_frame = frame.clone();
            }
            frames.push(json!({
                "name": name,
                "key": dir,
                "sender": sname,
                "recipient": rname,
                "frameType": p.frame_type(),
                "counter": counter.to_string(),
                "nonce": hex(&n),
                "decoded": describe_payload(p),
                "plaintext": hex(&plaintext),
                "frame": hex(&frame),
            }));
        }
    }

    // Invalid frames, derived from the audio_start frame (phone -> computer).
    let mut invalid = Vec::new();
    let mut push_invalid = |name: &str, frame: Vec<u8>, key: &str, error: &str| {
        invalid.push(json!({
            "name": name, "frame": hex(&frame), "key": key, "recipient": "computer", "sender": "phone", "error": error
        }));
    };
    let flip = |pos: usize| {
        let mut f = audio_start_frame.clone();
        f[pos] ^= 0x01;
        f
    };
    push_invalid("type bit flipped", flip(1), "p2c", "decrypt_failed");
    push_invalid("counter bit flipped", flip(41), "p2c", "decrypt_failed");
    push_invalid("nonce bit flipped", flip(45), "p2c", "decrypt_failed");
    push_invalid("ciphertext bit flipped", flip(60), "p2c", "decrypt_failed");
    push_invalid(
        "tag bit flipped",
        flip(audio_start_frame.len() - 1),
        "p2c",
        "decrypt_failed",
    );
    push_invalid("recipient changed", flip(20), "p2c", "wrong_recipient");
    push_invalid("sender changed", flip(5), "p2c", "wrong_sender");
    let mut v2 = audio_start_frame.clone();
    v2[0] = 2;
    push_invalid("version 2", v2, "p2c", "bad_version");
    push_invalid(
        "truncated below 70 bytes",
        audio_start_frame[..69].to_vec(),
        "p2c",
        "bad_frame",
    );
    push_invalid(
        "opened with the other direction's key",
        audio_start_frame.clone(),
        "c2p",
        "decrypt_failed",
    );

    // Control messages, as Rust serializes them; TypeScript must serialize them identically.
    let h = Secret32(sha256(a.as_bytes()));
    let digest = crate::Digest32(*h.as_bytes());
    let controls = vec![
        ControlMessage::Challenge { n: challenge },
        ControlMessage::Auth {
            id: computer_id,
            sig: computer
                .signing
                .sign_challenge(ChallengeLabel::Auth, &room_id, &challenge),
        },
        ControlMessage::Create {
            pub_key: computer.signing.spki().clone(),
            salt,
            sig: computer
                .signing
                .sign_challenge(ChallengeLabel::Create, &room_id, &challenge),
        },
        ControlMessage::Join {
            a: a.clone(),
            pub_key: phone.signing.spki().clone(),
            agree: phone.agreement.spki().clone(),
            mac: join_mac,
            sig: phone
                .signing
                .sign_challenge(ChallengeLabel::Join, &room_id, &challenge),
        },
        ControlMessage::Ok {
            role: Role::Owner,
            members: vec![
                MemberInfo {
                    id: computer_id,
                    role: Role::Owner,
                    online: true,
                    last_seen_day: 20384,
                },
                MemberInfo {
                    id: phone_id,
                    role: Role::Phone,
                    online: false,
                    last_seen_day: 20383,
                },
            ],
        },
        ControlMessage::AddAdmission {
            h: digest,
            exp: 1_792_713_600_000,
        },
        ControlMessage::CancelAdmission { h: digest },
        ControlMessage::MemberJoined {
            id: phone_id,
            pub_key: phone.signing.spki().clone(),
            agree: phone.agreement.spki().clone(),
            mac: join_mac,
            eid: 1,
        },
        ControlMessage::MemberLeft {
            id: phone_id,
            eid: 2,
        },
        ControlMessage::EventAck { eid: 2 },
        ControlMessage::Ack {
            op: AckOp::AddAdmission,
            h: Some(digest),
            id: None,
        },
        ControlMessage::Ack {
            op: AckOp::CancelAdmission,
            h: Some(digest),
            id: None,
        },
        ControlMessage::Ack {
            op: AckOp::Revoke,
            h: None,
            id: Some(phone_id),
        },
        ControlMessage::Leave,
        ControlMessage::Revoke { id: phone_id },
        ControlMessage::DeleteRoom,
        ControlMessage::Peer {
            id: computer_id,
            online: true,
        },
        ControlMessage::Error {
            code: "buffer_full".into(),
            msg: "relay buffer for this room is full".into(),
        },
        ControlMessage::Ping,
        ControlMessage::Pong,
    ];
    let control_json: Vec<Value> = controls
        .iter()
        .map(|c| json!({"t": c.type_name(), "json": c.to_json()}))
        .collect();

    json!({
        "description": "WalkieTalkey protocol v1 test vectors (SEC-05). Binary values are lowercase hex; counters are decimal strings. Generated by packages/protocol/rust/examples/gen_test_vectors.rs; do not edit by hand.",
        "version": 1,
        "devices": { "computer": device_json(&computer), "phone": device_json(&phone) },
        "room": {
            "salt": hex(salt.as_bytes()),
            "preimage": hex(&room_preimage),
            "roomId": hex(room_id.as_bytes()),
            "roomIdBase64url": room_id.to_b64u(),
        },
        "signatures": signatures,
        "pairing": {
            "a": hex(a.as_bytes()),
            "aSha256": hex(&sha256(a.as_bytes())),
            "s": hex(s.as_bytes()),
            "shared": hex(on_phone.shared.as_ref()),
            "pairInfo": hex(&pair_info),
            "base": hex(on_phone.base.as_ref()),
            "kP2c": hex(keys.p2c.as_ref()),
            "kC2p": hex(keys.c2p.as_ref()),
            "macKey": hex(join_mac_key(&s).as_ref()),
            "macInput": hex(&mac_input),
            "joinMac": hex(join_mac.as_bytes()),
        },
        "pairingUrl": {
            "phoneAppUrl": "https://app.walkietalkey.com",
            "relayUrl": "wss://relay.walkietalkey.com",
            "computerName": "Jonathans MacBook Pro",
            "os": "mac",
            "json": pairing_json,
            "url": url,
        },
        "frames": frames,
        "invalidFrames": invalid,
        "controlMessages": control_json,
        "counters": {
            "blockSize": COUNTER_BLOCK,
            "steps": [
                {"op": "open", "storedBefore": "0"},
                {"op": "next", "expect": "1", "storedAfter": "1000"},
                {"op": "nextMany", "count": 999, "expectLast": "1000", "storedAfter": "1000"},
                {"op": "next", "expect": "1001", "storedAfter": "2000"},
                {"op": "restart"},
                {"op": "next", "expect": "2001", "storedAfter": "3000"},
            ],
        },
    })
}
