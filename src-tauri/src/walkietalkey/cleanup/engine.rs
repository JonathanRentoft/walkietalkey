//! Running cleanup under the guardrails (DESK-84): once for a whole
//! dictation, or chunk by chunk while the user talks (DESK-47). In the chunk
//! case each call gets the previous chunk (already cleaned, still allowed to
//! change) plus the new chunk, so "nej vent, torsdag" can fix something said
//! before a cut; calls run in order in the background, nothing is pasted
//! until the end, and at release only the last chunk's call is left. With
//! "Når der er noget at rette" only the chunks that need it are sent.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use super::guardrails::{self, Violation};
use super::markers::needs_cleanup;
use super::prompt::{chunk_message, strip_tags, user_message, SYSTEM_PROMPT};
use super::provider::Provider;
use crate::walkietalkey::history::CleanupRecord;

/// The result of cleaning a dictation.
#[derive(Debug, Clone, PartialEq)]
pub struct Cleaned {
    pub text: String,
    /// What went to a cloud provider (DESK-85); `None` on the device or when
    /// nothing was sent.
    pub record: Option<CleanupRecord>,
    /// At least one call failed a guardrail; that part kept its local text.
    pub fell_back: bool,
    /// Whether any call was made.
    pub called: bool,
}

/// One call: the message, the deadline, the guardrails. `input` is the text
/// the answer is checked against.
async fn call(provider: &dyn Provider, user: &str, input: &str) -> Result<(String, u64), Violation> {
    let started = Instant::now();
    let answer = tokio::time::timeout(
        guardrails::deadline(input),
        provider.complete(SYSTEM_PROMPT, user),
    )
    .await
    .map_err(|_| Violation::Timeout)?
    .map_err(|e| {
        log::info!("Cleanup call failed: {e}");
        Violation::NoAnswer
    })?;
    let cleaned = strip_tags(&answer);
    guardrails::check(input, &cleaned)?;
    Ok((cleaned, started.elapsed().as_millis() as u64))
}

fn record(provider: &dyn Provider, sent: Vec<String>, duration_ms: u64) -> Option<CleanupRecord> {
    (provider.is_cloud() && !sent.is_empty()).then(|| CleanupRecord {
        provider: provider.label(),
        sent_text: sent.join("\n\n"),
        duration_ms,
    })
}

/// Cleans a whole dictation's local text in one call.
pub async fn clean_once(provider: &dyn Provider, text: &str) -> Cleaned {
    let user = user_message(text);
    match call(provider, &user, text).await {
        Ok((cleaned, ms)) => Cleaned {
            text: cleaned,
            record: record(provider, vec![user], ms),
            fell_back: false,
            called: true,
        },
        Err(violation) => {
            log::info!("Cleanup not used: {violation:?}");
            Cleaned {
                text: text.to_string(),
                record: record(provider, vec![user], 0),
                fell_back: true,
                called: true,
            }
        }
    }
}

#[derive(Default)]
struct ChunkState {
    /// The cleaned text so far, in pieces; the last piece is the one the next
    /// call may still change.
    pieces: Vec<String>,
    sent: Vec<String>,
    duration_ms: u64,
    fell_back: bool,
    called: bool,
}

