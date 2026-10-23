//! Derivations of spec 9.3.

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::bytes::{DeviceId, Mac32, RoomId, Salt, Secret32};
use crate::consts::*;
use crate::keys::{AgreementKeyPair, Spki};

type HmacSha256 = Hmac<Sha256>;

/// roomId = first 16 bytes of SHA-256("wt-room-v1" ‖ owner signing SPKI ‖ salt).
pub fn compute_room_id(owner_signing_spki: &Spki, salt: &Salt) -> RoomId {
    let mut h = Sha256::new();
    h.update(LABEL_ROOM.as_bytes());
    h.update(owner_signing_spki.as_bytes());
    h.update(salt.as_bytes());
    RoomId::from_slice(&h.finalize()[..ROOM_ID_LEN]).expect("16 bytes")
}

/// HKDF-SHA-256 with a zero-length salt meaning RFC 5869's default (HashLen zero bytes).
pub fn hkdf32(ikm: &[u8], salt: &[u8], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(Some(salt), ikm);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(info, out.as_mut())
        .expect("32 bytes is a valid HKDF length");
    out
}

/// The two direction keys of one phone ↔ computer pair.
#[derive(Clone, PartialEq, Eq)]
pub struct PairKeys {
    /// k_p2c: phone → computer.
    pub p2c: Zeroizing<[u8; 32]>,
    /// k_c2p: computer → phone.
    pub c2p: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for PairKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PairKeys(<redacted>)")
    }
}

/// Every intermediate value of the pair derivation (test vectors use these).
pub struct PairSecrets {
    pub shared: Zeroizing<[u8; 32]>,
    pub base: Zeroizing<[u8; 32]>,
    pub keys: PairKeys,
}

/// Inputs both sides know after the join.
pub struct PairContext<'a> {
    pub secret: &'a Secret32,
    pub room_id: &'a RoomId,
    pub computer_id: &'a DeviceId,
    pub phone_id: &'a DeviceId,
}

/// shared = ECDH(own agreement private, peer agreement public);
/// base = HKDF(shared, salt = s, info = "wt-pair-v1" ‖ roomId ‖ computerId ‖ phoneId);
/// k_p2c / k_c2p = HKDF(base, salt = "", info = "wt-p2c-v1" / "wt-c2p-v1").
pub fn derive_pair_secrets(
    own: &AgreementKeyPair,
    peer_agreement: &Spki,
    ctx: &PairContext<'_>,
) -> PairSecrets {
    let shared = own.shared_secret(peer_agreement);
    let mut info = Vec::with_capacity(LABEL_PAIR.len() + 48);
    info.extend_from_slice(LABEL_PAIR.as_bytes());
    info.extend_from_slice(ctx.room_id.as_bytes());
    info.extend_from_slice(ctx.computer_id.as_bytes());
    info.extend_from_slice(ctx.phone_id.as_bytes());
    let base = hkdf32(shared.as_ref(), ctx.secret.as_bytes(), &info);
    let keys = PairKeys {
        p2c: hkdf32(base.as_ref(), &[], LABEL_P2C.as_bytes()),
        c2p: hkdf32(base.as_ref(), &[], LABEL_C2P.as_bytes()),
    };
    PairSecrets { shared, base, keys }
}

pub fn derive_pair_keys(
    own: &AgreementKeyPair,
    peer_agreement: &Spki,
    ctx: &PairContext<'_>,
) -> PairKeys {
    derive_pair_secrets(own, peer_agreement, ctx).keys
}

/// mac_key = HKDF-SHA256(ikm = s, salt = "", info = "wt-join-mac-v1").
pub fn join_mac_key(secret: &Secret32) -> Zeroizing<[u8; 32]> {
    hkdf32(secret.as_bytes(), &[], LABEL_JOIN_MAC.as_bytes())
}

fn join_mac_hmac(
    secret: &Secret32,
    room_id: &RoomId,
    phone_signing: &Spki,
    phone_agreement: &Spki,
) -> HmacSha256 {
    let key = join_mac_key(secret);
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key.as_ref()).expect("any key length");
    mac.update(room_id.as_bytes());
    mac.update(phone_signing.as_bytes());
    mac.update(phone_agreement.as_bytes());
    mac
}

/// join_mac = HMAC-SHA256(mac_key, roomId ‖ phone signing SPKI ‖ phone agreement SPKI).
pub fn compute_join_mac(
    secret: &Secret32,
    room_id: &RoomId,
    phone_signing: &Spki,
    phone_agreement: &Spki,
) -> Mac32 {
    let out = join_mac_hmac(secret, room_id, phone_signing, phone_agreement)
        .finalize()
        .into_bytes();
    Mac32::from_slice(&out).expect("32 bytes")
}

/// Constant-time verification of a join MAC.
pub fn verify_join_mac(
    secret: &Secret32,
    room_id: &RoomId,
    phone_signing: &Spki,
    phone_agreement: &Spki,
    mac: &[u8],
) -> bool {
    join_mac_hmac(secret, room_id, phone_signing, phone_agreement)
        .verify_slice(mac)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::DeviceKeys;

    #[test]
    fn both_sides_derive_the_same_keys() {
        let computer = DeviceKeys::generate().unwrap();
        let phone = DeviceKeys::generate().unwrap();
        let s = Secret32::random().unwrap();
        let room = compute_room_id(computer.signing.spki(), &Salt::random().unwrap());
        let ctx = PairContext {
            secret: &s,
            room_id: &room,
            computer_id: &computer.device_id(),
            phone_id: &phone.device_id(),
        };
        let a = derive_pair_keys(&phone.agreement, computer.agreement.spki(), &ctx);
        let b = derive_pair_keys(&computer.agreement, phone.agreement.spki(), &ctx);
        assert_eq!(a, b);
        assert_ne!(*a.p2c, *a.c2p);
    }

    #[test]
    fn join_mac_detects_swapped_keys() {
        let phone = DeviceKeys::generate().unwrap();
        let other = DeviceKeys::generate().unwrap();
        let s = Secret32::random().unwrap();
        let room = RoomId::random().unwrap();
        let mac = compute_join_mac(&s, &room, phone.signing.spki(), phone.agreement.spki());
        assert!(verify_join_mac(
            &s,
            &room,
            phone.signing.spki(),
            phone.agreement.spki(),
            mac.as_bytes()
        ));
        assert!(!verify_join_mac(
            &s,
            &room,
            phone.signing.spki(),
            other.agreement.spki(),
            mac.as_bytes()
        ));
        assert!(!verify_join_mac(
            &Secret32::random().unwrap(),
            &room,
            phone.signing.spki(),
            phone.agreement.spki(),
            mac.as_bytes()
        ));
        assert!(!verify_join_mac(
            &s,
            &room,
            phone.signing.spki(),
            phone.agreement.spki(),
            &mac.as_bytes()[..31]
        ));
    }
}
