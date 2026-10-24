//! The silent microphone (DESK-59). When the selected input delivers no
//! sound (an audio interface with nothing plugged in, a muted or virtual
//! device), the user is told so instead of seeing nothing:
//!
//! 1. While a key dictation records, its raw input goes through
//!    [`level::SilenceDetector`] (the sink's raw tap, before VAD). After
//!    1.5 s without sound the pill says "Mikrofonen giver ingen lyd" while
//!    it keeps recording (`wt-mic-silent`); sound clears it.
//! 2. A take that never had sound is not transcribed. The pill ends with
//!    "Mikrofonen giver ingen lyd" ([`PillEnd::MicSilent`]), and the other
//!    inputs are probed once ([`suggest`]) for one that works.
//! 3. The window shows the notice for that input with the suggestion and
//!    "Brug {navn}" (`wt-mic-check`, [`MicCheck`]) until the selected input
//!    delivers sound again, the user picks another input, or switches.
//!
//! [`guard`] keeps every input stream a microphone: on macOS cpal would
//! otherwise record the system audio from a device without input channels.
//! Phone dictations have their own audio path and are not watched here.

pub mod guard;
pub mod level;
pub mod suggest;

#[cfg(target_os = "macos")]
mod coreaudio;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use log::info;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use level::{Change, Silence, SilenceDetector, Verdict};

use crate::audio_toolkit::audio::RawTap;

use super::output::PillEnd;

/// The microphone notice in the window (`wt_mic_check_status`,
/// `wt-mic-check`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
pub struct MicCheck {
    /// The input that gave no sound in the last take. `None`: all is well.
    pub silent_input: Option<String>,
    /// An input that delivered sound when probed: "Brug {navn}".
    pub suggestion: Option<String>,
    /// The other inputs are being probed.
    pub probing: bool,
}

/// `wt-mic-silent`: the pill's notice while recording.
#[derive(Debug, Clone, Serialize, Type)]
pub struct MicSilentEvent {
    pub silent: bool,
}

static CHECK: Mutex<MicCheck> = Mutex::new(MicCheck {
    silent_input: None,
    suggestion: None,
    probing: false,
});
static PROBING: AtomicBool = AtomicBool::new(false);

/// The notice as it stands.
pub fn status() -> MicCheck {
    CHECK.lock().unwrap().clone()
}

/// Replaces the notice and tells the windows, if it changed.
fn set(app: &AppHandle, next: MicCheck) {
    {
        let mut check = CHECK.lock().unwrap();
        if *check == next {
            return;
        }
        *check = next.clone();
    }
    let _ = app.emit("wt-mic-check", next);
}

/// The selected input delivers sound (again): the notice goes.
fn input_works(app: &AppHandle) {
    if CHECK.lock().unwrap().silent_input.is_some() {
        info!("Microphone check: the input delivers sound again");
        set(app, MicCheck::default());
    }
}

/* ------------------------------------------------------------ the take */

struct Take {
    input_id: String,
    input: String,
    detector: SilenceDetector,
}

/// The take being recorded, and the last one stopped (until the stop path
/// reads it). Key dictations come one at a time.
static CURRENT: Mutex<Option<Arc<Mutex<Take>>>> = Mutex::new(None);
static SEALED: Mutex<Option<Arc<Mutex<Take>>>> = Mutex::new(None);

/// What a take's tap reports while it records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TakeEvent {
    /// The pill's notice goes up (`true`) or away (`false`).
    Silent(bool),
    /// The input has delivered sound in this take.
    Works,
}

/// A raw-audio tap for one key recording on input `input` (handy-recorder's
/// device ID and name). Called by `AudioRecordingManager` when a recording
/// starts; runs on the recorder's delivery thread, once per chunk.
pub fn start_take(app: &AppHandle, input_id: String, input: String) -> RawTap {
    let app = app.clone();
    start_take_with(input_id, input, move |event| match event {
        TakeEvent::Silent(silent) => {
            let _ = app.emit("wt-mic-silent", MicSilentEvent { silent });
        }
        TakeEvent::Works => input_works(&app),
    })
}

fn start_take_with(
    input_id: String,
    input: String,
    on_event: impl Fn(TakeEvent) + Send + 'static,
) -> RawTap {
    let take = Arc::new(Mutex::new(Take {
        input_id,
        input,
        detector: SilenceDetector::new(),
    }));
    *CURRENT.lock().unwrap() = Some(Arc::clone(&take));
    let mut was_alive = false;
    Box::new(move |samples: &[f32]| {
        let (change, alive) = {
            let mut take = take.lock().unwrap();
            let change = take.detector.feed(samples);
            (change, take.detector.is_alive())
        };
        if let Some(change) = change {
            on_event(TakeEvent::Silent(change == Change::Silent));
        }
        if alive && !was_alive {
            was_alive = true;
            on_event(TakeEvent::Works);
        }
    })
}

