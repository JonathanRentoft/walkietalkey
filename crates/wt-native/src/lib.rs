//! The WalkieTalkey desktop app's small native platform layer, kept out of `src-tauri` so it
//! has no Tauri dependency, compiles fast, and its Windows code can be type-checked on a Mac.
//!
//! | Module | Spec | macOS | Windows |
//! |---|---|---|---|
//! | [`secret_file`] | SEC-09, DESK-81 (run 5) | a private folder: `0700`, `0600` files, atomic writes, excluded from Time Machine, bound to this Mac; never the keychain | (not used) |
//! | [`secrets`] | SEC-09, SEC-10, DESK-81 | `Unsupported` (never the keychain) | Credential Manager, `CRED_PERSIST_LOCAL_MACHINE` |
//! | [`clipboard_windows`] | DESK-54 | (not used; the app writes with NSPasteboard current-host-only) | clipboard formats that keep text out of Clipboard History and Cloud Clipboard |
//! | [`notifications`] | DESK-56, DESK-57 | `UNUserNotificationCenter` with a delegate | toasts with an `Activated` handler |
//! | [`notification_permission`] | DESK-15 | `getNotificationSettings` | the toast notifier's setting |
//! | [`managed`] | DESK-100..102, Appendix B | forced `CFPreferences` values of `com.walkietalkey.app` | `HKLM\SOFTWARE\Policies\WalkieTalkey` |
//! | [`presence`] | DESK-63 | seconds since input, screen lock | the same |
//! | [`elevation`] | DESK-50 | always `false` | is the foreground window elevated above us? |
//! | [`keyboard`] | DESK-80 | (the app asks CoreGraphics itself) | is Shift held? |
//!
//! Every function is safe to call on platforms it does not cover: it returns a neutral value
//! or an `Unsupported` error, so the app needs no `cfg` at the call sites.

pub mod clipboard_windows;
pub mod elevation;
pub mod keyboard;
pub mod managed;
pub mod notification_permission;
pub mod notifications;
pub mod presence;
#[cfg(unix)]
pub mod secret_file;
pub mod secrets;

pub use managed::{read_managed, ManagedValue};

#[cfg(test)]
mod no_keychain {
    //! Run 5: the Mac build never calls the keychain, so it can never ask for the login
    //! password. This reads every source file of the crate and its manifest.

    const SOURCES: [(&str, &str); 12] = [
        ("lib.rs", include_str!("lib.rs")),
        ("clipboard_windows.rs", include_str!("clipboard_windows.rs")),
        ("elevation.rs", include_str!("elevation.rs")),
        ("keyboard.rs", include_str!("keyboard.rs")),
        ("managed.rs", include_str!("managed.rs")),
        (
            "notification_permission.rs",
            include_str!("notification_permission.rs"),
        ),
        ("notifications.rs", include_str!("notifications.rs")),
        ("presence.rs", include_str!("presence.rs")),
        ("secret_file.rs", include_str!("secret_file.rs")),
        ("secrets.rs", include_str!("secrets.rs")),
        ("Cargo.toml", include_str!("../Cargo.toml")),
        ("examples/probe.rs", include_str!("../examples/probe.rs")),
    ];

    /// Calls and crates that reach a keychain (the login keychain or the data-protection one).
    const FORBIDDEN: [&str; 9] = [
        "security_framework",
        "security-framework",
        "SecItemCopyMatching",
        "SecItemAdd",
        "SecItemUpdate",
        "SecItemDelete",
        "SecKeychain",
        "generic_password",
        "kSecClass",
    ];

    #[test]
    fn the_mac_build_has_no_keychain_calls() {
        // This module's own list is the one place the names may appear.
        let marker = "mod no_keychain {";
        for (file, text) in SOURCES {
            let text = match text.find(marker) {
                Some(at) => &text[..at],
                None => text,
            };
            for word in FORBIDDEN {
                assert!(!text.contains(word), "{file} mentions {word}");
            }
        }
    }

    #[test]
    fn every_source_file_is_checked() {
        let listed: Vec<&str> = SOURCES.iter().map(|(f, _)| *f).collect();
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        for entry in std::fs::read_dir(dir).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            if name.ends_with(".rs") {
                assert!(listed.contains(&name.as_str()), "{name} is not checked");
            }
        }
    }
}
