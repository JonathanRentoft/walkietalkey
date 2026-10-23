// Owns the one web view that runs the bundled phone app (PHONE-03) and carries out ShellNavigator's
// decisions: "Start diktering" (PHONE-03), pairing links (PHONE-11) and haptics (PHONE-27). The
// microphone and camera are granted to our own origin only, so the user sees just the normal
// one-time iOS prompt (PHONE-02); links to the web open outside the app.

import Foundation
import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

@MainActor
final class ShellController: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let shared = ShellController()

    private var navigator = ShellNavigator()
    private var webView: WKWebView?
    private let haptics = HapticPlayer()

    private override init() {
        super.init()
    }

    /// The web view, created once and kept for the app's lifetime, so the page keeps its state when
    /// SwiftUI rebuilds the view.
    func makeWebView() -> WKWebView {
        if let webView { return webView }
        let webView = WKWebView(frame: .zero, configuration: makeConfiguration())
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        #if os(iOS)
        let background = UIColor(named: ShellRoutes.backgroundColorName) ?? .systemBackground
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        // The page lays itself out with viewport-fit=cover and env(safe-area-inset-*).
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bouncesZoom = false
        #endif
        #if DEBUG
        // Safari's Web Inspector for debug builds (the PHONE-03 spike checklist in ios/README.md).
        webView.isInspectable = true
        #endif
        self.webView = webView
        webView.load(URLRequest(url: navigator.webViewCreated()))
        return webView
    }

    /// "Start diktering" from the App Intent (Action button, Control Center, Siri, Shortcuts).
    func startDictation() {
        perform(navigator.startDictation())
    }

    /// A URL the app was opened with. Only pairing links on our own hosts do anything (PHONE-11).
    func open(_ url: URL) {
        guard let pairing = PairingLink.shellURL(for: url) else { return }
        perform(navigator.openPairing(pairing, now: Date()))
    }

    private func perform(_ command: WebCommand?) {
        guard let command, let webView else { return }
        switch command {
        case .load(let url):
            webView.load(URLRequest(url: url))
        case .evaluate(let script):
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    private func makeConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        // The app's own persistent storage (the IndexedDB keys, PHONE-13), not Safari's.
        configuration.websiteDataStore = .default()
        configuration.setURLSchemeHandler(BundleSchemeHandler(root: Self.bundledRoot), forURLScheme: ShellRoutes.scheme)
        configuration.applicationNameForUserAgent = ShellRoutes.applicationNameForUserAgent(
            existing: configuration.applicationNameForUserAgent, version: Self.appVersion)
        // Audio may start without a tap, so "Start diktering" can record right away.
        configuration.mediaTypesRequiringUserActionForPlayback = []
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        configuration.dataDetectorTypes = []
        #endif
        let content = configuration.userContentController
        content.add(WeakScriptMessageHandler(self), name: ShellRoutes.hapticsHandlerName)
        content.addUserScript(
            WKUserScript(source: ShellRoutes.noZoomScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        return configuration
    }

    private static var bundledRoot: URL {
        Bundle.main.url(forResource: ShellRoutes.bundledFolderName, withExtension: nil)
            ?? Bundle.main.bundleURL.appendingPathComponent(ShellRoutes.bundledFolderName, isDirectory: true)
    }

    private static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    }

    private func openExternally(_ url: URL) {
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    // MARK: WKNavigationDelegate

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
    ) {
        let url = navigationAction.request.url
        switch NavigationDecision.decide(url) {
        case .allow:
            decisionHandler(.allow)
        case .openExternally:
            if let url { openExternally(url) }
            decisionHandler(.cancel)
        case .cancel:
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        navigator.pageFinishedLoading()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let error = error as NSError
        navigator.pageFailedLoading(domain: error.domain, code: error.code)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let error = error as NSError
        navigator.pageFailedLoading(domain: error.domain, code: error.code)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        perform(navigator.contentProcessTerminated())
    }

    // MARK: WKUIDelegate

    func webView(
        _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
        decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void
    ) {
        decisionHandler(ShellRoutes.isOwnOrigin(scheme: origin.protocol, host: origin.host) ? .grant : .deny)
    }

    // MARK: WKScriptMessageHandler

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard
            message.name == ShellRoutes.hapticsHandlerName,
            ShellRoutes.isOwnOrigin(scheme: origin.protocol, host: origin.host),
            let kind = HapticKind(messageBody: message.body)
        else { return }
        haptics.play(kind)
    }
}