/// The recording stopped and its audio is all in: keeps its verdict for
/// [`finish_take`], out of reach of the next recording.
pub fn seal_take() {
    *SEALED.lock().unwrap() = CURRENT.lock().unwrap().take();
}

/// How the last stopped take went.
#[derive(Debug, Clone, PartialEq)]
pub struct TakeOutcome {
    pub input_id: String,
    pub input: String,
    pub verdict: Verdict,
}

impl TakeOutcome {
    pub fn is_silent(&self) -> bool {
        matches!(self.verdict, Verdict::Silent(_))
    }
}

/// The verdict of the take [`seal_take`] kept, once.
pub fn finish_take() -> Option<TakeOutcome> {
    let take = SEALED.lock().unwrap().take()?;
    let take = take.lock().unwrap();
    let outcome = TakeOutcome {
        input_id: take.input_id.clone(),
        input: take.input.clone(),
        verdict: take.detector.verdict(),
    };
    let what = match outcome.verdict {
        Verdict::Alive => "sound",
        Verdict::TooShort => "too short to judge",
        Verdict::Silent(Silence::DigitalZero) => "SILENT (digital zeros)",
        Verdict::Silent(Silence::BelowFloor) => "SILENT (below -60 dBFS)",
    };
    info!(
        "Microphone check: {:?}, {:.1} s, loudest window {:.1} dBFS: {what}",
        outcome.input,
        take.detector.seconds(),
        take.detector.peak_dbfs(),
    );
    Some(outcome)
}

/// A key take had no sound: the pill's end state, the notice, and one probe
/// of the other inputs for a suggestion.
pub fn silent_take<F>(app: &AppHandle, outcome: TakeOutcome, still_ours: F)
where
    F: Fn() -> bool + Send + 'static,
{
    super::pill::finish(app, PillEnd::MicSilent, still_ours);
    probe_others(app, outcome.input_id, outcome.input);
}

/// The latest probe request (the silent input's ID and name); the probe
/// thread takes it.
static REQUEST: Mutex<Option<(String, String)>> = Mutex::new(None);

