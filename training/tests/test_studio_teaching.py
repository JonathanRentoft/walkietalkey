"""Værkstedet teaches (run 11): evaluations under readable names, grouped by the normaliser
that counted them; the four settings a beginner should touch first, each saying what turning it
up or down does."""

import json
from datetime import datetime

import pytest

from fake_studio import get, start_server, stop_server, write_places
from wt_train import paths
from wt_train.studio import labels, runs


@pytest.fixture
def places(tmp_path, monkeypatch):
    return write_places(tmp_path, monkeypatch)


@pytest.fixture
def server(places):
    srv = start_server(places)
    yield srv
    stop_server(srv)


# --- readable names ---------------------------------------------------------------------

EDDA_HF = "danish-foundation-models/edda-v0.2@698f8d04b597"


@pytest.mark.parametrize("backend, model, dataset, train_run, title", [
    ("hf", EDDA_HF, "fleurs-da_dk-test", None, "Edda, original · FLEURS"),
    ("gguf", paths.SHIPPED_EDDA_ID, "fleurs-da_dk-test", None, "Appen · FLEURS"),
    ("gguf", "edda-ft-first-v2", "first-frozen-encoder-20261028-101500:test", "first-frozen-encoder-20261028-101500",
     "Edda finjusteret v2 · Dine optagelser"),
    ("lora", "first-frozen-encoder-20261028-101500", "first-frozen-encoder-20261028-101500:test",
     "first-frozen-encoder-20261028-101500", "Edda finjusteret (first-frozen-encoder) · Dine optagelser"),
    ("gguf", paths.SHIPPED_EDDA_ID, "first-frozen-encoder-20261028-101500:validation", None,
     "Appen · Dine optagelser, validering"),
    ("gguf", paths.SHIPPED_EDDA_ID, "exam", None, "Appen · Dine optagelser, eksamen"),
    ("gguf", paths.SHIPPED_EDDA_ID, "exam@phone-whisper", None,
     "Appen · Dine optagelser, eksamen (Telefonen, hvisket)"),
    ("gguf", paths.SHIPPED_EDDA_ID, "first-1:test@mac-normal", None,
     "Appen · Dine optagelser (Mac'en, almindelig stemme)"),
    ("hf", "local-whisper", "mine-klip", None, "local-whisper · mine-klip"),
])
def test_a_run_is_named_by_its_model_and_its_data(backend, model, dataset, train_run, title):
    assert runs.eval_title(backend, model, dataset, train_run) == title


def test_two_runs_that_would_share_a_name_get_their_day_then_their_time():
    rows = [{"title": "Appen · FLEURS", "when": datetime.fromisoformat("2026-10-26T17:07:53+01:00")},
            {"title": "Edda, original · FLEURS", "when": datetime.fromisoformat("2026-10-26T16:54:46+01:00")},
            {"title": "Appen · FLEURS", "when": datetime.fromisoformat("2026-10-25T02:16:19+02:00")},
            {"title": "Appen · FLEURS", "when": datetime.fromisoformat("2026-10-25T18:54:51+02:00")},
            {"title": "Appen · Dine optagelser", "when": None}]
    assert runs.unique_titles(rows) == [
        "Appen · FLEURS · 26. okt.", "Edda, original · FLEURS", "Appen · FLEURS · 25. okt. kl. 02.16",
        "Appen · FLEURS · 25. okt. kl. 18.54", "Appen · Dine optagelser"]


def test_the_danish_words_have_no_em_dash():
    for text in [*labels.EVAL_MODELS.values(), *labels.EVAL_DATA.values(), *labels.MONTHS]:
        assert "—" not in text and "–" not in text and text == text.strip()
    assert len(labels.MONTHS) == 12


# --- the owner's store, as it is today ------------------------------------------------------


def owners_store(places):
    """Five eval runs: three results.csv rows from 24 and 25 October (the old normaliser) and two
    tracked evaluations from 26 October, from before runs were tagged with their normaliser."""
    from wt_train import tracking

    lines = paths.RESULTS_CSV.read_text(encoding="utf-8").splitlines()
    results = places.work / "results.csv"
    results.parent.mkdir(parents=True, exist_ok=True)
    results.write_text("\n".join(lines[:4]) + "\n", encoding="utf-8")
    tracking.import_results(results)
    c, experiment = tracking.client()
    made = {}
    for name, backend, model, wer, when in (
            ("20261026-165446-hf-danish-foundation-models-edda-v0-2-698f8d04b597", "hf", EDDA_HF, 0.0632,
             "2026-10-26T16:54:46+01:00"),
            ("20261026-170753-gguf-walkietalkey-edda-v0-2-gguf-edda-v0-2-q8-0-gguf", "gguf", paths.SHIPPED_EDDA_ID,
             0.0672, "2026-10-26T17:07:53+01:00")):
        start = int(datetime.fromisoformat(when).timestamp() * 1000)
        run = c.create_run(experiment, start_time=start, run_name=name,
                           tags={"wt.kind": "eval", "wt.change": "pipeline"})
        for k, v in {"backend": backend, "model": model, "dataset": "fleurs-da_dk-test", "train_run": ""}.items():
            c.log_param(run.info.run_id, k, v)
        c.log_metric(run.info.run_id, "fleurs-da_dk-test/wer", wer)
        c.log_metric(run.info.run_id, "fleurs-da_dk-test/n", 930)
        c.set_terminated(run.info.run_id)
        made[backend] = run.info.run_id
    return made


