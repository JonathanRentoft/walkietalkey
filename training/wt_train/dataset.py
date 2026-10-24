"""``wt-train build <config>``: train, validation and test splits, checked for leakage.

Inputs
    The owner's takes in ``data.recordings`` (default training/data/recordings):
    ``<id>.wav`` (16 kHz mono) and ``<id>.txt`` (the text as read), one take
    per sentence id, joined with ``sentences.csv`` for the kind (terms or
    plain). Every transcript is re-spelled with ``Spelling.apply`` so the model
    learns one spelling per term form. Takes without a text, or whose id is not
    in sentences.csv, are skipped and listed in the summary.

Splits are by sentence
    A sentence is its text after the accuracy job's normaliser (case,
    punctuation and number spelling do not make two sentences different). Each
    sentence goes to exactly one split, chosen by a hash of the seed and its
    normalised text: below ``test_fraction`` it is test, below ``test_fraction
    + validation_fraction`` validation, otherwise train. The split of a sentence
    therefore never changes when more takes are recorded, so test results from
    different days stay comparable. The fractions hold on average, not exactly.

Rehearsal
    Plain Danish from FLEURS da_dk train, so the model keeps its plain Danish.
    ``rehearsal.share`` is the fraction of the final training split that is
    rehearsal: with 700 own training takes and share 0.3 it adds 300 FLEURS
    clips (300 of 1000). ``rehearsal.validation_share`` does the same for
    validation, so picking the best epoch also guards plain Danish. One clip
    (one speaker) per FLEURS sentence, sentences drawn with the seed, and never
    a sentence that is also among the owner's takes.

Leakage check (fails loudly, the build is not written)
    * the same sentence (normalised text) in two splits;
    * the same audio (hash of the decoded samples) twice anywhere;
    * any FLEURS da_dk test text in train or validation, or any FLEURS test
      audio (by content or by path) in any split. FLEURS test is the regression
      check of ``wt-train eval`` and must stay unseen.

Output, in ``<work>/builds/<config name>/``: ``train.jsonl``,
``validation.jsonl``, ``test.jsonl`` (one clip per line: id, audio path,
text, kind, source, audio_sha256, seconds) and ``summary.json``. The takes are
referenced by path, never copied.
"""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import os
import random
import sys
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from . import audio, fleurs, paths
from .audio import file_sha256
from .config import Config, load_config, to_dict, with_overrides
from .harness import normalize
from .sentences import load_sentences
from .spelling import Spelling, load_spelling

SPLITS = ("train", "validation", "test")
SOURCE_RECORDING = "recording"
SOURCE_REHEARSAL = "fleurs-train"


class LeakageError(RuntimeError):
    """The splits leak into each other or into FLEURS test."""


@dataclass(frozen=True)
class Item:
    id: str
    audio: str
    text: str
    kind: str
    source: str
    audio_sha256: str
    seconds: float

    @property
    def key(self) -> str:
        return sentence_key(self.text)


def sentence_key(text: str) -> str:
    """What makes two texts the same sentence: equal after the normaliser."""
    return normalize(text)


# --- the owner's takes ---------------------------------------------------------


def load_recordings(folder: Path, sentences_csv: Path, spelling: Spelling) -> tuple[list[Item], list[dict]]:
    """(usable takes, skipped takes with a reason)."""
    folder = Path(folder)
    if not folder.is_dir():
        raise FileNotFoundError(f"no recordings folder at {folder}; record takes with: wt-train record")
    kinds = {s.id: s.kind for s in load_sentences(sentences_csv)}
    items, skipped = [], []
    for wav in sorted(folder.glob("*.wav")):
        sid = wav.stem
        txt = wav.with_suffix(".txt")
        if not txt.is_file():
            skipped.append({"id": sid, "reason": "no .txt next to the .wav"})
            continue
        if sid not in kinds:
            skipped.append({"id": sid, "reason": "id not in sentences.csv"})
            continue
        text = spelling.apply(txt.read_text(encoding="utf-8").strip())
        if not sentence_key(text):
            skipped.append({"id": sid, "reason": "empty text"})
            continue
        info = audio.info(wav)
        if not info.is_16k_mono:
            raise ValueError(f"{wav}: {info.rate} Hz, {info.channels} channel(s); takes must be 16 kHz mono")
        items.append(Item(id=sid, audio=str(wav.resolve()), text=text, kind=kinds[sid],
                          source=SOURCE_RECORDING, audio_sha256=audio.content_sha256(wav),
                          seconds=round(info.seconds, 3)))
    return items, skipped


