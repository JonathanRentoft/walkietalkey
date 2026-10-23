//! Control messages (Appendix C.1): JSON text frames between a device and the relay.

use serde::{Deserialize, Serialize};

use crate::bytes::{Challenge, DeviceId, Digest32, Mac32, Salt, Secret32, Signature64};
use crate::error::{ProtocolError, Result};
use crate::keys::Spki;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Owner,
    Phone,
}

/// A member as listed in `ok`. `last_seen_day` is days since 1970-01-01 UTC.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberInfo {
    pub id: DeviceId,
    pub role: Role,
    pub online: bool,
    pub last_seen_day: u64,
}

/// Owner commands the relay confirms with `ack` (extension, see PROTOCOL.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AckOp {
    AddAdmission,
    CancelAdmission,
    Revoke,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ControlMessage {
    Challenge {
        n: Challenge,
    },
    Auth {
        id: DeviceId,
        sig: Signature64,
    },
    Create {
        #[serde(rename = "pub")]
        pub_key: Spki,
        salt: Salt,
        sig: Signature64,
    },
    Join {
        a: Secret32,
        #[serde(rename = "pub")]
        pub_key: Spki,
        agree: Spki,
        mac: Mac32,
        sig: Signature64,
    },
    Ok {
        role: Role,
        members: Vec<MemberInfo>,
    },
    AddAdmission {
        h: Digest32,
        exp: u64,
    },
    CancelAdmission {
        h: Digest32,
    },
    MemberJoined {
        id: DeviceId,
        #[serde(rename = "pub")]
        pub_key: Spki,
        agree: Spki,
        mac: Mac32,
        eid: u64,
    },
    MemberLeft {
        id: DeviceId,
        eid: u64,
    },
    EventAck {
        eid: u64,
    },
    Ack {
        op: AckOp,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        h: Option<Digest32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<DeviceId>,
    },
    Leave,
    Revoke {
        id: DeviceId,
    },
    DeleteRoom,
    Peer {
        id: DeviceId,
        online: bool,
    },
    Error {
        code: String,
        msg: String,
    },
    Ping,
    Pong,
}

const KNOWN: &[&str] = &[
    "challenge",
    "auth",
    "create",
    "join",
    "ok",
    "add_admission",
    "cancel_admission",
    "member_joined",
    "member_left",
    "event_ack",
    "ack",
    "leave",
    "revoke",
    "delete_room",
    "peer",
    "error",
    "ping",
    "pong",
];

impl ControlMessage {
    /// Parses one text frame. Unknown fields are ignored. Never panics.
    pub fn parse(text: &str) -> Result<Self> {
        match serde_json::from_str::<ControlMessage>(text) {
            Ok(m) => Ok(m),
            Err(e) => {
                let t = serde_json::from_str::<serde_json::Value>(text)
                    .ok()
                    .and_then(|v| v.get("t").and_then(|t| t.as_str().map(str::to_owned)));
                match t {
                    Some(t) if !KNOWN.contains(&t.as_str()) => Err(ProtocolError::UnknownMessage),
                    _ => Err(ProtocolError::BadMessage(e.to_string())),
                }
            }
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("control messages serialize")
    }

    pub fn type_name(&self) -> &'static str {
        match self {
            ControlMessage::Challenge { .. } => "challenge",
            ControlMessage::Auth { .. } => "auth",
            ControlMessage::Create { .. } => "create",
            ControlMessage::Join { .. } => "join",
            ControlMessage::Ok { .. } => "ok",
            ControlMessage::AddAdmission { .. } => "add_admission",
            ControlMessage::CancelAdmission { .. } => "cancel_admission",
            ControlMessage::MemberJoined { .. } => "member_joined",
            ControlMessage::MemberLeft { .. } => "member_left",
            ControlMessage::EventAck { .. } => "event_ack",
            ControlMessage::Ack { .. } => "ack",
            ControlMessage::Leave => "leave",
            ControlMessage::Revoke { .. } => "revoke",
            ControlMessage::DeleteRoom => "delete_room",
            ControlMessage::Peer { .. } => "peer",
            ControlMessage::Error { .. } => "error",
            ControlMessage::Ping => "ping",
            ControlMessage::Pong => "pong",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consts::PING_MESSAGE;
    use crate::keys::SigningKeyPair;

    #[test]
    fn round_trips_and_exact_ping() {
        let k = SigningKeyPair::generate().unwrap();
        let msgs = vec![
            ControlMessage::Challenge {
                n: Challenge::random().unwrap(),
            },
            ControlMessage::Auth {
                id: k.device_id(),
                sig: Signature64([1; 64]),
            },
            ControlMessage::Create {
                pub_key: k.spki().clone(),
                salt: Salt([2; 16]),
                sig: Signature64([3; 64]),
            },
            ControlMessage::Join {
                a: Secret32([4; 32]),
                pub_key: k.spki().clone(),
                agree: k.spki().clone(),
                mac: Mac32([5; 32]),
                sig: Signature64([6; 64]),
            },
            ControlMessage::Ok {
                role: Role::Owner,
                members: vec![MemberInfo {
                    id: k.device_id(),
                    role: Role::Phone,
                    online: true,
                    last_seen_day: 20384,
                }],
            },
            ControlMessage::AddAdmission {
                h: Digest32([7; 32]),
                exp: 1_790_000_000_000,
            },
            ControlMessage::CancelAdmission {
                h: Digest32([7; 32]),
            },
            ControlMessage::MemberJoined {
                id: k.device_id(),
                pub_key: k.spki().clone(),
                agree: k.spki().clone(),
                mac: Mac32([8; 32]),
                eid: 9,
            },
            ControlMessage::MemberLeft {
                id: k.device_id(),
                eid: 10,
            },
            ControlMessage::EventAck { eid: 10 },
            ControlMessage::Ack {
                op: AckOp::AddAdmission,
                h: Some(Digest32([7; 32])),
                id: None,
            },
            ControlMessage::Ack {
                op: AckOp::Revoke,
                h: None,
                id: Some(k.device_id()),
            },
            ControlMessage::Leave,
            ControlMessage::Revoke { id: k.device_id() },
            ControlMessage::DeleteRoom,
            ControlMessage::Peer {
                id: k.device_id(),
                online: false,
            },
            ControlMessage::Error {
                code: "buffer_full".into(),
                msg: "x".into(),
            },
            ControlMessage::Ping,
            ControlMessage::Pong,
        ];
        for m in msgs {
            let json = m.to_json();
            assert_eq!(ControlMessage::parse(&json).unwrap(), m, "{json}");
            assert!(
                json.starts_with(&format!(r#"{{"t":"{}""#, m.type_name())),
                "{json}"
            );
        }
        assert_eq!(ControlMessage::Ping.to_json(), PING_MESSAGE);
    }

    #[test]
    fn rejects_malformed_and_unknown() {
        assert_eq!(
            ControlMessage::parse(r#"{"t":"nope"}"#).unwrap_err(),
            ProtocolError::UnknownMessage
        );
        assert!(ControlMessage::parse("{}").is_err());
        assert!(ControlMessage::parse("[]").is_err());
        assert!(ControlMessage::parse(r#"{"t":"auth","id":"AAAA","sig":"AAAA"}"#).is_err());
        assert!(ControlMessage::parse(r#"{"t":"ack","op":"other"}"#).is_err());
        assert_eq!(
            ControlMessage::parse(r#"{"t":"leave","x":1}"#).unwrap(),
            ControlMessage::Leave
        );
    }
}
