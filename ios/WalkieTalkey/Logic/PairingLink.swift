// Pairing links opened with the normal camera (PHONE-11): `https://app.walkietalkey.com/p#<payload>`
// (spec 5.3, packages/protocol/src/pairing.ts encodePairingUrl). The secrets are in the fragment, which
// the bundled pairing page reads and then removes from history itself (PHONE-15).

import Foundation

enum PairingLink {
    /// The phone app's hosts. Both are listed in the Associated Domains entitlement, and each serves
    /// `/.well-known/apple-app-site-association` (built from phone/public).
    static let hosts: Set<String> = ["app.walkietalkey.com", "walkietalkey-app.pages.dev"]

    /// `walkietalkey://localhost/p#<fragment>` for a pairing link on one of our hosts, nil for anything else.
    static func shellURL(for link: URL) -> URL? {
        guard
            let components = URLComponents(url: link, resolvingAgainstBaseURL: false),
            components.scheme?.lowercased() == "https",
            let host = components.host?.lowercased(), hosts.contains(host),
            components.port == nil || components.port == 443,
            components.percentEncodedPath == "/p" || components.percentEncodedPath == "/p/",
            let fragment = components.percentEncodedFragment, !fragment.isEmpty
        else { return nil }
        return URL(string: "\(ShellRoutes.scheme)://\(ShellRoutes.host)/p#\(fragment)")
    }
}
