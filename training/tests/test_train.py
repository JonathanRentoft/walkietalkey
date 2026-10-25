"""Training on a tiny random Whisper: target modules, schedule, cache, logs and the kept adapter."""

import json
import re

import pytest

from conftest import takes_config, write_takes
from wt_train import train
from wt_train.config import LoraConfig, config_hash
from wt_train.dataset import build


def module_names(tiny_base):
    import torch

    return [n for n, _ in tiny_base.load(torch.float32, "cpu").named_modules()]


def matched(regex, names):
    return sorted(n for n in names if re.fullmatch(regex, n))


def test_target_modules_cover_decoder_attention_cross_attention_and_ffn(tiny_base):
    names = module_names(tiny_base)
    every = matched(train.target_modules(LoraConfig(), 3), names)
    assert len(every) == 2 * (4 + 4 + 2)  # 2 decoder layers
    assert "model.decoder.layers.1.encoder_attn.q_proj" in every and "model.decoder.layers.0.fc2" in every
    assert not any(".encoder." in n for n in every)
    cross_qv = matched(train.target_modules(LoraConfig(decoder=("cross_attn",), projections=("q_proj", "v_proj")), 3),
                       names)
    assert cross_qv == [f"model.decoder.layers.{i}.encoder_attn.{p}" for i in (0, 1) for p in ("q_proj", "v_proj")]


def test_target_modules_add_the_top_encoder_layers(tiny_base):
    names = module_names(tiny_base)
    top = matched(train.target_modules(LoraConfig(encoder_top_layers=1), 3), names)
    encoder = [n for n in top if ".encoder." in n]
    assert encoder == sorted(f"model.encoder.layers.2.{p}" for p in
                             ("self_attn.q_proj", "self_attn.k_proj", "self_attn.v_proj", "self_attn.out_proj",
                              "fc1", "fc2"))
    with pytest.raises(ValueError, match="encoder layers"):
        train.target_modules(LoraConfig(encoder_top_layers=4), 3)


def test_learning_rate_warms_up_then_decays():
    f = [train.lr_factor(s, 2, 10, "linear") for s in range(10)]
    assert f[0] == 0.5 and f[1] == 1.0 and f[2] == 1.0 and f[-1] == pytest.approx(1 / 8)
    assert all(a >= b for a, b in zip(f[1:], f[2:]))
    assert train.lr_factor(9, 0, 10, "cosine") == pytest.approx(0.5 * (1 + __import__("math").cos(0.9 * 3.14159265)), 1e-4)
    assert train.lr_factor(7, 2, 10, "constant") == 1.0


@pytest.fixture
def small_build(tmp_path, fleurs_root):
    folder, sentences, spelling = write_takes(tmp_path, 16)
    cfg = takes_config(folder, sentences, spelling,
                       training={"epochs": 2, "batch_size": 3, "gradient_accumulation": 2, "device": "cpu",
                                 "learning_rate": 0.01},
                       evaluation={"batch_size": 4, "max_new_tokens": 6},
                       lora={"rank": 2, "alpha": 4})
    return cfg, build(cfg, out_dir=tmp_path / "build", fleurs_root=fleurs_root)


def test_a_run_logs_every_epoch_and_keeps_the_best_adapter(tmp_path, tiny_base, small_build):
    cfg, b = small_build
    run = train.run(cfg, base=tiny_base, build=b, runs_root=tmp_path / "runs", cache_root=tmp_path / "cache",
                    log=lambda *_: None)
    metrics = [json.loads(line) for line in (run / "metrics.jsonl").read_text().splitlines()]
    assert [m["epoch"] for m in metrics] == [0, 1, 2]
    assert metrics[0]["train_loss"] is None and all(m["train_loss"] > 0 for m in metrics[1:])
    assert (run / "metrics.png").stat().st_size > 1000
    assert len(list((run / "validation").glob("epoch-*.jsonl"))) == 3
    # Run 4's takes are the Mac's, normal voice: validation WER per recording condition.
    assert all(set(m["validation_wer_by_condition"]) == {"mac-normal"} for m in metrics)

    best = json.loads((run / "best.json").read_text())
    by_wer = min(metrics, key=lambda m: (m["validation_wer"], m["validation_loss"]))
    assert best["epoch"] == by_wer["epoch"]
    assert (run / "adapter" / "adapter_config.json").is_file()
    assert (run / "adapter" / "adapter_model.safetensors").is_file()

    saved = json.loads((run / "config.json").read_text())
    assert saved["hash"] == config_hash(cfg) and saved["config"]["lora"]["rank"] == 2
    for split in ("train", "validation", "test"):
        assert (run / "dataset" / f"{split}.jsonl").read_bytes() == b.manifest(split).read_bytes()
    summary = json.loads((run / "dataset.json").read_text())["summary"]
    assert summary["splits"]["train"]["manifest_sha256"] == b.summary["splits"]["train"]["manifest_sha256"]

    cache = json.loads((run / "cache.json").read_text())
    clips = len(b.splits["train"]) + len(b.splits["validation"])
    assert len(cache["created"]) == clips and cache["reused"] == 0
    info = json.loads((run / "run.json").read_text())
    assert info["trainable_parameters"] > 0 and info["best_epoch"] == best["epoch"]

    # A second run of the same experiment reuses every cache entry.
    again = train.run(cfg, base=tiny_base, build=b, runs_root=tmp_path / "runs", cache_root=tmp_path / "cache",
                      log=lambda *_: None)
    assert again != run
    assert json.loads((again / "cache.json").read_text()) | {"dir": None} == {
        "dir": None, "created": [], "reused": clips, "bytes_created": 0}
    assert train.resolve_run("latest", tmp_path / "runs") == again
    assert train.resolve_run(run.name, tmp_path / "runs") == run
    with pytest.raises(FileNotFoundError):
        train.resolve_run("nope", tmp_path / "runs")


def test_runs_are_seeded(tmp_path, tiny_base, small_build):
    cfg, b = small_build
    runs = [train.run(cfg, base=tiny_base, build=b, runs_root=tmp_path / "runs", cache_root=tmp_path / "cache",
                      log=lambda *_: None) for _ in range(2)]
    losses = [[json.loads(line)["train_loss"] for line in (r / "metrics.jsonl").read_text().splitlines()]
              for r in runs]
    assert losses[0] == pytest.approx(losses[1])


def test_top_encoder_layers_train_from_their_own_cache(tmp_path, tiny_base, small_build):
    from wt_train.config import with_overrides

    cfg, b = small_build
    cfg = with_overrides(cfg, lora={"encoder_top_layers": 1}, training={"epochs": 1},
                         evaluation={"baseline": False})
    run = train.run(cfg, base=tiny_base, build=b, runs_root=tmp_path / "runs", cache_root=tmp_path / "cache",
                    log=lambda *_: None)
    metrics = [json.loads(line) for line in (run / "metrics.jsonl").read_text().splitlines()]
    assert [m["epoch"] for m in metrics] == [1]
    adapter = json.loads((run / "adapter" / "adapter_config.json").read_text())
    assert "encoder" in adapter["target_modules"]
    # Entries hold the output of the 2 frozen layers, keyed apart from full-encoder entries.
    created = json.loads((run / "cache.json").read_text())["created"]
    assert len(created) == len(b.splits["train"]) + len(b.splits["validation"])
