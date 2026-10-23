// Maps walkietalkey://localhost/<path> to a file in the bundled phone build (PHONE-03).
// Plain Foundation, no WebKit: BundleSchemeHandler turns the answer into a response.

import Foundation

struct BundledFileResolver {
    enum Resolution: Equatable {
        /// Serve this file with this `Content-Type`.
        case file(URL, contentType: String)
        /// 404: not our origin, or no such file.
        case notFound
        /// 403: the path tried to leave the bundled folder.
        case forbidden
    }

    /// The bundled folder (`Web` in the app bundle).
    let root: URL

    init(root: URL) {
        self.root = root
    }

    func resolve(_ url: URL) -> Resolution {
        guard ShellRoutes.isOwn(url) else { return .notFound }
        // `path` is percent-decoded, so an encoded "%2e%2e" is caught below as "..".
        return resolve(path: url.path)
    }

    /// Exact file first, then `<dir>/index.html`, then `<name>.html` (as Cloudflare Pages serves
    /// `/p` from `p.html`), then `index.html` for any other path without an extension (SPA).
    func resolve(path: String) -> Resolution {
        var components: [String] = []
        for part in path.split(separator: "/", omittingEmptySubsequences: true) {
            if part == "." { continue }
            if part == ".." || part.contains("\u{0}") { return .forbidden }
            components.append(String(part))
        }
        guard let last = components.last else { return index() }

        let candidate = fileURL(components)
        if isRegularFile(candidate) {
            return .file(candidate, contentType: MimeType.contentType(forPathExtension: candidate.pathExtension))
        }
        guard candidate.pathExtension.isEmpty else { return .notFound }

        if isDirectory(candidate) {
            let directoryIndex = fileURL(components + ["index.html"])
            if isRegularFile(directoryIndex) {
                return .file(directoryIndex, contentType: MimeType.contentType(forPathExtension: "html"))
            }
        }
        let page = fileURL(Array(components.dropLast()) + ["\(last).html"])
        if isRegularFile(page) {
            return .file(page, contentType: MimeType.contentType(forPathExtension: "html"))
        }
        return index()
    }

    private func index() -> Resolution {
        let index = fileURL(["index.html"])
        guard isRegularFile(index) else { return .notFound }
        return .file(index, contentType: MimeType.contentType(forPathExtension: "html"))
    }

    private func fileURL(_ components: [String]) -> URL {
        components.reduce(root) { url, component in
            url.appendingPathComponent(component, isDirectory: false)
        }
    }

    private func isRegularFile(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && !directory.boolValue
    }

    private func isDirectory(_ url: URL) -> Bool {
        var directory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &directory) && directory.boolValue
    }
}
