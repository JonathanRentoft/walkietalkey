//! One training session on the app's side, as pure state: what the recorder said, which phone
//! takes are coming in, and what to do about each event (the [`Action`]s, which the glue in
//! `training.rs` carries out). No Tauri, no sockets, so every path has a unit test.

use std::collections::HashMap;

use wt_relay_client::wt_protocol::{
    DeviceId, DevicePayload, ResultOutcome, ResultReason, SessionId, TrainingCheck, TrainingItem,
    TrainingLast, TrainingStyle,
};

use super::link::{pcm16_bytes, Command, HelloAnswer, TakeAnswer, TakeMeta};
use crate::walkietalkey::relay::session::SessionAudio;

pub type Key = (DeviceId, SessionId);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Phone,
    Mac,
}

/// What the glue does next, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// A training_prompt or training_end to the phone (PRIV-05).
    Phone(DeviceId, DevicePayload),
    /// Status for the recorder page.
    Event(serde_json::Value),
    MacStart(String),
    MacStop,
    MacCancel,
    /// The session is over.
    End,
}

/// The latest prompt the recorder sent.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Prompt {
    next: Option<TrainingItem>,
    last: Option<TrainingLast>,
    done: u32,
    total: u32,
}

struct PhoneTake {
    prompt: String,
    microphone: Option<String>,
    audio: SessionAudio,
    chunks: Option<u32>,
}

pub struct Session {
    pub training: SessionId,
    pub device: Device,
    pub style: TrainingStyle,
    pub phone: Option<DeviceId>,
    prompt: Option<Prompt>,
    takes: HashMap<Key, PhoneTake>,
    /// The prompt a Mac take is recording, from `mac_start` until it is handed over.
    mac: Option<String>,
}

/// A take ready for the recorder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Upload {
    pub meta: TakeMeta,
    pub pcm16: Vec<u8>,
}

impl Session {
    pub fn new(answer: &HelloAnswer) -> Result<Self, String> {
        let training = SessionId::from_b64u(&answer.training)
            .map_err(|_| "the recorder's training id is not 16 bytes".to_string())?;
        let device = match answer.device.as_str() {
            "phone" => Device::Phone,
            "mac" => Device::Mac,
            other => return Err(format!("unknown device {other}")),
        };
        let style = TrainingStyle::parse(&answer.style)
            .ok_or_else(|| format!("unknown style {}", answer.style))?;
        let phone = match (&answer.phone, device) {
            (Some(id), Device::Phone) => {
                Some(DeviceId::from_b64u(id).map_err(|_| "the recorder's phone id is not valid")?)
            }
            (None, Device::Phone) => return Err("the recorder named no phone".into()),
            _ => None,
        };
        Ok(Self {
            training,
            device,
            style,
            phone,
            prompt: None,
            takes: HashMap::new(),
            mac: None,
        })
    }

    /// The current prompt for the phone, to send again when it (or the relay) is back.
    pub fn prompt_frame(&self) -> Option<Action> {
        let (phone, prompt) = (self.phone?, self.prompt.as_ref()?);
        Some(Action::Phone(
            phone,
            DevicePayload::TrainingPrompt {
                training: self.training,
                style: self.style,
                done: prompt.done,
                total: prompt.total,
                next: prompt.next.clone(),
                last: prompt.last.clone(),
            },
        ))
    }

    pub fn end_frame(&self) -> Option<Action> {
        Some(Action::Phone(
            self.phone?,
            DevicePayload::TrainingEnd {
                training: self.training,
            },
        ))
    }

    pub fn on_command(&mut self, command: &Command) -> Vec<Action> {
        match command {
            Command::Prompt {
                next,
                last,
                done,
                total,
            } => {
                self.prompt = Some(Prompt {
                    next: next.as_ref().map(|n| TrainingItem {
                        prompt: n.prompt.clone(),
                        text: n.text.clone(),
                    }),
                    last: last.as_ref().map(|l| TrainingLast {
                        prompt: l.prompt.clone(),
                        text: l.text.clone(),
                        check: TrainingCheck::parse_lenient(&l.check),
                    }),
                    done: *done,
                    total: *total,
                });
                self.prompt_frame().into_iter().collect()
            }
            Command::MacStart { prompt } => {
                if self.device != Device::Mac || self.mac.is_some() {
                    return vec![Action::Event(serde_json::json!({
                        "type": "mac_failed", "message": "a Mac take is already recording, or this is a phone session"
                    }))];
                }
                self.mac = Some(prompt.clone());
                vec![Action::MacStart(prompt.clone())]
            }
            Command::MacStop if self.mac.is_some() => vec![Action::MacStop],
            Command::MacCancel if self.mac.is_some() => {
                self.mac = None;
                vec![Action::MacCancel]
            }
            Command::MacStop | Command::MacCancel | Command::Unknown => Vec::new(),
            // The phone hears the end when the session finishes (training.rs, finish_session).
            Command::End => vec![Action::End],
        }
    }

