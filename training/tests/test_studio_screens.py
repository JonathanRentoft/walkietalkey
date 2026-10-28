"""Værkstedet's other screens (run 9): the data and its leakage checks, training with its
progress and caffeinate, evaluations and their pages, versions, the pilot comparison and the
lab journal, edited only under the owner's two headings."""

import json
import sys
import time

import pytest

import fake_app
from conftest import write_fleurs
from fake_studio import App, get, good, post, request, start_server, stop_server, write_places
from wt_train import paths
from wt_train.studio import labels, notebook
from wt_train.studio.training import read_progress


@pytest.fixture
def places(tmp_path, monkeypatch):
    return write_places(tmp_path, monkeypatch)


@pytest.fixture
def server(places):
    srv = start_server(places)
    yield srv
    stop_server(srv)


def record(srv, places, ids=("s0001", "s0002", "s0003")):
    post(srv, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})
    app = App(srv, places)
    app.hello()
    for n, i in enumerate(ids):
        app.take(i, good(seconds=2.0 + 0.05 * n))  # distinct audio, or the leakage check finds it twice
    assert srv.reviewer.idle(10)
    return app


# --- data --------------------------------------------------------------------------------


def test_the_data_a_config_would_train_on(server, places):
    record(server, places)
    post(server, "/api/recording/redo", {"id": "s0002"})
    status, d = get(server, "/api/data")
    assert status == 200
    assert d["config"] == "tiny" and d["configs"] == ["tiny"]
    assert d["fractions"] == {"validation": 0.25, "test": 0.25}
    assert d["sentences"] == {"total": 4, "plain": 2, "terms": 2, "recorded": 2, "own": 0}
    # Run 12: the split record as the config would deal it (nothing is written by looking).
    assert d["split"]["params"] == {"seed": 3, "validation_fraction": 0.25, "test_fraction": 0.25,
                                    "held_out_terms": []}
    assert sum(d["split"]["sentences"].values()) == 4 and d["split"]["locked"] is False
    pw = {c["id"]: c for c in d["conditions"]}["phone-whisper"]
    assert pw["takes"] == 2 and pw["label"] == "Telefonen, hvisket"
    assert sum(s["takes"] for s in pw["split"].values()) == 2
    assert {"id": "s0002.phone-whisper", "reason": "marked for a new take"} in d["skipped"]
    assert d["rehearsal"] == {"share": 0.3, "validation_share": 0.3}
    leak = d["leakage"]
    checks = {c["id"]: c for c in leak["checks"]}
    assert list(checks) == ["splits", "fleurs-test", "exam", "pilot"]
    assert checks["splits"]["label"] == "Træning, validering og test deler ingen sætninger"
    assert checks["splits"]["ok"] is True and checks["exam"]["ok"] is True and checks["pilot"]["ok"] is True
    # FLEURS is not downloaded in the tmp work folder: that check alone is unknown.
    assert checks["fleurs-test"]["ok"] is None and "wt-train fetch" in checks["fleurs-test"]["detail"]
    assert leak["ran"] is True and leak["ok"] is None and leak["message"] is None
    assert get(server, "/api/data?config=nope")[1]["error"] == "unknown"


def test_a_leak_names_its_check(server, places, tmp_path):
    record(server, places, ids=("s0001",))
    # The pilot holds the same sentence as a take: the pilot check fails, the others pass.
    places.pilot_sentences.write_text('id,text,kind\npilot-01,"Vi merger PR\'en, når buildet er grønt.",terms\n',
                                      encoding="utf-8")
    write_fleurs(paths.fleurs_dir(), "test", [("x0", "2000", "Testsætning alfa.")], seed0=900)
    leak = get(server, "/api/data")[1]["leakage"]
    checks = {c["id"]: c for c in leak["checks"]}
    assert checks["pilot"]["ok"] is False and checks["pilot"]["overlap"] == 1
    assert checks["fleurs-test"]["ok"] is True and checks["splits"]["ok"] is True
    assert leak["ok"] is False and "a pilot sentence" in leak["message"]


