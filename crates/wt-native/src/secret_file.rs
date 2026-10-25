//! The secret store on macOS (and other Unix systems): one private folder that only this user's
//! WalkieTalkey writes, instead of the login keychain (SEC-09, DESK-81, run 5).
//!
//! Why not the keychain: an app signed without an Apple Team ID (CI's ad-hoc builds, the local
//! self-signed identity) is trusted by the login keychain only for the exact build that created
//! an item (its `cdhash`), so after every update macOS asked for the login password before the
//! app could read its own keys, and the app's main thread waited in the keychain read until
//! the user answered. The data-protection keychain avoids that but needs a provisioning profile,
//! which needs an Apple Developer ID. This store never shows a dialog.
//!
//! The rules:
//!
//! - The folder is `0700` and owned by the user; every file in it is `0600`. Wider permissions
//!   found on start are tightened, a folder owned by someone else is refused, and symbolic links
//!   are never followed.
//! - Writes are atomic: a new temporary file (`0600` from its creation), written, `fsync`ed
//!   (`F_FULLFSYNC` on macOS), renamed over the old file, then the folder is synced. A crash
//!   leaves the old value or the new one, never half of one, and temporary files left by a crash
//!   are removed on the next start.
//! - The folder is excluded from Time Machine (the sticky `com_apple_backup_excludeItem`
//!   attribute that `tmutil addexclusion` sets), so a backup restored onto another Mac never
//!   brings this Mac's device identity along: two computers must never share one (SEC-10).
//! - The folder remembers which computer it belongs to (a hash of the host UUID, never the UUID
//!   itself). A copy that arrives on another computer anyway (a Migration Assistant transfer, a
//!   cloned disk) is emptied on its first start there, so that computer makes its own keys.
//! - Secrets never go to logs: errors name the operation, never the content.
//!
//! What it does not protect against: another program running as the same user can read the
//! files, as it could read an item of a keychain that is unlocked and allows it. The phone's
//! keys stay non-extractable WebCrypto keys (SEC-09); this is the computer's side only.

use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::secrets::SecretError;

/// The file that names the computer a folder belongs to.
pub const MACHINE_FILE: &str = ".machine";
/// Secret files end in this.
const SECRET_EXT: &str = "secret";
/// Temporary files of an unfinished write contain this.
const TMP_MARK: &str = ".tmp-";
/// The longest `service`/`account` pair (file names are at most 255 bytes).
const MAX_NAME_BYTES: usize = 120;

/// The attribute Time Machine reads (`tmutil addexclusion`, `CSBackupSetItemExcluded` with
/// `excludeByPath = false`): a binary property list holding the string "com.apple.backupd".
pub const BACKUP_EXCLUDE_XATTR: &str = "com.apple.metadata:com_apple_backup_excludeItem";
pub const BACKUP_EXCLUDE_VALUE: [u8; 61] = [
    0x62, 0x70, 0x6C, 0x69, 0x73, 0x74, 0x30, 0x30, 0x5F, 0x10, 0x11, 0x63, 0x6F, 0x6D, 0x2E, 0x61,
    0x70, 0x70, 0x6C, 0x65, 0x2E, 0x62, 0x61, 0x63, 0x6B, 0x75, 0x70, 0x64, 0x08, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1C,
];

/// What `open` found and did, for the app's log (never anything secret).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Opened {
    /// The folder was new (or empty).
    pub created: bool,
    /// It belonged to another computer and was emptied.
    pub reset_for_another_computer: bool,
    /// Temporary files of interrupted writes were removed.
    pub removed_temp_files: usize,
}

/// A private folder of secrets, by `service` and `account` like the keychain's generic
/// passwords. Calls on one instance are serialised.
pub struct SecretDir {
    dir: PathBuf,
    opened: Opened,
    lock: Mutex<()>,
}

impl std::fmt::Debug for SecretDir {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretDir").field("dir", &self.dir).finish()
    }
}

fn io_err(what: &str, e: io::Error) -> SecretError {
    if e.kind() == io::ErrorKind::PermissionDenied {
        SecretError::Denied(format!("{what}: {e}"))
    } else {
        SecretError::Platform(format!("{what}: {e}"))
    }
}

impl SecretDir {
    /// Opens (creating if needed) the folder at `dir` for this computer.
    pub fn open(dir: &Path) -> Result<Self, SecretError> {
        Self::open_for_machine(dir, this_machine().as_deref())
    }

