# Models

What WalkieTalkey runs, where each file comes from, how it was checked, and the
licence terms behind it. Milestone M0 (spec section 16): DESK-29 to DESK-35,
DESK-41, DESK-43, OSS-24. Measured on 23 October 2026 on the owner's 16-inch
MacBook Pro (Apple M1 Pro, 32 GB, macOS 26.6).

| Model                                               | Role                                                | Engine                             | File we ship                                              | Licence                                                    | Status                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------- | ---------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Edda v0.2 (Alexandra Institute)                     | Danish speech recognition, default (DESK-30)        | transcribe.cpp 0.4                 | `edda-v0.2-Q8_0.gguf`, 886 MB                             | Apache-2.0 + CoRal restrictions                            | Converted and validated; 7.17 % WER on FLEURS da. Decode with timestamps off and one utterance per window. Publishing waits on decision 18.7 |
| Ekko v1 Tiny (RyeAI)                                | Fast model for slow PCs (DESK-35)                   | transcribe.cpp 0.4                 | `ekko-v1-tiny-Q8_0.gguf`, 134 MB                          | NVIDIA Open Model License + CC BY 4.0 + CoRal restrictions | Licence allows it; converted and validated; same FT Speech question as Edda                                                                  |
| Ekko PnC v2 (RyeAI)                                 | Punctuation and capitalisation (DESK-41)            | ONNX Runtime via `crates/ekko-pnc` | `pnc.int8.onnx` + `tokenizer.json` + `config.json`, 25 MB | CC BY 4.0 + CoRal restrictions                             | Rust port reproduces the reference exactly                                                                                                   |
| Silero VAD v6.2                                     | Voice activity detection                            | transcribe.cpp 0.4                 | bundled in the app                                        | MIT                                                        | Unchanged from Handy                                                                                                                         |
| Whisper large-v3-turbo (OpenAI, the catalog's GGUF) | Baseline for comparison, "Andre modeller" (DESK-34) | transcribe.cpp 0.4                 | the model catalog (`catalog.json`)                        | MIT                                                        | Unchanged from Handy                                                                                                                         |

Every file the app downloads or bundles is listed with size and SHA-256 in
[`models/manifest.json`](../models/manifest.json) (DESK-32). They are the assets
of the GitHub release [`models-v1`](https://github.com/JonathanRentoft/walkietalkey/releases/tag/models-v1), one flat folder with the model cards
(`<model>-README.md`), the licence files (prefixed `<model>-`, because a release
cannot hold folders; the app puts them back in `LICENSES/`) and `SHA256SUMS`.
`models/release.sh` stages and publishes it. A company's `ModelBaseUrl`
(Appendix B) replaces it: the app fetches each file from
`<ModelBaseUrl>/<file name>` (one flat folder, the same file names and bytes),
and checks its SHA-256. Run 2: the owner chose GitHub over Hugging Face; the FT
Speech question (decision 18.7) only concerns companies' use and stays open.

## Decode Edda with timestamps off

Edda was fine-tuned on `<|da|><|transcribe|><|notimestamps|>` sequences only.
transcribe.cpp's default `TimestampKind::Auto` always
runs Whisper models with segment timestamps, and then Edda drops or cuts the
first words of a window ("Dette er en vigtig måde ..." becomes "er en vigtig
måde ..."). This is the model, not the engine: the original Transformers model
with `return_timestamps=True` drops or cuts leading words on 6 of 10 test clips
and lower-cases the first word on 3 more. With `TimestampKind::None` the GGUF
matches the original exactly (below). The GGUF metadata cannot switch this off
(`Auto` resolves to segment timestamps for every Whisper file), so the app must
pass `TimestampKind::None` for Edda; `models/manifest.json` records it as the
model's `runOptions`, and the draft catalog entry sets `timestamps: false`.
On all 930 FLEURS test clips this doubles Edda's WER, from 7.17 % (off) to
14.54 % (on); Whisper turbo barely moves (13.06 % and 13.29 %). With segment
timestamps on, transcribe-cli can also print invalid UTF-8 (a segment boundary
splitting a multi-byte character), which the harness now tolerates.

## Edda v0.2: conversion and validation (DESK-29)

- **Conversion.** transcribe.cpp 0.4.0 (the release the app links;
  `scripts/convert-whisper.py`, then `transcribe-quantize --quant Q8_0`). A
  wrapper only registers the name ("Edda v0.2", variant `edda-v0.2`); the
  weights, vocabulary and configuration go through the upstream converter
  unchanged. The GGUF header has the same keys and the same 589 tensors as
  the catalog's Whisper turbo file, so the app lists it from its custom
  models folder as "Edda v0.2".
- **transcribe.cpp's Whisper gate** (`validate.py all --family whisper`, F16 GGUF on
  CPU against Transformers 5.6.1 fp32, cases: two Danish FLEURS clips and
  `jfk.wav`). The Danish transcripts match the reference **exactly**. Neither
  Edda nor stock turbo stays inside transcribe.cpp's published tolerance budget
  on this machine (the budget was calibrated on jfk only, on another machine),
  so the same pipeline was run on stock `openai/whisper-large-v3-turbo` with
  the catalog's F16 GGUF as a control:

  | Case                             | Tensors within budget: Edda | Turbo (control) |       Worst max_abs: Edda | Turbo |
  | -------------------------------- | --------------------------: | --------------: | ------------------------: | ----: |
  | FLEURS 6263195548503774343 (da)  |                       13/22 |           12/22 | 7.51 (`enc.block.31.out`) |  11.5 |
  | FLEURS 17924706686437869147 (da) |                       12/22 |           11/22 | 12.7 (`enc.block.31.out`) |  14.2 |
  | jfk (en)                         |                       15/22 |           14/22 |  2.4 (`enc.block.31.out`) |  7.17 |

  Edda drifts no more than the stock model it is built on, on the same build
  and machine: the deviations are F16 noise, not conversion errors. On the
  English `jfk.wav` Edda's C++ transcript differs from its reference by one word
  ("country" against "county"); stock turbo matches on all three.

- **Same text as the original** on 10 real Danish FLEURS clips (every 93rd
  test file): `edda-v0.2-Q8_0.gguf` on Metal, the same on CPU, and
  `edda-v0.2-F16.gguf` on CPU each give **exactly** the original model's text
  on **10 of 10** clips (Transformers fp32 greedy, timestamps off).
- **Q8_0 against F16** (`quant_accuracy.py`, a diagnostic, not an acceptance
  gate upstream): identical transcript; 47 of 49 activation dumps inside the
  starting Q8_0 bands; `enc.final` 6.5 % worst-element relative error (1.6 %
  mean), last-step logits 2.3 % mean.
- **Reproducible.** Re-running both conversions from the originals gives
  byte-identical files.

## Ekko v1 Tiny: conversion and validation (DESK-35)

transcribe.cpp 0.4.0 `scripts/convert-parakeet.py` (a wrapper adds an
`ekko-v1-tiny` profile: 110M RNN-T, 44-token vocabulary, Danish only, its own
licence metadata), then Q8_0. transcribe.cpp's Parakeet gate
(`validate.py all --family parakeet`, F32 GGUF on CPU against NeMo fp32) on two
Danish FLEURS clips: both transcripts equal NeMo's **exactly**; 14/16 and 15/16
tensors inside the Parakeet tolerances. The tensor outside on both clips is
`enc.block.16.out`, which in this 17-layer model is the encoder output (its
values equal `enc.final`, which passes); `enc.block.8.out` exceeds max_abs on
one clip with its mean inside. F32 and Q8_0 give the same text on both clips.
transcribe.cpp recommends Q8_0 as the default quant for every model it
publishes (the model catalog ships Q8_0 for its 110M Parakeet too); RyeAI's own
quant table shows Q8_0 within 0.01 WER points of F16.

## Ekko PnC in Rust (DESK-41)

`crates/ekko-pnc` (no Tauri dependency) runs `pnc.int8.onnx` through ONNX
Runtime with the `ort` crate and reproduces the reference runtime, `ekko.pnc.Punctuator`
from `ekko-stt` 0.1.2:

```rust
let pnc = ekko_pnc::Punctuator::from_dir(dir)?;      // pnc.int8.onnx, tokenizer.json, config.json
let text: String = pnc.punctuate("hej mit navn er emil hvordan går det")?;
let words: Vec<String> = pnc.punctuate_words(&["hej", "med", "dig"])?;
```

- Words are Python's `str.split()`; tokenisation is the same `tokenizer.json`
  through the same Rust core (`tokenizers` 0.23.2, which reproduces the golden set) with pre-tokenised input;
  windows of at most 128 tokens re-read 12 words of left context and hold back
  12 words for the next window, exactly as the reference plans and merges them;
  each word's label comes from its first sub-token (NumPy `argmax` semantics);
  capitalisation keeps existing capitals, and a final pass capitalises after
  ". ! ?" except after abbreviations. Python's `str` semantics (whitespace,
  `isalpha`, `isupper`/`istitle`, `title`) come from tables generated from
  CPython 3.12 (`src/pyunicode.rs`, `models/ekko-pnc/gen_unicode_tables.py`).
- **Golden set**: 52 inputs generated with `ekko-stt`
  (`models/ekko-pnc/generate_golden.py`): dictation-style Danish, mixed Danish
  and English, numbers, casing, abbreviations, odd whitespace and characters,
  and 5 inputs longer than one 128-token window (154 to 1,672 tokens, built from
  FLEURS transcripts). `cargo test -p ekko-pnc` reproduces **all 52 byte for
  byte**. Tests that need the model read `WT_EKKO_PNC_DIR` and skip with a
  notice without it; `models/ekko-pnc/download.sh <dir>` fetches the pinned
  files with checksum checks (for CI).
- **ONNX Runtime version matters.** With `ort` 2.0.0-rc.12 (ONNX Runtime
  1.24.2, the version the app shipped before) 6 near-tie words in 3 long inputs came out
  differently, and the Python reference itself gives exactly the same 6
  differences on onnxruntime 1.24.2; on 1.28.0 it matches the reference's 1.29.0
  on every input, and on 1.31.0 (`ort` rc.14 and rc.15) it differs again (3 words). The crate therefore
  pins **`ort` =2.0.0-rc.13 (ONNX Runtime 1.28.0)**. Any API-17+ runtime works;
  only the exact golden match needs 1.28/1.29.
- **Targets.** `cargo check` passes for `aarch64-apple-darwin` (pyke's prebuilt
  static ONNX Runtime, default feature), `x86_64-pc-windows-msvc` (prebuilt) and
  `x86_64-apple-darwin` with `--features load-dynamic`. pyke ships no
  `x86_64-apple-darwin` binary and Microsoft stopped publishing Intel macOS
  builds after 1.23, so Intel Macs need an ONNX Runtime built for them, linked with `ORT_LIB_LOCATION` +
  `ORT_PREFER_DYNAMIC_LINK=1`, or loaded at run time (`load-dynamic`). On
  Windows, link Microsoft's baseline `onnxruntime.dll` dynamically, because
  pyke's static Windows build has an AVX2 initialiser that crashes on
  pre-Haswell CPUs (use the 1.28.0 release).
- **Speed** (release build, M1 Pro CPU): model load 130 ms; a 15-word sentence
  3 ms; 1,324 words (11 windows) 190 ms.

## Danish test harness (spec 15.1)

`models/eval/` (Python, standard library only, run with uv). One command:

```bash
models/eval/run.sh                       # FLEURS da_dk test, all models (WT_WORK_DIR=_kit/work by default)
models/eval/run.sh --limit 200           # evenly spread, deterministic subset
models/eval/run.sh --clips-dir ~/diktater   # the owner's own <name>.wav + <name>.txt, outside the repo
```

It fetches and builds what is missing (transcribe.cpp 0.4.0, FLEURS, Edda Q8_0
from the original, the catalog's Whisper turbo Q8_0 checked against its
SHA-256, Ekko v1 tiny Q8_0), transcribes every clip with each model through
`transcribe-cli` in batch mode (model loaded once, greedy, language forced to
Danish) and writes `summary.md`, `summary.json` and one `<model>.jsonl` with
every clip's reference, hypothesis and scores. `--clips-dir` refuses folders
inside the repository and converts audio that is not 16 kHz mono with ffmpeg.
Unit tests: `cd models/eval && uv run --group dev pytest` (88 tests).

- **Data.** FLEURS (google/fleurs, CC BY 4.0) `da_dk` test split, revision
  `70bb2e84b976b7e960aa89f1c648e09c59f894dd`: 930 clips, 2.9 hours, read news
  sentences (several speakers per sentence). The reference is FLEURS's raw
  (cased, punctuated) transcription.
- **WER normaliser** (`wt_eval/normalize.py`, applied to both sides): Unicode
  NFKC and lower case; numbers as spoken Danish ("800.000" becomes "otte
  hundrede tusind", "3,5" becomes "tre komma fem", 1100 to 1999 read alike
  whether written "1.100", "1100" or in words, other integers as cardinals,
  "%" becomes "procent"); every character that is not a letter or digit becomes
  a space (punctuation, hyphens, quotes); "tusinde"/"tusind", "én"/"en" and "et
  hundrede"/"hundrede" folded; whitespace collapsed. WER is the corpus total of
  substitutions, deletions and insertions over reference words (Levenshtein),
  with a 95 % bootstrap interval over clips.

  **Run 8: the reference and the model's text normalise the same way.** Before,
  the normaliser read some written forms differently from the same words
  spoken, so part of the "errors" were scoring errors: "29¾" in a FLEURS
  reference became "to hundrede og treoghalvfems fire", "e.kr." was split. Now
  fractions ("29¾" and "29 trefjerdedele" both read "niogtyve tre
  fjerdedele"), abbreviations (e.kr., f.Kr., f.eks., bl.a., ca., kl., nr., pct.,
  osv. and more; "kr." is kroner only after a number), units after a number
  (km, m, cm, km/t), signs ($, ~, x), ordinals and dates ("15. august"), clock
  times, ratios and ranges, accents (idé/ide) and a few spelling variants
  ("selv om"/"selvom", "dollars"/"dollar") read alike, and `normalize_pair`
  joins a hyphenated compound when the other text writes it closed
  ("Schengen-land"/"Schengenland"). Over the 930 FLEURS test references, 89
  changed (34 distinct texts). Both baselines were rerun with identical
  transcripts and the fixed normaliser: Edda float16 through Transformers
  7.21 % to **6.32 %** (95 %: 5.86 to 6.79), the app path (0.2.1) 7.63 % to
  **6.72 %** (6.26 to 7.18), all of it from the scoring. Still not folded:
  "10.30" outside "klokken", "halv syv", Roman numerals, compounds written
  apart without a hyphen. The transcribe-cli table below was scored with the
  earlier normaliser.

- **Punctuation measure** (`wt_eval/punctuation.py`, on the raw hypothesis):
  marks are `. , ? ! ; :` except a mark between two digits ("3,5", "800.000");
  words are whitespace-separated tokens. Reported as marks per 25 words over the
  whole set, and the share of clips with fewer than 1 mark per 25 words, which
  is exactly the DESK-41 trigger (`marks * 25 < words`, never for empty text).

### Results: FLEURS da_dk test, all 930 clips

Q8_0 files, transcribe.cpp 0.4.0 on Metal, language forced to Danish, greedy.
Run on 23 October 2026, 02:12 to 04:58 with pauses (GPU job log in
`_kit/work/runs/gpu-jobs.log`; parts ran next to other jobs of ours, which only
affects timing).

| Model                                 | Timestamps          |        WER | 95 % CI        | Subst. | Del. | Ins. | Marks per 25 words | Clips under 1 mark per 25 words (DESK-41 trigger) |
| ------------------------------------- | ------------------- | ---------: | -------------- | -----: | ---: | ---: | -----------------: | ------------------------------------------------: |
| **Edda v0.2 Q8_0**                    | off                 | **7.17 %** | 6.64 to 7.74   |  1,046 |  293 |  130 |               1.98 |                                      377 (40.5 %) |
| Edda v0.2 Q8_0                        | on (engine default) |    14.54 % | 12.72 to 16.94 |  1,243 |  880 |  858 |               1.79 |                                      445 (47.8 %) |
| Whisper large-v3-turbo Q8_0 (catalog) | off                 |    13.06 % | 12.28 to 13.71 |  2,069 |  285 |  322 |               3.22 |                                         6 (0.6 %) |
| Whisper large-v3-turbo Q8_0 (catalog) | on (engine default) |    13.29 % | 12.53 to 13.94 |  2,083 |  297 |  344 |               3.17 |                                         7 (0.8 %) |
| Ekko v1 Tiny Q8_0                     | n/a (RNN-T)         |    10.11 % | 9.47 to 10.76  |  1,442 |  412 |  219 |               0.00 |                                      929 (99.9 %) |

The references have 3.16 marks per 25 words. For comparison, the originals'
own numbers on this split: Edda 7.34 % (5-beam search, leaderboard
normalisation), Ekko v1 Tiny 9.36 % (RyeAI's normalisation), Whisper turbo
13.60 % (transcribe.cpp's normalisation). Edda was trained on FLEURS `da_dk`
_train_ split: the test split is held out but in its domain, which favours it here;
the owner's own dictations (`--clips-dir`) are the real test.

**Checked in run 7.** Edda's model card lists 2,463 FLEURS da_dk clips from
`google/fleurs` _train_ in its training data. At the pinned revision FLEURS
da_dk has 2,465 train clips (1,380 sentences), 395 validation and 930 test
(350 sentences), so 2,463 is the train split after Edda's filtering (train and
validation together would be 2,860). `wt-train fetch --overlap` compares train
with test: no test clip shares a FLEURS sentence id, a normalised text, a file
name or decoded audio with any train clip. Our FLEURS test regression check is
therefore held out from Edda's training as well as from ours.

**Punctuation after DESK-41** (`wt_eval.pnc_after`, Ekko PnC through
`crates/ekko-pnc` on every clip under the threshold):

| Model              | Clips that got PnC | Marks per 25 words before, after | Clips still under the threshold | Clips ending in . ? ! |
| ------------------ | -----------------: | -------------------------------- | ------------------------------: | --------------------: |
| Edda v0.2 Q8_0     |                377 | 1.98, 3.18                       |                               3 |            918 of 930 |
| Whisper turbo Q8_0 |                  6 | 3.22, 3.23                       |                               3 |            929 of 930 |
| Ekko v1 Tiny Q8_0  |                929 | 0.00, 3.14                       |                               5 |            910 of 930 |

So Edda leaves 4 in 10 clips without punctuation of its own (its FT Speech
training transcripts are unpunctuated), and DESK-41 closes the gap: after PnC
all three models punctuate about as densely as the references. Ekko v1 Tiny
always needs PnC, as the spec expects.

## Raw speed (DESK-31, DESK-43)

`models/speed/run.sh`: a small bench on the `transcribe-cpp` 0.4.0 crate (with
`transcribe-cpp-sys` 0.4.0, as in the app's lock file), the app's run options (language
`da`, timestamps off), model loaded once, 1 warm-up and 5 timed runs per clip,
wall time around `Session::run`. Clips: Danish FLEURS speech of exactly 10, 11,
30 (three utterances) and 35 s (four utterances; two Whisper windows),
`models/clips/make_clips.sh`. M1 Pro (8 performance + 2 efficiency cores,
16-core GPU), measured 02:50 to 03:04 on 23 October 2026 with no other job of
ours running; the lead's occasional short Metal benches may overlap. Mean
(min to max) of 5 runs:

| Model              | Backend          |               10 s |               11 s |                 30 s |                   35 s |
| ------------------ | ---------------- | -----------------: | -----------------: | -------------------: | ---------------------: |
| Edda v0.2 Q8_0     | Metal            | 0.93 s (0.93-0.94) | 0.96 s (0.96-0.96) | 0.93 s\* (0.92-0.93) |   1.81 s\* (1.77-1.88) |
| Edda v0.2 Q8_0     | CPU              | 5.12 s (4.17-7.13) | 4.06 s (3.92-4.22) | 5.03 s\* (4.25-6.60) |  9.55 s\* (7.49-10.43) |
| Edda v0.2 Q8_0     | CPU + Accelerate | 5.79 s (5.39-6.24) | 4.80 s (4.64-4.92) | 5.46 s\* (4.73-6.13) | 11.81 s\* (8.39-20.56) |
| Whisper turbo Q8_0 | Metal            | 0.94 s (0.93-0.96) | 0.96 s (0.95-0.97) |   1.22 s (1.16-1.28) |     2.04 s (2.01-2.09) |
| Whisper turbo Q8_0 | CPU              | 4.45 s (3.42-5.40) | 5.33 s (4.60-5.97) |   6.33 s (5.58-7.01) |   11.34 s (8.86-14.16) |
| Whisper turbo Q8_0 | CPU + Accelerate | 5.64 s (5.07-6.37) | 4.99 s (4.49-5.96) |   5.10 s (4.78-5.31) |    8.74 s (7.37-10.12) |
| Ekko v1 Tiny Q8_0  | Metal            |             0.07 s |             0.09 s |               0.22 s |                 0.25 s |
| Ekko v1 Tiny Q8_0  | CPU              |             0.09 s |             0.10 s |               0.29 s |                 0.35 s |
| Ekko v1 Tiny Q8_0  | CPU + Accelerate |             0.08 s |             0.11 s |               0.29 s |                 0.34 s |

\* Edda stopped after the first sentence of each window on these
multi-sentence clips (17 of about 60 words on 30 s), so these times are short
by the decoding of the missing words; see "Edda and pauses" below. Whisper
models encode a full 30 s window whatever the length, so 10 s costs about as
much as 30 s; 35 s needs two windows.

- **DESK-31 check** (the bundled 10 s clip): Edda needs **0.93 s on Metal**,
  inside the 1.5 s threshold, so Edda is the default on this Mac. On CPU alone it
  needs 4 to 6 s, so a CPU-only machine of this class would be offered Ekko v1
  Tiny (0.09 s, about 110 times real time).
- **Against transcribe.cpp's published numbers** (its own `transcribe-bench`,
  library defaults, `jfk` 11.0 s and `dots` 35.3 s, stock Whisper turbo Q8_0;
  `upstream-bench.jsonl`): this M1 Pro takes 0.93 s and 2.04 s on Metal and
  3.37 s and 7.68 s on CPU, against 0.30 s and 0.69 s (Metal) and 2.85 s and
  5.80 s (CPU) on transcribe.cpp's M4 Max, so this GPU is about 3 times slower.
  Edda on these English samples with library defaults (language detection,
  timestamps on) produces nonsense and is not comparable.
- **DESK-43** measures the wait after release, which with DESK-46's live
  chunking is the decode of the last chunk only: on this Mac about 0.95 s for
  any last chunk up to one window with Edda on Metal.

## Edda and pauses: decode one utterance per window

Greedy decoding is all transcribe.cpp 0.4 offers for Whisper (no beam search).
Given a window with several sentences and the pauses between them, greedy Edda
often ends the transcript at the first sentence boundary. The original
Transformers model does the same: on the 30 s speed clip (three sentences) it
stops after 17 of 60 words with greedy decoding, with or without timestamps,
and gets all 60 with 5-beam search, its card's default. FLEURS utterances are
single sentences, so the main WER table cannot show this; `make_multi_clips.py`
joins 2 or 3 consecutive FLEURS test utterances into one window (under 29.5 s)
for this test. WER, timestamps off, Metal:

| Clips                                           | Edda v0.2 Q8_0, whole window | Edda, VAD-split | Whisper turbo Q8_0, whole window | Turbo, VAD-split | Ekko v1 Tiny |
| ----------------------------------------------- | ---------------------------: | --------------: | -------------------------------: | ---------------: | -----------: |
| 100 x 2 utterances, recorded pauses             |              15.49 % (D 424) |         10.25 % |                          13.31 % |          19.48 % |      10.28 % |
| 60 x 3 utterances, recorded pauses              |              22.09 % (D 565) |          9.64 % |                          13.26 % |          16.73 % |      13.14 % |
| 100 x 2 utterances, speech trimmed, 0.3 s pause |              16.00 % (D 448) |         10.75 % |                          13.57 % |          19.53 % |          n/a |

Edda drops at least a quarter of the words on 17 of 100 two-sentence windows,
19 of 60 three-sentence windows and 18 of 100 windows with 0.3 s pauses,
against 1 of 930 single utterances; Whisper turbo on none. A short, ordinary
pause is enough. "VAD-split" (`--split-vad`) cuts each window at the pauses
Silero VAD finds (the VAD the app bundles; about 5 segments per two-sentence
clip, some inside sentences) and decodes every segment as its own window
without context: that brings Edda close to its single-utterance accuracy and
below turbo, while it makes turbo worse.

**What the app does (measured through the app).** Splitting at every pause
fixes multi-sentence windows but hurts single sentences: pieces of one or two
seconds decoded on their own repeat phrases or drift into other scripts. Decoding
each 10-18 s chunk whole and only a cut-short one again by segment is the most
accurate, but a cut-short last chunk then costs several encoder passes after
release (DESK-43, DESK-46). The app therefore decodes Edda one piece at a time
while the user talks, text only, with the previous text as the context prompt: a
pause of half a second or more (the usual break between sentences) ends a piece
(run 4: once it is a second long; run 5: with 1.5 s of speech on each side, see
"Invented words on short pieces" below), so a sentence with its shorter pauses
stays whole, and a piece whose text still comes out cut short (run 4: under 1.6
words per second of audio; run 5: under 9 letters per second of speech) is split
again at its shorter pauses and kept only with 25 % more words. The batch path
(the CLI, a history re-transcription) does the same. WER through the app
(`walkietalkey -f <clip> --json`, the harness's normalisation), and the wait
after release (`walkietalkey -f <clip> --live`, release build, M1 Pro), run 4:

| Decoding                                                             |           Single sentences (100) | 2 utterances (100) | 3 utterances (60) | Wait, 16 s | Wait, 2 min |
| -------------------------------------------------------------------- | -------------------------------: | -----------------: | ----------------: | ---------: | ----------: |
| Whole windows                                                        | (7.17 % on all 930, engine only) |            15.49 % |           22.09 % |            |             |
| At every pause                                                       |                          11.01 % |            10.68 % |            9.46 % |            |             |
| Whole, cut-short chunks again by segment                             |                           6.89 % |             8.13 % |            7.09 % |     1.03 s |      4.74 s |
| At pauses of 0.2 s or more                                           |                           9.15 % |             8.60 % |            9.61 % |     0.93 s |      0.99 s |
| **At pauses of 0.5 s or more, cut-short pieces split finer (run 4)** |                       **8.65 %** |         **7.45 %** |        **7.70 %** | **0.92 s** |  **0.99 s** |

With run 4's decoding, 1 of 260 windows still loses a quarter of its words
(against 17 of 100 two-utterance windows decoded whole), and the wait after a
two-minute dictation is within 0.1 s of the wait after 16 s.

## Invented words on short pieces (run 5, DESK-46)

Run 4 scored all 930 FLEURS da_dk test clips through the app
(`training/results.csv`): the shipped Edda v0.2 Q8_0 at 8.44 % WER (95 % CI
7.84 to 9.05) against 7.21 % (6.66 to 7.78) for the base model in Transformers
(float16, greedy, one clip per window). The gap was mostly insertions: 319
against 135. The 20 clips with the most insertions beyond the float16 run
carried 102 of them ("Tester en to tre fire fem seks syv otte.", "G rides
USB", a loop of "der er af Svendås").

**The measured path is the real one.** `--transcribe-list` (and
`--transcribe-file`) decodes with the live chunker's plan (`LIVE_SEGMENTS`), the
same chunk decode (context prompts, joint repair, script guard) and the same
finishing as a dictation, and the chunker cuts a clip pushed whole exactly as it
cuts it fed in 200 ms pieces (`audio_toolkit::chunking` tests). A phone
dictation reaches the chunker as it is, like a file. A key recording does not:
the recorder's own VAD (Silero at 0.3, 450 ms pre-roll and hangover) drops what
it calls silence first, so its pauses are shorter and its ends trimmed.
`--key-recording` passes a file through the recorder's capture sink first, so
that path is measured too (below).

**What the chunker cut.** With the pieces logged (debug log, `Long-form chunk`),
the 20 clips had 41 pieces, 9 of them under 3 s; 11 pieces were re-split as
"cut short" and 7 of those re-splits replaced the whole text. On an evenly
spread 200, there were 17 pieces under 3 s and 40 re-splits (of 261 pieces).
Two things in the chunker made the short pieces:

- A pause of 0.5 s ended a piece once the piece was a second long, silence
  included. FLEURS clips end with up to 6 s of room sound, a breath or a click
  after the sentence; that stretch, after a pause, became a piece of its own
  (on the 200: 14 clips with a short last piece, 23 insertions more than
  float16; on the 20: 7 clips, 16).
- The cut-short check counted words per second of the whole piece, silence
  included, so a single sentence with two seconds of silence around it looked
  cut short. Its re-split at 0.1 s pauses made pieces of one or two seconds,
  which invented words, and the invented words won because the rule keeps the
  pieces when they have 25 % more words (on the 20: 7 clips, 45 insertions).

**Why Edda invents words on them.** A probe on transcribe.cpp 0.4.0 (the
library's C API with the app's run settings: Danish, text only, the previous
text as prompt) read the engine's per-window trace on such pieces:

| Piece (FLEURS clip, seconds)    | No-speech probability | Greedy pass: avg log-prob, text                  | Kept (5 fallbacks to T = 1.0), 4 seeds                                             |
| ------------------------------- | --------------------: | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 731573035460961798, 17.8-19.6   |                 0.000 | -1.43 "Tak, kusk, kusk"                          | "Ja det var såvel", "Nord Thriste nyssund", "ensemble", "T enforcement"            |
| 7915212696696083057, 16.7-18.2  |                 0.000 | -1.42 "Det er der ikke, hvor fedt."              | "Kikal guys", "Det er nemlig следующ", "Starsrael surrounded Dont", "движ"         |
| 17525722700148894525, 13.1-21.8 |                 0.000 | -1.80 "Ja"                                       | "synthing отно", "itte ακ相alling 1960emy", "concur Queens", "all Broadjamilleden" |
| 2502419634491081382, 9.9-15.9   |                 0.000 | -0.61 "Tester en to tre fire fem seks syv otte." | (passes at greedy: the same every time)                                            |
| The same clips whole            |                 0.000 | -0.14, -0.11: the sentence only                  | (no fallback)                                                                      |

Edda never predicts Whisper's no-speech token (probability 0.000 on silence,
noise and speech alike; it was fine-tuned without such examples), so the
engine's no-speech gate (`no_speech_prob > 0.6`) can never fire. On a piece
without speech the greedy pass is unsure (average log-probability under -1.0),
so transcribe.cpp falls back to sampling at temperatures 0.2 to 1.0 and, when
no try passes, keeps the last: random words in several scripts, different on
every run (the library's default seed is random; the 20 clips gave 106, 78 and
98 insertions on three runs with run 4's chunking). Some pieces pass at greedy
with a fluent invention. With the sentence in the same window, Edda writes the
sentence and stops. Turning the fallback off makes it worse: greedy-only
decoding writes fluent sentences into such pieces ("Det er bare ikke, at det er
bare ikke at se.", "Hun har været uden at se på arbejde"), 103 insertions on the
20 clips against 52 with the fallback.

**What changed (run 5).** The fix is in the chunker: never give Edda a piece
without real speech.

- A pause ends a piece only with at least 1.5 s of speech (VAD) on each side of
  it. Less before it, and the stretch joins the next piece; less after it, and
  live the cut waits until that much speech has followed, so at the end a short
  rest joins the piece before it. The maximum-length rule (18 s) keeps the same
  condition and keeps a stretch whole up to 28 s (one window) rather than cut
  off a stretch past the maximum that has no speech.
- A piece in which the VAD found no speech at all is not decoded (only when the
  VAD heard speech elsewhere in the recording, so a quiet speaker it misses is
  still decoded).
- The cut-short check counts letters per second of speech: under 9, with more
  than 4 s of speech. Danish pieces come out at a median of 14 (1st percentile
  9.2) on 600 pieces of FLEURS single and joined clips; on the 200 the check now
  fires once instead of 40 times, which also spares those re-splits' decode time
  after release.
- Edda's pieces decode with a fixed sampling seed, so the same audio gives the
  same text and evaluations repeat exactly; the library's fallback recipe stays.

How the two thresholds were chosen (WER, substitutions / deletions /
insertions; the 20 clips, an evenly spread 200 of the 930, the joined clips with
0.3 s pauses, where Edda stops early most, and synthetic clips that end in a real
short phrase after a 0.8 s pause: FLEURS clips whose last 0.25 to 1 s, or 1 to
2 s, of sound was moved 0.8 s away from the rest):

| Speech on each side of a cut, cut-short check | 20 clips              | 200 clips              | 2 utt., 0.3 s pauses (100) | Last phrase 0.25-1 s (60) | Last phrase 1-2 s (32) |
| --------------------------------------------- | --------------------- | ---------------------- | -------------------------- | ------------------------- | ---------------------- |
| None, run 4's check (run 4)                   | 30.24 % (54/1/98)     | 7.94 % (206/72/68)     | 8.15 % (239/56/54)         | 11.14 % (100/19/32)       | 7.79 % (43/6/10)       |
| 1 s, run 4's check                            | 22.33 % (52/2/59)     | 7.58 % (207/70/53)\*   | 7.80 % (241/63/30)         | 8.70 % (86/18/14)\*       |                        |
| 1 s, no re-split                              | 18.38 % (47/4/42)\*   |                        | 8.62 % (236/107/26)        |                           |                        |
| 1 s, under 6 letters per second of speech     | 14.62 % (49/5/20)     | 7.37 % (210/74/37)     | 7.99 % (236/76/30)         |                           | 7.79 % (43/6/10)       |
| 1 s, under 9                                  | 15.02 % (49/5/22)     | 7.32 % (209/72/38)     | 7.94 % (242/68/30)         |                           |                        |
| 1 s, under 10                                 | 17.59 % (50/5/34)     |                        | 7.85 % (241/63/32)         |                           |                        |
| 1.5 s, under 6                                | 14.03 % (48/5/18)     | 7.25 % (206/73/37)     |                            | 8.48 % (84/19/12)         | 8.19 % (42/10/10)      |
| 2 s, under 6                                  | 13.24 % (46/6/15)     |                        |                            |                           | 7.40 % (36/15/5)       |
| **1.5 s, under 9, fixed seed (run 5)**        | **14.03 % (48/5/18)** | **7.25 % (206/73/37)** | **7.94 % (243/70/27)**     | **8.48 % (84/19/12)**     | **8.19 % (42/10/10)**  |

\* Without the no-speech rule and the maximum-length condition (an earlier
build). Each row is one run with the random seed, so small differences are
noise. A larger speech minimum removes more noise pieces but merges real short
phrases into the sentence before them, where greedy Edda sometimes stops at the
pause (2 s: 15 deletions against 6 on the 1-2 s phrases); 1.5 s is the
compromise. Without the re-split, joined sentences with 0.3 s pauses lose twice
the words; 9 letters per second keeps most of that and stays clear of ordinary
pieces.

**Results.** All 930 FLEURS da_dk test clips through the app built from
`50b750a1` (`wt-train eval --backend gguf`, `training/results.csv`):

| Path                                                     |        WER | 95 % CI      |    CER | Subst. | Del. | Ins. |
| -------------------------------------------------------- | ---------: | ------------ | -----: | -----: | ---: | ---: |
| Base Edda v0.2, Transformers float16 (run 4)             |     7.21 % | 6.66 to 7.78 | 2.61 % |  1,053 |  289 |  135 |
| App, file or phone dictation, run 4                      |     8.44 % | 7.84 to 9.05 | 3.42 % |  1,129 |  282 |  319 |
| **App, file or phone dictation, run 5**                  | **7.63 %** | 7.10 to 8.18 | 2.75 % |  1,105 |  290 |  168 |
| App, key recording (`--key-recording`), run 4's chunking |     8.24 % | 7.65 to 8.82 | 3.37 % |  1,102 |  299 |  287 |
| **App, key recording (`--key-recording`), run 5**        | **7.54 %** | 7.00 to 8.07 | 2.77 % |  1,085 |  302 |  159 |

The key-recording rows come from the same clips passed through the recorder's
VAD first (scored like `wt-train eval`; run 4's chunking is a run 5 build with
the speech minimum off, run 4's cut-short check and the random seed). The
recorder's silence removal alone does not fix it (287 insertions): it keeps
450 ms around anything it hears, so a noise after the sentence still arrives
after a pause. The app's interval now overlaps the float16 baseline's on both
paths. On the 20 clips the
insertions beyond the float16 run fall from 102 to 14 (WER 31.42 % to 14.03 %;
float16 9.09 %). Substitutions / deletions / insertions per clip, from the
930-clip runs:

| FLEURS clip          | Words | float16    | Run 4 app    | Run 5 app   | What run 4 invented, and where                           |
| -------------------- | ----: | ---------- | ------------ | ----------- | -------------------------------------------------------- |
| 2051415096147390912  |    21 | 2 / 1 / 0  | 2 / 0 / 13   | 3 / 2 / 0   | "der er af Svendås" four times (re-split)                |
| 16599102496662238901 |    21 | 2 / 1 / 0  | 3 / 0 / 11   | 2 / 1 / 0   | "Ang involves ... en stor betydning" (re-split)          |
| 7915212696696083057  |    18 | 1 / 1 / 0  | 3 / 0 / 11   | 2 / 1 / 1   | "Hrelsandet exclus Ayeet atthepắng ..." (noise after)    |
| 2502419634491081382  |    16 | 2 / 0 / 0  | 3 / 0 / 9    | 3 / 0 / 0   | "Tester en to tre fire fem seks syv otte." (noise after) |
| 4851889155600873884  |    21 | 1 / 0 / 0  | 2 / 0 / 6    | 1 / 0 / 0   | "uanstændigste regering i St. De havde" (re-split)       |
| 589359802683847315   |    53 | 4 / 0 / 0  | 7 / 0 / 5    | 7 / 0 / 2   | "Geo Spis af Fortis ... Conny Rostris" (re-split)        |
| 7407803414687478783  |    12 | 2 / 0 / 0  | 2 / 0 / 5    | 2 / 0 / 0   | "regering af Moss gik đólerne" (re-split)                |
| 13697487523436270226 |     8 | 1 / 0 / 0  | 2 / 0 / 4    | 1 / 0 / 0   | "R Penso Hadj Spark Qualquer." (noise before)            |
| 17340757067814297395 |    25 | 3 / 1 / 0  | 3 / 1 / 4    | 3 / 1 / 3   | "scrapedullah" (noise after), "et år siden" (both)       |
| 17525722700148894525 |    24 | 0 / 0 / 0  | 0 / 0 / 4    | 0 / 0 / 0   | "S!!!! to corn to" (noise after)                         |
| 10206519617373672484 |    17 | 1 / 0 / 0  | 1 / 0 / 3    | 1 / 0 / 0   | "Redeem's M" (noise after)                               |
| 1037714189972178176  |     9 | 0 / 0 / 0  | 0 / 0 / 3    | 0 / 0 / 0   | "vir haya as" (noise after)                              |
| 16073310946335797123 |    20 | 1 / 0 / 0  | 2 / 0 / 3    | 2 / 0 / 0   | "F T I R" for "(FTIR)"                                   |
| 16784563479963076732 |    15 | 2 / 1 / 0  | 4 / 0 / 3    | 4 / 0 / 3   | "S V A P O" for "(SWAPO)" (both)                         |
| 16788956687477097039 |    34 | 2 / 0 / 0  | 2 / 0 / 3    | 0 / 0 / 2   | numbers at a joint (both)                                |
| 3819249943536717398  |    33 | 0 / 0 / 0  | 1 / 0 / 3    | 0 / 0 / 0   | "og Chry" (noise after)                                  |
| 557199963716864611   |    45 | 6 / 1 / 2  | 6 / 0 / 5    | 6 / 0 / 5   | "er en lang rute" before a cut (both)                    |
| 577638229780910873   |    33 | 0 / 0 / 0  | 0 / 0 / 3    | 0 / 0 / 0   | "Burn bul nutr" (noise after)                            |
| 7055059421005981818  |    53 | 4 / 0 / 1  | 7 / 0 / 4    | 6 / 0 / 1   | "Giudspisa. Conni Rostris" (re-split)                    |
| 731573035460961798   |    28 | 2 / 0 / 1  | 2 / 0 / 4    | 5 / 0 / 1   | "G rides USB" (noise after)                              |
| **All 20**           |   506 | 36 / 6 / 4 | 52 / 1 / 106 | 48 / 5 / 18 |                                                          |

On the joined clips with recorded pauses, run 5 gives 6.96 % (218 / 49 / 31) on
2 utterances (run 4: 7.45 %, 212 / 45 / 62) and 7.12 % (155 / 68 / 11) on 3 (run
4: 7.70 %, 168 / 56 / 29). One of these 160 windows still loses a quarter of
its words, as in run 4, and none of the 100 with 0.3 s pauses.

**What is left** (0.42 points to the float16 run, 52 substitutions and 33
insertions more): a pause inside a sentence still ends a piece, and Edda then
sometimes finishes the sentence on its own ("ved afslutningen af et år siden.",
"som følge af en rute set er en lang rute."), or a word cut at a joint is written
as two ("lyd, redigering"); a joint where the next piece starts with digits can
come out with the numbers in words. These are the cost of decoding while the
user talks (DESK-46), not short pieces.

**DESK-46 after the change** (`walkietalkey --transcribe-file <wav> --live
--json`, release build, the 15.98 s and 120.02 s FLEURS dictations in
`_kit/work/bench`, runs interleaved, M1 Pro, 25 October 2026, with other jobs
on the machine: 1-minute load average 1.3 to 3.0):

| Build                  | Runs | Wait, 16 s (median) | Wait, 2 min (median) |  Difference |
| ---------------------- | ---: | ------------------: | -------------------: | ----------: |
| Run 4 (`63efb83d`)     |    3 |              1.05 s |               0.99 s |     -0.06 s |
| **Run 5 (`50b750a1`)** |    5 |          **1.03 s** |           **0.99 s** | **-0.04 s** |

The two-minute dictation waits no longer than the 16-second one, as before
(DESK-46: within 0.3 s). Both builds measure about 0.1 s slower on the short
clip than run 4 did on 23 October (0.92 s), on the same audio: the machine, not
the change.

The measurements (per-clip rows with every piece's range, speech and text, the
probe and its output) are in `_kit/work/runs/run5-short-pieces/`.

## Licence terms

### Ekko v1 Tiny: the layered licence, read in full

Files read: `MODEL_LICENSE.md`, `NOTICE`, `README.md` (model card),
`LICENSES/NVIDIA-OPEN-MODEL-LICENSE.pdf` (NVIDIA Open Model License Agreement,
version released 24 October 2025), `LICENSES/CC-BY-4.0.txt` (byte-identical to
Creative Commons' official legal code), `LICENSES/CORAL-LICENSE` (identical to
the licence of the CoRal-v3 dataset), `LICENSES/FTSPEECH-LICENSE.md`, and the two
Folketinget terms that statement points to (open data and TV, read from the
Internet Archive because ft.dk refuses automated requests), plus NVIDIA's
Trustworthy AI terms that the NVIDIA licence makes binding (section 2.3).

**What is allowed.** The NVIDIA Open Model License grants a perpetual,
worldwide, royalty-free licence to use, reproduce, modify, distribute (through
several tiers), sell and offer to sell the model and derivative models, and
states "Models are commercially usable" and "You are free to create and
distribute Derivative Models"; NVIDIA claims no rights in outputs. RyeAI's own
changes are CC BY 4.0, which allows any use including commercial. The CoRal
licence grants a perpetual, worldwide, royalty-free, irrevocable licence to
reproduce, sublicense and distribute the data and models trained on it, with
or without changes and as a hosted service. **Free use including commercial
use is allowed**, subject to the conditions below.

**Attribution duties.**

- NVIDIA 3.1: give every recipient a copy of the NVIDIA agreement and include
  "Licensed by NVIDIA Corporation under the NVIDIA Open Model License" in a
  "Notice" text file shipped with the copies (RyeAI's `NOTICE` has it).
- CC BY 4.0: credit RyeAI, link the licence, and say what we changed.
- CoRal 3(c) and 3(d): mark modified files as changed; keep all copyright and
  attribution notices.
- Folketinget open data: name "Folketinget" as the source; Folketinget TV:
  credit the source in accordance with good practice.

**What must travel with the model.** The NVIDIA agreement (PDF), the `NOTICE`
file, the CC BY 4.0 text, the CoRal licence (CoRal 3(b): "a copy of this
License" to every recipient), and the FT Speech statement with its two
Folketinget licences (the statement says the data "must always be accompanied
by this LICENSE statement and the two Folketing licenses"; RyeAI ships the
statement with the model). `models/ekko-v1-tiny/convert.sh` copies RyeAI's
bundle next to the converted file, and `models/release.sh` publishes it with
the model card.

**Restrictions.**

- CoRal use restrictions (Attachment A plus additions 4(a) and 4(b)): no
  impersonation, including synthetic speech that emulates or resembles a
  specific person; no detecting or inferring a person's identity or
  characteristics (name, address, gender, age, origin, health and others); no
  unlawful use, harm to minors, defamation, harassment, discrimination,
  disinformation intended to harm, deceptive impersonation, fully automated
  decisions that adversely affect a person's legal rights, and no
  machine-generated content "without expressly and intelligibly disclaiming
  that it is machine-generated" (Attachment A 3(a); see the owner's open points
  below). CoRal 3(a): these restrictions must be included **as an enforceable
  provision** in whatever licence governs our distribution of the model, and
  CoRal 4 requires us to make users comply. CoRal 6 lets the licensor restrict
  usage that violates the licence. The licence is void if the processing
  becomes unlawful. Danish law; mediation and arbitration in Aarhus.
- NVIDIA: rights end automatically if we sue anyone claiming the model
  infringes a copyright or patent, or if we bypass a guardrail in the model
  (it has none relevant to us); use must follow NVIDIA's Trustworthy AI terms
  (no use against the law, including illegal surveillance, illegal processing
  of biometric data, harassment or intentional deception); NVIDIA may update
  the agreement for legal or regulatory reasons, and we must then comply or
  stop distributing; we indemnify NVIDIA against third-party claims arising
  from our use or distribution; no NVIDIA trademarks beyond describing the
  origin; export-control compliance; Delaware law, courts in Santa Clara County.
- FT Speech: Folketinget's open data may be used commercially without limit,
  but Folketinget's TV licence forbids changing or building on its productions
  ("bygge videre på ... eller skabe bearbejdede værker"). Whether a model
  trained on the audio is such a work is the same open question as for Edda.

**Decision: allowed; offered as the fast model.** No clause forbids free or
commercial use of Ekko v1 Tiny inside a free, Apache-2.0 dictation app, so it
was converted, validated and measured, and the app's catalog offers it as the
fast model for slower computers (DESK-35; entry in
`src-tauri/src/walkietalkey/catalog.json`, generated from
`models/ekko-v1-tiny/catalog-entry.json`). Publishing the converted file waits
only on the same FT Speech decision as Edda (18.7); until then it is imported
with "Importér modelfil". The CoRal enforceable-provision duty
(3(a)) needs a sentence in the app's terms and the model card (drafted in
`models/ekko-v1-tiny/README.md`).

### Edda v0.2

The weights are released by the Alexandra Institute under Apache-2.0 (licence
text, notices, statement of changes; no use restrictions of its own). The base
model is OpenAI's Whisper large-v3-turbo under MIT, so OpenAI's copyright
notice travels with it (`models/edda/licenses/Whisper-MIT.txt`). Training data:
CoRal v3 (Alexandra Institute's CoRal licence, as above), FT Speech (1,690 of
2,605 hours), NST Danish (CC0), FLEURS (CC BY 4.0) and Common Voice 17 (CC0).
The Alexandra Institute licenses both Edda and CoRal; its Apache-2.0 release
of Edda does not mention the CoRal restrictions. We pass them on anyway
(model card and app terms), which costs nothing for a dictation app.

### Ekko PnC v2

CC BY 4.0 (RyeAI; base model `jonfd/electra-small-nordic`, CC BY 4.0), with the
CoRal restrictions incorporated into the model terms, and the FT Speech and NST
notices bundled. Training text included CoRal, FT Speech, NST and Wikipedia;
RyeAI's `NOTICE` says CoRal and FT Speech punctuation was restored by GPT-4o.
Credit in About and NOTICE (spec section 11). We mirror the files unchanged.

### Open decisions for the owner

- **18.7, FT Speech (open; not answered here).** About 1,690 of Edda's 2,605
  training hours are FT Speech. The FT Speech statement points to
  Folketinget's open-data terms (commercial use allowed, credit "Folketinget")
  and Folketinget's TV terms (sharing allowed, no changes, no building on the
  productions, no derived works); the FT Speech paper calls the corpus "freely
  available for research purposes only". Whether these terms limit use of
  model weights trained on it is for the owner to settle, by reading the
  terms (and NST's) and asking the Alexandra Institute, and to record here. It
  affects Edda, Ekko v1 Tiny and, through its training text, Ekko PnC. Until
  then nothing is uploaded; if the answer is no, the default falls back to
  the catalog's Whisper turbo or Parakeet V3 (spec section 11).
- **CoRal Attachment A 3(a), machine-generated content.** The CoRal licence
  forbids using models trained on CoRal "to generate or disseminate
  machine-generated information or content in any medium without expressly and
  intelligibly disclaiming that it is machine-generated". Dictation produces the
  user's own words, but a literal reading could reach transcribed text. Worth
  one question to the Alexandra Institute together with 18.7.
- **CoRal 3(a), enforceable provision.** WalkieTalkey's licence terms for the
  models (model cards, the app's licence screen) must state the CoRal use
  restrictions as binding conditions, not only mention them.
- **NVIDIA Open Model License** (Ekko v1 Tiny only): revocable on patent or
  copyright litigation, updatable by NVIDIA, with an indemnity in NVIDIA's
  favour and US jurisdiction. Acceptable for an optional fast model, but it is
  not an OSI open-source licence; the About screen should say so.

## Reproducing everything

From the repository root, with `WORK=<scratch folder>` (the run used
`_kit/work/`):

```bash
models/tools/setup-transcribe-cpp.sh "$WORK"        # transcribe.cpp 0.4.0, tarball SHA-256 pinned
models/edda/convert.sh "$WORK"                      # edda-v0.2-F16.gguf, edda-v0.2-Q8_0.gguf
models/ekko-v1-tiny/convert.sh "$WORK"              # ekko-v1-tiny-F32.gguf, ekko-v1-tiny-Q8_0.gguf
models/ekko-pnc/download.sh "$WORK/models-final/ekko-pnc"
models/eval/fetch_fleurs.sh "$WORK/datasets"
models/edda/validate.sh "$WORK" "$WORK/datasets/fleurs-da_dk"
models/ekko-v1-tiny/validate.sh "$WORK" "$WORK/datasets/fleurs-da_dk"
WT_WORK_DIR="$WORK" models/eval/run.sh              # WER and punctuation, all models
models/speed/run.sh "$WORK"                         # raw speed, Metal and CPU
WT_EKKO_PNC_DIR="$WORK/models-final/ekko-pnc" \
  cargo test -p ekko-pnc --manifest-path crates/ekko-pnc/Cargo.toml
python3 models/tools/check_manifest.py --dir "$WORK/models-final"
models/release.sh --dry-run --dir "$WORK/models-final"  # --yes-publish made models-v1
```

Re-running both conversions gave byte-identical files (same SHA-256 for
`edda-v0.2-F16`, `edda-v0.2-Q8_0`, `ekko-v1-tiny-F32` and `ekko-v1-tiny-Q8_0`).
On macOS with only the Command Line Tools, export
`SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` for C/C++ and Rust
builds (the default SDK's `.tbd` files are unreadable by the installed linker);
the scripts do this themselves.
