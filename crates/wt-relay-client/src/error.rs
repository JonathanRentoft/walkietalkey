use thiserror::Error;
use wt_protocol::ProtocolError;

/// Errors from the persistence layer (the desktop app maps its keychain errors to this).
#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("key store: {0}")]
pub struct StoreError(pub String);

impl StoreError {
    pub fn new(msg: impl Into<String>) -> Self {
        StoreError(msg.into())
    }
}

impl From<StoreError> for ProtocolError {
    fn from(e: StoreError) -> Self {
        ProtocolError::Store(e.0)
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// SEC-06: the relay URL must be wss:// (ws:// only to localhost in debug builds).
    #[error("relay URL refused: {0}")]
    InsecureRelayUrl(String),
    #[error("not connected to the relay")]
    NotConnected,
    #[error("the relay did not answer in time")]
    Timeout,
    #[error("unknown phone")]
    UnknownPhone,
    #[error("no such presence query (presence is only sent as an answer, DESK-63)")]
    NoPendingQuery,
    #[error("relay error {code}: {message}")]
    Relay { code: String, message: String },
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    #[error("the client has shut down")]
    Shutdown,
}
