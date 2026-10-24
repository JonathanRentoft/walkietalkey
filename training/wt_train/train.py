"""``wt-train train <config>``: a LoRA adapter on Edda, one YAML config per experiment.

What a run does, in order:

1. Builds the dataset the config describes (``wt-train build``, leakage check
   included) and copies its manifests into the run, so the run keeps the exact
   clips it was trained and validated on.
2. Fills the encoder cache (``encoder_cache.py``) for the training and
   validation clips: the whole frozen encoder, or its bottom 32 - N layers when
   ``lora.encoder_top_layers`` is N. Entries other runs made are reused.
3. Loads the base model in float32 on the Apple GPU (CPU fallback), adds LoRA
   adapters to the configured modules (Transformers + PEFT) and trains only
   them: AdamW, learning-rate warmup then decay, gradient accumulation, the
   loss averaged over the text tokens of each optimiser step (labels exactly
   as Edda was trained; see ``whisper.py``). Seeded: the adapter's initial
   weights and the clip order follow ``training.seed``.
4. After each epoch (and before the first, the base model, when
   ``evaluation.baseline``) transcribes the validation split greedily with
   timestamps off and scores it with the accuracy job's normaliser: WER, CER,
   WER on the owner's takes and on the FLEURS rehearsal clips separately, and
   English-term accuracy. One line per epoch goes to ``metrics.jsonl``, the
   curves to ``metrics.png``, the transcripts to ``validation/epoch-<n>.jsonl``.
5. Keeps the adapter of the epoch with the lowest validation WER (ties: lower
   validation loss) in ``adapter/``. Epoch 0 is the untouched base model: if
   no epoch beats it, the kept adapter is the zero update and ``best.json``
   says so.

A run lives in ``<work>/runs/train/<name>-<timestamp>/`` with ``config.yaml``
(the file as written), ``config.json`` (resolved, with its hash),
``dataset.json`` (the build summary with manifest hashes), ``dataset/``,
``metrics.jsonl``, ``metrics.png``, ``best.json``, ``adapter/``, ``cache.json``
(cache entries it created) and ``run.json``.

The per-epoch validation WER comes from the training model (float32 decoder,
cached float16 encoder outputs). ``wt-train eval --backend lora`` scores the
merged float16 model from audio, as the export does; the two can differ a
little.
"""

from __future__ import annotations

import argparse
import gc
import json
import math
import random
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np

from . import audio, console, dataset, paths, per_condition, whisper
from .config import Config, LoraConfig, config_hash, load_config, to_dict, with_overrides
from .dataset import Build, Item
from .encoder_cache import CacheSpec, EncoderCache
from .metrics import score_clip, summarize
from .spelling import load_spelling


# --- configuration helpers -----------------------------------------------------


def target_modules(lora: LoraConfig, encoder_layers: int) -> str:
    """A PEFT ``target_modules`` regex (full match on module names) for the config."""
    projections = "|".join(lora.projections)
    decoder = {
        "self_attn": rf"self_attn\.(?:{projections})",
        "cross_attn": rf"encoder_attn\.(?:{projections})",
        "ffn": r"fc1|fc2",
    }
    parts = [rf"model\.decoder\.layers\.\d+\.(?:{'|'.join(decoder[p] for p in lora.decoder)})"]
    if lora.encoder_top_layers:
        if lora.encoder_top_layers > encoder_layers:
            raise ValueError(f"lora.encoder_top_layers is {lora.encoder_top_layers}, "
                             f"but the model has {encoder_layers} encoder layers")
        layers = "|".join(str(i) for i in range(encoder_layers - lora.encoder_top_layers, encoder_layers))
        encoder = {"self_attn": rf"self_attn\.(?:{projections})", "ffn": r"fc1|fc2"}
        parts.append(rf"model\.encoder\.layers\.(?:{layers})\.(?:{'|'.join(encoder[p] for p in lora.encoder)})")
    return "|".join(f"(?:{p})" for p in parts)


def lr_factor(step: int, warmup: int, total: int, schedule: str) -> float:
    """Multiplier of the peak learning rate at optimiser step ``step`` (0-based)."""
    if warmup and step < warmup:
        return (step + 1) / warmup
    if schedule == "constant":
        return 1.0
    progress = min(1.0, (step - warmup) / max(1, total - warmup))
    if schedule == "cosine":
        return 0.5 * (1.0 + math.cos(math.pi * progress))
    return max(0.0, 1.0 - progress)


