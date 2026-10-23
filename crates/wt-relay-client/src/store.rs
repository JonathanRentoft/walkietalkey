//! Persistence behind one trait. The desktop app implements [`KeyStore`] with the OS keychain
//! for secrets (device keys, pair keys; SEC-10 on Windows) and a plain file for the rest (room,
//! counters). [`MemoryKeyStore`] and [`JsonFileKeyStore`] are for tests and tools: the JSON file
//! holds private keys in the clear.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use wt_protocol::{
    b64u_decode, b64u_encode, CounterStore, DeviceId, PairKeys, ProtocolError, RoomId, Salt, Spki,
};
use zeroize::Zeroizing;

use crate::error::StoreError;

/// The computer's two private keys as 32-byte P-256 scalars.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredDeviceKeys {
    #[serde(with = "secret32")]
    pub signing_scalar: Zeroizing<[u8; 32]>,
    #[serde(with = "secret32")]
    pub agreement_scalar: Zeroizing<[u8; 32]>,
}

impl std::fmt::Debug for StoredDeviceKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StoredDeviceKeys(<redacted>)")
    }
}

/// This computer's room on one relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredRoom {
    pub relay_url: String,
    pub room_id: RoomId,
    pub salt: Salt,
    /// True once the relay confirmed `create` (or answered 4409 for it).
    pub created: bool,
}

/// A paired phone and its two direction keys.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredPhone {
    pub id: DeviceId,
    pub signing_spki: Spki,
    pub agreement_spki: Spki,
    #[serde(with = "secret32")]
    pub key_p2c: Zeroizing<[u8; 32]>,
    #[serde(with = "secret32")]
    pub key_c2p: Zeroizing<[u8; 32]>,
    pub name: Option<String>,
    pub platform: Option<String>,
    /// Unix ms.
    pub paired_at: u64,
}

impl StoredPhone {
    pub fn pair_keys(&self) -> PairKeys {
        PairKeys {
            p2c: self.key_p2c.clone(),
            c2p: self.key_c2p.clone(),
        }
    }
}

impl std::fmt::Debug for StoredPhone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredPhone")
            .field("id", &self.id)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

/// Everything the relay client persists. All methods are synchronous and are called from the
/// client task; keep them fast. `save_*` must return only once the data is durable (counters
/// in particular: spec 9.4).
pub trait KeyStore: Send + Sync + 'static {
    fn load_device_keys(&self) -> Result<Option<StoredDeviceKeys>, StoreError>;
    fn save_device_keys(&self, keys: &StoredDeviceKeys) -> Result<(), StoreError>;

    fn load_room(&self) -> Result<Option<StoredRoom>, StoreError>;
    fn save_room(&self, room: &StoredRoom) -> Result<(), StoreError>;
    fn delete_room(&self) -> Result<(), StoreError>;

    fn load_phones(&self) -> Result<Vec<StoredPhone>, StoreError>;
    fn save_phone(&self, phone: &StoredPhone) -> Result<(), StoreError>;
    fn delete_phone(&self, id: &DeviceId) -> Result<(), StoreError>;

    /// Counter values by name (`send:<sender>><recipient>` = end of the reserved block,
    /// `recv:<sender>><recipient>` = last accepted). Missing reads as 0.
    fn load_counter(&self, name: &str) -> Result<u64, StoreError>;
    fn save_counter(&self, name: &str, value: u64) -> Result<(), StoreError>;
    /// Removes every counter whose name contains this device id (base64url).
    fn delete_counters_for(&self, id: &DeviceId) -> Result<(), StoreError>;
}

/// Adapts a [`KeyStore`] to the protocol crate's [`CounterStore`].
pub struct StoreCounters<'a>(pub &'a dyn KeyStore);

impl CounterStore for StoreCounters<'_> {
    fn load_send_reservation(&self, key: &str) -> Result<u64, ProtocolError> {
        Ok(self.0.load_counter(&format!("send:{key}"))?)
    }
    fn save_send_reservation(&self, key: &str, end: u64) -> Result<(), ProtocolError> {
        Ok(self.0.save_counter(&format!("send:{key}"), end)?)
    }
    fn load_last_accepted(&self, key: &str) -> Result<u64, ProtocolError> {
        Ok(self.0.load_counter(&format!("recv:{key}"))?)
    }
    fn save_last_accepted(&self, key: &str, value: u64) -> Result<(), ProtocolError> {
        Ok(self.0.save_counter(&format!("recv:{key}"), value)?)
    }
}

