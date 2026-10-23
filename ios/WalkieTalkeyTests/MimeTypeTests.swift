// MIME types for the bundled phone build (PHONE-03): module scripts and AudioWorklet modules only run
// when served as JavaScript.

import XCTest
@testable import WalkieTalkey

final class MimeTypeTests: XCTestCase {
    func testEveryTypeThePhoneBuildUses() {
        let expected = [
            "html": "text/html",
            "htm": "text/html",
            "js": "text/javascript",
            "mjs": "text/javascript",
            "css": "text/css",
            "json": "application/json",
            "map": "application/json",
            "webmanifest": "application/manifest+json",
            "svg": "image/svg+xml",
            "png": "image/png",
            "jpg": "image/jpeg",
            "webp": "image/webp",
            "wasm": "application/wasm",
            "woff2": "font/woff2",
            "woff": "font/woff",
            "ico": "image/x-icon",
            "txt": "text/plain",
        ]
        for (ext, mime) in expected {
            XCTAssertEqual(MimeType.forPathExtension(ext), mime, ext)
            XCTAssertEqual(MimeType.forPathExtension(ext.uppercased()), mime, ext.uppercased())
        }
    }

    func testUnknownExtensionsAreBinary() {
        XCTAssertEqual(MimeType.forPathExtension(""), "application/octet-stream")
        XCTAssertEqual(MimeType.forPathExtension("bin"), "application/octet-stream")
    }

    func testTextTypesCarryUTF8AndBinaryTypesDoNot() {
        XCTAssertEqual(MimeType.contentType(forPathExtension: "html"), "text/html; charset=utf-8")
        XCTAssertEqual(MimeType.contentType(forPathExtension: "js"), "text/javascript; charset=utf-8")
        XCTAssertEqual(MimeType.contentType(forPathExtension: "json"), "application/json; charset=utf-8")
        XCTAssertEqual(MimeType.contentType(forPathExtension: "svg"), "image/svg+xml; charset=utf-8")
        XCTAssertEqual(MimeType.contentType(forPathExtension: "png"), "image/png")
        XCTAssertEqual(MimeType.contentType(forPathExtension: "wasm"), "application/wasm")
        XCTAssertEqual(MimeType.contentType(forPathExtension: "woff2"), "font/woff2")
    }
}
