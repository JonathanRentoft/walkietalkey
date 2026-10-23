# Models

What WalkieTalkey runs, where each file comes from, how it was checked, and the
licence terms behind it. Milestone M0 (spec section 16): DESK-29 to DESK-35,
DESK-41, DESK-43, OSS-24. Measured on 23 October 2026 on the owner's 16-inch
MacBook Pro (Apple M1 Pro, 32 GB, macOS 26.6).

| Model | Role | Engine | File we ship | Licence | Status |
|---|---|---|---|---|---|
| Edda v0.2 (Alexandra Institute) | Danish speech recognition, default (DESK-30) | transcribe.cpp 0.4 | `edda-v0.2-Q8_0.gguf`, 886 MB | Apache-2.0 + CoRal restrictions | Converted and validated; publishing waits on decision 18.7 |
| Ekko v1 Tiny (RyeAI) | Fast model for slow PCs (DESK-35) | transcribe.cpp 0.4 | `ekko-v1-tiny-Q8_0.gguf`, 134 MB | NVIDIA Open Model License + CC BY 4.0 + CoRal restrictions | Licence allows it; converted and validated; same FT Speech question as Edda |
| Ekko PnC v2 (RyeAI) | Punctuation and capitalisation (DESK-41) | ONNX Runtime via `crates/ekko-pnc` | `pnc.int8.onnx` + `tokenizer.json` + `config.json`, 25 MB | CC BY 4.0 + CoRal restrictions | Rust port reproduces the reference exactly |
| Silero VAD v6.2 | Voice activity detection | transcribe.cpp 0.4 | bundled in the app | MIT | Unchanged from Handy |
| Whisper large-v3-turbo (OpenAI, Handy's GGUF) | Baseline for comparison, "Andre modeller" (DESK-34) | transcribe.cpp 0.4 | Handy's catalog file | MIT | Unchanged from Handy |

Every file the app downloads or bundles is listed with size and SHA-256 in
[`models/manifest.json`](../models/manifest.json) (DESK-32), with a path below
`https://huggingface.co/walkietalkey/`. A company's `ModelBaseUrl` (Appendix B)
replaces that base and must serve the same paths.

## Decode Edda with timestamps off

Edda was fine-tuned on `<|da|><|transcribe|><|notimestamps|>` sequences only.
transcribe.cpp's default `TimestampKind::Auto` (which stock Handy uses) always
runs Whisper models with segment timestamps, and then Edda drops or cuts the
first words of a window ("Dette er en vigtig måde ..." becomes "er en vigtig
måde ..."). This is the model, not the engine: the original Transformers model
with `return_timestamps=True` drops or cuts leading words on 6 of 10 test clips
and lower-cases the first word on 3 more. With `TimestampKind::None` the GGUF
matches the original exactly (below). The GGUF metadata cannot switch this off
(`Auto` resolves to segment timestamps for every Whisper file), so the app must
pass `TimestampKind::None` for Edda; `models/manifest.json` records it as the
model's `runOptions`, and the draft catalog entry sets `timestamps: false`.

## Edda v0.2: conversion and validation (DESK-29)

- **Conversion.** transcribe.cpp 0.4.0 (the release Handy links;
  `scripts/convert-whisper.py`, then `transcribe-quantize --quant Q8_0`). A
  wrapper only registers the name ("Edda v0.2", variant `edda-v0.2`); the
  weights, vocabulary and configuration go through the upstream converter
  unchanged. The GGUF header has the same keys and the same 589 tensors as
  Handy's own Whisper turbo file, so stock Handy lists it from its custom
  models folder as "Edda v0.2".
- **transcribe.cpp's Whisper gate** (`validate.py all --family whisper`, F16 GGUF on
  CPU against Transformers 5.6.1 fp32, cases: two Danish FLEURS clips and
  `jfk.wav`). The Danish transcripts match the reference **exactly**. Neither
  Edda nor stock turbo stays inside transcribe.cpp's published tolerance budget
  on this machine (the budget was calibrated on jfk only, on another machine),
  so the same pipeline was run on stock `openai/whisper-large-v3-turbo` with
  Handy's F16 GGUF as a control:

  | Case | Tensors within budget: Edda | Turbo (control) | Worst max_abs: Edda | Turbo |
  |---|---:|---:|---:|---:|
  | FLEURS 6263195548503774343 (da) | 13/22 | 12/22 | 7.51 (`enc.block.31.out`) | 11.5 |
  | FLEURS 17924706686437869147 (da) | 12/22 | 11/22 | 12.7 (`enc.block.31.out`) | 14.2 |
  | jfk (en) | 15/22 | 14/22 | 2.4 (`enc.block.31.out`) | 7.17 |

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
publishes (Handy's catalog ships Q8_0 for its 110M Parakeet too); RyeAI's own
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
  through the same Rust core (`tokenizers` 0.22.2) with pre-tokenised input;
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
  1.24.2, what Handy last shipped) 6 near-tie words in 3 long inputs came out
  differently, and the Python reference itself gives exactly the same 6
  differences on onnxruntime 1.24.2; on 1.28.0 it matches the reference's 1.29.0
  on every input, and on 1.31.0 it differs again (3 words). The crate therefore
  pins **`ort` =2.0.0-rc.13 (ONNX Runtime 1.28.0)**. Any API-17+ runtime works;
  only the exact golden match needs 1.28/1.29.
- **Targets.** `cargo check` passes for `aarch64-apple-darwin` (pyke's prebuilt
  static ONNX Runtime, default feature), `x86_64-pc-windows-msvc` (prebuilt) and
  `x86_64-apple-darwin` with `--features load-dynamic`. pyke ships no
  `x86_64-apple-darwin` binary and Microsoft stopped publishing Intel macOS
  builds after 1.23, so Intel Macs need an ONNX Runtime built for them (Handy
  hosted its own 1.24.2) linked with `ORT_LIB_LOCATION` +
  `ORT_PREFER_DYNAMIC_LINK=1`, or loaded at run time (`load-dynamic`). On
  Windows, Handy linked Microsoft's baseline `onnxruntime.dll` dynamically
  because pyke's static Windows build has an AVX2 initialiser that crashes on
  pre-Haswell CPUs; the same applies here (use the 1.28.0 release).
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
from the original, Handy's Whisper turbo Q8_0 checked against the catalog's
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
  hundrede tusind", "3,5" becomes "tre komma fem", a lone 1100 to 1999 is read as
  a year, "nitten hundrede og seksoghalvfjerds", other integers as cardinals,
  "%" becomes "procent"); every character that is not a letter or digit becomes
  a space (punctuation, hyphens, quotes); "tusinde"/"tusind", "én"/"en" and "et
  hundrede"/"hundrede" folded; whitespace collapsed. WER is the corpus total of
  substitutions, deletions and insertions over reference words (Levenshtein),
  with a 95 % bootstrap interval over clips. Known limits: ordinals ("5. maj"
  reads as "fem maj"), clock times ("10.30" reads as a decimal) and
  abbreviations ("f.eks.") are not folded.
