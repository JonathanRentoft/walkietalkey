//! System notifications (DESK-56, DESK-57). Tauri v2's notification plugin cannot report a
//! click on desktop, so posting and the click handler live here.
//!
//! - **macOS**: `UNUserNotificationCenter` with our own delegate. The history id travels in
//!   the notification's `userInfo` (`"history_id"`); `didReceiveNotificationResponse` hands
//!   it to the [`on_click`] handler, and `willPresentNotification` shows the banner even
//!   while the app is frontmost. `UNUserNotificationCenter` only works inside a bundled
//!   `.app` (it throws an Objective-C exception without one, for example under `cargo test`
//!   or `tauri dev`), so outside a bundle every call returns [`NotifyError::NotBundled`].
//! - **Windows**: toasts through `ToastNotificationManager` with the app's AUMID (the Tauri
//!   identifier, `com.walkietalkey.app`, which the installer's Start menu shortcut carries).
//!   The history id is the toast's `launch` argument (`historyId=42`); the toast's
//!   `Activated` event calls the handler. The most recent toasts are kept alive so the event
//!   still fires for a click in Action Center while the app runs. A toast clicked after the
//!   app quit only starts the app (no COM activator is registered).
//! - Elsewhere: [`NotifyError::Unsupported`].
//!
//! # Threads
//!
//! [`init`], [`post`] and [`on_click`] may be called from any thread. [`request_permission`]
//! blocks until the user answers the system prompt, so call it off the main thread (a Tauri
//! async command or `spawn_blocking`). The click handler runs on a system thread, not the
//! main thread: hand the work to the app (an event, `run_on_main_thread`).
//!
//! # Lifecycle
//!
//! Call [`init`] once in Tauri's `setup` hook, then [`on_click`]. On macOS that installs the
//! delegate before launch finishes, so a click that started the app is delivered too; a
//! click that arrives before a handler is registered is kept and handed to it.

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Mutex, RwLock};

/// Why a notification call failed.
#[derive(Debug, thiserror::Error)]
pub enum NotifyError {
    /// macOS: not running from a bundled `.app` (no bundle identifier or bundle path).
    #[error("notifications need the bundled app (.app with a bundle identifier)")]
    NotBundled,
    /// Windows: [`init`] has not been given the app's AUMID.
    #[error("notifications are not initialised; call notifications::init first")]
    NotInitialized,
    /// The system did not answer in time.
    #[error("the notification system did not answer in time")]
    Timeout,
    #[error("notification error: {0}")]
    Platform(String),
    #[error("no notification support on this platform")]
    Unsupported,
}

/// Receives the history id of a clicked notification (`None` for notifications posted
/// without one).
pub type ClickHandler = Box<dyn Fn(Option<i64>) + Send + Sync + 'static>;

/// Prepares notifications. `app_id` is the Windows AUMID (the app's Tauri identifier); macOS
/// uses the bundle's own identifier and installs the delegate here. Safe to call again.
pub fn init(app_id: &str) -> Result<(), NotifyError> {
    imp::init(app_id)
}

/// Whether notifications can be posted in this process (macOS: running as a bundled app;
/// Windows: [`init`] was called).
pub fn available() -> bool {
    imp::available()
}

/// Registers the click handler, replacing an earlier one. A click that arrived before any
/// handler was registered is delivered to this one right away.
pub fn on_click(handler: ClickHandler) {
    let handler: Arc<dyn Fn(Option<i64>) + Send + Sync> = Arc::from(handler);
    *HANDLER.write().unwrap_or_else(|p| p.into_inner()) = Some(handler);
    let pending = PENDING.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(history_id) = pending {
        dispatch_click(history_id);
    }
}

/// Asks for permission to show notifications (DESK-15) and returns whether they are allowed.
/// macOS shows the system prompt the first time and blocks until the user answers (at most
/// [`PERMISSION_PROMPT_TIMEOUT`]); later calls return the stored answer at once. Windows has
/// no prompt: the answer is whether toasts are enabled for the app.
pub fn request_permission() -> Result<bool, NotifyError> {
    imp::request_permission()
}

/// Posts a notification. `history_id` is handed to the click handler (DESK-57).
pub fn post(title: &str, body: &str, history_id: Option<i64>) -> Result<(), NotifyError> {
    imp::post(title, body, history_id)
}

