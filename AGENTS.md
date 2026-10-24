# AGENTS.md

This file provides guidance to AI coding assistants working with code in this repository.

## WalkieTalkey first

WalkieTalkey is free, open-source Danish dictation for Mac, Windows and the phone. The behaviour is specified in `docs/SPEC.md`; requirement IDs (`DESK-`, `PHONE-`, `RELAY-`, `SEC-`, `SITE-`, `PRIV-`, `OSS-`) are cited in tests, commits and pull requests. The code map is `docs/ARCHITECTURE.md`; the protocol is `docs/PROTOCOL.md`; the models are `docs/MODELS.md`.

Rules that keep the code maintainable and the product honest:

- **Features live in their own modules** (DESK-05): `src-tauri/src/walkietalkey/`, `src-tauri/src/pipeline/da/`, `src/walkietalkey/`, `crates/`, and the workspaces `phone/`, `relay/`, `site/`, `packages/`. The desktop core (the rest of `src-tauri/src/` and `src/`) calls them through small hooks marked with a `WalkieTalkey` comment.
- **Tests first.** The relay tests count storage writes per dictation; the protocol has shared test vectors in TypeScript and Rust (`packages/protocol/test-vectors.json`); AI providers are always fakes in tests. Never use real API keys.
- **English** for code, comments, commits and docs. **Danish** for user-facing text, from spec Appendix A; new strings not in the spec are marked `TODO(copy)`. No em dashes in user-facing text.
- **Privacy**: no telemetry, no analytics, no crash reporting. Audio is never stored unless "Gem lyd til fejlfinding" is on; text never goes back to the phone.
- **Secrets** live in the OS keychain (`walkietalkey::secrets`, `wt-native`), never in settings files or logs.

| Part                              | Folder                                                          | Commands                                                                                                              |
| --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Desktop app                       | `src-tauri/`, `src/`                                            | `bun run tauri dev`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`                                          |
| Protocol                          | `packages/protocol/` (Rust in `rust/`)                          | `bun run --cwd packages/protocol test`, `cargo test --manifest-path packages/protocol/rust/Cargo.toml`                |
| Relay client, native, punctuation | `crates/wt-relay-client`, `crates/wt-native`, `crates/ekko-pnc` | `cargo test --manifest-path crates/<crate>/Cargo.toml`                                                                |
| Relay                             | `relay/`                                                        | `bun run --cwd relay test`, `bun run --cwd relay dev`                                                                 |
| Phone app                         | `phone/`                                                        | `bun run --cwd phone dev`, `bun run --cwd phone test`, `bun run --cwd phone test:e2e`                                 |
| iOS shell                         | `ios/`                                                          | XcodeGen (`ios/project.yml`); built in CI                                                                             |
| Website                           | `site/`                                                         | `bun run --cwd site dev`, `bun run --cwd site test`                                                                   |
| Design system                     | `packages/ui/`                                                  | `bun run --cwd packages/ui test`                                                                                      |
| Licences                          | `deny.toml`, `scripts/walkietalkey/check-js-licenses.ts`        | `cargo deny --manifest-path src-tauri/Cargo.toml check`, `bun scripts/walkietalkey/check-js-licenses.ts`, `bun audit` |

On macOS, if linking fails against a beta SDK: with only the Command Line Tools, point `SDKROOT` at `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk`; with full Xcode, use Xcode's own SDK and never mix in the Command Line Tools SDK. CI pins a released Xcode with `scripts/walkietalkey/ci/select-xcode.sh`.

The rest of this file is the desktop app's development guide.

## Development Commands

**Prerequisites:**

- [Rust](https://rustup.rs/) (latest stable)
- [Bun](https://bun.sh/) package manager

**Core Development:**

```bash
# Install dependencies
bun install

# Run in development mode
bun run tauri dev
# If cmake error on macOS:
CMAKE_POLICY_VERSION_MINIMUM=3.5 bun run tauri dev

# Build for production
bun run tauri build

