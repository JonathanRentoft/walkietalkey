// SwiftUI wrapper for the controller's one web view.

import SwiftUI
import WebKit

#if os(iOS)
struct ShellWebView: UIViewRepresentable {
    let controller: ShellController

    func makeUIView(context: Context) -> WKWebView {
        controller.makeWebView()
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
#else
/// Stand-in so the sources also type-check against the macOS SDK. The app itself is iOS only.
struct ShellWebView: NSViewRepresentable {
    let controller: ShellController

    func makeNSView(context: Context) -> WKWebView {
        controller.makeWebView()
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}
}
#endif