/// How long [`request_permission`] waits for the user's answer.
pub const PERMISSION_PROMPT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

type SharedHandler = Arc<dyn Fn(Option<i64>) + Send + Sync>;

static HANDLER: RwLock<Option<SharedHandler>> = RwLock::new(None);
/// A click that arrived before [`on_click`] (the click that launched the app).
static PENDING: Mutex<Option<Option<i64>>> = Mutex::new(None);

/// Hands a click to the handler, or keeps it until one is registered. A panicking handler
/// is contained: unwinding into the OS callback would abort the app.
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub(crate) fn dispatch_click(history_id: Option<i64>) {
    let handler = HANDLER.read().unwrap_or_else(|p| p.into_inner()).clone();
    match handler {
        Some(handler) => {
            if std::panic::catch_unwind(AssertUnwindSafe(|| handler(history_id))).is_err() {
                log::error!("The notification click handler panicked");
            }
        }
        None => *PENDING.lock().unwrap_or_else(|p| p.into_inner()) = Some(history_id),
    }
}

/// Windows: the toast's `launch` argument for a history id.
#[cfg_attr(not(windows), allow(dead_code))]
fn launch_argument(history_id: Option<i64>) -> String {
    history_id
        .map(|id| format!("historyId={id}"))
        .unwrap_or_default()
}

/// Windows: the history id back from a toast's activation arguments.
#[cfg_attr(not(windows), allow(dead_code))]
fn history_id_from_launch(arguments: &str) -> Option<i64> {
    arguments
        .split('&')
        .find_map(|pair| pair.strip_prefix("historyId="))
        .and_then(|id| id.parse().ok())
}

