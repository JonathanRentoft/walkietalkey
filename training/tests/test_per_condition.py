"""Scores per recording condition (device x style), with term accuracy, in a shape a tracker logs."""

import csv
import json

import pytest

import fake_app
from conftest import write_fleurs
from wt_train import evaluate, per_condition
from wt_train.metrics import score_clip
from wt_train.spelling import Spelling, Term

SPELLING = Spelling([Term("deploy", ("deploye", "deployede"))])


def rows():
    out = []
    for i, (cond, ref, hyp) in enumerate([
        ("phone-whisper", "Vi deployede den i går.", "vi deployede den i går"),
        ("phone-whisper", "Hej med dig.", "hej med mig"),
        ("phone-normal", "Vi skal deploye nu.", "vi skal deploy nu"),
        ("mac-normal", "Godt arbejde.", "godt arbejde"),
        ("", "Plain FLEURS.", "plain fleurs"),
    ]):
        out.append({**score_clip(f"c{i}", ref, hyp, SPELLING), "condition": cond})
    return out


def test_summaries_group_by_condition_in_a_fixed_order():
    by = per_condition.summaries(rows())
    assert list(by) == ["phone-whisper", "phone-normal", "mac-normal"]
    assert by["phone-whisper"]["n"] == 2 and by["phone-whisper"]["wer"] == pytest.approx(1 / 8)
    assert by["phone-whisper"]["term_accuracy_strict"] == 1.0
    assert by["phone-normal"]["terms"] == 1 and by["phone-normal"]["terms_strict"] == 0
    assert by["mac-normal"]["term_accuracy_strict"] is None
    assert per_condition.summaries([r for r in rows() if not r["condition"]]) == {}


def test_metrics_for_a_tracker_are_flat_numbers():
    from wt_train.metrics import summarize

    all_rows = rows()
    m = per_condition.for_logging(summarize(all_rows), per_condition.summaries(all_rows), prefix="test")
    assert m["test/wer"] == pytest.approx(summarize(all_rows)["wer"])
    assert m["test/phone-whisper/wer"] == pytest.approx(1 / 8)
    assert m["test/phone-whisper/term_accuracy_strict"] == 1.0
    assert m["test/phone-normal/n"] == 1
    assert "test/mac-normal/term_accuracy_strict" not in m, "no terms, no accuracy"
    assert all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in m.values())
    json.dumps(m)


def test_eval_reports_every_condition_and_appends_a_row_for_each(tmp_path, make_wav, monkeypatch, capsys):
    work = tmp_path / "work"
    monkeypatch.setenv("WT_WORK_DIR", str(work))
    write_fleurs(work / "datasets" / "fleurs-da_dk", "test",
                 [(f"x{i}", f"{3000 + i}", f"Sætning {i}.") for i in range(2)], seed0=40)
    clips = tmp_path / "clips"
    items = []
    for i, (cond, text) in enumerate([("phone-whisper", "Vi deployede den i går."),
                                      ("phone-normal", "Hej med dig."), ("mac-normal", "Vi ses.")]):
        wav = make_wav(clips / f"s{i}.wav", seed=i)
        (clips / f"s{i}.txt").write_text(text, encoding="utf-8")
        items.append({"id": f"s{i}.{cond}", "audio": str(wav), "text": text, "kind": "plain",
                      "source": "recording", "audio_sha256": f"h{i}", "seconds": 0.5, "sentence": f"s{i}",
                      "condition": cond})
    manifest = tmp_path / "test.jsonl"
    manifest.write_text("".join(json.dumps(i) + "\n" for i in items), encoding="utf-8")
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text("terms:\n  deploy:\n    forms: [deploye, deployede]\n", encoding="utf-8")
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    results = tmp_path / "results.csv"
    report = evaluate.run(["--backend", "gguf", "--model", "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
                           "--dataset", str(manifest), "--app-bin", str(binary), "--spelling", str(spelling),
                           "--results", str(results)], log=print)
    assert report["exit_code"] == 0
    assert set(report["by_condition"]) == {"phone-whisper", "phone-normal", "mac-normal"}
    assert report["by_condition"]["phone-whisper"]["term_accuracy_strict"] == 1.0
    assert report["metrics"]["test/phone-whisper/wer"] == 0.0
    assert report["metrics"]["fleurs-da_dk-test/wer"] > 0
    with results.open(newline="") as f:
        written = list(csv.DictReader(f))
    assert [r["dataset"] for r in written] == ["test", "test@phone-whisper", "test@phone-normal", "test@mac-normal"]
    assert written[1]["n"] == "1" and written[1]["term_accuracy_strict_pct"] == "100.00"
    assert written[0]["fleurs_n"] == "2" and written[1]["fleurs_n"] == ""
    out = capsys.readouterr().out
    assert "phone-whisper" in out
    summary = json.loads(next((work / "runs" / "eval").iterdir()).joinpath("summary.json").read_text())
    assert set(summary["by_condition"]) == set(report["by_condition"])
    assert summary["metrics"] == report["metrics"]


def test_the_exam_is_a_dataset_per_condition_through_the_live_path(tmp_path, make_wav, monkeypatch):
    rec = tmp_path / "recordings"
    for i, cond in enumerate(["phone-whisper", "mac-normal"]):
        folder = rec / "exam" / cond
        make_wav(folder / "e01.wav", seed=i)
        (folder / "e01.txt").write_text("God morgen allesammen.\n", encoding="utf-8")
        (folder / "e01.json").write_text(json.dumps({"condition": cond}), encoding="utf-8")
    label, clips = evaluate.load_dataset("exam", recordings=rec)
    assert label == "exam" and [(c.id, c.condition) for c in clips] == [
        ("e01.phone-whisper", "phone-whisper"), ("e01.mac-normal", "mac-normal")]
    label, clips = evaluate.load_dataset("exam:mac-normal", recordings=rec)
    assert label == "exam@mac-normal" and len(clips) == 1
    with pytest.raises(ValueError, match="no exam takes"):
        evaluate.load_dataset("exam", recordings=tmp_path / "none")

    work = tmp_path / "work"
    monkeypatch.setenv("WT_WORK_DIR", str(work))
    binary, log = fake_app.install(tmp_path, monkeypatch, batch=True)
    report = evaluate.run(["--backend", "gguf", "--model", "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
                           "--dataset", "exam", "--recordings", str(rec), "--live", "--no-fleurs",
                           "--app-bin", str(binary), "--results", str(tmp_path / "r.csv")], log=print)
    assert report["exit_code"] == 0 and set(report["by_condition"]) == {"phone-whisper", "mac-normal"}
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    live = [c for c in calls if "-f" in c]
    assert len(live) == 2 and all("--live" in c for c in live)