#[derive(Default, Clone, Serialize, Deserialize)]
struct Inner {
    device_keys: Option<StoredDeviceKeys>,
    room: Option<StoredRoom>,
    phones: BTreeMap<String, StoredPhone>,
    counters: BTreeMap<String, u64>,
}

impl Inner {
    fn delete_counters_for(&mut self, id: &DeviceId) {
        let needle = id.to_b64u();
        self.counters.retain(|k, _| !k.contains(&needle));
    }
}

/// In-memory store (tests; a restart loses everything).
#[derive(Default)]
pub struct MemoryKeyStore {
    inner: Mutex<Inner>,
}

impl MemoryKeyStore {
    pub fn new() -> Self {
        Self::default()
    }
}

macro_rules! impl_store {
    ($t:ty, $lock:ident, $commit:ident) => {
        impl KeyStore for $t {
            fn load_device_keys(&self) -> Result<Option<StoredDeviceKeys>, StoreError> {
                Ok(self.$lock()?.device_keys.clone())
            }
            fn save_device_keys(&self, keys: &StoredDeviceKeys) -> Result<(), StoreError> {
                let mut g = self.$lock()?;
                g.device_keys = Some(keys.clone());
                self.$commit(&g)
            }
            fn load_room(&self) -> Result<Option<StoredRoom>, StoreError> {
                Ok(self.$lock()?.room.clone())
            }
            fn save_room(&self, room: &StoredRoom) -> Result<(), StoreError> {
                let mut g = self.$lock()?;
                g.room = Some(room.clone());
                self.$commit(&g)
            }
            fn delete_room(&self) -> Result<(), StoreError> {
                let mut g = self.$lock()?;
                g.room = None;
                self.$commit(&g)
            }
            fn load_phones(&self) -> Result<Vec<StoredPhone>, StoreError> {
                Ok(self.$lock()?.phones.values().cloned().collect())
            }
            fn save_phone(&self, phone: &StoredPhone) -> Result<(), StoreError> {
                let mut g = self.$lock()?;
                g.phones.insert(phone.id.to_b64u(), phone.clone());
                self.$commit(&g)
            }
            fn delete_phone(&self, id: &DeviceId) -> Result<(), StoreError> {
                let mut g = self.$lock()?;
                g.phones.remove(&id.to_b64u());
                self.$commit(&g)
            }
            fn load_counter(&self, name: &str) -> Result<u64, StoreError> {
                Ok(*self.$lock()?.counters.get(name).unwrap_or(&0))
            }
            fn save_counter(&self, name: &str, value: u64) -> Result<(), StoreError> {
                let mut g = self.$lock()?;
                g.counters.insert(name.to_string(), value);
                self.$commit(&g)
            }
            fn delete_counters_for(&self, id: &DeviceId) -> Result<(), StoreError> {
                let mut g = self.$lock()?;
                g.delete_counters_for(id);
                self.$commit(&g)
            }
        }
    };
}

impl MemoryKeyStore {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, StoreError> {
        self.inner.lock().map_err(|_| StoreError::new("poisoned"))
    }
    fn commit(&self, _: &Inner) -> Result<(), StoreError> {
        Ok(())
    }
}
impl_store!(MemoryKeyStore, lock, commit);

/// One JSON file, rewritten atomically (temp file + rename) on every change. For tests and
/// tools only: it keeps private keys and pair keys unencrypted.
pub struct JsonFileKeyStore {
    path: PathBuf,
    inner: Mutex<Inner>,
}

