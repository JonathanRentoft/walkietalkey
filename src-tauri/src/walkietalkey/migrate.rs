//! One-time moves of stored settings to new defaults, all in one place.
//!
//! Version 2 (run 2, "plug and play"): users still on v1's defaults get the
//! new ones; anyone who chose otherwise keeps their choice.
//! - Tap or hold (DESK-22): v1's push-to-talk with 300 ms becomes
//!   hold-or-toggle with 500 ms.
//! - The pill for phone dictations (DESK-58): v1's `false` becomes `true`.
//! - "Udviklerord" (DESK-67): v1's `false` becomes `true`.
//! - walkietalkey.com (Phase 6): v1's relay and phone app addresses become
//!   relay.walkietalkey.com and app.walkietalkey.com. Both old addresses still
//!   reach the same relay and phone app, so existing pairings keep working.
//!
//! v1 persisted its defaults like any choice, so a v1 value equal to v1's
//! default is read as "never chosen". A fresh install already has the new
//! defaults and is only stamped.

use log::info;
use tauri::AppHandle;

use super::settings::{
    WtSettings, DEFAULT_PHONE_APP_URL, DEFAULT_RELAY_URL, SETTINGS_VERSION, V1_PHONE_APP_URL,
    V1_RELAY_URL,
};
use crate::settings::{AppSettings, ShortcutActivation};

/// v1's hold threshold.
const V1_HOLD_THRESHOLD_MS: u64 = 300;

/// What a migration changed.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Changed {
    pub handy: bool,
    pub walkietalkey: bool,
}

/// Brings `handy` and `wt` to [`SETTINGS_VERSION`]. `wt_stored` is whether
/// the store had WalkieTalkey settings at all (v1 wrote them on the first
/// change; a fresh install has none, and then `wt` holds the new defaults).
pub fn upgrade(handy: &mut AppSettings, wt: &mut WtSettings, wt_stored: bool) -> Changed {
    let version = if wt_stored { wt.settings_version } else { 0 };
    let mut changed = Changed::default();
    if version >= SETTINGS_VERSION {
        return changed;
    }
    if version < 2 {
        if handy.shortcut_activation == ShortcutActivation::PushToTalk
            && handy.hold_threshold_ms == V1_HOLD_THRESHOLD_MS
        {
            handy.shortcut_activation = ShortcutActivation::HoldOrToggle;
            handy.hold_threshold_ms = super::keys::DEFAULT_HOLD_THRESHOLD_MS;
            changed.handy = true;
        }
        if wt_stored {
            wt.pill_for_phone = true;
            wt.developer_words = true;
            if wt.relay_url == V1_RELAY_URL {
                wt.relay_url = DEFAULT_RELAY_URL.to_string();
            }
            if wt.phone_app_url == V1_PHONE_APP_URL {
                wt.phone_app_url = DEFAULT_PHONE_APP_URL.to_string();
            }
        }
    }
    wt.settings_version = SETTINGS_VERSION;
    changed.walkietalkey = true;
    changed
}

