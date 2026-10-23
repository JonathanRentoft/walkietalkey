//! Managed settings for companies (DESK-100..102, Appendix B): the raw values a configuration
//! profile or Group Policy set. The app's `walkietalkey::managed::apply` validates them and
//! lays them over the user's settings; every value returned here is locked (DESK-101).
//!
//! - **macOS**: `CFPreferencesCopyAppValue` for domain `com.walkietalkey.app`, keeping only
//!   values for which `CFPreferencesAppValueIsForced` is true, i.e. the ones a configuration
//!   profile (Jamf, Intune, Kandji...) installed. What the user wrote with `defaults` is ignored.
//! - **Windows**: `HKLM\SOFTWARE\Policies\WalkieTalkey` in the 64-bit view. `REG_SZ` becomes
//!   [`ManagedValue::Text`], `REG_EXPAND_SZ` too after `%VAR%` expansion, `REG_DWORD` and
//!   `REG_QWORD` become [`ManagedValue::Int`]. A DWORD is read as signed, so `0xFFFFFFFF` is
//!   `-1` (`HistoryRetentionDays` = "Altid").
//! - Elsewhere: nothing is managed.

use std::collections::BTreeMap;

/// A value as the platform store holds it: plist strings, booleans and integers; registry
/// REG_SZ and REG_DWORD. Identical to the app's `walkietalkey::managed::ManagedValue`, so it
/// converts one-to-one.
#[derive(Debug, Clone, PartialEq)]
pub enum ManagedValue {
    Text(String),
    Bool(bool),
    Int(i64),
}

/// The macOS preferences domain (the app's bundle identifier).
pub const DOMAIN: &str = "com.walkietalkey.app";

/// The Windows policy key under `HKEY_LOCAL_MACHINE`.
pub const POLICY_KEY: &str = r"SOFTWARE\Policies\WalkieTalkey";

/// Every Appendix B key, the same names on macOS and Windows (the app's `managed::KEYS`).
pub const KEYS: &[&str] = &[
    "RelayUrl",
    "PhoneAppUrl",
    "ModelBaseUrl",
    "AllowPhonePairing",
    "CleanupMode",
    "CleanupProvider",
    "AllowCloudCleanup",
    "CleanupBaseUrl",
    "CleanupModel",
    "CleanupApiKey",
    "VocabularySource",
    "OutputMode",
    "ShowTextInNotifications",
    "HistoryRetentionDays",
    "AutoUpdate",
    "UpdateChannel",
    "Model",
];

/// The managed values found, by Appendix B key. Keys that are not set, not forced, or of a
/// type that cannot be represented (arrays, data, binary registry values) are left out.
pub fn read_managed() -> BTreeMap<String, ManagedValue> {
    imp::read(KEYS)
}

/// The registry value types the policy key may hold, independent of the `winreg` crate so the
/// conversion is testable on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RegKind {
    Sz,
    ExpandSz,
    Dword,
    Qword,
    Other,
}

/// Converts one registry value. `env` looks up environment variables for `REG_EXPAND_SZ`.
#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn from_registry(
    kind: RegKind,
    bytes: &[u8],
    env: impl Fn(&str) -> Option<String>,
) -> Option<ManagedValue> {
    match kind {
        RegKind::Sz => utf16_string(bytes).map(ManagedValue::Text),
        RegKind::ExpandSz => utf16_string(bytes).map(|s| ManagedValue::Text(expand_env(&s, env))),
        RegKind::Dword => {
            let raw: [u8; 4] = bytes.try_into().ok()?;
            Some(ManagedValue::Int(i64::from(i32::from_le_bytes(raw))))
        }
        RegKind::Qword => {
            let raw: [u8; 8] = bytes.try_into().ok()?;
            Some(ManagedValue::Int(i64::from_le_bytes(raw)))
        }
        RegKind::Other => None,
    }
}

/// A registry string: UTF-16LE, usually with a terminating NUL (or several).
fn utf16_string(bytes: &[u8]) -> Option<String> {
    let (pairs, odd) = bytes.as_chunks::<2>();
    if !odd.is_empty() {
        return None;
    }
    let mut units: Vec<u16> = pairs.iter().map(|&pair| u16::from_le_bytes(pair)).collect();
    while units.last() == Some(&0) {
        units.pop();
    }
    String::from_utf16(&units).ok()
}

