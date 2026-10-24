//! Never record the system audio (DESK-59). WalkieTalkey only ever needs a
//! microphone, but cpal 0.18 on macOS records the *system audio* through a
//! process tap (`host/coreaudio/macos/device.rs`, `build_input_stream_raw`)
//! whenever an input stream is built on a device whose `supports_input()` is
//! false, silently and without an error. macOS then lists the app under
//! "System Audio Recording Only", and the take is either the user's music or,
//! with that permission off, digital silence.
//!
//! The one place WalkieTalkey opens an input stream is handy-recorder's
//! `open_device`. With a device ID it only accepts devices from
//! `input_devices()`, which cpal filters with that same `supports_input()`.
//! With no ID (the system default, the default setting) it falls back to
//! the default device *unfiltered* when the device is not among the inputs,
//! which is the path into the tap. So on macOS the default is resolved here,
//! to an input-capable device's ID, or refused. After opening, the guard
//! also checks that cpal did not build its loopback aggregate device after
//! all (`supports_input()` is a live query that can change between the
//! filter and the build), and refuses the stream if it did.
//!
//! Windows and Linux need neither step: WASAPI's default input is always a
//! capture endpoint and loopback needs a render device, which
//! handy-recorder's input list never holds; PulseAudio monitors are flagged
//! and kept out of the microphone list.

use std::fmt;

/// Why an input stream was refused instead of opened.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InputRefused {
    /// The system reports no default input at all.
    NoDefaultInput,
    /// The system default has no input channels (an output-only device).
    NotAnInput(String),
    /// cpal built a tap of the system audio after all.
    Loopback,
}

impl fmt::Display for InputRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoDefaultInput => write!(f, "the system has no default input device"),
            Self::NotAnInput(name) => write!(
                f,
                "the default input {name:?} has no input channels; refusing to record it (cpal would record the system audio instead)"
            ),
            Self::Loopback => write!(
                f,
                "the input stream turned out to be a recording of the system audio; refused"
            ),
        }
    }
}

impl std::error::Error for InputRefused {}

/// What the system says about its default input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DefaultInput {
    /// The cpal device ID, as handy-recorder lists it; `None` if the device
    /// has no UID.
    pub id: Option<String>,
    /// cpal's own `supports_input()`, the test it uses to choose the tap.
    pub supports_input: bool,
    pub name: String,
}

/// The device to open for "the system default": its ID, so handy-recorder
/// takes its filtered path, or a refusal. `Ok(None)` (open the default the
/// recorder resolves) only when the device has no ID but does have input.
pub fn choose_default(default: Option<DefaultInput>) -> Result<Option<String>, InputRefused> {
    match default {
        None => Err(InputRefused::NoDefaultInput),
        Some(d) if !d.supports_input => Err(InputRefused::NotAnInput(d.name)),
        Some(d) => Ok(d.id),
    }
}

