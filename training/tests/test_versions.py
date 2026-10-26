"""Model versions and rollback (run 6, Part 3): every export is a new version in
MLflow's model registry with its run, metrics and config; every run says what
changed (the pipeline around the model, or the model's weights); and
``wt-train use <version|edda>`` switches the app between the installed versions,
so rolling back is switching."""

import json

import pytest

import fake_app
from wt_train import paths, tracking, versions
from wt_train import use as use_step


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_TRACKING", "1")
    monkeypatch.setenv("WT_APP_MODELS_DIR", str(tmp_path / "app-models"))
    (tmp_path / "app-models").mkdir()
    return tmp_path / "work" / "mlflow"


def results_rows(tmp_path, n: int):
    """A results.csv with the first ``n`` rows of the real one (run 4's two baselines, then run 5's app path)."""
    lines = paths.RESULTS_CSV.read_text(encoding="utf-8").splitlines()
    path = tmp_path / "results.csv"
    path.write_text("\n".join(lines[: n + 1]) + "\n", encoding="utf-8")
    return path


def fake_export(tmp_path, version: int, run: str = "first-20261025-1") -> dict:
    """What ``export_run`` returns, with its card and its sidecar in the app's models folder."""
    models = paths.app_models_dir()
    mid = f"edda-ft-first-v{version}"
    card = models / f"{mid}.README.md"
    card.write_text("# Edda finjusteret\n", encoding="utf-8")
    (models / f"{mid}.gguf").write_bytes(b"GGUF")
    result = {"model_id": mid, "name": f"Edda finjusteret (version {version})", "path": str(models / f"{mid}.gguf"),
              "card": str(card), "sha256": "ab" * 32, "size_bytes": 886_000_000, "run": run, "version": version,
              "config_hash": "c0ffee", "validation_wer": 0.061,
              "verify": {"n": 10, "exact_matches": 9, "normalized_matches": 10, "passed": True},
              "seconds": {"merge": 4.0}}
    versions.write_sidecar(models, result)
    return result


# --- the registry -----------------------------------------------------------------


def test_every_export_is_a_new_registered_version_with_its_run_metrics_and_config(store, tmp_path):
    with tracking.run("train", "first-20261025-1") as train:
        train.params({"lora": {"rank": 8}, "config_hash": "c0ffee"})
        train.metrics({"validation/wer": 0.061})
    for v in (1, 2):
        tracking.log_export(fake_export(tmp_path, v))
    c, _ = tracking.client()
    got = sorted(c.search_model_versions(f"name='{versions.REGISTERED_MODEL}'"), key=lambda m: int(m.version))
    assert [int(m.version) for m in got] == [1, 2]
    first = got[0]
    assert first.tags["wt.model_id"] == "edda-ft-first-v1"
    assert first.tags["wt.sha256"] == "ab" * 32
    assert first.tags["wt.train_run"] == "first-20261025-1"
    assert first.tags["wt.config_hash"] == "c0ffee"
    assert first.tags["wt.change"] == "model"
    # The version points at its export run, which sits under the training run, with the metrics and the card.
    export_run = c.get_run(first.run_id)
    assert export_run.data.tags["wt.kind"] == "export"
    assert export_run.data.tags["mlflow.parentRunId"] == train.id
    assert export_run.data.metrics["validation_wer"] == 0.061
    assert first.source == f"runs:/{first.run_id}/model"
    assert "model/edda-ft-first-v1.README.md" in {a.path for a in c.list_artifacts(first.run_id, "model")}


def test_an_export_timed_by_its_real_step_names_is_logged(store, tmp_path):
    # Run 9: export_run times its steps by name, and "verify (merged model)" has brackets, which
    # MLflow refuses in a metric name; the first real export failed there after installing.
    result = fake_export(tmp_path, 1)
    result["seconds"] = {"merge": 4.0, "convert": 30.0, "quantise": 9.0, "verify (merged model)": 20.0,
                         "verify (GGUF)": 12.0, "install": 1.0}
    assert tracking.log_export(result) == 1
    got = tracking.find_runs(kind="export")[0]
    assert got.data.metrics["seconds/verify merged model"] == 20.0
    assert got.data.metrics["seconds/verify GGUF"] == 12.0


def test_versions_count_on_from_the_registry_and_the_installed_files(store, tmp_path):
    models = paths.app_models_dir()
    assert versions.next_version(models) == 1
    fake_export(tmp_path, 1)
    assert versions.next_version(models) == 2  # a sidecar alone counts (tracking may have been off)
    tracking.log_export(fake_export(tmp_path, 2))
    assert versions.next_version(models) == 3


def test_each_version_gets_its_own_file_so_earlier_ones_stay_installed():
    from wt_train import export

    assert export.model_id("first", 3) == "edda-ft-first-v3"
    assert export.model_id("first") == "edda-ft-first"


# --- what changed -------------------------------------------------------------------


def test_every_run_says_whether_the_pipeline_or_the_model_changed(store):
    with tracking.run("train", "t"):
        pass
    with tracking.run("eval", "e", change="pipeline"):
        pass
    with tracking.run("export", "x"):
        pass
    tags = {r.info.run_name: r.data.tags["wt.change"] for r in tracking.find_runs()}
    assert tags == {"t": "model", "e": "pipeline", "x": "model"}
    with pytest.raises(ValueError, match="pipeline, model or data"):
        with tracking.run("eval", "bad", change="weights"):
            pass


