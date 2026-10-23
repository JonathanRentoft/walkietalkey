//! Constants shared with the TypeScript implementation (`src/constants.ts`).

pub const PROTOCOL_VERSION: u8 = 1;

pub const LABEL_ROOM: &str = "wt-room-v1";
pub const LABEL_AUTH: &str = "wt-auth-v1";
pub const LABEL_CREATE: &str = "wt-create-v1";
pub const LABEL_JOIN: &str = "wt-join-v1";
pub const LABEL_PAIR: &str = "wt-pair-v1";
pub const LABEL_P2C: &str = "wt-p2c-v1";
pub const LABEL_C2P: &str = "wt-c2p-v1";
pub const LABEL_JOIN_MAC: &str = "wt-join-mac-v1";

pub const ROOM_ID_LEN: usize = 16;
pub const DEVICE_ID_LEN: usize = 16;
pub const SESSION_ID_LEN: usize = 16;
pub const SALT_LEN: usize = 16;
pub const CHALLENGE_LEN: usize = 32;
pub const SECRET_LEN: usize = 32;
pub const MAC_LEN: usize = 32;
pub const SHA256_LEN: usize = 32;
pub const KEY_LEN: usize = 32;
pub const SIGNATURE_LEN: usize = 64;
pub const NONCE_LEN: usize = 12;
pub const TAG_LEN: usize = 16;

/// DER prefix of a P-256 SPKI with an uncompressed point, including the 0x04 point tag.
pub const SPKI_PREFIX: [u8; 27] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
];
pub const SPKI_LEN: usize = 91;

/// Header bytes covered as AAD: version, type, sender, recipient, counter.
pub const AAD_LEN: usize = 42;
/// AAD plus nonce.
pub const HEADER_LEN: usize = 54;
pub const FRAME_OVERHEAD: usize = HEADER_LEN + TAG_LEN;
pub const MAX_FRAME_LEN: usize = 65536;
pub const MAX_PLAINTEXT_LEN: usize = MAX_FRAME_LEN - FRAME_OVERHEAD;

pub mod frame_type {
    pub const DEVICE_INFO: u8 = 0x10;
    pub const PRESENCE: u8 = 0x11;
    pub const PRESENCE_QUERY: u8 = 0x12;
    pub const AUDIO_START: u8 = 0x20;
    pub const AUDIO_CHUNK: u8 = 0x21;
    pub const AUDIO_END: u8 = 0x22;
    pub const AUDIO_CANCEL: u8 = 0x23;
    pub const RESULT: u8 = 0x30;
}

/// WebSocket close codes (Appendix C.3).
pub mod close_code {
    pub const NOT_AUTHORISED: u16 = 4401;
    pub const NOT_ALLOWED: u16 = 4403;
    pub const ROOM_NOT_FOUND: u16 = 4404;
    pub const ROOM_EXISTS: u16 = 4409;
    pub const FRAME_TOO_LARGE: u16 = 4413;
    pub const RATE_LIMITED: u16 = 4429;
    /// Outside C.3: normal close (leave, delete_room, a replaced socket).
    pub const NORMAL: u16 = 1000;
    /// Outside C.3: the relay closed a socket that went quiet (RELAY-10).
    pub const GOING_AWAY: u16 = 1001;
    /// Outside C.3: malformed control message or frame.
    pub const POLICY_VIOLATION: u16 = 1008;
}

pub const SAMPLE_RATE: u32 = 16000;
pub const BLOCK_MS: u32 = 200;
pub const BLOCK_SAMPLES: usize = 3200;
pub const BLOCK_BYTES: usize = 6400;
pub const MAX_BLOCKS_PER_FRAME: usize = 10;
pub const AUDIO_CHUNK_HEADER_LEN: usize = SESSION_ID_LEN + 4;

pub const MAX_DEVICE_NAME_BYTES: usize = 256;
pub const MAX_PLATFORM_BYTES: usize = 32;
pub const MAX_COMPUTER_NAME_BYTES: usize = 256;

pub const ADMISSION_TTL_MS: u64 = 10 * 60 * 1000;
pub const PING_INTERVAL_MS: u64 = 30_000;
pub const LIVENESS_TIMEOUT_MS: u64 = 75_000;
pub const COUNTER_BLOCK: u64 = 1000;

/// Exact strings of the relay's automatic ping answer (RELAY-10).
pub const PING_MESSAGE: &str = r#"{"t":"ping"}"#;
pub const PONG_MESSAGE: &str = r#"{"t":"pong"}"#;