def test_the_data_is_cached_until_a_folder_changes(server, places, monkeypatch):
    from wt_train import dataset

    record(server, places, ids=("s0001",))
    calls = []
    real = dataset.load_recordings
    monkeypatch.setattr(dataset, "load_recordings", lambda *a, **k: calls.append(1) or real(*a, **k))
    first = get(server, "/api/data")[1]
    assert get(server, "/api/data")[1] == first and len(calls) == 1
    app = App(server, places)
    app.take("s0002", good(seconds=2.3))
    assert server.reviewer.idle(10)
    assert get(server, "/api/data")[1]["sentences"]["recorded"] == 2 and len(calls) == 2


# --- training ----------------------------------------------------------------------------


def test_every_setting_of_a_config_with_its_label(server):
    status, configs = get(server, "/api/training/configs")
    assert status == 200 and [c["name"] for c in configs] == ["tiny"]
    tiny = configs[0]
    assert tiny["file"] == "configs/tiny.yaml"
    by_key = {s["key"]: s for s in tiny["settings"]}
    assert list(by_key)[:3] == ["name", "base_model.repo", "base_model.revision"]
    assert by_key["training.learning_rate"] == {"key": "training.learning_rate", "section": "training",
                                                "value": 0.0001,
                                                "label": "Hvor store skridt modellen tager, når den lærer",
                                                "section_label": "Træning",
                                                "help": labels.ESSENTIALS["training.learning_rate"]}
    assert by_key["data.seed"]["help"] is None
    assert by_key["training.epochs"]["value"] == 1 and by_key["name"]["section"] is None
    assert by_key["lora.decoder"]["value"] == ["self_attn", "cross_attn", "ffn"]
    assert all(s["label"] != s["key"] for s in tiny["settings"])


def test_a_config_that_does_not_load_says_why(server, places):
    (places.configs / "broken.yaml").write_text("name: broken\ntraining:\n  epochs: zero\n", encoding="utf-8")
    broken = {c["name"]: c for c in get(server, "/api/training/configs")[1]}["broken"]
    assert broken["settings"] == [] and "epochs" in broken["error"]


def fake_caffeinate(tmp_path):
    """Stays while the process -w names lives, like caffeinate."""
    script = tmp_path / "caffeinate"
    script.write_text(f"""#!{sys.executable}
import os, sys, time
pid = int(sys.argv[sys.argv.index("-w") + 1])
open({str(tmp_path / 'caffeinate.args')!r}, "w").write(" ".join(sys.argv[1:]))
while True:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        break
    time.sleep(0.1)
""")
    script.chmod(0o755)
    return script


def test_a_training_runs_as_a_job_beside_caffeinate_and_its_failure_shows(places, tmp_path):
    srv = start_server(places, caffeinate=[str(fake_caffeinate(tmp_path))])
    try:
        status, job = post(srv, "/api/training/start", {"config": "tiny"})
        assert status == 200 and job["kind"] == "train" and job["title"] == "Træning: tiny"
        assert job["status"] == "running"
        assert post(srv, "/api/training/start", {"config": "tiny"})[1]["error"] == "busy"
        assert get(srv, "/api/overview")[1]["training"] == {"running": True, "config": "tiny"}
        state = get(srv, "/api/training/state")[1]
        assert state["progress"]["config"] == "tiny"
        assert srv.jobs.get(job["id"]).done.wait(120)
        state = get(srv, "/api/training/state")[1]
        # No takes in the tmp recordings: the build fails, and the progress says so.
        assert state["job"]["status"] == "failed"
        assert state["progress"]["phase"] == "failed" and "no recordings folder" in state["progress"]["message"]
        assert state["progress"]["awake"] is False
        args = (tmp_path / "caffeinate.args").read_text()
        assert args == f"-i -w {srv.jobs.get(job['id']).pid}"
        assert any("--recordings" in line or "no recordings folder" in line for line in state["job"]["log"])
    finally:
        stop_server(srv)


def test_training_errors(server):
    assert post(server, "/api/training/start", {"config": "nope"})[1]["error"] == "unknown"
    assert post(server, "/api/training/start", {"config": "../tiny"})[1]["error"] == "unknown"
    assert post(server, "/api/training/stop")[1]["error"] == "not-running"