def test_run_5s_app_path_result_is_a_pipeline_run_against_run_4(store, tmp_path):
    assert tracking.import_results(results_rows(tmp_path, 3)) == 3
    runs = {r.data.params["timestamp"][:10] + "/" + r.data.params["backend"]: r for r in tracking.find_runs()}
    hf, run4, run5 = runs["2026-10-24/hf"], runs["2026-10-24/gguf"], runs["2026-10-25/gguf"]
    # The two references are baselines; the float16 run measures the weights alone.
    assert (hf.data.tags["wt.kind"], hf.data.tags["wt.change"]) == ("baseline", "model")
    assert (run4.data.tags["wt.kind"], run4.data.tags["wt.change"]) == ("baseline", "pipeline")
    # Run 5 changed only the app around the model: same model file, 8.44 % to 7.63 %.
    assert run5.data.tags["wt.kind"] == "eval"
    assert run5.data.tags["wt.change"] == "pipeline"
    assert run5.data.params["model"] == run4.data.params["model"]
    assert run5.data.tags["wt.compared_to"] == run4.info.run_name
    assert run5.data.metrics["wer_pct"] == 7.63
    assert run5.data.metrics["wer_pct_delta"] == pytest.approx(-0.81)
    assert "without touching the model" in run5.data.tags["mlflow.note.content"]


def test_runs_tracked_before_run_6_get_their_change_tag(store):
    c, experiment = tracking.client()
    old_train = c.create_run(experiment, run_name="old-train", tags={"wt.kind": "train"}).info.run_id
    old_eval = c.create_run(experiment, run_name="old-eval", tags={"wt.kind": "eval"}).info.run_id
    c.log_param(old_eval, "model", paths.SHIPPED_EDDA_ID)
    assert tracking.tag_changes() == 2
    assert c.get_run(old_train).data.tags["wt.change"] == "model"
    assert c.get_run(old_eval).data.tags["wt.change"] == "pipeline"
    assert tracking.tag_changes() == 0


# --- switching ------------------------------------------------------------------------


def test_versions_resolve_by_number_by_id_and_edda(store, tmp_path):
    tracking.log_export(fake_export(tmp_path, 1))
    assert versions.resolve("edda") == paths.SHIPPED_EDDA_ID
    assert versions.resolve("1") == "edda-ft-first-v1"
    assert versions.resolve("v1") == "edda-ft-first-v1"
    assert versions.resolve("edda-ft-first-v1") == "edda-ft-first-v1"
    with pytest.raises(versions.VersionError, match="no version 7"):
        versions.resolve("7")


def test_versions_resolve_from_the_installed_files_without_tracking(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_APP_MODELS_DIR", str(tmp_path / "app-models"))
    (tmp_path / "app-models").mkdir()
    fake_export(tmp_path, 4)
    assert versions.resolve("4") == "edda-ft-first-v4"


def test_wt_train_use_switches_the_app_and_marks_the_version_in_the_registry(store, tmp_path, monkeypatch, capsys):
    tracking.log_export(fake_export(tmp_path, 1))
    tracking.log_export(fake_export(tmp_path, 2))
    binary, log = fake_app.install(tmp_path, monkeypatch, batch=True)
    monkeypatch.setenv("WT_APP_BIN", str(binary))
    monkeypatch.setenv("FAKE_APP_USE_EXIT", "0")
    assert use_step.main(["2"]) == 0
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    assert ["--use-model", "edda-ft-first-v2"] in calls
    c, _ = tracking.client()
    assert int(c.get_model_version_by_alias(versions.REGISTERED_MODEL, versions.APP_ALIAS).version) == 2
    # Rolling back is switching: to version 1, then to the base Edda.
    assert use_step.main(["1"]) == 0
    assert int(c.get_model_version_by_alias(versions.REGISTERED_MODEL, versions.APP_ALIAS).version) == 1
    assert use_step.main(["edda"]) == 0
    assert ["--use-model", paths.SHIPPED_EDDA_ID] in [json.loads(x) for x in log.read_text().splitlines()]
    with pytest.raises(Exception):
        c.get_model_version_by_alias(versions.REGISTERED_MODEL, versions.APP_ALIAS)
    assert "Edda v0.2" in capsys.readouterr().out


def test_wt_train_use_refuses_a_version_the_app_does_not_have(store, tmp_path, monkeypatch, capsys):
    tracking.log_export(fake_export(tmp_path, 1))
    (paths.app_models_dir() / "edda-ft-first-v1.gguf").unlink()
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    monkeypatch.setenv("WT_APP_BIN", str(binary))
    monkeypatch.setenv("FAKE_APP_USE_EXIT", "0")
    assert use_step.main(["1"]) == 1
    assert "not installed" in capsys.readouterr().err


def test_wt_train_use_needs_an_app_that_can_switch(store, tmp_path, monkeypatch, capsys):
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    monkeypatch.setenv("WT_APP_BIN", str(binary))
    assert use_step.main(["edda"]) == 1
    assert "update WalkieTalkey" in capsys.readouterr().err


def test_wt_train_use_lists_the_versions(store, tmp_path, monkeypatch, capsys):
    tracking.log_export(fake_export(tmp_path, 1))
    assert use_step.main(["--list"]) == 0
    out = capsys.readouterr().out
    assert "edda" in out and "edda-ft-first-v1" in out and "6.10 %" in out
