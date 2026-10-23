// The haptics bridge (PHONE-27): the web app posts "start" or "stop" to
// window.webkit.messageHandlers.haptics and the shell plays a native tick.

import Foundation
import WebKit
#if os(iOS)
import UIKit
#endif

/// Plays the start and stop ticks: medium for start, light for stop.
@MainActor
final class HapticPlayer {
    #if os(iOS)
    private let startTick = UIImpactFeedbackGenerator(style: .medium)
    private let stopTick = UIImpactFeedbackGenerator(style: .light)
    #endif

    func play(_ kind: HapticKind) {
        #if os(iOS)
        switch kind {
        case .start:
            startTick.impactOccurred()
            stopTick.prepare()
        case .stop:
            stopTick.impactOccurred()
            startTick.prepare()
        }
        #endif
    }
}

/// `WKUserContentController` keeps its script message handlers alive. This proxy holds the real
/// handler weakly, so the web view's configuration never retains the controller that owns the web view.
@MainActor
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private weak var target: WKScriptMessageHandler?

    init(_ target: WKScriptMessageHandler) {
        self.target = target
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
