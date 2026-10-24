//! After a silent take (DESK-59): which other input delivers sound? Only
//! after a silent take or when the user asks, never continuously. Each
//! candidate is opened briefly by its ID (inputs only, never the system
//! audio: virtual devices are skipped and the no-loopback guard applies), in
//! this order: the system default, the built-in microphone, then the rest.
//! The first that delivers sound is offered.

use std::sync::mpsc;
use std::time::Duration;

use handy_recorder::{AudioChunk, Recorder, RecorderConfig, Sink};
use log::{debug, info, warn};

use super::guard;
use super::level::{SilenceDetector, WINDOW};

/// How long a probe listens once audio flows. A working microphone's room
/// tone clears the floor in its first windows; 500 ms leaves room for a
/// device that starts with a few hundred ms of zeros.
pub const PROBE_LISTEN: Duration = Duration::from_millis(500);
/// A device that has not delivered its first audio by then is not working
/// (Bluetooth can take a second or two to switch to its microphone).
pub const PROBE_FIRST_AUDIO: Duration = Duration::from_millis(2_000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    /// The computer's own microphone.
    BuiltIn,
    /// Software routing or an aggregate: other apps' audio, not a microphone.
    Virtual,
    Other,
}

/// An input the probe may try.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    /// The handy-recorder (cpal) device ID.
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub kind: InputKind,
}

/// What probing one input found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    Sound,
    Silent,
    /// It would not open, or no audio came.
    Failed,
}

/// The inputs worth probing, best first: not the silent input (nor another
/// device with its name, which would read "X gives no sound, try X"), never
/// a virtual device; the system default, then the built-in microphone,
/// then the rest in the system's order.
pub fn probe_order(devices: Vec<Candidate>, silent_id: &str, silent_name: &str) -> Vec<Candidate> {
    let mut order: Vec<Candidate> = devices
        .into_iter()
        .filter(|d| d.id != silent_id && d.name != silent_name && d.kind != InputKind::Virtual)
        .collect();
    order.sort_by_key(|d| match (d.is_default, d.kind) {
        (true, _) => 0,
        (false, InputKind::BuiltIn) => 1,
        _ => 2,
    });
    order
}

/// The first input in `order` that delivers sound, probing one at a time.
pub fn first_that_works(
    order: &[Candidate],
    mut probe: impl FnMut(&Candidate) -> Probe,
) -> Option<Candidate> {
    order
        .iter()
        .find(|candidate| {
            let result = probe(candidate);
            info!("Microphone probe: {:?} -> {result:?}", candidate.name);
            result == Probe::Sound
        })
        .cloned()
}

/// The system's inputs as candidates. PulseAudio monitors (a speaker's
/// output) are left out like in the microphone list.
pub fn candidates() -> Vec<Candidate> {
    let devices = match handy_recorder::list_input_devices() {
        Ok(devices) => devices,
        Err(e) => {
            warn!("Microphone probe: cannot list inputs: {e}");
            return Vec::new();
        }
    };
    #[cfg(target_os = "macos")]
    let facts = super::coreaudio::devices();
    devices
        .into_iter()
        .filter(|d| !d.is_monitor)
        .map(|d| {
            #[cfg(target_os = "macos")]
            let kind = kind_of(&d.id, &facts);
            #[cfg(not(target_os = "macos"))]
            let kind = InputKind::Other;
            Candidate {
                id: d.id,
                name: d.name,
                is_default: d.is_default,
                kind,
            }
        })
        .collect()
}

/// A cpal device ID is `<host>:<uid>`; the UID may itself hold colons.
#[cfg(target_os = "macos")]
fn kind_of(id: &str, facts: &[super::coreaudio::DeviceFacts]) -> InputKind {
    let uid = id.split_once(':').map_or(id, |(_, uid)| uid);
    facts
        .iter()
        .find(|f| f.uid == uid)
        .map_or(InputKind::Other, |f| f.kind)
}

/// Feeds the level detector and says when audio first flows.
struct ProbeSink {
    detector: SilenceDetector,
    first: Option<mpsc::Sender<()>>,
}

impl Sink for ProbeSink {
    fn process_chunk(&mut self, chunk: AudioChunk<'_>) {
        if let Some(first) = self.first.take() {
            let _ = first.send(());
        }
        self.detector.feed(&chunk.samples[..chunk.valid_frames]);
    }
}

