//! One transcription's output at a time, in the order the recordings end
//! (DESK-27). A recording takes a ticket when it ends; its output (paste, or
//! clipboard and notification) waits until every earlier ticket is done. So a
//! phone dictation that ends during a key dictation's processing waits, and
//! its notification follows the key dictation's paste.

use std::sync::{Condvar, Mutex};

use once_cell::sync::Lazy;

struct State {
    next_ticket: u64,
    now_serving: u64,
}

static STATE: Lazy<(Mutex<State>, Condvar)> = Lazy::new(|| {
    (
        Mutex::new(State {
            next_ticket: 0,
            now_serving: 0,
        }),
        Condvar::new(),
    )
});

/// A recording's place in the output order. Dropping it (output done, or
/// the dictation abandoned) lets the next one go.
#[derive(Debug)]
pub struct Ticket {
    number: u64,
    done: bool,
}

impl Ticket {
    /// Blocks until every earlier recording's output is done.
    pub fn wait_turn(&self) {
        let (lock, cvar) = &*STATE;
        let mut state = lock.lock().unwrap();
        while state.now_serving < self.number {
            state = cvar.wait(state).unwrap();
        }
    }

    /// Async-friendly wait: runs `wait_turn` off the async runtime.
    pub async fn wait_turn_async(self) -> Ticket {
        tauri::async_runtime::spawn_blocking(move || {
            self.wait_turn();
            self
        })
        .await
        .expect("ticket wait does not panic")
    }

    fn finish(&mut self) {
        if self.done {
            return;
        }
        self.done = true;
        let (lock, cvar) = &*STATE;
        let mut state = lock.lock().unwrap();
        // A later ticket may finish first (abandoned); serving only moves
        // past this one when it is the one being served.
        if state.now_serving == self.number {
            state.now_serving += 1;
            // Skip tickets abandoned while they waited.
            while ABANDONED.lock().unwrap().remove(&state.now_serving) {
                state.now_serving += 1;
            }
        } else {
            ABANDONED.lock().unwrap().insert(self.number);
        }
        cvar.notify_all();
    }
}

static ABANDONED: Lazy<Mutex<std::collections::HashSet<u64>>> =
    Lazy::new(|| Mutex::new(std::collections::HashSet::new()));

impl Drop for Ticket {
    fn drop(&mut self) {
        self.finish();
    }
}

/// Takes the next ticket: call when a recording ends.
pub fn take_ticket() -> Ticket {
    let (lock, _) = &*STATE;
    let mut state = lock.lock().unwrap();
    let number = state.next_ticket;
    state.next_ticket += 1;
    Ticket {
        number,
        done: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    // The sequencer is global; the tests share it, so they run in one test.
    #[test]
    fn outputs_follow_the_order_recordings_ended() {
        // Later ticket waits for the earlier one.
        let order = Arc::new(Mutex::new(Vec::new()));
        let first = take_ticket();
        let second = take_ticket();
        let o = Arc::clone(&order);
        let waiter = thread::spawn(move || {
            second.wait_turn();
            o.lock().unwrap().push("phone");
        });
        thread::sleep(Duration::from_millis(50));
        assert!(
            order.lock().unwrap().is_empty(),
            "the phone waits for the key"
        );
        first.wait_turn();
        order.lock().unwrap().push("key");
        drop(first);
        waiter.join().unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["key", "phone"]);

        // A ticket abandoned while it waited does not block the ones after it.
        let a = take_ticket();
        let b = take_ticket();
        let c = take_ticket();
        drop(b);
        a.wait_turn();
        drop(a);
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            c.wait_turn();
            tx.send(()).unwrap();
        });
        rx.recv_timeout(Duration::from_secs(2))
            .expect("c runs once a and the abandoned b are done");
    }
}