def test_a_running_training_stops(places, tmp_path, monkeypatch):
    from wt_train.studio import training

    progress = {}

    def slow(*args):
        out = args[args.index("--progress") + 1]
        progress["file"] = out
        return [sys.executable, "-c", f"""
import json, time
f = open({out!r}, "a")
for e in [{{"event": "phase", "phase": "build"}}, {{"event": "run", "name": "tiny-1", "dir": "/x"}},
          {{"event": "plan", "epochs": 2, "steps_per_epoch": 3, "total_steps": 6}}, {{"event": "phase", "phase": "train"}},
          {{"event": "step", "step": 1, "epoch": 1, "loss": 1.9, "lr": 0.0001}}]:
    f.write(json.dumps(e) + "\\n"); f.flush()
try:
    time.sleep(30)
except KeyboardInterrupt:
    f.write(json.dumps({{"event": "stopped"}}) + "\\n")
"""]

    monkeypatch.setattr(training, "step_argv", slow)
    srv = start_server(places, caffeinate=[str(fake_caffeinate(tmp_path))])
    try:
        status, job = post(srv, "/api/training/start", {"config": "tiny"})
        deadline = time.time() + 20
        while time.time() < deadline and get(srv, "/api/training/state")[1]["progress"]["step"] != 1:
            time.sleep(0.1)
        p = get(srv, "/api/training/state")[1]["progress"]
        assert (p["run"], p["phase"], p["epochs"], p["total_steps"], p["step"]) == ("tiny-1", "train", 2, 6, 1)
        assert p["train_loss"] == [[1, 1.9]] and p["awake"] is True
        status, stopped = post(srv, "/api/training/stop")
        assert status == 200
        assert srv.jobs.get(job["id"]).done.wait(20)
        state = get(srv, "/api/training/state")[1]
        assert state["job"]["status"] == "stopped" and state["progress"]["phase"] == "stopped"
    finally:
        stop_server(srv)


def test_the_progress_file_becomes_curves(tmp_path):
    f = tmp_path / "p.jsonl"
    events = [{"event": "phase", "phase": "build"}, {"event": "run", "name": "r", "dir": "/r"},
              {"event": "plan", "epochs": 2, "steps_per_epoch": 2, "total_steps": 4},
              {"event": "phase", "phase": "validate"},
              {"event": "epoch", "epoch": 0, "step": 0, "train_loss": None, "validation_loss": 1.7,
               "validation_wer": 0.21},
              {"event": "step", "step": 1, "epoch": 1, "loss": 1.92, "lr": 1e-4},
              {"event": "step", "step": 2, "epoch": 1, "loss": 1.85, "lr": 1e-4},
              {"event": "epoch", "epoch": 1, "step": 2, "train_loss": 1.88, "validation_loss": 1.41,
               "validation_wer": 0.17},
              {"event": "done", "run": "r", "best_epoch": 1, "best_validation_wer": 0.17}]
    f.write_text("".join(json.dumps(e) + "\n" for e in events) + '{"event": "st')
    p = read_progress(f)
    assert p["phase"] == "done" and p["run"] == "r" and (p["epoch"], p["epochs"], p["step"]) == (1, 2, 2)
    assert p["train_loss"] == [[1, 1.92], [2, 1.85]]
    assert p["validation_loss"] == [[0, 1.7], [2, 1.41]] and p["validation_wer"] == [[0, 0.21], [2, 0.17]]
    assert (p["best_epoch"], p["best_validation_wer"]) == (1, 0.17)


def test_earlier_training_runs_are_listed(server, places):
    run = places.runs / "tiny-20261027-120000"
    (run / "adapter").mkdir(parents=True)
    (run / "config.json").write_text("{}")
    (run / "adapter" / "adapter_config.json").write_text("{}")
    (run / "run.json").write_text(json.dumps({"best_epoch": 3, "best_validation_wer": 0.12,
                                              "baseline_validation_wer": 0.2}))
    runs = get(server, "/api/training/state")[1]["runs"]
    assert runs[0]["name"] == run.name and runs[0]["best_epoch"] == 3 and runs[0]["baseline_validation_wer"] == 0.2
    assert get(server, "/api/training/state")[1]["progress"] is None


