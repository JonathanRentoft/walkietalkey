// What the web view loads or runs for "Start diktering" (PHONE-03) and pairing links (PHONE-11).
// A plain state machine without WebKit, so the choices are unit-tested; ShellController executes them.

import Foundation

/// One thing for the web view to do.
enum WebCommand: Equatable {
    case load(URL)
    case evaluate(String)
}

struct ShellNavigator {
    enum PageState: Equatable {
        /// The web view does not exist yet (cold start).
        case noWebView
        /// A page is loading, or the last load failed.
        case notReady
        /// The page has loaded and listens for `wt-shell-start`.
        case ready
    }

    /// SwiftUI may hand the same Universal Link to both `onOpenURL` and `onContinueUserActivity`.
    static let duplicateWindow: TimeInterval = 2

    private(set) var state: PageState = .noWebView
    /// Asked for before the web view existed; becomes its first page.
    private var pending: URL?
    /// The page the web view is loading or showing.
    private var current: URL?
    private var lastLink: (url: URL, at: Date)?

    /// The web view was created: the URL to load first. A pairing link beats "Start diktering".
    mutating func webViewCreated() -> URL {
        let url = pending ?? ShellRoutes.rootURL
        pending = nil
        return beginLoad(url)
    }

    mutating func pageFinishedLoading() {
        if state != .noWebView { state = .ready }
    }

    mutating func pageFailedLoading() {
        if state != .noWebView { state = .notReady }
    }

    /// The web content process went away (memory pressure): start the app again.
    mutating func contentProcessTerminated() -> WebCommand {
        .load(beginLoad(ShellRoutes.rootURL))
    }

    /// "Start diktering". Cold start or a page that is not ready: load `?start=1`, which the web app
    /// handles after it has loaded its pairings. A loaded page: dispatch `wt-shell-start`. While a
    /// pairing link is opening, the pairing wins (the web app ignores `?start=1` with a fragment too).
    mutating func startDictation() -> WebCommand? {
        switch state {
        case .noWebView:
            if pending == nil { pending = ShellRoutes.startURL }
            return nil
        case .notReady:
            if let current, ShellRoutes.isPairingPage(current) { return nil }
            return .load(beginLoad(ShellRoutes.startURL))
        case .ready:
            return .evaluate(ShellRoutes.startScript)
        }
    }

    /// A pairing link, already mapped to `walkietalkey://localhost/p#<fragment>` by `PairingLink`.
    mutating func openPairing(_ url: URL, now: Date) -> WebCommand? {
        if let last = lastLink, last.url == url, now.timeIntervalSince(last.at) < Self.duplicateWindow {
            return nil
        }
        lastLink = (url, now)
        if state == .noWebView {
            pending = url
            return nil
        }
        return .load(beginLoad(url))
    }

    private mutating func beginLoad(_ url: URL) -> URL {
        state = .notReady
        current = url
        return url
    }
}
