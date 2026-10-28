"""Shared fixtures: synthetic clips, a FLEURS folder and a tiny random Whisper.

Every test runs offline on the CPU. Nothing here downloads Edda or FLEURS: the
FLEURS folder is written in the layout ``wt-train fetch`` leaves, and the model
is a two-layer Whisper with random weights, a small mel front end (1-second
windows) and a character tokenizer with Whisper's special-token layout.
"""

from __future__ import annotations

import csv
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf


def write_wav(path: Path, seed: int, seconds: float = 0.5, rate: int = 16000, channels: int = 1,
              subtype: str = "PCM_16") -> Path:
    """A distinct noise clip per seed (distinct content hash)."""
    rng = np.random.default_rng(seed)
    frames = int(seconds * rate)
    pcm = (rng.standard_normal((frames, channels)) * 0.1).astype(np.float32)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), pcm if channels > 1 else pcm[:, 0], rate, subtype=subtype)
    return path


@pytest.fixture(autouse=True)
def untracked(monkeypatch):
    """No test writes an MLflow store unless it asks for one (test_tracking*.py, test_journal.py)."""
    monkeypatch.setenv("WT_TRACKING", "0")


@pytest.fixture(autouse=True)
def private(tmp_path_factory, monkeypatch):
    """Run 12: no test reads the app's real dictation history or writes the owner's own words:
    both point into a folder of the test's own unless it names others."""
    own = tmp_path_factory.mktemp("private")
    monkeypatch.setenv("WT_APP_HISTORY_DB", str(own / "no-history.db"))
    monkeypatch.setenv("WT_LOCAL_DIR", str(own / "local"))


@pytest.fixture
def make_wav():
    return write_wav


WORDS = ["kat", "hund", "fisk", "fugl", "hest", "ko", "gris", "får", "ged", "and", "ugle", "ræv",
         "ulv", "bjørn", "elg", "mus", "rotte", "hare", "pindsvin", "odder", "sæl", "hval", "laks", "ørred"]


def write_takes(root: Path, n: int = 24) -> tuple[Path, Path, Path]:
    """n takes of distinct sentences (every third with a term spelled the
    unconventional way), their sentences.csv and a spelling.yaml."""
    folder = root / "recordings"
    rows = ["id,text,kind"]
    for i, word in enumerate(WORDS[:n]):
        sid = f"s{i:04d}"
        if i % 3 == 0:
            text, kind = f"Vi skal deploy'e {word} i dag.", "terms"
        else:
            text, kind = f"Der er en {word} i haven.", "plain"
        rows.append(f'{sid},"{text}",{kind}')
        write_wav(folder / f"{sid}.wav", seed=i)
        (folder / f"{sid}.txt").write_text(text + "\n", encoding="utf-8")
    sentences = root / "sentences.csv"
    sentences.write_text("\n".join(rows) + "\n", encoding="utf-8")
    spelling = root / "spelling.yaml"
    spelling.write_text("terms:\n  deploy:\n    forms: [deploye, deployer]\n    also:\n      deploy'e: deploye\n",
                        encoding="utf-8")
    return folder, sentences, spelling


def takes_config(folder: Path, sentences: Path, spelling: Path, **sections):
    """A config over write_takes() output; ``sections`` update its sections."""
    from wt_train.config import config_from_dict

    raw = {"name": "t",
           "data": {"recordings": str(folder), "sentences": str(sentences), "spelling": str(spelling),
                    "validation_fraction": 0.25, "test_fraction": 0.25, "seed": 3},
           "rehearsal": {"share": 0.25, "validation_share": 0.2}}
    for section, values in sections.items():
        raw.setdefault(section, {}).update(values)
    return config_from_dict(raw)


def write_fleurs(root: Path, split: str, rows: list[tuple[str, str, str]], seed0: int) -> Path:
    """rows: (sentence id, file stem, raw text). Writes <split>.tsv, <split>/*.wav (32-bit
    float, like FLEURS) and the marker."""
    root.mkdir(parents=True, exist_ok=True)
    with (root / f"{split}.tsv").open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, delimiter="\t", quoting=csv.QUOTE_NONE, escapechar="\\")
        for i, (sid, stem, text) in enumerate(rows):
            write_wav(root / split / f"{stem}.wav", seed0 + i, subtype="FLOAT")
            w.writerow([sid, f"{stem}.wav", text, text.lower(), "x", 8000, "FEMALE"])
    (root / (".complete" if split == "test" else ".complete-train")).touch()
    return root


