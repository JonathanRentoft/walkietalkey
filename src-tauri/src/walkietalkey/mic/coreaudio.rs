//! CoreAudio facts the recorder does not expose (macOS): each device's UID
//! and transport type. Read-only property queries; nothing here opens a
//! stream. Written after handy-recorder's `backend/headset_macos.rs` (MIT).

use std::{
    ffi::c_void,
    ptr::{null, NonNull},
};

use objc2_core_audio::{
    kAudioDevicePropertyDeviceUID, kAudioDevicePropertyTransportType,
    kAudioDeviceTransportTypeAggregate, kAudioDeviceTransportTypeBuiltIn,
    kAudioDeviceTransportTypeVirtual, kAudioHardwarePropertyDevices,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize, AudioObjectID,
    AudioObjectPropertyAddress, AudioObjectPropertySelector,
};
use objc2_core_foundation::{CFRetained, CFString};

use super::suggest::InputKind;

/// One CoreAudio device, as far as WalkieTalkey needs to know it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceFacts {
    /// `kAudioDevicePropertyDeviceUID`: the part of a cpal device ID after
    /// the host name.
    pub uid: String,
    pub kind: InputKind,
}

/// Every device this process can see, including its own private aggregate
/// devices (cpal's loopback tap is one).
pub fn devices() -> Vec<DeviceFacts> {
    ids(
        kAudioObjectSystemObject as AudioObjectID,
        kAudioHardwarePropertyDevices,
    )
    .into_iter()
    .filter_map(|device| {
        Some(DeviceFacts {
            uid: uid(device)?,
            kind: kind(scalar(device, kAudioDevicePropertyTransportType)),
        })
    })
    .collect()
}

fn kind(transport: Option<u32>) -> InputKind {
    match transport {
        Some(t) if t == kAudioDeviceTransportTypeBuiltIn => InputKind::BuiltIn,
        // Software routing (BlackHole, Loopback, meeting apps' drivers) and
        // aggregates carry other apps' audio, not a microphone.
        Some(t) if t == kAudioDeviceTransportTypeVirtual => InputKind::Virtual,
        Some(t) if t == kAudioDeviceTransportTypeAggregate => InputKind::Virtual,
        _ => InputKind::Other,
    }
}

fn address(selector: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

/// A property holding an array of object IDs.
fn ids(object: AudioObjectID, selector: AudioObjectPropertySelector) -> Vec<AudioObjectID> {
    let address = address(selector);
    let mut size = 0u32;
    // SAFETY: the address and size outlive the call.
    let status = unsafe {
        AudioObjectGetPropertyDataSize(
            object,
            NonNull::from(&address),
            0,
            null(),
            NonNull::from(&mut size),
        )
    };
    if status != 0 || size == 0 {
        return Vec::new();
    }
    let mut out = vec![0 as AudioObjectID; size as usize / size_of::<AudioObjectID>()];
    let mut size = (out.len() * size_of::<AudioObjectID>()) as u32;
    let Some(data) = NonNull::new(out.as_mut_ptr()) else {
        return Vec::new();
    };
    // SAFETY: `out` has room for `size` bytes; CoreAudio writes at most that
    // many and updates `size` to what it wrote.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&address),
            0,
            null(),
            NonNull::from(&mut size),
            data.cast::<c_void>(),
        )
    };
    if status != 0 {
        return Vec::new();
    }
    out.truncate(size as usize / size_of::<AudioObjectID>());
    out
}

fn scalar(object: AudioObjectID, selector: AudioObjectPropertySelector) -> Option<u32> {
    let address = address(selector);
    let mut value = 0u32;
    let mut size = size_of::<u32>() as u32;
    // SAFETY: `value` has room for the `size` bytes CoreAudio may write.
    let status = unsafe {
        AudioObjectGetPropertyData(
            object,
            NonNull::from(&address),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::from(&mut value).cast(),
        )
    };
    (status == 0 && size == size_of::<u32>() as u32).then_some(value)
}

fn uid(device: AudioObjectID) -> Option<String> {
    let address = address(kAudioDevicePropertyDeviceUID);
    let mut uid: *mut CFString = std::ptr::null_mut();
    let mut size = size_of::<*mut CFString>() as u32;
    // SAFETY: the UID property is a CFString pointer returned under the
    // create rule (+1), which `CFRetained::from_raw` takes over.
    let status = unsafe {
        AudioObjectGetPropertyData(
            device,
            NonNull::from(&address),
            0,
            null(),
            NonNull::from(&mut size),
            NonNull::from(&mut uid).cast(),
        )
    };
    if status != 0 {
        return None;
    }
    let uid = NonNull::new(uid)?;
    // SAFETY: see above; the pointer is non-null and owned.
    Some(unsafe { CFRetained::from_raw(uid) }.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transport_types_map_to_input_kinds() {
        assert_eq!(
            kind(Some(kAudioDeviceTransportTypeBuiltIn)),
            InputKind::BuiltIn
        );
        assert_eq!(
            kind(Some(kAudioDeviceTransportTypeVirtual)),
            InputKind::Virtual
        );
        assert_eq!(
            kind(Some(kAudioDeviceTransportTypeAggregate)),
            InputKind::Virtual
        );
        // USB, Bluetooth, unknown.
        assert_eq!(kind(Some(0x75736220)), InputKind::Other);
        assert_eq!(kind(None), InputKind::Other);
    }

    #[test]
    fn listing_devices_opens_nothing_and_does_not_panic() {
        // Property reads only; on a machine without audio it is empty.
        let devices = devices();
        assert!(devices.iter().all(|d| !d.uid.is_empty()));
    }
}
