"""Tracking in train, eval and export (run 5, Part 4): what each run leaves in MLflow."""

import csv
import json

import pytest

import fake_app
from conftest import takes_config, write_fleurs, write_takes
from wt_train import evaluate, paths, smoke, tracking, train
from wt_train.config import config_hash
from wt_train.dataset import build


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_TRACKING", "1")


@pytest.fixture
def small_build(tmp_path, fleurs_root):
    folder, sentences, spelling = write_takes(tmp_path, 16)
    cfg = takes_config(folder, sentences, spelling,
                       training={"epochs": 2, "batch_size": 3, "gradient_accumulation": 2, "device": "cpu",
                                 "learning_rate": 0.01},
                       evaluation={"batch_size": 4, "max_new_tokens": 6},
                       lora={"rank": 2, "alpha": 4})
    return cfg, build(cfg, out_dir=tmp_path / "build", fleurs_root=fleurs_root)


def history(run, key):
    c, _ = tracking.client()
    return [(m.step, m.value) for m in c.get_metric_history(run.info.run_id, key)]


def artifacts(run) -> set[str]:
    c, _ = tracking.client()
    return {a.path for a in c.list_artifacts(run.info.run_id)}


def test_training_logs_config_dataset_loss_per_step_validation_per_epoch_and_plot(store, tmp_path, tiny_base,
                                                                                   small_build):
    cfg, b = small_build
    with tracking.run("train", cfg.name) as tracked:
        run_dir = train.run(cfg, base=tiny_base, build=b, runs_root=tmp_path / "runs", cache_root=tmp_path / "cache",
                            log=lambda *_: None, tracked=tracked)
    (got,) = tracking.find_runs(kind="train")
    assert got.info.run_name == run_dir.name and got.info.status == "FINISHED"
    params = got.data.params
    assert params["lora.rank"] == "2" and params["training.epochs"] == "2"
    assert params["config_hash"] == config_hash(cfg)
    fingerprint = tracking.dataset_fingerprint(b.splits)
    assert params["dataset.fingerprint"] == fingerprint["fingerprint"]
    for key, count in fingerprint["counts"].items():
        assert params[f"dataset.counts.{key}"] == str(count)
    # Train loss for every optimiser step, validation for every epoch (0 = the base model).
    steps = history(got, "train/loss")
    assert [s for s, _ in steps] == list(range(1, len(steps) + 1)) and len(steps) >= 2
    assert all(v > 0 for _, v in steps)
    assert [s for s, _ in history(got, "train/learning_rate")] == [s for s, _ in steps]
    assert [s for s, _ in history(got, "validation/loss")] == [0, 1, 2]
    assert [s for s, _ in history(got, "validation/wer")] == [0, 1, 2]
    assert [s for s, _ in history(got, "validation/mac-normal/wer")] == [0, 1, 2]
    assert got.data.metrics["best/epoch"] in (0, 1, 2)
    assert {"metrics.png", "metrics.jsonl", "best.json", "run.json", "config.json"} <= artifacts(got)


def test_wt_train_train_opens_the_tracked_run(store, tmp_path, monkeypatch):
    seen = {}

    def fake_run(cfg, **kw):
        seen["tracked"] = kw.get("tracked")
        run_dir = tmp_path / "runs" / "smoke-1"
        run_dir.mkdir(parents=True)
        return run_dir

    monkeypatch.setattr(train, "run", fake_run)
    assert train.main([str(paths.CONFIGS / "smoke.yaml")]) == 0
    (got,) = tracking.find_runs(kind="train")
    assert seen["tracked"].id == got.info.run_id and got.info.status == "FINISHED"


def gguf_eval(tmp_path, make_wav, monkeypatch, *extra):
    work = tmp_path / "work"
    write_fleurs(work / "datasets" / "fleurs-da_dk", "test",
                 [(f"x{i}", f"{3000 + i}", f"Sætning {i}.") for i in range(4)], seed0=40)
    folder = tmp_path / "clips"
    for i, (name, text) in enumerate({"a": "Vi deployede den i går.", "b": "Hej med dig."}.items()):
        make_wav(folder / f"{name}.wav", seed=i)
        (folder / f"{name}.txt").write_text(text, encoding="utf-8")
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text("terms:\n  deploy:\n    forms: [deploye, deployede]\n", encoding="utf-8")
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    return evaluate.main(["--backend", "gguf", "--model", "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
                          "--dataset", str(folder), "--app-bin", str(binary), "--spelling", str(spelling),
                          "--results", str(tmp_path / "results.csv"), *extra], log=lambda *_: None)


def test_an_eval_logs_every_metric_the_fleurs_regression_terms_and_transcripts(store, tmp_path, make_wav,
                                                                               monkeypatch):
    assert gguf_eval(tmp_path, make_wav, monkeypatch) == 0
    (got,) = tracking.find_runs(kind="eval")
    params, metrics = got.data.params, got.data.metrics
    assert params["backend"] == "gguf" and params["dataset"] == "clips"
    assert params["model"] == "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf"
    assert metrics["clips/wer"] == 0 and metrics["clips/n"] == 2
    assert metrics["fleurs-da_dk-test/wer"] > 0  # the regression check (the fake app answers "hej")
    # Run 8: term accuracy for the owner's clips only, never for the FLEURS check.
    assert metrics["clips/terms"] == 1 and not [k for k in metrics if k.startswith("fleurs-da_dk-test/term")]
    assert "mlflow.parentRunId" not in got.data.tags  # no training run behind a base-model eval
    assert {"summary.json", "terms.md", "side-by-side.md"} <= artifacts(got)
    (out,) = list((tmp_path / "work" / "runs" / "eval").iterdir())
    terms = (out / "terms.md").read_text(encoding="utf-8")
    assert "| deploy | 1 | 1 | 0 |" in terms
    side = (out / "side-by-side.md").read_text(encoding="utf-8")
    assert "Hej med dig." in side and "| id |" in side


