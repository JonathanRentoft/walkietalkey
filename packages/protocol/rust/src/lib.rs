//! WalkieTalkey wire protocol (spec sections 5, 8, 9 and Appendix C; byte-level detail in
//! `docs/PROTOCOL.md`). The TypeScript package `@walkietalkey/protocol` implements the same
//! protocol; both pass `packages/protocol/test-vectors.json`.
//!
//! RustCrypto only (p256, hkdf, hmac, aes-gcm, sha2) and `getrandom` for randomness.
//! No async runtime.

pub mod bytes;
pub mod channel;
pub mod consts;
pub mod control;
pub mod counter;
pub mod derive;
pub mod error;
pub mod frame;
pub mod keys;
pub mod pairing;
pub mod payload;
#[cfg(feature = "test-utils")]
pub mod test_vectors;

pub use bytes::{
    b64u_decode, b64u_encode, Challenge, DeviceId, Digest32, Mac32, RoomId, Salt, Secret32,
    SessionId, Signature64,
};
pub use channel::{PairChannel, PairRole};
pub use control::{AckOp, ControlMessage, MemberInfo, Role};
pub use counter::{counter_key, CounterStore, MemoryCounterStore, ReplayGuard, SendCounter};
pub use derive::{
    compute_join_mac, compute_room_id, derive_pair_keys, derive_pair_secrets, verify_join_mac,
    PairContext, PairKeys,
};
pub use error::{ProtocolError, Result};
pub use frame::{open_frame, parse_frame, seal_frame, FrameHeader, ParsedFrame, SealHeader};
pub use keys::{
    challenge_message, verify_challenge, AgreementKeyPair, ChallengeLabel, DeviceKeys,
    SigningKeyPair, Spki,
};
pub use pairing::{
    assert_relay_url, decode_pairing_url, encode_pairing_url, room_socket_url, ComputerOs, Intent,
    PairingPayload,
};
pub use payload::{DevicePayload, Direction, ResultOutcome, ResultReason};

/// SHA-256 helper.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    sha2::Sha256::digest(data).into()
}
