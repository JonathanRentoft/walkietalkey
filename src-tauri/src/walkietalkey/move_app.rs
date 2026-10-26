//! "Flyt til Programmer" (DESK-114). An app opened straight from its disk
//! image runs from the image or, quarantined, from a read-only App
//! Translocation copy, and the updater cannot replace either (DESK-113). One
//! click copies the running bundle to /Applications with `ditto` (signature
//! and resources intact), moves a copy already there to the Trash first (never
//! deletes it), clears the quarantine attribute (the user already opened this
//! exact app), and hands over to a small detached helper. The helper waits
//! until this process has exited (the single-instance plugin would otherwise
//! hand the new launch back to us), opens the copy in Programmer and ejects
//! the disk image. A standard user cannot write to /Applications: no admin
//! prompt, the window keeps the manual instruction.
//!
//! The paths, the mount lookup, the helper script and the move itself are
//! plain functions over any folders, so the tests run them in temp folders.
// Only macOS moves itself; the other platforms compile the command alone.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use specta::Type;

/// Where the app belongs.
pub const APPLICATIONS: &str = "/Applications";

/// Why the move did not happen; the window shows the Danish fallback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MoveError {
    /// This user may not write to /Applications (a standard user).
    NotWritable,
    /// Anything else; the message is for the log.
    Failed { message: String },
}

fn failed(message: impl std::fmt::Display) -> MoveError {
    MoveError::Failed {
        message: message.to_string(),
    }
}

/// The `.app` bundle around an executable at `<bundle>/Contents/MacOS/<exe>`;
/// None for a binary outside a bundle (a dev build in `target/`).
pub fn bundle_from_exe(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_app = bundle
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("app"));
    (macos.file_name()? == "MacOS" && contents.file_name()? == "Contents" && is_app)
        .then(|| bundle.to_path_buf())
}

/// A read-only copy macOS made of a quarantined app (App Translocation).
pub fn is_translocated(path: &Path) -> bool {
    path.to_string_lossy().contains("/AppTranslocation/")
}

/// `/private/var/...` and `/var/...` are the same folder; `mount` and
/// `current_exe` may print either.
fn without_private(path: &str) -> &str {
    match path.strip_prefix("/private") {
        Some(rest) if rest.starts_with('/') => rest,
        _ => path,
    }
}

/// Where a translocated bundle really lives: the source of the read-only
/// nullfs mount it runs from. `mount` prints
/// `/Volumes/WalkieTalkey/WalkieTalkey.app on /private/var/folders/../AppTranslocation/<uuid> (nullfs, ...)`
/// and the app runs from `<mount point>/d/WalkieTalkey.app`.
pub fn translocation_source(bundle: &Path, mount_output: &str) -> Option<PathBuf> {
    let bundle = bundle.to_string_lossy();
    let target = without_private(bundle.trim_end_matches('/'));
    let mut best: Option<(usize, PathBuf)> = None;
    for line in mount_output.lines() {
        let Some(opts) = line.rfind(" (") else {
            continue;
        };
        if !line[opts..].contains("nullfs") {
            continue;
        }
        let head = &line[..opts];
        // A path may hold " on " itself: try every split.
        for (at, _) in head.match_indices(" on ") {
            let source = &head[..at];
            let point = without_private(head[at + 4..].trim_end_matches('/'));
            let Some(rest) = target.strip_prefix(point) else {
                continue;
            };
            if !(rest.is_empty() || rest.starts_with('/')) {
                continue;
            }
            // The source is the bundle itself (macOS 10.12 and later); an
            // older layout mounted the folder around it.
            let original = if rest.is_empty() || source.ends_with(".app") {
                PathBuf::from(source)
            } else {
                Path::new(source).join(rest.trim_start_matches("/d/"))
            };
            if best.as_ref().is_none_or(|(len, _)| point.len() > *len) {
                best = Some((point.len(), original));
            }
        }
    }
    best.map(|(_, path)| path)
}

/// `/Volumes/<name>` for a path on a mounted volume.
fn volume_of(path: &Path) -> Option<PathBuf> {
    let mut parts = path.components();
    match (parts.next(), parts.next(), parts.next()) {
        (
            Some(Component::RootDir),
            Some(Component::Normal(volumes)),
            Some(Component::Normal(name)),
        ) if volumes == "Volumes" => Some(Path::new("/Volumes").join(name)),
        _ => None,
    }
}

