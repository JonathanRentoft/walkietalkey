use thiserror::Error;

/// Every failure of untrusted input. `code()` matches the TypeScript `ProtocolError.code`.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("bad_base64")]
    BadBase64,
    #[error("bad_hex")]
    BadHex,
    #[error("bad_utf8")]
    BadUtf8,
    #[error("bad_length: {0}")]
    BadLength(&'static str),
    #[error("bad_key: {0}")]
    BadKey(&'static str),
    #[error("bad_label")]
    BadLabel,
    #[error("bad_frame: {0}")]
    BadFrame(&'static str),
    #[error("bad_version: {0}")]
    BadVersion(u8),
    #[error("frame_too_large")]
    FrameTooLarge,
    #[error("wrong_recipient")]
    WrongRecipient,
    #[error("wrong_sender")]
    WrongSender,
    #[error("decrypt_failed")]
    DecryptFailed,
    #[error("replay: counter {counter} <= {last}")]
    Replay { counter: u64, last: u64 },
    #[error("bad_payload: {0}")]
    BadPayload(String),
    #[error("bad_message: {0}")]
    BadMessage(String),
    #[error("unknown_message")]
    UnknownMessage,
    #[error("bad_pairing_url: {0}")]
    BadPairingUrl(String),
    #[error("bad_relay_url: {0}")]
    BadRelayUrl(&'static str),
    #[error("store: {0}")]
    Store(String),
    #[error("random: the platform CSPRNG failed")]
    Random,
}

impl ProtocolError {
    /// The shared error code string (same values as the TypeScript implementation).
    pub fn code(&self) -> &'static str {
        match self {
            ProtocolError::BadBase64 => "bad_base64",
            ProtocolError::BadHex => "bad_hex",
            ProtocolError::BadUtf8 => "bad_utf8",
            ProtocolError::BadLength(_) => "bad_length",
            ProtocolError::BadKey(_) => "bad_key",
            ProtocolError::BadLabel => "bad_label",
            ProtocolError::BadFrame(_) => "bad_frame",
            ProtocolError::BadVersion(_) => "bad_version",
            ProtocolError::FrameTooLarge => "frame_too_large",
            ProtocolError::WrongRecipient => "wrong_recipient",
            ProtocolError::WrongSender => "wrong_sender",
            ProtocolError::DecryptFailed => "decrypt_failed",
            ProtocolError::Replay { .. } => "replay",
            ProtocolError::BadPayload(_) => "bad_payload",
            ProtocolError::BadMessage(_) => "bad_message",
            ProtocolError::UnknownMessage => "unknown_message",
            ProtocolError::BadPairingUrl(_) => "bad_pairing_url",
            ProtocolError::BadRelayUrl(_) => "bad_relay_url",
            ProtocolError::Store(_) => "store",
            ProtocolError::Random => "random",
        }
    }
}

pub type Result<T, E = ProtocolError> = std::result::Result<T, E>;
