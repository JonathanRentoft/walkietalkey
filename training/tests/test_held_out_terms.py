"""Held-out terms (run 12): their sentences are tested only, never trained on, and the evaluation
reports English-term accuracy for the terms the model trained on (seen) and the held-out ones
(unseen) apart."""

from __future__ import annotations

import json

import pytest

import fake_app
from conftest import owner_config, owner_takes
from wt_train import evaluate, per_condition, report, splits
from wt_train.config import ConfigError, config_from_dict
from wt_train.dataset import build
from wt_train.metrics import score_clip, summarize, without_terms
from wt_train.spelling import Spelling, Term, load_spelling

MODEL = "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf"
SPELLING = Spelling([Term("deploy", ("deploye", "deployede")), Term("kafka", ("Kafka",))])


def test_held_out_terms_are_a_list_of_names_in_the_config():
    assert config_from_dict({"name": "x"}).data.held_out_terms == ()
    cfg = config_from_dict({"name": "x", "data": {"held_out_terms": ["kafka"]}})
    assert cfg.data.held_out_terms == ("kafka",)
    with pytest.raises(ConfigError, match="held_out_terms"):
        config_from_dict({"name": "x", "data": {"held_out_terms": "kafka"}})
    with pytest.raises(ConfigError, match="held_out_terms: lists a term twice"):
        config_from_dict({"name": "x", "data": {"held_out_terms": ["kafka", "kafka"]}})


def test_a_build_with_a_term_that_is_not_in_the_spelling_stops(tmp_path, fleurs_root):
    recordings, sentences, spelling = owner_takes(tmp_path)
    cfg = owner_config(recordings, sentences, spelling, held_out_terms=["postgres"])
    with pytest.raises(ConfigError, match=r"'postgres' is not a term in .*spelling.yaml"):
        build(cfg, out_dir=tmp_path / "b", fleurs_root=fleurs_root)


def test_held_out_sentences_land_in_test_only(tmp_path, fleurs_root):
    recordings, sentences, spelling = owner_takes(tmp_path)
    cfg = owner_config(recordings, sentences, spelling, held_out_terms=["kafka"])
    b = build(cfg, out_dir=tmp_path / "b", fleurs_root=fleurs_root, log=lambda *_: None)
    spell = load_spelling(spelling)

    def holds_kafka(item):
        return any(h.term == "kafka" for h in spell.find_terms(item.text))

    assert all(not holds_kafka(i) for name in ("train", "validation") for i in b.splits[name])
    assert sum(holds_kafka(i) for i in b.splits["test"]) == 16
    assert b.summary["split_record"]["params"]["held_out_terms"] == ["kafka"]
    # The other term is still measured in test and validation and trained on; a held-out term is
    # missing from train and validation on purpose, so it is not listed as below there.
    below = {name: b.summary["splits"][name]["terms_below"] for name in ("train", "validation", "test")}
    assert below == {"train": [], "validation": [], "test": []}