/// The mounted disk image the running bundle came from, for the helper to
/// eject; None when it came from elsewhere (a quarantined app in Overførsler
/// is translocated too, and has nothing to eject).
pub fn source_volume(bundle: &Path, mount_output: &str) -> Option<PathBuf> {
    if is_translocated(bundle) {
        volume_of(&translocation_source(bundle, mount_output)?)
    } else {
        volume_of(bundle)
    }
}

/// A word for `sh`, quoted.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The detached helper: waits (at most 30 seconds) until process `pid` has
/// exited, opens `app`, then ejects `volume` and ignores a failure (the
/// translocated copy may still hold it; the user ejects it then).
pub fn relaunch_script(pid: u32, app: &Path, volume: Option<&Path>) -> String {
    let mut script = format!(
        "i=0\n\
         while kill -0 {pid} 2>/dev/null && [ \"$i\" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done\n\
         /usr/bin/open {}\n",
        sh_quote(&app.to_string_lossy())
    );
    if let Some(volume) = volume {
        let volume = sh_quote(&volume.to_string_lossy());
        script.push_str(&format!(
            "sleep 1\n\
             /usr/bin/hdiutil detach {volume} -quiet >/dev/null 2>&1 || {{ sleep 2; /usr/bin/hdiutil detach {volume} -quiet >/dev/null 2>&1; }} || true\n"
        ));
    }
    script
}

/// Copies the bundle `src` into `dst_dir` under its own name, as `ditto`
/// does (permissions, symlinks, extended attributes and signatures intact),
/// and clears the quarantine attribute on the copy. A copy already in
/// `dst_dir` goes to `trash` first, never deleted outright. Nothing is
/// written when `dst_dir` is not writable. Returns the new bundle's path.
pub fn move_bundle(
    src: &Path,
    dst_dir: &Path,
    trash: impl Fn(&Path) -> io::Result<()>,
) -> Result<PathBuf, MoveError> {
    let name = src
        .file_name()
        .ok_or_else(|| failed(format!("{} has no name", src.display())))?;
    let dst = dst_dir.join(name);
    if dst.exists() && fs::canonicalize(src).ok() == fs::canonicalize(&dst).ok() {
        return Ok(dst);
    }
    // A hidden folder next to the destination: proves the folder is writable
    // before anything else, and the copy appears under its name in one step.
    let staging = dst_dir.join(format!(
        ".{}.moving-{}",
        name.to_string_lossy(),
        std::process::id()
    ));
    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    match fs::create_dir(&staging) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
            return Err(MoveError::NotWritable)
        }
        Err(e) => return Err(failed(format!("{}: {e}", dst_dir.display()))),
    }
    let result = copy_and_swap(src, &staging.join(name), &dst, trash);
    let _ = fs::remove_dir_all(&staging);
    result.map(|()| dst)
}