    /// [`open`](Self::open) with the computer given (tests). `None`: binding is skipped.
    pub fn open_for_machine(dir: &Path, machine: Option<&str>) -> Result<Self, SecretError> {
        let mut opened = Opened::default();
        match fs::symlink_metadata(dir) {
            Ok(meta) => {
                if !meta.file_type().is_dir() {
                    return Err(SecretError::Platform(
                        "the secret folder is not a folder (or is a symbolic link)".into(),
                    ));
                }
                // SAFETY: geteuid has no preconditions.
                if meta.uid() != unsafe { libc::geteuid() } {
                    return Err(SecretError::Denied(
                        "the secret folder belongs to another user".into(),
                    ));
                }
                if meta.permissions().mode() & 0o077 != 0 {
                    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                        .map_err(|e| io_err("tightening the secret folder", e))?;
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(dir)
                    .map_err(|e| io_err("creating the secret folder", e))?;
                // `recursive` applies the mode to new parents too; the folder itself must be
                // 0700 whatever the umask did.
                fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
                    .map_err(|e| io_err("tightening the secret folder", e))?;
                opened.created = true;
            }
            Err(e) => return Err(io_err("reading the secret folder", e)),
        }
        if let Err(e) = exclude_from_backup(dir) {
            log::warn!("Could not exclude the secret folder from Time Machine: {e}");
        }
        let this = Self {
            dir: dir.to_path_buf(),
            opened,
            lock: Mutex::new(()),
        };
        this.opened_mut_scan(machine)
    }

    fn opened_mut_scan(mut self, machine: Option<&str>) -> Result<Self, SecretError> {
        // Interrupted writes: their temporary files never replaced anything.
        let mut entries = Vec::new();
        for entry in fs::read_dir(&self.dir).map_err(|e| io_err("listing the secret folder", e))? {
            let entry = entry.map_err(|e| io_err("listing the secret folder", e))?;
            let name = entry.file_name();
            if name.to_string_lossy().contains(TMP_MARK) {
                let _ = fs::remove_file(entry.path());
                self.opened.removed_temp_files += 1;
            } else {
                entries.push(name);
            }
        }
        if let Some(machine) = machine {
            let stamp = machine_stamp(machine);
            let path = self.dir.join(MACHINE_FILE);
            match read_small(&path) {
                Ok(Some(found)) if found.trim_ascii() == stamp.as_bytes() => {}
                Ok(Some(_)) => {
                    // A copy from another computer: its keys are that computer's identity.
                    for name in entries.iter().filter(|n| n.as_os_str() != MACHINE_FILE) {
                        remove_any(&self.dir.join(name))
                            .map_err(|e| io_err("emptying a copied secret folder", e))?;
                    }
                    self.opened.reset_for_another_computer = true;
                    entries.clear();
                    write_private(&path, stamp.as_bytes())
                        .map_err(|e| io_err("stamping the secret folder", e))?;
                }
                Ok(None) => write_private(&path, stamp.as_bytes())
                    .map_err(|e| io_err("stamping the secret folder", e))?,
                Err(e) => return Err(io_err("reading the secret folder's stamp", e)),
            }
        }
        if entries.iter().all(|n| n.as_os_str() == MACHINE_FILE) {
            self.opened.created = true;
        }
        Ok(self)
    }

    /// The folder, for state that must live and die with these keys (the relay's counters).
    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// What opening found.
    pub fn opened(&self) -> Opened {
        self.opened
    }

    fn file(&self, service: &str, account: &str) -> Result<PathBuf, SecretError> {
        Ok(self.dir.join(file_name(service, account)?))
    }

    /// Stores `secret` under `service`/`account`, replacing any earlier value atomically.
    pub fn set(&self, service: &str, account: &str, secret: &[u8]) -> Result<(), SecretError> {
        let path = self.file(service, account)?;
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        write_private(&path, secret).map_err(|e| io_err("writing a secret", e))
    }

    /// The secret under `service`/`account`, or `None` when there is none. An `Err` means the
    /// store could not be read; callers must not mistake it for "no key yet".
    pub fn get(
        &self,
        service: &str,
        account: &str,
    ) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
        let path = self.file(service, account)?;
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        read_private(&path).map_err(|e| io_err("reading a secret", e))
    }

