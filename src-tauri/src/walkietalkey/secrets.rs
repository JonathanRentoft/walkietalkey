//! Where the app keeps its secrets (SEC-09, SEC-10, DESK-81): device keys, pair keys and the
//! user's cleanup API keys. Never in a settings file, never in a log.
//!
//! - **macOS** (and Linux): a private folder in the app's data folder, `secrets/`
//!   (`wt_native::secret_file`): `0700`, `0600` files, atomic writes, excluded from Time
//!   Machine, bound to this computer. Run 5: never the keychain. An app without an Apple Team
//!   ID is trusted by the login keychain only for the build that wrote an item, so every update
//!   asked for the login password, and the read at start blocked the main thread until the
//!   user answered. The old keychain items ("WalkieTalkey relay", "WalkieTalkey AI cleanup")
//!   are never read again, because reading them would ask: v0.2.0 starts with a new device
//!   identity (phones pair again) and cleanup API keys are entered again.
//! - **Windows**: Credential Manager with local-machine persistence (SEC-10), which never asks.

use std::path::PathBuf;
use std::sync::Arc;

use once_cell::sync::OnceCell;
use zeroize::Zeroizing;

/// The folder of secrets in the app's data folder (macOS, Linux).
pub const SECRET_DIR: &str = "secrets";

/// A store of secrets by service and account, like the keychain's generic passwords.
pub trait SecretStore: Send + Sync {
    /// `None` when there is none; an `Err` means it could not be read, which callers must not
    /// mistake for a first start.
    fn get(&self, service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String>;
    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), String>;
    /// A missing secret deletes fine.
    fn delete(&self, service: &str, account: &str) -> Result<(), String>;
}

#[cfg(unix)]
impl SecretStore for wt_native::secret_file::SecretDir {
    fn get(&self, service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        wt_native::secret_file::SecretDir::get(self, service, account).map_err(|e| e.to_string())
    }
    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
        wt_native::secret_file::SecretDir::set(self, service, account, secret)
            .map_err(|e| e.to_string())
    }
    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        wt_native::secret_file::SecretDir::delete(self, service, account).map_err(|e| e.to_string())
    }
}

/// Credential Manager (SEC-10).
#[cfg(windows)]
struct CredentialManager;

#[cfg(windows)]
impl SecretStore for CredentialManager {
    fn get(&self, service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        wt_native::secrets::get(service, account).map_err(|e| e.to_string())
    }
    fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
        wt_native::secrets::set(service, account, secret).map_err(|e| e.to_string())
    }
    fn delete(&self, service: &str, account: &str) -> Result<(), String> {
        wt_native::secrets::delete(service, account).map_err(|e| e.to_string())
    }
}

static STORE: OnceCell<Arc<dyn SecretStore>> = OnceCell::new();

/// The secret folder's path (macOS, Linux).
pub fn secret_dir() -> Result<PathBuf, String> {
    let app = super::app().ok_or("the app is not set up yet")?;
    Ok(crate::portable::app_data_dir(app)
        .map_err(|e| e.to_string())?
        .join(SECRET_DIR))
}

/// The app's store, opened once (it never shows a dialog).
pub fn store() -> Result<Arc<dyn SecretStore>, String> {
    STORE
        .get_or_try_init(|| {
            #[cfg(unix)]
            {
                let dir = secret_dir()?;
                let opened =
                    wt_native::secret_file::SecretDir::open(&dir).map_err(|e| e.to_string())?;
                let what = opened.opened();
                if what.reset_for_another_computer {
                    log::warn!(
                        "The secret folder was copied from another computer; this one makes its own keys"
                    );
                }
                if what.removed_temp_files > 0 {
                    log::info!(
                        "Removed {} unfinished secret writes",
                        what.removed_temp_files
                    );
                }
                Ok(Arc::new(opened) as Arc<dyn SecretStore>)
            }
            #[cfg(windows)]
            {
                Ok(Arc::new(CredentialManager) as Arc<dyn SecretStore>)
            }
        })
        .cloned()
}

/// Stores a secret.
pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
    store()?.set(service, account, secret)
}

