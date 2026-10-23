---
license: other
license_name: nvidia-open-model-license
license_link: LICENSES/NVIDIA-OPEN-MODEL-LICENSE.pdf
language:
- da
base_model: RyeAI/ekko-v1-tiny
base_model_relation: quantized
pipeline_tag: automatic-speech-recognition
tags:
- gguf
- parakeet
- rnnt
- danish
- speech-recognition
- transcribe.cpp
- walkietalkey
---

# Ekko v1 Tiny, GGUF for transcribe.cpp

DRAFT (spec DESK-33). Not uploaded: like Edda it was trained on FT Speech, so
publishing waits on the owner's decision about those terms (decision 18.7).

**Ekko v1 Tiny** by RyeAI, a 110M-parameter Danish FastConformer RNN-T,
converted to GGUF for [transcribe.cpp](https://github.com/handy-computer/transcribe.cpp)
and quantised to Q8_0. WalkieTalkey offers it as the fast model for computers
without a usable GPU (DESK-35). Its output is lower-case without punctuation;
WalkieTalkey always runs Ekko PnC after it.

## Original

| | |
|---|---|
| Model | [`RyeAI/ekko-v1-tiny`](https://huggingface.co/RyeAI/ekko-v1-tiny) at revision `3658535e7b2fa98d5d9aad8114573c0fab1e6203` (`ekko-v1-tiny.nemo` SHA-256 `c48614a2118bb634dc97a1497e3702940153e6db4d16b72f175a3ab94a06cece`) |
| Author | RyeAI |
| Base model | `nvidia/parakeet-rnnt-110m-da-dk`, NVIDIA Open Model License |
| Architecture | FastConformer encoder (17 layers, 512-d) with an RNN-T decoder, 44-token vocabulary |

## Licence

Layered, as RyeAI publishes it (`MODEL_LICENSE.md`):

- The model is a Derivative Model of NVIDIA's `parakeet-rnnt-110m-da-dk` and is
  distributed under the **NVIDIA Open Model License**
  (`LICENSES/NVIDIA-OPEN-MODEL-LICENSE.pdf`). Licensed by NVIDIA Corporation
  under the NVIDIA Open Model License (see `NOTICE`).
- RyeAI's own modifications are under **CC BY 4.0** (`LICENSES/CC-BY-4.0.txt`).
- **CoRal** use restrictions (`LICENSES/CORAL-LICENSE`) apply in addition: no
  impersonation or synthetic speech emulating a person, no detecting or
  inferring a person's identity or characteristics, and the other uses listed
  in Attachment A of that licence. Dictation and transcription are fine.
- **FT Speech** statement (`LICENSES/FTSPEECH-LICENSE.md`): see WalkieTalkey's
  `docs/MODELS.md`; the same open question as for Edda.

## What we changed

The weights are RyeAI's. We changed their file format and precision:

1. **Conversion** of the `.nemo` checkpoint to a GGUF file at its original
   precision (F32) with transcribe.cpp 0.4.0's `scripts/convert-parakeet.py`.
   The converter selects a variant profile by name; we added one for this model
   (identity, Danish only, its licence) and changed nothing in the conversion.
2. **Quantisation** to Q8_0 with transcribe.cpp 0.4.0's `transcribe-quantize`.

Reproducible with `models/ekko-v1-tiny/convert.sh` in the
[WalkieTalkey repository](https://github.com/JonathanRentoft/walkietalkey).

## Files

| File | Size | SHA-256 |
|---|---:|---|
| `ekko-v1-tiny-Q8_0.gguf` | 133,940,896 bytes | `ccb40917c85575a6045b63e97896b882d778de1632bd99296dd94a6dc4039a1d` |

The F32 reference file (451,397,472 bytes, SHA-256
`80c5c1b825b23143374ec18381c5709107433f9b65e9aff593d09f9712f7487b`) is not
published; `convert.sh` rebuilds it.

## Validation

`models/ekko-v1-tiny/validate.sh`: transcribe.cpp's Parakeet gate
(`scripts/validate.py all --family parakeet`) against NeMo (fp32) on two Danish
FLEURS clips: both transcripts match NeMo **exactly**; 14 of 16 and 15 of 16
tensors are inside transcribe.cpp's Parakeet tolerances. The one tensor outside
on both clips is `enc.block.16.out`, which in this 17-layer model is the
encoder output itself and is inside the `enc.final` budget; `enc.block.8.out`
exceeds its max_abs budget on one clip with its mean inside. F32 and Q8_0
give the same text on both clips.

## Accuracy

FLEURS da_dk test (930 clips), Q8_0, Danish, WalkieTalkey's normaliser (lower
case, punctuation stripped, numbers as spoken): **10.11 % WER** (95 % CI 9.47 to
10.76). RyeAI reports 9.36 % with its own normalisation. Speed on an Apple M1 Pro
CPU: 0.09 s for 10 s of speech, 0.35 s for 35 s.

## Credit

Ekko v1 Tiny by RyeAI, derived from NVIDIA's parakeet-rnnt-110m-da-dk.
Licensed by NVIDIA Corporation under the NVIDIA Open Model License. Converted
with transcribe.cpp (MIT). GGUF conversion and quantisation by the WalkieTalkey
project.
