//! The computer's connection to its room (DESK-60..64). One background task owns the socket;
//! [`RelayClient`] sends it commands and [`RelayEvent`]s come back on a channel.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use log::{debug, info, warn};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::time::{sleep_until, timeout, Instant};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode as WsCloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use wt_protocol::consts::{close_code, PING_MESSAGE, PONG_MESSAGE};
use wt_protocol::{
    compute_room_id, derive_pair_keys, encode_pairing_url, parse_frame, room_socket_url, sha256,
    verify_join_mac, AckOp, AgreementKeyPair, ChallengeLabel, ControlMessage, DeviceId, DeviceKeys,
    DevicePayload, Digest32, Intent, MemberInfo, PairChannel, PairContext, PairRole,
    PairingPayload, ResultOutcome, Role, RoomId, Salt, Secret32, SessionId, SigningKeyPair, Spki,
};
use zeroize::Zeroizing;

use crate::config::ClientConfig;
use crate::error::{ClientError, StoreError};
use crate::events::{PairingTicket, PhoneSummary, QueryId, RejectReason, RelayEvent, Status};
use crate::sessions::{EndOutcome, SessionTracker, StartOutcome};
use crate::store::{KeyStore, StoreCounters, StoredDeviceKeys, StoredPhone, StoredRoom};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;
type Sink = SplitSink<Ws, Message>;
type Stream = SplitStream<Ws>;
type Reply<T> = oneshot::Sender<Result<T, ClientError>>;

enum Command {
    StartPairing(Reply<PairingTicket>),
    CancelPairing(Reply<()>),
    Revoke(DeviceId, Reply<()>),
    DeleteRoom(Reply<()>),
    SendResult(DeviceId, SessionId, ResultOutcome, Reply<()>),
    AnswerPresence(QueryId, u32, bool, Reply<()>),
    Status(oneshot::Sender<Status>),
    ReconnectNow,
    Shutdown(oneshot::Sender<()>),
}

/// Handle to the background task. Cheap to clone.
#[derive(Clone)]
pub struct RelayClient {
    tx: mpsc::UnboundedSender<Command>,
    device_id: DeviceId,
}

impl std::fmt::Debug for RelayClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "RelayClient({})", self.device_id)
    }
}

impl RelayClient {
    /// Loads (or creates and persists) the device keys, checks the relay URL (SEC-06) and starts
    /// the connection task on the current Tokio runtime.
    pub fn start(
        config: ClientConfig,
        store: Arc<dyn KeyStore>,
    ) -> Result<(RelayClient, mpsc::UnboundedReceiver<RelayEvent>), ClientError> {
        config.validate()?;
        let keys = load_or_create_keys(store.as_ref())?;
        let device_id = keys.device_id();
        let (tx, cmds) = mpsc::unbounded_channel();
        let (events_tx, events) = mpsc::unbounded_channel();
        let mut actor = Actor::new(config, store, keys, events_tx)?;
        tokio::spawn(async move { actor.run(cmds).await });
        Ok((RelayClient { tx, device_id }, events))
    }

    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    async fn call<T>(&self, make: impl FnOnce(Reply<T>) -> Command) -> Result<T, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.tx.send(make(tx)).map_err(|_| ClientError::Shutdown)?;
        rx.await.map_err(|_| ClientError::Shutdown)?
    }

    /// Registers a new pairing code at the relay and returns the QR URL (spec 5.3). Any earlier
    /// code is cancelled. Needs a connection.
    pub async fn start_pairing(&self) -> Result<PairingTicket, ClientError> {
        self.call(Command::StartPairing).await
    }

    /// The pairing window was closed: cancel the code (`cancel_admission`) and forget `s`.
    pub async fn cancel_pairing(&self) -> Result<(), ClientError> {
        self.call(Command::CancelPairing).await
    }

    /// Removes a phone: its keys are deleted here at once (SEC-04) and the relay is told
    /// (now, or on the next connection).
    pub async fn revoke_phone(&self, phone: DeviceId) -> Result<(), ClientError> {
        self.call(|r| Command::Revoke(phone, r)).await
    }

    /// Deletes the room at the relay and every phone here. The next connection creates a new room.
    pub async fn delete_room(&self) -> Result<(), ClientError> {
        self.call(Command::DeleteRoom).await
    }

    /// DESK-64: ok or a reason, never text. Queued while offline.
    pub async fn send_result(
        &self,
        phone: DeviceId,
        session: SessionId,
        outcome: ResultOutcome,
    ) -> Result<(), ClientError> {
        self.call(|r| Command::SendResult(phone, session, outcome, r))
            .await
    }

    /// DESK-63: answers one presence_query; refused if there is no such pending query.
    pub async fn answer_presence(
        &self,
        query: QueryId,
        seconds_since_input: u32,
        locked: bool,
    ) -> Result<(), ClientError> {
        self.call(|r| Command::AnswerPresence(query, seconds_since_input, locked, r))
            .await
    }

    pub async fn status(&self) -> Result<Status, ClientError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Status(tx))
            .map_err(|_| ClientError::Shutdown)?;
        rx.await.map_err(|_| ClientError::Shutdown)
    }

    /// DESK-60: reconnect now (after sleep or a network change), skipping any backoff.
    pub fn reconnect_now(&self) {
        let _ = self.tx.send(Command::ReconnectNow);
    }

    /// Closes the socket and ends the task.
    pub async fn shutdown(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Command::Shutdown(tx)).is_ok() {
            let _ = rx.await;
        }
    }
}

