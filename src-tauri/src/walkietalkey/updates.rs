//! Updates (spec 6.16): Tauri's updater with our own key (DESK-110, SEC-07:
//! every artifact is verified against the public key in tauri.conf.json
//! before install). Checks at start and every 6 hours, downloads in the
//! background and installs on the next restart, with "Genstart nu" in the
//! menu (DESK-111). Stable reads `latest.json` from GitHub's latest release
//! (which skips pre-releases); beta reads its own manifest (DESK-112). A
//! company can turn updates off (Appendix B `AutoUpdate`).

use std::sync::Mutex;
use std::time::Duration;

use log::{info, warn};
use once_cell::sync::Lazy;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use super::settings::UpdateChannel;

/// Stable: GitHub's "latest" release, which never points at a pre-release.
pub const STABLE_MANIFEST: &str =
    "https://github.com/JonathanRentoft/walkietalkey/releases/latest/download/latest.json";

/// Beta: written by the release workflow to the website (SITE-08). Until the
/// walkietalkey.com domain exists, the site's pages.dev address serves it.
pub const BETA_MANIFEST: &str = "https://walkietalkey-site.pages.dev/updates/beta.json";

pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

pub fn manifest_url(channel: UpdateChannel) -> &'static str {
    match channel {
        UpdateChannel::Stable => STABLE_MANIFEST,
        UpdateChannel::Beta => BETA_MANIFEST,
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum UpdateStatus {
    Checking,
    UpToDate,
    Downloading {
        version: String,
    },
    /// Installs on restart; "Genstart nu" is in the menu.
    Ready {
        version: String,
    },
    Failed {
        message: String,
    },
}

/// A downloaded update not yet installed (Windows installs on restart,
/// because its installer closes the app).
static PENDING: Lazy<Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>> =
    Lazy::new(|| Mutex::new(None));

fn emit(app: &AppHandle, status: UpdateStatus) {
    let _ = app.emit("wt-update-status", status);
}

fn enabled(app: &AppHandle) -> bool {
    let wt = super::store::get(app);
    let handy = crate::settings::get_settings(app);
    wt.auto_update && crate::settings::update_checks_effectively_enabled(&handy)
}

/// Starts the background schedule: a check now and every 6 hours.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            if enabled(&app) {
                check(&app).await;
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// "Søg efter opdateringer": a check now, whatever the schedule.
pub fn check_now(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { check(&app).await });
}

async fn check(app: &AppHandle) {
    if super::tray::update_ready() {
        return;
    }
    let channel = super::store::get(app).update_channel;
    emit(app, UpdateStatus::Checking);
    let updater = match app
        .updater_builder()
        .endpoints(vec![manifest_url(channel)
            .parse()
            .expect("valid manifest URL")])
        .and_then(|builder| builder.build())
    {
        Ok(updater) => updater,
        Err(e) => {
            warn!("Updater unavailable: {e}");
            emit(
                app,
                UpdateStatus::Failed {
                    message: e.to_string(),
                },
            );
            return;
        }
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            emit(app, UpdateStatus::UpToDate);
            return;
        }
        Err(e) => {
            info!("Update check failed: {e}");
            emit(
                app,
                UpdateStatus::Failed {
                    message: e.to_string(),
                },
            );
            return;
        }
    };
    let version = update.version.clone();
    info!("Update {version} found on the {channel:?} channel; downloading");
    emit(
        app,
        UpdateStatus::Downloading {
            version: version.clone(),
        },
    );
    // download() verifies the signature against our public key (SEC-07).
    let bytes = match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => bytes,
        Err(e) => {
            warn!("Update download failed: {e}");
            emit(
                app,
                UpdateStatus::Failed {
                    message: e.to_string(),
                },
            );
            return;
        }
    };
    // macOS replaces the app bundle now and runs the new version after the
    // restart; Windows keeps the bytes until the user restarts.
    if cfg!(target_os = "macos") {
        if let Err(e) = update.install(&bytes) {
            warn!("Update install failed: {e}");
            emit(
                app,
                UpdateStatus::Failed {
                    message: e.to_string(),
                },
            );
            return;
        }
    } else {
        *PENDING.lock().unwrap() = Some((update, bytes));
    }
    super::tray::set_update_ready(app);
    emit(app, UpdateStatus::Ready { version });
    super::notify::update_ready(app);
}

/// "Genstart nu": installs a pending update (Windows) and restarts.
pub fn restart_now(app: &AppHandle) {
    if let Some((update, bytes)) = PENDING.lock().unwrap().take() {
        if let Err(e) = update.install(&bytes) {
            warn!("Update install failed: {e}");
        }
    }
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels_have_their_own_manifests() {
        assert!(
            manifest_url(UpdateChannel::Stable).ends_with("/releases/latest/download/latest.json")
        );
        assert!(manifest_url(UpdateChannel::Beta).ends_with("/updates/beta.json"));
        assert!(manifest_url(UpdateChannel::Beta).starts_with("https://"));
        assert_eq!(CHECK_EVERY, Duration::from_secs(21_600));
    }
}