/// Probes the inputs other than the silent one, in the background, and
/// offers the first that works. One probe thread at a time; a request made
/// while it runs is taken up when it finishes.
fn probe_others(app: &AppHandle, silent_id: String, silent: String) {
    set(
        app,
        MicCheck {
            silent_input: Some(silent.clone()),
            suggestion: None,
            probing: true,
        },
    );
    *REQUEST.lock().unwrap() = Some((silent_id, silent));
    if PROBING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::Builder::new()
        .name("wt-mic-probe".into())
        .spawn(move || loop {
            let Some((silent_id, silent)) = REQUEST.lock().unwrap().take() else {
                PROBING.store(false, Ordering::Release);
                // A request that came in after the take above, while this
                // thread still counted as running, is not lost.
                if REQUEST.lock().unwrap().is_some() && !PROBING.swap(true, Ordering::AcqRel) {
                    continue;
                }
                break;
            };
            let order = suggest::probe_order(suggest::candidates(), &silent_id, &silent);
            let found = suggest::first_that_works(&order, |c| suggest::probe_input(&c.id));
            // The notice may have gone meanwhile (sound, or another input).
            if CHECK.lock().unwrap().silent_input.as_deref() == Some(silent.as_str()) {
                set(
                    &app,
                    MicCheck {
                        silent_input: Some(silent),
                        suggestion: found.map(|c| c.name),
                        probing: false,
                    },
                );
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| {
            log::error!("Microphone probe: cannot start a thread: {e}");
            PROBING.store(false, Ordering::Release);
        });
}

/* ------------------------------------------------------- the window */

/// "Brug {navn}": records from `name` from now on, and drops the notice
/// (that input delivered sound when probed).
pub async fn use_input(app: &AppHandle, name: String) -> Result<(), String> {
    let mut settings = crate::settings::get_settings(app);
    settings.selected_microphone = Some(name.clone());
    crate::settings::write_settings(app, settings);
    let rm = app
        .state::<Arc<crate::managers::audio::AudioRecordingManager>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn_blocking(move || rm.update_selected_device())
        .await
        .map_err(|e| format!("audio task join failed: {e}"))?
        .map_err(|e| format!("Failed to switch the microphone: {e}"))?;
    let _ = app.emit(
        "settings-changed",
        serde_json::json!({ "setting": "selected_microphone", "value": name }),
    );
    info!("Microphone check: switched to {name:?}");
    set(app, MicCheck::default());
    Ok(())
}

/// "Tjek igen": listens to the silent input again; if it delivers sound
/// now, the notice goes, otherwise the others are probed again.
pub fn recheck(app: &AppHandle) {
    let Some(silent) = status().silent_input else {
        return;
    };
    if PROBING.load(Ordering::Acquire) {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("wt-mic-recheck".into())
        .spawn(move || {
            let candidates = suggest::candidates();
            let Some(input) = candidates.iter().find(|c| c.name == silent).cloned() else {
                // Gone (unplugged): the notice was about a device no longer
                // in use.
                set(&app, MicCheck::default());
                return;
            };
            if suggest::probe_input(&input.id) == suggest::Probe::Sound {
                input_works(&app);
            } else {
                probe_others(&app, input.id, input.name);
            }
        });
}

/// The microphone setting changed: a notice about an input that is no
/// longer the one in use goes. Called by `set_selected_microphone`.
pub fn selection_changed(app: &AppHandle) {
    let Some(silent) = status().silent_input else {
        return;
    };
    let selected = crate::settings::get_settings(app).selected_microphone;
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("wt-mic-selection".into())
        .spawn(move || {
            let in_use = match selected {
                Some(name) => Some(name),
                // "Standard": the system default, resolved now.
                None => suggest::candidates()
                    .into_iter()
                    .find(|c| c.is_default)
                    .map(|c| c.name),
            };
            if in_use.as_deref() != Some(silent.as_str()) {
                set(&app, MicCheck::default());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// The take slots are process-wide; these tests take turns.
    static SERIAL: Mutex<()> = Mutex::new(());

    type Tap = RawTap;

    fn take(name: &str) -> (Tap, mpsc::Receiver<TakeEvent>) {
        let (tx, rx) = mpsc::channel();
        let tap = start_take_with(format!("ca:{name}"), name.into(), move |e| {
            let _ = tx.send(e);
        });
        (tap, rx)
    }

    /// `seconds` of a tone at Nyquist with amplitude `value` (DC-free, so
    /// the detector's DC removal keeps it), in 512-sample chunks.
    fn feed_seconds(tap: &mut Tap, value: f32, seconds: f32) {
        let chunk: Vec<f32> = (0..512)
            .map(|n| if n % 2 == 0 { value } else { -value })
            .collect();
        for _ in 0..(seconds * 16_000.0 / 512.0) as usize {
            tap(&chunk);
        }
    }

    #[test]
    fn a_silent_take_raises_the_notice_while_recording_and_ends_silent() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (mut tap, events) = take("Scarlett Solo USB");
        feed_seconds(&mut tap, 0.0, 2.0);
        assert_eq!(
            events.try_iter().collect::<Vec<_>>(),
            [TakeEvent::Silent(true)]
        );
        drop(tap);
        seal_take();
        let outcome = finish_take().expect("a sealed take");
        assert_eq!(outcome.input, "Scarlett Solo USB");
        assert_eq!(outcome.input_id, "ca:Scarlett Solo USB");
        assert!(outcome.is_silent());
        // Read once.
        assert_eq!(finish_take(), None);
    }

    #[test]
    fn a_working_take_says_the_input_works_once_and_raises_no_notice() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (mut tap, events) = take("MacBook Pro-mikrofon");
        feed_seconds(&mut tap, 0.01, 2.0);
        assert_eq!(events.try_iter().collect::<Vec<_>>(), [TakeEvent::Works]);
        seal_take();
        assert!(!finish_take().unwrap().is_silent());
    }

    #[test]
    fn sound_after_the_notice_clears_it_and_the_take_is_not_silent() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (mut tap, events) = take("USB Mic");
        feed_seconds(&mut tap, 0.0, 2.0);
        feed_seconds(&mut tap, 0.05, 0.5);
        assert_eq!(
            events.try_iter().collect::<Vec<_>>(),
            [
                TakeEvent::Silent(true),
                TakeEvent::Silent(false),
                TakeEvent::Works
            ]
        );
        seal_take();
        assert!(!finish_take().unwrap().is_silent());
    }

    #[test]
    fn the_next_recording_cannot_overwrite_a_stopped_takes_verdict() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (mut first, _) = take("Scarlett Solo USB");
        feed_seconds(&mut first, 0.0, 1.0);
        seal_take();
        // The key is pressed again before the stop path read the verdict.
        let (mut second, _) = take("MacBook Pro-mikrofon");
        feed_seconds(&mut second, 0.02, 1.0);
        let outcome = finish_take().unwrap();
        assert_eq!(outcome.input, "Scarlett Solo USB");
        assert!(outcome.is_silent());
        seal_take();
        assert!(!finish_take().unwrap().is_silent());
    }

    #[test]
    fn a_short_take_is_not_called_silent() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let (mut tap, _) = take("Scarlett Solo USB");
        feed_seconds(&mut tap, 0.0, 0.3);
        seal_take();
        assert_eq!(finish_take().unwrap().verdict, Verdict::TooShort);
    }
}
