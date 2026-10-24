"""Edda (a Whisper large-v3-turbo) the way it was trained and the way the app runs it.

* **Labels.** Edda was fine-tuned on ``<|notimestamps|>`` sequences only, so a
  training example is exactly
  ``<|startoftranscript|><|da|><|transcribe|><|notimestamps|> text <|endoftext|>``,
  with the text tokenised without a leading space (as Edda generates it). The
  decoder reads the sequence without its last token and predicts it shifted by
  one; the loss covers only the text tokens and the closing ``<|endoftext|>``,
  never the fixed prompt.
* **Decoding** is greedy, timestamps off, language forced to Danish, task
  transcribe: Transformers' Whisper ``generate`` with the generation config's
  token suppression, the same reference models/edda/same_text.py checks the
  GGUF against.
* **The encoder in two parts.** ``encoder_bottom`` runs the convolutions,
  positions and the first ``stop`` layers; ``encoder_top`` runs the remaining
  layers and the final layer norm. Together they equal the encoder's own
  forward. With the encoder frozen, the bottom (all layers) and top (only the
  norm) are computed once and cached; with the top N layers adapted, the bottom
  32 - N layers are cached and the top runs every step.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

LANGUAGE = "da"
TASK = "transcribe"
IGNORE = -100


@dataclass(frozen=True)
class Tokens:
    """Whisper's special tokens and its text tokenizer."""

    sot: int
    lang: int
    task: int
    notimestamps: int
    eot: int
    encode: Callable[[str], list[int]]
    decode: Callable[[list[int]], str]

    @property
    def prompt(self) -> list[int]:
        return [self.sot, self.lang, self.task, self.notimestamps]


def tokens_from_tokenizer(tokenizer, language: str = LANGUAGE) -> Tokens:
    ids = tokenizer.convert_tokens_to_ids(
        ["<|startoftranscript|>", f"<|{language}|>", f"<|{TASK}|>", "<|notimestamps|>", "<|endoftext|>"])
    return Tokens(
        sot=ids[0], lang=ids[1], task=ids[2], notimestamps=ids[3], eot=ids[4],
        encode=lambda text: tokenizer.encode(text, add_special_tokens=False),
        decode=lambda token_ids: tokenizer.decode(token_ids, skip_special_tokens=True).strip(),
    )


def example(tokens: Tokens, text: str, max_positions: int = 448) -> tuple[list[int], list[int]]:
    """(decoder input ids, labels) for one transcript; see the module docstring."""
    sequence = tokens.prompt + tokens.encode(text) + [tokens.eot]
    if len(sequence) > max_positions:
        raise ValueError(f"transcript is {len(sequence)} tokens, Whisper holds {max_positions}: {text[:60]!r}")
    inputs = sequence[:-1]
    labels = sequence[1:]
    # inputs[i] predicts labels[i]; the first len(prompt) - 1 targets are the fixed prompt.
    fixed = len(tokens.prompt) - 1
    labels = [IGNORE] * fixed + labels[fixed:]
    return inputs, labels


def collate(examples: list[tuple[list[int], list[int]]], pad_id: int):
    """Right-padded (input ids, labels) tensors. Padding is never attended to by
    the real tokens (the decoder is causal) and is ignored by the loss."""
    import torch

    width = max(len(i) for i, _ in examples)
    inputs = torch.full((len(examples), width), pad_id, dtype=torch.long)
    labels = torch.full((len(examples), width), IGNORE, dtype=torch.long)
    for row, (i, lab) in enumerate(examples):
        inputs[row, : len(i)] = torch.tensor(i)
        labels[row, : len(lab)] = torch.tensor(lab)
    return inputs, labels


# --- the model ---------------------------------------------------------------


def pick_device(preference: str = "auto") -> str:
    import torch

    if preference == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("device mps requested but PyTorch reports no MPS device")
    if preference in ("mps", "cpu"):
        return preference
    return "mps" if torch.backends.mps.is_available() else "cpu"


def inference_dtype(device: str):
    """fp16 on the Apple GPU (Edda's own precision), fp32 on the CPU."""
    import torch

    return torch.float16 if device == "mps" else torch.float32


@dataclass
class Base:
    """A Whisper checkpoint on disk with its front end and tokens."""

    path: Path
    repo: str
    revision: str
    feature_extractor: object
    tokens: Tokens

    def load(self, dtype, device: str):
        from transformers import WhisperForConditionalGeneration

        model = WhisperForConditionalGeneration.from_pretrained(self.path, dtype=dtype)
        # SpecAugment would mask input features in training mode; the workbench
        # trains on fixed (cached) encoder outputs, so it is off everywhere.
        model.config.apply_spec_augment = False
        return model.to(device).eval()

    def feature_settings(self) -> dict:
        fe = self.feature_extractor
        keys = ("feature_size", "sampling_rate", "hop_length", "n_fft", "chunk_length", "n_samples",
                "nb_max_frames", "padding_value", "dither")
        return {k: getattr(fe, k, None) for k in keys}


def load_base(repo: str, revision: str, path: Path | None = None) -> Base:
    """The base checkpoint, downloaded into the work folder when missing."""
    from transformers import WhisperProcessor

    from .hub import model_snapshot

    path = Path(path) if path is not None else model_snapshot(repo, revision)
    processor = WhisperProcessor.from_pretrained(path)
    return Base(path=path, repo=repo, revision=revision, feature_extractor=processor.feature_extractor,
                tokens=tokens_from_tokenizer(processor.tokenizer))


def features(feature_extractor, pcms: list[np.ndarray]) -> np.ndarray:
    """Log-mel features [batch, mels, frames], padded to the model's window."""
    out = feature_extractor(pcms, sampling_rate=feature_extractor.sampling_rate, return_tensors="np")
    return out["input_features"].astype(np.float32)


def encoder_bottom(encoder, input_features, stop: int):
    """Convolutions, positions and layers [0, stop) of a Whisper encoder."""
    import torch
    from torch import nn

    x = nn.functional.gelu(encoder.conv1(input_features))
    x = nn.functional.gelu(encoder.conv2(x))
    x = x.permute(0, 2, 1)
    positions = torch.arange(encoder.embed_positions.num_embeddings, device=x.device)
    hidden = x + encoder.embed_positions(positions)
    for layer in encoder.layers[:stop]:
        hidden = layer(hidden, None)
    return hidden


def encoder_top(encoder, hidden, start: int):
    """Layers [start, end) and the final layer norm of a Whisper encoder."""
    for layer in encoder.layers[start:]:
        hidden = layer(hidden, None)
    return encoder.layer_norm(hidden)


def generate(model, tokens: Tokens, *, input_features=None, encoder_hidden=None,
             max_new_tokens: int = 440) -> list[str]:
    """Greedy Danish transcripts, timestamps off, for a batch of features or
    precomputed encoder outputs."""
    import torch
    from transformers.modeling_outputs import BaseModelOutput

    kwargs = dict(language=LANGUAGE, task=TASK, return_timestamps=False, do_sample=False, num_beams=1,
                  max_new_tokens=max_new_tokens)
    with torch.inference_mode():
        if encoder_hidden is not None:
            ids = model.generate(encoder_outputs=BaseModelOutput(last_hidden_state=encoder_hidden), **kwargs)
        else:
            ids = model.generate(input_features=input_features, **kwargs)
    special = set(tokens.prompt) | {tokens.eot}
    return [tokens.decode([t for t in row.tolist() if t not in special]) for row in ids]
