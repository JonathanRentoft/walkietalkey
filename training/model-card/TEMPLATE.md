---
license: apache-2.0
language:
  - da
base_model: "{{base_repo}}"
base_model_relation: finetune
pipeline_tag: automatic-speech-recognition
tags:
  - gguf
  - whisper
  - danish
  - lora
  - walkietalkey
---

# {{display_name}}

A personal fine-tune of **Edda v0.2** for WalkieTalkey, made on this Mac with the
fine-tuning workbench in `training/` (`wt-train export`). It is meant to get
English developer terms inside Danish speech right without getting worse at
plain Danish.

**Personal weights.** This model was trained on its owner's own voice
recordings. The weights can carry traces of that voice and of the sentences
read. They live only in this computer's WalkieTalkey models folder and are
never uploaded anywhere: not to Hugging Face, not to a release, not to a
shared drive.

## The file

|                 |                                                       |
| --------------- | ----------------------------------------------------- |
| File            | `{{file_name}}`                                       |
| Model id in app | `{{model_id}}`                                        |
| Size            | {{size_bytes}} bytes                                  |
| SHA-256         | `{{sha256}}`                                          |
| Format          | GGUF, Q8_0, transcribe.cpp {{transcribe_cpp_version}} |
| Made            | {{created}}                                           |

Decode it like Edda: language forced to Danish, segment timestamps off
(`transcribe-cli -m {{file_name}} -l da --timestamps none clip.wav`). The app
does this for every model id that starts with `edda-`.

## How it was made

1. **Training run** `{{run_name}}`: LoRA adapters on Edda v0.2
   (`{{base_repo}}` at revision `{{base_revision}}`), trained with Hugging Face
   Transformers and PEFT. Config `{{config_source}}`, hash `{{config_hash}}`.
   Key settings: `{{lora_knobs}}`.
2. **Data**: {{takes_train}} of the owner's takes for training,
   {{rehearsal_train}} FLEURS da_dk train clips mixed in as plain-Danish
   rehearsal, validation on {{validation_clips}} clips. Splits by sentence,
   checked for leakage; FLEURS da_dk test was never trained on.
3. **Best epoch** {{best_epoch}} by validation WER: {{validation_wer}} %
   (the untouched base model: {{baseline_validation_wer}} %).
4. **Merge** of the adapters into the base weights (float16), **conversion**
   to GGUF with transcribe.cpp's own `scripts/convert-whisper.py` (only the
   name metadata added: `general.name` "{{display_name}}", `stt.variant`
   "{{model_id}}"), and **quantisation** to Q8_0 with `transcribe-quantize`.
5. **Same-text check**: on {{verify_n}} validation clips the GGUF
   (transcribe-cli, Danish, timestamps off) gave the merged model's text
   exactly on {{verify_exact}} and after normalisation on
   {{verify_normalized}}.

Scores on the owner's test split and on FLEURS da_dk test are in
`training/results.csv` (`wt-train eval`).

## Credit and licence

- **This fine-tune**: Copyright 2026 Jonathan Rentoft and the WalkieTalkey
  contributors, made with the WalkieTalkey fine-tuning workbench, under the
  Apache License 2.0.
- **Edda v0.2** by the Alexandra Institute (CoRal project), released by Danish
  Foundation Models under the Apache License 2.0. This file is a derivative of
  its weights and carries the same licence.
- **Whisper large-v3-turbo** by OpenAI, the architecture and the original
  weights Edda was fine-tuned from: MIT licence, Copyright (c) 2022 OpenAI.
- **transcribe.cpp** (MIT) converted and quantised it.

## Training data terms

Edda's training data: CoRal v3 (read aloud and conversation), FT Speech, NST
Danish, FLEURS and Common Voice 17 (Danish). Their terms reach this fine-tune
as they reach Edda:

- **CoRal** (Alexandra Institute; CoRal licence): models trained on the data
  are "Adapted Material", and its use restrictions must travel with them as
  enforceable terms. **They apply to this file.** You may not use the model,
  or its output, to impersonate a person, including creating synthetic speech
  that emulates or resembles a specific person's voice; to detect or infer a
  person's identity or characteristics (name, gender, age, origin, health and
  so on); or for any other use listed in Attachment A of that licence
  (unlawful use, harming minors, discrimination, harassment, disinformation,
  deceptive impersonation, undisclosed machine-generated content, and fully
  automated decisions that adversely affect a person's legal rights).
  Dictation and transcription are fine.
- **FT Speech** (Folketinget recordings): its statement points to
  Folketinget's open-data terms (free use including commercial, with
  "Folketinget" credited as source) and Folketinget's TV terms (sharing
  allowed; no editing, no building on the productions). The FT Speech paper
  describes the corpus as "freely available for research purposes only".
  **Whether these terms limit use of weights trained on it is an open
  question for companies' use**, recorded as decision 18.7 in WalkieTalkey's
  `docs/MODELS.md`. It stays open; personal use is not affected.
- **NST Danish** (CC0 1.0), **Common Voice** (CC0 1.0) and **FLEURS**
  (CC BY 4.0, Google; also the rehearsal data of this fine-tune): no
  restriction on the trained model.
