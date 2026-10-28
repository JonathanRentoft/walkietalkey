"""Run 12, test only on purpose: Værkstedet measures on the validation by default, the test set
only after a confirm (and says so in WT_TEST_USE_SOURCE), shows every use of the test set from
its log and whether it is frozen, and marks a test result as test."""

import json
import sys

import pytest

from fake_studio import get, post, start_server, stop_server, write_places
from wt_train.studio import measure, runs


@pytest.fixture
def places(tmp_path, monkeypatch):
    return write_places(tmp_path, monkeypatch)


@pytest.fixture
def server(places):
    srv = start_server(places)
    yield srv
    stop_server(srv)


# --- what an evaluation measured on -------------------------------------------------------


@pytest.mark.parametrize("dataset, summary, split", [
    ("first-frozen-encoder-20261026-2112:test", None, "test"),
    ("first-frozen-encoder-20261026-2112:test@phone-whisper", None, "test"),
    ("tiny:validation", None, "validation"),
    ("tiny:train", None, "train"),
    ("fleurs-da_dk-test", None, "fleurs"),
    ("exam", None, "exam"),
    ("exam@mac-normal", None, "exam"),
    ("own-clips", None, None),
    # summary.json says it once the eval writes it.
    ("own-clips", {"split": "test"}, "test"),
    ("tiny:validation", {"split": "Validation"}, "validation"),
    ("fleurs-da_dk-test", {"split": "fleurs-test"}, "fleurs"),
])
def test_what_an_evaluation_measured_on(dataset, summary, split):
    assert runs.split_of(dataset, summary) == split


# --- the test set: frozen, and every use -----------------------------------------------------


def test_no_lock_and_no_uses_yet(server):
    assert get(server, "/api/eval/testset") == (200, {"lock": None, "uses": [], "count": 0})


def test_the_lock_and_every_use_newest_first(server, places):
    places.test_lock.write_text(json.dumps({"created": "2026-10-28T21:00:00+01:00", "build": "first-frozen-encoder",
                                            "sentences": [f"s{i:04d}" for i in range(104)],
                                            "clips": [f"c{i}" for i in range(312)], "sha256": "ab" * 32}))
    places.work.mkdir(parents=True, exist_ok=True)
    places.test_uses.write_text("\n".join([
        json.dumps({"at": "2026-10-28T21:10:00+01:00", "runs": ["tiny-20261028-200000"], "backend": "lora",
                    "build": None, "eval_run": "20261028-211000-lora-tiny", "source": "cli"}),
        "not json",
        json.dumps(["not", "a", "use"]),
        json.dumps({"runs": ["no time"]}),
        "",
        json.dumps({"at": "2026-10-28T22:30:00+01:00", "runs": [], "backend": "hf", "build": "tiny",
                    "eval_run": "20261028-223000-hf-edda", "source": "studio"}),
        '{"at": "2026-10-28T23:00:00+01:00", "runs": "a-run", "source": "elsewhere"',  # cut off: skipped
    ]) + "\n", encoding="utf-8")
    t = get(server, "/api/eval/testset")[1]
    assert t["lock"] == {"created": "2026-10-28T21:00:00+01:00", "build": "first-frozen-encoder", "sentences": 104,
                         "clips": 312, "sha256": "ab" * 32}
    assert t["count"] == 2
    assert [u["eval_run"] for u in t["uses"]] == ["20261028-223000-hf-edda", "20261028-211000-lora-tiny"]
    assert t["uses"][0] == {"at": "2026-10-28T22:30:00+01:00", "runs": [], "backend": "hf", "build": "tiny",
                            "eval_run": "20261028-223000-hf-edda", "source": "studio"}
    assert t["uses"][1]["runs"] == ["tiny-20261028-200000"] and t["uses"][1]["source"] == "cli"


def test_a_lock_with_counts_instead_of_lists(server, places):
    places.test_lock.write_text(json.dumps({"created": "2026-10-28", "sentences": 50, "clips": 150}))
    assert get(server, "/api/eval/testset")[1]["lock"] == {"created": "2026-10-28", "build": None, "sentences": 50,
                                                           "clips": 150, "sha256": None}
    places.test_lock.write_text("{broken")
    assert get(server, "/api/eval/testset")[1]["lock"] is None


