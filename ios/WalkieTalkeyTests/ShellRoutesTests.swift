// Our own origin, the user agent marker, the haptics messages and where links go (PHONE-03, PHONE-27).

import XCTest
@testable import WalkieTalkey

final class ShellRoutesTests: XCTestCase {
    func testMicrophoneAndCameraAreGrantedOnlyToOurOrigin() {
        XCTAssertTrue(ShellRoutes.isOwnOrigin(scheme: "walkietalkey", host: "localhost"))
        XCTAssertTrue(ShellRoutes.isOwnOrigin(scheme: "WalkieTalkey", host: "LOCALHOST"))
        XCTAssertFalse(ShellRoutes.isOwnOrigin(scheme: "https", host: "localhost"))
        XCTAssertFalse(ShellRoutes.isOwnOrigin(scheme: "https", host: "app.walkietalkey.com"))
        XCTAssertFalse(ShellRoutes.isOwnOrigin(scheme: "walkietalkey", host: "example.com"))
        XCTAssertFalse(ShellRoutes.isOwnOrigin(scheme: "walkietalkey", host: ""))
        XCTAssertFalse(ShellRoutes.isOwnOrigin(scheme: "", host: "localhost"))
    }

    func testUserAgentKeepsWebKitsPartAndAddsTheMarker() {
        XCTAssertEqual(
            ShellRoutes.applicationNameForUserAgent(existing: "Mobile/15E148", version: "0.1.0"),
            "Mobile/15E148 WalkieTalkeyIOS/0.1.0")
        XCTAssertEqual(ShellRoutes.applicationNameForUserAgent(existing: nil, version: "0.1.0"), "WalkieTalkeyIOS/0.1.0")
        XCTAssertEqual(ShellRoutes.applicationNameForUserAgent(existing: "", version: "2.0"), "WalkieTalkeyIOS/2.0")
        // The web app's detection (phone/src/lib/platform.ts, SHELL_UA_MARKER).
        XCTAssertEqual(ShellRoutes.userAgentMarker, "WalkieTalkeyIOS")
    }

    func testHapticsMessagesFromTheWebApp() {
        XCTAssertEqual(ShellRoutes.hapticsHandlerName, "haptics")
        XCTAssertEqual(HapticKind(messageBody: "start"), .start)
        XCTAssertEqual(HapticKind(messageBody: "stop"), .stop)
        XCTAssertNil(HapticKind(messageBody: "Start"))
        XCTAssertNil(HapticKind(messageBody: "boom"))
        XCTAssertNil(HapticKind(messageBody: 42))
        XCTAssertNil(HapticKind(messageBody: ["kind": "start"]))
    }

    func testOurPagesStayAndWebAndMailLinksOpenOutside() {
        func decide(_ string: String) -> NavigationDecision { NavigationDecision.decide(URL(string: string)) }
        XCTAssertEqual(decide("walkietalkey://localhost/"), .allow)
        XCTAssertEqual(decide("walkietalkey://localhost/p#abc"), .allow)
        XCTAssertEqual(decide("about:blank"), .allow)
        XCTAssertEqual(decide("https://walkietalkey.com/privatliv"), .openExternally)
        XCTAssertEqual(decide("https://github.com/walkietalkey"), .openExternally)
        XCTAssertEqual(decide("http://example.com/"), .openExternally)
        XCTAssertEqual(decide("mailto:kontakt@walkietalkey.com"), .openExternally)
        XCTAssertEqual(decide("walkietalkey://example.com/"), .cancel)
        XCTAssertEqual(decide("file:///etc/hosts"), .cancel)
        XCTAssertEqual(decide("data:text/html,hi"), .cancel)
        XCTAssertEqual(NavigationDecision.decide(nil), .cancel)
    }
}