# --- evaluations -----------------------------------------------------------------------


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setenv("WT_TRACKING", "1")


def eval_folder(places, name, make_wav, hyp="vi ses i morgen"):
    from wt_train import metrics, per_condition

    folder = places.eval_runs / name
    folder.mkdir(parents=True)
    wav = make_wav(places.work / "wavs" / f"{name}.wav", seed=1, seconds=0.3)
    rows = [{**metrics.score_clip("c1", "vi ses i morgen", hyp), "wav": str(wav), "condition": ""}]
    summary = metrics.summarize(rows)
    (folder / "fleurs-da-dk-test.jsonl").write_text(json.dumps(rows[0]) + "\n", encoding="utf-8")
    (folder / "summary.json").write_text(json.dumps({"backend": "gguf", "model": paths.SHIPPED_EDDA_ID,
                                                     "results": {"fleurs-da_dk-test": summary},
                                                     "by_condition": {}, "metrics": {}}))
    return folder, summary


def log_eval(folder, summary):
    from wt_train import per_condition, tracking

    return tracking.log_eval({"out": str(folder), "backend": "gguf", "model": paths.SHIPPED_EDDA_ID,
                              "dataset": "fleurs-da_dk-test",
                              "metrics": per_condition.for_logging(summary, {}, "fleurs-da_dk-test")})


def test_evaluations_from_mlflow_with_their_numbers_and_pages(places, store, make_wav):
    from wt_train import tracking

    a, sa = eval_folder(places, "20261026-170753-gguf-a", make_wav)
    b, sb = eval_folder(places, "20261027-090000-gguf-b", make_wav, hyp="vi ses i går")
    id_a, id_b = log_eval(a, sa), log_eval(b, sb)
    results = places.work / "results.csv"
    results.write_text(paths.RESULTS_CSV.read_text(encoding="utf-8").splitlines()[0] + "\n"
                       + paths.RESULTS_CSV.read_text(encoding="utf-8").splitlines()[1] + "\n", encoding="utf-8")
    tracking.import_results(results)
    srv = start_server(places)
    try:
        status, runs = get(srv, "/api/eval/runs")
        assert status == 200 and len(runs) == 3
        by_id = {r["id"]: r for r in runs}
        ra = by_id[id_a]
        assert (ra["kind"], ra["dataset"], ra["model"], ra["backend"], ra["clips"]) == (
            "eval", "fleurs-da_dk-test", "edda-v0.2 (app)", "gguf", 1)
        assert ra["wer"] == 0.0 and ra["cer"] == 0.0 and ra["change"] == "pipeline" and ra["report"] is None
        assert by_id[id_b]["wer"] == pytest.approx(0.25) and len(by_id[id_b]["wer_ci"]) == 2
        baseline = next(r for r in runs if r["kind"] == "baseline")
        assert 0 < baseline["wer"] < 0.2 and baseline["clips"] == 930 and baseline["wer_ci"][0] < baseline["wer"]
        assert runs[0]["date"] >= runs[-1]["date"]
        # Its page, written once as a job and reused.
        status, page = post(srv, "/api/eval/report", {"run": id_a})
        assert status == 200 and page["url"] == f"/reports/{a.name}.html" and page["job"]
        assert request(srv, "GET", page["url"])[0] == 200
        assert post(srv, "/api/eval/report", {"run": id_a})[1] == {"url": page["url"]}
        assert {r["id"]: r for r in get(srv, "/api/eval/runs")[1]}[id_a]["report"] == page["url"]
        status, both = post(srv, "/api/eval/compare", {"a": id_b, "b": id_a})
        assert status == 200 and both["url"] == "/reports/20261027-090000-gguf-vs-20261026-170753-gguf.html"
        assert (places.reports / both["url"].split("/")[-1]).is_file()
        assert post(srv, "/api/eval/report", {"run": baseline["id"]})[1]["error"] == "no-folder"
        assert post(srv, "/api/eval/report", {"run": "f" * 32})[1]["error"] == "unknown"
    finally:
        stop_server(srv)


