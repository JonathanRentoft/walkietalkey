# WalkieTalkey

Free, open-source Danish dictation for Mac, Windows and the phone (Apache-2.0). The system spec is `docs/SPEC.md`; read the parts you touch before changing anything. `AGENTS.md` has the commands, the code map and the rules.

## How we work

- Tests first, then code. Requirement IDs (DESK-, PHONE-, RELAY-, SEC-, SITE-, PRIV-, OSS-) from `docs/SPEC.md` go in tests, commits and pull requests.
- English for code, comments, commits and docs. Danish only for user-facing text, from spec Appendix A; new strings are drafted in Danish and marked `TODO(copy)`. No em dashes in user-facing text.
- Never commit secrets, keys, model weights or personal data. Tests use fakes, never real AI provider keys.
- Pull requests follow `.github/PULL_REQUEST_TEMPLATE.md`; contributions are Apache-2.0 (`CONTRIBUTING.md`).

## Repository layout (spec section 4.1)

WalkieTalkey's features live in their own folders and modules, apart from the desktop core (DESK-05).

```
src-tauri/            desktop app, Rust; feature modules in src-tauri/src/walkietalkey/, relay/, pipeline/da/
src/                  desktop UI, React + TypeScript; WalkieTalkey screens in src/walkietalkey/
crates/               our standalone Rust crates (Ekko PnC, relay client), no Tauri dependency
phone/                phone web app, Vite + React + TypeScript, PWA
ios/                  native iOS shell (SwiftUI + WKWebView)
relay/                Cloudflare Worker + Durable Object, TypeScript
site/                 walkietalkey.com, Astro with React islands
packages/ui/          React components and tokens ported from the design system
packages/protocol/    message types, envelope crypto, test vectors; Rust crate in packages/protocol/rust/
models/               model manifest, conversion scripts, model cards, licence texts
docs/                 SPEC.md, PROTOCOL.md, PRIVACY.md, MANAGED_SETTINGS.md, ARCHITECTURE.md, MODELS.md
deploy/               managed-settings templates (ADMX/ADML, .mobileconfig)
licenses/             third-party licence texts
```

`docs/SPEC.md` is the committed copy of the system spec. Requirement IDs (DESK-, PHONE-, RELAY-, SEC-, SITE-, PRIV-, OSS-) are referenced from tests and pull requests. Package manager: bun workspaces.

The development guide follows.

Read @AGENTS.md
