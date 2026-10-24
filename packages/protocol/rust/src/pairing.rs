//! Pairing URL of spec 5.3 and relay URL rules (SEC-06).

use serde::{Deserialize, Serialize};

use crate::bytes::{b64u_decode, b64u_encode, RoomId, Secret32};
use crate::consts::MAX_COMPUTER_NAME_BYTES;
use crate::error::{ProtocolError, Result};
use crate::keys::Spki;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ComputerOs {
    Mac,
    Win,
}

/// The connection intent a client declares in the socket URL (extension, see PROTOCOL.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    Auth,
    Create,
    Join,
}

impl Intent {
    pub fn as_str(self) -> &'static str {
        match self {
            Intent::Auth => "auth",
            Intent::Create => "create",
            Intent::Join => "join",
        }
    }
}

/// The QR payload. Debug output never shows the secrets.
#[derive(Clone, PartialEq, Eq)]
pub struct PairingPayload {
    pub room_id: RoomId,
    pub admission: Secret32,
    pub secret: Secret32,
    pub computer_agreement: Spki,
    pub relay_url: String,
    pub computer_name: String,
    pub os: ComputerOs,
}

impl std::fmt::Debug for PairingPayload {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingPayload")
            .field("room_id", &self.room_id)
            .field("relay_url", &self.relay_url)
            .field("computer_name", &self.computer_name)
            .field("os", &self.os)
            .finish_non_exhaustive()
    }
}

/// Wire form; field order is the JSON key order v, r, a, s, e, u, n, o.
#[derive(Serialize, Deserialize)]
struct PairingJson {
    v: u32,
    r: RoomId,
    a: Secret32,
    s: Secret32,
    e: Spki,
    u: String,
    n: String,
    o: ComputerOs,
}