/// The device ID to hand handy-recorder for `device` (`None`: the system
/// default). A named device passes unchanged: handy-recorder only opens it
/// if it is an input.
pub fn resolve(device: Option<String>) -> Result<Option<String>, InputRefused> {
    if device.is_some() {
        return Ok(device);
    }
    #[cfg(target_os = "macos")]
    {
        choose_default(default_input())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

#[cfg(target_os = "macos")]
fn default_input() -> Option<DefaultInput> {
    use rodio::cpal::traits::{DeviceTrait, HostTrait};
    let device = rodio::cpal::default_host().default_input_device()?;
    let supports_input = device.supports_input();
    Some(DefaultInput {
        id: device.id().ok().map(|id| id.to_string()),
        supports_input,
        // Only needed for the refusal; it costs a few more queries.
        name: if supports_input {
            String::new()
        } else {
            device
                .description()
                .map(|d| d.name().to_owned())
                .unwrap_or_else(|_| "?".into())
        },
    })
}

/// The UID prefix of cpal's loopback aggregate devices for process `pid`
/// (`loopback.rs`: `com.cpal.LoopbackRecordAggregateDevice.{pid}.{n}`).
pub fn is_own_loopback(uid: &str, pid: u32) -> bool {
    uid.strip_prefix("com.cpal.LoopbackRecordAggregateDevice.")
        .and_then(|rest| rest.split_once('.'))
        .is_some_and(|(p, _)| p == pid.to_string())
}

/// After an input stream opened: refuse it if cpal made it a tap of the
/// system audio. The aggregate is private, so only this process sees it.
pub fn refuse_loopback() -> Result<(), InputRefused> {
    #[cfg(target_os = "macos")]
    {
        let pid = std::process::id();
        if super::coreaudio::devices()
            .iter()
            .any(|d| is_own_loopback(&d.uid, pid))
        {
            log::error!("cpal opened a process tap of the system audio; closing it");
            return Err(InputRefused::Loopback);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: Option<&str>, supports_input: bool, name: &str) -> Option<DefaultInput> {
        Some(DefaultInput {
            id: id.map(str::to_owned),
            supports_input,
            name: name.to_owned(),
        })
    }

    #[test]
    fn a_default_with_input_channels_is_opened_by_its_id() {
        assert_eq!(
            choose_default(device(
                Some("CoreAudio:BuiltInMicrophoneDevice"),
                true,
                "MacBook Pro-mikrofon"
            )),
            Ok(Some("CoreAudio:BuiltInMicrophoneDevice".to_owned()))
        );
    }

    #[test]
    fn an_output_only_default_is_refused_never_recorded() {
        // cpal would build a process tap of the system audio here.
        let refused = choose_default(device(Some("CoreAudio:hdmi"), false, "MSI MP341CQ"));
        assert_eq!(refused, Err(InputRefused::NotAnInput("MSI MP341CQ".into())));
        assert!(refused.unwrap_err().to_string().contains("system audio"));
    }

    #[test]
    fn no_default_input_is_refused() {
        assert_eq!(choose_default(None), Err(InputRefused::NoDefaultInput));
    }

    #[test]
    fn a_default_without_a_uid_falls_back_to_the_recorders_own_resolution() {
        assert_eq!(choose_default(device(None, true, "")), Ok(None));
    }

    #[test]
    fn a_named_device_is_left_to_handy_recorders_input_filter() {
        assert_eq!(
            resolve(Some("CoreAudio:usb".into())),
            Ok(Some("CoreAudio:usb".into()))
        );
    }

    #[test]
    fn only_this_processs_loopback_aggregates_count() {
        let pid = 4242;
        assert!(is_own_loopback(
            "com.cpal.LoopbackRecordAggregateDevice.4242.0",
            pid
        ));
        assert!(is_own_loopback(
            "com.cpal.LoopbackRecordAggregateDevice.4242.17",
            pid
        ));
        assert!(!is_own_loopback(
            "com.cpal.LoopbackRecordAggregateDevice.42420.0",
            pid
        ));
        assert!(!is_own_loopback(
            "com.cpal.LoopbackRecordAggregateDevice.99.0",
            pid
        ));
        assert!(!is_own_loopback("BuiltInMicrophoneDevice", pid));
        assert!(!is_own_loopback("AppleUSBAudioEngine:Focusrite", pid));
    }

    #[test]
    fn a_process_that_built_no_tap_passes_the_check() {
        assert_eq!(refuse_loopback(), Ok(()));
    }

    #[test]
    fn refusals_are_reported_as_no_input_device() {
        for refused in [
            InputRefused::NoDefaultInput,
            InputRefused::NotAnInput("x".into()),
            InputRefused::Loopback,
        ] {
            let error = anyhow::Error::new(refused).context("Failed to open microphone stream");
            assert_eq!(
                crate::managers::audio::recording_error_type(&error),
                "no_input_device"
            );
        }
    }
}