/// Expands `%NAME%` the way `ExpandEnvironmentStrings` does: unknown names and a lone `%`
/// stay as written.
fn expand_env(text: &str, env: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match env(name) {
                    Some(value) => out.push_str(&value),
                    None => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::BTreeMap;

    use objc2_core_foundation::{
        CFBoolean, CFNumber, CFPreferencesAppValueIsForced, CFPreferencesCopyAppValue, CFString,
        CFType,
    };

    use super::ManagedValue;

    pub fn read(keys: &[&str]) -> BTreeMap<String, ManagedValue> {
        read_domain(super::DOMAIN, keys)
    }

    /// Forced values of `keys` in `domain`.
    pub fn read_domain(domain: &str, keys: &[&str]) -> BTreeMap<String, ManagedValue> {
        let domain = CFString::from_str(domain);
        let mut found = BTreeMap::new();
        for &key in keys {
            let cf_key = CFString::from_str(key);
            if !CFPreferencesAppValueIsForced(&cf_key, &domain) {
                continue;
            }
            let Some(value) = CFPreferencesCopyAppValue(&cf_key, &domain) else {
                continue;
            };
            match from_cf(&value) {
                Some(v) => {
                    found.insert(key.to_string(), v);
                }
                None => log::warn!("Managed setting {key} has an unsupported type; ignored"),
            }
        }
        found
    }

    /// Converts one property-list value: strings, booleans and whole numbers. A number with a
    /// fraction, and arrays, dictionaries, data and dates, are not managed values.
    pub fn from_cf(value: &CFType) -> Option<ManagedValue> {
        if let Some(text) = value.downcast_ref::<CFString>() {
            return Some(ManagedValue::Text(text.to_string()));
        }
        if let Some(flag) = value.downcast_ref::<CFBoolean>() {
            return Some(ManagedValue::Bool(flag.as_bool()));
        }
        if let Some(number) = value.downcast_ref::<CFNumber>() {
            // CFNumberGetValue refuses a lossy conversion, so 1.5 is None and 14.0 is 14.
            return number.as_i64().map(ManagedValue::Int);
        }
        None
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::BTreeMap;

    use winreg::enums::{RegType, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;

    use super::{from_registry, ManagedValue, RegKind};

    pub fn read(keys: &[&str]) -> BTreeMap<String, ManagedValue> {
        let mut found = BTreeMap::new();
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        let Ok(policy) = hklm.open_subkey_with_flags(super::POLICY_KEY, KEY_READ | KEY_WOW64_64KEY)
        else {
            return found;
        };
        for &key in keys {
            let Ok(value) = policy.get_raw_value(key) else {
                continue;
            };
            let kind = match value.vtype {
                RegType::REG_SZ => RegKind::Sz,
                RegType::REG_EXPAND_SZ => RegKind::ExpandSz,
                RegType::REG_DWORD => RegKind::Dword,
                RegType::REG_QWORD => RegKind::Qword,
                _ => RegKind::Other,
            };
            match from_registry(kind, &value.bytes, |name| std::env::var(name).ok()) {
                Some(v) => {
                    found.insert(key.to_string(), v);
                }
                None => log::warn!("Managed setting {key} has an unsupported type; ignored"),
            }
        }
        found
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use std::collections::BTreeMap;

    use super::ManagedValue;

    pub fn read(_keys: &[&str]) -> BTreeMap<String, ManagedValue> {
        BTreeMap::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .chain([0])
            .flat_map(|unit| unit.to_le_bytes())
            .collect()
    }

    fn no_env(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn registry_strings_lose_their_terminator() {
        assert_eq!(
            from_registry(RegKind::Sz, &utf16("wss://relay.firma.dk"), no_env),
            Some(ManagedValue::Text("wss://relay.firma.dk".into()))
        );
        assert_eq!(
            from_registry(RegKind::Sz, &utf16("Dansk æøå"), no_env),
            Some(ManagedValue::Text("Dansk æøå".into()))
        );
        // Without a terminator, and with an empty value.
        assert_eq!(
            from_registry(RegKind::Sz, &[b'h', 0, b'i', 0], no_env),
            Some(ManagedValue::Text("hi".into()))
        );
        assert_eq!(
            from_registry(RegKind::Sz, &[], no_env),
            Some(ManagedValue::Text(String::new()))
        );
        // An odd byte count or an unpaired surrogate is not a string.
        assert_eq!(from_registry(RegKind::Sz, &[b'h', 0, b'i'], no_env), None);
        assert_eq!(from_registry(RegKind::Sz, &[0x00, 0xD8], no_env), None);
    }

    #[test]
    fn registry_expand_strings_expand_known_variables() {
        let env = |name: &str| (name == "ProgramData").then(|| r"C:\ProgramData".to_string());
        assert_eq!(
            from_registry(
                RegKind::ExpandSz,
                &utf16(r"%ProgramData%\WalkieTalkey\ord.txt"),
                env
            ),
            Some(ManagedValue::Text(
                r"C:\ProgramData\WalkieTalkey\ord.txt".into()
            ))
        );
        assert_eq!(expand_env("100% sure", env), "100% sure");
        assert_eq!(expand_env("%Unknown%\\x", env), "%Unknown%\\x");
        assert_eq!(expand_env("%%", env), "%%");
        assert_eq!(expand_env("a%ProgramData%b%", env), r"aC:\ProgramDatab%");
    }

    #[test]
    fn registry_numbers_are_signed() {
        assert_eq!(
            from_registry(RegKind::Dword, &14u32.to_le_bytes(), no_env),
            Some(ManagedValue::Int(14))
        );
        assert_eq!(
            from_registry(RegKind::Dword, &0u32.to_le_bytes(), no_env),
            Some(ManagedValue::Int(0))
        );
        // HistoryRetentionDays = -1 ("Altid") arrives as DWORD 0xFFFFFFFF.
        assert_eq!(
            from_registry(RegKind::Dword, &0xFFFF_FFFFu32.to_le_bytes(), no_env),
            Some(ManagedValue::Int(-1))
        );
        assert_eq!(
            from_registry(RegKind::Qword, &(-7i64).to_le_bytes(), no_env),
            Some(ManagedValue::Int(-7))
        );
        assert_eq!(from_registry(RegKind::Dword, &[1, 0, 0], no_env), None);
        assert_eq!(from_registry(RegKind::Qword, &[1, 0, 0, 0], no_env), None);
        assert_eq!(from_registry(RegKind::Other, &[1, 0, 0, 0], no_env), None);
    }

    #[test]
    fn keys_match_appendix_b() {
        assert_eq!(KEYS.len(), 17);
        let mut sorted = KEYS.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), KEYS.len(), "no duplicates");
    }

    #[test]
    fn read_managed_returns_only_appendix_b_keys() {
        // On a developer machine this is normally empty; with a profile installed it must
        // still hold nothing but known keys.
        for key in read_managed().keys() {
            assert!(KEYS.contains(&key.as_str()), "{key}");
        }
    }

    #[cfg(target_os = "macos")]
    mod macos {
        use objc2_core_foundation::{
            CFArray, CFBoolean, CFNumber, CFPreferencesAppSynchronize, CFPreferencesSetAppValue,
            CFString,
        };

        use super::super::imp::{from_cf, read_domain};
        use super::super::ManagedValue;

        #[test]
        fn plist_values_convert() {
            assert_eq!(
                from_cf(&CFString::from_str("wss://relay.firma.dk")),
                Some(ManagedValue::Text("wss://relay.firma.dk".into()))
            );
            assert_eq!(
                from_cf(CFBoolean::new(true)),
                Some(ManagedValue::Bool(true))
            );
            assert_eq!(
                from_cf(CFBoolean::new(false)),
                Some(ManagedValue::Bool(false))
            );
            assert_eq!(from_cf(&CFNumber::new_i32(14)), Some(ManagedValue::Int(14)));
            assert_eq!(from_cf(&CFNumber::new_i64(-1)), Some(ManagedValue::Int(-1)));
            assert_eq!(
                from_cf(&CFNumber::new_f64(14.0)),
                Some(ManagedValue::Int(14))
            );
            assert_eq!(from_cf(&CFNumber::new_f64(1.5)), None);
            let array = CFArray::<CFString>::from_retained_objects(&[CFString::from_str("x")]);
            assert_eq!(from_cf(&array), None);
        }

        /// A value the user wrote is not forced, so it is not managed (DESK-101).
        #[test]
        fn user_values_are_not_managed() {
            let domain = "com.walkietalkey.wt-native-test";
            let cf_domain = CFString::from_str(domain);
            let key = CFString::from_str("RelayUrl");
            let value = CFString::from_str("wss://user.example");
            // SAFETY: a CFString is a property-list value; key and domain are valid strings.
            unsafe { CFPreferencesSetAppValue(&key, Some(value.as_ref()), &cf_domain) };
            assert!(CFPreferencesAppSynchronize(&cf_domain));
            let found = read_domain(domain, &["RelayUrl"]);
            // SAFETY: as above; `None` removes the value again.
            unsafe { CFPreferencesSetAppValue(&key, None, &cf_domain) };
            CFPreferencesAppSynchronize(&cf_domain);
            // cfprefsd leaves the emptied plist behind.
            if let Some(home) = std::env::var_os("HOME") {
                let plist = std::path::Path::new(&home)
                    .join("Library/Preferences")
                    .join(format!("{domain}.plist"));
                let _ = std::fs::remove_file(plist);
            }
            assert!(found.is_empty(), "{found:?}");
        }
    }
}
