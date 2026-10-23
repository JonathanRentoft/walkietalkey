// WalkieTalkey for iPhone: a thin SwiftUI shell around the phone web app, bundled inside the app
// (spec 7.1, PHONE-02..04). Pairing links arrive as Universal Links (PHONE-11).

import SwiftUI

@main
struct WalkieTalkeyApp: App {
    var body: some Scene {
        WindowGroup {
            ShellView()
        }
    }
}

struct ShellView: View {
    var body: some View {
        ShellWebView(controller: .shared)
            .ignoresSafeArea()
            .background(Color(ShellRoutes.backgroundColorName).ignoresSafeArea())
            .onOpenURL { url in
                ShellController.shared.open(url)
            }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                if let url = activity.webpageURL {
                    ShellController.shared.open(url)
                }
            }
    }
}
