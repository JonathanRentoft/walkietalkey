//! The phone dictations this computer is receiving (DESK-58, DESK-61), and
//! the watchdog for the ones that go silent.
//!
//! A dictation is *receiving* from its `audio_start` until its `audio_end`
//! (then *ending*: it waits up to 5 s for resent blocks and is transcribed)
//! or its `audio_cancel`. One that goes silent, about 15 s without a new
//! block (the phone was closed or lost its connection mid-recording), stops
//! receiving: its waveform and live decode end, and the pill and the menu bar
//! let go of it. Its audio is kept, because the rest may still come: the
//! phone resends the whole session after a reconnect (PHONE-32), and the
//! relay holds frames for a computer that was offline. The relay client
//! passes on only blocks it has not passed on before, so a resend brings
//! just the missing ones; they land in the same dictation, which receives
//! again, and its `audio_end` finishes it as usual. A silent dictation is
//! dropped after the relay client's `SESSION_TTL` (15 minutes; the phone
//! waits 10 for a result, PHONE-24), and the client forgets its blocks too,
//! so a later resend arrives whole, as a new dictation. One still receiving
//! past the 5-minute limit (PHONE-29) and a grace period is answered
//! `too_long`.
//!
//! Every method takes the time, so tests drive the watchdog with a fake clock.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use wt_relay_client::wt_protocol::{DeviceId, SessionId};
use wt_relay_client::SESSION_TTL;

use super::levels::PhoneLevels;
use super::session::SessionAudio;
use crate::managers::transcription::SideStream;

/// About this long without a new block, a dictation has gone silent.
pub const SILENCE_LIMIT: Duration = Duration::from_secs(15);
/// A phone dictation longer than this is answered `too_long` (PHONE-29: the
/// phone itself stops at 5:00).
pub const TOO_LONG: Duration = Duration::from_secs(5 * 60 + 15);
/// A dictation still receiving this much past [`TOO_LONG`] is ended.
pub const LIMIT_GRACE: Duration = Duration::from_secs(15);
/// How long a silent dictation's audio waits for the rest.
pub const SILENT_KEEP: Duration = SESSION_TTL;
/// How often the watchdog looks.
pub const WATCH_EVERY: Duration = Duration::from_secs(1);

pub type Key = (DeviceId, SessionId);

/// A phone dictation in progress.
pub struct PhoneDictation {
    pub audio: SessionAudio,
    pub side: Option<SideStream>,
    pub paused: bool,
    /// The pill's waveform while it streams in (DESK-58), when the pill shows.
    pub levels: Option<Arc<PhoneLevels>>,
    /// This dictation shows the pill.
    pub pill: bool,
    /// When its last new block arrived (or it started): the watchdog's clock.
    last_block: Instant,
}

pub type Dictation = Arc<Mutex<PhoneDictation>>;

impl PhoneDictation {
    pub fn new(
        side: Option<SideStream>,
        paused: bool,
        levels: Option<Arc<PhoneLevels>>,
        now: Instant,
    ) -> Dictation {
        Arc::new(Mutex::new(Self {
            audio: SessionAudio::new(),
            side,
            paused,
            pill: levels.is_some(),
            levels,
            last_block: now,
        }))
    }

    /// No more audio is coming: the waveform stops.
    pub fn stop_levels(&mut self) {
        if let Some(levels) = self.levels.take() {
            levels.stop();
        }
    }

    /// No more audio for now: the waveform and the live decode end. The
    /// audio stays; a resumed dictation is transcribed whole at its end.
    fn stop_receiving(&mut self) {
        self.stop_levels();
        if let Some(side) = self.side.take() {
            side.cancel();
        }
    }
}

/// The watchdog's view of one receiving dictation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Watch {
    Receiving,
    /// No new block for [`SILENCE_LIMIT`].
    Silent,
    /// More audio than [`TOO_LONG`] and [`LIMIT_GRACE`] (counted in audio,
    /// not wall-clock time, so a late resend is never too long for being late).
    OverLimit,
}