def test_a_recorded_sentence_in_train_with_a_newly_held_out_term_is_left_out_not_moved(tmp_path, fleurs_root):
    recordings, sentences, spelling = owner_takes(tmp_path)
    first = build(owner_config(recordings, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root,
                  log=lambda *_: None)
    trained = {i.sentence for i in first.splits["train"] if "Kafka" in i.text}
    assert trained
    second = build(owner_config(recordings, sentences, spelling, held_out_terms=["kafka"]), out_dir=tmp_path / "b",
                   fleurs_root=fleurs_root, log=lambda *_: None)
    record, _ = splits.read_record(sentences.with_name("splits.csv"))
    assert all(record[sid] == "train" for sid in trained)
    skipped = {s["id"]: s["reason"] for s in second.summary["inputs"]["skipped"]}
    for sid in trained:
        (clip,) = [k for k in skipped if k.startswith(sid + ".")]
        assert "held-out term kafka" in skipped[clip]
    assert not any("Kafka" in i.text for name in ("train", "validation") for i in second.splits[name])


# --- seen and unseen in the scores -------------------------------------------------------------


def rows(unseen=frozenset({"kafka"})):
    return [{**score_clip("a", "Vi deployede Kafka i går.", "vi deployede kafka i går", SPELLING, unseen=unseen),
             "condition": "phone-whisper"},
            {**score_clip("b", "Kafka er nede, så vi skal deploye.", "kafta er nede så vi skal deploye", SPELLING,
                          unseen=unseen), "condition": "phone-normal"}]


def test_term_accuracy_is_reported_for_seen_and_unseen_terms_apart():
    summary = summarize(rows())
    assert summary["terms"] == 4 and summary["terms_strict"] == 3
    assert summary["seen"] == {"terms": 2, "terms_strict": 2, "terms_lenient": 2, "term_accuracy_strict": 1.0,
                               "term_accuracy_lenient": 1.0}
    assert summary["unseen"] == {"terms": 2, "terms_strict": 1, "terms_lenient": 1, "term_accuracy_strict": 0.5,
                                 "term_accuracy_lenient": 0.5}
    by = per_condition.summaries(rows())
    assert by["phone-normal"]["unseen"]["term_accuracy_strict"] == 0.0
    m = per_condition.for_logging(summary, by, "test")
    assert m["test/unseen/term_accuracy_strict"] == 0.5 and m["test/seen/terms"] == 2
    assert m["test/phone-normal/unseen/term_accuracy_strict"] == 0.0
    # Nothing held out: everything is seen, and there is no unseen block.
    plain = summarize(rows(unseen=frozenset()))
    assert "unseen" not in plain and "seen" not in plain
    assert "test/unseen/terms" not in per_condition.for_logging(plain, {}, "test")
    assert "unseen" not in without_terms(summary) and without_terms(summary)["terms"] is None


def test_the_evaluation_reports_unseen_terms_of_the_builds_config(tmp_path, monkeypatch, fleurs_root):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    recordings, sentences, spelling = owner_takes(tmp_path)
    cfg = owner_config(recordings, sentences, spelling, held_out_terms=["kafka"])
    build(cfg, fleurs_root=fleurs_root, log=lambda *_: None)
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    result = evaluate.run(["--backend", "gguf", "--model", MODEL, "--dataset", "test", "--build", "owner",
                           "--no-fleurs", "--app-bin", str(binary), "--spelling", str(spelling),
                           "--results", str(tmp_path / "results.csv")], log=lambda *_: None)
    summary = json.loads((result["out"] / "summary.json").read_text())
    assert summary["held_out_terms"] == ["kafka"]
    main = summary["results"]["owner:test"]
    assert main["unseen"]["terms"] == 16 and main["seen"]["terms"] == main["terms"] - 16
    assert "owner:test/unseen/term_accuracy_strict" in summary["metrics"]
    # results.csv keeps its header.
    assert (tmp_path / "results.csv").read_text().splitlines()[0] == ",".join(evaluate.RESULT_COLUMNS)
    page = report.single_page(report.load(result["out"]), load_spelling(spelling))
    assert "Nye fagord" in page and "Kendte fagord" in page and "kafka" in page

    plain = owner_config(recordings, sentences, spelling, name="plain")
    build(plain, fleurs_root=fleurs_root, log=lambda *_: None)
    result = evaluate.run(["--backend", "gguf", "--model", MODEL, "--dataset", "validation", "--build", "plain",
                           "--no-fleurs", "--app-bin", str(binary), "--spelling", str(spelling),
                           "--results", str(tmp_path / "results.csv")], log=lambda *_: None)
    summary = json.loads((result["out"] / "summary.json").read_text())
    assert summary["held_out_terms"] == [] and "unseen" not in summary["results"]["plain:validation"]
    page = report.single_page(report.load(result["out"]), load_spelling(spelling))
    assert "Nye fagord" not in page
