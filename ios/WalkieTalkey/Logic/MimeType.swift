// MIME types for the bundled phone build. Module scripts and AudioWorklet modules are only run when
// they are served as JavaScript, so this table matters.

import Foundation

enum MimeType {
    private static let types: [String: String] = [
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
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "gif": "image/gif",
        "ico": "image/x-icon",
        "wasm": "application/wasm",
        "woff2": "font/woff2",
        "woff": "font/woff",
        "ttf": "font/ttf",
        "txt": "text/plain",
        "xml": "application/xml",
    ]

    private static let textTypes: Set<String> = [
        "application/json",
        "application/manifest+json",
        "application/xml",
        "image/svg+xml",
    ]

    static let fallback = "application/octet-stream"

    /// The MIME type for a file extension (without the dot), case-insensitive.
    static func forPathExtension(_ ext: String) -> String {
        types[ext.lowercased()] ?? fallback
    }

    /// The `Content-Type` header value: text types are UTF-8 (Vite writes UTF-8).
    static func contentType(forPathExtension ext: String) -> String {
        let mime = forPathExtension(ext)
        if mime.hasPrefix("text/") || textTypes.contains(mime) {
            return "\(mime); charset=utf-8"
        }
        return mime
    }
}
