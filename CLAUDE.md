# WalkieTalkey

This folder becomes the WalkieTalkey repository: free, open-source Danish dictation (Apache-2.0), built on the public MIT-licensed Handy app. The owner is Jonathan. The brief for the current run is `_kit/PROMPT.md`; the system spec is `_kit/SPEC.md`; the design system is `_kit/design-system/`. Read the brief and the spec completely before changing anything.

## The owner has authorized, for this project

- Importing the full public history of github.com/cjpais/Handy (MIT) as the base of this repository and pushing it to the new public repository `walkietalkey` on the owner's personal GitHub account (the signed-in `gh` user). Pushing branches there, opening and squash-merging pull requests, changing its settings, secrets and branch protection.
- Deploying to the owner's own Cloudflare account with `wrangler`: the relay (Worker `walkietalkey-relay` with Durable Objects), the phone web app (Pages project `walkietalkey-app`) and the website (Pages project `walkietalkey-site`). These are test deployments on workers.dev and pages.dev.
- Downloading the model danish-foundation-models/edda-v0.2, RyeAI's Ekko models and public Danish test clips from Hugging Face, code from github.com/handy-computer/transcribe.cpp, and packages from Homebrew, crates.io, npm and PyPI.
- Installing developer tools with Homebrew, rustup, npm/bun and uv.

## Never

- `sudo`, `curl | sh` style installers, force-push, rewriting or deleting published history or remote branches.
- Committing or printing secrets, tokens or private keys. Never use the owner's personal API keys; tests use fakes.
- Uploading model weights anywhere (the Edda training-data licence question is open, spec section 11).
- Deleting or changing files outside this folder, except installing tools and the app's own data folders.

## How we work

- Keep `caffeinate` running while you work; stop it right before your final reply.
- Subagents: spawn them with effort `xhigh` (never `max`), at most 3 running at the same time.
- Tests first, then code. One branch and one pull request per run: commit locally as often as you like, push once when everything is green locally; if CI fails, fix everything in one go, push once more, squash-merge when green.
- English for code, comments, commits and docs. Danish only for user-facing text (spec Appendix A). No em dashes in user-facing text.
- Do setup yourself with the CLIs (`gh`, `wrangler`, `brew`, `rustup`, `uv`, `bun`). Do not write how-to guides for the owner; the owner is guided elsewhere. Write status and reports for the assistant who guides him.

## Repository layout (spec section 4.1)

Handy's folders stay where they are, so monthly upstream merges stay easy. Our code lives in our own folders and modules (DESK-05).

```
src-tauri/            desktop app, Rust (from Handy); our modules in src-tauri/src/walkietalkey/, relay/, pipeline/da/
src/                  desktop UI, React + TypeScript (from Handy); our screens in src/walkietalkey/
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
licenses/             third-party licence texts, including Handy's MIT licence
```

`docs/SPEC.md` is the committed copy of the system spec. Requirement IDs (DESK-, PHONE-, RELAY-, SEC-, SITE-, PRIV-, OSS-) are referenced from tests and pull requests. Package manager: bun workspaces.

Handy's own development guide follows.

Read @AGENTS.md
