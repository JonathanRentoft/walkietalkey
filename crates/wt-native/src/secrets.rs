//! The OS secret store (SEC-09, SEC-10, DESK-81): device keys, pair keys and cleanup API keys.
//! Counters and other non-secret state belong in a plain file, not here.
//!
//! - **macOS**: generic passwords in the login Keychain through the `SecItem` API. Every item
//!   is written and looked up with `kSecAttrSynchronizable = false`, so it never syncs to
//!   iCloud Keychain and never leaves this Mac.
//! - **Windows**: generic credentials in Credential Manager through the keyring store
//!   (`windows-native-keyring-store`) with its `persistence=local` modifier, which writes
//!   `CRED_PERSIST_LOCAL_MACHINE`. The store's default, Enterprise, roams to the user's other
//!   computers in a company domain, and two computers must never share a device identity.
//!   [`set`] reads the persistence back after writing and refuses anything but local. The
//!   target name is `"{account}.{service}"`, the keyring crate's convention. One secret is at
//!   most 2,560 bytes (`CRED_MAX_CREDENTIAL_BLOB_SIZE`).
//! - Elsewhere every call returns [`SecretError::Unsupported`].
//!
//! Calls are serialised by a process-wide lock: Credential Manager does not reliably order
//! operations on one entry from several threads.

use std::sync::Mutex;

use zeroize::Zeroizing;

/// Why a secret operation failed. A missing item is not an error: [`get`] returns `None` and
/// [`delete`] succeeds.
#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    #[error("service and account must not be empty")]
    EmptyName,
    #[error("the secret store refused access: {0}")]
    Denied(String),
    #[error("the secret is too large for the platform store")]
    TooLarge,
    #[error("the credential was not stored with local-machine persistence ({0})")]
    WrongPersistence(String),
    #[error("secret store error: {0}")]
    Platform(String),
    #[error("no secret store on this platform")]
    Unsupported,
}

static LOCK: Mutex<()> = Mutex::new(());

fn guarded<T>(
    service: &str,
    account: &str,
    f: impl FnOnce() -> Result<T, SecretError>,
) -> Result<T, SecretError> {
    if service.is_empty() || account.is_empty() {
        return Err(SecretError::EmptyName);
    }
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f()
}

/// Stores `secret` under `service`/`account`, replacing any earlier value.
pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), SecretError> {
    guarded(service, account, || imp::set(service, account, secret))
}

/// The secret stored under `service`/`account`, or `None` when there is none. An `Err` means
/// the store could not be read (locked, access denied): callers must not treat that as
/// "no key yet" and create a new identity.
pub fn get(service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
    guarded(service, account, || imp::get(service, account))
}

/// Deletes the secret under `service`/`account`. Deleting one that does not exist succeeds.
pub fn delete(service: &str, account: &str) -> Result<(), SecretError> {
    guarded(service, account, || imp::delete(service, account))
}

/// The keyring-store modifiers every Windows entry is built with (SEC-10).
#[cfg_attr(not(windows), allow(dead_code))]
const WINDOWS_MODIFIERS: [(&str, &str); 1] = [("persistence", "Local")];

#[cfg(target_os = "macos")]
mod imp {
    use super::SecretError;
    use security_framework::base::Error;
    use security_framework::passwords::{
        delete_generic_password_options, generic_password, set_generic_password_options,
        PasswordOptions,
    };
    use zeroize::Zeroizing;

    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
    const ERR_SEC_AUTH_FAILED: i32 = -25293;
    const ERR_SEC_INTERACTION_NOT_ALLOWED: i32 = -25308;
    const ERR_SEC_USER_CANCELED: i32 = -128;

    fn options(service: &str, account: &str) -> PasswordOptions {
        let mut options = PasswordOptions::new_generic_password(service, account);
        // SEC-09: this device only. Also scopes lookups to non-synchronizable items.
        options.set_access_synchronized(Some(false));
        options
    }

    fn map(err: Error) -> SecretError {
        let text = err
            .message()
            .unwrap_or_else(|| format!("OSStatus {}", err.code()));
        match err.code() {
            ERR_SEC_AUTH_FAILED | ERR_SEC_INTERACTION_NOT_ALLOWED | ERR_SEC_USER_CANCELED => {
                SecretError::Denied(text)
            }
            _ => SecretError::Platform(text),
        }
    }

    pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), SecretError> {
        set_generic_password_options(secret, options(service, account)).map_err(map)
    }

    pub fn get(service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        match generic_password(options(service, account)) {
            Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(err) => Err(map(err)),
        }
    }

    pub fn delete(service: &str, account: &str) -> Result<(), SecretError> {
        match delete_generic_password_options(options(service, account)) {
            Ok(()) => Ok(()),
            Err(err) if err.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(err) => Err(map(err)),
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::collections::HashMap;

    use keyring_core::api::CredentialStoreApi;
    use keyring_core::{Entry, Error};
    use windows_native_keyring_store::Store;
    use zeroize::Zeroizing;

    use super::{SecretError, WINDOWS_MODIFIERS};

    fn entry(service: &str, account: &str) -> Result<Entry, SecretError> {
        let store = Store::new().map_err(map)?;
        let modifiers: HashMap<&str, &str> = WINDOWS_MODIFIERS.into_iter().collect();
        store.build(service, account, Some(&modifiers)).map_err(map)
    }

    fn map(err: Error) -> SecretError {
        match err {
            Error::TooLong(..) => SecretError::TooLarge,
            Error::NoStorageAccess(e) => SecretError::Denied(e.to_string()),
            other => SecretError::Platform(other.to_string()),
        }
    }

    pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), SecretError> {
        let entry = entry(service, account)?;
        entry.set_secret(secret).map_err(map)?;
        // SEC-10: prove what was written. An Enterprise credential would roam to the user's
        // other domain computers, so it is removed again rather than kept.
        let persistence = entry
            .get_attributes()
            .map_err(map)?
            .get("persistence")
            .cloned()
            .unwrap_or_default();
        if persistence.eq_ignore_ascii_case("Local") {
            Ok(())
        } else {
            let _ = entry.delete_credential();
            Err(SecretError::WrongPersistence(persistence))
        }
    }

    pub fn get(service: &str, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        match entry(service, account)?.get_secret() {
            Ok(bytes) => Ok(Some(Zeroizing::new(bytes))),
            Err(Error::NoEntry) => Ok(None),
            Err(err) => Err(map(err)),
        }
    }

    pub fn delete(service: &str, account: &str) -> Result<(), SecretError> {
        match entry(service, account)?.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(err) => Err(map(err)),
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::SecretError;
    use zeroize::Zeroizing;

    pub fn set(_: &str, _: &str, _: &[u8]) -> Result<(), SecretError> {
        Err(SecretError::Unsupported)
    }

    pub fn get(_: &str, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        Err(SecretError::Unsupported)
    }

    pub fn delete(_: &str, _: &str) -> Result<(), SecretError> {
        Err(SecretError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_entries_are_local_machine_only() {
        // SEC-10: never the keyring store's default (Enterprise).
        assert_eq!(WINDOWS_MODIFIERS, [("persistence", "Local")]);
    }

    #[test]
    fn empty_names_are_refused() {
        assert!(matches!(set("", "a", b"x"), Err(SecretError::EmptyName)));
        assert!(matches!(get("s", ""), Err(SecretError::EmptyName)));
        assert!(matches!(delete("", ""), Err(SecretError::EmptyName)));
    }

    /// Writes, reads, overwrites and deletes a real item under a test service name that is
    /// unique per run, so a rebuilt test binary never touches an item an older build created
    /// (which could make the Keychain ask for access).
    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn round_trip_in_the_os_store() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let service = format!(
            "com.walkietalkey.wt-native-test.{}.{nanos}",
            std::process::id()
        );
        let account = "device-keys";

        struct Cleanup<'a>(&'a str, &'a str);
        impl Drop for Cleanup<'_> {
            fn drop(&mut self) {
                let _ = delete(self.0, self.1);
            }
        }
        let _cleanup = Cleanup(&service, account);

        assert!(
            get(&service, account).unwrap().is_none(),
            "nothing there yet"
        );
        delete(&service, account).expect("deleting a missing item succeeds");

        let first: Vec<u8> = (0u8..64).collect();
        set(&service, account, &first).unwrap();
        assert_eq!(get(&service, account).unwrap().as_deref(), Some(&first));

        let second = vec![0u8, 255, 1, 254];
        set(&service, account, &second).unwrap();
        assert_eq!(get(&service, account).unwrap().as_deref(), Some(&second));

        // Another account under the same service is a separate item.
        assert!(get(&service, "pair-keys").unwrap().is_none());

        delete(&service, account).unwrap();
        assert!(get(&service, account).unwrap().is_none());
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    #[test]
    fn unsupported_elsewhere() {
        assert!(matches!(get("s", "a"), Err(SecretError::Unsupported)));
    }
}
