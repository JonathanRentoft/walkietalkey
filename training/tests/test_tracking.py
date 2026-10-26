"""Experiment tracking (run 5, Part 4): MLflow in the git-ignored work folder,
telemetry off, results.csv rows as the first runs, and the UI on 127.0.0.1."""

import csv
import os
import socket
import subprocess

import pytest

from wt_train import evaluate, paths, tracking, ui


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_TRACKING", "1")
    return tmp_path / "work" / "mlflow"


def first_rows(tmp_path, n: int = 2):
    """A results.csv with the first ``n`` rows of the real one: run 4's two FLEURS baselines."""
    lines = paths.RESULTS_CSV.read_text(encoding="utf-8").splitlines()
    path = tmp_path / "results.csv"
    path.write_text("\n".join(lines[: n + 1]) + "\n", encoding="utf-8")
    return path


def test_telemetry_is_off_here_and_in_the_ui_server():
    # Set when wt_train.tracking is imported, before mlflow ever is.
    assert os.environ["MLFLOW_DISABLE_TELEMETRY"] == "true" and os.environ["DO_NOT_TRACK"] == "true"
    env = ui.environment()
    assert env["MLFLOW_DISABLE_TELEMETRY"] == "true" and env["DO_NOT_TRACK"] == "true"
    assert env["MLFLOW_DISABLE_AGENT_HINT"] == "1"


def test_the_store_is_in_the_work_folder_which_git_ignores(store):
    assert tracking.tracking_uri() == f"sqlite:///{store / 'mlflow.db'}"
    assert tracking.artifact_root() == store / "artifacts"
    ignored = subprocess.run(["git", "check-ignore", "-q", str(paths.TRAINING / "work" / "mlflow" / "mlflow.db")],
                             cwd=paths.REPO)
    assert ignored.returncode == 0


def test_a_run_keeps_params_per_step_metrics_and_artifacts(store, tmp_path):
    plot = tmp_path / "metrics.png"
    plot.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 16)
    with tracking.run("train", "first-1") as r:
        r.params({"lora": {"rank": 16, "decoder": ["self_attn", "ffn"]}, "config_hash": "abc", "note": None})
        for step, loss in enumerate([2.0, 1.5, 1.2], start=1):
            r.metrics({"train.loss": loss}, step=step)
        r.metrics({"validation": {"loss": 1.1, "wer_pct": 9.5, "skipped": "text"}}, step=1)
        r.artifact(plot)
        r.text("a | b\n", "per-term.md")
    c, _ = tracking.client()
    got = tracking.find_runs(kind="train")[0]
    assert (got.info.run_name, got.info.status) == ("first-1", "FINISHED")
    assert got.data.params["lora.rank"] == "16"
    assert got.data.params["lora.decoder"] == '["self_attn", "ffn"]'
    assert got.data.params["note"] == ""
    assert [m.value for m in c.get_metric_history(got.info.run_id, "train.loss")] == [2.0, 1.5, 1.2]
    assert [m.step for m in c.get_metric_history(got.info.run_id, "train.loss")] == [1, 2, 3]
    assert got.data.metrics["validation/wer_pct"] == 9.5 and "validation/skipped" not in got.data.metrics
    assert sorted(a.path for a in c.list_artifacts(got.info.run_id)) == ["metrics.png", "per-term.md"]
    assert got.data.tags["wt.git_commit"] and got.data.tags["wt.git_dirty"] in ("true", "false")


def test_a_block_that_raises_leaves_a_failed_run(store):
    with pytest.raises(RuntimeError):
        with tracking.run("train", "boom"):
            raise RuntimeError("out of memory")
    assert tracking.find_runs(name="boom")[0].info.status == "FAILED"


def test_a_run_stopped_with_ctrl_c_ends_killed(store):
    # Run 9: Værkstedet stops a training with SIGINT; that is a stop, not a failure.
    with pytest.raises(KeyboardInterrupt):
        with tracking.run("train", "stopped") as r:
            raise KeyboardInterrupt
    c, _ = tracking.client()
    assert c.get_run(r.id).info.status == "KILLED"


def test_an_eval_nests_under_its_training_run(store):
    with tracking.run("train", "t") as parent:
        with tracking.run("eval", "t-test", parent=parent) as kid:
            kid.metrics({"test": {"wer_pct": 5.0}})
    kid = tracking.find_runs(kind="eval")[0]
    assert kid.data.tags["mlflow.parentRunId"] == tracking.find_runs(kind="train")[0].info.run_id


def test_tracking_off_writes_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_TRACKING", "0")
    with tracking.run("train", "x") as r:
        r.params({"a": 1})
        r.metrics({"b": 2.0}, step=3)
        r.text("hi", "a.txt")
    assert not (tmp_path / "work" / "mlflow").exists()
    assert tracking.import_results(first_rows(tmp_path)) == 0