def seed_everything(seed: int) -> None:
    import torch

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def _model_config(base: whisper.Base) -> dict:
    return json.loads((Path(base.path) / "config.json").read_text())


def new_run_dir(root: Path, name: str) -> Path:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run = Path(root) / f"{name}-{stamp}"
    n = 1
    while run.exists():
        n += 1
        run = Path(root) / f"{name}-{stamp}-{n}"
    run.mkdir(parents=True)
    return run


def resolve_run(arg: str, root: Path | None = None) -> Path:
    """A run folder from a path, a run name, or ``latest`` (the newest run)."""
    root = Path(root) if root is not None else paths.runs_dir()
    if arg == "latest":
        runs = sorted((p for p in root.glob("*") if (p / "config.json").is_file()),
                      key=lambda p: p.stat().st_mtime)
        if not runs:
            raise FileNotFoundError(f"no training runs in {root}")
        return runs[-1]
    for candidate in (Path(arg), root / arg):
        if (candidate / "config.json").is_file():
            return candidate.resolve()
    raise FileNotFoundError(f"no training run {arg!r} (looked for a folder or a name in {root})")


# --- the encoder cache ---------------------------------------------------------


def fill_cache(cache: EncoderCache, base: whisper.Base, items: list[Item], device: str, batch_size: int,
               log=console.log) -> list[Path]:
    """Compute the missing entries with a float16 (GPU) or float32 (CPU) copy of the base."""
    import torch

    todo = cache.missing(items)
    if not todo:
        return []
    dtype = whisper.inference_dtype(device)
    log(f"encoder cache: computing {len(todo)} of {len(items)} clips "
        f"({cache.spec.layers} of {cache.spec.total_layers} layers, {device})")
    model = base.load(dtype, device)
    encoder = model.model.encoder
    spec = cache.spec

    def compute(batch: list[Item]) -> np.ndarray:
        feats = whisper.features(base.feature_extractor, [audio.read_16k_mono(Path(i.audio)) for i in batch])
        x = torch.from_numpy(feats).to(device, dtype)
        with torch.inference_mode():
            hidden = whisper.encoder_bottom(encoder, x, spec.layers)
            if spec.final:
                hidden = whisper.encoder_top(encoder, hidden, spec.layers)
        return hidden.float().cpu().numpy()

    started = time.time()
    next_report = [0.0]

    def progress(done: int, total: int) -> None:
        if done == total or done >= next_report[0]:
            log(f"  {done}/{total} clips, {time.time() - started:.0f} s")
            next_report[0] = done + total / 10

    created = cache.fill(todo, compute, batch_size, progress)
    del model, encoder
    _free_memory(device)
    return created


def _free_memory(device: str) -> None:
    import torch

    gc.collect()
    if device == "mps":
        torch.mps.empty_cache()


# --- training --------------------------------------------------------------------


class _Batches:
    """Encoder outputs (from the cache) and token tensors for lists of clips."""

    def __init__(self, cache: EncoderCache, examples: dict[str, tuple[list[int], list[int]]], pad_id: int,
                 device: str, encoder=None, top_start: int | None = None):
        self.cache, self.examples, self.pad_id, self.device = cache, examples, pad_id, device
        self.encoder, self.top_start = encoder, top_start

    def hidden(self, items: list[Item]):
        import torch

        h = torch.from_numpy(self.cache.load(items)).to(self.device).float()
        if self.top_start is not None:
            h = whisper.encoder_top(self.encoder, h, self.top_start)
        return h

    def tokens(self, items: list[Item]):
        inputs, labels = whisper.collate([self.examples[i.id] for i in items], self.pad_id)
        return inputs.to(self.device), labels.to(self.device)


def _loss_sum(model, hidden, inputs, labels):
    import torch.nn.functional as F
    from transformers.modeling_outputs import BaseModelOutput

    logits = model(encoder_outputs=BaseModelOutput(last_hidden_state=hidden), decoder_input_ids=inputs).logits
    loss = F.cross_entropy(logits.float().reshape(-1, logits.size(-1)), labels.reshape(-1),
                           ignore_index=whisper.IGNORE, reduction="sum")
    return loss, int((labels != whisper.IGNORE).sum())