fn copy_and_swap(
    src: &Path,
    copy: &Path,
    dst: &Path,
    trash: impl Fn(&Path) -> io::Result<()>,
) -> Result<(), MoveError> {
    let out = Command::new("/usr/bin/ditto")
        .arg(src)
        .arg(copy)
        .output()
        .map_err(|e| failed(format!("ditto: {e}")))?;
    if !out.status.success() {
        return Err(failed(format!(
            "ditto: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    // Absent on a copy that was never quarantined: the status is ignored.
    let _ = Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(copy)
        .output();
    if fs::symlink_metadata(dst).is_ok() {
        trash(dst).map_err(|e| match e.kind() {
            io::ErrorKind::PermissionDenied => MoveError::NotWritable,
            _ => failed(format!(
                "could not move {} to the Trash: {e}",
                dst.display()
            )),
        })?;
    }
    fs::rename(copy, dst).map_err(|e| failed(format!("{}: {e}", dst.display())))
}

/// The user's Trash, through NSFileManager: nothing is deleted, and unlike
/// asking Finder over AppleScript there is no Automation prompt.
#[cfg(target_os = "macos")]
fn move_to_trash(path: &Path) -> io::Result<()> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| {
            // NSFileWriteNoPermissionError
            let kind = if e.code() == 513 {
                io::ErrorKind::PermissionDenied
            } else {
                io::ErrorKind::Other
            };
            io::Error::new(kind, e.localizedDescription().to_string())
        })
}

#[cfg(target_os = "macos")]
fn spawn_detached(script: &str) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    Command::new("/bin/sh")
        .arg("-c")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own process group, so it outlives this app.
        .process_group(0)
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn move_and_relaunch(app: &tauri::AppHandle) -> Result<(), MoveError> {
    use log::info;
    let exe = std::env::current_exe().map_err(failed)?;
    if !super::updates::runs_from_disk_image(&exe) {
        return Err(failed("WalkieTalkey does not run from a disk image"));
    }
    let bundle = bundle_from_exe(&exe).ok_or_else(|| failed("not inside an app bundle"))?;
    let mounts = Command::new("/sbin/mount")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let volume = source_volume(&bundle, &mounts);
    let dst = move_bundle(&bundle, Path::new(APPLICATIONS), move_to_trash)?;
    info!(
        "Moved {} to {}; relaunching from there",
        bundle.display(),
        dst.display()
    );
    spawn_detached(&relaunch_script(
        std::process::id(),
        &dst,
        volume.as_deref(),
    ))
    .map_err(|e| failed(format!("could not start the relaunch helper: {e}")))?;
    app.exit(0);
    Ok(())
}

/// "Flyt til Programmer": moves the app to /Applications, opens it from there
/// and quits this copy (DESK-114). macOS only.
#[tauri::command]
#[specta::specta]
pub async fn wt_move_to_applications(app: tauri::AppHandle) -> Result<(), MoveError> {
    #[cfg(target_os = "macos")]
    {
        let result = tauri::async_runtime::spawn_blocking(move || move_and_relaunch(&app))
            .await
            .map_err(failed)?;
        if let Err(e) = &result {
            log::warn!("Could not move WalkieTalkey to Programmer: {e:?}");
        }
        result
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(failed("only on macOS"))
    }
}

// ditto and xattr are macOS tools.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    const TRANSLOCATED: &str = "/private/var/folders/18/bc5s/T/AppTranslocation/7DF2259B-44AF-44D5-920A-231DC205F74D/d/WalkieTalkey.app";

    /// `mount` on macOS 26 with a translocated app from a disk image (the
    /// line's format as macOS prints it on the owner's Mac).
    fn mounts(source: &str) -> String {
        format!(
            "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n\
             devfs on /dev (devfs, local, nobrowse)\n\
             /dev/disk5s2 on /Volumes/WalkieTalkey 0.2.1 (hfs, local, nodev, nosuid, read-only, noowners, quarantine, mounted by me)\n\
             /Users/me/Downloads/Other.app on /private/var/folders/18/bc5s/T/AppTranslocation/0000AAAA-0000-0000-0000-000000000000 (nullfs, local, nodev, nosuid, read-only, nobrowse, mounted by me)\n\
             {source} on /private/var/folders/18/bc5s/T/AppTranslocation/7DF2259B-44AF-44D5-920A-231DC205F74D (nullfs, local, nodev, nosuid, read-only, nobrowse, mounted by me)\n"
        )
    }

    #[test]
    fn the_bundle_is_found_from_the_executable() {
        assert_eq!(
            bundle_from_exe(Path::new(&format!(
                "{TRANSLOCATED}/Contents/MacOS/walkietalkey"
            ))),
            Some(PathBuf::from(TRANSLOCATED))
        );
        assert_eq!(
            bundle_from_exe(Path::new(
                "/Volumes/WalkieTalkey/WalkieTalkey.app/Contents/MacOS/walkietalkey"
            )),
            Some(PathBuf::from("/Volumes/WalkieTalkey/WalkieTalkey.app"))
        );
        // A dev build is no bundle.
        assert_eq!(
            bundle_from_exe(Path::new(
                "/Volumes/SSD/walkietalkey/target/debug/walkietalkey"
            )),
            None
        );
        assert_eq!(bundle_from_exe(Path::new("/walkietalkey")), None);
    }

    #[test]
    fn a_translocated_copy_leads_back_to_its_disk_image() {
        let out = mounts("/Volumes/WalkieTalkey 0.2.1/WalkieTalkey.app");
        assert!(is_translocated(Path::new(TRANSLOCATED)));
        assert_eq!(
            translocation_source(Path::new(TRANSLOCATED), &out),
            Some(PathBuf::from(
                "/Volumes/WalkieTalkey 0.2.1/WalkieTalkey.app"
            ))
        );
        assert_eq!(
            source_volume(Path::new(TRANSLOCATED), &out),
            Some(PathBuf::from("/Volumes/WalkieTalkey 0.2.1"))
        );
        // current_exe may say /var where mount says /private/var.
        let short = TRANSLOCATED.strip_prefix("/private").unwrap();
        assert_eq!(
            source_volume(Path::new(short), &out),
            Some(PathBuf::from("/Volumes/WalkieTalkey 0.2.1"))
        );
    }

    #[test]
    fn a_path_with_on_in_it_is_still_found() {
        let out = mounts("/Volumes/Hold on/WalkieTalkey.app");
        assert_eq!(
            source_volume(Path::new(TRANSLOCATED), &out),
            Some(PathBuf::from("/Volumes/Hold on"))
        );
    }

    #[test]
    fn nothing_is_ejected_for_an_app_from_downloads_or_programmer() {
        let out = mounts("/Users/me/Downloads/WalkieTalkey.app");
        assert_eq!(
            translocation_source(Path::new(TRANSLOCATED), &out),
            Some(PathBuf::from("/Users/me/Downloads/WalkieTalkey.app"))
        );
        assert_eq!(source_volume(Path::new(TRANSLOCATED), &out), None);
        // No nullfs mount for it at all.
        assert_eq!(
            source_volume(Path::new(TRANSLOCATED), "devfs on /dev (devfs)\n"),
            None
        );
        assert_eq!(
            source_volume(Path::new("/Applications/WalkieTalkey.app"), &out),
            None
        );
        // Opened from the mounted image itself (not translocated).
        assert_eq!(
            source_volume(Path::new("/Volumes/WalkieTalkey/WalkieTalkey.app"), ""),
            Some(PathBuf::from("/Volumes/WalkieTalkey"))
        );
    }

    #[test]
    fn the_helper_waits_for_this_process_then_opens_programmer_and_ejects() {
        let s = relaunch_script(
            4242,
            Path::new("/Applications/WalkieTalkey.app"),
            Some(Path::new("/Volumes/Walkie's Talkey")),
        );
        let wait = s.find("kill -0 4242").expect("waits for the old process");
        let open = s
            .find("/usr/bin/open '/Applications/WalkieTalkey.app'")
            .expect("opens the copy in Programmer");
        let eject = s
            .find(r"/usr/bin/hdiutil detach '/Volumes/Walkie'\''s Talkey'")
            .expect("ejects the disk image, quoted");
        assert!(wait < open && open < eject);
        assert!(s.contains("|| true"), "an eject that fails is ignored");
        assert!(s.contains("-lt 300"), "gives up waiting after 30 seconds");
        let check = Command::new("/bin/sh")
            .arg("-n")
            .arg("-c")
            .arg(&s)
            .status()
            .unwrap();
        assert!(check.success(), "valid sh:\n{s}");

        let none = relaunch_script(1, Path::new("/Applications/WalkieTalkey.app"), None);
        assert!(!none.contains("hdiutil"));
    }

    #[test]
    fn the_helper_really_waits_until_the_process_is_gone() {
        // A stand-in for this app that quits after half a second; `open` of a
        // path that does not exist only prints an error, so nothing opens.
        let mut old = Command::new("/bin/sleep").arg("0.5").spawn().unwrap();
        let script = relaunch_script(
            old.id(),
            Path::new("/nonexistent/WalkieTalkey-test.app"),
            None,
        );
        let started = std::time::Instant::now();
        let reaper = std::thread::spawn(move || old.wait());
        Command::new("/bin/sh")
            .arg("-c")
            .arg(&script)
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(400));
        reaper.join().unwrap().unwrap();
    }

    /// A fake bundle: an executable, a plist and a symlink, as in a real one.
    fn fake_bundle(dir: &Path, version: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let app = dir.join("WalkieTalkey.app");
        fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        fs::create_dir_all(app.join("Contents/Frameworks/Lib.framework/Versions/A")).unwrap();
        let exe = app.join("Contents/MacOS/walkietalkey");
        fs::write(&exe, format!("#!/bin/sh\necho {version}\n")).unwrap();
        fs::set_permissions(&exe, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(app.join("Contents/Info.plist"), version).unwrap();
        std::os::unix::fs::symlink(
            "Versions/A",
            app.join("Contents/Frameworks/Lib.framework/Current"),
        )
        .unwrap();
        app
    }

    /// A Trash that keeps what it gets, like the real one.
    fn fake_trash(dir: &Path) -> impl Fn(&Path) -> io::Result<()> + '_ {
        move |p: &Path| {
            fs::create_dir_all(dir)?;
            fs::rename(p, dir.join(p.file_name().unwrap()))
        }
    }

    fn no_leftovers(dir: &Path) {
        let names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["WalkieTalkey.app".to_string()], "{names:?}");
    }

    #[test]
    fn the_bundle_is_copied_whole_into_the_folder() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let image = tmp.path().join("image");
        let apps = tmp.path().join("Applications");
        fs::create_dir_all(&image).unwrap();
        fs::create_dir_all(&apps).unwrap();
        let src = fake_bundle(&image, "0.2.2");

        let dst = move_bundle(&src, &apps, |_| panic!("nothing to trash")).unwrap();
        assert_eq!(dst, apps.join("WalkieTalkey.app"));
        assert_eq!(
            fs::read_to_string(dst.join("Contents/Info.plist")).unwrap(),
            "0.2.2"
        );
        let mode = fs::metadata(dst.join("Contents/MacOS/walkietalkey"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "still executable");
        assert_eq!(
            fs::read_link(dst.join("Contents/Frameworks/Lib.framework/Current")).unwrap(),
            PathBuf::from("Versions/A"),
            "symlinks stay symlinks"
        );
        assert!(
            src.join("Contents/Info.plist").exists(),
            "the original is left alone"
        );
        no_leftovers(&apps);
    }

    #[test]
    fn a_copy_already_in_programmer_goes_to_the_trash() {
        let tmp = tempfile::tempdir().unwrap();
        let image = tmp.path().join("image");
        let apps = tmp.path().join("Applications");
        let trash = tmp.path().join("Trash");
        fs::create_dir_all(&image).unwrap();
        fs::create_dir_all(&apps).unwrap();
        let src = fake_bundle(&image, "0.2.2");
        fake_bundle(&apps, "0.2.0");

        let dst = move_bundle(&src, &apps, fake_trash(&trash)).unwrap();
        assert_eq!(
            fs::read_to_string(dst.join("Contents/Info.plist")).unwrap(),
            "0.2.2"
        );
        assert_eq!(
            fs::read_to_string(trash.join("WalkieTalkey.app/Contents/Info.plist")).unwrap(),
            "0.2.0",
            "the old copy is in the Trash, not deleted"
        );
        no_leftovers(&apps);
    }

    #[test]
    fn a_trash_that_refuses_leaves_the_old_copy_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let image = tmp.path().join("image");
        let apps = tmp.path().join("Applications");
        fs::create_dir_all(&image).unwrap();
        fs::create_dir_all(&apps).unwrap();
        let src = fake_bundle(&image, "0.2.2");
        fake_bundle(&apps, "0.2.0");

        let refused = move_bundle(&src, &apps, |_| {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "owned by root",
            ))
        });
        assert_eq!(refused, Err(MoveError::NotWritable));
        let other = move_bundle(&src, &apps, |_| Err(io::Error::other("busy")));
        assert!(matches!(other, Err(MoveError::Failed { .. })), "{other:?}");
        assert_eq!(
            fs::read_to_string(apps.join("WalkieTalkey.app/Contents/Info.plist")).unwrap(),
            "0.2.0"
        );
        no_leftovers(&apps);
    }

    #[test]
    fn a_folder_this_user_cannot_write_to_is_said_plainly() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let image = tmp.path().join("image");
        let apps = tmp.path().join("Applications");
        fs::create_dir_all(&image).unwrap();
        fs::create_dir_all(&apps).unwrap();
        let src = fake_bundle(&image, "0.2.2");
        fs::set_permissions(&apps, fs::Permissions::from_mode(0o555)).unwrap();

        let result = move_bundle(&src, &apps, |_| panic!("nothing to trash"));
        fs::set_permissions(&apps, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(result, Err(MoveError::NotWritable));
        assert_eq!(fs::read_dir(&apps).unwrap().count(), 0, "nothing written");
    }

    #[test]
    fn the_copy_is_not_quarantined_again() {
        let tmp = tempfile::tempdir().unwrap();
        let image = tmp.path().join("image");
        let apps = tmp.path().join("Applications");
        fs::create_dir_all(&image).unwrap();
        fs::create_dir_all(&apps).unwrap();
        let src = fake_bundle(&image, "0.2.2");
        let quarantine = |p: &Path| {
            Command::new("/usr/bin/xattr")
                .args(["-p", "com.apple.quarantine"])
                .arg(p)
                .output()
                .unwrap()
                .status
                .success()
        };
        let set = Command::new("/usr/bin/xattr")
            .args(["-w", "com.apple.quarantine", "0081;6720f000;Safari;"])
            .arg(src.join("Contents/Info.plist"))
            .status()
            .unwrap();
        assert!(set.success());
        assert!(quarantine(&src.join("Contents/Info.plist")));

        let dst = move_bundle(&src, &apps, |_| panic!("nothing to trash")).unwrap();
        assert!(!quarantine(&dst.join("Contents/Info.plist")));
    }

    #[test]
    fn errors_reach_the_window_as_tagged_kinds() {
        assert_eq!(
            serde_json::to_value(MoveError::NotWritable).unwrap(),
            serde_json::json!({ "kind": "not_writable" })
        );
        assert_eq!(
            serde_json::to_value(failed("x")).unwrap(),
            serde_json::json!({ "kind": "failed", "message": "x" })
        );
    }
}
