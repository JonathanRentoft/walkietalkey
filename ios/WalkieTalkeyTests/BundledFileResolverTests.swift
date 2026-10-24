// The scheme handler's path resolution (PHONE-03): bundled files, SPA fallback, traversal refused.

import XCTest
@testable import WalkieTalkey

final class BundledFileResolverTests: XCTestCase {
    private var root: URL!
    private var resolver: BundledFileResolver!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("wt-web-\(UUID().uuidString)", isDirectory: true)
        for path in [
            "index.html",
            "p.html",
            "manifest.webmanifest",
            "favicon.svg",
            "sw.js",
            "assets/index-B4xRv4I5.js",
            "assets/capture-worklet-DCylqutv.js",
            "assets/index-CMbCy5Rp.css",
            "assets/albert-sans.woff2",
            "assets/my file.js",
            "icons/icon-192.png",
        ] {
            let file = root.appendingPathComponent(path, isDirectory: false)
            try FileManager.default.createDirectory(
                at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(path.utf8).write(to: file)
        }
        resolver = BundledFileResolver(root: root)
    }

    override func tearDownWithError() throws {
        if let root {
            try? FileManager.default.removeItem(at: root)
        }
    }

    private func file(_ path: String) -> URL {
        root.appendingPathComponent(path, isDirectory: false)
    }

    private func resolve(_ string: String) throws -> BundledFileResolver.Resolution {
        resolver.resolve(try XCTUnwrap(URL(string: string)))
    }

    private var index: BundledFileResolver.Resolution {
        .file(file("index.html"), contentType: "text/html; charset=utf-8")
    }

    func testRootAndEmptyPathServeIndex() throws {
        XCTAssertEqual(try resolve("walkietalkey://localhost/"), index)
        XCTAssertEqual(try resolve("walkietalkey://localhost"), index)
        XCTAssertEqual(try resolve("walkietalkey://localhost/?start=1"), index)
    }

    func testBundledFileIsServedWithItsMimeType() throws {
        XCTAssertEqual(
            try resolve("walkietalkey://localhost/assets/index-B4xRv4I5.js"),
            .file(file("assets/index-B4xRv4I5.js"), contentType: "text/javascript; charset=utf-8"))
        XCTAssertEqual(
            try resolve("walkietalkey://localhost/assets/capture-worklet-DCylqutv.js"),
            .file(file("assets/capture-worklet-DCylqutv.js"), contentType: "text/javascript; charset=utf-8"))
        XCTAssertEqual(
            try resolve("walkietalkey://localhost/assets/index-CMbCy5Rp.css"),
            .file(file("assets/index-CMbCy5Rp.css"), contentType: "text/css; charset=utf-8"))
        XCTAssertEqual(
            try resolve("walkietalkey://localhost/manifest.webmanifest"),
            .file(file("manifest.webmanifest"), contentType: "application/manifest+json; charset=utf-8"))
        XCTAssertEqual(
            try resolve("walkietalkey://localhost/favicon.svg"),
            .file(file("favicon.svg"), contentType: "image/svg+xml; charset=utf-8"))
        XCTAssertEqual(
            try resolve("walkietalkey://localhost/icons/icon-192.png"),
            .file(file("icons/icon-192.png"), contentType: "image/png"))
        XCTAssertEqual(
            try resolve("walkietalkey://localhost/assets/albert-sans.woff2"),
            .file(file("assets/albert-sans.woff2"), contentType: "font/woff2"))
    }

    func testPercentEncodedNamesAreDecoded() throws {
        XCTAssertEqual(
            try resolve("walkietalkey://localhost/assets/my%20file.js"),
            .file(file("assets/my file.js"), contentType: "text/javascript; charset=utf-8"))
    }

    func testPairingPathServesPairingPageLikeCloudflarePages() throws {
        let page = BundledFileResolver.Resolution.file(file("p.html"), contentType: "text/html; charset=utf-8")
        XCTAssertEqual(try resolve("walkietalkey://localhost/p"), page)
        XCTAssertEqual(try resolve("walkietalkey://localhost/p#eyJ2IjoxfQ"), page)
    }

    func testUnknownPathsWithoutExtensionFallBackToIndex() throws {
        XCTAssertEqual(try resolve("walkietalkey://localhost/settings"), index)
        XCTAssertEqual(try resolve("walkietalkey://localhost/a/b/c"), index)
        XCTAssertEqual(try resolve("walkietalkey://localhost/assets"), index)
        XCTAssertEqual(try resolve("walkietalkey://localhost/assets/"), index)
    }

    func testMissingFilesWithExtensionAreNotFound() throws {
        XCTAssertEqual(try resolve("walkietalkey://localhost/assets/missing.js"), .notFound)
        XCTAssertEqual(try resolve("walkietalkey://localhost/favicon.ico"), .notFound)
        XCTAssertEqual(try resolve("walkietalkey://localhost/nested/index.html"), .notFound)
    }

    func testPathTraversalIsRefused() throws {
        XCTAssertEqual(try resolve("walkietalkey://localhost/../secret.txt"), .forbidden)
        XCTAssertEqual(try resolve("walkietalkey://localhost/assets/../../secret.txt"), .forbidden)
        XCTAssertEqual(try resolve("walkietalkey://localhost/%2e%2e/secret.txt"), .forbidden)
        XCTAssertEqual(try resolve("walkietalkey://localhost/assets/%2E%2E/%2E%2E/etc/hosts"), .forbidden)
        XCTAssertEqual(resolver.resolve(path: "/../index.html"), .forbidden)
        XCTAssertEqual(resolver.resolve(path: ".."), .forbidden)
    }

    func testOtherSchemesAndHostsAreNotServed() throws {
        XCTAssertEqual(try resolve("walkietalkey://example.com/index.html"), .notFound)
        XCTAssertEqual(try resolve("https://localhost/index.html"), .notFound)
        XCTAssertEqual(try resolve("https://app.walkietalkey.com/"), .notFound)
    }

    func testSchemeAndHostMatchCaseInsensitively() throws {
        XCTAssertEqual(
            try resolve("WalkieTalkey://LocalHost/sw.js"),
            .file(file("sw.js"), contentType: "text/javascript; charset=utf-8"))
    }

    func testWithoutBundledIndexEverythingIsNotFound() {
        let empty = BundledFileResolver(root: root.appendingPathComponent("does-not-exist", isDirectory: true))
        XCTAssertEqual(empty.resolve(path: "/"), .notFound)
        XCTAssertEqual(empty.resolve(path: "/settings"), .notFound)
        XCTAssertEqual(empty.resolve(path: "/assets/index.js"), .notFound)
    }
}