/// Windows: the toast XML (generic template, title and optional body).
#[cfg_attr(not(windows), allow(dead_code))]
fn toast_xml(title: &str, body: &str, history_id: Option<i64>) -> String {
    let mut texts = format!("<text>{}</text>", xml_escape(title));
    if !body.is_empty() {
        texts.push_str(&format!("<text>{}</text>", xml_escape(body)));
    }
    format!(
        "<toast launch=\"{}\"><visual><binding template=\"ToastGeneric\">{texts}</binding></visual></toast>",
        xml_escape(&launch_argument(history_id))
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Characters XML 1.0 cannot carry at all.
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(target_os = "macos")]
pub(crate) mod imp {
    use std::sync::mpsc;
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{
        NSBundle, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol, NSString,
    };
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent,
        UNNotification, UNNotificationDismissActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNNotificationSettings,
        UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };

    use super::NotifyError;
    use crate::notification_permission::PermissionState;

    /// The `userInfo` key that carries the history id.
    pub const HISTORY_ID_KEY: &str = "history_id";

    const SETTINGS_TIMEOUT: Duration = Duration::from_secs(5);

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and Delegate has no Drop.
        #[unsafe(super = NSObject)]
        #[name = "WTNativeNotificationDelegate"]
        pub struct Delegate;

        // SAFETY: NSObjectProtocol has no safety requirements.
        unsafe impl NSObjectProtocol for Delegate {}

        // SAFETY: the method signatures match the protocol.
        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            /// Shows the banner (and keeps it in Notification Center) while the app is
            /// frontmost, where macOS would otherwise drop it silently.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion_handler.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
            }

            /// A click on the notification (DESK-57).
            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &block2::DynBlock<dyn Fn()>,
            ) {
                // SAFETY: a framework constant.
                let dismissed = &*response.actionIdentifier()
                    == unsafe { UNNotificationDismissActionIdentifier };
                if !dismissed {
                    let info = response.notification().request().content().userInfo();
                    super::dispatch_click(history_id_from_user_info(&info));
                }
                completion_handler.call(());
            }
        }
    );

    impl Delegate {
        pub fn new() -> Retained<Self> {
            let this = Self::alloc().set_ivars(());
            // SAFETY: NSObject's designated initialiser.
            unsafe { msg_send![super(this), init] }
        }
    }

    /// True when this process runs from a bundled `.app` with a bundle identifier, the only
    /// case in which `UNUserNotificationCenter` does not throw.
    pub fn bundled() -> bool {
        let bundle = NSBundle::mainBundle();
        bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
    }

    /// The notification center, or an error instead of an uncaught Objective-C exception.
    ///
    /// The bundle check is what keeps the process alive: outside a bundle
    /// `currentNotificationCenter` throws `NSInternalInconsistencyException`
    /// ("bundleProxyForCurrentProcess is nil") inside `dispatch_once`, where libdispatch
    /// terminates the process before any handler can catch it. The `catch` only covers
    /// exceptions thrown elsewhere.
    pub fn center() -> Result<Retained<UNUserNotificationCenter>, NotifyError> {
        if !bundled() {
            return Err(NotifyError::NotBundled);
        }
        objc2::exception::catch(UNUserNotificationCenter::currentNotificationCenter).map_err(
            |exception| {
                NotifyError::Platform(
                    exception
                        .map(|e| format!("{e:?}"))
                        .unwrap_or_else(|| "Objective-C exception".into()),
                )
            },
        )
    }

    /// Installs the delegate once. The center keeps only a weak reference, so the delegate
    /// lives for the rest of the process.
    fn ensure_delegate(center: &UNUserNotificationCenter) {
        static INSTALLED: OnceLock<()> = OnceLock::new();
        // Serialises the first installation; `OnceLock` alone cannot hold the !Send delegate.
        static INSTALLING: Mutex<()> = Mutex::new(());
        let _guard = INSTALLING.lock().unwrap_or_else(|p| p.into_inner());
        INSTALLED.get_or_init(|| {
            let delegate = Delegate::new();
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            std::mem::forget(delegate);
        });
    }

    pub fn init(app_id: &str) -> Result<(), NotifyError> {
        let center = center()?;
        if let Some(id) = NSBundle::mainBundle().bundleIdentifier() {
            if id.to_string() != app_id {
                log::warn!("Notifications use bundle id {id}, not {app_id}");
            }
        }
        ensure_delegate(&center);
        Ok(())
    }

    pub fn available() -> bool {
        bundled()
    }

    pub fn request_permission() -> Result<bool, NotifyError> {
        let center = center()?;
        ensure_delegate(&center);
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            if !error.is_null() {
                // SAFETY: a non-null NSError from the framework.
                let error = unsafe { &*error };
                log::warn!(
                    "Notification permission request failed: {}",
                    error.localizedDescription()
                );
            }
            let _ = tx.send(granted.as_bool());
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &block,
        );
        rx.recv_timeout(super::PERMISSION_PROMPT_TIMEOUT)
            .map_err(|_| NotifyError::Timeout)
    }

    pub fn permission_state() -> Result<PermissionState, NotifyError> {
        let center = center()?;
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
            // SAFETY: the framework passes a valid settings object.
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let _ = tx.send(status);
        });
        center.getNotificationSettingsWithCompletionHandler(&block);
        let status = rx
            .recv_timeout(SETTINGS_TIMEOUT)
            .map_err(|_| NotifyError::Timeout)?;
        Ok(state_from_status(status))
    }

    pub fn state_from_status(status: UNAuthorizationStatus) -> PermissionState {
        match status {
            UNAuthorizationStatus::NotDetermined => PermissionState::NotDetermined,
            UNAuthorizationStatus::Denied => PermissionState::Denied,
            // Authorized, Provisional (quiet delivery) and Ephemeral all deliver.
            _ => PermissionState::Granted,
        }
    }

    pub fn post(title: &str, body: &str, history_id: Option<i64>) -> Result<(), NotifyError> {
        let center = center()?;
        ensure_delegate(&center);
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        // SAFETY: a dictionary of NSString keys and property-list values.
        unsafe { content.setUserInfo(&user_info(history_id)) };
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&request_identifier()),
            &content,
            None,
        );
        let done = RcBlock::new(|error: *mut NSError| {
            if !error.is_null() {
                // SAFETY: a non-null NSError from the framework.
                let error = unsafe { &*error };
                log::warn!("Notification not shown: {}", error.localizedDescription());
            }
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&done));
        Ok(())
    }

    /// A unique request identifier: requests with the same identifier replace each other.
    fn request_identifier() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        format!("wt-{millis}-{}", NEXT.fetch_add(1, Ordering::Relaxed))
    }

    /// `userInfo` for a notification: `{"history_id": <id>}`, or empty.
    pub fn user_info(history_id: Option<i64>) -> Retained<NSDictionary> {
        let dict: Retained<NSDictionary<NSString, AnyObject>> = match history_id {
            Some(id) => {
                let key = NSString::from_str(HISTORY_ID_KEY);
                let number = NSNumber::new_i64(id);
                let value: &AnyObject = &number;
                NSDictionary::from_slices(&[&*key], &[value])
            }
            None => NSDictionary::new(),
        };
        // SAFETY: NSDictionary's type parameters are phantom; NSString keys are objects.
        unsafe { Retained::cast_unchecked(dict) }
    }

    /// The history id back from a clicked notification's `userInfo`.
    pub fn history_id_from_user_info(info: &NSDictionary) -> Option<i64> {
        let key = NSString::from_str(HISTORY_ID_KEY);
        let value = info.objectForKey(&key)?;
        value.downcast::<NSNumber>().ok().map(|n| n.as_i64())
    }
}

