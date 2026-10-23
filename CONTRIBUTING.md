# Contributing to WalkieTalkey

Thank you for helping. WalkieTalkey is free, open-source Danish dictation, built on [Handy](https://github.com/cjpais/Handy). The system specification is [docs/SPEC.md](docs/SPEC.md); every requirement has an ID (DESK-, PHONE-, RELAY-, SEC-, SITE-, PRIV-, OSS-) that tests and pull requests refer to.

## Licence

Contributions are accepted under the Apache License 2.0 (section 5 of the licence). There is no CLA. Files inherited from Handy remain available under MIT as well.

## The parts and how to build them

The repository is a bun workspace. Install everything once:

```bash
bun install
```

Rust comes from rustup (stable). On macOS with only the Command Line Tools, set `SDKROOT=$(xcrun --sdk macosx --show-sdk-path)` if a newer SDK breaks linking, and `CMAKE_POLICY_VERSION_MINIMUM=3.5` for the speech engine's CMake build.

| Part | Folder | Build and run | Tests |
|---|---|---|---|
| Desktop app (Tauri, Rust + React) | `src-tauri/`, `src/` | `bun run tauri dev` | `cd src-tauri && cargo test --lib`; `bun run test:playwright` |
| Danish pipeline, relay client, cleanup | `src-tauri/src/walkietalkey/`, `src-tauri/src/pipeline/da/` | (part of the app) | `cargo test --lib walkietalkey pipeline` |
| Protocol (TypeScript and Rust) | `packages/protocol/` | | `bun run test` there; `cargo test` in `packages/protocol/rust` (shared `test-vectors.json`) |
| Relay (Cloudflare Worker) | `relay/` | `bunx wrangler dev` | `bun run test` (Workers pool) |
| Relay client (Rust) | `crates/wt-relay-client/` | | `cargo test`; `scripts/integration.sh` against a local relay |
| Native platform layer | `crates/wt-native/` | | `cargo test` |
| Punctuation (Ekko PnC) | `crates/ekko-pnc/` | | `models/ekko-pnc/download.sh <dir>`, then `WT_EKKO_PNC_DIR=<dir> cargo test` |
| Phone app (PWA) | `phone/` | `bun run dev` | `bun run test`; `bun run test:e2e` |
| iOS shell | `ios/` | `xcodegen generate`, then Xcode | simulator build in CI |
| Website | `site/` | `bun run dev` | `bun run test` |
| Design system | `packages/ui/` | | `bun run test` |
| Models | `models/` | see `models/README` files | `models/eval/` (Danish accuracy, run before releases) |

End to end with a real model: build the app (`cd src-tauri && cargo build`), install a model, then

```bash
bun scripts/walkietalkey/e2e/phone-to-desktop.ts --wav <16 kHz Danish wav> --reference <text file>
```

pairs a scripted phone with the desktop through the relay and checks the transcript. `--live` with `--transcribe-file` runs a WAV through the key-dictation pipeline at real-time speed and prints the wait after the end of the audio (DESK-43, DESK-46).

## How we work

- Tests first, then code. Run the tests of every part you touch before you push.
- English for code, comments, commit messages and docs. Every word a user sees is Danish, from Appendix A of the spec; new strings are drafted in Danish and marked `TODO(copy)` until the maintainer approves them. No em dashes, no exclamation marks, no emoji in UI text.
- WalkieTalkey's code lives in its own modules (`src-tauri/src/walkietalkey/`, `src-tauri/src/pipeline/da/`, `src/walkietalkey/`, `crates/`, and the new top-level folders), so merges from Handy stay small (DESK-05). Changes to Handy's files are small hooks marked `WalkieTalkey`.
- Commit style: short imperative subject (`feat(relay): ...`, `fix(pipeline): ...`), a body that says why, requirement IDs where they apply.
- Never commit secrets, API keys or model weights.

## Pull request checklist

The template asks for it; in short: what and why with requirement IDs, tests added, screenshots for UI, Danish copy from Appendix A, docs and CHANGELOG updated, no secrets. CI must be green. The maintainer squash-merges.

## Keeping up with Handy (monthly)

```bash
git fetch upstream
git switch -c sync/handy-$(date +%Y-%m) main
git merge upstream/main
```

Resolve conflicts (keep WalkieTalkey's hooks, branding, workflows and data folder; Handy's own workflows stay deleted), run every test, and open a pull request "Sync med Handy". Merge it with a merge commit, not a squash, so the next sync starts from Handy's history. Fixes that would help Handy too (not branding or Danish-specific) are offered upstream as pull requests.

## Questions

Ask in [Discussions](https://github.com/JonathanRentoft/walkietalkey/discussions). Security problems go through [SECURITY.md](SECURITY.md), never public issues.