    /// Deletes the secret under `service`/`account`; a missing one succeeds.
    pub fn delete(&self, service: &str, account: &str) -> Result<(), SecretError> {
        let path = self.file(service, account)?;
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        match fs::remove_file(&path) {
            Ok(()) => {
                sync_dir(&self.dir);
                Ok(())
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(io_err("deleting a secret", e)),
        }
    }
}

/// `<hex(service)>.<hex(account)>.secret`: unambiguous, and safe on every file system.
fn file_name(service: &str, account: &str) -> Result<String, SecretError> {
    if service.is_empty() || account.is_empty() {
        return Err(SecretError::EmptyName);
    }
    if service.len() + account.len() > MAX_NAME_BYTES {
        return Err(SecretError::TooLarge);
    }
    Ok(format!(
        "{}.{}.{SECRET_EXT}",
        hex(service.as_bytes()),
        hex(account.as_bytes())
    ))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What `.machine` holds for a computer: never the hardware id itself.
pub fn machine_stamp(machine: &str) -> String {
    let digest = Sha256::digest(format!("wt-secret-dir-v1\0{machine}").as_bytes());
    hex(&digest[..16])
}

/// This computer's identity for the binding: the host UUID on macOS (`gethostuuid`, no
/// permission needed), `/etc/machine-id` on Linux. `None` skips the binding.
pub fn this_machine() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut uuid = [0u8; 16];
        let wait = libc::timespec {
            tv_sec: 1,
            tv_nsec: 0,
        };
        // SAFETY: a 16-byte buffer, as gethostuuid requires.
        let rc = unsafe { libc::gethostuuid(uuid.as_mut_ptr(), &wait) };
        (rc == 0 && uuid != [0u8; 16]).then(|| hex(&uuid))
    }
    #[cfg(not(target_os = "macos"))]
    {
        fs::read_to_string("/etc/machine-id")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }
}