#[cfg(windows)]
pub(crate) mod imp {
    use std::collections::VecDeque;
    use std::sync::{Mutex, RwLock};

    use windows::core::{IInspectable, Interface, HSTRING};
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::Foundation::TypedEventHandler;
    use windows::UI::Notifications::{
        NotificationSetting, ToastActivatedEventArgs, ToastNotification, ToastNotificationManager,
        ToastNotifier,
    };

    use super::NotifyError;
    use crate::notification_permission::PermissionState;

    static APP_ID: RwLock<Option<String>> = RwLock::new(None);
    /// Recent toasts, kept so their Activated handler stays registered.
    static LIVE: Mutex<VecDeque<ToastNotification>> = Mutex::new(VecDeque::new());
    const KEEP_ALIVE: usize = 32;

    fn platform(err: windows::core::Error) -> NotifyError {
        NotifyError::Platform(err.message())
    }

    pub fn init(app_id: &str) -> Result<(), NotifyError> {
        if app_id.trim().is_empty() {
            return Err(NotifyError::NotInitialized);
        }
        *APP_ID.write().unwrap_or_else(|p| p.into_inner()) = Some(app_id.to_string());
        Ok(())
    }

    pub fn available() -> bool {
        APP_ID.read().unwrap_or_else(|p| p.into_inner()).is_some()
    }