    /// A phone started a training take. `true`: this session takes it; `false`: it is not
    /// this session's (another phone, or the phone's prompt was from an earlier session).
    pub fn start(
        &mut self,
        key: Key,
        training: SessionId,
        prompt: &str,
        microphone: Option<String>,
    ) -> (bool, Vec<Action>) {
        if self.device != Device::Phone || Some(key.0) != self.phone || training != self.training {
            return (false, Vec::new());
        }
        self.takes.insert(
            key,
            PhoneTake {
                prompt: prompt.to_string(),
                microphone,
                audio: SessionAudio::new(),
                chunks: None,
            },
        );
        let event = serde_json::json!({"type": "recording", "prompt": prompt, "source": "phone"});
        (true, vec![Action::Event(event)])
    }

    #[cfg(test)]
    pub fn owns(&self, key: &Key) -> bool {
        self.takes.contains_key(key)
    }

    pub fn chunk(&mut self, key: &Key, index: u32, pcm: &[u8]) -> bool {
        let Some(take) = self.takes.get_mut(key) else {
            return false;
        };
        take.audio.add(index, pcm);
        true
    }

    pub fn end(&mut self, key: &Key, chunks: u32) -> bool {
        let Some(take) = self.takes.get_mut(key) else {
            return false;
        };
        take.audio.end(chunks);
        take.chunks = Some(chunks);
        true
    }

    /// Whether every block up to `audio_end` is here (else the glue waits for the resend).
    pub fn complete(&self, key: &Key) -> bool {
        self.takes
            .get(key)
            .is_none_or(|t| t.chunks.is_some() && t.audio.is_complete())
    }

    /// The finished phone take for the recorder, with the blocks that never came counted.
    pub fn phone_upload(&mut self, key: &Key) -> Option<Upload> {
        let mut take = self.takes.remove(key)?;
        let missing = take.audio.missing().len() as u32;
        take.audio.give_up_on_gaps();
        let audio = take.audio.audio();
        Some(Upload {
            meta: TakeMeta {
                prompt: take.prompt,
                source: "phone",
                session: Some(key.1.to_b64u()),
                phone: Some(key.0.to_b64u()),
                microphone: take.microphone,
                chunks: take.chunks,
                missing,
                duration_ms: (audio.len() / 16) as u32,
            },
            pcm16: pcm16_bytes(audio),
        })
    }

    /// The phone cancelled its take (slid off and let go, PHONE-26).
    pub fn cancel(&mut self, key: &Key) -> Option<Vec<Action>> {
        let take = self.takes.remove(key)?;
        Some(vec![Action::Event(
            serde_json::json!({"type": "cancelled", "prompt": take.prompt, "source": "phone"}),
        )])
    }

    /// The Mac take that `mac_stop` ended, for the recorder.
    pub fn mac_upload(&mut self, samples: &[f32], microphone: Option<String>) -> Option<Upload> {
        let prompt = self.mac.take()?;
        Some(Upload {
            meta: TakeMeta {
                prompt,
                source: "mac",
                session: None,
                phone: None,
                microphone,
                chunks: None,
                missing: 0,
                duration_ms: (samples.len() / 16) as u32,
            },
            pcm16: pcm16_bytes(samples),
        })
    }

    /// The Mac take could not start (the microphone is busy with a key dictation, say).
    pub fn mac_failed(&mut self) {
        self.mac = None;
    }

    /// The phone came online or went away: the page hears of it, and an online phone gets the
    /// current prompt again (it leaves the training screen when the computer is away, and when
    /// its own connection is new).
    pub fn on_phone(&self, phone: DeviceId, online: bool) -> Vec<Action> {
        if Some(phone) != self.phone {
            return Vec::new();
        }
        let mut out = vec![Action::Event(serde_json::json!({
            "type": "phone", "id": phone.to_b64u(), "online": online
        }))];
        if online {
            out.extend(self.prompt_frame());
        }
        out
    }