/// Cleans a recording chunk by chunk while it goes (DESK-47).
pub struct ChunkCleaner {
    provider: Arc<dyn Provider>,
    only_when_needed: bool,
    state: Arc<tokio::sync::Mutex<ChunkState>>,
    chain: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ChunkCleaner {
    pub fn new(provider: Arc<dyn Provider>, only_when_needed: bool) -> Self {
        Self {
            provider,
            only_when_needed,
            state: Arc::new(tokio::sync::Mutex::new(ChunkState::default())),
            chain: Mutex::new(None),
        }
    }

    /// A chunk's local text is ready: clean it in the background, after the
    /// chunks before it.
    pub fn push(&self, chunk: String) {
        let previous_task = self.chain.lock().unwrap().take();
        let provider = Arc::clone(&self.provider);
        let state = Arc::clone(&self.state);
        let only_when_needed = self.only_when_needed;
        let task = tauri::async_runtime::spawn(async move {
            if let Some(previous) = previous_task {
                let _ = previous.await;
            }
            let chunk = chunk.trim().to_string();
            if chunk.is_empty() {
                return;
            }
            let mut st = state.lock().await;
            let previous = st.pieces.last().cloned();
            let window = match &previous {
                Some(p) => format!("{p} {chunk}"),
                None => chunk.clone(),
            };
            if only_when_needed && !needs_cleanup(&window) {
                st.pieces.push(chunk);
                return;
            }
            let user = match &previous {
                Some(p) => chunk_message(p, &chunk),
                None => user_message(&chunk),
            };
            st.called = true;
            st.sent.push(user.clone());
            match call(provider.as_ref(), &user, &window).await {
                Ok((cleaned, ms)) => {
                    st.duration_ms += ms;
                    if previous.is_some() {
                        st.pieces.pop();
                    }
                    st.pieces.push(cleaned);
                }
                Err(violation) => {
                    log::info!("Chunk cleanup not used: {violation:?}");
                    st.fell_back = true;
                    st.pieces.push(chunk);
                }
            }
        });
        *self.chain.lock().unwrap() = Some(task);
    }

    /// The recording ended: waits for the last chunk's call and returns the
    /// whole cleaned text.
    pub async fn finish(&self) -> Cleaned {
        let last = self.chain.lock().unwrap().take();
        if let Some(last) = last {
            let _ = last.await;
        }
        let st = self.state.lock().await;
        Cleaned {
            text: st.pieces.join(" "),
            record: record(self.provider.as_ref(), st.sent.clone(), st.duration_ms),
            fell_back: st.fell_back,
            called: st.called,
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::super::provider::BoxFuture;
    use super::*;
    use std::time::Duration;

    /// A fake provider: answers with `respond(user message)` after `delay`,
    /// and records every user message it got.
    pub(crate) struct Fake {
        pub respond: Box<dyn Fn(&str) -> String + Send + Sync>,
        pub delay: Duration,
        pub calls: Mutex<Vec<String>>,
    }

    impl Fake {
        pub(crate) fn new(respond: impl Fn(&str) -> String + Send + Sync + 'static) -> Arc<Self> {
            Arc::new(Self {
                respond: Box::new(respond),
                delay: Duration::ZERO,
                calls: Mutex::new(Vec::new()),
            })
        }
    }

    impl Provider for Fake {
        fn label(&self) -> String {
            "Fake".into()
        }
        fn is_cloud(&self) -> bool {
            true
        }
        fn complete<'a>(&'a self, _system: &'a str, user: &'a str) -> BoxFuture<'a, Result<String, String>> {
            self.calls.lock().unwrap().push(user.to_string());
            Box::pin(async move {
                tokio::time::sleep(self.delay).await;
                Ok((self.respond)(user))
            })
        }
    }

    /// The text inside a message's <new> part, or inside <dictation>.
    fn new_part(user: &str) -> String {
        let inner = |open: &str, close: &str| {
            user.split(open).nth(1).and_then(|r| r.split(close).next()).map(|s| s.trim().to_string())
        };
        inner("<new>", "</new>").or_else(|| inner("<dictation>", "</dictation>")).unwrap_or_default()
    }

    fn previous_part(user: &str) -> Option<String> {
        user.split("<previous>")
            .nth(1)
            .and_then(|r| r.split("</previous>").next())
            .map(|s| s.trim().to_string())
    }

    /// A provider that applies "X, nej, Y" self-corrections and capitalises.
    fn editor(user: &str) -> String {
        let text = match previous_part(user) {
            Some(prev) => format!("{prev} {}", new_part(user)),
            None => new_part(user),
        };
        let text = text.replace("onsdag. nej vent torsdag", "torsdag").replace("onsdag nej torsdag", "torsdag");
        let mut chars = text.chars();
        match chars.next() {
            Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
            None => text,
        }
    }

    #[tokio::test]
    async fn a_whole_dictation_is_cleaned_in_one_call() {
        let fake = Fake::new(editor);
        let cleaned = clean_once(fake.as_ref(), "vi ses onsdag nej torsdag").await;
        assert_eq!(cleaned.text, "Vi ses torsdag");
        assert!(!cleaned.fell_back);
        let record = cleaned.record.expect("a cloud call is recorded");
        assert!(record.sent_text.contains("<dictation>"));
        assert_eq!(record.provider, "Fake");
    }

    #[tokio::test]
    async fn guardrails_fall_back_to_the_local_text() {
        let chatty = Fake::new(|_| "Selvfølgelig! Her er din tekst, pænt redigeret og forbedret: Vi ses.".into());
        let cleaned = clean_once(chatty.as_ref(), "vi ses").await;
        assert!(cleaned.fell_back);
        assert_eq!(cleaned.text, "vi ses");
    }

    #[tokio::test]
    async fn a_slow_provider_times_out() {
        let slow = Arc::new(Fake {
            respond: Box::new(|_| "Vi ses.".into()),
            delay: Duration::from_millis(3_200),
            calls: Mutex::new(Vec::new()),
        });
        let started = Instant::now();
        let cleaned = clean_once(slow.as_ref(), "vi ses").await;
        assert!(cleaned.fell_back, "3 s deadline for a short text");
        assert!(started.elapsed() < Duration::from_millis(3_150));
    }

    #[tokio::test]
    async fn chunks_are_cleaned_with_the_previous_chunk_so_corrections_cross_cuts() {
        let fake = Fake::new(editor);
        let cleaner = ChunkCleaner::new(fake.clone(), false);
        cleaner.push("vi ses onsdag.".into());
        cleaner.push("nej vent torsdag kl. 10".into());
        let cleaned = cleaner.finish().await;
        assert_eq!(cleaned.text, "Vi ses torsdag kl. 10");
        let calls = fake.calls.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert!(calls[1].contains("<previous>\nVi ses onsdag.\n</previous>"), "{}", calls[1]);
        assert!(cleaned.record.unwrap().sent_text.contains("<new>"));
    }

    #[tokio::test]
    async fn when_needed_only_sends_chunks_with_corrections() {
        let fake = Fake::new(editor);
        let cleaner = ChunkCleaner::new(fake.clone(), true);
        cleaner.push("Det her er helt fint.".into());
        cleaner.push("Det er det også.".into());
        let cleaned = cleaner.finish().await;
        assert!(!cleaned.called, "no marker, no call");
        assert!(fake.calls.lock().unwrap().is_empty());
        assert_eq!(cleaned.text, "Det her er helt fint. Det er det også.");

        let fake = Fake::new(editor);
        let cleaner = ChunkCleaner::new(fake.clone(), true);
        cleaner.push("vi ses onsdag.".into());
        cleaner.push("nej vent torsdag".into());
        let cleaned = cleaner.finish().await;
        assert_eq!(fake.calls.lock().unwrap().len(), 1, "only the chunk that needs it");
        assert_eq!(cleaned.text, "Vi ses torsdag");
    }

    #[tokio::test]
    async fn at_release_only_the_last_chunks_call_is_left() {
        let slow = Arc::new(Fake {
            respond: Box::new(editor),
            delay: Duration::from_millis(300),
            calls: Mutex::new(Vec::new()),
        });
        let cleaner = ChunkCleaner::new(slow.clone(), false);
        for i in 0..4 {
            cleaner.push(format!("del nummer {i}."));
            // The user keeps talking ~10 s per chunk; here 400 ms is plenty.
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
        cleaner.push("sidste del".into());
        let released = Instant::now();
        let cleaned = cleaner.finish().await;
        let wait = released.elapsed();
        assert!(wait < Duration::from_millis(550), "waited {wait:?}: only one call left");
        assert!(cleaned.text.ends_with("sidste del"));
    }

    #[tokio::test]
    async fn a_failing_chunk_keeps_its_own_text() {
        let picky = Fake::new(|user| {
            if user.contains("ødelæg") {
                "En helt anden tekst om noget andet end det sagte, som er alt for lang.".into()
            } else {
                editor(user)
            }
        });
        let cleaner = ChunkCleaner::new(picky, false);
        cleaner.push("første del.".into());
        cleaner.push("ødelæg mig".into());
        let cleaned = cleaner.finish().await;
        assert!(cleaned.fell_back);
        assert_eq!(cleaned.text, "Første del. ødelæg mig");
    }
}