/// At start, before anything reads the key settings.
pub fn run(app: &AppHandle) {
    let (mut wt, wt_stored) = super::store::stored_user_settings(app);
    let mut handy = crate::settings::get_settings(app);
    let changed = upgrade(&mut handy, &mut wt, wt_stored);
    if changed.handy {
        info!("Settings: tap or hold with 0.5 s replaces v1's hold to talk (DESK-22)");
        crate::settings::write_settings(app, handy);
    }
    if changed.walkietalkey {
        let version = wt.settings_version;
        if let Err(e) = super::store::update_internal(app, move |stored| {
            stored.pill_for_phone = wt.pill_for_phone;
            stored.developer_words = wt.developer_words;
            stored.relay_url = wt.relay_url;
            stored.phone_app_url = wt.phone_app_url;
            stored.settings_version = version;
        }) {
            log::warn!("Settings migration could not be saved: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::get_default_settings;

    fn v1_handy() -> AppSettings {
        let mut handy = get_default_settings();
        handy.shortcut_activation = ShortcutActivation::PushToTalk;
        handy.hold_threshold_ms = 300;
        handy
    }

    fn v1_wt() -> WtSettings {
        WtSettings {
            pill_for_phone: false,
            developer_words: false,
            relay_url: V1_RELAY_URL.to_string(),
            phone_app_url: V1_PHONE_APP_URL.to_string(),
            settings_version: 0,
            ..WtSettings::default()
        }
    }

    #[test]
    fn v1_addresses_move_to_walkietalkey_com_and_chosen_ones_stay() {
        let (mut handy, mut wt) = (v1_handy(), v1_wt());
        upgrade(&mut handy, &mut wt, true);
        assert_eq!(wt.relay_url, "wss://relay.walkietalkey.com");
        assert_eq!(wt.phone_app_url, "https://app.walkietalkey.com");

        let (mut handy, mut wt) = (v1_handy(), v1_wt());
        wt.relay_url = "wss://relae.firma.dk".into();
        wt.phone_app_url = "https://diktat.firma.dk".into();
        upgrade(&mut handy, &mut wt, true);
        assert_eq!(wt.relay_url, "wss://relae.firma.dk");
        assert_eq!(wt.phone_app_url, "https://diktat.firma.dk");
    }

    #[test]
    fn v1_defaults_move_to_tap_or_hold_with_half_a_second() {
        // DESK-22, DESK-58, DESK-67.
        let (mut handy, mut wt) = (v1_handy(), v1_wt());
        let changed = upgrade(&mut handy, &mut wt, true);
        assert_eq!(
            changed,
            Changed {
                handy: true,
                walkietalkey: true
            }
        );
        assert_eq!(handy.shortcut_activation, ShortcutActivation::HoldOrToggle);
        assert_eq!(handy.hold_threshold_ms, 500);
        assert!(wt.pill_for_phone);
        assert!(wt.developer_words);
        assert_eq!(wt.settings_version, SETTINGS_VERSION);
    }

    #[test]
    fn a_v1_user_who_never_saved_walkietalkey_settings_is_migrated_too() {
        let mut handy = v1_handy();
        let mut wt = WtSettings::default(); // what the store reader returns
        let changed = upgrade(&mut handy, &mut wt, false);
        assert!(changed.handy);
        assert_eq!(handy.shortcut_activation, ShortcutActivation::HoldOrToggle);
        assert!(wt.pill_for_phone && wt.developer_words);
    }

    #[test]
    fn other_choices_are_kept() {
        for (mode, ms) in [
            (ShortcutActivation::Toggle, 300),
            (ShortcutActivation::PushToTalk, 450),
            (ShortcutActivation::HoldOrToggle, 300),
        ] {
            let mut handy = get_default_settings();
            handy.shortcut_activation = mode;
            handy.hold_threshold_ms = ms;
            let mut wt = v1_wt();
            assert!(!upgrade(&mut handy, &mut wt, true).handy, "{mode:?} {ms}");
            assert_eq!(handy.shortcut_activation, mode);
            assert_eq!(handy.hold_threshold_ms, ms);
        }
    }

    #[test]
    fn it_runs_once() {
        let (mut handy, mut wt) = (v1_handy(), v1_wt());
        upgrade(&mut handy, &mut wt, true);
        // The user then turns the phone pill off and picks push-to-talk/300.
        wt.pill_for_phone = false;
        handy.shortcut_activation = ShortcutActivation::PushToTalk;
        handy.hold_threshold_ms = 300;
        assert_eq!(upgrade(&mut handy, &mut wt, true), Changed::default());
        assert!(!wt.pill_for_phone);
        assert_eq!(handy.shortcut_activation, ShortcutActivation::PushToTalk);
    }

    #[test]
    fn a_fresh_install_is_only_stamped() {
        let mut handy = get_default_settings();
        let mut wt = WtSettings::default();
        let changed = upgrade(&mut handy, &mut wt, false);
        assert!(!changed.handy);
        assert!(changed.walkietalkey);
        assert_eq!(handy.shortcut_activation, ShortcutActivation::HoldOrToggle);
        assert!(wt.pill_for_phone && wt.developer_words);
    }
}
