//! Per-dictation bookkeeping on the computer (DESK-61): blocks are keyed by session id and
//! 200 ms block index, duplicates after a resend (PHONE-32) are dropped, missing blocks are
//! reported at `audio_end`, and a finished session is remembered so a late resend is answered
//! with the same result instead of being transcribed twice.

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use wt_protocol::consts::BLOCK_BYTES;
use wt_protocol::{DeviceId, ResultOutcome, SessionId};

/// Phones stop at 5 minutes (1,500 blocks); anything far beyond is refused.
pub const MAX_BLOCK_INDEX: u32 = 18_000;
/// Sessions without activity, and finished ones, are forgotten after this.
pub const SESSION_TTL: Duration = Duration::from_secs(15 * 60);

type Key = (DeviceId, SessionId);

#[derive(Debug, Default)]
struct Session {
    received: BTreeSet<u32>,
    end: Option<(u32, u32)>,
    last_missing: Option<Vec<u32>>,
    touched: Option<Instant>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartOutcome {
    New,
    /// audio_start again (a resend); nothing to announce.
    Duplicate,
    /// The session already has a result.
    Completed(ResultOutcome),
}

#[derive(Debug, PartialEq, Eq)]
pub struct ChunkOutcome {
    /// True when no audio_start was seen for this session (it was lost); announce a start.
    pub implicit_start: bool,
    /// New blocks only, in index order.
    pub blocks: Vec<(u32, Vec<u8>)>,
    /// The session already has a result; the audio is dropped.
    pub completed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EndOutcome {
    /// Announce the end with these missing block indices.
    Emit {
        implicit_start: bool,
        missing: Vec<u32>,
    },
    /// Same end as before, nothing new.
    Unchanged,
    /// Already answered; send this result again.
    Completed(ResultOutcome),
}

#[derive(Debug, Default)]
pub struct SessionTracker {
    sessions: HashMap<Key, Session>,
    completed: HashMap<Key, (ResultOutcome, Instant)>,
}

impl SessionTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn start(&mut self, phone: DeviceId, session: SessionId, now: Instant) -> StartOutcome {
        let key = (phone, session);
        if let Some((o, _)) = self.completed.get(&key) {
            return StartOutcome::Completed(*o);
        }
        self.prune(now);
        match self.sessions.get_mut(&key) {
            Some(s) => {
                s.touched = Some(now);
                StartOutcome::Duplicate
            }
            None => {
                self.sessions.insert(
                    key,
                    Session {
                        touched: Some(now),
                        ..Default::default()
                    },
                );
                StartOutcome::New
            }
        }
    }

    pub fn chunk(
        &mut self,
        phone: DeviceId,
        session: SessionId,
        first_index: u32,
        pcm: &[u8],
        now: Instant,
    ) -> ChunkOutcome {
        let key = (phone, session);
        if self.completed.contains_key(&key) {
            return ChunkOutcome {
                implicit_start: false,
                blocks: vec![],
                completed: true,
            };
        }
        let implicit_start = !self.sessions.contains_key(&key);
        let s = self.sessions.entry(key).or_default();
        s.touched = Some(now);
        let mut blocks = Vec::new();
        for (k, block) in pcm.chunks(BLOCK_BYTES).enumerate() {
            let Some(index) = first_index.checked_add(k as u32) else {
                break;
            };
            if index >= MAX_BLOCK_INDEX {
                break;
            }
            if s.received.insert(index) {
                blocks.push((index, block.to_vec()));
            }
        }
        ChunkOutcome {
            implicit_start,
            blocks,
            completed: false,
        }
    }

    pub fn end(
        &mut self,
        phone: DeviceId,
        session: SessionId,
        chunks: u32,
        duration_ms: u32,
        now: Instant,
    ) -> EndOutcome {
        let key = (phone, session);
        if let Some((o, _)) = self.completed.get(&key) {
            return EndOutcome::Completed(*o);
        }
        let implicit_start = !self.sessions.contains_key(&key);
        let s = self.sessions.entry(key).or_default();
        s.touched = Some(now);
        s.end = Some((chunks, duration_ms));
        let missing: Vec<u32> = (0..chunks.min(MAX_BLOCK_INDEX))
            .filter(|i| !s.received.contains(i))
            .collect();
        if s.last_missing.as_ref() == Some(&missing) {
            return EndOutcome::Unchanged;
        }
        s.last_missing = Some(missing.clone());
        EndOutcome::Emit {
            implicit_start,
            missing,
        }
    }

    /// Missing blocks of an ended session, if it has ended.
    pub fn missing(&self, phone: DeviceId, session: SessionId) -> Option<Vec<u32>> {
        let s = self.sessions.get(&(phone, session))?;
        let (chunks, _) = s.end?;
        Some(
            (0..chunks.min(MAX_BLOCK_INDEX))
                .filter(|i| !s.received.contains(i))
                .collect(),
        )
    }

    /// Returns true when the session was known (and is now dropped).
    pub fn cancel(&mut self, phone: DeviceId, session: SessionId) -> bool {
        self.sessions.remove(&(phone, session)).is_some()
    }

