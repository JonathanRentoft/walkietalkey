// Serves the bundled phone build at walkietalkey://localhost/ (PHONE-03), the Capacitor pattern:
// nothing is loaded from the web, and a scheme registered this way is a secure context.

import Foundation
import WebKit

@MainActor
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let resolver: BundledFileResolver

    init(root: URL) {
        resolver = BundledFileResolver(root: root)
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }
        switch resolver.resolve(url) {
        case .file(let file, let contentType):
            if let body = try? Data(contentsOf: file, options: .mappedIfSafe) {
                respond(urlSchemeTask, url: url, status: 200, contentType: contentType, body: body)
            } else {
                respond(urlSchemeTask, url: url, status: 404, contentType: "text/plain; charset=utf-8", body: Data())
            }
        case .notFound:
            respond(urlSchemeTask, url: url, status: 404, contentType: "text/plain; charset=utf-8", body: Data())
        case .forbidden:
            respond(urlSchemeTask, url: url, status: 403, contentType: "text/plain; charset=utf-8", body: Data())
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Every task is answered synchronously in `start`, so there is never one left to stop.
    }

    private func respond(_ task: WKURLSchemeTask, url: URL, status: Int, contentType: String, body: Data) {
        let headers = [
            "Content-Type": contentType,
            "Content-Length": String(body.count),
            "Cache-Control": "no-cache",
            "X-Content-Type-Options": "nosniff",
        ]
        let response =
            HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)
            ?? URLResponse(url: url, mimeType: nil, expectedContentLength: body.count, textEncodingName: nil)
        task.didReceive(response)
        if !body.isEmpty {
            task.didReceive(body)
        }
        task.didFinish()
    }
}
