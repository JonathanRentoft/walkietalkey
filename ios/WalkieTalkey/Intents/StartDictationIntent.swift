// "Start diktering" (PHONE-03 native value, App Store guideline 4.2): an App Intent that opens the app
// and asks the web app to start a tap-mode recording. The App Shortcut makes it available to Siri,
// Spotlight and Shortcuts, so it can go on the Action button and, through the Shortcuts control, in
// Control Center.

import AppIntents

struct StartDictationIntent: AppIntent {
    static var title: LocalizedStringResource = "Start diktering"
    // TODO(copy): the description and the phrases below are drafts for the owner to approve
    // (spec Appendix A, "Missing strings").
    static var description = IntentDescription("Åbner WalkieTalkey og begynder at optage.")
    static var openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        ShellController.shared.startDictation()
        return .result()
    }
}

struct WalkieTalkeyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartDictationIntent(),
            phrases: [
                "Start diktering i \(.applicationName)",
                "Diktér med \(.applicationName)",
                "Tal ind i \(.applicationName)",
            ],
            shortTitle: "Start diktering",
            systemImageName: "mic.fill"
        )
    }
}