def test_no_evaluations_when_tracking_is_off(server):
    assert get(server, "/api/eval/runs") == (200, [])
    assert post(server, "/api/eval/report", {"run": "x"})[1]["error"] == "tracking-off"


# --- versions ----------------------------------------------------------------------------


def test_versions_the_model_in_the_app_and_what_can_be_exported(places, monkeypatch, tmp_path):
    models = places.app_models
    models.mkdir(parents=True)
    (models / paths.SHIPPED_EDDA_FILE).write_bytes(b"gguf")
    (models / "edda-ft-first-v2.gguf").write_bytes(b"gguf")
    (models / "edda-ft-first-v2.json").write_text(json.dumps(
        {"model_id": "edda-ft-first-v2", "version": 2, "name": "Edda finjusteret (forsøg 1)", "run": "first-1",
         "created": "2026-10-27T12:00:00+01:00", "validation_wer": 0.12}))
    (models.parent / "settings_store.json").write_text(json.dumps({"settings": {"selected_model": "edda-ft-first-v2"}}))
    run = places.runs / "first-1"
    (run / "adapter").mkdir(parents=True)
    (run / "config.json").write_text("{}")
    (run / "adapter" / "adapter_config.json").write_text("{}")
    (run / "best.json").write_text(json.dumps({"epoch": 2, "validation_wer": 0.12}))
    binary, log = fake_app.install(tmp_path, monkeypatch, batch=True)
    monkeypatch.setenv("FAKE_APP_USE_EXIT", "0")
    from wt_train.app import App

    srv = start_server(places, find_app=lambda: App(binary))
    try:
        v = get(srv, "/api/versions")[1]
        assert v["app"] == {"found": True, "version": None, "use": True}
        assert v["in_app"] == "edda-ft-first-v2"
        assert v["base"] == {"id": paths.SHIPPED_EDDA_ID, "name": "Edda", "installed": True}
        assert v["versions"] == [{"version": 2, "id": "edda-ft-first-v2", "name": "Edda finjusteret (forsøg 1)",
                                  "run": "first-1", "date": "2026-10-27T12:00:00+01:00", "validation_wer": 0.12,
                                  "installed": True, "in_app": True}]
        assert v["exportable"] == [{"run": "first-1", "date": v["exportable"][0]["date"], "best_validation_wer": 0.12}]
        status, used = post(srv, "/api/versions/use", {"version": "edda"})
        assert status == 200 and used["ok"] and used["in_app"] == paths.SHIPPED_EDDA_ID
        assert "--use-model" in log.read_text()
        status, bad = post(srv, "/api/versions/use", {"version": 9})
        assert status == 409 and bad["error"] == "use-failed"
        assert post(srv, "/api/versions/export", {"run": "nope"})[1]["error"] == "unknown"
        assert post(srv, "/api/versions/export", {"run": "../first-1"})[1]["error"] == "unknown"
        status, job = post(srv, "/api/versions/export", {"run": "first-1"})
        assert status == 200 and job["kind"] == "export" and job["title"] == "Eksport: first-1"
        assert srv.jobs.get(job["id"]).done.wait(120)
    finally:
        stop_server(srv)


# --- the pilot ---------------------------------------------------------------------------


def test_the_pilot_comparison_runs_as_a_job(places, tmp_path, monkeypatch):
    import dataclasses

    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    srv = start_server(dataclasses.replace(places, app_bin=binary))
    try:
        post(srv, "/api/recording/start", {"kind": "pilot", "id": "iphone-whisper"})
        app = App(srv, places)
        app.hello()
        app.take("pilot-01", good())
        app.take("pilot-02", good())
        assert srv.reviewer.idle(10)
        status, job = post(srv, "/api/pilot/compare")
        assert status == 200 and job["kind"] == "pilot" and job["title"] == "Pilotens sammenligning"
        assert post(srv, "/api/pilot/compare")[1]["error"] == "busy"
        assert srv.jobs.get(job["id"]).done.wait(120), srv.jobs.get(job["id"]).log
        pilot = get(srv, "/api/pilot")[1]
        assert pilot["job"]["status"] == "done", pilot["job"]["log"]
        c = pilot["comparison"]
        assert c["model"] == paths.SHIPPED_EDDA_ID and c["generated_at"]
        assert c["report"].startswith("/reports/pilot-") and request(srv, "GET", c["report"])[0] == 200
        (setup,) = c["setups"]
        assert setup["name"] == "iphone-whisper" and setup["label"] == "iPhone, hvisket" and setup["clips"] == 2
        assert setup["wer"] is not None and setup["level_dbfs"] < -30 and setup["seconds"] == pytest.approx(2.9, 0.1)
        assert isinstance(setup["notes"], list) and pilot["job"]["result"]["setups"][0]["name"] == "iphone-whisper"
        assert c["left_out"] == []
    finally:
        stop_server(srv)