def split_of(key: str, seed: int, validation_fraction: float, test_fraction: float) -> str:
    """The split of one sentence: a uniform number from a hash of seed and text."""
    digest = hashlib.sha256(f"{seed}\0{key}".encode("utf-8")).digest()
    u = int.from_bytes(digest[:8], "big") / 2**64
    if u < test_fraction:
        return "test"
    if u < test_fraction + validation_fraction:
        return "validation"
    return "train"


def split_by_sentence(items: list[Item], validation_fraction: float, test_fraction: float,
                      seed: int) -> dict[str, list[Item]]:
    splits: dict[str, list[Item]] = {s: [] for s in SPLITS}
    for item in items:
        splits[split_of(item.key, seed, validation_fraction, test_fraction)].append(item)
    for split in splits.values():
        split.sort(key=lambda i: i.id)
    return splits


# --- rehearsal -------------------------------------------------------------------


def rehearsal_count(own: int, share: float) -> int:
    """Rehearsal clips so that they are ``share`` of own + rehearsal clips."""
    if share <= 0 or own <= 0:
        return 0
    return round(share * own / (1 - share))


def sample_rehearsal(candidates: list[fleurs.FleursClip], n_train: int, n_validation: int,
                     exclude: set[str], seed: int, spelling: Spelling) -> tuple[list[Item], list[Item]]:
    """One clip per FLEURS sentence; validation and train never share a sentence."""
    groups: dict[str, list[fleurs.FleursClip]] = {}
    for clip in candidates:
        key = sentence_key(clip.text)
        if key and key not in exclude:
            groups.setdefault(key, []).append(clip)
    keys = sorted(groups)
    need = n_train + n_validation
    if need > len(keys):
        raise ValueError(f"rehearsal needs {need} distinct FLEURS train sentences but only {len(keys)} "
                         "are available; lower rehearsal.share or rehearsal.validation_share")
    rng = random.Random(f"rehearsal:{seed}")
    rng.shuffle(keys)

    def pick(key: str) -> Item:
        clip = rng.choice(sorted(groups[key], key=lambda c: c.id))
        return Item(id=clip.id, audio=str(clip.wav.resolve()), text=spelling.apply(clip.text), kind="plain",
                    source=SOURCE_REHEARSAL, audio_sha256=audio.content_sha256(clip.wav),
                    seconds=round(clip.seconds, 3))

    validation = sorted((pick(k) for k in keys[:n_validation]), key=lambda i: i.id)
    train = sorted((pick(k) for k in keys[n_validation:need]), key=lambda i: i.id)
    return train, validation


# --- leakage -------------------------------------------------------------------


@dataclass(frozen=True)
class HeldOut:
    """What must never be trained on: FLEURS da_dk test, by text, audio and path."""

    keys: frozenset[str]
    hashes: frozenset[str]
    folder: Path


def fleurs_test_held_out(root: Path | None = None) -> HeldOut:
    root = Path(root) if root is not None else paths.fleurs_dir()
    clips = fleurs.load_split("test", root)
    # Content hashes of the 930 test clips, computed once and kept next to them.
    cache = root / "test.content-sha256.json"
    known = json.loads(cache.read_text()) if cache.is_file() else {}
    if set(known) != {c.wav.name for c in clips}:
        known = {c.wav.name: audio.content_sha256(c.wav) for c in clips}
        cache.write_text(json.dumps(known, indent=0, sort_keys=True) + "\n")
    return HeldOut(keys=frozenset(sentence_key(c.text) for c in clips),
                   hashes=frozenset(known.values()), folder=(root / "test").resolve())


