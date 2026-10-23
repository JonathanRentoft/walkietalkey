---
license: cc-by-4.0
language:
- da
base_model: RyeAI/ekko-pnc
pipeline_tag: token-classification
tags:
- onnx
- punctuation-restoration
- truecasing
- danish
- walkietalkey
---

# Ekko PnC v2 (mirror)

DRAFT (spec DESK-33). Not uploaded yet.

An unchanged copy of the runtime files of **Ekko PnC v2** by RyeAI, the Danish
punctuation and capitalisation model WalkieTalkey runs locally when dictated
text has fewer than one punctuation mark per 25 words (DESK-41). It is mirrored
so that the app downloads every model file from one place, or from a company's
own server (`ModelBaseUrl`).

## Original and changes

| | |
|---|---|
| Model | [`RyeAI/ekko-pnc`](https://huggingface.co/RyeAI/ekko-pnc) at revision `d3129544e4e0155093e192cac58a9e69a4dea1ff` (the revision the reference runtime `ekko-stt` 0.1.2 pins) |
| Author | RyeAI; base model `jonfd/electra-small-nordic` (CC BY 4.0) |
| Changes | **None.** `pnc.int8.onnx`, `tokenizer.json` and `config.json` are byte-identical to RyeAI's files, with RyeAI's licence bundle |

| File | Size | SHA-256 |
|---|---:|---|
| `pnc.int8.onnx` | 22,424,741 bytes | `46bb979d409731872f10b6cb71298594595f16368d2aec2fcaf94d87b4266527` |
| `tokenizer.json` | 2,301,084 bytes | `a1e0d43ee307ad7a1ccc23e6e5398d877a68ca7f576067ac507625a0d50e9502` |
| `config.json` | 1,062 bytes | `dc655c46f69eeb15dd43786ad58fb5862cc794b36cc9d2c426ab5bc4b01f23ca` |

## Licence

CC BY 4.0 (`LICENSES/CC-BY-4.0.txt`), as RyeAI publishes it (`MODEL_LICENSE.md`,
`NOTICE`). The CoRal use restrictions (`LICENSES/CORAL-LICENSE`, section 4 and
Attachment A) are part of the model terms: no impersonation or synthetic speech
emulating a person, no inferring a person's identity or characteristics, and the
other listed uses. Training text included FT Speech and NST; their notices are
bundled (`LICENSES/FTSPEECH-LICENSE.md`, `LICENSES/CC0-1.0.txt`). RyeAI's
`NOTICE` states that CoRal and FT Speech punctuation used in training was
restored by GPT-4o (Azure OpenAI).

## Using it

WalkieTalkey runs it with `crates/ekko-pnc`, a Rust port of the reference
runtime that reproduces `ekko-stt` 0.1.2 exactly on a 52-input golden set
(128-token windows, 12 words of overlap).

## Credit

Ekko PnC v2 by RyeAI, CC BY 4.0, derived from jonfd/electra-small-nordic
(CC BY 4.0).
