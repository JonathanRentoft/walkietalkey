//! The relay client's key store on the desktop (spec 9.2): the device keys and
//! every phone's pair keys in the OS keychain (SEC-09, SEC-10), the room, the
//! phone list and the frame counters in a small file in the data folder (the
//! counters change several times a second while a phone streams).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use wt_relay_client::wt_protocol::DeviceId;
use wt_relay_client::{
    JsonFileKeyStore, KeyStore, StoreError, StoredDeviceKeys, StoredPhone, StoredRoom,
};
use zeroize::Zeroizing;

const SERVICE: &str = "WalkieTalkey relay";
const DEVICE_KEYS: &str = "device-keys";

fn phone_account(id: &DeviceId) -> String {
    format!("phone:{}", id.to_b64u())
}

#[derive(Default, Serialize, Deserialize)]
struct FileState {
    room: Option<StoredRoom>,
    phones: Vec<String>,
    counters: BTreeMap<String, u64>,
}

pub struct DesktopKeyStore {
    path: PathBuf,
    state: Mutex<FileState>,
}

fn store_err(e: impl std::fmt::Display) -> StoreError {
    StoreError::new(e.to_string())
}

impl DesktopKeyStore {
    /// Opens the store in `dir`, moving any keys a plain-file store left
    /// there into the keychain and deleting that file.
    pub fn open(dir: &Path) -> Result<Self, StoreError> {
        std::fs::create_dir_all(dir).map_err(store_err)?;
        let path = dir.join("relay-state.json");
        let state = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(store_err)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => FileState::default(),
            Err(e) => return Err(store_err(e)),
        };
        let store = Self {
            path,
            state: Mutex::new(state),
        };
        store.migrate_plain_file(&dir.join("keys.json"))?;
        Ok(store)
    }

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
        log::info!("Moved the relay keys from a file into the keychain");
        Ok(())
    }

    fn persist(&self, state: &FileState) -> Result<(), StoreError> {
        use std::io::Write;
        let bytes = serde_json::to_vec_pretty(state).map_err(store_err)?;
        let tmp = self.path.with_extension("json.tmp");
        let mut file = std::fs::File::create(&tmp).map_err(store_err)?;
        file.write_all(&bytes).map_err(store_err)?;
        // A crash may skip counter numbers but never reuse one (spec 9.4):
        // the new state is on disk before it replaces the old one.
        file.sync_all().map_err(store_err)?;
        drop(file);
        std::fs::rename(&tmp, &self.path).map_err(store_err)?;
        // The rename itself, where the platform lets a folder be synced.
        if let Some(dir) = self.path.parent() {
            if let Ok(dir) = std::fs::File::open(dir) {
                let _ = dir.sync_all();
            }
        }
        Ok(())
    }
}

impl KeyStore for DesktopKeyStore {
    fn load_device_keys(&self) -> Result<Option<StoredDeviceKeys>, StoreError> {
        match super::super::secrets::get_checked(SERVICE, DEVICE_KEYS).map_err(store_err)? {
            Some(bytes) => {
                let bytes = Zeroizing::new(bytes);
                serde_json::from_slice(&bytes).map(Some).map_err(store_err)
            }
            None => Ok(None),
        }
    }

    fn save_device_keys(&self, keys: &StoredDeviceKeys) -> Result<(), StoreError> {
        let bytes = Zeroizing::new(serde_json::to_vec(keys).map_err(store_err)?);
        super::super::secrets::set(SERVICE, DEVICE_KEYS, &bytes).map_err(store_err)
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
            match super::super::secrets::get_checked(SERVICE, &account).map_err(store_err)? {
                Some(bytes) => {
                    let bytes = Zeroizing::new(bytes);
                    phones.push(serde_json::from_slice(&bytes).map_err(store_err)?);
                }
                None => log::warn!("Pair keys for a listed phone are missing; it must pair again"),
            }
        }
        Ok(phones)
    }

    fn save_phone(&self, phone: &StoredPhone) -> Result<(), StoreError> {
        let bytes = Zeroizing::new(serde_json::to_vec(phone).map_err(store_err)?);
        super::super::secrets::set(SERVICE, &phone_account(&phone.id), &bytes)
            .map_err(store_err)?;
        let mut state = self.state.lock().unwrap();
        let id = phone.id.to_b64u();
        if !state.phones.contains(&id) {
            state.phones.push(id);
        }
        self.persist(&state)
    }

    fn delete_phone(&self, id: &DeviceId) -> Result<(), StoreError> {
        super::super::secrets::delete(SERVICE, &phone_account(id)).map_err(store_err)?;
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