# --- measuring --------------------------------------------------------------------------------


def training_run(places, name="tiny-20261028-120000", splits=("validation", "test")):
    run = places.runs / name
    (run / "adapter").mkdir(parents=True)
    (run / "dataset").mkdir()
    (run / "config.json").write_text("{}")
    (run / "adapter" / "adapter_config.json").write_text("{}")
    (run / "best.json").write_text(json.dumps({"epoch": 1, "validation_wer": 0.12}))
    for s in splits:
        (run / "dataset" / f"{s}.jsonl").write_text("")
    return name


def build(places, name="tiny", splits=("validation", "test")):
    folder = places.work / "builds" / name
    folder.mkdir(parents=True)
    for s in splits:
        (folder / f"{s}.jsonl").write_text("")


@pytest.fixture
def recorded(tmp_path, monkeypatch):
    """wt-train eval, played by a script that writes down its arguments and its environment."""
    out = tmp_path / "eval-calls.jsonl"

    def stand_in(*args):
        assert args[0] == "eval"
        return [sys.executable, "-c", f"""
import json, os, sys
with open({str(out)!r}, "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "source": os.environ.get("WT_TEST_USE_SOURCE"),
                         "work": os.environ.get("WT_WORK_DIR")}}) + "\\n")
print("eval: done")
""", *args[1:]]

    monkeypatch.setattr(measure, "step_argv", stand_in)
    return lambda: [json.loads(line) for line in out.read_text().splitlines()] if out.is_file() else []


def wait(srv, job):
    assert srv.jobs.get(job["id"]).done.wait(30)
    return get(srv, f"/api/jobs/{job['id']}")[1]


def test_what_can_be_measured(server, places):
    name = training_run(places)
    training_run(places, "half-20261027-120000", splits=("validation",))
    no_adapter = places.runs / "plain-1"
    no_adapter.mkdir(parents=True)
    (no_adapter / "config.json").write_text("{}")
    build(places, splits=("validation",))
    t = get(server, "/api/eval/measure")[1]
    by_name = {r["name"]: r for r in t["runs"]}
    assert set(by_name) == {name, "half-20261027-120000"}
    assert by_name[name]["title"] == "Edda finjusteret (tiny)" and by_name[name]["best_validation_wer"] == 0.12
    assert (by_name[name]["validation"], by_name[name]["test"]) == (True, True)
    assert by_name["half-20261027-120000"]["test"] is False
    assert t["configs"] == [{"name": "tiny", "validation": True, "test": False}]
    assert t["base"] == "Edda, original" and t["job"] is None


def test_a_training_run_is_measured_on_the_validation_as_a_job(server, places, recorded):
    name = training_run(places)
    status, job = post(server, "/api/eval/measure", {"backend": "lora", "run": name, "dataset": "validation"})
    assert status == 200 and job["kind"] == "eval"
    assert job["title"] == "Måling på valideringen: Edda finjusteret (tiny)"
    assert wait(server, job)["status"] == "done"
    (call,) = recorded()
    assert call["argv"] == ["--backend", "lora", "--run", name, "--dataset", "validation", "--spelling",
                            str(places.spelling)]
    assert call["source"] == "studio" and call["work"] == str(places.work)
    assert get(server, "/api/eval/measure")[1]["job"]["id"] == job["id"]


def test_edda_on_a_builds_validation_without_fleurs(server, places, recorded):
    build(places)
    status, job = post(server, "/api/eval/measure", {"backend": "hf", "build": "tiny", "fleurs": False})
    assert status == 200 and job["title"] == "Måling på valideringen: Edda, original · tiny"
    wait(server, job)
    assert recorded()[0]["argv"] == ["--backend", "hf", "--build", "tiny", "--dataset", "validation", "--spelling",
                                     str(places.spelling), "--no-fleurs"]