impl JsonFileKeyStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let path = path.as_ref().to_path_buf();
        let inner = match std::fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).map_err(|e| StoreError::new(format!("parse {e}")))?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Inner::default(),
            Err(e) => return Err(StoreError::new(format!("read {e}"))),
        };
        Ok(JsonFileKeyStore {
            path,
            inner: Mutex::new(inner),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Inner>, StoreError> {
        self.inner.lock().map_err(|_| StoreError::new("poisoned"))
    }

    fn commit(&self, g: &Inner) -> Result<(), StoreError> {
        let text = serde_json::to_vec_pretty(g).map_err(|e| StoreError::new(e.to_string()))?;
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, text).map_err(|e| StoreError::new(format!("write {e}")))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| StoreError::new(format!("rename {e}")))
    }
}
impl_store!(JsonFileKeyStore, lock, commit);

mod secret32 {
    use super::*;

    pub fn serialize<S: Serializer>(v: &Zeroizing<[u8; 32]>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&b64u_encode(v.as_ref()))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Zeroizing<[u8; 32]>, D::Error> {
        let text = String::deserialize(d)?;
        let bytes = Zeroizing::new(b64u_decode(&text).map_err(serde::de::Error::custom)?);
        let arr: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| serde::de::Error::custom("need 32 bytes"))?;
        Ok(Zeroizing::new(arr))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wt_protocol::{counter_key, SendCounter, SigningKeyPair};

    fn phone() -> StoredPhone {
        let k = SigningKeyPair::generate().unwrap();
        StoredPhone {
            id: k.device_id(),
            signing_spki: k.spki().clone(),
            agreement_spki: k.spki().clone(),
            key_p2c: Zeroizing::new([1; 32]),
            key_c2p: Zeroizing::new([2; 32]),
            name: Some("iPhone".into()),
            platform: Some("ios".into()),
            paired_at: 1,
        }
    }

    fn exercise(store: &dyn KeyStore) {
        assert!(store.load_device_keys().unwrap().is_none());
        let keys = StoredDeviceKeys {
            signing_scalar: Zeroizing::new([3; 32]),
            agreement_scalar: Zeroizing::new([4; 32]),
        };
        store.save_device_keys(&keys).unwrap();
        assert_eq!(store.load_device_keys().unwrap().unwrap(), keys);
        let room = StoredRoom {
            relay_url: "wss://r".into(),
            room_id: RoomId([5; 16]),
            salt: Salt([6; 16]),
            created: false,
        };
        store.save_room(&room).unwrap();
        assert_eq!(store.load_room().unwrap().unwrap(), room);
        let p = phone();
        store.save_phone(&p).unwrap();
        assert_eq!(store.load_phones().unwrap(), vec![p.clone()]);
        let me = DeviceId([9; 16]);
        let counters = StoreCounters(store);
        let mut c = SendCounter::open(&counters, counter_key(&me, &p.id)).unwrap();
        assert_eq!(c.next(&counters).unwrap(), 1);
        assert_eq!(
            store
                .load_counter(&format!("send:{}", counter_key(&me, &p.id)))
                .unwrap(),
            1000
        );
        store.save_counter("recv:other", 5).unwrap();
        store.delete_counters_for(&p.id).unwrap();
        assert_eq!(
            store
                .load_counter(&format!("send:{}", counter_key(&me, &p.id)))
                .unwrap(),
            0
        );
        assert_eq!(store.load_counter("recv:other").unwrap(), 5);
        store.delete_phone(&p.id).unwrap();
        assert!(store.load_phones().unwrap().is_empty());
        store.delete_room().unwrap();
        assert!(store.load_room().unwrap().is_none());
    }

    #[test]
    fn memory_store() {
        exercise(&MemoryKeyStore::new());
    }

    #[test]
    fn json_store_persists_across_reopen() {
        let dir = std::env::temp_dir().join(format!("wt-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("store.json");
        let _ = std::fs::remove_file(&path);
        exercise(&JsonFileKeyStore::open(&path).unwrap());
        let s = JsonFileKeyStore::open(&path).unwrap();
        let p = phone();
        s.save_phone(&p).unwrap();
        s.save_counter("recv:x", 42).unwrap();
        drop(s);
        let again = JsonFileKeyStore::open(&path).unwrap();
        assert_eq!(again.load_phones().unwrap(), vec![p]);
        assert_eq!(again.load_counter("recv:x").unwrap(), 42);
        assert!(!format!("{:?}", again.load_device_keys().unwrap()).contains("AwMD"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
