# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's **Report a vulnerability** button on the [Security tab](https://github.com/JonathanRentoft/walkietalkey/security/advisories/new), or by email to kontakt@walkietalkey.com if you cannot use GitHub. Never in a public issue or discussion.

We answer within 7 days, keep you informed while we fix it, and credit you in the release notes unless you prefer otherwise.

## What is in scope

- The desktop app (macOS, Windows), the phone app (web app and iOS shell), the relay (`relay/`), the protocol (`packages/protocol/`) and the website.
- In particular: anything that lets the relay or a third party read audio or text, forge or replay frames, join a room without the pairing QR, keep access after removal, or make the app send text anywhere the user did not choose.

## How WalkieTalkey protects your words

The design is in [docs/SPEC.md](docs/SPEC.md) sections 5, 9 and 13 and in [docs/PROTOCOL.md](docs/PROTOCOL.md). In short: speech becomes text on your own computer; the phone's audio is end-to-end encrypted (AES-256-GCM with keys from an ECDH agreement and a one-time secret in the QR code) through a relay that only routes; device keys live in a private folder only WalkieTalkey writes on the Mac (never the keychain, which asked for the password after every update) and in Credential Manager on Windows; updates are verified with our updater key before they install.

## Supported versions

Only the latest release gets security fixes.
