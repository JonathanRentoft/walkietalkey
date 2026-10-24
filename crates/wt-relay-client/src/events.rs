use std::time::{Duration, SystemTime};

use wt_protocol::{DeviceId, Digest32, MemberInfo, RoomId, SessionId};

/// Opaque handle for one `presence_query`, used to answer it (DESK-63).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct QueryId(pub u64);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    /// The join MAC did not verify with the pairing secret: the keys were swapped (SEC-03).
    BadMac,
    /// A phone joined but this computer has no pairing in progress (for example after a restart).
    NoPairingInProgress,
}

/// Everything the client reports. Audio events carry raw PCM16 little-endian mono 16 kHz.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayEvent {
    /// Authenticated with the relay; `members` as the relay lists them.
    Connected {
        room_id: RoomId,
        members: Vec<MemberInfo>,
    },
    /// The socket is gone; the client retries after `retry_in` (DESK-60).
    Disconnected {
        reason: String,
        retry_in: Option<Duration>,
    },
    /// A new room was created on the relay (first start, or after a reset).
    RoomCreated {
        room_id: RoomId,
    },
    /// The relay no longer knows this room (90 days unseen, spec 5.4). All phones are gone; a
    /// new room is created and phones must pair again.
    RoomReset {
        old_room_id: RoomId,
        code: u16,
    },
    /// `delete_room` finished.
    RoomDeleted,
    /// A phone joined and its MAC verified (DESK-62: show "Var det dig?"). `name` is None when
    /// the phone did not send one within `name_wait`.
    PhonePaired {
        phone: DeviceId,
        name: Option<String>,
        platform: Option<String>,
    },
    /// The phone's name or platform arrived after PhonePaired, or changed.
    PhoneInfo {
        phone: DeviceId,
        name: String,
        platform: String,
    },
    /// A joined phone was refused and revoked at the relay (SEC-03).
    PhoneRejected {
        phone: DeviceId,
        reason: RejectReason,
    },
    /// The pairing code expired without a join (SEC-02).
    PairingExpired {
        admission_hash: Digest32,
    },
    /// The phone removed itself (`leave`); its keys are deleted.
    PhoneLeft {
        phone: DeviceId,
    },
    /// A phone was removed by `revoke_phone` (or for being unseen 90 days); its keys are deleted.
    PhoneRemoved {
        phone: DeviceId,
    },
    PeerStatus {
        phone: DeviceId,
        online: bool,
    },
    AudioStart {
        phone: DeviceId,
        session: SessionId,
        sample_rate: u32,
    },
    /// A take for the fine-tuning workbench started (`audio_start_training`, PROTOCOL.md 8.4).
    /// Its blocks and its end follow as `AudioChunk` and `AudioEnd`, like a dictation's, but it
    /// never comes as an `AudioStart`: the app records it for the workbench and never
    /// transcribes it.
    TrainingStart {
        phone: DeviceId,
        session: SessionId,
        /// The training session the phone's prompt came from.
        training: SessionId,
        /// The prompt this take reads.
        prompt: String,
        /// The phone's microphone, as its browser names it, when known.
        microphone: Option<String>,
    },
    /// One 200 ms block (the last one of a session may be shorter), each index exactly once.
    AudioChunk {
        phone: DeviceId,
        session: SessionId,
        index: u32,
        pcm: Vec<u8>,
    },
    /// `missing` lists block indices below `chunks` not received yet; resent blocks still
    /// arrive as AudioChunk (DESK-61 waits up to 5 s for them).
    AudioEnd {
        phone: DeviceId,
        session: SessionId,
        chunks: u32,
        duration_ms: u32,
        missing: Vec<u32>,
    },
    AudioCancel {
        phone: DeviceId,
        session: SessionId,
    },
    /// Answer with `RelayClient::answer_presence` (DESK-63); nothing is sent unasked.
    PresenceQuery {
        phone: DeviceId,
        query: QueryId,
    },
    /// An `error` control message from the relay (for example `buffer_full`).
    RelayError {
        code: String,
        message: String,
    },
}

/// What `start_pairing` returns: the QR content (spec 5.3).
#[derive(Clone, PartialEq, Eq)]
pub struct PairingTicket {
    pub url: String,
    pub admission_hash: Digest32,
    pub expires_at: SystemTime,
}

impl std::fmt::Debug for PairingTicket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingTicket")
            .field("admission_hash", &self.admission_hash)
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhoneSummary {
    pub id: DeviceId,
    pub name: Option<String>,
    pub platform: Option<String>,
    pub online: bool,
    /// Days since 1970-01-01 UTC that the relay last saw the phone; today
    /// while it is online, `None` when it was never seen.
    pub last_seen_day: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    pub connected: bool,
    pub device_id: DeviceId,
    pub room_id: Option<RoomId>,
    pub phones: Vec<PhoneSummary>,
    pub pairing_active: bool,
}

/// PCM16 little-endian bytes to samples.
pub fn pcm16_samples(pcm: &[u8]) -> Vec<i16> {
    (0..pcm.len() / 2)
        .map(|i| i16::from_le_bytes([pcm[2 * i], pcm[2 * i + 1]]))
        .collect()
}