fn load_or_create_keys(store: &dyn KeyStore) -> Result<DeviceKeys, ClientError> {
    if let Some(k) = store.load_device_keys()? {
        return Ok(DeviceKeys {
            signing: SigningKeyPair::from_scalar_bytes(k.signing_scalar.as_ref())?,
            agreement: AgreementKeyPair::from_scalar_bytes(k.agreement_scalar.as_ref())?,
        });
    }
    let keys = DeviceKeys::generate()?;
    store.save_device_keys(&StoredDeviceKeys {
        signing_scalar: keys.signing.to_scalar_bytes(),
        agreement_scalar: keys.agreement.to_scalar_bytes(),
    })?;
    Ok(keys)
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct PhoneState {
    stored: StoredPhone,
    channel: PairChannel,
}

struct PendingPairing {
    secret: Secret32,
    hash: Digest32,
    expires: Instant,
}

enum AckWaiter {
    Pairing {
        secret: Secret32,
        hash: Digest32,
        url: String,
        expires_at: SystemTime,
        reply: Reply<PairingTicket>,
    },
    Cancel {
        hash: Digest32,
        reply: Option<Reply<()>>,
    },
    Revoke {
        id: DeviceId,
        reply: Option<Reply<()>>,
    },
}

struct PendingAck {
    waiter: AckWaiter,
    deadline: Instant,
}

/// How a connection ended.
enum End {
    Shutdown,
    Retry {
        immediate: bool,
        authed: bool,
        reason: String,
    },
}

struct Actor {
    cfg: ClientConfig,
    store: Arc<dyn KeyStore>,
    keys: DeviceKeys,
    events: mpsc::UnboundedSender<RelayEvent>,
    phones: HashMap<DeviceId, PhoneState>,
    sessions: SessionTracker,
    pairings: Vec<PendingPairing>,
    name_waits: HashMap<DeviceId, Instant>,
    queries: HashMap<u64, (DeviceId, Instant)>,
    next_query: u64,
    acks: Vec<PendingAck>,
    outbox: VecDeque<(DeviceId, DevicePayload)>,
    pending_revokes: Vec<DeviceId>,
    online: HashMap<DeviceId, bool>,
    members: Vec<MemberInfo>,
    reconcile_at: Option<Instant>,
    delete_requested: Option<Reply<()>>,
    connected: bool,
    room_id: Option<RoomId>,
}

impl Actor {
    fn new(
        cfg: ClientConfig,
        store: Arc<dyn KeyStore>,
        keys: DeviceKeys,
        events: mpsc::UnboundedSender<RelayEvent>,
    ) -> Result<Self, ClientError> {
        let mut actor = Actor {
            cfg,
            store,
            keys,
            events,
            phones: HashMap::new(),
            sessions: SessionTracker::new(),
            pairings: Vec::new(),
            name_waits: HashMap::new(),
            queries: HashMap::new(),
            next_query: 1,
            acks: Vec::new(),
            outbox: VecDeque::new(),
            pending_revokes: Vec::new(),
            online: HashMap::new(),
            members: Vec::new(),
            reconcile_at: None,
            delete_requested: None,
            connected: false,
            room_id: None,
        };
        for p in actor.store.load_phones()? {
            actor.add_phone(p)?;
        }
        actor.room_id = actor.store.load_room()?.map(|r| r.room_id);
        Ok(actor)
    }

    fn emit(&self, e: RelayEvent) {
        let _ = self.events.send(e);
    }

    fn add_phone(&mut self, stored: StoredPhone) -> Result<(), ClientError> {
        let channel = PairChannel::new(
            PairRole::Computer,
            self.keys.device_id(),
            stored.id,
            stored.pair_keys(),
            &StoreCounters(self.store.as_ref()),
        )?;
        self.phones
            .insert(stored.id, PhoneState { stored, channel });
        Ok(())
    }

    /// Deletes a phone's keys and counters here (SEC-04).
    fn forget_phone(&mut self, id: &DeviceId) {
        self.phones.remove(id);
        self.name_waits.remove(id);
        self.online.remove(id);
        self.sessions.forget_phone(id);
        self.outbox.retain(|(p, _)| p != id);
        if let Err(e) = self
            .store
            .delete_phone(id)
            .and_then(|_| self.store.delete_counters_for(id))
        {
            warn!("could not delete phone keys: {e}");
        }
    }

    fn forget_all_phones(&mut self) {
        let ids: Vec<DeviceId> = self.phones.keys().copied().collect();
        for id in ids {
            self.forget_phone(&id);
        }
        self.pending_revokes.clear();
    }

    // ------------------------------------------------------------ task loop

    async fn run(&mut self, mut cmds: mpsc::UnboundedReceiver<Command>) {
        let mut attempt = 0usize;
        loop {
            let end = self.connection(&mut cmds).await;
            self.connected = false;
            self.fail_acks(ClientError::NotConnected);
            let reason = match end {
                End::Shutdown => return,
                End::Retry {
                    immediate,
                    authed,
                    reason,
                } => {
                    if authed {
                        attempt = 0;
                    }
                    if immediate {
                        self.emit(RelayEvent::Disconnected {
                            reason,
                            retry_in: Some(Duration::ZERO),
                        });
                        continue;
                    }
                    reason
                }
            };
            let delay = self.cfg.backoff_for(attempt);
            attempt += 1;
            self.emit(RelayEvent::Disconnected {
                reason,
                retry_in: Some(delay),
            });
            let wake = Instant::now() + delay;
            loop {
                let next = self.next_timer().map_or(wake, |t| t.min(wake));
                tokio::select! {
                    _ = sleep_until(next) => {
                        self.fire_timers(None).await;
                        if Instant::now() >= wake { break; }
                    }
                    cmd = cmds.recv() => match cmd {
                        None => return,
                        Some(Command::Shutdown(tx)) => { let _ = tx.send(()); return; }
                        Some(Command::ReconnectNow) => { attempt = 0; break; }
                        Some(c) => self.offline_command(c),
                    }
                }
            }
        }
    }

    fn fail_acks(&mut self, err: ClientError) {
        for a in self.acks.drain(..) {
            match a.waiter {
                AckWaiter::Pairing { reply, .. } => {
                    let _ = reply.send(Err(err.clone()));
                }
                AckWaiter::Cancel { reply: Some(r), .. }
                | AckWaiter::Revoke { reply: Some(r), .. } => {
                    let _ = r.send(Err(err.clone()));
                }
                _ => {}
            }
        }
        if let Some(r) = self.delete_requested.take() {
            let _ = r.send(Err(err));
        }
    }

    fn status(&self) -> Status {
        Status {
            connected: self.connected,
            device_id: self.keys.device_id(),
            room_id: self.room_id,
            phones: self
                .phones
                .values()
                .map(|p| {
                    let online = *self.online.get(&p.stored.id).unwrap_or(&false);
                    let reported = self
                        .members
                        .iter()
                        .find(|m| m.id == p.stored.id)
                        .map(|m| m.last_seen_day);
                    PhoneSummary {
                        id: p.stored.id,
                        name: p.stored.name.clone(),
                        platform: p.stored.platform.clone(),
                        online,
                        last_seen_day: last_seen_day(online, reported, today()),
                    }
                })
                .collect(),
            pairing_active: !self.pairings.is_empty(),
        }
    }

    fn offline_command(&mut self, cmd: Command) {
        match cmd {
            Command::StartPairing(r) => {
                let _ = r.send(Err(ClientError::NotConnected));
            }
            Command::CancelPairing(r) => {
                // The relay deletes the admission at its expiry anyway; forget s now.
                self.pairings.clear();
                let _ = r.send(Ok(()));
            }
            Command::Revoke(id, r) => {
                if !self.phones.contains_key(&id) {
                    let _ = r.send(Err(ClientError::UnknownPhone));
                    return;
                }
                self.forget_phone(&id);
                self.pending_revokes.push(id);
                self.emit(RelayEvent::PhoneRemoved { phone: id });
                let _ = r.send(Ok(()));
            }
            Command::DeleteRoom(r) => {
                let _ = r.send(Err(ClientError::NotConnected));
            }
            Command::SendResult(phone, session, outcome, r) => {
                let res = self.queue_result(phone, session, outcome);
                let _ = r.send(res);
            }
            Command::AnswerPresence(q, _, _, r) => {
                // A late answer is useless to the phone (it waits 1 s); drop it.
                self.queries.remove(&q.0);
                let _ = r.send(Err(ClientError::NotConnected));
            }
            Command::Status(r) => {
                let _ = r.send(self.status());
            }
            Command::ReconnectNow | Command::Shutdown(_) => {}
        }
    }

    fn queue_result(
        &mut self,
        phone: DeviceId,
        session: SessionId,
        outcome: ResultOutcome,
    ) -> Result<(), ClientError> {
        if !self.phones.contains_key(&phone) {
            return Err(ClientError::UnknownPhone);
        }
        self.sessions
            .complete(phone, session, outcome, std::time::Instant::now());
        self.outbox.push_back((
            phone,
            DevicePayload::Result {
                session_id: session,
                outcome,
            },
        ));
        while self.outbox.len() > 64 {
            self.outbox.pop_front();
        }
        Ok(())
    }

    // ------------------------------------------------------------ timers

    fn next_timer(&self) -> Option<Instant> {
        let mut t: Option<Instant> = None;
        let mut take = |x: Instant| t = Some(t.map_or(x, |y| y.min(x)));
        for p in &self.pairings {
            take(p.expires);
        }
        for d in self.name_waits.values() {
            take(*d);
        }
        for a in &self.acks {
            take(a.deadline);
        }
        if let Some(r) = self.reconcile_at {
            take(r);
        }
        t
    }

    async fn fire_timers(&mut self, sink: Option<&mut Sink>) {
        let now = Instant::now();
        let expired: Vec<Digest32> = self
            .pairings
            .iter()
            .filter(|p| p.expires <= now)
            .map(|p| p.hash)
            .collect();
        self.pairings.retain(|p| p.expires > now);
        for h in expired {
            self.emit(RelayEvent::PairingExpired { admission_hash: h });
        }
        let due: Vec<DeviceId> = self
            .name_waits
            .iter()
            .filter(|(_, d)| **d <= now)
            .map(|(id, _)| *id)
            .collect();
        for id in due {
            self.name_waits.remove(&id);
            self.emit(RelayEvent::PhonePaired {
                phone: id,
                name: None,
                platform: None,
            });
        }
        let mut i = 0;
        while i < self.acks.len() {
            if self.acks[i].deadline <= now {
                match self.acks.remove(i).waiter {
                    AckWaiter::Pairing { reply, .. } => {
                        let _ = reply.send(Err(ClientError::Timeout));
                    }
                    AckWaiter::Cancel { reply: Some(r), .. }
                    | AckWaiter::Revoke { reply: Some(r), .. } => {
                        let _ = r.send(Err(ClientError::Timeout));
                    }
                    _ => {}
                }
            } else {
                i += 1;
            }
        }
        self.queries
            .retain(|_, (_, t)| now.duration_since(*t) < Duration::from_secs(30));
        if let (Some(at), Some(sink)) = (self.reconcile_at, sink) {
            if at <= now {
                self.reconcile_at = None;
                self.reconcile(sink).await;
            }
        }
    }

    /// Phones the relay lists as members but which have no keys here are useless and are
    /// revoked (a lost revoke, or a join this computer never verified).
    async fn reconcile(&mut self, sink: &mut Sink) {
        let strays: Vec<DeviceId> = self
            .members
            .iter()
            .filter(|m| {
                m.role == Role::Phone
                    && !self.phones.contains_key(&m.id)
                    && !self.name_waits.contains_key(&m.id)
            })
            .map(|m| m.id)
            .collect();
        for id in strays {
            info!("revoking a phone without keys");
            let _ = send_control(sink, &ControlMessage::Revoke { id }).await;
        }
    }

    // ------------------------------------------------------------ one connection

    /// The room to use and how to enter it: create (first time or not confirmed) or auth.
    fn room_for_connect(&mut self) -> Result<(StoredRoom, Intent), ClientError> {
        if let Some(mut room) = self.store.load_room()? {
            if self.cfg.is_same_relay(&room.relay_url) {
                if room.relay_url != self.cfg.relay_url {
                    // The same relay under a new address (v1's workers.dev host before
                    // relay.walkietalkey.com): the room and its phones stay (RELAY-01).
                    info!("the relay has a new address; keeping the room");
                    room.relay_url = self.cfg.relay_url.clone();
                    if let Err(e) = self.store.save_room(&room) {
                        warn!("could not save the room's new address: {e}");
                    }
                }
                let intent = if room.created {
                    Intent::Auth
                } else {
                    Intent::Create
                };
                return Ok((room, intent));
            }
            // A different relay (managed setting changed): a new room there.
            self.forget_all_phones();
        }
        let salt = Salt::random()?;
        let room = StoredRoom {
            relay_url: self.cfg.relay_url.clone(),
            room_id: compute_room_id(self.keys.signing.spki(), &salt),
            salt,
            created: false,
        };
        // Persist before create so a lost `ok` can be recovered (4409 then auth).
        self.store.save_room(&room)?;
        self.room_id = Some(room.room_id);
        Ok((room, Intent::Create))
    }

    async fn connection(&mut self, cmds: &mut mpsc::UnboundedReceiver<Command>) -> End {
        let retry = |reason: String| End::Retry {
            immediate: false,
            authed: false,
            reason,
        };
        let (mut room, intent) = match self.room_for_connect() {
            Ok(x) => x,
            Err(e) => return retry(e.to_string()),
        };
        let url = room_socket_url(&self.cfg.relay_url, &room.room_id, intent);
        let ws = match timeout(self.cfg.connect_timeout, connect_async(url.as_str())).await {
            Ok(Ok((ws, _))) => ws,
            Ok(Err(e)) => return retry(format!("connect: {e}")),
            Err(_) => return retry("connect: timed out".into()),
        };
        let (mut sink, mut stream) = ws.split();

        // Challenge, then create or auth, then ok.
        let challenge = match wait_control(&mut stream, self.cfg.connect_timeout).await {
            Ok(ControlMessage::Challenge { n }) => n,
            Ok(other) => return retry(format!("expected challenge, got {}", other.type_name())),
            Err(Closed(code)) => return self.handshake_closed(&mut room, intent, code),
        };
        let hello = match intent {
            Intent::Create => ControlMessage::Create {
                pub_key: self.keys.signing.spki().clone(),
                salt: room.salt,
                sig: self.keys.signing.sign_challenge(
                    ChallengeLabel::Create,
                    &room.room_id,
                    &challenge,
                ),
            },
            _ => ControlMessage::Auth {
                id: self.keys.device_id(),
                sig: self.keys.signing.sign_challenge(
                    ChallengeLabel::Auth,
                    &room.room_id,
                    &challenge,
                ),
            },
        };
        if send_control(&mut sink, &hello).await.is_err() {
            return retry("send failed".into());
        }
        let members = loop {
            match wait_control(&mut stream, self.cfg.connect_timeout).await {
                Ok(ControlMessage::Ok { members, .. }) => break members,
                Ok(ControlMessage::Error { code, msg }) => {
                    debug!("relay error during handshake: {code} {msg}")
                }
                Ok(_) => {}
                Err(Closed(code)) => return self.handshake_closed(&mut room, intent, code),
            }
        };
        if intent == Intent::Create {
            room.created = true;
            if let Err(e) = self.store.save_room(&room) {
                warn!("could not save room: {e}");
            }
            self.emit(RelayEvent::RoomCreated {
                room_id: room.room_id,
            });
        }
        self.connected = true;
        self.room_id = Some(room.room_id);
        self.online = members
            .iter()
            .filter(|m| m.role == Role::Phone)
            .map(|m| (m.id, m.online))
            .collect();
        self.members = members.clone();
        self.reconcile_at = Some(Instant::now() + self.cfg.reconcile_delay);
        info!("connected to the relay");
        self.emit(RelayEvent::Connected {
            room_id: room.room_id,
            members,
        });

        for id in std::mem::take(&mut self.pending_revokes) {
            let _ = send_control(&mut sink, &ControlMessage::Revoke { id }).await;
        }
        while let Some((phone, payload)) = self.outbox.pop_front() {
            if self.send_payload(&mut sink, phone, &payload).await.is_err() {
                self.outbox.push_front((phone, payload));
                return End::Retry {
                    immediate: false,
                    authed: true,
                    reason: "send failed".into(),
                };
            }
        }

        let mut ping = tokio::time::interval_at(
            Instant::now() + self.cfg.ping_interval,
            self.cfg.ping_interval,
        );
        let mut pong_deadline: Option<Instant> = None;
        loop {
            let mut next = self.next_timer();
            if let Some(p) = pong_deadline {
                next = Some(next.map_or(p, |t| t.min(p)));
            }
            let next = next.unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
            tokio::select! {
                msg = stream.next() => {
                    let msg = match msg {
                        Some(Ok(m)) => m,
                        Some(Err(e)) => return End::Retry { immediate: false, authed: true, reason: format!("socket: {e}") },
                        None => return End::Retry { immediate: false, authed: true, reason: "socket closed".into() },
                    };
                    match msg {
                        Message::Text(t) => {
                            if t.as_str() == PONG_MESSAGE {
                                pong_deadline = None;
                            } else {
                                self.on_control(&mut sink, t.as_str()).await;
                            }
                        }
                        Message::Binary(b) => self.on_frame(&mut sink, &b).await,
                        Message::Close(frame) => {
                            let code = frame.map(|f| u16::from(f.code)).unwrap_or(1006);
                            return self.closed_while_connected(&room, code);
                        }
                        _ => {}
                    }
                }
                cmd = cmds.recv() => match cmd {
                    None => { let _ = sink.close().await; return End::Shutdown; }
                    Some(Command::Shutdown(tx)) => {
                        close_normal(&mut sink).await;
                        let _ = tx.send(());
                        return End::Shutdown;
                    }
                    Some(Command::ReconnectNow) => {
                        close_normal(&mut sink).await;
                        return End::Retry { immediate: true, authed: true, reason: "reconnect requested".into() };
                    }
                    Some(c) => self.online_command(&mut sink, c).await,
                },
                _ = ping.tick() => {
                    if sink.send(Message::Text(PING_MESSAGE.into())).await.is_err() {
                        return End::Retry { immediate: false, authed: true, reason: "ping failed".into() };
                    }
                    if pong_deadline.is_none() {
                        pong_deadline = Some(Instant::now() + self.cfg.pong_timeout);
                    }
                }
                _ = sleep_until(next) => {
                    if pong_deadline.is_some_and(|p| p <= Instant::now()) {
                        return End::Retry { immediate: false, authed: true, reason: "no pong".into() };
                    }
                    self.fire_timers(Some(&mut sink)).await;
                }
            }
        }
    }

    fn handshake_closed(&mut self, room: &mut StoredRoom, intent: Intent, code: u16) -> End {
        match (intent, code) {
            (Intent::Create, close_code::ROOM_EXISTS) => {
                // Our create went through earlier but its ok was lost; authenticate instead.
                room.created = true;
                if let Err(e) = self.store.save_room(room) {
                    warn!("could not save room: {e}");
                }
                End::Retry {
                    immediate: true,
                    authed: false,
                    reason: "room exists, authenticating".into(),
                }
            }
            (Intent::Auth, close_code::ROOM_NOT_FOUND | close_code::NOT_AUTHORISED) => {
                self.reset_room(room.room_id, code);
                End::Retry {
                    immediate: true,
                    authed: false,
                    reason: format!("room gone ({code}), creating a new one"),
                }
            }
            _ => End::Retry {
                immediate: false,
                authed: false,
                reason: format!("closed during handshake ({code})"),
            },
        }
    }

    /// Spec 5.4: the relay deleted the room; phones must pair again.
    fn reset_room(&mut self, old: RoomId, code: u16) {
        warn!("the relay no longer knows this room ({code}); creating a new one");
        self.forget_all_phones();
        if let Err(e) = self.store.delete_room() {
            warn!("could not delete room: {e}");
        }
        self.room_id = None;
        self.emit(RelayEvent::RoomReset {
            old_room_id: old,
            code,
        });
    }

    fn closed_while_connected(&mut self, room: &StoredRoom, code: u16) -> End {
        if let Some(reply) = self.delete_requested.take() {
            self.forget_all_phones();
            let _ = self.store.delete_room();
            self.room_id = None;
            self.pairings.clear();
            self.emit(RelayEvent::RoomDeleted);
            let _ = reply.send(Ok(()));
            return End::Retry {
                immediate: true,
                authed: true,
                reason: "room deleted".into(),
            };
        }
        if code == close_code::ROOM_NOT_FOUND {
            self.reset_room(room.room_id, code);
            return End::Retry {
                immediate: true,
                authed: true,
                reason: "room deleted by the relay".into(),
            };
        }
        End::Retry {
            immediate: false,
            authed: true,
            reason: format!("closed by the relay ({code})"),
        }
    }

    // ------------------------------------------------------------ commands while connected

    async fn online_command(&mut self, sink: &mut Sink, cmd: Command) {
        let deadline = Instant::now() + self.cfg.ack_timeout;
        match cmd {
            Command::StartPairing(reply) => {
                // One code at a time: closing or reopening the window cancels the old one.
                for p in std::mem::take(&mut self.pairings) {
                    let _ =
                        send_control(sink, &ControlMessage::CancelAdmission { h: p.hash }).await;
                }
                let (Some(room_id), Ok(a), Ok(s)) =
                    (self.room_id, Secret32::random(), Secret32::random())
                else {
                    let _ = reply.send(Err(ClientError::NotConnected));
                    return;
                };
                let hash = Digest32(sha256(a.as_bytes()));
                let expires_at = SystemTime::now() + self.cfg.pairing_ttl;
                let exp = unix_ms() + self.cfg.pairing_ttl.as_millis() as u64;
                let payload = PairingPayload {
                    room_id,
                    admission: a,
                    secret: s.clone(),
                    computer_agreement: self.keys.agreement.spki().clone(),
                    relay_url: self.cfg.relay_url.clone(),
                    computer_name: self.cfg.computer_name.clone(),
                    os: self.cfg.os,
                };
                let url = match encode_pairing_url(&self.cfg.phone_app_url, &payload) {
                    Ok(u) => u,
                    Err(e) => {
                        let _ = reply.send(Err(e.into()));
                        return;
                    }
                };
                if send_control(sink, &ControlMessage::AddAdmission { h: hash, exp })
                    .await
                    .is_err()
                {
                    let _ = reply.send(Err(ClientError::NotConnected));
                    return;
                }
                self.acks.push(PendingAck {
                    waiter: AckWaiter::Pairing {
                        secret: s,
                        hash,
                        url,
                        expires_at,
                        reply,
                    },
                    deadline,
                });
            }
            Command::CancelPairing(reply) => {
                let pending = std::mem::take(&mut self.pairings);
                if pending.is_empty() {
                    let _ = reply.send(Ok(()));
                    return;
                }
                let mut reply = Some(reply);
                for p in pending {
                    let _ =
                        send_control(sink, &ControlMessage::CancelAdmission { h: p.hash }).await;
                    self.acks.push(PendingAck {
                        waiter: AckWaiter::Cancel {
                            hash: p.hash,
                            reply: reply.take(),
                        },
                        deadline,
                    });
                }
            }
            Command::Revoke(id, reply) => {
                if !self.phones.contains_key(&id) && !self.members.iter().any(|m| m.id == id) {
                    let _ = reply.send(Err(ClientError::UnknownPhone));
                    return;
                }
                self.forget_phone(&id);
                if send_control(sink, &ControlMessage::Revoke { id })
                    .await
                    .is_err()
                {
                    self.pending_revokes.push(id);
                    self.emit(RelayEvent::PhoneRemoved { phone: id });
                    let _ = reply.send(Ok(()));
                    return;
                }
                self.acks.push(PendingAck {
                    waiter: AckWaiter::Revoke {
                        id,
                        reply: Some(reply),
                    },
                    deadline,
                });
            }
            Command::DeleteRoom(reply) => {
                if send_control(sink, &ControlMessage::DeleteRoom)
                    .await
                    .is_err()
                {
                    let _ = reply.send(Err(ClientError::NotConnected));
                    return;
                }
                self.delete_requested = Some(reply);
            }
            Command::SendResult(phone, session, outcome, reply) => {
                if !self.phones.contains_key(&phone) {
                    let _ = reply.send(Err(ClientError::UnknownPhone));
                    return;
                }
                self.sessions
                    .complete(phone, session, outcome, std::time::Instant::now());
                let payload = DevicePayload::Result {
                    session_id: session,
                    outcome,
                };
                let res = match self.send_payload(sink, phone, &payload).await {
                    Ok(()) => Ok(()),
                    Err(ClientError::NotConnected) => {
                        self.outbox.push_back((phone, payload));
                        Ok(())
                    }
                    Err(e) => Err(e),
                };
                let _ = reply.send(res);
            }
            Command::AnswerPresence(q, seconds, locked, reply) => {
                let Some((phone, _)) = self.queries.remove(&q.0) else {
                    let _ = reply.send(Err(ClientError::NoPendingQuery));
                    return;
                };
                let payload = DevicePayload::Presence {
                    seconds_since_input: seconds,
                    locked,
                };
                let _ = reply.send(self.send_payload(sink, phone, &payload).await);
            }
            Command::Status(r) => {
                let _ = r.send(self.status());
            }
            Command::ReconnectNow | Command::Shutdown(_) => {}
        }
    }

    async fn send_payload(
        &mut self,
        sink: &mut Sink,
        phone: DeviceId,
        payload: &DevicePayload,
    ) -> Result<(), ClientError> {
        let state = self
            .phones
            .get_mut(&phone)
            .ok_or(ClientError::UnknownPhone)?;
        // Re-encrypted with a fresh counter every time, never a replay of an old frame.
        let frame = state
            .channel
            .seal(&StoreCounters(self.store.as_ref()), payload)?;
        sink.send(Message::Binary(frame.into()))
            .await
            .map_err(|_| ClientError::NotConnected)
    }

    // ------------------------------------------------------------ incoming control messages

    async fn on_control(&mut self, sink: &mut Sink, text: &str) {
        let msg = match ControlMessage::parse(text) {
            Ok(m) => m,
            Err(e) => {
                debug!("ignoring control message: {e}");
                return;
            }
        };
        match msg {
            ControlMessage::MemberJoined {
                id,
                pub_key,
                agree,
                mac,
                eid,
            } => {
                self.on_member_joined(sink, id, pub_key, agree, mac.as_bytes())
                    .await;
                let _ = send_control(sink, &ControlMessage::EventAck { eid }).await;
            }
            ControlMessage::MemberLeft { id, eid } => {
                if self.phones.contains_key(&id) {
                    self.forget_phone(&id);
                    self.emit(RelayEvent::PhoneLeft { phone: id });
                }
                self.members.retain(|m| m.id != id);
                let _ = send_control(sink, &ControlMessage::EventAck { eid }).await;
            }
            ControlMessage::Peer { id, online } => {
                if self.phones.contains_key(&id) {
                    if !online {
                        // Last seen is the moment it went offline.
                        if let Some(m) = self.members.iter_mut().find(|m| m.id == id) {
                            m.last_seen_day = today();
                        }
                    }
                    self.online.insert(id, online);
                    self.emit(RelayEvent::PeerStatus { phone: id, online });
                }
            }
            ControlMessage::Ack { op, h, id } => self.on_ack(op, h, id),
            ControlMessage::Error { code, msg } => {
                warn!("relay error: {code}");
                self.emit(RelayEvent::RelayError { code, message: msg });
            }
            ControlMessage::Pong => {}
            other => debug!("unexpected control message {}", other.type_name()),
        }
    }

    fn on_ack(&mut self, op: AckOp, h: Option<Digest32>, id: Option<DeviceId>) {
        let pos = self.acks.iter().position(|a| match (&a.waiter, op) {
            (AckWaiter::Pairing { hash, .. }, AckOp::AddAdmission) => Some(*hash) == h,
            (AckWaiter::Cancel { hash, .. }, AckOp::CancelAdmission) => Some(*hash) == h,
            (AckWaiter::Revoke { id: rid, .. }, AckOp::Revoke) => Some(*rid) == id,
            _ => false,
        });
        let Some(pos) = pos else { return };
        match self.acks.remove(pos).waiter {
            AckWaiter::Pairing {
                secret,
                hash,
                url,
                expires_at,
                reply,
            } => {
                self.pairings.push(PendingPairing {
                    secret,
                    hash,
                    expires: Instant::now() + self.cfg.pairing_ttl,
                });
                let _ = reply.send(Ok(PairingTicket {
                    url,
                    admission_hash: hash,
                    expires_at,
                }));
            }
            AckWaiter::Cancel { reply, .. } => {
                if let Some(r) = reply {
                    let _ = r.send(Ok(()));
                }
            }
            AckWaiter::Revoke { id, reply } => {
                self.members.retain(|m| m.id != id);
                self.emit(RelayEvent::PhoneRemoved { phone: id });
                if let Some(r) = reply {
                    let _ = r.send(Ok(()));
                }
            }
        }
    }

    /// Spec 5.3 step 6: verify the MAC with s, derive and store the pair keys, forget s.
    async fn on_member_joined(
        &mut self,
        sink: &mut Sink,
        id: DeviceId,
        pub_key: Spki,
        agree: Spki,
        mac: &[u8],
    ) {
        let Some(room_id) = self.room_id else { return };
        if pub_key.device_id() != id {
            warn!("member_joined with an id that does not match its key");
            return;
        }
        // A pairing code this join answers comes first: a phone that is paired
        // already may pair again with the same device keys, and then has new
        // pair keys and counters (SEC-01, spec 5.3 step 6).
        let found = self
            .pairings
            .iter()
            .position(|p| verify_join_mac(&p.secret, &room_id, &pub_key, &agree, mac));
        let Some(pos) = found else {
            if let Some(known) = self.phones.get(&id) {
                if known.stored.agreement_spki == agree {
                    return; // the same event again (not acknowledged before a reconnect)
                }
            }
            let reason = if self.pairings.is_empty() {
                RejectReason::NoPairingInProgress
            } else {
                RejectReason::BadMac
            };
            if self.phones.contains_key(&id) {
                // A failed re-pair of a phone that is already paired: keep the existing pairing,
                // so a forged member_joined cannot unpair a phone.
                warn!("ignoring a re-pair whose join MAC does not verify");
                self.emit(RelayEvent::PhoneRejected { phone: id, reason });
                return;
            }
            warn!("refusing a phone whose join MAC does not verify");
            let _ = send_control(sink, &ControlMessage::Revoke { id }).await;
            self.emit(RelayEvent::PhoneRejected { phone: id, reason });
            return;
        };
        // Single use: s is forgotten now (SEC-02).
        let pairing = self.pairings.remove(pos);
        let computer_id = self.keys.device_id();
        let keys = derive_pair_keys(
            &self.keys.agreement,
            &agree,
            &PairContext {
                secret: &pairing.secret,
                room_id: &room_id,
                computer_id: &computer_id,
                phone_id: &id,
            },
        );
        drop(pairing);
        // New pair keys: counters for this pair start again (old frames cannot decrypt anyway).
        if let Err(e) = self.store.delete_counters_for(&id) {
            warn!("could not reset counters: {e}");
        }
        let stored = StoredPhone {
            id,
            signing_spki: pub_key,
            agreement_spki: agree,
            key_p2c: Zeroizing::new(*keys.p2c),
            key_c2p: Zeroizing::new(*keys.c2p),
            name: None,
            platform: None,
            paired_at: unix_ms(),
        };
        if let Err(e) = self.store.save_phone(&stored) {
            warn!("could not save the phone's keys: {e}");
            let _ = send_control(sink, &ControlMessage::Revoke { id }).await;
            return;
        }
        if let Err(e) = self.add_phone(stored) {
            warn!("could not open the pair channel: {e}");
            return;
        }
        if !self.members.iter().any(|m| m.id == id) {
            self.members.push(MemberInfo {
                id,
                role: Role::Phone,
                online: true,
                last_seen_day: 0,
            });
        }
        self.online.insert(id, true);
        self.name_waits
            .insert(id, Instant::now() + self.cfg.name_wait);
    }

    // ------------------------------------------------------------ incoming frames

    async fn on_frame(&mut self, sink: &mut Sink, bytes: &[u8]) {
        let header = match parse_frame(bytes) {
            Ok(p) => p.header,
            Err(e) => {
                debug!("dropping frame: {e}");
                return;
            }
        };
        if header.recipient != self.keys.device_id() {
            debug!("dropping a frame for someone else");
            return;
        }
        let phone = header.sender;
        let store = self.store.clone();
        let Some(state) = self.phones.get_mut(&phone) else {
            debug!("dropping a frame from an unknown sender");
            return;
        };
        let payload = match state.channel.open(&StoreCounters(store.as_ref()), bytes) {
            Ok((_, p)) => p,
            Err(e) => {
                debug!("dropping frame: {}", e.code());
                return;
            }
        };
        let now = std::time::Instant::now();
        match payload {
            DevicePayload::DeviceInfo { name, platform } => {
                state.stored.name = Some(name.clone());
                state.stored.platform = Some(platform.clone());
                if let Err(e) = store.save_phone(&state.stored) {
                    warn!("could not save the phone's name: {e}");
                }
                if self.name_waits.remove(&phone).is_some() {
                    self.emit(RelayEvent::PhonePaired {
                        phone,
                        name: Some(name),
                        platform: Some(platform),
                    });
                } else {
                    self.emit(RelayEvent::PhoneInfo {
                        phone,
                        name,
                        platform,
                    });
                }
            }
            DevicePayload::PresenceQuery => {
                let q = self.next_query;
                self.next_query += 1;
                self.queries.insert(q, (phone, Instant::now()));
                self.emit(RelayEvent::PresenceQuery {
                    phone,
                    query: QueryId(q),
                });
            }
            DevicePayload::AudioStart { session_id } => {
                match self.sessions.start(phone, session_id, now) {
                    StartOutcome::New => self.emit(RelayEvent::AudioStart {
                        phone,
                        session: session_id,
                        sample_rate: 16000,
                    }),
                    StartOutcome::Duplicate => {}
                    StartOutcome::Completed(_) => {}
                }
            }
            DevicePayload::AudioChunk {
                session_id,
                first_index,
                pcm,
            } => {
                let out = self
                    .sessions
                    .chunk(phone, session_id, first_index, &pcm, now);
                if out.implicit_start {
                    self.emit(RelayEvent::AudioStart {
                        phone,
                        session: session_id,
                        sample_rate: 16000,
                    });
                }
                for (index, pcm) in out.blocks {
                    self.emit(RelayEvent::AudioChunk {
                        phone,
                        session: session_id,
                        index,
                        pcm,
                    });
                }
            }
            DevicePayload::AudioEnd {
                session_id,
                chunks,
                duration_ms,
            } => {
                match self
                    .sessions
                    .end(phone, session_id, chunks, duration_ms, now)
                {
                    EndOutcome::Emit {
                        implicit_start,
                        missing,
                    } => {
                        if implicit_start {
                            self.emit(RelayEvent::AudioStart {
                                phone,
                                session: session_id,
                                sample_rate: 16000,
                            });
                        }
                        self.emit(RelayEvent::AudioEnd {
                            phone,
                            session: session_id,
                            chunks,
                            duration_ms,
                            missing,
                        });
                    }
                    EndOutcome::Unchanged => {}
                    EndOutcome::Completed(outcome) => {
                        // The phone missed our result (it resent the session): answer again.
                        let payload = DevicePayload::Result {
                            session_id,
                            outcome,
                        };
                        let _ = self.send_payload(sink, phone, &payload).await;
                    }
                }
            }
            DevicePayload::AudioCancel { session_id } => {
                if self.sessions.cancel(phone, session_id) {
                    self.emit(RelayEvent::AudioCancel {
                        phone,
                        session: session_id,
                    });
                }
            }
            DevicePayload::Presence { .. } | DevicePayload::Result { .. } => {}
        }
    }
}

struct Closed(u16);

async fn wait_control(stream: &mut Stream, limit: Duration) -> Result<ControlMessage, Closed> {
    let deadline = Instant::now() + limit;
    loop {
        let msg = match timeout(
            deadline.saturating_duration_since(Instant::now()),
            stream.next(),
        )
        .await
        {
            Err(_) => return Err(Closed(0)),
            Ok(None) | Ok(Some(Err(_))) => return Err(Closed(1006)),
            Ok(Some(Ok(m))) => m,
        };
        match msg {
            Message::Text(t) => {
                if let Ok(m) = ControlMessage::parse(t.as_str()) {
                    return Ok(m);
                }
            }
            Message::Close(f) => return Err(Closed(f.map(|f| u16::from(f.code)).unwrap_or(1005))),
            _ => {}
        }
    }
}

async fn send_control(sink: &mut Sink, msg: &ControlMessage) -> Result<(), ClientError> {
    sink.send(Message::Text(msg.to_json().into()))
        .await
        .map_err(|_| ClientError::NotConnected)
}

async fn close_normal(sink: &mut Sink) {
    let _ = sink
        .send(Message::Close(Some(CloseFrame {
            code: WsCloseCode::Normal,
            reason: "bye".into(),
        })))
        .await;
    let _ = sink.close().await;
}

#[allow(dead_code)]
/// Days since 1970-01-01 UTC, the unit of the relay's `lastSeenDay`.
fn today() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() / 86_400)
        .unwrap_or(0)
}

/// The day a phone was last seen: today while it is online, otherwise what
/// the relay reported, where `0` means never.
fn last_seen_day(online: bool, reported: Option<u64>, today: u64) -> Option<u64> {
    if online {
        Some(today)
    } else {
        reported.filter(|&day| day > 0)
    }
}

#[cfg(test)]
mod last_seen_tests {
    use super::last_seen_day;

    #[test]
    fn online_phones_are_seen_today_and_offline_ones_keep_the_relays_day() {
        assert_eq!(last_seen_day(true, Some(20_000), 20_384), Some(20_384));
        assert_eq!(last_seen_day(true, None, 20_384), Some(20_384));
        assert_eq!(last_seen_day(false, Some(20_380), 20_384), Some(20_380));
        assert_eq!(last_seen_day(false, Some(0), 20_384), None);
        assert_eq!(last_seen_day(false, None, 20_384), None);
    }
}

fn _assert_send() {
    fn is_send<T: Send>() {}
    is_send::<RelayClient>();
    let _ = StoreError::new("");
}
