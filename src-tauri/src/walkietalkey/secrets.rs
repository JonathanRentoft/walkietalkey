//! Secrets in the OS keychain (SEC-09, DESK-81): the macOS login Keychain and
//! Windows Credential Manager with local-machine persistence, so nothing
//! roams to another computer (SEC-10). Never in a settings file.

/// Stores a secret.
pub fn set(service: &str, account: &str, secret: &[u8]) -> Result<(), String> {
    wt_native::secrets::set(service, account, secret).map_err(|e| e.to_string())
}

/// Reads a secret; an unreadable keychain is an error, not "no secret", so
/// callers never mistake it for a first start.
pub fn get_checked(service: &str, account: &str) -> Result<Option<Vec<u8>>, String> {
    wt_native::secrets::get(service, account)
        .map(|secret| secret.map(|bytes| bytes.to_vec()))
        .map_err(|e| e.to_string())
}

/// Reads a secret where "absent" and "unreadable" lead to the same thing.
pub fn get(service: &str, account: &str) -> Option<Vec<u8>> {
    get_checked(service, account).unwrap_or_else(|e| {
        log::warn!("Keychain read failed for {service}: {e}");
        None
    })
}

pub fn delete(service: &str, account: &str) -> Result<(), String> {
    wt_native::secrets::delete(service, account).map_err(|e| e.to_string())
}
