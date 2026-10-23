//! WalkieTalkey desktop relay client: the computer's side of its room (spec sections 5, 8, 9;
//! DESK-60 to DESK-64). Independent of Tauri and of how audio is transcribed.
//!
//! ```no_run
//! # async fn demo() -> Result<(), wt_relay_client::ClientError> {
//! use std::sync::Arc;
//! use wt_relay_client::{ClientConfig, MemoryKeyStore, RelayClient, RelayEvent};
//! use wt_protocol::{ComputerOs, ResultOutcome};
//!
//! let config = ClientConfig::new("wss://relay.walkietalkey.com", "https://app.walkietalkey.com", "Jonathans Mac", ComputerOs::Mac);
//! let (client, mut events) = RelayClient::start(config, Arc::new(MemoryKeyStore::new()))?;
//! let ticket = client.start_pairing().await?; // show ticket.url as a QR code
//! while let Some(event) = events.recv().await {
//!     match event {
//!         RelayEvent::PhonePaired { phone, name, .. } => { /* "Ny telefon parret: …. Var det dig?" */ }
//!         RelayEvent::AudioChunk { index, pcm, .. } => { /* feed the live chunker */ }
//!         RelayEvent::AudioEnd { phone, session, .. } => {
//!             client.send_result(phone, session, ResultOutcome::Ok).await?;
//!         }
//!         _ => {}
//!     }
//! }
//! # Ok(()) }
//! ```

mod client;
mod config;
mod error;
mod events;
mod sessions;
mod store;

pub use client::RelayClient;
pub use config::{ClientConfig, DEFAULT_BACKOFF};
pub use error::{ClientError, StoreError};
pub use events::{
    pcm16_samples, PairingTicket, PhoneSummary, QueryId, RejectReason, RelayEvent, Status,
};
pub use sessions::{SessionTracker, MAX_BLOCK_INDEX, SESSION_TTL};
pub use store::{
    JsonFileKeyStore, KeyStore, MemoryKeyStore, StoreCounters, StoredDeviceKeys, StoredPhone,
    StoredRoom,
};
pub use wt_protocol;