/// Reads a secret; an unreadable store is an error, not "no secret", so callers never mistake
/// it for a first start.
pub fn get_checked(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
    store()?
        .get(service, account)
        .map(|secret| secret.map(|bytes| bytes.to_vec()))
}

/// Reads a secret where "absent" and "unreadable" lead to the same thing.
pub fn get(service: &str, account: &str) -> Option<Vec<u8>> {
    get_checked(service, account).unwrap_or_else(|e| {
        log::warn!("Secret read failed for {service}: {e}");
        None
    })
}

pub fn delete(service: &str, account: &str) -> Result<(), String> {
    store()?.delete(service, account)
}

#[cfg(test)]
mod tests {
    /// Run 5: nothing in the desktop app reaches a keychain on macOS, so no update can make it
    /// ask for the login password. The binary check: the linker keeps only code something
    /// reaches, so this holds on to every function on the secret path (ours and wt-native's);
    /// whatever they call is then in the test binary, which must import none of the keychain's
    /// item calls. (`scripts/walkietalkey/check-no-keychain.sh` checks the app itself.)
    #[cfg(target_os = "macos")]
    #[test]
    fn the_mac_build_imports_no_keychain_calls() {
        type Get = fn(&str, &str) -> Result<Option<Vec<u8>>, String>;
        type NativeGet =
            fn(
                &str,
                &str,
            )
                -> Result<Option<zeroize::Zeroizing<Vec<u8>>>, wt_native::secrets::SecretError>;
        type NativeSet = fn(&str, &str, &[u8]) -> Result<(), wt_native::secrets::SecretError>;
        type NativeDelete = fn(&str, &str) -> Result<(), wt_native::secrets::SecretError>;
        let reached: [usize; 10] = [
            super::set as fn(&str, &str, &[u8]) -> Result<(), String> as usize,
            super::get_checked as Get as usize,
            super::delete as fn(&str, &str) -> Result<(), String> as usize,
            super::store as fn() -> _ as usize,
            wt_native::secrets::get as NativeGet as usize,
            wt_native::secrets::set as NativeSet as usize,
            wt_native::secrets::delete as NativeDelete as usize,
            crate::walkietalkey::cleanup::keys::get as fn(&str) -> Option<String> as usize,
            crate::walkietalkey::cleanup::keys::set as fn(&str, &str) -> Result<(), String>
                as usize,
            crate::walkietalkey::relay::keystore::pair_again as fn(&std::path::Path) -> bool
                as usize,
        ];
        std::hint::black_box(&reached);
        let exe = std::env::current_exe().unwrap();
        let Ok(out) = std::process::Command::new("/usr/bin/nm")
            .arg("-u")
            .arg(&exe)
            .output()
        else {
            eprintln!("SKIPPED: nm is not installed");
            return;
        };
        assert!(out.status.success(), "nm failed");
        let imports = String::from_utf8_lossy(&out.stdout);
        let keychain: Vec<&str> = imports
            .lines()
            .map(str::trim)
            .filter(|s| s.starts_with("_SecItem") || s.starts_with("_SecKeychain"))
            .collect();
        assert!(keychain.is_empty(), "keychain calls: {keychain:?}");
    }

    /// The same, in the sources: the macOS paths of the files that held keychain calls before
    /// run 5 do not mention the keychain crate or its calls.
    #[test]
    fn the_secret_paths_have_no_keychain_calls() {
        let sources = [
            ("secrets.rs", include_str!("secrets.rs")),
            ("relay/keystore.rs", include_str!("relay/keystore.rs")),
            ("cleanup/keys.rs", include_str!("cleanup/keys.rs")),
            ("../../Cargo.toml", include_str!("../../Cargo.toml")),
        ];
        let marker = "mod tests {";
        for (file, text) in sources {
            let text = text.find(marker).map_or(text, |at| &text[..at]);
            for word in [
                "security_framework",
                "security-framework",
                "SecItem",
                "SecKeychain",
                "keyring",
            ] {
                assert!(!text.contains(word), "{file} mentions {word}");
            }
        }
    }
}