/// Errors unless the URL is `wss://`, or `ws://` to localhost / 127.0.0.1 / [::1] when allowed.
pub fn assert_relay_url(url: &str, allow_insecure_localhost: bool) -> Result<()> {
    let (scheme, rest) = url
        .split_once("://")
        .ok_or(ProtocolError::BadRelayUrl("not a URL"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let host = if host_port.starts_with('[') {
        match host_port.find(']') {
            Some(end) => &host_port[..=end],
            None => return Err(ProtocolError::BadRelayUrl("bad IPv6 host")),
        }
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return Err(ProtocolError::BadRelayUrl("no host"));
    }
    match scheme.to_ascii_lowercase().as_str() {
        "wss" => Ok(()),
        "ws" if allow_insecure_localhost
            && matches!(
                host.to_ascii_lowercase().as_str(),
                "localhost" | "127.0.0.1" | "[::1]"
            ) =>
        {
            Ok(())
        }
        _ => Err(ProtocolError::BadRelayUrl("the relay must use wss://")),
    }
}

/// `<relay>/v1/rooms/<roomId>/ws?intent=<intent>`.
pub fn room_socket_url(relay_url: &str, room_id: &RoomId, intent: Intent) -> String {
    format!(
        "{}/v1/rooms/{}/ws?intent={}",
        relay_url.trim_end_matches('/'),
        room_id.to_b64u(),
        intent.as_str()
    )
}

fn validate(p: &PairingPayload, allow_insecure_localhost: bool) -> Result<()> {
    assert_relay_url(&p.relay_url, allow_insecure_localhost)
        .map_err(|_| ProtocolError::BadPairingUrl("u must be a wss:// relay URL".into()))?;
    if p.computer_name.len() > MAX_COMPUTER_NAME_BYTES {
        return Err(ProtocolError::BadPairingUrl("n too long".into()));
    }
    Ok(())
}

/// `<phoneAppUrl>/p#<base64url(UTF-8 JSON)>`.
pub fn encode_pairing_url(phone_app_url: &str, p: &PairingPayload) -> Result<String> {
    validate(p, true)?;
    let json = serde_json::to_string(&PairingJson {
        v: 1,
        r: p.room_id,
        a: p.admission.clone(),
        s: p.secret.clone(),
        e: p.computer_agreement.clone(),
        u: p.relay_url.clone(),
        n: p.computer_name.clone(),
        o: p.os,
    })
    .expect("pairing JSON serializes");
    Ok(format!(
        "{}/p#{}",
        phone_app_url.trim_end_matches('/'),
        b64u_encode(json.as_bytes())
    ))
}

pub fn decode_pairing_url(url: &str, allow_insecure_localhost: bool) -> Result<PairingPayload> {
    let (_, fragment) = url
        .split_once('#')
        .ok_or_else(|| ProtocolError::BadPairingUrl("no fragment".into()))?;
    let bytes =
        b64u_decode(fragment).map_err(|_| ProtocolError::BadPairingUrl("not base64url".into()))?;
    let j: PairingJson = serde_json::from_slice(&bytes)
        .map_err(|e| ProtocolError::BadPairingUrl(format!("bad JSON: {e}")))?;
    if j.v != 1 {
        return Err(ProtocolError::BadPairingUrl("unsupported version".into()));
    }
    let p = PairingPayload {
        room_id: j.r,
        admission: j.a,
        secret: j.s,
        computer_agreement: j.e,
        relay_url: j.u,
        computer_name: j.n,
        os: j.o,
    };
    validate(&p, allow_insecure_localhost)?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::AgreementKeyPair;

    fn payload(u: &str) -> PairingPayload {
        PairingPayload {
            room_id: RoomId([1; 16]),
            admission: Secret32([2; 32]),
            secret: Secret32([3; 32]),
            computer_agreement: AgreementKeyPair::generate().unwrap().spki().clone(),
            relay_url: u.into(),
            computer_name: "Jonathans MacBook Pro".into(),
            os: ComputerOs::Mac,
        }
    }

    #[test]
    fn round_trip_with_key_order() {
        let p = payload("wss://relay.walkietalkey.com");
        let url = encode_pairing_url("https://app.walkietalkey.com/", &p).unwrap();
        assert!(url.starts_with("https://app.walkietalkey.com/p#"));
        let json = String::from_utf8(b64u_decode(url.split_once('#').unwrap().1).unwrap()).unwrap();
        assert!(json.starts_with(r#"{"v":1,"r":"#), "{json}");
        let keys: Vec<_> = serde_json::from_str::<serde_json::Value>(&json)
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys.len(), 8);
        assert_eq!(decode_pairing_url(&url, false).unwrap(), p);
        assert!(!format!("{p:?}").contains(&Secret32([3; 32]).to_b64u()));
    }

    #[test]
    fn relay_url_policy() {
        assert!(assert_relay_url("wss://relay.walkietalkey.com", false).is_ok());
        assert!(assert_relay_url("ws://relay.walkietalkey.com", true).is_err());
        assert!(assert_relay_url("ws://localhost:8787", false).is_err());
        assert!(assert_relay_url("ws://localhost:8787", true).is_ok());
        assert!(assert_relay_url("ws://127.0.0.1:8787/x", true).is_ok());
        assert!(assert_relay_url("ws://[::1]:8787", true).is_ok());
        assert!(assert_relay_url("ws://localhost.evil.example", true).is_err());
        assert!(assert_relay_url("https://relay.example", true).is_err());
        let p = payload("ws://127.0.0.1:8787");
        let url = encode_pairing_url("http://localhost:5173", &p).unwrap();
        assert!(decode_pairing_url(&url, false).is_err());
        assert!(decode_pairing_url(&url, true).is_ok());
    }

    #[test]
    fn socket_url() {
        assert_eq!(
            room_socket_url("wss://r.example/", &RoomId([0; 16]), Intent::Join),
            "wss://r.example/v1/rooms/AAAAAAAAAAAAAAAAAAAAAA/ws?intent=join"
        );
    }
}