@pytest.fixture
def fleurs_root(tmp_path):
    """A FLEURS da_dk folder: 12 train sentences (two read twice) and 4 test ones."""
    root = tmp_path / "fleurs-da_dk"
    train = [(f"t{i}", f"{1000 + i}", f"Træningssætning nummer {word} her." ) for i, word in enumerate(
        ["en", "to", "tre", "fire", "fem", "seks", "syv", "otte", "ni", "ti", "elleve", "tolv"])]
    train += [("t0", "1100", "Træningssætning nummer en her."), ("t1", "1101", "Træningssætning nummer to her.")]
    test = [(f"x{i}", f"{2000 + i}", f"Testsætning {word}.") for i, word in enumerate(["alfa", "beta", "gamma", "delta"])]
    write_fleurs(root, "train", train, seed0=500)
    write_fleurs(root, "test", test, seed0=900)
    return root


# --- a tiny Whisper ---------------------------------------------------------

ALPHABET = "abcdefghijklmnopqrstuvwxyzæøå .,'?"
EOT, SOT, DA, TRANSCRIBE, TRANSLATE, NOTIMESTAMPS = range(len(ALPHABET), len(ALPHABET) + 6)
VOCAB = NOTIMESTAMPS + 2


def fake_tokens():
    from wt_train.whisper import Tokens

    index = {c: i for i, c in enumerate(ALPHABET)}

    def encode(text: str) -> list[int]:
        return [index[c] for c in text.lower() if c in index]

    def decode(ids: list[int]) -> str:
        return "".join(ALPHABET[i] for i in ids if 0 <= i < len(ALPHABET)).strip()

    return Tokens(sot=SOT, lang=DA, task=TRANSCRIBE, notimestamps=NOTIMESTAMPS, eot=EOT,
                  encode=encode, decode=decode)


def build_tiny_model_dir(folder: Path) -> Path:
    import torch
    from transformers import GenerationConfig, WhisperConfig, WhisperFeatureExtractor, WhisperForConditionalGeneration

    torch.manual_seed(0)
    config = WhisperConfig(
        vocab_size=VOCAB, num_mel_bins=8, d_model=16, encoder_layers=3, decoder_layers=2,
        encoder_attention_heads=2, decoder_attention_heads=2, encoder_ffn_dim=32, decoder_ffn_dim=32,
        max_source_positions=50, max_target_positions=64, decoder_start_token_id=SOT,
        eos_token_id=EOT, pad_token_id=EOT, bos_token_id=EOT, begin_suppress_tokens=None,
        suppress_tokens=None, apply_spec_augment=False,
    )
    model = WhisperForConditionalGeneration(config)
    model.generation_config = GenerationConfig(
        decoder_start_token_id=SOT, eos_token_id=EOT, pad_token_id=EOT, bos_token_id=EOT,
        max_length=64, is_multilingual=True, lang_to_id={"<|da|>": DA},
        task_to_id={"transcribe": TRANSCRIBE, "translate": TRANSLATE},
        no_timestamps_token_id=NOTIMESTAMPS, suppress_tokens=[], begin_suppress_tokens=[EOT],
    )
    model.save_pretrained(folder)
    WhisperFeatureExtractor(feature_size=8, sampling_rate=16000, hop_length=160, chunk_length=1,
                            n_fft=400).save_pretrained(folder)
    for name in ("tokenizer.json", "vocab.json", "merges.txt"):
        (folder / name).write_text("{}\n" if name.endswith(".json") else "#version: 0.2\n")
    return folder


@pytest.fixture(scope="session")
def tiny_model_dir(tmp_path_factory):
    return build_tiny_model_dir(tmp_path_factory.mktemp("tiny-whisper"))


@pytest.fixture
def tiny_base(tiny_model_dir):
    from transformers import WhisperFeatureExtractor

    from wt_train.whisper import Base

    return Base(path=tiny_model_dir, repo="test/tiny-whisper", revision="0" * 40,
                feature_extractor=WhisperFeatureExtractor.from_pretrained(tiny_model_dir),
                tokens=fake_tokens())
