//! The relay client's key store on the desktop (spec 9.2): the device keys and every phone's
//! pair keys in the app's secret store (`walkietalkey::secrets`: a private folder on macOS,
//! Credential Manager on Windows; SEC-09, SEC-10), and the room, the phone list and the frame
//! counters in `relay-state.json` (the counters change several times a second while a phone
//! streams). On macOS that file lives inside the private folder too, so it is excluded from
//! Time Machine and bound to this Mac together with the keys it belongs to.
//!
//! Run 5: v0.1 kept the keys in the login keychain and its `relay-state.json` in the data
//! folder's `relay/`. Reading those keys would make macOS ask for the login password, so they
//! are never read: that old state is retired, this computer gets a new identity, and the phones
//! paired before must pair again (`pair_again`, shown in Indstillinger › Telefon).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use wt_relay_client::wt_protocol::DeviceId;
use wt_relay_client::{
    JsonFileKeyStore, KeyStore, StoreError, StoredDeviceKeys, StoredPhone, StoredRoom,
};
use zeroize::Zeroizing;

use crate::walkietalkey::secrets::SecretStore;

const SERVICE: &str = "WalkieTalkey relay";
const DEVICE_KEYS: &str = "device-keys";
/// The state file's name, in the state folder (and in v0.1's `relay/`).
pub const STATE_FILE: &str = "relay-state.json";
/// The plain-file store of the earliest builds (keys in the clear), moved in once.
const PLAIN_KEYS_FILE: &str = "keys.json";

fn phone_account(id: &DeviceId) -> String {
    format!("phone:{}", id.to_b64u())
}

#[derive(Default, Serialize, Deserialize)]
struct FileState {
    room: Option<StoredRoom>,
    phones: Vec<String>,
    counters: BTreeMap<String, u64>,
    /// Phones were paired with this computer's previous identity, whose keys were never read
    /// again (run 5), so they must pair again. Cleared once a phone pairs.
    #[serde(default)]
    pair_again: bool,
}

pub struct DesktopKeyStore {
    path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    state: Mutex<FileState>,
}

fn store_err(e: impl std::fmt::Display) -> StoreError {
    StoreError::new(e.to_string())
}

fn read_state(path: &Path) -> Result<Option<FileState>, StoreError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(store_err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(store_err(e)),
    }
}

/// Whether phones paired before run 5 must pair again, read without opening the store (for
/// the settings screen while the relay client holds the store).
pub fn pair_again(state_dir: &Path) -> bool {
    read_state(&state_dir.join(STATE_FILE))
        .ok()
        .flatten()
        .is_some_and(|s| s.pair_again && s.phones.is_empty())
}

/// Writes atomically and durably: on disk before it replaces the old file, so a crash may skip
/// counter numbers but never reuse one (spec 9.4). On Unix the file is `0600`.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        wt_native::secret_file::write_private(path, bytes)
    }
    #[cfg(not(unix))]
    {
        use std::io::Write;
        let tmp = path.with_extension("json.tmp");
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)?;
        if let Some(dir) = path.parent() {
            if let Ok(dir) = std::fs::File::open(dir) {
                let _ = dir.sync_all();
            }
        }
        Ok(())
    }
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

impl DesktopKeyStore {
    /// Opens the store: the state in `state_dir`, the keys in `secrets`. `legacy_dir` is where
    /// v0.1 kept its state on this platform when that is somewhere else (macOS: the data
    /// folder's `relay/`); its keys are never read (see the module notes).
    pub fn open(
        state_dir: &Path,
        secrets: Arc<dyn SecretStore>,
        legacy_dir: Option<&Path>,
    ) -> Result<Self, StoreError> {
        create_private_dir(state_dir).map_err(store_err)?;
        let path = state_dir.join(STATE_FILE);
        let state = read_state(&path)?.unwrap_or_default();
        let store = Self {
            path,
            secrets,
            state: Mutex::new(state),
        };
        store.migrate_plain_file(&state_dir.join(PLAIN_KEYS_FILE))?;
        if let Some(legacy) = legacy_dir.filter(|l| *l != state_dir) {
            store.migrate_plain_file(&legacy.join(PLAIN_KEYS_FILE))?;
            store.retire_keychain_state(legacy)?;
        }
        Ok(store)
    }

