"""The WER normaliser's version (run 11): every tracked run says which normaliser scored it, so
the evaluations before run 8's fix (26 October 2026) are never compared with the ones after."""

from datetime import date, datetime

import pytest

from wt_train import normaliser, paths, tracking


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_TRACKING", "1")


def test_the_normaliser_in_models_eval_has_a_version_number():
    # Changed models/eval/wt_eval/normalize.py or danish_numbers.py? Add its fingerprint to
    # normaliser.VERSIONS as the next version, with the day it takes over, and bump CURRENT.
    assert normaliser.current() == normaliser.CURRENT, (
        f"the normaliser's fingerprint {normaliser.fingerprint()} is not in normaliser.VERSIONS")
    assert normaliser.VERSIONS[-1].number == normaliser.CURRENT


def test_the_versions_count_up_in_time_with_distinct_files():
    numbers = [v.number for v in normaliser.VERSIONS]
    assert numbers == list(range(1, len(numbers) + 1))
    assert normaliser.VERSIONS[0].since is None
    days = [v.since for v in normaliser.VERSIONS[1:]]
    assert days == sorted(days) and len(set(days)) == len(days)
    assert len({v.sha for v in normaliser.VERSIONS}) == len(numbers)
    assert normaliser.VERSIONS[1].since == date(2026, 10, 26)


def test_the_fingerprint_covers_both_files_and_ignores_line_ends(tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    for folder, end in ((a, "\n"), (b, "\r\n")):
        folder.mkdir()
        (folder / "normalize.py").write_bytes(f"def normalize(t):{end}    return t{end}".encode())
        (folder / "danish_numbers.py").write_bytes(f"ONES = []{end}".encode())
    assert normaliser.fingerprint(a) == normaliser.fingerprint(b)
    (b / "danish_numbers.py").write_text("ONES = ['nul']\n")
    assert normaliser.fingerprint(a) != normaliser.fingerprint(b)
    assert normaliser.current(a) is None
    assert [f.name for f in normaliser.files()] == ["normalize.py", "danish_numbers.py"]
    assert normaliser.files()[0].parent == paths.MODELS_EVAL / "wt_eval"


def test_a_run_without_the_tag_is_classified_by_its_day():
    assert normaliser.of_date(date(2026, 10, 24)) == 1
    assert normaliser.of_date(date(2026, 10, 25)) == 1
    assert normaliser.of_date(date(2026, 10, 26)) == 2
    assert normaliser.of_date(date(2027, 3, 1)) == 2
    assert normaliser.of_run({}, datetime(2026, 10, 25, 23, 59)) == 1
    assert normaliser.of_run({}, datetime(2026, 10, 26, 0, 1)) == 2
    assert normaliser.of_run({"wt.normaliser": "1"}, datetime(2026, 10, 27)) == 1, "the tag wins"
    assert normaliser.of_run({"wt.normaliser": "unknown"}, datetime(2026, 10, 27)) is None
    assert normaliser.of_run({}, None) is None


def test_every_tracked_run_carries_the_normaliser(store):
    with tracking.run("eval", "e1") as r:
        pass
    with tracking.run("train", "t1"):
        pass
    for run in tracking.find_runs():
        assert run.data.tags["wt.normaliser"] == str(normaliser.CURRENT)
        assert run.data.tags["wt.normaliser_sha"] == normaliser.fingerprint()
    assert r.id


def test_an_eval_logged_now_carries_the_normaliser(store, tmp_path):
    out = tmp_path / "20261027-120000-gguf-x"
    out.mkdir()
    run_id = tracking.log_eval({"out": str(out), "backend": "gguf", "model": paths.SHIPPED_EDDA_ID,
                                "dataset": "fleurs-da_dk-test", "metrics": {"fleurs-da_dk-test": {"wer": 0.07}}})
    c, _ = tracking.client()
    assert c.get_run(run_id).data.tags["wt.normaliser"] == str(normaliser.CURRENT)


def test_an_edited_normaliser_is_tagged_unknown(store, monkeypatch):
    monkeypatch.setattr(normaliser, "fingerprint", lambda root=None: "0" * 16)
    with tracking.run("eval", "edited"):
        pass
    (run,) = tracking.find_runs()
    assert run.data.tags["wt.normaliser"] == "unknown" and run.data.tags["wt.normaliser_sha"] == "0" * 16
