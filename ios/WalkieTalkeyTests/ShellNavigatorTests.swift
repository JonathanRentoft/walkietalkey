// What the shell loads or runs in the web view: "Start diktering" (PHONE-03) and pairing links (PHONE-11).

import XCTest
@testable import WalkieTalkey

final class ShellNavigatorTests: XCTestCase {
    private let pairing = URL(string: "walkietalkey://localhost/p#eyJ2IjoxfQ")!
    private let otherPairing = URL(string: "walkietalkey://localhost/p#eyJ2IjoyfQ")!
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testTheURLsAndScriptTheWebAppExpects() {
        XCTAssertEqual(ShellRoutes.rootURL.absoluteString, "walkietalkey://localhost/")
        XCTAssertEqual(ShellRoutes.startURL.absoluteString, "walkietalkey://localhost/?start=1")
        XCTAssertEqual(ShellRoutes.startScript, "window.dispatchEvent(new CustomEvent('wt-shell-start'))")
    }

    func testPlainLaunchLoadsTheAppRoot() {
        var nav = ShellNavigator()
        XCTAssertEqual(nav.state, .noWebView)
        XCTAssertEqual(nav.webViewCreated(), ShellRoutes.rootURL)
        XCTAssertEqual(nav.state, .notReady)
        nav.pageFinishedLoading()
        XCTAssertEqual(nav.state, .ready)
    }

    func testColdStartLoadsStartURLFirst() {
        var nav = ShellNavigator()
        XCTAssertNil(nav.startDictation())
        XCTAssertEqual(nav.webViewCreated(), ShellRoutes.startURL)
    }

    func testWarmStartDispatchesTheEvent() {
        var nav = ShellNavigator()
        _ = nav.webViewCreated()
        nav.pageFinishedLoading()
        XCTAssertEqual(nav.startDictation(), .evaluate(ShellRoutes.startScript))
        XCTAssertEqual(nav.state, .ready)
    }

    func testStartWhileLoadingReloadsWithStartURL() {
        var nav = ShellNavigator()
        _ = nav.webViewCreated()
        XCTAssertEqual(nav.startDictation(), .load(ShellRoutes.startURL))
        XCTAssertEqual(nav.state, .notReady)
    }

    func testStartAfterFailedLoadReloadsWithStartURL() {
        var nav = ShellNavigator()
        _ = nav.webViewCreated()
        nav.pageFinishedLoading()
        nav.pageFailedLoading()
        XCTAssertEqual(nav.startDictation(), .load(ShellRoutes.startURL))
    }

    func testWebContentCrashReloadsTheRoot() {
        var nav = ShellNavigator()
        _ = nav.webViewCreated()
        nav.pageFinishedLoading()
        XCTAssertEqual(nav.contentProcessTerminated(), .load(ShellRoutes.rootURL))
        XCTAssertEqual(nav.state, .notReady)
        XCTAssertEqual(nav.startDictation(), .load(ShellRoutes.startURL))
    }

    func testColdPairingLinkIsTheFirstPage() {
        var nav = ShellNavigator()
        XCTAssertNil(nav.openPairing(pairing, now: t0))
        XCTAssertEqual(nav.webViewCreated(), pairing)
    }

    func testPairingLinkWinsOverStartWhateverTheOrder() {
        var startFirst = ShellNavigator()
        _ = startFirst.startDictation()
        _ = startFirst.openPairing(pairing, now: t0)
        XCTAssertEqual(startFirst.webViewCreated(), pairing)

        var pairingFirst = ShellNavigator()
        _ = pairingFirst.openPairing(pairing, now: t0)
        XCTAssertNil(pairingFirst.startDictation())
        XCTAssertEqual(pairingFirst.webViewCreated(), pairing)

        var loading = ShellNavigator()
        _ = loading.webViewCreated()
        XCTAssertEqual(loading.openPairing(pairing, now: t0), .load(pairing))
        XCTAssertNil(loading.startDictation())
    }

    func testWarmPairingLinkLoadsThePairingPage() {
        var nav = ShellNavigator()
        _ = nav.webViewCreated()
        nav.pageFinishedLoading()
        XCTAssertEqual(nav.openPairing(pairing, now: t0), .load(pairing))
        XCTAssertEqual(nav.state, .notReady)
        nav.pageFinishedLoading()
        XCTAssertEqual(nav.startDictation(), .evaluate(ShellRoutes.startScript))
    }

    func testSameLinkDeliveredTwiceAtOnceIsLoadedOnce() {
        var nav = ShellNavigator()
        _ = nav.webViewCreated()
        nav.pageFinishedLoading()
        XCTAssertEqual(nav.openPairing(pairing, now: t0), .load(pairing))
        XCTAssertNil(nav.openPairing(pairing, now: t0.addingTimeInterval(0.5)))
        XCTAssertEqual(nav.openPairing(otherPairing, now: t0.addingTimeInterval(0.6)), .load(otherPairing))
        XCTAssertEqual(nav.openPairing(pairing, now: t0.addingTimeInterval(5)), .load(pairing))
    }
}