    /// Phones were paired with the previous identity and must pair again.
    pub fn pair_again(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.pair_again && state.phones.is_empty()
    }

    /// Keys a plain-file store left in the clear: moved in (no prompt can come from a file),
    /// then the file is deleted.
    fn migrate_plain_file(&self, old: &Path) -> Result<(), StoreError> {
        if !old.exists() {
            return Ok(());
        }
        let legacy = JsonFileKeyStore::open(old)?;
        if self.load_device_keys()?.is_none() {
            if let Some(keys) = legacy.load_device_keys()? {
                self.save_device_keys(&keys)?;
            }
        }
        if let Some(room) = legacy.load_room()? {
            self.save_room(&room)?;
        }
        for phone in legacy.load_phones()? {
            self.save_phone(&phone)?;
        }
        std::fs::remove_file(old).map_err(store_err)?;
        log::info!("Moved the relay keys from a plain file into the secret store");
        Ok(())
    }

    /// v0.1's state, whose keys are in the login keychain: noted (were phones paired?) and
    /// deleted. The keychain items stay where they are, unread.
    fn retire_keychain_state(&self, legacy_dir: &Path) -> Result<(), StoreError> {
        let old = legacy_dir.join(STATE_FILE);
        let Some(previous) = read_state(&old).unwrap_or_else(|e| {
            log::warn!("Ignoring an unreadable old relay state: {e}");
            Some(FileState::default())
        }) else {
            return Ok(());
        };
        {
            let mut state = self.state.lock().unwrap();
            if !previous.phones.is_empty() && state.phones.is_empty() {
                state.pair_again = true;
            }
            self.persist(&state)?;
        }
        std::fs::remove_file(&old).map_err(store_err)?;
        // The folder goes too once it is empty (v0.1 kept nothing else there).
        let _ = std::fs::remove_dir(legacy_dir);
        log::info!(
            "Retired the relay state of the previous identity ({} phone(s) must pair again)",
            previous.phones.len()
        );
        Ok(())
    }

    fn persist(&self, state: &FileState) -> Result<(), StoreError> {
        let bytes = serde_json::to_vec_pretty(state).map_err(store_err)?;
        write_atomic(&self.path, &bytes).map_err(store_err)
    }
}