def check_leakage(splits: dict[str, list[Item]], held_out: HeldOut) -> dict:
    """Raise LeakageError listing every problem; otherwise a short report."""
    problems: list[str] = []

    def examples(values) -> str:
        values = sorted(values)
        return ", ".join(repr(v) for v in values[:3]) + (" ..." if len(values) > 3 else "")

    keys = {name: {i.key for i in items} for name, items in splits.items()}
    for a, b in itertools.combinations(splits, 2):
        both = keys[a] & keys[b]
        if both:
            problems.append(f"{len(both)} sentence(s) in both {a} and {b}: {examples(both)}")

    every = [(name, item) for name, items in splits.items() for item in items]
    by_audio: dict[str, list[str]] = {}
    for name, item in every:
        by_audio.setdefault(item.audio_sha256, []).append(f"{item.id} ({name})")
    for places in by_audio.values():
        if len(places) > 1:
            problems.append(f"the same audio twice: {', '.join(places)}")
    ids = Counter(item.id for _, item in every)
    for clip_id, n in ids.items():
        if n > 1:
            problems.append(f"id {clip_id} appears {n} times")

    for name, item in every:
        where = f"{item.id} ({name})"
        if name != "test" and item.key in held_out.keys:
            problems.append(f"FLEURS test text in {name}: {where}: {item.text!r}")
        if item.audio_sha256 in held_out.hashes:
            problems.append(f"FLEURS test audio in {name}: {where}")
        if Path(item.audio).resolve().is_relative_to(held_out.folder):
            problems.append(f"a FLEURS test file in {name}: {item.audio}")

    if problems:
        raise LeakageError("leakage check failed:\n  " + "\n  ".join(problems))
    return {
        "passed": True,
        "checks": ["no sentence in two splits", "no audio twice", "no FLEURS test text in train or validation",
                   "no FLEURS test audio in any split"],
        "fleurs_test_sentences": len(held_out.keys),
    }


# --- the build -------------------------------------------------------------------


@dataclass
class Build:
    dir: Path
    splits: dict[str, list[Item]]
    summary: dict

    def manifest(self, split: str) -> Path:
        return self.dir / f"{split}.jsonl"


def read_manifest(path: Path) -> list[Item]:
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [Item(**json.loads(line)) for line in lines if line.strip()]


def load_build(folder: Path) -> Build:
    folder = Path(folder)
    summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
    return Build(dir=folder, splits={s: read_manifest(folder / f"{s}.jsonl") for s in SPLITS}, summary=summary)