def validate(model, batches: _Batches, items: list[Item], tokens: whisper.Tokens, spelling, batch_size: int,
             max_new_tokens: int) -> tuple[list[dict], dict]:
    """Greedy transcripts and teacher-forced loss on the validation clips."""
    import torch

    model.eval()
    rows, loss, n_tokens = [], 0.0, 0
    for start in range(0, len(items), batch_size):
        batch = items[start:start + batch_size]
        with torch.inference_mode():
            hidden = batches.hidden(batch)
            texts = whisper.generate(model, tokens, encoder_hidden=hidden, max_new_tokens=max_new_tokens)
            inputs, labels = batches.tokens(batch)
            batch_loss, batch_tokens = _loss_sum(model, hidden, inputs, labels)
        loss += float(batch_loss)
        n_tokens += batch_tokens
        for item, text in zip(batch, texts):
            rows.append({**score_clip(item.id, item.text, text, spelling), "kind": item.kind, "source": item.source,
                         "condition": item.condition})
    summary = summarize(rows)
    summary["loss"] = loss / n_tokens if n_tokens else 0.0
    for source in (dataset.SOURCE_RECORDING, dataset.SOURCE_REHEARSAL):
        part = [r for r in rows if r["source"] == source]
        summary[f"wer_{source}"] = summarize(part)["wer"] if part else None
    # Per recording condition (phone whispered, phone normal, Mac normal).
    summary["wer_by_condition"] = {cid: s["wer"] for cid, s in per_condition.summaries(rows).items()}
    return rows, summary


def _write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")


def plot_metrics(metrics: list[dict], path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(7, 4), dpi=120)
    epochs = [m["epoch"] for m in metrics]
    train = [(m["epoch"], m["train_loss"]) for m in metrics if m["train_loss"] is not None]
    if train:
        ax.plot(*zip(*train), marker="o", color="#4c6ef5", label="train loss")
    ax.plot(epochs, [m["validation_loss"] for m in metrics], marker="o", color="#4c6ef5", linestyle="--",
            label="validation loss")
    ax.set_xlabel("epoch")
    ax.set_ylabel("loss per text token")
    ax.set_xticks(epochs)
    ax2 = ax.twinx()
    ax2.plot(epochs, [m["validation_wer"] * 100 for m in metrics], marker="s", color="#e8590c",
             label="validation WER %")
    ax2.set_ylabel("validation WER %")
    lines = ax.get_legend_handles_labels()
    lines2 = ax2.get_legend_handles_labels()
    ax.legend(lines[0] + lines2[0], lines[1] + lines2[1], loc="upper right", fontsize=8)
    ax.set_title(path.parent.name, fontsize=9)
    fig.tight_layout()
    fig.savefig(path)
    plt.close(fig)