def test_the_dataset_fingerprint_counts_clips_per_split_and_condition():
    splits = {
        "train": [{"id": "s1-a", "audio_sha256": "1", "device": "iphone", "style": "whisper"},
                  {"id": "s2-a", "audio_sha256": "2", "condition": "mac-normal"},
                  {"id": "f1", "audio_sha256": "3", "source": "fleurs"}],
        "validation": [{"id": "s3-a", "audio_sha256": "4", "device": "iphone", "style": "normal"}],
        "test": [],
    }
    fp = tracking.dataset_fingerprint(splits)
    assert fp["counts"] == {"test.total": 0, "train.fleurs": 1, "train.iphone-whisper": 1, "train.mac-normal": 1,
                            "train.total": 3, "validation.iphone-normal": 1, "validation.total": 1}
    reordered = {**splits, "train": list(reversed(splits["train"]))}
    assert tracking.dataset_fingerprint(reordered)["fingerprint"] == fp["fingerprint"]
    other_audio = {**splits, "train": [dict(splits["train"][0], audio_sha256="9")] + splits["train"][1:]}
    assert tracking.dataset_fingerprint(other_audio)["fingerprint"] != fp["fingerprint"]


def test_results_csv_rows_become_baseline_runs_once(store, tmp_path):
    results = first_rows(tmp_path)
    assert tracking.import_results(results) == 2
    assert tracking.import_results(results) == 0
    runs = tracking.find_runs(kind="baseline")
    assert sorted(r.data.metrics["wer_pct"] for r in runs) == [7.21, 8.44]
    hf = next(r for r in runs if r.data.params["backend"] == "hf")
    assert (hf.data.metrics["wer_ci95_low_pct"], hf.data.metrics["wer_ci95_high_pct"]) == (6.66, 7.78)
    assert hf.data.metrics["n"] == 930 and hf.data.metrics["cer_pct"] == 2.61
    assert hf.data.tags["wt.git_commit"].startswith("37c834e3")
    assert "baseline" in hf.data.tags["mlflow.note.content"]


def test_fleurs_rows_import_without_term_accuracy(store, tmp_path):
    # Run 8: rows from before run 8 counted FLEURS words such as "test" as English terms.
    path = tmp_path / "results.csv"
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=evaluate.RESULT_COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerow({**{c: "" for c in evaluate.RESULT_COLUMNS}, "timestamp": "2026-10-25T02:16:19+02:00",
                    "backend": "gguf", "model": "m", "dataset": "fleurs-da_dk-test", "n": "930", "wer_pct": "7.63",
                    "terms": "8", "terms_strict": "5", "terms_lenient": "5", "term_accuracy_strict_pct": "62.50",
                    "term_accuracy_lenient_pct": "62.50", "notes": "run 5"})
        w.writerow({**{c: "" for c in evaluate.RESULT_COLUMNS}, "timestamp": "2026-10-26T10:00:00+02:00",
                    "backend": "lora", "model": "t", "dataset": "t:test", "n": "40", "wer_pct": "9.00",
                    "terms": "20", "terms_strict": "15", "term_accuracy_strict_pct": "75.00", "notes": "own takes"})
    assert tracking.import_results(path) == 2
    by_dataset = {r.data.params["dataset"]: r.data.metrics for r in tracking.find_runs()}
    assert by_dataset["fleurs-da_dk-test"]["wer_pct"] == 7.63
    assert not [k for k in by_dataset["fleurs-da_dk-test"] if k.startswith("term")]
    assert by_dataset["t:test"]["term_accuracy_strict_pct"] == 75.0 and by_dataset["t:test"]["terms"] == 20


def test_the_ui_serves_the_local_store_on_localhost_only(store):
    cmd = ui.command(5055)
    assert cmd[1:4] == ["-m", "mlflow", "ui"]
    assert cmd[cmd.index("--host") + 1] == "127.0.0.1"
    assert cmd[cmd.index("--port") + 1] == "5055"
    assert cmd[cmd.index("--backend-store-uri") + 1] == tracking.tracking_uri()


def test_a_busy_port_is_skipped():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        busy = s.getsockname()[1]
        assert ui.free_port(busy, tries=5) != busy


def test_a_file_can_be_attached_to_a_finished_run(store, tmp_path):
    """Run 7: a report page goes onto its evaluation's run afterwards."""
    with tracking.run("eval", "e") as r:
        pass
    page = tmp_path / "report.html"
    page.write_text("<!doctype html>", encoding="utf-8")
    assert tracking.attach(r.id, page, "report")
    c, _ = tracking.client()
    assert [a.path for a in c.list_artifacts(r.id, "report")] == ["report/report.html"]
    assert not tracking.attach("0" * 32, page)
    assert not tracking.attach(r.id, tmp_path / "missing.html")


def test_a_pilot_run_changes_the_data():
    assert tracking.DEFAULT_CHANGE["pilot"] == "data"