/// Opens the input `id` (never the system default, so never an unchecked
/// device), listens for [`PROBE_LISTEN`], and closes it. Nothing is kept.
pub fn probe_input(id: &str) -> Probe {
    let config = RecorderConfig {
        device: Some(id.to_owned()),
        frames_per_chunk: Some(WINDOW),
        ..RecorderConfig::speech()
    };
    let recorder = match Recorder::<ProbeSink>::open(config) {
        Ok(recorder) => recorder,
        Err(e) => {
            debug!("Microphone probe: {id:?} would not open: {e}");
            return Probe::Failed;
        }
    };
    if guard::refuse_loopback().is_err() {
        let _ = recorder.close();
        return Probe::Failed;
    }
    let (first, first_audio) = mpsc::channel();
    let sink = ProbeSink {
        detector: SilenceDetector::new(),
        first: Some(first),
    };
    if let Err(e) = recorder.start(sink) {
        debug!("Microphone probe: {id:?} would not start: {e}");
        let _ = recorder.close();
        return Probe::Failed;
    }
    let flowed = first_audio.recv_timeout(PROBE_FIRST_AUDIO).is_ok();
    if flowed {
        std::thread::sleep(PROBE_LISTEN);
    }
    let result = match recorder.stop() {
        Ok(stopped) if flowed && stopped.sink.detector.is_alive() => Probe::Sound,
        Ok(_) if flowed => Probe::Silent,
        Ok(_) => Probe::Failed,
        Err(e) => {
            debug!("Microphone probe: {id:?} failed: {e}");
            Probe::Failed
        }
    };
    let _ = recorder.close();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: &str, name: &str, is_default: bool, kind: InputKind) -> Candidate {
        Candidate {
            id: id.into(),
            name: name.into(),
            is_default,
            kind,
        }
    }

    /// The owner's Mac on 24 October 2026 (system_profiler), with the
    /// Scarlett as the default input.
    fn owners_mac() -> Vec<Candidate> {
        vec![
            input("ca:scarlett", "Scarlett Solo USB", true, InputKind::Other),
            input("ca:blackhole", "BlackHole 2ch", false, InputKind::Virtual),
            input(
                "ca:builtin",
                "MacBook Pro-mikrofon",
                false,
                InputKind::BuiltIn,
            ),
        ]
    }

    fn names(order: &[Candidate]) -> Vec<&str> {
        order.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn the_silent_default_is_skipped_and_the_built_in_microphone_comes_first() {
        let order = probe_order(owners_mac(), "ca:scarlett", "Scarlett Solo USB");
        // BlackHole carries other apps' audio: never probed.
        assert_eq!(names(&order), ["MacBook Pro-mikrofon"]);
    }

    #[test]
    fn the_system_default_comes_before_the_built_in_microphone() {
        let devices = vec![
            input("ca:usb", "Rode NT-USB", false, InputKind::Other),
            input(
                "ca:builtin",
                "MacBook Pro-mikrofon",
                false,
                InputKind::BuiltIn,
            ),
            input("ca:airpods", "AirPods Pro", true, InputKind::Other),
            input("ca:scarlett", "Scarlett Solo USB", false, InputKind::Other),
        ];
        let order = probe_order(devices, "ca:scarlett", "Scarlett Solo USB");
        assert_eq!(
            names(&order),
            ["AirPods Pro", "MacBook Pro-mikrofon", "Rode NT-USB"]
        );
    }

    #[test]
    fn a_second_device_with_the_silent_inputs_name_is_not_offered() {
        let devices = vec![
            input("ca:a", "USB Mic", true, InputKind::Other),
            input("ca:b", "USB Mic", false, InputKind::Other),
            input("ca:c", "Webcam", false, InputKind::Other),
        ];
        assert_eq!(names(&probe_order(devices, "ca:a", "USB Mic")), ["Webcam"]);
    }

    #[test]
    fn the_first_input_with_sound_is_offered_and_probing_stops_there() {
        let devices = vec![
            input("ca:default", "Headset", true, InputKind::Other),
            input(
                "ca:builtin",
                "MacBook Pro-mikrofon",
                false,
                InputKind::BuiltIn,
            ),
            input("ca:usb", "Rode NT-USB", false, InputKind::Other),
        ];
        let order = probe_order(devices, "ca:scarlett", "Scarlett Solo USB");
        let mut probed = Vec::new();
        let found = first_that_works(&order, |c| {
            probed.push(c.id.clone());
            match c.id.as_str() {
                "ca:default" => Probe::Silent,
                "ca:builtin" => Probe::Sound,
                _ => Probe::Sound,
            }
        });
        assert_eq!(found.map(|c| c.name), Some("MacBook Pro-mikrofon".into()));
        assert_eq!(probed, ["ca:default", "ca:builtin"]);
    }

    #[test]
    fn a_device_that_fails_to_open_is_passed_over() {
        let order = probe_order(
            vec![
                input("ca:bt", "AirPods Pro", true, InputKind::Other),
                input("ca:usb", "Rode NT-USB", false, InputKind::Other),
            ],
            "ca:x",
            "X",
        );
        let found = first_that_works(&order, |c| {
            if c.id == "ca:bt" {
                Probe::Failed
            } else {
                Probe::Sound
            }
        });
        assert_eq!(found.map(|c| c.id), Some("ca:usb".into()));
    }

    #[test]
    fn when_no_input_works_there_is_no_suggestion() {
        let order = probe_order(owners_mac(), "ca:scarlett", "Scarlett Solo USB");
        assert_eq!(first_that_works(&order, |_| Probe::Silent), None);
        assert_eq!(first_that_works(&[], |_| Probe::Sound), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_cpal_id_maps_to_its_coreaudio_kind_by_uid() {
        use super::super::coreaudio::DeviceFacts;
        let facts = vec![
            DeviceFacts {
                uid: "BuiltInMicrophoneDevice".into(),
                kind: InputKind::BuiltIn,
            },
            DeviceFacts {
                uid: "AA-BB-CC:input".into(),
                kind: InputKind::Other,
            },
            DeviceFacts {
                uid: "BlackHole2ch_UID".into(),
                kind: InputKind::Virtual,
            },
        ];
        assert_eq!(
            kind_of("CoreAudio:BuiltInMicrophoneDevice", &facts),
            InputKind::BuiltIn
        );
        assert_eq!(
            kind_of("CoreAudio:AA-BB-CC:input", &facts),
            InputKind::Other
        );
        assert_eq!(
            kind_of("CoreAudio:BlackHole2ch_UID", &facts),
            InputKind::Virtual
        );
        assert_eq!(kind_of("CoreAudio:gone", &facts), InputKind::Other);
    }
}