/// Writes `bytes` to `path` as a `0600` file, atomically and durably (see the module notes).
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no parent folder"))?;
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let tmp = dir.join(format!("{name}{TMP_MARK}{}-{nanos}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&tmp)?;
        file.write_all(bytes)?;
        // F_FULLFSYNC on Apple platforms (std's sync_all): on the disk, not only in its cache.
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result?;
    sync_dir(dir);
    Ok(())
}

/// Reads a private file: `None` when missing; never follows a symbolic link; tightens a file
/// that something made readable to others.
pub fn read_private(path: &Path) -> io::Result<Option<Zeroizing<Vec<u8>>>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !meta.file_type().is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if meta.permissions().mode() & 0o077 != 0 {
        log::warn!("A secret file was readable by others; making it private again");
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    let mut bytes = Zeroizing::new(Vec::with_capacity(meta.len() as usize));
    file.read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

fn read_small(path: &Path) -> io::Result<Option<Vec<u8>>> {
    Ok(read_private(path)?.map(|b| b.to_vec()))
}

fn remove_any(path: &Path) -> io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// Makes a rename or delete in `dir` durable, where the platform lets a folder be synced.
fn sync_dir(dir: &Path) {
    if let Ok(d) = File::open(dir) {
        let _ = d.sync_all();
    }
}

/// Sets the sticky Time Machine exclusion on `path` (macOS; elsewhere nothing to do).
pub fn exclude_from_backup(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
        let c_name = std::ffi::CString::new(BACKUP_EXCLUDE_XATTR)?;
        // SAFETY: valid NUL-terminated strings and a buffer of the given length.
        let rc = unsafe {
            libc::setxattr(
                c_path.as_ptr(),
                c_name.as_ptr(),
                BACKUP_EXCLUDE_VALUE.as_ptr().cast(),
                BACKUP_EXCLUDE_VALUE.len(),
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = path;
    Ok(())
}

/// Whether `path` carries the Time Machine exclusion (macOS; `false` elsewhere).
pub fn is_excluded_from_backup(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::ffi::OsStrExt;
        let (Ok(c_path), Ok(c_name)) = (
            std::ffi::CString::new(path.as_os_str().as_bytes()),
            std::ffi::CString::new(BACKUP_EXCLUDE_XATTR),
        ) else {
            return false;
        };
        let mut buf = [0u8; 128];
        // SAFETY: valid strings and a buffer of the given length.
        let n = unsafe {
            libc::getxattr(
                c_path.as_ptr(),
                c_name.as_ptr(),
                buf.as_mut_ptr().cast(),
                buf.len(),
                0,
                libc::XATTR_NOFOLLOW,
            )
        };
        n > 0 && buf[..n as usize] == BACKUP_EXCLUDE_VALUE
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp dir, removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "wt-secret-dir-{tag}-{}-{nanos}",
                std::process::id()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn join(&self, p: &str) -> PathBuf {
            self.0.join(p)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn mode(path: &Path) -> u32 {
        fs::symlink_metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn round_trip_overwrite_and_delete() {
        let s = Scratch::new("round");
        let store = SecretDir::open_for_machine(&s.join("secrets"), Some("mac-a")).unwrap();
        assert!(store.opened().created);
        assert!(store
            .get("WalkieTalkey relay", "device-keys")
            .unwrap()
            .is_none());
        store.delete("WalkieTalkey relay", "device-keys").unwrap();

        let first: Vec<u8> = (0u8..64).collect();
        store
            .set("WalkieTalkey relay", "device-keys", &first)
            .unwrap();
        assert_eq!(
            store
                .get("WalkieTalkey relay", "device-keys")
                .unwrap()
                .as_deref(),
            Some(&first)
        );
        store
            .set("WalkieTalkey relay", "device-keys", b"second")
            .unwrap();
        assert_eq!(
            store
                .get("WalkieTalkey relay", "device-keys")
                .unwrap()
                .as_deref(),
            Some(&b"second".to_vec())
        );
        // Another account (and another service) is another secret.
        assert!(store
            .get("WalkieTalkey relay", "phone:abc")
            .unwrap()
            .is_none());
        assert!(store
            .get("WalkieTalkey AI cleanup", "device-keys")
            .unwrap()
            .is_none());

        store.delete("WalkieTalkey relay", "device-keys").unwrap();
        assert!(store
            .get("WalkieTalkey relay", "device-keys")
            .unwrap()
            .is_none());

        // Reopened, a secret is still there (it is on disk, not in memory).
        store
            .set("WalkieTalkey AI cleanup", "openai", b"sk-test-fake")
            .unwrap();
        let again = SecretDir::open_for_machine(&s.join("secrets"), Some("mac-a")).unwrap();
        assert!(!again.opened().created);
        assert_eq!(
            again
                .get("WalkieTalkey AI cleanup", "openai")
                .unwrap()
                .as_deref(),
            Some(&b"sk-test-fake".to_vec())
        );
    }

    #[test]
    fn the_folder_is_0700_and_every_file_0600() {
        let s = Scratch::new("perms");
        let dir = s.join("secrets");
        let store = SecretDir::open_for_machine(&dir, Some("mac-a")).unwrap();
        store.set("svc", "acct", b"x").unwrap();
        assert_eq!(mode(&dir), 0o700);
        for name in files(&dir) {
            assert_eq!(mode(&dir.join(&name)), 0o600, "{name}");
        }
        // write_private makes 0600 files whatever the umask (other state in the folder).
        write_private(&dir.join("relay-state.json"), b"{}").unwrap();
        assert_eq!(mode(&dir.join("relay-state.json")), 0o600);
    }

    #[test]
    fn wider_permissions_are_tightened() {
        let s = Scratch::new("tighten");
        let dir = s.join("secrets");
        let store = SecretDir::open_for_machine(&dir, Some("mac-a")).unwrap();
        store.set("svc", "acct", b"x").unwrap();
        drop(store);
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        let file = dir.join(file_name("svc", "acct").unwrap());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();

        let store = SecretDir::open_for_machine(&dir, Some("mac-a")).unwrap();
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(
            store.get("svc", "acct").unwrap().as_deref(),
            Some(&b"x".to_vec())
        );
        assert_eq!(mode(&file), 0o600);
    }

    #[test]
    fn writes_are_atomic_and_leave_no_temporary_files() {
        let s = Scratch::new("atomic");
        let dir = s.join("secrets");
        let store = SecretDir::open_for_machine(&dir, Some("mac-a")).unwrap();
        store.set("svc", "acct", b"old").unwrap();
        let file = dir.join(file_name("svc", "acct").unwrap());
        let inode = fs::metadata(&file).unwrap().ino();

        // A replace is a rename of a new file, never an in-place truncate: a reader (or a
        // crash) sees the whole old value or the whole new one.
        store.set("svc", "acct", b"new value").unwrap();
        assert_ne!(fs::metadata(&file).unwrap().ino(), inode);
        assert!(
            files(&dir).iter().all(|n| !n.contains(TMP_MARK)),
            "{:?}",
            files(&dir)
        );

        // A crash in the middle of a write leaves a temporary file and the old value.
        let tmp = dir.join(format!(
            "{}{TMP_MARK}99999-1",
            file_name("svc", "acct").unwrap()
        ));
        fs::write(&tmp, b"half").unwrap();
        assert_eq!(
            store.get("svc", "acct").unwrap().as_deref(),
            Some(&b"new value".to_vec())
        );
        drop(store);
        // The next start removes it.
        let store = SecretDir::open_for_machine(&dir, Some("mac-a")).unwrap();
        assert_eq!(store.opened().removed_temp_files, 1);
        assert!(!tmp.exists());
        assert_eq!(
            store.get("svc", "acct").unwrap().as_deref(),
            Some(&b"new value".to_vec())
        );
    }

    #[test]
    fn a_failed_write_keeps_the_old_value() {
        let s = Scratch::new("failed");
        let dir = s.join("secrets");
        let store = SecretDir::open_for_machine(&dir, Some("mac-a")).unwrap();
        store.set("svc", "acct", b"old").unwrap();
        // A folder the write cannot create its temporary file in.
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o500)).unwrap();
        let result = store.set("svc", "acct", b"new");
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(
            store.get("svc", "acct").unwrap().as_deref(),
            Some(&b"old".to_vec())
        );
    }

    #[test]
    fn symbolic_links_are_never_followed() {
        let s = Scratch::new("links");
        let dir = s.join("secrets");
        let store = SecretDir::open_for_machine(&dir, Some("mac-a")).unwrap();
        let elsewhere = s.join("elsewhere");
        fs::write(&elsewhere, b"not ours").unwrap();
        std::os::unix::fs::symlink(&elsewhere, dir.join(file_name("svc", "acct").unwrap()))
            .unwrap();
        assert!(store.get("svc", "acct").is_err());
        // A write replaces the link itself, never the file it points to.
        store.set("svc", "acct", b"ours").unwrap();
        assert_eq!(fs::read(&elsewhere).unwrap(), b"not ours");

        // A folder that is a link is refused.
        let link = s.join("linked");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(SecretDir::open_for_machine(&link, Some("mac-a")).is_err());
    }

    #[test]
    fn a_copy_from_another_computer_starts_empty() {
        let s = Scratch::new("machine");
        let dir = s.join("secrets");
        let a = SecretDir::open_for_machine(&dir, Some("mac-a")).unwrap();
        a.set("WalkieTalkey relay", "device-keys", b"identity of mac a")
            .unwrap();
        fs::create_dir_all(dir.join("relay")).unwrap();
        write_private(&dir.join("relay").join("relay-state.json"), b"{}").unwrap();
        drop(a);

        // The same folder, restored or migrated onto mac B.
        let b = SecretDir::open_for_machine(&dir, Some("mac-b")).unwrap();
        assert!(b.opened().reset_for_another_computer);
        assert!(b.opened().created);
        assert!(b
            .get("WalkieTalkey relay", "device-keys")
            .unwrap()
            .is_none());
        assert!(!dir.join("relay").exists());
        b.set("WalkieTalkey relay", "device-keys", b"identity of mac b")
            .unwrap();
        drop(b);

        // Back on B: kept.
        let b = SecretDir::open_for_machine(&dir, Some("mac-b")).unwrap();
        assert!(!b.opened().reset_for_another_computer);
        assert_eq!(
            b.get("WalkieTalkey relay", "device-keys")
                .unwrap()
                .as_deref(),
            Some(&b"identity of mac b".to_vec())
        );
        // The stamp is a hash, not the hardware id.
        let stamp = fs::read_to_string(dir.join(MACHINE_FILE)).unwrap();
        assert_eq!(stamp, machine_stamp("mac-b"));
        assert!(!stamp.contains("mac-b"));
    }

    #[test]
    fn names_are_checked_and_unambiguous() {
        assert!(matches!(file_name("", "a"), Err(SecretError::EmptyName)));
        assert!(matches!(file_name("s", ""), Err(SecretError::EmptyName)));
        assert!(matches!(
            file_name(&"s".repeat(200), "a"),
            Err(SecretError::TooLarge)
        ));
        // "a.b" + "c" and "a" + "b.c" are different files.
        assert_ne!(
            file_name("a.b", "c").unwrap(),
            file_name("a", "b.c").unwrap()
        );
        // Path characters never reach the file name.
        let name = file_name("../x", "/etc").unwrap();
        let stem = name.strip_suffix(".secret").unwrap();
        assert!(
            stem.chars().all(|c| c.is_ascii_hexdigit() || c == '.'),
            "{name}"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_folder_is_excluded_from_time_machine() {
        let s = Scratch::new("backup");
        let dir = s.join("secrets");
        let _store = SecretDir::open_for_machine(&dir, Some("mac-a")).unwrap();
        assert!(is_excluded_from_backup(&dir));
        // Time Machine's own tool agrees (read only; needs no rights).
        if let Ok(out) = std::process::Command::new("/usr/bin/tmutil")
            .arg("isexcluded")
            .arg(&dir)
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            assert!(text.contains("[Excluded]"), "tmutil says: {text}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_mac_has_a_stable_identity() {
        let one = this_machine().expect("gethostuuid");
        assert_eq!(Some(one.clone()), this_machine());
        assert_eq!(one.len(), 32);
    }
}