def test_the_test_set_only_after_a_confirm(server, places, recorded):
    name = training_run(places)
    for confirm in (None, False, "yes", 1):
        body = {"backend": "lora", "run": name, "dataset": "test", **({"confirm": confirm} if confirm is not None else {})}
        status, e = post(server, "/api/eval/measure", body)
        assert (status, e["error"]) == (409, "confirm")
    assert recorded() == [] and server.jobs.latest("eval") is None
    status, job = post(server, "/api/eval/measure", {"backend": "lora", "run": name, "dataset": "test",
                                                     "confirm": True})
    assert status == 200 and job["title"] == "Måling på testsættet: Edda finjusteret (tiny)"
    wait(server, job)
    (call,) = recorded()
    assert call["argv"][call["argv"].index("--dataset") + 1] == "test" and call["source"] == "studio"


def test_measuring_errors(server, places, recorded):
    name = training_run(places, splits=("validation",))
    cases = [({"backend": "lora", "run": "nope"}, 404, "unknown"),
             ({"backend": "lora", "run": "../tiny"}, 404, "unknown"),
             ({"backend": "lora", "run": name, "dataset": "test", "confirm": True}, 409, "no-split"),
             ({"backend": "hf", "build": "tiny"}, 409, "no-build"),
             ({"backend": "hf", "build": "../x"}, 404, "unknown"),
             ({"backend": "gguf", "run": name}, 400, "backend"),
             ({"backend": "lora", "run": name, "dataset": "train"}, 400, "dataset")]
    for body, status, error in cases:
        got = post(server, "/api/eval/measure", body)
        assert (got[0], got[1]["error"]) == (status, error), body
    assert recorded() == []


def test_one_measurement_at_a_time(server, places, monkeypatch):
    name = training_run(places)
    monkeypatch.setattr(measure, "step_argv", lambda *a: [sys.executable, "-c", "import time; time.sleep(30)"])
    status, job = post(server, "/api/eval/measure", {"backend": "lora", "run": name})
    assert status == 200
    assert post(server, "/api/eval/measure", {"backend": "lora", "run": name})[1]["error"] == "busy"
    post(server, f"/api/jobs/{job['id']}/stop")
    assert server.jobs.get(job["id"]).done.wait(30)


def test_a_stand_in_for_wt_train_eval(monkeypatch):
    monkeypatch.setenv("WT_STUDIO_EVAL", "/tmp/fake-eval")
    assert measure.eval_argv("--backend", "hf") == ["/tmp/fake-eval", "--backend", "hf"]
    monkeypatch.delenv("WT_STUDIO_EVAL")
    assert measure.eval_argv("--backend", "hf")[1:] == ["-m", "wt_train", "eval", "--backend", "hf"]


# --- a test result is marked as test ------------------------------------------------------------


@pytest.fixture
def store(monkeypatch):
    monkeypatch.setenv("WT_TRACKING", "1")


def test_the_evaluations_say_what_they_measured_on(places, store, make_wav):
    from wt_train import metrics, per_condition, tracking

    def logged(name, dataset, split=None):
        folder = places.eval_runs / name
        folder.mkdir(parents=True)
        wav = make_wav(places.work / "wavs" / f"{name}.wav", seed=1, seconds=0.3)
        row = {**metrics.score_clip("c1", "vi ses i morgen", "vi ses i morgen"), "wav": str(wav), "condition": ""}
        summary = metrics.summarize([row])
        (folder / "summary.json").write_text(json.dumps({"backend": "lora", "model": "tiny-1", "results":
                                                         {dataset: summary}, **({"split": split} if split else {})}))
        return tracking.log_eval({"out": str(folder), "backend": "lora", "model": "tiny-1", "dataset": dataset,
                                  "train_run": "tiny-1", "metrics": per_condition.for_logging(summary, {}, dataset)})

    test_id = logged("20261028-100000-lora-tiny-1", "tiny-1:test")
    val_id = logged("20261028-110000-lora-tiny-1", "tiny-1:validation")
    said_id = logged("20261028-120000-lora-tiny-1", "held-out-clips", split="test")
    fleurs_id = logged("20261028-130000-lora-tiny-1", "fleurs-da_dk-test")
    srv = start_server(places)
    try:
        by_id = {r["id"]: r for r in get(srv, "/api/eval/runs")[1]}
        assert by_id[test_id]["split"] == "test" and by_id[val_id]["split"] == "validation"
        assert by_id[said_id]["split"] == "test" and by_id[fleurs_id]["split"] == "fleurs"
    finally:
        stop_server(srv)