def test_a_fleurs_eval_counts_no_terms_and_is_tracked_as_asked(store, tmp_path, make_wav, monkeypatch):
    # Run 8: FLEURS's "terms" are ordinary Danish words; a rescoring is a pipeline change with a note,
    # and the results.csv row it appends is not imported a second time by wt-train ui.
    work = tmp_path / "work"
    write_fleurs(work / "datasets" / "fleurs-da_dk", "test",
                 [(f"x{i}", f"{3000 + i}", f"Vi deployede den {i}.") for i in range(3)], seed0=40)
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text("terms:\n  deploy:\n    forms: [deploye, deployede]\n", encoding="utf-8")
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    results = tmp_path / "results.csv"
    code = evaluate.main(["--backend", "gguf", "--model", "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
                          "--app-bin", str(binary), "--spelling", str(spelling), "--results", str(results),
                          "--change", "pipeline", "--notes", "normaliser fix, run 8"], log=lambda *_: None)
    assert code == 0
    with results.open(newline="") as f:
        (written,) = list(csv.DictReader(f))
    assert written["dataset"] == evaluate.FLEURS_TEST and written["fleurs_n"] == "3"
    for column in ("terms", "terms_strict", "terms_lenient", "term_accuracy_strict_pct", "term_accuracy_lenient_pct"):
        assert written[column] == ""
    (out,) = list((work / "runs" / "eval").iterdir())
    summary = json.loads((out / "summary.json").read_text(encoding="utf-8"))["results"][evaluate.FLEURS_TEST]
    assert summary["terms"] is None and summary["term_accuracy_strict"] is None
    assert not (out / "terms.md").exists()
    (got,) = tracking.find_runs(kind="eval")
    assert got.data.tags["wt.change"] == "pipeline"
    assert got.data.tags["mlflow.note.content"] == "normaliser fix, run 8"
    assert not [k for k in got.data.metrics if "term" in k]
    assert tracking.import_results(results) == 0
    assert len(tracking.find_runs()) == 1


def test_an_eval_measures_the_model_unless_told(store, tmp_path, make_wav, monkeypatch):
    assert gguf_eval(tmp_path, make_wav, monkeypatch, "--change", "model") == 0
    assert tracking.find_runs(kind="eval")[0].data.tags["wt.change"] == "model"
    with pytest.raises(SystemExit):
        gguf_eval(tmp_path, make_wav, monkeypatch, "--change", "weather")


def test_an_eval_of_a_trained_run_sits_under_it(store, tmp_path):
    with tracking.run("train", "first-20261025-1"):
        pass
    out = tmp_path / "eval-out"
    out.mkdir()
    (out / "summary.json").write_text("{}", encoding="utf-8")
    report = {"exit_code": 0, "backend": "lora", "model": "first-20261025-1", "dataset": "test",
              "train_run": "first-20261025-1", "metrics": {"test/wer": 0.071, "test/iphone-whisper/wer": 0.09},
              "out": out}
    tracking.log_eval(report)
    (got,) = tracking.find_runs(kind="eval")
    (parent,) = tracking.find_runs(kind="train")
    assert got.data.tags["mlflow.parentRunId"] == parent.info.run_id
    assert got.data.metrics["test/iphone-whisper/wer"] == 0.09


def test_an_export_sits_under_its_training_run_with_its_card(store, tmp_path):
    with tracking.run("train", "first-20261025-1"):
        pass
    card = tmp_path / "edda-ft-first.README.md"
    card.write_text("# Edda finjusteret\n", encoding="utf-8")
    result = {"model_id": "edda-ft-first", "name": "Edda finjusteret (forsøg 1)", "path": "/x/edda-ft-first.gguf",
              "card": str(card), "sha256": "ab" * 32, "size_bytes": 886_000_000, "run": "first-20261025-1",
              "verify": {"n": 10, "exact_matches": 9, "normalized_matches": 10, "passed": True},
              "seconds": {"merge": 4.0, "convert": 9.5}}
    tracking.log_export(result)
    (got,) = tracking.find_runs(kind="export")
    (parent,) = tracking.find_runs(kind="train")
    assert got.data.tags["mlflow.parentRunId"] == parent.info.run_id
    assert got.data.params["model_id"] == "edda-ft-first" and got.data.params["sha256"] == "ab" * 32
    assert got.data.metrics["size_bytes"] == 886_000_000 and got.data.metrics["verify/exact_matches"] == 9
    assert got.data.metrics["verify/passed"] == 1 and got.data.metrics["seconds/convert"] == 9.5
    # Run 6: the card and export.json sit under model/, the folder its registered version points at.
    c, _ = tracking.client()
    assert {a.path for a in c.list_artifacts(got.info.run_id, "model")} == {"model/edda-ft-first.README.md",
                                                                            "model/export.json"}
    assert got.data.tags["wt.change"] == "model"


def test_the_smoke_test_tracks_nothing(store, monkeypatch):
    seen = {}

    def stop():
        seen["enabled"] = tracking.enabled()
        raise RuntimeError("stop here")

    monkeypatch.setattr(smoke.paths, "work_dir", stop)
    with pytest.raises(RuntimeError, match="stop here"):
        smoke.main([])
    assert seen == {"enabled": False}
