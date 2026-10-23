//! Secrets in the OS keychain (SEC-09, DESK-81): the macOS login Keychain and
//! Windows Credential Manager. Until the native module is linked in, keys
//! live in memory for the session only (nothing is ever written to a file).

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;

static MEMORY: Lazy<Mutex<HashMap<(String, String), Vec<u8>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
    MEMORY
        .lock()
        .unwrap()
        .insert((service.to_string(), account.to_string()), secret.to_vec());
    Ok(())
}

pub fn get(service: &str, account: &str) -> Option<Vec<u8>> {
    MEMORY
        .lock()
        .unwrap()
        .get(&(service.to_string(), account.to_string()))
        .cloned()
}

pub fn delete(service: &str, account: &str) -> Result<(), String> {
    MEMORY
        .lock()
        .unwrap()
        .remove(&(service.to_string(), account.to_string()));
    Ok(())
}
