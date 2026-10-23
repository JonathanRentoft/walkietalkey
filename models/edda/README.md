---
license: apache-2.0
language:
  - da
base_model: danish-foundation-models/edda-v0.2
base_model_relation: quantized
pipeline_tag: automatic-speech-recognition
tags:
  - gguf
  - whisper
  - danish
  - speech-recognition
  - transcribe.cpp
  - walkietalkey
---

# Edda v0.2, GGUF for transcribe.cpp

DRAFT (spec DESK-33). Not uploaded: publishing waits on the owner's decision
about the FT Speech terms (see "Training data terms" below).

Danish speech recognition model **Edda v0.2** by the Alexandra Institute,
converted to GGUF for [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)
and quantised to Q8_0. It is the default speech model of WalkieTalkey, free
open-source Danish dictation, and loads in any app built on transcribe.cpp 0.4
or newer (for example Handy, from its custom models folder).

## Original

|                        |                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                  | [`danish-foundation-models/edda-v0.2`](https://huggingface.co/danish-foundation-models/edda-v0.2) at revision `698f8d04b5970f963d31c4079c05a76fa7f4f5bb` (`model.safetensors` SHA-256 `84f31719f0a26ea774a9d4470f0a54fecf807afef6ac6fb04291cd2dabe40e4c`) |
| Author                 | Alexandra Institute, CoRal project; released by Danish Foundation Models                                                                                                                                                                                  |
| Architecture           | Whisper large-v3-turbo (809M parameters, 32 encoder and 4 decoder layers), fully fine-tuned on about 2,600 hours of Danish                                                                                                                                |
| Base model             | [`openai/whisper-large-v3-turbo`](https://huggingface.co/openai/whisper-large-v3-turbo), MIT licence, Copyright (c) 2022 OpenAI (`LICENSES/Whisper-MIT.txt`)                                                                                              |
| Licence of the weights | Apache License 2.0 (`LICENSE`)                                                                                                                                                                                                                            |

## What we changed

The weights are Edda's. We changed their file format and precision, nothing else:

1. **Conversion** to a GGUF file at the original precision (F16) with
   transcribe.cpp 0.4.0's own `scripts/convert-whisper.py`. The only input we
   added is the model's name in the file metadata (`general.name` "Edda v0.2",
   `stt.variant` "edda-v0.2"); the converter does not recognise fine-tunes by
   name otherwise. No layer, vocabulary or configuration was changed.
2. **Quantisation** of that file to Q8_0 (8-bit) with transcribe.cpp 0.4.0's
   `transcribe-quantize`. This is lossy; see "Validation" for what it changes.

Both steps are reproducible from the original with `models/edda/convert.sh` in
the [WalkieTalkey repository](https://github.com/JonathanRentoft/walkietalkey).

## Files

| File                  |              Size | SHA-256                                                            |
| --------------------- | ----------------: | ------------------------------------------------------------------ |
| `edda-v0.2-Q8_0.gguf` | 886,381,920 bytes | `63ac884ad3d436642e8599ed3bda6c2b3456a0bb939a497c796589dee3f3b18d` |

The F16 reference file (1,625,935,680 bytes, SHA-256
`800406ef00ab1e5ae1298eab444aba506db5af27d79119604bb9bd016c34e193`) is not
published; `convert.sh` rebuilds it.

## How to run it

Force Danish and **turn segment timestamps off**:

```bash
transcribe-cli -m edda-v0.2-Q8_0.gguf -l da --timestamps none clip.wav
```

In code, `RunOptions { language: Some("da"), timestamps: TimestampKind::None, .. }`.
Edda was fine-tuned on `<|notimestamps|>` sequences only. With Whisper's
segment timestamps (transcribe.cpp's default `auto`) it drops or cuts the
first words of a window. The original Transformers model does the same with
`return_timestamps=True`: on 10 test clips it dropped or cut leading words on
6 and lower-cased the first word on 3 more. The model has no punctuation
of its own for parliamentary-style speech (most of its training audio has
lower-case, unpunctuated transcripts); WalkieTalkey adds punctuation with Ekko
PnC when a text has fewer than one mark per 25 words.

## Validation

Checked on this conversion before anything else (`models/edda/validate.sh`):

- **transcribe.cpp's own Whisper gate** (`scripts/validate.py all --family whisper`):
  the F16 GGUF on CPU against the Transformers 5.6.1 reference (fp32),
  tensor by tensor, on two Danish FLEURS clips and transcribe.cpp's `jfk.wav`.
  The Danish transcripts match the reference **exactly**. Stock
  `openai/whisper-large-v3-turbo` (Handy's official F16 GGUF) run through the
  identical pipeline on the same machine exceeds transcribe.cpp's published
  tolerance budget on the same tensors (the budget was calibrated on another
  machine); Edda stays within it on as many tensors or more on every case, and
  with smaller worst-case drift. On the English `jfk.wav` one word differs
  ("country" against the reference's "county"; Edda is a Danish model).
- **Same text as the original** on 10 real Danish clips (FLEURS): Q8_0 on
  Metal, Q8_0 on CPU and F16 on CPU give exactly the original model's text on
  10 of 10 clips (Transformers greedy, timestamps off).
- **Q8_0 against F16** (`scripts/quant_accuracy.py`, diagnostic): identical
  transcript; 47 of 49 activation dumps inside transcribe.cpp's starting Q8_0
  bands (the two others: `enc.final` max 6.5 % relative, mean 1.6 %).

## Accuracy

FLEURS da_dk test (930 clips), language forced to Danish, greedy decoding, our
normaliser (lower case, punctuation stripped, numbers as spoken Danish):

| Model                                       |         WER (95 % CI) |
| ------------------------------------------- | --------------------: |
| Edda v0.2 Q8_0, timestamps off              | 7.17 % (6.64 to 7.74) |
| Edda v0.2 Q8_0, timestamps on               |               14.54 % |
| Whisper large-v3-turbo Q8_0, for comparison |               13.06 % |

**One utterance per window.** Decoded greedily (transcribe.cpp has no beam
search), Edda tends to end its transcript at the first sentence boundary in a
window: on windows of two or three FLEURS sentences its WER rises to 15 to 22 %,
almost all deletions, and the original Transformers model does the same.
Cutting the audio at pauses (Silero VAD) and decoding each speech segment on its
own brings it back to about 10 %. Feed it one utterance per window.

Edda was trained on FLEURS da_dk _train_; the test split is held out but is in
its domain. The original's own result on this test set is 7.34 % WER (beam
search with 5 beams, leaderboard normalisation).

## Training data terms

Edda's training data: CoRal v3 (read aloud and conversation), FT Speech, NST
Danish, FLEURS and Common Voice 17 (Danish). Their terms, as far as they reach
a model trained on them:

- **CoRal** (Alexandra Institute; `LICENSES/CORAL-LICENSE`): models trained on
  the data are "Adapted Material", and its use restrictions must travel with
  them as enforceable terms. **They apply to these files.** You may not use the
  model, or its output, to impersonate a person, including creating synthetic
  speech that emulates or resembles a specific person's voice; to detect or
  infer a person's identity or characteristics (name, gender, age, origin,
  health and so on); or for any other use listed in Attachment A of that
  licence (unlawful use, harming minors, discrimination, harassment,
  disinformation, deceptive impersonation, undisclosed machine-generated
  content, and fully automated decisions that adversely affect a person's
  legal rights). Dictation and transcription are fine.
- **FT Speech** (Folketinget recordings; `LICENSES/FTSPEECH-LICENSE.md`): its
  statement points to Folketinget's open-data terms (free use including
  commercial, with "Folketinget" credited as source) and Folketinget's TV terms
  (sharing allowed; no editing, no building on the productions). The FT Speech
  paper describes the corpus as "freely available for research purposes only".
  **Whether these terms limit use of weights trained on it is an open
  question**, recorded as the owner's decision 18.7 in WalkieTalkey's
  `docs/MODELS.md`. These files are not published until it is answered.
- **NST Danish** (CC0 1.0), **Common Voice** (CC0 1.0) and **FLEURS**
  (CC BY 4.0, Google): no restriction on the trained model.

## Credit

Edda v0.2 by the Alexandra Institute (CoRal project), released by Danish
Foundation Models under Apache-2.0. Based on OpenAI's Whisper large-v3-turbo
(MIT). Converted with transcribe.cpp (MIT). GGUF conversion and quantisation by
the WalkieTalkey project.
