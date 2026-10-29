"""Experiment configs: one YAML file per experiment in ``training/configs/``.

The schema is the dataclasses below; the shipped configs comment every knob.
Loading is strict: an unknown key, a wrong type or an out-of-range value is an
error naming the key, so a typo never silently falls back to a default. Keys
left out take the defaults below, and the run saves the fully resolved config
(``config.json``) with its hash, so every result can be traced to its knobs.

Relative paths in ``data`` are relative to the ``training/`` folder; ``null``
means the default (``training/data/recordings``, ``sentences.csv``,
``spelling.yaml``). Floats may be written ``1e-4`` (YAML 1.1 reads that as a
string; it is accepted as a number here).
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
import types
import typing
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from . import paths

NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]*")
SLUG_RE = re.compile(r"[a-z0-9-]+")
DECODER_PARTS = ("self_attn", "cross_attn", "ffn")
ENCODER_PARTS = ("self_attn", "ffn")
PROJECTIONS = ("q_proj", "k_proj", "v_proj", "out_proj")
SCHEDULES = ("linear", "cosine", "constant")
DEVICES = ("auto", "mps", "cpu")
# Whisper's decoder holds 448 positions; the prompt takes 4 of them.
MAX_NEW_TOKENS = 444


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class BaseModelConfig:
    repo: str = paths.EDDA_REPO
    revision: str = paths.EDDA_REVISION

    def check(self, where: str) -> None:
        _require(re.fullmatch(r"[\w.-]+/[\w.-]+", self.repo), f"{where}.repo", "must be <owner>/<name>")
        _require(re.fullmatch(r"[0-9a-f]{40}", self.revision), f"{where}.revision",
                 "must be a full 40-character commit hash, so the run is reproducible")


@dataclass(frozen=True)
class DataConfig:
    recordings: str | None = None
    sentences: str | None = None
    spelling: str | None = None
    validation_fraction: float = 0.1
    test_fraction: float = 0.1
    seed: int = 1
    # Run 12: terms of spelling.yaml whose sentences are tested only, never trained on, so the
    # evaluation measures how the model does on terms it never heard (splits.py; the names
    # are checked against spelling.yaml where the split is dealt).
    held_out_terms: tuple[str, ...] = ()

    def check(self, where: str) -> None:
        _require(0 < self.validation_fraction < 1, f"{where}.validation_fraction",
                 "must be above 0 (the best adapter is picked on validation) and below 1")
        _require(0 <= self.test_fraction < 1, f"{where}.test_fraction", "must be at least 0 and below 1")
        _require(self.validation_fraction + self.test_fraction < 1, f"{where}",
                 "validation_fraction + test_fraction must leave something to train on")
        _require(self.seed >= 0, f"{where}.seed", "must be at least 0")
        _require(all(t.strip() for t in self.held_out_terms), f"{where}.held_out_terms", "lists an empty name")
        _require(len(set(self.held_out_terms)) == len(self.held_out_terms), f"{where}.held_out_terms",
                 "lists a term twice")

    def path(self, name: str) -> Path:
        value = getattr(self, name)
        default = {"recordings": paths.RECORDINGS, "sentences": paths.SENTENCES_CSV,
                   "spelling": paths.SPELLING_YAML}[name]
        if value is None:
            return default
        p = Path(value).expanduser()
        return p if p.is_absolute() else (paths.TRAINING / p).resolve()


@dataclass(frozen=True)
class RehearsalConfig:
    share: float = 0.3
    validation_share: float = 0.3

    def check(self, where: str) -> None:
        _require(0 <= self.share < 1, f"{where}.share", "must be at least 0 and below 1")
        _require(0 <= self.validation_share < 1, f"{where}.validation_share", "must be at least 0 and below 1")


@dataclass(frozen=True)
class LoraConfig:
    rank: int = 16
    alpha: float = 32.0
    dropout: float = 0.05
    decoder: tuple[str, ...] = DECODER_PARTS
    projections: tuple[str, ...] = PROJECTIONS
    encoder_top_layers: int = 0
    encoder: tuple[str, ...] = ENCODER_PARTS

    def check(self, where: str) -> None:
        _require(self.rank >= 1, f"{where}.rank", "must be at least 1")
        _require(self.alpha > 0, f"{where}.alpha", "must be above 0")
        _require(0 <= self.dropout < 1, f"{where}.dropout", "must be at least 0 and below 1")
        _check_subset(self.decoder, DECODER_PARTS, f"{where}.decoder")
        _check_subset(self.projections, PROJECTIONS, f"{where}.projections")
        _require(0 <= self.encoder_top_layers <= 32, f"{where}.encoder_top_layers", "must be 0 to 32")
        _check_subset(self.encoder, ENCODER_PARTS, f"{where}.encoder")


@dataclass(frozen=True)
class TrainingConfig:
    learning_rate: float = 1e-4
    warmup_fraction: float = 0.1
    schedule: str = "linear"
    epochs: int = 5
    batch_size: int = 8
    gradient_accumulation: int = 2
    weight_decay: float = 0.0
    max_grad_norm: float = 1.0
    seed: int = 1
    device: str = "auto"

    def check(self, where: str) -> None:
        _require(0 < self.learning_rate < 1, f"{where}.learning_rate", "must be above 0 and below 1")
        _require(0 <= self.warmup_fraction < 1, f"{where}.warmup_fraction", "must be at least 0 and below 1")
        _require(self.schedule in SCHEDULES, f"{where}.schedule", f"must be one of {', '.join(SCHEDULES)}")
        _require(self.epochs >= 1, f"{where}.epochs", "must be at least 1")
        _require(self.batch_size >= 1, f"{where}.batch_size", "must be at least 1")
        _require(self.gradient_accumulation >= 1, f"{where}.gradient_accumulation", "must be at least 1")
        _require(self.weight_decay >= 0, f"{where}.weight_decay", "must be at least 0")
        _require(self.max_grad_norm >= 0, f"{where}.max_grad_norm", "must be at least 0 (0 turns clipping off)")
        _require(self.seed >= 0, f"{where}.seed", "must be at least 0")
        _require(self.device in DEVICES, f"{where}.device", f"must be one of {', '.join(DEVICES)}")


@dataclass(frozen=True)
class EvaluationConfig:
    batch_size: int = 8
    max_new_tokens: int = 440
    baseline: bool = True

    def check(self, where: str) -> None:
        _require(self.batch_size >= 1, f"{where}.batch_size", "must be at least 1")
        _require(1 <= self.max_new_tokens <= MAX_NEW_TOKENS, f"{where}.max_new_tokens",
                 f"must be 1 to {MAX_NEW_TOKENS}")


@dataclass(frozen=True)
class ExportConfig:
    slug: str = "experiment"
    name: str = "Edda (finjusteret)"
    verify_clips: int = 10
    max_differing_clips: int = 1

    def check(self, where: str) -> None:
        _require(SLUG_RE.fullmatch(self.slug), f"{where}.slug", "must be lower-case letters, digits and -")
        _require(0 < len(self.name) <= 64 and "\n" not in self.name, f"{where}.name",
                 "must be one line of 1 to 64 characters")
        _require(self.verify_clips >= 1, f"{where}.verify_clips", "must be at least 1")
        _require(0 <= self.max_differing_clips <= self.verify_clips, f"{where}.max_differing_clips",
                 "must be 0 to verify_clips")


@dataclass(frozen=True)
class Config:
    name: str
    base_model: BaseModelConfig = field(default_factory=BaseModelConfig)
    data: DataConfig = field(default_factory=DataConfig)
    rehearsal: RehearsalConfig = field(default_factory=RehearsalConfig)
    lora: LoraConfig = field(default_factory=LoraConfig)
    training: TrainingConfig = field(default_factory=TrainingConfig)
    evaluation: EvaluationConfig = field(default_factory=EvaluationConfig)
    export: ExportConfig = field(default_factory=ExportConfig)
    # Where the config was read from; not part of the YAML or the hash.
    source: Path | None = field(default=None, compare=False)

    def check(self) -> None:
        _require(NAME_RE.fullmatch(self.name), "name", "must be lower-case letters, digits and -")
        for f in dataclasses.fields(self):
            section = getattr(self, f.name)
            if hasattr(section, "check"):
                section.check(f.name)


# --- loading -----------------------------------------------------------------


def _require(ok, key: str, message: str) -> None:
    if not ok:
        raise ConfigError(f"{key}: {message}")


def _check_subset(values: tuple[str, ...], allowed: tuple[str, ...], key: str) -> None:
    _require(len(values) > 0, key, f"must list at least one of {', '.join(allowed)}")
    _require(len(set(values)) == len(values), key, "lists a value twice")
    unknown = [v for v in values if v not in allowed]
    _require(not unknown, key, f"unknown {', '.join(unknown)}; allowed: {', '.join(allowed)}")


def _coerce(value, annotation, key: str):
    """``value`` as the annotated type, or a ConfigError naming ``key``."""
    origin = typing.get_origin(annotation)
    if origin in (typing.Union, types.UnionType):
        args = typing.get_args(annotation)
        if value is None and type(None) in args:
            return None
        (inner,) = [a for a in args if a is not type(None)]
        return _coerce(value, inner, key)
    if dataclasses.is_dataclass(annotation):
        return _section(annotation, value, key)
    if origin is tuple:
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ConfigError(f"{key}: must be a list of strings")
        return tuple(value)
    if annotation is bool:
        if not isinstance(value, bool):
            raise ConfigError(f"{key}: must be true or false")
        return value
    if annotation is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ConfigError(f"{key}: must be a whole number")
        return value
    if annotation is float:
        if isinstance(value, str):
            try:
                return float(value)
            except ValueError:
                pass
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ConfigError(f"{key}: must be a number")
        return float(value)
    if annotation is str:
        if not isinstance(value, str):
            raise ConfigError(f"{key}: must be a string")
        return value
    raise TypeError(f"unsupported config type {annotation!r} for {key}")


def _section(cls, raw, where: str):
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ConfigError(f"{where or 'config'}: must be a mapping")
    hints = typing.get_type_hints(cls)
    fields = {f.name: f for f in dataclasses.fields(cls) if f.name != "source"}
    unknown = sorted(set(raw) - set(fields))
    if unknown:
        prefix = f"{where}." if where else ""
        raise ConfigError(f"unknown key {prefix}{unknown[0]}; allowed: {', '.join(fields)}")
    values = {}
    for name in fields:
        key = f"{where}.{name}" if where else name
        if name in raw:
            values[name] = _coerce(raw[name], hints[name], key)
        elif fields[name].default is dataclasses.MISSING and fields[name].default_factory is dataclasses.MISSING:
            raise ConfigError(f"{key}: is required")
    return cls(**values)


def config_from_dict(raw: dict, source: Path | None = None) -> Config:
    cfg = _section(Config, raw, "")
    cfg = dataclasses.replace(cfg, source=source)
    cfg.check()
    return cfg


def load_config(path: Path) -> Config:
    path = Path(path)
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        raise ConfigError(f"{path}: not valid YAML: {e}") from e
    try:
        return config_from_dict(raw, source=path.resolve())
    except ConfigError as e:
        raise ConfigError(f"{path}: {e}") from None


def to_dict(cfg: Config) -> dict:
    """The resolved config as plain data (tuples become lists; no source path)."""
    out = dataclasses.asdict(cfg)
    out.pop("source", None)
    return json.loads(json.dumps(out))


def config_hash(cfg: Config) -> str:
    """12 hex characters of SHA-256 over the resolved config; comments don't count."""
    blob = json.dumps(to_dict(cfg), sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:12]


def key_knobs(cfg: Config) -> dict:
    """The knobs results.csv records next to every score."""
    return {
        "rank": cfg.lora.rank, "alpha": cfg.lora.alpha, "dropout": cfg.lora.dropout,
        "decoder": list(cfg.lora.decoder), "projections": list(cfg.lora.projections),
        "encoder_top_layers": cfg.lora.encoder_top_layers,
        "learning_rate": cfg.training.learning_rate, "epochs": cfg.training.epochs,
        "batch_size": cfg.training.batch_size,
        "gradient_accumulation": cfg.training.gradient_accumulation,
        "rehearsal_share": cfg.rehearsal.share,
    }


def with_overrides(cfg: Config, **sections) -> Config:
    """A copy with some fields of some sections replaced, checked again.

    ``with_overrides(cfg, data={"recordings": "/tmp/x"}, training={"epochs": 1})``
    """
    changes = {}
    for name, fields in sections.items():
        if name == "name":
            changes[name] = fields
            continue
        changes[name] = dataclasses.replace(getattr(cfg, name), **fields)
    out = dataclasses.replace(cfg, **changes)
    out.check()
    return out