impl KeyStore for DesktopKeyStore {
    fn load_device_keys(&self) -> Result<Option<StoredDeviceKeys>, StoreError> {
        match self.secrets.get(SERVICE, DEVICE_KEYS).map_err(store_err)? {
            Some(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(store_err),
            None => Ok(None),
        }
    }

    fn save_device_keys(&self, keys: &StoredDeviceKeys) -> Result<(), StoreError> {
        let bytes = Zeroizing::new(serde_json::to_vec(keys).map_err(store_err)?);
        self.secrets
            .set(SERVICE, DEVICE_KEYS, &bytes)
            .map_err(store_err)
    }

    fn load_room(&self) -> Result<Option<StoredRoom>, StoreError> {
        Ok(self.state.lock().unwrap().room.clone())
    }

    fn save_room(&self, room: &StoredRoom) -> Result<(), StoreError> {
        let mut state = self.state.lock().unwrap();
        state.room = Some(room.clone());
        self.persist(&state)
    }

    fn delete_room(&self) -> Result<(), StoreError> {
        let mut state = self.state.lock().unwrap();
        state.room = None;
        self.persist(&state)
    }

    fn load_phones(&self) -> Result<Vec<StoredPhone>, StoreError> {
        let ids = self.state.lock().unwrap().phones.clone();
        let mut phones = Vec::new();
        for id in ids {
            let account = format!("phone:{id}");
            match self.secrets.get(SERVICE, &account).map_err(store_err)? {
                Some(bytes) => phones.push(serde_json::from_slice(&bytes).map_err(store_err)?),
                None => log::warn!("Pair keys for a listed phone are missing; it must pair again"),
            }
        }
        Ok(phones)
    }

    fn save_phone(&self, phone: &StoredPhone) -> Result<(), StoreError> {
        let bytes = Zeroizing::new(serde_json::to_vec(phone).map_err(store_err)?);
        self.secrets
            .set(SERVICE, &phone_account(&phone.id), &bytes)
            .map_err(store_err)?;
        let mut state = self.state.lock().unwrap();
        let id = phone.id.to_b64u();
        if !state.phones.contains(&id) {
            state.phones.push(id);
        }
        state.pair_again = false;
        self.persist(&state)
    }

    fn delete_phone(&self, id: &DeviceId) -> Result<(), StoreError> {
        self.secrets
            .delete(SERVICE, &phone_account(id))
            .map_err(store_err)?;
        let mut state = self.state.lock().unwrap();
        let b64 = id.to_b64u();
        state.phones.retain(|p| p != &b64);
        self.persist(&state)
    }

    fn load_counter(&self, name: &str) -> Result<u64, StoreError> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .counters
            .get(name)
            .copied()
            .unwrap_or(0))
    }

    fn save_counter(&self, name: &str, value: u64) -> Result<(), StoreError> {
        let mut state = self.state.lock().unwrap();
        state.counters.insert(name.to_string(), value);
        self.persist(&state)
    }

    fn delete_counters_for(&self, id: &DeviceId) -> Result<(), StoreError> {
        let mut state = self.state.lock().unwrap();
        let needle = id.to_b64u();
        state.counters.retain(|k, _| !k.contains(&needle));
        self.persist(&state)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;
    use std::sync::Mutex as StdMutex;

    use wt_native::secret_file::SecretDir;
    use wt_relay_client::wt_protocol::{RoomId, Salt, SigningKeyPair};

    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir()
                .join(format!("wt-keystore-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The real secret folder, with every call recorded.
    struct Recording {
        inner: SecretDir,
        calls: StdMutex<Vec<String>>,
    }
    impl SecretStore for Recording {
        fn get(&self, s: &str, a: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
            self.calls.lock().unwrap().push(format!("get {s}/{a}"));
            self.inner.get(s, a).map_err(|e| e.to_string())
        }
        fn set(&self, s: &str, a: &str, v: &[u8]) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("set {s}/{a}"));
            self.inner.set(s, a, v).map_err(|e| e.to_string())
        }
        fn delete(&self, s: &str, a: &str) -> Result<(), String> {
            self.calls.lock().unwrap().push(format!("delete {s}/{a}"));
            self.inner.delete(s, a).map_err(|e| e.to_string())
        }
    }

    fn secrets(dir: &Path) -> Arc<Recording> {
        Arc::new(Recording {
            inner: SecretDir::open_for_machine(dir, Some("this-mac")).unwrap(),
            calls: StdMutex::new(Vec::new()),
        })
    }

    fn phone() -> StoredPhone {
        let k = SigningKeyPair::generate().unwrap();
        StoredPhone {
            id: k.device_id(),
            signing_spki: k.spki().clone(),
            agreement_spki: k.spki().clone(),
            key_p2c: Zeroizing::new([7; 32]),
            key_c2p: Zeroizing::new([8; 32]),
            name: Some("Testtelefon".into()),
            platform: Some("ios".into()),
            paired_at: 1,
        }
    }

    fn room() -> StoredRoom {
        StoredRoom {
            relay_url: "wss://relay.example".into(),
            room_id: RoomId([9; 16]),
            salt: Salt([3; 16]),
            created: true,
        }
    }

    #[test]
    fn keys_and_state_survive_a_restart_in_private_files() {
        let s = Scratch::new("restart");
        let secret_dir = s.0.join("secrets");
        let state_dir = secret_dir.join("relay");
        let keys = StoredDeviceKeys {
            signing_scalar: Zeroizing::new([1; 32]),
            agreement_scalar: Zeroizing::new([2; 32]),
        };
        let paired = phone();
        {
            let store = DesktopKeyStore::open(&state_dir, secrets(&secret_dir), None).unwrap();
            assert!(store.load_device_keys().unwrap().is_none());
            store.save_device_keys(&keys).unwrap();
            store.save_room(&room()).unwrap();
            store.save_phone(&paired).unwrap();
            store.save_counter("send:a>b", 1000).unwrap();
        }
        let store = DesktopKeyStore::open(&state_dir, secrets(&secret_dir), None).unwrap();
        assert_eq!(store.load_device_keys().unwrap().unwrap(), keys);
        assert_eq!(store.load_room().unwrap().unwrap(), room());
        assert_eq!(store.load_phones().unwrap(), vec![paired.clone()]);
        assert_eq!(store.load_counter("send:a>b").unwrap(), 1000);

        // SEC-09: no key is in the state file; it and its folder are private.
        let text = std::fs::read_to_string(state_dir.join(STATE_FILE)).unwrap();
        assert!(!text.contains("signing_scalar") && !text.contains("key_p2c"));
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&state_dir), 0o700);
        assert_eq!(mode(&state_dir.join(STATE_FILE)), 0o600);

        store.delete_phone(&paired.id).unwrap();
        assert!(store.load_phones().unwrap().is_empty());
    }

    /// Run 5: v0.1's state (keys in the login keychain) is retired without reading a key: the
    /// new store asks its own folder only, finds nothing, and says the phones must pair again.
    #[test]
    fn the_v0_1_state_is_retired_and_its_phones_pair_again() {
        let s = Scratch::new("legacy");
        let data = s.0.join("WalkieTalkey");
        let legacy = data.join("relay");
        std::fs::create_dir_all(&legacy).unwrap();
        // Exactly what v0.1 wrote (it had no `pair_again`).
        let v0_1 = serde_json::json!({
            "room": serde_json::to_value(room()).unwrap(),
            "phones": [phone().id.to_b64u()],
            "counters": { "send:x": 2000 },
        });
        std::fs::write(legacy.join(STATE_FILE), v0_1.to_string()).unwrap();
        let secret_dir = data.join("secrets");
        let state_dir = secret_dir.join("relay");
        let recorded = secrets(&secret_dir);
        let store = DesktopKeyStore::open(&state_dir, recorded.clone(), Some(&legacy)).unwrap();

        assert!(store.pair_again());
        assert!(pair_again(&state_dir));
        // The old room and phones are not this identity's: nothing of them is used.
        assert!(store.load_room().unwrap().is_none());
        assert!(store.load_phones().unwrap().is_empty());
        assert_eq!(store.load_counter("send:x").unwrap(), 0);
        assert!(!legacy.join(STATE_FILE).exists());
        assert!(!legacy.exists(), "the empty v0.1 folder is removed");
        // Not one secret read for the old phones (in the keychain they would have asked).
        let calls = recorded.calls.lock().unwrap().clone();
        assert!(calls.iter().all(|c| !c.contains("phone:")), "{calls:?}");

        // Opening again keeps the note; the first new pairing clears it.
        drop(store);
        let store = DesktopKeyStore::open(&state_dir, secrets(&secret_dir), Some(&legacy)).unwrap();
        assert!(store.pair_again());
        store.save_phone(&phone()).unwrap();
        assert!(!store.pair_again());
        assert!(!pair_again(&state_dir));
    }

    #[test]
    fn v0_1_without_phones_needs_no_pairing_again() {
        let s = Scratch::new("legacy-empty");
        let legacy = s.0.join("relay");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join(STATE_FILE),
            r#"{"room":null,"phones":[],"counters":{}}"#,
        )
        .unwrap();
        let secret_dir = s.0.join("secrets");
        let store = DesktopKeyStore::open(
            &secret_dir.join("relay"),
            secrets(&secret_dir),
            Some(&legacy),
        )
        .unwrap();
        assert!(!store.pair_again());
        assert!(!legacy.join(STATE_FILE).exists());
    }

    #[test]
    fn a_plain_key_file_moves_into_the_secret_store() {
        let s = Scratch::new("plain");
        let legacy = s.0.join("relay");
        std::fs::create_dir_all(&legacy).unwrap();
        let keys = StoredDeviceKeys {
            signing_scalar: Zeroizing::new([4; 32]),
            agreement_scalar: Zeroizing::new([6; 32]),
        };
        let moved = phone();
        {
            let plain = JsonFileKeyStore::open(&legacy.join(PLAIN_KEYS_FILE)).unwrap();
            plain.save_device_keys(&keys).unwrap();
            plain.save_room(&room()).unwrap();
            plain.save_phone(&moved).unwrap();
        }
        let secret_dir = s.0.join("secrets");
        let store = DesktopKeyStore::open(
            &secret_dir.join("relay"),
            secrets(&secret_dir),
            Some(&legacy),
        )
        .unwrap();
        assert_eq!(store.load_device_keys().unwrap().unwrap(), keys);
        assert_eq!(store.load_room().unwrap().unwrap(), room());
        assert_eq!(store.load_phones().unwrap(), vec![moved]);
        assert!(!store.pair_again());
        assert!(!legacy.join(PLAIN_KEYS_FILE).exists());
    }
}
