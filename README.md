# WalkieTalkey

Free, open-source Danish dictation for Mac, Windows and your phone.

![WalkieTalkey: hold the key, talk, and the text appears](docs/assets/hero.gif)

Hold `fn` on a Mac (Right Ctrl on Windows, or a key you choose), talk, let go, and the text appears where you are typing. Or hold the button in the phone app, talk, let go, and the text lands on the computer you are sitting at, on the clipboard with a small notification.

- Speech becomes text on your own computer, with Edda, a Danish speech model. Long dictations are transcribed while you talk, so you wait about as long after two minutes as after ten seconds.
- Your own words and replacements, Danish filler words removed, punctuation on the computer, and optional AI cleanup with a provider and key you choose.
- Encrypted from phone to computer. The relay in between only routes; it cannot read the audio.
- No accounts. No tracking.

## Download

- **Mac** (macOS 13 or newer, Apple silicon and Intel) and **Windows** (10 and 11, x64): [the latest release](https://github.com/JonathanRentoft/walkietalkey/releases/latest).
- **Phone**: open the phone app from the QR code in the desktop app ("Par en telefon"). It works in the browser on iPhone and Android; add it to the home screen.
- Companies: [docs/MANAGED_SETTINGS.md](docs/MANAGED_SETTINGS.md) (own relay, own model server, managed settings for Intune, Jamf and Group Policy).

The app downloads its speech model on first start (886 MB for Edda, or 134 MB for Ekko v1 Tiny on slower computers), from Hugging Face or your company's server. Until our converted models are published ([docs/MODELS.md](docs/MODELS.md)), build them with `models/` and import the file in the app's model settings.

## Privacy in three lines

1. Your voice is turned into text on your computer, never on our servers.
2. Audio from the phone is end-to-end encrypted; the relay sees only encrypted frames and is not given the text.
3. No accounts, no analytics, no crash reports. AI cleanup is off unless you turn it on, and then only text goes to the provider you chose.

Details: [docs/PRIVACY.md](docs/PRIVACY.md), [SECURITY.md](SECURITY.md) and [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Build

You need [Rust](https://rustup.rs/) (stable), [Bun](https://bun.sh/) and CMake; on macOS the Xcode command line tools, on Windows the Visual Studio C++ build tools and the Vulkan SDK. Platform details are in [BUILD.md](BUILD.md).

```bash
bun install

# The desktop app (Tauri)
bun run tauri dev                       # add CMAKE_POLICY_VERSION_MINIMUM=3.5 if CMake complains
bun run tauri build

# The phone app, the relay and the website
bun run --cwd phone dev
bun run --cwd relay dev                 # wrangler dev, a local relay
bun run --cwd site dev
```

Tests:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib     # desktop pipeline, settings, relay client hooks
cargo test --manifest-path packages/protocol/rust/Cargo.toml
bun run --cwd packages/protocol test                        # shared protocol test vectors
bun run --cwd relay test                                    # Workers pool (Miniflare)
bun run --cwd packages/ui test
bun run --cwd phone test
bun run --cwd site test
```

How the parts fit together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The full behaviour is specified in [docs/SPEC.md](docs/SPEC.md); the models in [docs/MODELS.md](docs/MODELS.md). Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

- [Handy](https://github.com/cjpais/Handy) by CJ Pais (MIT): WalkieTalkey is a fork of Handy and keeps its structure, so improvements can flow both ways.
- [Edda v0.2](https://huggingface.co/danish-foundation-models/edda-v0.2) (Alexandra Institute, Danish Foundation Models), [Ekko v1 Tiny](https://huggingface.co/RyeAI/ekko-v1-tiny) and [Ekko PnC](https://huggingface.co/RyeAI/ekko-pnc) (RyeAI), trained on CoRal and other Danish speech: see [NOTICE](NOTICE) and [docs/MODELS.md](docs/MODELS.md) for licences and training data.
- [transcribe.cpp](https://github.com/handy-computer/transcribe-cpp), [ONNX Runtime](https://onnxruntime.ai/), [Tauri](https://tauri.app/) and [Cloudflare Workers](https://workers.cloudflare.com/).

## Licence

Apache-2.0, see [LICENSE](LICENSE). Files from Handy remain available under MIT as well ([licenses/Handy-MIT.txt](licenses/Handy-MIT.txt)). The name WalkieTalkey and the logo are not covered by the code licence: [TRADEMARKS.md](TRADEMARKS.md).