    /// The result was sent: remember it so a late resend gets the same answer.
    pub fn complete(
        &mut self,
        phone: DeviceId,
        session: SessionId,
        outcome: ResultOutcome,
        now: Instant,
    ) {
        self.sessions.remove(&(phone, session));
        self.completed.insert((phone, session), (outcome, now));
    }

    pub fn forget_phone(&mut self, phone: &DeviceId) {
        self.sessions.retain(|(p, _), _| p != phone);
        self.completed.retain(|(p, _), _| p != phone);
    }

    pub fn prune(&mut self, now: Instant) {
        self.sessions.retain(|_, s| {
            s.touched
                .is_none_or(|t| now.duration_since(t) < SESSION_TTL)
        });
        self.completed
            .retain(|_, (_, t)| now.duration_since(*t) < SESSION_TTL);
    }

    pub fn open_sessions(&self) -> usize {
        self.sessions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wt_protocol::ResultReason;

    fn ids() -> (DeviceId, SessionId) {
        (DeviceId([1; 16]), SessionId([2; 16]))
    }

    fn block(v: u8) -> Vec<u8> {
        vec![v; BLOCK_BYTES]
    }

    #[test]
    fn dedups_by_block_index_after_a_resend() {
        let (p, s) = ids();
        let now = Instant::now();
        let mut t = SessionTracker::new();
        assert_eq!(t.start(p, s, now), StartOutcome::New);
        for i in 0..5u32 {
            let out = t.chunk(p, s, i, &block(i as u8), now);
            assert_eq!(out.blocks.len(), 1);
        }
        // The phone lost its socket; it resends everything packed 10 per frame.
        assert_eq!(t.start(p, s, now), StartOutcome::Duplicate);
        let mut pcm = Vec::new();
        for i in 0..10u8 {
            pcm.extend(block(i));
        }
        let out = t.chunk(p, s, 0, &pcm, now);
        assert_eq!(
            out.blocks.iter().map(|b| b.0).collect::<Vec<_>>(),
            vec![5, 6, 7, 8, 9]
        );
        assert_eq!(out.blocks[0].1, block(5));
        let mut tail = block(10);
        tail.extend(vec![11u8; 640]);
        let out = t.chunk(p, s, 10, &tail, now);
        assert_eq!(
            out.blocks
                .iter()
                .map(|b| (b.0, b.1.len()))
                .collect::<Vec<_>>(),
            vec![(10, 6400), (11, 640)]
        );
        assert_eq!(
            t.end(p, s, 12, 2220, now),
            EndOutcome::Emit {
                implicit_start: false,
                missing: vec![]
            }
        );
        assert_eq!(t.end(p, s, 12, 2220, now), EndOutcome::Unchanged);
    }

    #[test]
    fn reports_missing_blocks_and_updates_when_they_arrive() {
        let (p, s) = ids();
        let now = Instant::now();
        let mut t = SessionTracker::new();
        t.start(p, s, now);
        t.chunk(p, s, 0, &block(0), now);
        t.chunk(p, s, 2, &block(2), now);
        assert_eq!(
            t.end(p, s, 4, 800, now),
            EndOutcome::Emit {
                implicit_start: false,
                missing: vec![1, 3]
            }
        );
        assert_eq!(t.missing(p, s), Some(vec![1, 3]));
        t.chunk(p, s, 1, &block(1), now);
        t.chunk(p, s, 3, &block(3), now);
        assert_eq!(
            t.end(p, s, 4, 800, now),
            EndOutcome::Emit {
                implicit_start: false,
                missing: vec![]
            }
        );
    }

    #[test]
    fn a_completed_session_is_not_transcribed_twice() {
        let (p, s) = ids();
        let now = Instant::now();
        let mut t = SessionTracker::new();
        t.start(p, s, now);
        t.chunk(p, s, 0, &block(0), now);
        let outcome = ResultOutcome::Failed(ResultReason::NoSpeech);
        t.complete(p, s, outcome, now);
        assert_eq!(t.start(p, s, now), StartOutcome::Completed(outcome));
        assert!(t.chunk(p, s, 0, &block(0), now).completed);
        assert_eq!(t.end(p, s, 1, 200, now), EndOutcome::Completed(outcome));
        t.prune(now + SESSION_TTL + Duration::from_secs(1));
        assert_eq!(
            t.start(p, s, now + SESSION_TTL + Duration::from_secs(1)),
            StartOutcome::New
        );
    }

    #[test]
    fn a_lost_audio_start_is_implied_and_absurd_indices_are_ignored() {
        let (p, s) = ids();
        let now = Instant::now();
        let mut t = SessionTracker::new();
        let out = t.chunk(p, s, 3, &block(3), now);
        assert!(out.implicit_start);
        assert!(t
            .chunk(p, s, MAX_BLOCK_INDEX, &block(0), now)
            .blocks
            .is_empty());
        assert!(t.chunk(p, s, u32::MAX, &block(0), now).blocks.is_empty());
        assert!(t.cancel(p, s));
        assert_eq!(t.open_sessions(), 0);
    }
}
