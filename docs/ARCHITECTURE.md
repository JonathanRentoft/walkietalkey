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
| `lib.rs` single-instance handoff             | `walkietalkey::relay::training::{start, session_arg, NOT_RUNNING_EXIT}`                                                                                        | a `wt-train record` session handed to the running app (run 5)                                                                |
| `tray.rs`, `lib.rs` menu events              | `walkietalkey::tray`                                                                                                                                           | Seneste, Par en telefon, Sæt på pause, Genstart nu, pulse                                                                    |

Our own modules (`src-tauri/src/walkietalkey/`, `src-tauri/src/pipeline/da/`):

- `relay/`: the room connection (`crates/wt-relay-client`), pairing QR, phone dictations with their own live decode, key store (keys in the secret store, never the macOS keychain; room and counters beside them), headless e2e mode, and `relay/training` (DESK-65): the workbench's training takes, which the event loop hands over before any dictation code sees them.
- `cleanup/`: modes, markers, guardrails, the editor prompt, providers with pooled warm connections, the chunk-by-chunk engine.
- `settings.rs`, `managed.rs`, `store.rs`: WalkieTalkey settings and the Appendix B overlay.
- `history.rs`, `output.rs`, `dictation.rs`, `notify.rs`, `updates.rs`, `models.rs`, `speed.rs`, `presence.rs`, `secrets.rs`.
- `mic/`: the silent microphone (DESK-59): the level detector on the raw input, the probe that suggests a working input, and the guard that keeps every input stream a microphone (cpal on macOS would otherwise record the system audio from a device without input channels).

## Crates (`crates/`, `packages/protocol/rust/`)

| Crate                                    | What                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wt-protocol` (`packages/protocol/rust`) | keys, derivations, frames, payloads, control messages; shares `test-vectors.json` with the TypeScript package                                                                                 |
| `wt-relay-client`                        | the computer's side of a room: connect, create, auth, ping, backoff, pairing, decrypt, results                                                                                                |
| `wt-native`                              | secret folder (macOS), Credential Manager (Windows), microphone permission state, Windows clipboard formats, notifications with click handling, managed settings readers, presence, elevation |
| `ekko-pnc`                               | Ekko PnC punctuation in Rust, reproducing the `ekko-stt` reference on a golden set                                                                                                            |

## Phone, relay, site

- `phone/`: the PWA (Vite + React), on `@walkietalkey/protocol` and `@walkietalkey/ui`.
- `ios/`: the SwiftUI shell that serves the phone build from bundled files through `WKURLSchemeHandler`.
- `relay/`: Cloudflare Worker and one SQLite-backed Durable Object per room (hibernation, batching, one alarm).
- `site/`: Astro with React islands, static, no cookies or analytics.
- `packages/ui/`: the design system as typed React components and tokens.

## Fine-tuning workbench (`training/`)

Python (uv, PyTorch with MPS, Transformers, PEFT), separate from the app: one command, `wt-train`, with a step per module in `training/wt_train/` (plan, record, fetch, build, train, eval, export, smoke, ui, card). The sentences and the spelling conventions for English developer terms are in `training/data/`; recordings stay in `training/data/recordings/` (git-ignored) and everything large in the git-ignored work folder. Evaluation reuses the accuracy job's normaliser and WER (`models/eval/wt_eval`) and scores a GGUF through the app's own pipeline (`walkietalkey --transcribe-list`). An exported fine-tune is installed in the app's models folder as `edda-ft-<name>.gguf`; the app decodes ids starting with `edda-` like Edda (`walkietalkey::catalog::decodes_by_segment`).

Recording (run 5) goes through the app, so a clip is what the model hears:

```
wt-train record (127.0.0.1 page + API) ◀── HTTP, bearer token ── desktop relay/training ──training_prompt──▶ phone training screen
        │ checks, saves                                             ▲   (connects out only)        ◀──audio_start_training + chunks── (dictation capture)
        ▼                                                           └── Mac takes: AudioRecordingManager, no VAD
recordings/<condition>/<id>.wav + .txt + .json
```

`wt-train plan` gives every sentence one condition (phone whispered, phone normal, Mac normal; 40/40/20 within each split, `training/data/plan.csv`). `wt-train record --condition <c>` hands its session to the running app with `walkietalkey --training-session http://127.0.0.1:<port>/app/v1#<token>`; the app long-polls the recorder for prompts and Mac start/stop, sends each prompt to the phone (PRIV-05), and uploads every take as the 16 kHz audio received, before VAD. The recorder checks level, clipping and silence with limits for whispers, saves the take with its metadata, keeps every replaced take, and moves on. The exam (`training/data/exam.yaml`, six long paragraphs read once per condition) is evaluated through the app's live path and never trained on; the dataset builder's leakage check keeps it, and FLEURS test, out of every split. `wt-train eval` reports per condition (`wt_train/per_condition.py`).

Every train, eval and export run is tracked in MLflow (`wt_train/tracking.py`), in the git-ignored work folder (`<work>/mlflow`: a SQLite store and an artifact folder), with MLflow's telemetry switched off: the config, the git commit, the dataset fingerprint per split and condition, the loss of every step, validation every epoch, every eval metric overall and per condition, the FLEURS regression, and the files (loss plot, per-term table, side-by-side transcripts). `wt-train ui` opens MLflow's UI on 127.0.0.1 after adding `training/results.csv` rows as baseline runs; `wt-train card <run>` writes `training/journal/<date>-<run>.md` (`wt_train/journal.py`) with the numbers, the plots, the config diff against the previous run and four empty headings for the owner.