# Frontend only development
bun run dev        # Start Vite dev server
bun run build      # Build frontend (TypeScript + Vite)
bun run preview    # Preview built frontend
```

**Linting and Formatting (run before committing):**

```bash
bun run lint              # ESLint for frontend
bun run lint:fix          # ESLint with auto-fix
bun run format            # Prettier + cargo fmt
bun run format:check      # Check formatting without changes
bun run format:frontend   # Prettier only
bun run format:backend    # cargo fmt only
```

**Models:**

The Silero VAD model is committed (`src-tauri/resources/models/silero-vad-v6.2-F32.gguf`). Speech models live in the app data folder (`~/Library/Application Support/WalkieTalkey/models/`, `%LOCALAPPDATA%\WalkieTalkey\models\`); the app downloads them, or you build them with `models/` (see `docs/MODELS.md`) and import the file in the model settings. Never upload model weights anywhere: the training-data licence question is open (spec section 11).

For detailed platform-specific build setup, see [BUILD.md](BUILD.md).

## Architecture Overview

The desktop app is a cross-platform speech-to-text application built with Tauri 2.x (Rust backend + React/TypeScript frontend).

### Backend Structure (src-tauri/src/)

- `lib.rs` - Main entry point, Tauri setup, manager initialization
- `managers/` - Core business logic:
  - `audio.rs` - Audio recording and device management
  - `model.rs` - Model downloading and management
  - `transcription.rs` - Speech-to-text processing pipeline
  - `history.rs` - Transcription history storage
- `audio_toolkit/` - Low-level audio processing:
  - `audio/` - Recording sink (VAD, levels, live streaming feed), output devices, WAV I/O
  - `vad/` - Voice Activity Detection (Silero VAD)
- `commands/` - Tauri command handlers for frontend communication
- `cli.rs` - CLI argument definitions (clap derive)
- `shortcut.rs` - Global keyboard shortcut handling
- `settings.rs` - Application settings management
- `overlay.rs` - Recording overlay window (platform-specific)
- `signal_handle.rs` - `send_transcription_input()` reusable function
- `utils.rs` - Platform detection helpers

### Frontend Structure (src/)

- `App.tsx` - Main component with onboarding flow
- `components/` - React UI components:
  - `settings/` - Settings UI
  - `model-selector/` - Model management interface
  - `onboarding/` - First-run experience
  - `overlay/` - Recording overlay UI
  - `update-checker/` - App update notifications
  - `shared/`, `ui/`, `icons/`, `footer/` - Shared components
- `hooks/useSettings.ts` - Settings state management hook
- `stores/settingsStore.ts` - Zustand store for settings
- `bindings.ts` - Auto-generated Tauri type bindings (via tauri-specta)
- `overlay/` - Recording overlay window entry point
- `lib/types.ts` - Shared TypeScript type definitions

### Key Architecture Patterns

**Manager Pattern:** Core functionality organized into managers (Audio, Model, Transcription) initialized at startup and managed via Tauri state.

**Command-Event Architecture:** Frontend → Backend via Tauri commands; Backend → Frontend via events.

**Pipeline Processing:** Audio → VAD → Whisper/Parakeet → Text output → Clipboard/Paste

**State Flow:** Zustand → Tauri Command → Rust State → Persistence (tauri-plugin-store)

### Technology Stack

**Core Libraries:**

- `transcribe-cpp` - Local speech recognition (Whisper, Parakeet, Moonshine, SenseVoice, etc.; GGML/GGUF) with GPU acceleration
- `handy-recorder` - Microphone capture: device selection, resampling to 16 kHz, failure detection
- `transcribe-cpp` (Silero VAD v6, CPU-only, in-process) / `earshot` - Voice Activity Detection
- `rdev` - Global keyboard shortcuts
- `rodio` - Audio playback for feedback sounds

### Application Flow

1. **Initialization:** App starts minimized to tray, loads settings, initializes managers
2. **Model Setup:** First-run downloads preferred Whisper model (Small/Medium/Turbo/Large)
3. **Recording:** Global shortcut triggers audio recording with VAD filtering
4. **Processing:** Audio sent to Whisper model for transcription
5. **Output:** Text pasted to active application via system clipboard

### Settings System

Settings are stored using Tauri's store plugin with reactive updates:

- Keyboard shortcuts (configurable, supports push-to-talk)
- Audio devices (microphone/output selection)
- Model preferences (Small/Medium/Turbo/Large Whisper variants)
- Audio feedback and translation options

### Single Instance Architecture

The app enforces single instance behavior — launching when already running brings the settings window to front rather than creating a new process. Remote control flags (`--toggle-transcription`, etc.) work by launching a second instance that sends args to the running instance via `tauri_plugin_single_instance`, then exits.

## Internationalization (i18n)

All user-facing strings must use i18next translations. ESLint enforces this (no hardcoded strings in JSX).

**Adding new text:**

1. Add key to `src/i18n/locales/en/translation.json`
2. Use in component: `const { t } = useTranslation(); t('key.path')`

**File structure:**

```
src/i18n/
├── index.ts           # i18n setup
├── languages.ts       # Language metadata
└── locales/
    ├── en/translation.json  # English (source)
    ├── de/, es/, fr/, ja/, ru/, zh/, ...
    └── ...
