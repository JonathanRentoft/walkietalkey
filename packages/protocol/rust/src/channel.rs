//! One end of an encrypted phone ↔ computer pair (mirror of TypeScript `PairChannel`).

use crate::bytes::DeviceId;
use crate::counter::{counter_key, CounterStore, ReplayGuard, SendCounter};
use crate::derive::PairKeys;
use crate::error::{ProtocolError, Result};
use crate::frame::{open_frame, parse_frame, seal_frame, FrameHeader, SealHeader};
use crate::payload::{direction_of, DevicePayload, Direction};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairRole {
    Phone,
    Computer,
}

pub struct PairChannel {
    role: PairRole,
    self_id: DeviceId,
    peer_id: DeviceId,
    keys: PairKeys,
    counter: SendCounter,
    guard: ReplayGuard,
}

impl std::fmt::Debug for PairChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairChannel")
            .field("role", &self.role)
            .field("peer", &self.peer_id)
            .finish_non_exhaustive()
    }
}

impl PairChannel {
    pub fn new(
        role: PairRole,
        self_id: DeviceId,
        peer_id: DeviceId,
        keys: PairKeys,
        store: &dyn CounterStore,
    ) -> Result<Self> {
        Ok(PairChannel {
            role,
            self_id,
            peer_id,
            keys,
            counter: SendCounter::open(store, counter_key(&self_id, &peer_id))?,
            guard: ReplayGuard::open(store, counter_key(&peer_id, &self_id))?,
        })
    }

    pub fn peer_id(&self) -> DeviceId {
        self.peer_id
    }

    fn out_direction(&self) -> Direction {
        match self.role {
            PairRole::Phone => Direction::PhoneToComputer,
            PairRole::Computer => Direction::ComputerToPhone,
        }
    }

    /// Encrypts a payload to the peer with a fresh counter and random nonce.
    pub fn seal(&mut self, store: &dyn CounterStore, payload: &DevicePayload) -> Result<Vec<u8>> {
        if payload.direction() != self.out_direction() {
            return Err(ProtocolError::BadPayload(
                "payload type not sent by this side".into(),
            ));
        }
        let bytes = payload.encode()?;
        let counter = self.counter.next(store)?;
        let key = match self.role {
            PairRole::Phone => &self.keys.p2c,
            PairRole::Computer => &self.keys.c2p,
        };
        seal_frame(
            key,
            &SealHeader {
                frame_type: payload.frame_type(),
                sender: self.self_id,
                recipient: self.peer_id,
                counter,
            },
            &bytes,
        )
    }

    /// Recipient, sender and replay checks, decrypt, persist the counter, decode.
    pub fn open(
        &mut self,
        store: &dyn CounterStore,
        frame: &[u8],
    ) -> Result<(FrameHeader, DevicePayload)> {
        let parsed = parse_frame(frame)?;
        if parsed.header.recipient != self.self_id {
            return Err(ProtocolError::WrongRecipient);
        }
        if parsed.header.sender != self.peer_id {
            return Err(ProtocolError::WrongSender);
        }
        if !self.guard.would_accept(parsed.header.counter) {
            return Err(ProtocolError::Replay {
                counter: parsed.header.counter,
                last: self.guard.last_accepted(),
            });
        }
        let key = match self.role {
            PairRole::Phone => &self.keys.c2p,
            PairRole::Computer => &self.keys.p2c,
        };
        let (header, plaintext) = open_frame(key, frame, &self.self_id, Some(&self.peer_id))?;
        self.guard.accept(store, header.counter)?;
        let incoming = match self.role {
            PairRole::Phone => Direction::ComputerToPhone,
            PairRole::Computer => Direction::PhoneToComputer,
        };
        if direction_of(header.frame_type) != Some(incoming) {
            return Err(ProtocolError::BadPayload(
                "frame type not allowed in this direction".into(),
            ));
        }
        let payload = DevicePayload::decode(header.frame_type, &plaintext)?;
        Ok((header, payload))
    }
}