# --- the journal -------------------------------------------------------------------------

CARD = """# first-frozen-encoder-20261027-120000 (2026-10-27)

kind train, commit abc.

## Numbers

| metric | value |
|---|---:|
| best/epoch | 3 |

## Hypothesis

## What I changed

## What happened

## What I learned

"""


def test_saving_replaces_only_the_two_sections(tmp_path):
    out = notebook.replace_sections(CARD, {"Hypothesis": "Whispers need more data.", "What I learned": "Yes."})
    assert out == CARD.replace("## Hypothesis\n\n", "## Hypothesis\n\nWhispers need more data.\n\n") \
        .replace("## What I learned\n\n", "## What I learned\n\nYes.\n")
    assert notebook.section(out, "Hypothesis") == "Whispers need more data."
    assert notebook.section(out, "What I learned") == "Yes."
    again = notebook.replace_sections(out, {"Hypothesis": "", "What I learned": "Yes."})
    assert again == CARD.replace("## What I learned\n\n", "## What I learned\n\nYes.\n")


def test_a_page_the_owner_edited_by_hand_keeps_every_other_byte():
    hand = ("# my run (2026-10-27)\n\nSome notes  with  spaces\t\n\n## Hypothesis\nold idea\nsecond line\n\n"
            "### a sub heading stays inside\n\n## What I changed\n- the *rank*\n\n## What I learned\n"
            "first thought\n## After\nkept, æøå\n")
    out = notebook.replace_sections(hand, {"Hypothesis": "new idea\r\nover two lines", "What I learned": "learned"})
    assert out.startswith("# my run (2026-10-27)\n\nSome notes  with  spaces\t\n\n## Hypothesis\n")
    assert "\n## What I changed\n- the *rank*\n\n## What I learned\n" in out
    assert out.endswith("## What I learned\n\nlearned\n\n## After\nkept, æøå\n")
    assert notebook.section(out, "Hypothesis") == "new idea\nover two lines" and "\r" not in out
    assert "### a sub heading" not in out, "the sub heading was part of the section"
    unchanged = notebook.replace_sections(hand, {"Hypothesis": notebook.section(hand, "Hypothesis")})
    assert unchanged == hand


def test_a_missing_heading_is_added_at_the_end():
    out = notebook.replace_sections("# x\n\n## Hypothesis\n\nidea\n", {"Hypothesis": "idea", "What I learned": "a"})
    assert out == "# x\n\n## Hypothesis\n\nidea\n\n## What I learned\n\na\n"
    assert notebook.replace_sections("# x", {"What I learned": "b"}) == "# x\n\n## What I learned\n\nb\n"


