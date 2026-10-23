//! The user's own API keys for cleanup providers (DESK-81): kept in the OS
//! keychain, never in settings files, and sent only to that provider. A
//! managed `CleanupApiKey` (Appendix B) wins and lives only in memory.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;

const SERVICE: &str = "WalkieTalkey AI cleanup";

/// Keys read this session, so the keychain is asked once.
static CACHE: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn set(provider: &str, key: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return delete(provider);
    }
    super::super::secrets::set(SERVICE, provider, key.as_bytes())?;
    CACHE
        .lock()
        .unwrap()
        .insert(provider.to_string(), key.to_string());
    Ok(())
}

pub fn delete(provider: &str) -> Result<(), String> {
    CACHE.lock().unwrap().remove(provider);
    super::super::secrets::delete(SERVICE, provider)
}

pub fn get(provider: &str) -> Option<String> {
    if let Some(key) = CACHE.lock().unwrap().get(provider) {
        return Some(key.clone());
    }
    let key = super::super::secrets::get(SERVICE, provider)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .filter(|k| !k.is_empty())?;
    CACHE
        .lock()
        .unwrap()
        .insert(provider.to_string(), key.clone());
    Some(key)
}

pub fn has(provider: &str) -> bool {
    get(provider).is_some()
}