def test_the_owners_five_runs_by_name_and_normaliser(places, monkeypatch):
    monkeypatch.setenv("WT_TRACKING", "1")
    made = owners_store(places)
    srv = start_server(places)
    try:
        status, rows = get(srv, "/api/eval/runs")
    finally:
        stop_server(srv)
    assert status == 200
    got = [(r["title"], r["normaliser"], round(r["wer"] * 100, 2)) for r in rows]
    assert got == [("Appen · FLEURS · 26. okt.", 2, 6.72), ("Edda, original · FLEURS · 26. okt.", 2, 6.32),
                   ("Appen · FLEURS · 25. okt.", 1, 7.63), ("Appen · FLEURS · 24. okt.", 1, 8.44),
                   ("Edda, original · FLEURS · 24. okt.", 1, 7.21)]
    # The slug stays, for the command line; an imported row's date is when it was measured.
    assert rows[0]["id"] == made["gguf"] and rows[0]["name"].startswith("20261026-170753-gguf")
    assert rows[2]["name"] == "gguf-fleurs-da_dk-test-2026-10-25"
    assert rows[2]["date"] == "2026-10-25T02:16:19+02:00"
    assert rows[4]["date"] == "2026-10-24T18:17:11+02:00"


def test_a_new_eval_is_grouped_by_its_tag(places, monkeypatch, make_wav):
    from wt_train import normaliser, tracking

    monkeypatch.setenv("WT_TRACKING", "1")
    folder = places.eval_runs / "20261027-120000-gguf-a"
    folder.mkdir(parents=True)
    (folder / "summary.json").write_text(json.dumps({"backend": "gguf", "results": {}}))
    tracking.log_eval({"out": str(folder), "backend": "gguf", "model": paths.SHIPPED_EDDA_ID,
                       "dataset": "fleurs-da_dk-test", "metrics": {"fleurs-da_dk-test": {"wer": 0.07, "n": 930}}})
    srv = start_server(places)
    try:
        (row,) = get(srv, "/api/eval/runs")[1]
    finally:
        stop_server(srv)
    assert row["normaliser"] == normaliser.CURRENT and row["title"] == "Appen · FLEURS"


# --- the four settings a beginner touches first ------------------------------------------------

ESSENTIALS = ["training.learning_rate", "training.epochs", "lora.rank", "rehearsal.share"]


def test_the_four_settings_come_first_with_what_turning_them_does(server):
    (tiny,) = get(server, "/api/training/configs")[1]
    assert tiny["essentials"] == ESSENTIALS
    by_key = {s["key"]: s for s in tiny["settings"]}
    for key in ESSENTIALS:
        help_text = by_key[key]["help"]
        assert help_text and help_text == help_text.strip() and "—" not in help_text
        # One or two short lines: what more and what less does.
        assert 1 <= help_text.count(".") <= 3 and len(help_text) <= 220, help_text
    assert all(s["help"] is None for s in tiny["settings"] if s["key"] not in ESSENTIALS)
    assert set(labels.ESSENTIALS) == set(ESSENTIALS) and list(labels.ESSENTIALS) == ESSENTIALS
    # Every essential is a real setting with its own label.
    assert all(k in labels.SETTINGS for k in ESSENTIALS)


# --- pages from before run 11 -----------------------------------------------------------------


def test_an_english_page_from_before_is_written_again_in_danish(places, monkeypatch, make_wav):
    from test_studio_screens import eval_folder, log_eval

    monkeypatch.setenv("WT_TRACKING", "1")
    folder, summary = eval_folder(places, "20261026-170753-gguf-a", make_wav)
    run_id = log_eval(folder, summary)
    places.reports.mkdir(parents=True)
    old = places.reports / f"{folder.name}.html"
    old.write_text('<!doctype html>\n<html lang="en"><head><title>fleurs: edda</title></head></html>\n')
    srv = start_server(places)
    try:
        (row,) = get(srv, "/api/eval/runs")[1]
        assert row["report"] is None, "an English page is not shown"
        from fake_studio import post

        status, page = post(srv, "/api/eval/report", {"run": run_id})
        assert status == 200 and page["url"] == f"/reports/{folder.name}.html" and page["job"]
        html = old.read_text(encoding="utf-8")
        assert '<html lang="da">' in html and '<meta name="generator" content="wt-train page 2">' in html
        assert get(srv, "/api/eval/runs")[1][0]["report"] == page["url"]
        assert post(srv, "/api/eval/report", {"run": run_id})[1] == {"url": page["url"]}, "now it is reused"
    finally:
        stop_server(srv)