def _write(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def _split_summary(items: list[Item], manifest: Path) -> dict:
    return {
        "clips": len(items),
        "sentences": len({i.key for i in items}),
        "hours": round(sum(i.seconds for i in items) / 3600, 3),
        "by_kind": dict(sorted(Counter(i.kind for i in items).items())),
        "by_source": dict(sorted(Counter(i.source for i in items).items())),
        "manifest_sha256": file_sha256(manifest),
    }


def build(cfg: Config, *, out_dir: Path | None = None, fleurs_root: Path | None = None,
          log=print) -> Build:
    """Build, check and write the splits for one experiment config."""
    spelling = load_spelling(cfg.data.path("spelling"))
    own, skipped = load_recordings(cfg.data.path("recordings"), cfg.data.path("sentences"), spelling)
    if not own:
        raise ValueError(f"no usable takes in {cfg.data.path('recordings')}; record with: wt-train record")
    splits = split_by_sentence(own, cfg.data.validation_fraction, cfg.data.test_fraction, cfg.data.seed)
    for name, fraction in (("validation", cfg.data.validation_fraction), ("test", cfg.data.test_fraction)):
        if fraction > 0 and not splits[name]:
            raise ValueError(f"no sentence landed in {name} ({len(own)} takes); record more or change data.seed")
    if not splits["train"]:
        raise ValueError("no sentence landed in train; lower the validation and test fractions")

    if fleurs_root is None:
        fleurs_root = paths.fleurs_dir()
        fleurs.ensure("test", fleurs_root)
    held_out = fleurs_test_held_out(fleurs_root)

    n_train = rehearsal_count(len(splits["train"]), cfg.rehearsal.share)
    n_val = rehearsal_count(len(splits["validation"]), cfg.rehearsal.validation_share)
    if n_train or n_val:
        if not fleurs.is_ready("train", fleurs_root):
            fleurs.ensure("train", fleurs_root)
        exclude = {i.key for i in own} | set(held_out.keys)
        reh_train, reh_val = sample_rehearsal(fleurs.load_split("train", fleurs_root), n_train, n_val,
                                              exclude, cfg.data.seed, spelling)
        splits["train"] = sorted(splits["train"] + reh_train, key=lambda i: i.id)
        splits["validation"] = sorted(splits["validation"] + reh_val, key=lambda i: i.id)

    report = check_leakage(splits, held_out)

    out = Path(out_dir) if out_dir is not None else paths.builds_dir() / cfg.name
    out.mkdir(parents=True, exist_ok=True)
    for name, items in splits.items():
        _write(out / f"{name}.jsonl",
               "".join(json.dumps(asdict(i), ensure_ascii=False) + "\n" for i in items))

    def actual_share(name: str) -> float:
        items = splits[name]
        return round(sum(i.source == SOURCE_REHEARSAL for i in items) / len(items), 4) if items else 0.0

    sentences_csv, spelling_yaml = cfg.data.path("sentences"), cfg.data.path("spelling")
    summary = {
        "name": cfg.name,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "inputs": {
            "recordings": str(cfg.data.path("recordings")),
            "takes_used": len(own),
            "skipped": skipped,
            "sentences": str(sentences_csv),
            "sentences_sha256": file_sha256(sentences_csv),
            "spelling": str(spelling_yaml),
            "spelling_sha256": file_sha256(spelling_yaml),
            "fleurs": str(Path(fleurs_root).resolve()),
            "fleurs_revision": paths.FLEURS_REVISION,
        },
        "data": to_dict(cfg)["data"],
        "rehearsal": {**to_dict(cfg)["rehearsal"], "train_clips": n_train, "validation_clips": n_val,
                      "train_share_actual": actual_share("train"),
                      "validation_share_actual": actual_share("validation")},
        "splits": {name: _split_summary(items, out / f"{name}.jsonl") for name, items in splits.items()},
        "leakage_check": report,
    }
    _write(out / "summary.json", json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    return Build(dir=out, splits=splits, summary=summary)


def format_summary(b: Build) -> str:
    lines = [f"{'split':<11} {'clips':>6} {'sentences':>9} {'hours':>6} {'terms':>6} {'plain':>6} {'rehearsal':>9}"]
    for name in SPLITS:
        s = b.summary["splits"][name]
        lines.append(f"{name:<11} {s['clips']:>6} {s['sentences']:>9} {s['hours']:>6.2f} "
                     f"{s['by_kind'].get('terms', 0):>6} {s['by_kind'].get('plain', 0):>6} "
                     f"{s['by_source'].get(SOURCE_REHEARSAL, 0):>9}")
    skipped = b.summary["inputs"]["skipped"]
    if skipped:
        lines.append(f"skipped {len(skipped)} take(s): " + ", ".join(f"{s['id']} ({s['reason']})" for s in skipped[:5])
                     + (" ..." if len(skipped) > 5 else ""))
    lines.append("leakage check: passed (" + "; ".join(b.summary["leakage_check"]["checks"]) + ")")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train build", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("config", type=Path, help="experiment YAML, e.g. configs/first-frozen-encoder.yaml")
    p.add_argument("--recordings", type=Path, help="takes folder instead of the config's data.recordings")
    a = p.parse_args(argv)
    cfg = load_config(a.config)
    if a.recordings:
        cfg = with_overrides(cfg, data={"recordings": str(a.recordings.resolve())})
    b = build(cfg)
    print(f"build {cfg.name} -> {b.dir}")
    print(format_summary(b))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