- **Punctuation measure** (`wt_eval/punctuation.py`, on the raw hypothesis):
  marks are `. , ? ! ; :` except a mark between two digits ("3,5", "800.000");
  words are whitespace-separated tokens. Reported as marks per 25 words over the
  whole set, and the share of clips with fewer than 1 mark per 25 words, which
  is exactly the DESK-41 trigger (`marks * 25 < words`, never for empty text).

<!-- WER -->

<!-- SPEED -->

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
bundle next to the converted file, and `models/upload.sh` uploads it with the
model card.

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

**Decision: allowed, converted, not yet shipped.** No clause forbids free or
commercial use of Ekko v1 Tiny inside a free, Apache-2.0 dictation app, so it
was converted, validated and measured, and a catalog entry is ready
(`models/ekko-v1-tiny/catalog-entry.json`). Shipping it waits only on the same
FT Speech decision as Edda (18.7). The CoRal enforceable-provision duty
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
  Handy's Whisper turbo or Parakeet V3 (spec section 11).
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
models/tools/check_manifest.py --dir "$WORK/models-final"
models/upload.sh --dry-run --dir "$WORK/models-final"   # the real upload is not run
```

Re-running both conversions gave byte-identical files (same SHA-256 for
`edda-v0.2-F16`, `edda-v0.2-Q8_0`, `ekko-v1-tiny-F32` and `ekko-v1-tiny-Q8_0`).
On macOS with only the Command Line Tools, export
`SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk` for C/C++ and Rust
builds (the default SDK's `.tbd` files are unreadable by the installed linker);
the scripts do this themselves.