pub fn watch(since_block: Duration, received: Duration) -> Watch {
    if received > TOO_LONG + LIMIT_GRACE {
        Watch::OverLimit
    } else if since_block >= SILENCE_LIMIT {
        Watch::Silent
    } else {
        Watch::Receiving
    }
}

/// What one look of the watchdog changed. The `bool` is whether that
/// dictation showed the pill.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Watched {
    /// Gone silent: no longer receiving, audio kept.
    pub silent: Vec<(Key, bool)>,
    /// Past the limit: gone; answer `too_long`.
    pub over_limit: Vec<(Key, bool)>,
    /// Silent for [`SILENT_KEEP`]: gone; the relay client forgets them too.
    pub dropped: Vec<Key>,
}

impl Watched {
    pub fn stopped_any(&self) -> bool {
        !self.silent.is_empty() || !self.over_limit.is_empty()
    }

    pub fn showed_pill(&self) -> bool {
        self.silent
            .iter()
            .chain(&self.over_limit)
            .any(|(_, pill)| *pill)
    }
}

/// Every phone dictation this relay connection knows. Lock order: a map,
/// then a dictation; never a map while holding a dictation.
#[derive(Default)]
pub struct Dictations {
    receiving: Mutex<HashMap<Key, Dictation>>,
    /// `audio_end` came: waiting for resent blocks, then transcribed (DESK-61).
    ending: Mutex<HashMap<Key, Dictation>>,
    /// Gone silent, since when.
    silent: Mutex<HashMap<Key, (Dictation, Instant)>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Dictations {
    /// `audio_start`. A silent dictation with the same key was forgotten by
    /// the relay client, which now sends it whole again: this one replaces it.
    pub fn start(&self, key: Key, dictation: Dictation) {
        lock(&self.silent).remove(&key);
        lock(&self.receiving).insert(key, dictation);
    }

    /// The dictation a new block belongs to: one receiving, one ending (a
    /// resend after `audio_end`, DESK-61), or one gone silent, which receives
    /// again (`true`: the pill and the menu bar come back).
    pub fn for_block(&self, key: &Key, now: Instant) -> Option<(Dictation, bool)> {
        if let Some(d) = lock(&self.receiving).get(key).cloned() {
            lock(&d).last_block = now;
            return Some((d, false));
        }
        if let Some(d) = lock(&self.ending).get(key).cloned() {
            return Some((d, false));
        }
        let (d, _) = lock(&self.silent).remove(key)?;
        lock(&d).last_block = now;
        lock(&self.receiving).insert(*key, Arc::clone(&d));
        Some((d, true))
    }

    /// `audio_end`: the dictation, receiving or silent, is ending now.
    pub fn end(&self, key: &Key) -> Option<Dictation> {
        let receiving = lock(&self.receiving).remove(key);
        let d = receiving.or_else(|| lock(&self.silent).remove(key).map(|(d, _)| d))?;
        lock(&self.ending).insert(*key, Arc::clone(&d));
        Some(d)
    }

    /// The resend wait is over; nothing more lands in it.
    pub fn ended(&self, key: &Key) {
        lock(&self.ending).remove(key);
    }

    /// `audio_cancel`: gone. `Some(showed the pill)` when it was known.
    pub fn cancel(&self, key: &Key) -> Option<bool> {
        let receiving = lock(&self.receiving).remove(key);
        let d = receiving.or_else(|| lock(&self.silent).remove(key).map(|(d, _)| d))?;
        let mut d = lock(&d);
        let pill = d.pill;
        d.stop_receiving();
        Some(pill)
    }

    /// The phone left or was removed: its dictations are gone.
    /// `Some(any showed the pill)` when it had any.
    pub fn forget_phone(&self, phone: &DeviceId) -> Option<bool> {
        let mut gone: Vec<Dictation> = Vec::new();
        lock(&self.receiving).retain(|(p, _), d| {
            if p == phone {
                gone.push(Arc::clone(d));
            }
            p != phone
        });
        lock(&self.silent).retain(|(p, _), (d, _)| {
            if p == phone {
                gone.push(Arc::clone(d));
            }
            p != phone
        });
        if gone.is_empty() {
            return None;
        }
        let mut pill = false;
        for d in gone {
            let mut d = lock(&d);
            pill |= d.pill;
            d.stop_receiving();
        }
        Some(pill)
    }

    /// One look of the watchdog at `now`.
    pub fn watch(&self, now: Instant) -> Watched {
        let mut watched = Watched::default();
        let mut silent = Vec::new();
        lock(&self.receiving).retain(|key, d| {
            let mut dictation = lock(d);
            let verdict = watch(
                now.saturating_duration_since(dictation.last_block),
                dictation.audio.received(),
            );
            if verdict == Watch::Receiving {
                return true;
            }
            dictation.stop_receiving();
            let pill = dictation.pill;
            drop(dictation);
            if verdict == Watch::Silent {
                watched.silent.push((*key, pill));
                silent.push((*key, Arc::clone(d)));
            } else {
                watched.over_limit.push((*key, pill));
            }
            false
        });
        let mut kept = lock(&self.silent);
        for (key, d) in silent {
            kept.insert(key, (d, now));
        }
        kept.retain(|key, (_, since)| {
            let keep = now.saturating_duration_since(*since) < SILENT_KEEP;
            if !keep {
                watched.dropped.push(*key);
            }
            keep
        });
        watched
    }

    /// A dictation is receiving: the menu bar pulses.
    pub fn is_receiving(&self) -> bool {
        !lock(&self.receiving).is_empty()
    }

    /// A dictation is receiving or being finished.
    pub fn busy(&self) -> bool {
        self.is_receiving() || !lock(&self.ending).is_empty()
    }

    /// A receiving or ending dictation shows the pill.
    pub fn pill_in_use(&self) -> bool {
        let shown = |map: &HashMap<Key, Dictation>| map.values().any(|d| lock(d).pill);
        shown(&lock(&self.receiving)) || shown(&lock(&self.ending))
    }

    #[cfg(test)]
    fn is_silent(&self, key: &Key) -> bool {
        lock(&self.silent).contains_key(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walkietalkey::relay::session::BLOCK_SAMPLES;

    const PHONE: DeviceId = DeviceId([7; 16]);

    fn key(n: u8) -> Key {
        (PHONE, SessionId([n; 16]))
    }

    /// `n` blocks of PCM16.
    fn pcm(n: usize) -> Vec<u8> {
        vec![1u8; n * BLOCK_SAMPLES * 2]
    }

    /// A receiving dictation that shows the pill, started at `t0`.
    fn started(dictations: &Dictations, key: Key, t0: Instant) -> (Dictation, Arc<PhoneLevels>) {
        let levels = PhoneLevels::detached();
        let d = PhoneDictation::new(None, false, Some(Arc::clone(&levels)), t0);
        dictations.start(key, Arc::clone(&d));
        (d, levels)
    }

    /// A new block `index` at `now`, as the event loop adds it.
    fn block(dictations: &Dictations, key: &Key, index: u32, now: Instant) -> Option<bool> {
        let (d, resumed) = dictations.for_block(key, now)?;
        lock(&d).audio.add(index, &pcm(1));
        Some(resumed)
    }

    #[test]
    fn the_verdict() {
        let s = Duration::from_secs;
        assert_eq!(watch(s(14), s(60)), Watch::Receiving);
        assert_eq!(watch(s(15), s(60)), Watch::Silent);
        assert_eq!(watch(s(0), TOO_LONG + LIMIT_GRACE), Watch::Receiving);
        assert_eq!(watch(s(0), s(331)), Watch::OverLimit);
    }

    #[test]
    fn a_dictation_that_goes_silent_lets_go_of_the_pill_and_keeps_its_audio() {
        // DESK-58, PHONE-24: the phone stopped sending mid-recording.
        let (dictations, t0) = (Dictations::default(), Instant::now());
        let k = key(1);
        let (d, levels) = started(&dictations, k, t0);
        block(&dictations, &k, 0, t0);
        block(&dictations, &k, 1, t0 + Duration::from_secs(1));
        assert_eq!(
            dictations.watch(t0 + Duration::from_secs(15)),
            Watched::default(),
            "14 s since the last block"
        );
        let watched = dictations.watch(t0 + Duration::from_secs(16));
        assert_eq!(watched.silent, vec![(k, true)]);
        assert!(watched.stopped_any() && watched.showed_pill());
        assert!(!levels.is_live(), "the waveform stopped");
        assert!(!dictations.is_receiving(), "the menu bar stops pulsing");
        assert!(!dictations.busy());
        assert!(!dictations.pill_in_use());
        assert!(dictations.is_silent(&k));
        assert_eq!(lock(&d).audio.received().as_millis(), 400);
        // Once is enough.
        assert_eq!(
            dictations.watch(t0 + Duration::from_secs(17)),
            Watched::default()
        );
    }

    #[test]
    fn a_resend_after_the_silence_completes_the_same_dictation() {
        // PHONE-32: after its reconnect the phone resends; the relay client
        // passes on only the blocks not seen yet, and they land here.
        let (dictations, t0) = (Dictations::default(), Instant::now());
        let k = key(2);
        let (d, _) = started(&dictations, k, t0);
        block(&dictations, &k, 0, t0);
        dictations.watch(t0 + Duration::from_secs(20));
        let later = t0 + Duration::from_secs(8 * 60);
        assert_eq!(block(&dictations, &k, 1, later), Some(true), "resumed");
        assert_eq!(block(&dictations, &k, 2, later), Some(false));
        assert!(dictations.is_receiving());
        assert!(!dictations.is_silent(&k));
        assert_eq!(
            dictations.watch(later + Duration::from_secs(1)),
            Watched::default(),
            "receiving again, and not too long for being late"
        );
        let ending = dictations.end(&k).expect("its audio_end finishes it");
        assert!(Arc::ptr_eq(&ending, &d));
        let mut audio = lock(&ending);
        audio.audio.end(3);
        assert!(audio.audio.is_complete());
    }

    #[test]
    fn blocks_resent_after_audio_end_still_reach_the_dictation() {
        // DESK-61: after audio_end the app waits up to 5 s for the resend.
        let (dictations, t0) = (Dictations::default(), Instant::now());
        let k = key(11);
        let (d, levels) = started(&dictations, k, t0);
        assert!(dictations.for_block(&k, t0).is_some(), "receiving");
        let ending = dictations.end(&k).unwrap();
        lock(&ending).stop_levels();
        assert!(!levels.is_live());
        assert!(!dictations.is_receiving(), "the pulse stops");
        let (found, resumed) = dictations.for_block(&k, t0).expect("a resend lands");
        assert!(Arc::ptr_eq(&found, &d) && !resumed);
        // The watchdog leaves an ending dictation alone.
        assert_eq!(
            dictations.watch(t0 + Duration::from_secs(60)),
            Watched::default()
        );
        dictations.ended(&k);
        assert!(dictations.for_block(&k, t0).is_none(), "after the wait");
    }

    #[test]
    fn audio_end_for_a_silent_dictation_still_finishes_it() {
        // Frames the relay held for an offline computer arrive late, ending
        // with audio_end.
        let (dictations, t0) = (Dictations::default(), Instant::now());
        let k = key(3);
        let (d, _) = started(&dictations, k, t0);
        dictations.watch(t0 + Duration::from_secs(30));
        let ending = dictations.end(&k).expect("still known");
        assert!(Arc::ptr_eq(&ending, &d));
        assert!(dictations.busy(), "being finished");
        // A resend of missing blocks during the 5 s wait (DESK-61).
        assert_eq!(block(&dictations, &k, 0, t0), Some(false));
        dictations.ended(&k);
        assert!(dictations.for_block(&k, t0).is_none(), "after the wait");
        assert!(!dictations.busy());
    }

    #[test]
    fn a_silent_dictation_is_dropped_after_the_resend_window() {
        let (dictations, t0) = (Dictations::default(), Instant::now());
        let k = key(4);
        started(&dictations, k, t0);
        let stalled = t0 + Duration::from_secs(15);
        dictations.watch(stalled);
        assert!(dictations
            .watch(stalled + SILENT_KEEP - Duration::from_secs(1))
            .dropped
            .is_empty());
        let watched = dictations.watch(stalled + SILENT_KEEP);
        assert_eq!(
            watched.dropped,
            vec![k],
            "forgotten in the relay client too"
        );
        assert!(!watched.stopped_any(), "it had let go already");
        assert!(dictations.for_block(&k, stalled).is_none());
        assert!(dictations.end(&k).is_none());
    }

    #[test]
    fn a_new_start_replaces_a_silent_dictation_with_the_same_key() {
        // The relay client forgot it and sends the resend whole, as new.
        let (dictations, t0) = (Dictations::default(), Instant::now());
        let k = key(5);
        let (old, _) = started(&dictations, k, t0);
        block(&dictations, &k, 0, t0);
        dictations.watch(t0 + Duration::from_secs(15));
        let (new, _) = started(&dictations, k, t0 + Duration::from_secs(60));
        assert!(!dictations.is_silent(&k));
        let (found, resumed) = dictations.for_block(&k, t0).unwrap();
        assert!(Arc::ptr_eq(&found, &new) && !Arc::ptr_eq(&found, &old));
        assert!(!resumed);
    }

    #[test]
    fn a_dictation_past_the_limit_is_ended() {
        // PHONE-29: the phone stops at 5:00; one still sending at 5:30 of
        // audio is answered too_long and let go.
        let (dictations, t0) = (Dictations::default(), Instant::now());
        let k = key(6);
        let (_, levels) = started(&dictations, k, t0);
        let (d, _) = dictations.for_block(&k, t0).unwrap();
        let blocks = ((TOO_LONG + LIMIT_GRACE).as_millis() / 200 + 1) as usize;
        lock(&d).audio.add(0, &pcm(blocks));
        let watched = dictations.watch(t0 + Duration::from_secs(1));
        assert_eq!(watched.over_limit, vec![(k, true)]);
        assert!(watched.silent.is_empty());
        assert!(!levels.is_live());
        assert!(!dictations.is_receiving());
        assert!(!dictations.is_silent(&k), "not kept");
        assert!(dictations.for_block(&k, t0).is_none());
    }

    #[test]
    fn cancel_and_a_phone_that_left_end_their_dictations() {
        let (dictations, t0) = (Dictations::default(), Instant::now());
        let (a, b) = (key(7), key(8));
        let (_, levels_a) = started(&dictations, a, t0);
        started(&dictations, b, t0);
        assert_eq!(dictations.cancel(&a), Some(true));
        assert!(!levels_a.is_live());
        assert_eq!(dictations.cancel(&a), None, "once");
        dictations.watch(t0 + Duration::from_secs(15));
        assert!(dictations.is_silent(&b));
        assert_eq!(dictations.forget_phone(&PHONE), Some(true));
        assert!(!dictations.is_silent(&b));
        assert_eq!(dictations.forget_phone(&PHONE), None);
        assert!(!dictations.busy());
    }

    #[test]
    fn the_pill_is_in_use_while_one_that_shows_it_receives_or_ends() {
        let (dictations, t0) = (Dictations::default(), Instant::now());
        let (with, without) = (key(9), key(10));
        started(&dictations, with, t0);
        dictations.start(without, PhoneDictation::new(None, false, None, t0));
        assert!(dictations.pill_in_use());
        dictations.end(&with);
        assert!(dictations.pill_in_use(), "its transcribing pill");
        dictations.ended(&with);
        assert!(!dictations.pill_in_use());
        assert!(dictations.is_receiving());
    }
}
