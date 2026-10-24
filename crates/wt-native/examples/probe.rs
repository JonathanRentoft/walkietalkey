//! Prints what the native layer sees on this machine, for checking a platform by hand (for
//! example on Windows, where the tests here can only be type-checked from a Mac).
//!
//! ```text
//! cargo run --example probe                     # read-only
//! cargo run --example probe -- --ask            # also ask for notification permission
//! cargo run --example probe -- --post           # also post a notification, wait 30 s for a click
//! cargo run --example probe -- --app-id <AUMID> # Windows AUMID / macOS bundle id to expect
//! ```
//!
//! Managed settings are listed by key and type only: `CleanupApiKey` is a secret. On macOS
//! the notification part only works when this binary runs inside a `.app` bundle.

use std::time::Duration;

use wt_native::{
    elevation, managed, notification_permission, notifications, presence, ManagedValue,
};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let app_id = args
        .iter()
        .position(|a| a == "--app-id")
        .and_then(|i| args.get(i + 1))
        .cloned()
        .unwrap_or_else(|| "com.walkietalkey.app".to_string());

    println!(
        "presence: {} s since input, screen locked: {}",
        presence::seconds_since_input(),
        presence::screen_locked()
    );
    println!(
        "foreground window elevated above us: {}",
        elevation::foreground_window_is_elevated_above_us()
    );

    let values = managed::read_managed();
    if values.is_empty() {
        println!("managed settings: none");
    }
    for (key, value) in &values {
        let kind = match value {
            ManagedValue::Text(_) => "text",
            ManagedValue::Bool(_) => "bool",
            ManagedValue::Int(_) => "int",
        };
        println!("managed setting: {key} ({kind})");
    }

    println!(
        "notifications init({app_id}): {:?}",
        notifications::init(&app_id)
    );
    println!("notifications available: {}", notifications::available());
    println!(
        "notification permission: {:?}",
        notification_permission::check()
    );

    if args.iter().any(|a| a == "--ask") {
        println!(
            "request_permission: {:?}",
            notifications::request_permission()
        );
    }
    if args.iter().any(|a| a == "--post") {
        notifications::on_click(Box::new(|id| println!("clicked, history id {id:?}")));
        println!(
            "post: {:?}",
            notifications::post(
                "Tekst klar til at indsætte",
                "Probe fra wt-native",
                Some(42)
            )
        );
        std::thread::sleep(Duration::from_secs(30));
    }
}
