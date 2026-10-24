// Pairing links opened from the camera or a Universal Link (PHONE-11, spec 5.3).

import XCTest
@testable import WalkieTalkey

final class PairingLinkTests: XCTestCase {
    private func map(_ string: String) throws -> URL? {
        PairingLink.shellURL(for: try XCTUnwrap(URL(string: string)))
    }

    func testBothPhoneAppHostsMapToTheBundledPairingPage() throws {
        let fragment = "eyJ2IjoxLCJyIjoiQUFBQSIsImEiOiJCQkJCIn0"
        for host in ["app.walkietalkey.com", "walkietalkey-app.pages.dev"] {
            XCTAssertEqual(
                try map("https://\(host)/p#\(fragment)"), URL(string: "walkietalkey://localhost/p#\(fragment)"), host)
        }
    }

    func testFragmentIsKeptExactly() throws {
        XCTAssertEqual(
            try map("https://app.walkietalkey.com/p#abc_-123XYZ"), URL(string: "walkietalkey://localhost/p#abc_-123XYZ"))
        XCTAssertEqual(try map("https://app.walkietalkey.com/p#a%20b"), URL(string: "walkietalkey://localhost/p#a%20b"))
    }

    func testLenientForms() throws {
        let expected = URL(string: "walkietalkey://localhost/p#abc")
        XCTAssertEqual(try map("https://APP.WalkieTalkey.com/p#abc"), expected)
        XCTAssertEqual(try map("HTTPS://app.walkietalkey.com/p#abc"), expected)
        XCTAssertEqual(try map("https://app.walkietalkey.com/p/#abc"), expected)
        XCTAssertEqual(try map("https://app.walkietalkey.com/p?utm=1#abc"), expected)
        XCTAssertEqual(try map("https://app.walkietalkey.com:443/p#abc"), expected)
    }

    func testOtherHostsAreIgnored() throws {
        for link in [
            "https://evil.example/p#abc",
            "https://app.walkietalkey.com.evil.example/p#abc",
            "https://walkietalkey.com/p#abc",
            "https://preview.walkietalkey-app.pages.dev/p#abc",
            "https://walkietalkey-app.pages.dev.evil.example/p#abc",
            "https://app.walkietalkey.com:8443/p#abc",
        ] {
            XCTAssertNil(try map(link), link)
        }
    }

    func testOtherSchemesPathsAndEmptyFragmentsAreIgnored() throws {
        for link in [
            "http://app.walkietalkey.com/p#abc",
            "walkietalkey://localhost/p#abc",
            "https://app.walkietalkey.com/#abc",
            "https://app.walkietalkey.com/q#abc",
            "https://app.walkietalkey.com/p/extra#abc",
            "https://app.walkietalkey.com/pair#abc",
            "https://app.walkietalkey.com/p",
            "https://app.walkietalkey.com/p#",
        ] {
            XCTAssertNil(try map(link), link)
        }
    }
}
