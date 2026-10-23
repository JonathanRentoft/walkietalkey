// The shell's side of the contract with the phone web app (phone/src/main.tsx, phone/src/lib/platform.ts).
// Plain Foundation, no WebKit, so the unit tests also run on macOS.

import Foundation

/// The bundled web app's origin and the URLs, scripts and names the shell uses (PHONE-03).
enum ShellRoutes {
    /// The custom scheme the bundled files are served from. WebKit treats a scheme registered with
    /// `WKURLSchemeHandler` as a secure context, so WebCrypto, IndexedDB and AudioWorklet work.
    static let scheme = "walkietalkey"
    static let host = "localhost"

    /// The folder reference in the app bundle that holds the phone build (ios/scripts/bundle-phone.sh).
    static let bundledFolderName = "Web"

    static let rootURL = URL(string: "walkietalkey://localhost/")!

    /// Cold start from "Start diktering": the web app starts a tap-mode recording once it is ready
    /// and removes the query itself.
    static let startURL = URL(string: "walkietalkey://localhost/?start=1")!

    /// Warm start from "Start diktering": the page is already loaded and listens for this event.
    static let startScript = "window.dispatchEvent(new CustomEvent('wt-shell-start'))"

    /// The web app detects the shell by this marker (`SHELL_UA_MARKER`) or by the haptics handler.
    static let userAgentMarker = "WalkieTalkeyIOS"

    /// `window.webkit.messageHandlers.haptics.postMessage("start" | "stop")` (PHONE-27).
    static let hapticsHandlerName = "haptics"

    /// Keeps the page at 100 %: no pinch zoom and no zoom into focused text fields.
    static let noZoomScript = """
        (function () {
          var meta = document.querySelector('meta[name="viewport"]');
          if (!meta) {
            meta = document.createElement('meta');
            meta.name = 'viewport';
            document.head.appendChild(meta);
          }
          meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
        })();
        """

    /// True for our own origin only. Used for the microphone and camera grant.
    static func isOwnOrigin(scheme: String, host: String) -> Bool {
        scheme.lowercased() == Self.scheme && host.lowercased() == Self.host
    }

    /// True for URLs served by the bundled-files handler.
    static func isOwn(_ url: URL) -> Bool {
        isOwnOrigin(scheme: url.scheme ?? "", host: url.host ?? "")
    }

    /// True for the bundled pairing page (`/p`), which reads the secrets from its fragment.
    static func isPairingPage(_ url: URL) -> Bool {
        isOwn(url) && url.path == "/p"
    }

    /// WebKit's own application name (for example "Mobile/15E148") followed by our marker.
    static func applicationNameForUserAgent(existing: String?, version: String) -> String {
        let ours = "\(userAgentMarker)/\(version)"
        guard let existing, !existing.isEmpty else { return ours }
        return "\(existing) \(ours)"
    }
}

/// The two haptic ticks the web app asks for (PHONE-27).
enum HapticKind: Equatable {
    case start
    case stop

    init?(messageBody: Any) {
        switch messageBody as? String {
        case "start": self = .start
        case "stop": self = .stop
        default: return nil
        }
    }
}

/// Where a navigation in the web view goes.
enum NavigationDecision: Equatable {
    /// Our own pages stay in the web view.
    case allow
    /// Web and mail links open in Safari or Mail, never inside the shell.
    case openExternally
    /// Anything else is dropped.
    case cancel

    static func decide(_ url: URL?) -> NavigationDecision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if ShellRoutes.isOwn(url) { return .allow }
        switch scheme {
        case "about": return .allow
        case "https", "http", "mailto": return .openExternally
        default: return .cancel
        }
    }
}
