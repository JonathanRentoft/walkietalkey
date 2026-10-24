"""The lab journal (run 5, Part 4): ``wt-train card`` writes a page from a tracked run,
with its numbers, plots and config diff, and four empty headings for the owner."""

import time
from datetime import date

import pytest

from wt_train import journal, tracking

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 16


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_TRACKING", "1")


def two_training_runs(tmp_path):
    plot = tmp_path / "metrics.png"
    plot.write_bytes(PNG)
    with tracking.run("train", "first-a") as a:
        a.params({"lora": {"rank": 8}, "training": {"epochs": 3}, "config_hash": "aaa"})
        a.metrics({"best": {"validation_wer_pct": 9.0}})
    time.sleep(0.02)  # start times are in milliseconds
    with tracking.run("train", "first-b") as b:
        b.params({"lora": {"rank": 16}, "training": {"epochs": 3}, "config_hash": "bbb",
                  "dataset": {"fingerprint": "f00d"}})
        b.metrics({"best": {"validation_wer_pct": 8.0, "epoch": 2}})
        b.artifact(plot)
        with tracking.run("eval", "first-b-test", parent=b) as e:
            e.metrics({"test": {"wer_pct": 7.5, "iphone-whisper": {"wer_pct": 9.1, "term_accuracy_pct": 60.0}},
                       "fleurs": {"wer_pct": 7.3}})


def test_the_card_has_numbers_plots_config_diff_and_four_empty_headings(store, tmp_path):
    two_training_runs(tmp_path)
    out = tmp_path / "journal"
    page = journal.write_card("first-b", out=out)
    today = date.today().isoformat()
    assert page == out / f"{today}-first-b.md"
    text = page.read_text(encoding="utf-8")
    assert text.startswith(f"# first-b ({today})")
    assert "config hash bbb" in text and "dataset f00d" in text
    assert "| best/validation_wer_pct | 8.00 |" in text and "| best/epoch | 2 |" in text
    assert "### eval: first-b-test" in text
    assert "| test/iphone-whisper/wer_pct | 9.10 |" in text and "| fleurs/wer_pct | 7.30 |" in text
    assert "Against first-a" in text
    assert "| lora.rank | 8 | 16 |" in text and "| config_hash | aaa | bbb |" in text
    assert "training.epochs" not in text  # unchanged keys stay out of the diff
    plot = out / f"{today}-first-b" / "first-b-metrics.png"
    assert plot.read_bytes() == PNG
    assert f"](./{today}-first-b/first-b-metrics.png)" in text or f"]({today}-first-b/first-b-metrics.png)" in text
    for heading in journal.HEADINGS:
        assert f"\n## {heading}\n\n" in text
    assert text.endswith("## What I learned\n\n")
    assert text.index("## Hypothesis") > text.index("## Config")


def test_an_existing_page_is_never_overwritten(store, tmp_path):
    two_training_runs(tmp_path)
    out = tmp_path / "journal"
    page = journal.write_card("latest", out=out)  # the newest training run
    assert page.name.endswith("-first-b.md")
    page.write_text(page.read_text(encoding="utf-8") + "my notes\n", encoding="utf-8")
    with pytest.raises(journal.CardError, match="--force"):
        journal.write_card("first-b", out=out)
    assert page.read_text(encoding="utf-8").endswith("my notes\n")
    journal.write_card("first-b", out=out, force=True)
    assert "my notes" not in page.read_text(encoding="utf-8")


def test_the_first_run_has_nothing_to_compare_with(store, tmp_path):
    two_training_runs(tmp_path)
    text = journal.write_card("first-a", out=tmp_path / "journal").read_text(encoding="utf-8")
    assert "No earlier run of this kind." in text


def test_an_unknown_run_is_refused(store, tmp_path):
    two_training_runs(tmp_path)
    with pytest.raises(journal.CardError, match="no tracked run"):
        journal.write_card("nope", out=tmp_path / "journal")


def test_a_baseline_from_results_csv_gets_a_card(store, tmp_path):
    from test_tracking import first_rows

    tracking.import_results(first_rows(tmp_path))
    hf = next(r for r in tracking.find_runs(kind="baseline") if r.data.params["backend"] == "hf")
    text = journal.write_card(hf.info.run_name, out=tmp_path / "journal").read_text(encoding="utf-8")
    assert "| wer_pct | 7.21 |" in text and "| wer_ci95_low_pct | 6.66 |" in text