```

WalkieTalkey ships Danish (default) and English only (`src/walkietalkey/i18n.ts`). Danish copy comes from spec Appendix A; `bun run check:translations` checks that every key exists in every locale.

## Code Style

**Rust:**

- Run `cargo fmt` and `cargo clippy` before committing
- Handle errors explicitly (avoid unwrap in production)
- Use descriptive names, add doc comments for public APIs

**TypeScript/React:**

- Strict TypeScript, avoid `any` types
- Functional components with hooks
- Tailwind CSS for styling
- Path aliases: `@/` → `./src/`

## CLI Parameters

The desktop app supports command-line parameters on all platforms for integration with scripts, window managers, and autostart configurations.

**Implementation:** `cli.rs` (definitions), `main.rs` (parsing), `lib.rs` (applying), `signal_handle.rs` (shared logic)

| Flag                      | Description                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--toggle-transcription`  | Toggle recording on/off on a running instance                                                                                             |
| `--toggle-post-process`   | Toggle recording with post-processing on/off                                                                                              |
| `--cancel`                | Cancel the current operation on a running instance                                                                                        |
| `--start-hidden`          | Launch without showing the main window (tray icon visible)                                                                                |
| `--no-tray`               | Launch without system tray (closing window quits the app)                                                                                 |
| `--debug`                 | Enable debug mode with verbose (Trace) logging                                                                                            |
| `-f`, `--transcribe-file` | Transcribe a 16 kHz mono WAV headlessly and exit                                                                                          |
| `--live`                  | With `--transcribe-file`: feed it through the live path at real-time speed and report the wait (DESK-43, DESK-46)                         |
| `--phone-receive`         | Receive phone dictations headlessly for the end-to-end test (DESK-61); with `--relay-url`, `--phone-app-url`, `--count`, `--timeout-secs` |

**Key design decisions:**

- CLI flags are runtime-only overrides — they do NOT modify persisted settings
- Remote control flags work via `tauri_plugin_single_instance`: second instance sends args, then exits
- `send_transcription_input()` in `signal_handle.rs` is shared between signal handlers and CLI

## Debug Mode

Access debug features: `Cmd+Shift+D` (macOS) or `Ctrl+Shift+D` (Windows/Linux)

## Platform Notes

- **macOS**: Metal acceleration, accessibility permissions required for keyboard shortcuts
- **Windows**: Vulkan acceleration, code signing. Implicit Vulkan layers (overlays, capture hooks) are disabled for the WalkieTalkey process via `VK_LOADER_LAYERS_DISABLE=~implicit~` set in `main.rs`; opt out with `WALKIETALKEY_KEEP_VULKAN_IMPLICIT_LAYERS=1` or by setting `VK_LOADER_LAYERS_DISABLE` yourself
- **Linux**: OpenBLAS + Vulkan, limited Wayland support, overlay uses GTK layer shell (disable with `WALKIETALKEY_NO_GTK_LAYER_SHELL=1`)
- **Packagers**: `WALKIETALKEY_DISABLE_UPDATER=1` force-disables the self-updater at runtime without touching the persisted setting, for installs where self-update cannot work

## Troubleshooting

See the [Troubleshooting](BUILD.md#troubleshooting) section in BUILD.md.

## GitHub workflow for AI coding assistants

**Before opening a PR, issue or discussion in this repo, read the relevant template and fill in every section.**

- **Opening a PR:** Read [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md): What and why (with the requirement IDs from `docs/SPEC.md`), Tests, Screenshots for UI changes, and the checklist. Say plainly which parts an AI assistant wrote.
- **Opening an issue:** Read [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/). Blank issues are disabled: `fejl.md` for bugs (version, OS, model, steps), `oenske.md` for feature wishes. Questions go to [Discussions](https://github.com/JonathanRentoft/walkietalkey/discussions); vulnerabilities go to private reporting ([SECURITY.md](SECURITY.md)), never to a public issue.
- **Translations:** WalkieTalkey's UI is Danish (spec Appendix A); new strings are drafted in Danish and marked `TODO(copy)`.
- **Full contributor workflow:** [CONTRIBUTING.md](CONTRIBUTING.md).

**Commits:** Use conventional commit prefixes (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`, `ci:`). Focus the message on _why_, not _what_, and name the requirement IDs.