    fn notifier() -> Result<ToastNotifier, NotifyError> {
        let app_id = APP_ID
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or(NotifyError::NotInitialized)?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))
            .map_err(platform)
    }

    fn setting() -> Result<NotificationSetting, NotifyError> {
        notifier()?.Setting().map_err(platform)
    }

    pub fn request_permission() -> Result<bool, NotifyError> {
        Ok(setting()? == NotificationSetting::Enabled)
    }

    pub fn permission_state() -> Result<PermissionState, NotifyError> {
        Ok(if setting()? == NotificationSetting::Enabled {
            PermissionState::Granted
        } else {
            PermissionState::Denied
        })
    }

    pub fn post(title: &str, body: &str, history_id: Option<i64>) -> Result<(), NotifyError> {
        let notifier = notifier()?;
        let document = XmlDocument::new().map_err(platform)?;
        document
            .LoadXml(&HSTRING::from(super::toast_xml(title, body, history_id)))
            .map_err(platform)?;
        let toast = ToastNotification::CreateToastNotification(&document).map_err(platform)?;
        toast
            .Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(
                |_sender, args| {
                    let history_id = args
                        .as_ref()
                        .and_then(|args| args.cast::<ToastActivatedEventArgs>().ok())
                        .and_then(|args| args.Arguments().ok())
                        .and_then(|arguments| {
                            super::history_id_from_launch(&arguments.to_string_lossy())
                        });
                    super::dispatch_click(history_id);
                    Ok(())
                },
            ))
            .map_err(platform)?;
        notifier.Show(&toast).map_err(platform)?;
        let mut live = LIVE.lock().unwrap_or_else(|p| p.into_inner());
        live.push_back(toast);
        while live.len() > KEEP_ALIVE {
            live.pop_front();
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) mod imp {
    use super::NotifyError;
    use crate::notification_permission::PermissionState;

    pub fn init(_app_id: &str) -> Result<(), NotifyError> {
        Err(NotifyError::Unsupported)
    }

    pub fn available() -> bool {
        false
    }

    pub fn request_permission() -> Result<bool, NotifyError> {
        Err(NotifyError::Unsupported)
    }

    pub fn permission_state() -> Result<PermissionState, NotifyError> {
        Err(NotifyError::Unsupported)
    }

    pub fn post(_: &str, _: &str, _: Option<i64>) -> Result<(), NotifyError> {
        Err(NotifyError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn toast_xml_escapes_and_carries_the_history_id() {
        assert_eq!(
            toast_xml(
                "Tekst klar til at indsætte",
                "Fisk & <chips> \"nu\"",
                Some(42)
            ),
            "<toast launch=\"historyId=42\"><visual><binding template=\"ToastGeneric\">\
             <text>Tekst klar til at indsætte</text>\
             <text>Fisk &amp; &lt;chips&gt; &quot;nu&quot;</text>\
             </binding></visual></toast>"
        );
        // No body, no id; control characters cannot appear in XML.
        assert_eq!(
            toast_xml("Ny\u{1} telefon", "", None),
            "<toast launch=\"\"><visual><binding template=\"ToastGeneric\">\
             <text>Ny telefon</text></binding></visual></toast>"
        );
    }

    #[test]
    fn launch_arguments_round_trip() {
        for id in [Some(0), Some(42), Some(-1), Some(i64::MAX), None] {
            assert_eq!(history_id_from_launch(&launch_argument(id)), id);
        }
        assert_eq!(history_id_from_launch("x=1&historyId=7"), Some(7));
        assert_eq!(history_id_from_launch("historyId=abc"), None);
    }

    /// The only test that touches the process-wide handler.
    #[test]
    fn clicks_reach_the_handler_even_before_it_is_registered() {
        dispatch_click(Some(5));
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        on_click(Box::new(move |id| {
            let _ = tx.lock().unwrap().send(id);
        }));
        assert_eq!(rx.try_recv(), Ok(Some(5)), "the pending click is delivered");
        dispatch_click(None);
        assert_eq!(rx.try_recv(), Ok(None));
        // A panicking handler does not take the caller down.
        on_click(Box::new(|_| panic!("handler bug")));
        dispatch_click(Some(1));
    }

    #[cfg(target_os = "macos")]
    mod macos {
        use super::super::imp::{
            history_id_from_user_info, state_from_status, user_info, Delegate,
        };
        use super::super::*;
        use crate::notification_permission::PermissionState;
        use objc2::runtime::ProtocolObject;
        use objc2_user_notifications::{UNAuthorizationStatus, UNUserNotificationCenterDelegate};

        #[test]
        fn outside_a_bundle_every_call_degrades_to_an_error() {
            // `cargo test` runs a bare executable: no .app, no bundle identifier.
            assert!(!available());
            assert!(matches!(
                init("com.walkietalkey.app"),
                Err(NotifyError::NotBundled)
            ));
            assert!(matches!(
                post("Titel", "Tekst", Some(1)),
                Err(NotifyError::NotBundled)
            ));
            assert!(matches!(request_permission(), Err(NotifyError::NotBundled)));
            assert!(matches!(
                crate::notification_permission::check(),
                Err(NotifyError::NotBundled)
            ));
        }

        #[test]
        fn the_history_id_travels_in_user_info() {
            for id in [Some(42), Some(-1), Some(i64::MAX), None] {
                assert_eq!(history_id_from_user_info(&user_info(id)), id);
            }
        }

        #[test]
        fn the_delegate_class_registers_and_conforms() {
            let delegate = Delegate::new();
            let _: &ProtocolObject<dyn UNUserNotificationCenterDelegate> =
                ProtocolObject::from_ref(&*delegate);
        }

        #[test]
        fn authorization_status_maps_to_permission_state() {
            assert_eq!(
                state_from_status(UNAuthorizationStatus::NotDetermined),
                PermissionState::NotDetermined
            );
            assert_eq!(
                state_from_status(UNAuthorizationStatus::Denied),
                PermissionState::Denied
            );
            assert_eq!(
                state_from_status(UNAuthorizationStatus::Authorized),
                PermissionState::Granted
            );
            assert_eq!(
                state_from_status(UNAuthorizationStatus::Provisional),
                PermissionState::Granted
            );
            assert_eq!(
                state_from_status(UNAuthorizationStatus::Ephemeral),
                PermissionState::Granted
            );
        }
    }
}
