//! Frame counters (spec 9.4): block reservation for sending, replay guard for receiving.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::bytes::DeviceId;
use crate::consts::COUNTER_BLOCK;
use crate::error::{ProtocolError, Result};

/// Persistence for counters. A missing value reads as 0. `save_*` must return only once
/// the value is durable. Errors are `ProtocolError::Store`.
pub trait CounterStore: Send + Sync {
    /// End of the last reserved send block, 0 if none.
    fn load_send_reservation(&self, key: &str) -> Result<u64>;
    fn save_send_reservation(&self, key: &str, end: u64) -> Result<()>;
    /// Last accepted counter from a sender, 0 if none.
    fn load_last_accepted(&self, key: &str) -> Result<u64>;
    fn save_last_accepted(&self, key: &str, value: u64) -> Result<()>;
}

/// `<sender b64u>><recipient b64u>`, the same key format as TypeScript.
pub fn counter_key(sender: &DeviceId, recipient: &DeviceId) -> String {
    format!("{}>{}", sender.to_b64u(), recipient.to_b64u())
}

#[derive(Default)]
pub struct MemoryCounterStore {
    send: Mutex<HashMap<String, u64>>,
    recv: Mutex<HashMap<String, u64>>,
}

impl CounterStore for MemoryCounterStore {
    fn load_send_reservation(&self, key: &str) -> Result<u64> {
        Ok(*self.send.lock().unwrap().get(key).unwrap_or(&0))
    }
    fn save_send_reservation(&self, key: &str, end: u64) -> Result<()> {
        self.send.lock().unwrap().insert(key.to_owned(), end);
        Ok(())
    }
    fn load_last_accepted(&self, key: &str) -> Result<u64> {
        Ok(*self.recv.lock().unwrap().get(key).unwrap_or(&0))
    }
    fn save_last_accepted(&self, key: &str, value: u64) -> Result<()> {
        self.recv.lock().unwrap().insert(key.to_owned(), value);
        Ok(())
    }
}

/// Hands out counters; the end of each block of 1,000 is persisted before any number of
/// it is used, and a restart starts a new block.
#[derive(Debug, Clone)]
pub struct SendCounter {
    key: String,
    next: u64,
    reserved_end: u64,
    block: u64,
}

impl SendCounter {
    pub fn open(store: &dyn CounterStore, key: impl Into<String>) -> Result<Self> {
        Self::open_with_block(store, key, COUNTER_BLOCK)
    }

    pub fn open_with_block(
        store: &dyn CounterStore,
        key: impl Into<String>,
        block: u64,
    ) -> Result<Self> {
        assert!(block >= 1);
        let key = key.into();
        let stored = store.load_send_reservation(&key)?;
        Ok(SendCounter {
            key,
            next: stored + 1,
            reserved_end: stored,
            block,
        })
    }

    pub fn next(&mut self, store: &dyn CounterStore) -> Result<u64> {
        if self.next > self.reserved_end {
            let end = self
                .next
                .checked_add(self.block - 1)
                .ok_or(ProtocolError::Store("counter exhausted".into()))?;
            store.save_send_reservation(&self.key, end)?;
            self.reserved_end = end;
        }
        let n = self.next;
        self.next += 1;
        Ok(n)
    }
}

/// Rejects any counter not higher than the last accepted one, across restarts.
#[derive(Debug, Clone)]
pub struct ReplayGuard {
    key: String,
    last: u64,
}

impl ReplayGuard {
    pub fn open(store: &dyn CounterStore, key: impl Into<String>) -> Result<Self> {
        let key = key.into();
        let last = store.load_last_accepted(&key)?;
        Ok(ReplayGuard { key, last })
    }

    pub fn last_accepted(&self) -> u64 {
        self.last
    }

    pub fn would_accept(&self, counter: u64) -> bool {
        counter > self.last
    }

    pub fn accept(&mut self, store: &dyn CounterStore, counter: u64) -> Result<()> {
        if !self.would_accept(counter) {
            return Err(ProtocolError::Replay {
                counter,
                last: self.last,
            });
        }
        store.save_last_accepted(&self.key, counter)?;
        self.last = counter;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[derive(Default)]
    struct Flaky {
        inner: MemoryCounterStore,
        fail: AtomicBool,
        log: Mutex<Vec<u64>>,
    }

    impl CounterStore for Flaky {
        fn load_send_reservation(&self, key: &str) -> Result<u64> {
            self.inner.load_send_reservation(key)
        }
        fn save_send_reservation(&self, key: &str, end: u64) -> Result<()> {
            if self.fail.swap(false, Ordering::SeqCst) {
                return Err(ProtocolError::Store("disk full".into()));
            }
            self.log.lock().unwrap().push(end);
            self.inner.save_send_reservation(key, end)
        }
        fn load_last_accepted(&self, key: &str) -> Result<u64> {
            self.inner.load_last_accepted(key)
        }
        fn save_last_accepted(&self, key: &str, value: u64) -> Result<()> {
            self.inner.save_last_accepted(key, value)
        }
    }

    #[test]
    fn blocks_and_restarts() {
        let store = Flaky::default();
        let mut c = SendCounter::open(&store, "k").unwrap();
        assert!(store.log.lock().unwrap().is_empty());
        assert_eq!(c.next(&store).unwrap(), 1);
        assert_eq!(*store.log.lock().unwrap(), vec![1000]);
        for i in 2..=1000 {
            assert_eq!(c.next(&store).unwrap(), i);
        }
        assert_eq!(c.next(&store).unwrap(), 1001);
        assert_eq!(*store.log.lock().unwrap(), vec![1000, 2000]);
        let mut again = SendCounter::open(&store, "k").unwrap();
        assert_eq!(again.next(&store).unwrap(), 2001);
    }

    #[test]
    fn failed_reservation_hands_out_nothing() {
        let store = Flaky::default();
        let mut c = SendCounter::open(&store, "k").unwrap();
        store.fail.store(true, Ordering::SeqCst);
        assert!(c.next(&store).is_err());
        assert_eq!(c.next(&store).unwrap(), 1);
    }

    #[test]
    fn replay_guard() {
        let store = MemoryCounterStore::default();
        let mut g = ReplayGuard::open(&store, "p").unwrap();
        assert!(!g.would_accept(0));
        g.accept(&store, 5).unwrap();
        assert!(g.accept(&store, 5).is_err());
        assert!(g.accept(&store, 4).is_err());
        let g2 = ReplayGuard::open(&store, "p").unwrap();
        assert!(!g2.would_accept(5));
        assert!(g2.would_accept(6));
    }
}