    /// The phones whose takes are still coming in (they get an error result if the session
    /// ends first).
    pub fn open_takes(&self) -> Vec<Key> {
        self.takes.keys().copied().collect()
    }
}

/// The phone's result for a take the recorder judged: kept takes are ok (a failed check is
/// shown with the next prompt and offered for a redo), a silent one "no speech".
pub fn outcome(answer: &TakeAnswer) -> ResultOutcome {
    if answer.saved {
        ResultOutcome::Ok
    } else if answer.check == "silent" {
        ResultOutcome::Failed(ResultReason::NoSpeech)
    } else {
        ResultOutcome::Failed(ResultReason::Error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::walkietalkey::relay::training::link::{PromptItem, PromptLast};

    const PHONE: DeviceId = DeviceId([3; 16]);
    const OTHER: DeviceId = DeviceId([4; 16]);
    const TRAINING: SessionId = SessionId([9; 16]);

    fn answer(device: &str) -> HelloAnswer {
        HelloAnswer {
            training: TRAINING.to_b64u(),
            device: device.into(),
            style: "whisper".into(),
            phone: (device == "phone").then(|| PHONE.to_b64u()),
        }
    }

    fn prompt(next: Option<&str>, last: Option<(&str, &str)>) -> Command {
        Command::Prompt {
            next: next.map(|p| PromptItem {
                prompt: p.into(),
                text: format!("Tekst til {p}."),
            }),
            last: last.map(|(p, check)| PromptLast {
                prompt: p.into(),
                text: format!("Tekst til {p}."),
                check: check.into(),
            }),
            done: 1,
            total: 3,
        }
    }

    fn block(value: i16, samples: usize) -> Vec<u8> {
        std::iter::repeat_n(value.to_le_bytes(), samples)
            .flatten()
            .collect()
    }

    #[test]
    fn a_prompt_goes_to_the_sessions_phone_as_a_training_prompt() {
        let mut s = Session::new(&answer("phone")).unwrap();
        assert_eq!(s.prompt_frame(), None, "nothing before the first prompt");
        let actions = s.on_command(&prompt(Some("s0002"), Some(("s0001", "quiet"))));
        let [Action::Phone(
            to,
            DevicePayload::TrainingPrompt {
                training,
                style,
                done,
                total,
                next,
                last,
            },
        )] = actions.as_slice()
        else {
            panic!("{actions:?}");
        };
        assert_eq!(
            (*to, *training, *style, *done, *total),
            (PHONE, TRAINING, TrainingStyle::Whisper, 1, 3)
        );
        assert_eq!(next.as_ref().unwrap().prompt, "s0002");
        assert_eq!(last.as_ref().unwrap().check, TrainingCheck::Quiet);
        // A newer recorder's check reads as error, like a result reason.
        let actions = s.on_command(&prompt(None, Some(("s0003", "too_fast"))));
        assert!(
            matches!(&actions[0], Action::Phone(_, DevicePayload::TrainingPrompt { last: Some(l), next: None, .. }) if l.check == TrainingCheck::Error)
        );
    }

    #[test]
    fn a_mac_session_sends_nothing_to_a_phone() {
        let mut s = Session::new(&answer("mac")).unwrap();
        assert!(s.on_command(&prompt(Some("s0001"), None)).is_empty());
        assert_eq!(s.on_command(&Command::End), vec![Action::End]);
    }

    #[test]
    fn the_end_has_a_frame_for_the_phone() {
        let mut s = Session::new(&answer("phone")).unwrap();
        assert_eq!(s.on_command(&Command::End), vec![Action::End]);
        assert_eq!(
            s.end_frame(),
            Some(Action::Phone(
                PHONE,
                DevicePayload::TrainingEnd { training: TRAINING }
            ))
        );
        assert_eq!(Session::new(&answer("mac")).unwrap().end_frame(), None);
    }

    #[test]
    fn a_phone_take_is_assembled_and_handed_over_as_it_came() {
        let mut s = Session::new(&answer("phone")).unwrap();
        let key = (PHONE, SessionId([5; 16]));
        let (mine, actions) = s.start(key, TRAINING, "s0001", Some("iPhone-mikrofon".into()));
        assert!(mine && s.owns(&key));
        assert!(
            matches!(&actions[0], Action::Event(v) if v["type"] == "recording" && v["prompt"] == "s0001")
        );
        // Two blocks arrive out of order, then the end.
        assert!(s.chunk(&key, 1, &block(200, 3200)));
        assert!(!s.complete(&key));
        assert!(s.chunk(&key, 0, &block(100, 3200)));
        assert!(s.end(&key, 2));
        assert!(s.complete(&key));
        let up = s.phone_upload(&key).unwrap();
        assert_eq!(up.meta.prompt, "s0001");
        assert_eq!(up.meta.source, "phone");
        assert_eq!(up.meta.microphone.as_deref(), Some("iPhone-mikrofon"));
        assert_eq!(
            (up.meta.chunks, up.meta.missing, up.meta.duration_ms),
            (Some(2), 0, 400)
        );
        assert_eq!(up.pcm16, [block(100, 3200), block(200, 3200)].concat());
        assert!(!s.owns(&key));
    }

    #[test]
    fn missing_blocks_are_counted_for_the_recorder() {
        let mut s = Session::new(&answer("phone")).unwrap();
        let key = (PHONE, SessionId([6; 16]));
        s.start(key, TRAINING, "s0001", None);
        s.chunk(&key, 0, &block(1, 3200));
        s.chunk(&key, 2, &block(3, 3200));
        s.end(&key, 3);
        assert!(!s.complete(&key));
        let up = s.phone_upload(&key).unwrap();
        assert_eq!(up.meta.missing, 1);
    }

    #[test]
    fn a_take_from_another_phone_or_session_is_not_this_sessions() {
        let mut s = Session::new(&answer("phone")).unwrap();
        assert!(
            !s.start((OTHER, SessionId([1; 16])), TRAINING, "s0001", None)
                .0
        );
        assert!(
            !s.start(
                (PHONE, SessionId([1; 16])),
                SessionId([8; 16]),
                "s0001",
                None
            )
            .0
        );
        let mut mac = Session::new(&answer("mac")).unwrap();
        assert!(
            !mac.start((PHONE, SessionId([1; 16])), TRAINING, "s0001", None)
                .0
        );
    }

    #[test]
    fn a_cancelled_take_is_dropped_and_the_page_hears_of_it() {
        let mut s = Session::new(&answer("phone")).unwrap();
        let key = (PHONE, SessionId([7; 16]));
        s.start(key, TRAINING, "s0002", None);
        let actions = s.cancel(&key).unwrap();
        assert!(matches!(&actions[0], Action::Event(v) if v["type"] == "cancelled"));
        assert!(!s.owns(&key) && s.cancel(&key).is_none());
    }

    /// PHONE-52 (PROTOCOL.md 8.4): the phone's "Spring over" is a training take for
    /// `skip:<prompt>` that it cancels at once, with no blocks. The installed desktop passes it
    /// to the recorder as a recording and a cancel with the prefixed prompt, and sends the
    /// phone nothing: no result, no prompt, no end. The recorder reads it as "Spring over". This
    /// pins that, so a desktop change cannot break the phone's skip without a failing test.
    #[test]
    fn a_skip_is_an_empty_cancelled_take_the_recorder_hears_of_and_the_phone_does_not() {
        use wt_relay_client::wt_protocol::consts::{frame_type, MAX_PROMPT_ID_BYTES};

        let mut s = Session::new(&answer("phone")).unwrap();
        s.on_command(&prompt(Some("s0042"), Some(("s0041", "ok"))));
        let key = (PHONE, SessionId([11; 16]));
        let (mine, actions) = s.start(key, TRAINING, "skip:s0042", Some("iPhone-mikrofon".into()));
        assert!(
            mine,
            "the session's own phone and training id: this session's"
        );
        assert_eq!(
            actions,
            vec![Action::Event(serde_json::json!({
                "type": "recording", "prompt": "skip:s0042", "source": "phone"
            }))]
        );
        let actions = s.cancel(&key).expect("the skip is this session's take");
        assert_eq!(
            actions,
            vec![Action::Event(serde_json::json!({
                "type": "cancelled", "prompt": "skip:s0042", "source": "phone"
            }))],
            "only the page hears of it; nothing goes to the phone"
        );
        assert!(!s.owns(&key) && s.open_takes().is_empty());
        assert!(
            s.phone_upload(&key).is_none(),
            "never handed over as a take"
        );
        assert!(s.cancel(&key).is_none(), "a second cancel is nobody's");

        // `skip:` (5 bytes) plus the longest prompt id the recorder uses still fits the
        // protocol's 64 bytes; the phone refuses to skip when it would not (training/state.ts).
        let longest = format!("skip:{}", "p".repeat(MAX_PROMPT_ID_BYTES - 5));
        let start = DevicePayload::AudioStartTraining {
            session_id: SessionId([12; 16]),
            training: TRAINING,
            prompt: longest.clone(),
            microphone: None,
        };
        let bytes = start.encode().unwrap();
        assert_eq!(
            DevicePayload::decode(frame_type::AUDIO_START_TRAINING, &bytes).unwrap(),
            start
        );
        let too_long = DevicePayload::AudioStartTraining {
            session_id: SessionId([12; 16]),
            training: TRAINING,
            prompt: format!("{longest}p"),
            microphone: None,
        };
        assert!(too_long.encode().is_err());
    }

    #[test]
    fn mac_takes_follow_the_pages_start_and_stop() {
        let mut s = Session::new(&answer("mac")).unwrap();
        assert!(
            s.on_command(&Command::MacStop).is_empty(),
            "nothing to stop"
        );
        assert_eq!(
            s.on_command(&Command::MacStart {
                prompt: "s0001".into()
            }),
            vec![Action::MacStart("s0001".into())]
        );
        // A second start while recording is refused.
        assert!(
            matches!(&s.on_command(&Command::MacStart { prompt: "s0002".into() })[0], Action::Event(v) if v["type"] == "mac_failed")
        );
        assert_eq!(s.on_command(&Command::MacStop), vec![Action::MacStop]);
        let up = s
            .mac_upload(&[0.5; 1600], Some("MacBook Pro-mikrofon".into()))
            .unwrap();
        assert_eq!(
            (up.meta.source, up.meta.prompt.as_str(), up.meta.duration_ms),
            ("mac", "s0001", 100)
        );
        assert_eq!(up.meta.microphone.as_deref(), Some("MacBook Pro-mikrofon"));
        assert_eq!(&up.pcm16[..2], &16384i16.to_le_bytes());
        assert!(s.mac_upload(&[0.0], None).is_none(), "handed over once");
        s.on_command(&Command::MacStart {
            prompt: "s0002".into(),
        });
        assert_eq!(s.on_command(&Command::MacCancel), vec![Action::MacCancel]);
        assert!(s.mac_upload(&[0.0], None).is_none());
    }

    #[test]
    fn the_phone_back_online_gets_the_prompt_again() {
        let mut s = Session::new(&answer("phone")).unwrap();
        s.on_command(&prompt(Some("s0001"), None));
        let actions = s.on_phone(PHONE, true);
        assert!(matches!(&actions[0], Action::Event(v) if v["online"] == true));
        assert!(
            matches!(&actions[1], Action::Phone(p, DevicePayload::TrainingPrompt { .. }) if *p == PHONE)
        );
        assert_eq!(s.on_phone(PHONE, false).len(), 1);
        assert!(s.on_phone(OTHER, true).is_empty());
    }

    #[test]
    fn results_for_the_phone_never_carry_text() {
        let a = |saved, check: &str| TakeAnswer {
            saved,
            check: check.into(),
        };
        assert_eq!(outcome(&a(true, "ok")), ResultOutcome::Ok);
        assert_eq!(outcome(&a(true, "quiet")), ResultOutcome::Ok);
        assert_eq!(
            outcome(&a(false, "silent")),
            ResultOutcome::Failed(ResultReason::NoSpeech)
        );
        assert_eq!(
            outcome(&a(false, "gaps")),
            ResultOutcome::Failed(ResultReason::Error)
        );
    }

    #[test]
    fn a_hello_answer_must_make_sense() {
        assert!(Session::new(&HelloAnswer {
            training: "short".into(),
            ..answer("phone")
        })
        .is_err());
        assert!(Session::new(&HelloAnswer {
            style: "loud".into(),
            ..answer("phone")
        })
        .is_err());
        assert!(Session::new(&HelloAnswer {
            phone: None,
            ..answer("phone")
        })
        .is_err());
        assert!(Session::new(&HelloAnswer {
            device: "tablet".into(),
            ..answer("phone")
        })
        .is_err());
    }
}
