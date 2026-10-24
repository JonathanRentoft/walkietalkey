# Architecture

The behaviour is specified in [SPEC.md](SPEC.md); the wire protocol in [PROTOCOL.md](PROTOCOL.md); the models in [MODELS.md](MODELS.md). This page is a map of the code.

```
 hold fn ──▶ desktop app (Tauri: Rust + React)
             HandyKeys ─▶ coordinator (300 ms rule) ─▶ recorder ─▶ live chunker (10-18 s, previous-chunk context)
                                                                      │  transcribe.cpp + Edda (text-only windows)
                                                                      ▼
             punctuation (Ekko PnC, ONNX Runtime) ─▶ filler words ─▶ replacements ─▶ AI cleanup (optional, per chunk)
                                                                      ▼
             output order (one at a time) ─▶ paste or private clipboard ─▶ pill / notification ─▶ history

 phone app (PWA / iOS shell) ──encrypted 200 ms PCM frames──▶ relay (Worker + Durable Object per room) ──▶ desktop relay client
                                                                                                        └▶ side live stream ─▶ same text steps ─▶ clipboard + notification
```

## Desktop (`src-tauri/`, `src/`)

The desktop app has a core (audio, models, shortcuts, paste, history, tray) and WalkieTalkey's modules beside it (DESK-05). The core calls in through a few hooks marked `WalkieTalkey`:

| Hook in the core                             | WalkieTalkey module                                                                                                                                            | What                                                                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `lib.rs` `run`, `initialize_core_logic`, CLI | `walkietalkey::{early_init, startup}`, `bench`, `relay::headless`                                                                                              | managed settings, model loaded at start, relay, updates, notifications; `--live` bench and `--phone-receive` e2e mode        |
| `settings::get_settings`                     | `walkietalkey::store::overlay_handy`                                                                                                                           | managed values win (DESK-101)                                                                                                |
| `transcription_coordinator`                  | `Discard`, `ForceStop` effects                                                                                                                                 | short holds dropped, 5-minute limit                                                                                          |
| `actions.rs` start/stop                      | `walkietalkey::{keys, limits, dictation, pill, sequence}`                                                                                                      | reveal after 300 ms, fn shortcuts cancel, output in order                                                                    |
| `managers/transcription`                     | `audio_toolkit::chunking::ChunkPlan::LIVE_DA`, `pipeline::da::context`, `walkietalkey::{cleanup::key_chunk_observer, punctuation::apply, vocabulary::for_run}` | 10-18 s chunks, context prompts, text-only windows, cleanup per chunk, Ekko PnC before filler removal, Ord within 150 tokens |
| `managers/model`                             | `walkietalkey::models::company_mirror`                                                                                                                         | `ModelBaseUrl` downloads                                                                                                     |
| `catalog`                                    | `walkietalkey::catalog` (`catalog.json`)                                                                                                                       | Edda and Ekko as an overlay on the model catalog, ranking by hardware                                                        |
| `clipboard.rs`                               | `walkietalkey::clipboard::write_private`                                                                                                                       | clipboard that stays on this computer                                                                                        |
| `managers/audio`, `CaptureSink` raw tap      | `walkietalkey::mic::{guard, start_take, seal_take, finish_take, silent_take}`                                                                                  | silent microphone notice and probe, no system audio (DESK-59)                                                                |
| `tray.rs`, `lib.rs` menu events              | `walkietalkey::tray`                                                                                                                                           | Seneste, Par en telefon, Sæt på pause, Genstart nu, pulse                                                                    |

Our own modules (`src-tauri/src/walkietalkey/`, `src-tauri/src/pipeline/da/`):

- `relay/`: the room connection (`crates/wt-relay-client`), pairing QR, phone dictations with their own live decode, key store (keychain for keys, a file for counters), headless e2e mode.
- `cleanup/`: modes, markers, guardrails, the editor prompt, providers with pooled warm connections, the chunk-by-chunk engine.
- `settings.rs`, `managed.rs`, `store.rs`: WalkieTalkey settings and the Appendix B overlay.
- `history.rs`, `output.rs`, `dictation.rs`, `notify.rs`, `updates.rs`, `models.rs`, `speed.rs`, `presence.rs`, `secrets.rs`.
- `mic/`: the silent microphone (DESK-59): the level detector on the raw input, the probe that suggests a working input, and the guard that keeps every input stream a microphone (cpal on macOS would otherwise record the system audio from a device without input channels).

## Crates (`crates/`, `packages/protocol/rust/`)

| Crate                                    | What                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `wt-protocol` (`packages/protocol/rust`) | keys, derivations, frames, payloads, control messages; shares `test-vectors.json` with the TypeScript package         |
| `wt-relay-client`                        | the computer's side of a room: connect, create, auth, ping, backoff, pairing, decrypt, results                        |
| `wt-native`                              | keychain, Windows clipboard formats, notifications with click handling, managed settings readers, presence, elevation |
| `ekko-pnc`                               | Ekko PnC punctuation in Rust, reproducing the `ekko-stt` reference on a golden set                                    |

## Phone, relay, site

- `phone/`: the PWA (Vite + React), on `@walkietalkey/protocol` and `@walkietalkey/ui`.
- `ios/`: the SwiftUI shell that serves the phone build from bundled files through `WKURLSchemeHandler`.
- `relay/`: Cloudflare Worker and one SQLite-backed Durable Object per room (hibernation, batching, one alarm).
- `site/`: Astro with React islands, static, no cookies or analytics.
- `packages/ui/`: the design system as typed React components and tokens.

## Fine-tuning workbench (`training/`)

Python (uv, PyTorch with MPS, Transformers, PEFT), separate from the app: one command, `wt-train`, with a step per module in `training/wt_train/` (record, fetch, build, train, eval, export, smoke). The sentences and the spelling conventions for English developer terms are in `training/data/`; recordings stay in `training/data/recordings/` (git-ignored) and everything large in the git-ignored work folder. Evaluation reuses the accuracy job's normaliser and WER (`models/eval/wt_eval`) and scores a GGUF through the app's own pipeline (`walkietalkey --transcribe-list`). An exported fine-tune is installed in the app's models folder as `edda-ft-<name>.gguf`; the app decodes ids starting with `edda-` like Edda (`walkietalkey::catalog::decodes_by_segment`).