def save_run_inputs(run: Path, cfg: Config, build: Build) -> None:
    if cfg.source and Path(cfg.source).is_file():
        shutil.copyfile(cfg.source, run / "config.yaml")
    (run / "config.json").write_text(json.dumps(
        {"hash": config_hash(cfg), "source": str(cfg.source) if cfg.source else None, "config": to_dict(cfg)},
        indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (run / "dataset").mkdir()
    for split in dataset.SPLITS:
        shutil.copyfile(build.manifest(split), run / "dataset" / f"{split}.jsonl")
    (run / "dataset.json").write_text(json.dumps({"build": str(build.dir), "summary": build.summary},
                                                 indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run(cfg: Config, *, base: whisper.Base | None = None, build: Build | None = None,
        runs_root: Path | None = None, cache_root: Path | None = None, log=console.log) -> Path:
    """Train one experiment; returns the run folder."""
    import torch
    from peft import LoraConfig as PeftLoraConfig
    from peft import get_peft_model

    started = time.time()
    t = cfg.training
    seed_everything(t.seed)
    build = build if build is not None else dataset.build(cfg, log=log)
    base = base if base is not None else whisper.load_base(cfg.base_model.repo, cfg.base_model.revision)
    device = whisper.pick_device(t.device)
    model_config = _model_config(base)
    total_layers = int(model_config["encoder_layers"])
    regex = target_modules(cfg.lora, total_layers)  # checks encoder_top_layers against the model
    frozen = total_layers - cfg.lora.encoder_top_layers

    run_dir = new_run_dir(runs_root if runs_root is not None else paths.runs_dir(), cfg.name)
    save_run_inputs(run_dir, cfg, build)
    log(f"run {run_dir.name} on {device}")
    train_items, val_items = build.splits["train"], build.splits["validation"]

    cache = EncoderCache(cache_root if cache_root is not None else paths.encoder_cache_dir(),
                         CacheSpec(model=base.repo, revision=base.revision, features=base.feature_settings(),
                                   layers=frozen, total_layers=total_layers))
    reused = len({cache.path(i) for i in train_items + val_items}) - len(cache.missing(train_items + val_items))
    created = fill_cache(cache, base, train_items + val_items, device, cfg.evaluation.batch_size, log)
    (run_dir / "cache.json").write_text(json.dumps(
        {"dir": str(cache.root), "created": [str(p) for p in created], "reused": reused,
         "bytes_created": EncoderCache.bytes_of(created)}, indent=2) + "\n")

    max_positions = int(model_config.get("max_target_positions", 448))
    examples = {i.id: whisper.example(base.tokens, i.text, max_positions) for i in train_items + val_items}

    seed_everything(t.seed)
    model = base.load(torch.float32, device)
    model = get_peft_model(model, PeftLoraConfig(r=cfg.lora.rank, lora_alpha=cfg.lora.alpha,
                                                 lora_dropout=cfg.lora.dropout, target_modules=regex,
                                                 bias="none"))
    inner = model.get_base_model()
    trainable = sum(p.numel() for p in model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in model.parameters())
    log(f"LoRA rank {cfg.lora.rank}: {trainable:,} trainable of {total:,} parameters")
    batches = _Batches(cache, examples, base.tokens.eot, device, encoder=inner.model.encoder,
                       top_start=frozen if cfg.lora.encoder_top_layers else None)
    spelling_path = cfg.data.path("spelling")
    spelling = load_spelling(spelling_path) if spelling_path.is_file() else None

    params = [p for p in model.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=t.learning_rate, weight_decay=t.weight_decay)
    n_batches = math.ceil(len(train_items) / t.batch_size)
    steps_per_epoch = math.ceil(n_batches / t.gradient_accumulation)
    total_steps = steps_per_epoch * t.epochs
    warmup = round(t.warmup_fraction * total_steps)
    scheduler = torch.optim.lr_scheduler.LambdaLR(
        optimizer, lambda step: lr_factor(step, warmup, total_steps, t.schedule))
    log(f"{len(train_items)} training clips, {len(val_items)} validation clips; "
        f"{t.epochs} epoch(s) of {steps_per_epoch} step(s), warmup {warmup}")

    metrics: list[dict] = []
    best: dict | None = None

    def evaluate_epoch(epoch: int, train_loss: float | None, step: int, epoch_seconds: float) -> None:
        nonlocal best
        rows, s = validate(inner, batches, val_items, base.tokens, spelling, cfg.evaluation.batch_size,
                           cfg.evaluation.max_new_tokens)
        _write_jsonl(run_dir / "validation" / f"epoch-{epoch}.jsonl", rows)
        row = {
            "epoch": epoch, "step": step, "train_loss": train_loss, "validation_loss": s["loss"],
            "validation_wer": s["wer"], "validation_cer": s["cer"],
            "validation_wer_recordings": s[f"wer_{dataset.SOURCE_RECORDING}"],
            "validation_wer_rehearsal": s[f"wer_{dataset.SOURCE_REHEARSAL}"],
            "validation_wer_by_condition": s["wer_by_condition"],
            "term_accuracy_strict": s["term_accuracy_strict"], "term_accuracy_lenient": s["term_accuracy_lenient"],
            "terms": s["terms"], "learning_rate": scheduler.get_last_lr()[0], "epoch_seconds": round(epoch_seconds, 1),
        }
        metrics.append(row)
        with (run_dir / "metrics.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        plot_metrics(metrics, run_dir / "metrics.png")
        log(format_metrics_row(row))
        if best is None or (row["validation_wer"], row["validation_loss"]) < (best["validation_wer"],
                                                                              best["validation_loss"]):
            best = row
            model.save_pretrained(run_dir / "adapter")
            (run_dir / "best.json").write_text(json.dumps(
                {**row, "note": "epoch 0 is the base model: no epoch beat it" if epoch == 0 else None},
                indent=2) + "\n")

    log(METRICS_HEADER)
    if cfg.evaluation.baseline:
        evaluate_epoch(0, None, 0, 0.0)

    step = 0
    token_counts = {i.id: sum(1 for x in examples[i.id][1] if x != whisper.IGNORE) for i in train_items}
    for epoch in range(1, t.epochs + 1):
        epoch_started = time.time()
        model.train()
        generator = torch.Generator().manual_seed(t.seed * 1000 + epoch)
        order = [train_items[i] for i in torch.randperm(len(train_items), generator=generator).tolist()]
        micro = [order[i:i + t.batch_size] for i in range(0, len(order), t.batch_size)]
        loss_sum, token_sum = 0.0, 0
        for g in range(0, len(micro), t.gradient_accumulation):
            group = micro[g:g + t.gradient_accumulation]
            group_tokens = sum(token_counts[i.id] for batch in group for i in batch)
            optimizer.zero_grad(set_to_none=True)
            for batch in group:
                inputs, labels = batches.tokens(batch)
                loss, n = _loss_sum(inner, batches.hidden(batch), inputs, labels)
                (loss / group_tokens).backward()
                loss_sum += float(loss.detach())
                token_sum += n
            if t.max_grad_norm > 0:
                torch.nn.utils.clip_grad_norm_(params, t.max_grad_norm)
            optimizer.step()
            scheduler.step()
            step += 1
            if step % max(1, steps_per_epoch // 5) == 0 or step == total_steps:
                log(f"  epoch {epoch} step {step}/{total_steps}: loss {loss_sum / max(1, token_sum):.4f}, "
                    f"lr {scheduler.get_last_lr()[0]:.2e}")
        evaluate_epoch(epoch, loss_sum / max(1, token_sum), step, time.time() - epoch_started)

    assert best is not None  # evaluate_epoch keeps the first result it sees
    summary = {
        "name": run_dir.name, "config_hash": config_hash(cfg), "device": device,
        "base": {"repo": base.repo, "revision": base.revision, "path": str(base.path)},
        "trainable_parameters": trainable, "total_parameters": total, "steps": step,
        "best_epoch": best["epoch"], "best_validation_wer": best["validation_wer"],
        "baseline_validation_wer": metrics[0]["validation_wer"] if cfg.evaluation.baseline else None,
        "cache": {"created": len(created), "reused": reused, "bytes_created": EncoderCache.bytes_of(created)},
        "seconds": round(time.time() - started, 1),
    }
    (run_dir / "run.json").write_text(json.dumps(summary, indent=2) + "\n")
    del model, inner, batches
    _free_memory(device)
    note = " (no epoch beat the base model)" if best["epoch"] == 0 else ""
    log(f"best: epoch {best['epoch']}, validation WER {best['validation_wer'] * 100:.2f} %{note}; "
        f"adapter in {run_dir / 'adapter'}")
    return run_dir


METRICS_HEADER = (f"{'epoch':>5} {'train loss':>10} {'val loss':>9} {'val WER %':>9} {'takes %':>8} "
                  f"{'FLEURS %':>8} {'terms strict':>12} {'seconds':>7}")


def format_metrics_row(row: dict) -> str:
    def pct(v):
        return f"{v * 100:.2f}" if v is not None else "-"

    train_loss = f"{row['train_loss']:.4f}" if row["train_loss"] is not None else "-"
    return (f"{row['epoch']:>5} {train_loss:>10} {row['validation_loss']:>9.4f} {pct(row['validation_wer']):>9} "
            f"{pct(row['validation_wer_recordings']):>8} {pct(row['validation_wer_rehearsal']):>8} "
            f"{pct(row['term_accuracy_strict']):>12} {row['epoch_seconds']:>7.0f}")


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train train", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("config", type=Path, help="experiment YAML, e.g. configs/first-frozen-encoder.yaml")
    p.add_argument("--recordings", type=Path, help="takes folder instead of the config's data.recordings")
    p.add_argument("--device", choices=["auto", "mps", "cpu"], help="instead of the config's training.device")
    a = p.parse_args(argv)
    cfg = load_config(a.config)
    if a.recordings:
        cfg = with_overrides(cfg, data={"recordings": str(a.recordings.resolve())})
    if a.device:
        cfg = with_overrides(cfg, training={"device": a.device})
    run_dir = run(cfg)
    print(f"next: wt-train eval --backend lora --run {run_dir.name} --dataset test")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