def test_journal_pages_are_listed_read_and_saved(server, places):
    places.journal.mkdir(parents=True)
    page = places.journal / "2026-10-27-first-frozen-encoder-20261027-120000.md"
    page.write_text(CARD, encoding="utf-8")
    (places.journal / "notes.txt").write_text("not a page")
    status, listing = get(server, "/api/journal")
    assert status == 200 and listing["runs"] == []
    assert listing["pages"] == [{"name": page.stem, "title": "first-frozen-encoder-20261027-120000 (2026-10-27)",
                                 "date": "2026-10-27", "run": "first-frozen-encoder-20261027-120000",
                                 "notes": {"hypothesis": False, "learned": False}}]
    status, read = get(server, f"/api/journal/{page.stem}")
    assert read == {"name": page.stem, "title": "first-frozen-encoder-20261027-120000 (2026-10-27)",
                    "markdown": CARD, "hypothesis": "", "learned": "", "files": f"/files/journal/{page.stem}/"}
    status, saved = post(server, f"/api/journal/{page.stem}", {"hypothesis": "Mere hvisken.", "learned": "Ja."})
    assert status == 200 and saved["hypothesis"] == "Mere hvisken." and saved["learned"] == "Ja."
    raw = page.read_bytes()
    assert b"\r" not in raw and raw.decode("utf-8") == saved["markdown"]
    assert get(server, "/api/journal")[1]["pages"][0]["notes"] == {"hypothesis": True, "learned": True}
    assert get(server, "/api/journal/nope")[1]["error"] == "unknown"
    assert get(server, "/api/journal/..%2Fsecret")[0] == 404
    assert post(server, "/api/journal/nope", {"hypothesis": "x"})[1]["error"] == "unknown"
    assert post(server, f"/api/journal/{page.stem}", {"hypothesis": 3})[1]["error"] == "text"


def test_a_page_is_written_for_a_tracked_run_once(places, store):
    from wt_train import tracking

    with tracking.run("train", "first-frozen-encoder-20261027-120000") as r:
        r.metrics({"best": {"epoch": 3}})
    srv = start_server(places)
    try:
        runs = get(srv, "/api/journal")[1]["runs"]
        assert runs[0]["run"] == "first-frozen-encoder-20261027-120000" and runs[0]["kind"] == "train"
        assert runs[0]["page"] is None
        status, page = post(srv, "/api/journal", {"run": "first-frozen-encoder-20261027-120000"})
        assert status == 200 and page["title"].startswith("first-frozen-encoder-20261027-120000")
        assert (places.journal / f"{page['name']}.md").is_file()
        assert get(srv, "/api/journal")[1]["runs"][0]["page"] == page["name"]
        status, again = post(srv, "/api/journal", {"run": "first-frozen-encoder-20261027-120000"})
        assert status == 409 and again["error"] == "exists"
        assert post(srv, "/api/journal", {"run": "nope"})[1]["error"] == "unknown"
    finally:
        stop_server(srv)


# --- the review's findings: the journal (run 9) --------------------------------------------


def test_a_heading_typed_into_a_section_does_not_split_it(server, places):
    places.journal.mkdir(parents=True)
    page = places.journal / "2026-10-27-run.md"
    page.write_text(CARD, encoding="utf-8")
    typed = "Idé:\n## Mere data\nog\n##  to mellemrum"
    status, saved = post(server, f"/api/journal/{page.stem}", {"hypothesis": typed, "learned": "## Lært"})
    assert status == 200
    assert saved["hypothesis"] == "Idé:\n### Mere data\nog\n###  to mellemrum"
    assert saved["learned"] == "### Lært"
    again = get(server, f"/api/journal/{page.stem}")[1]
    assert again["hypothesis"] == saved["hypothesis"] and again["learned"] == "### Lært"
    assert "## What I changed\n\n## What happened" in again["markdown"], "the other sections stay"


def test_any_plain_page_name_in_the_journal_opens(server, places):
    places.journal.mkdir(parents=True)
    page = places.journal / "Mit forsøg (æøå) 2.md"
    page.write_text(CARD, encoding="utf-8")
    (places.journal / ".skjult.md").write_text(CARD, encoding="utf-8")
    (places.journal.parent / "secret.md").write_text("secret", encoding="utf-8")
    names = [p["name"] for p in get(server, "/api/journal")[1]["pages"]]
    assert names == ["Mit forsøg (æøå) 2"]
    from urllib.parse import quote

    status, read = get(server, f"/api/journal/{quote(page.stem)}")
    assert status == 200 and read["name"] == page.stem and read["files"] == f"/files/journal/{page.stem}/"
    assert post(server, f"/api/journal/{quote(page.stem)}", {"learned": "Ja."})[1]["learned"] == "Ja."
    for bad in ("..%2Fsecret", "%2E%2E%2Fsecret", ".skjult", "a%5Cb", "%2Fetc%2Fpasswd"):
        assert get(server, f"/api/journal/{bad}")[0] == 404, bad
