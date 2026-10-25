"""Run 7: Mac whispered is a condition like the others (recorded, built, scored per condition)
once the mix gives it a share, and ``wt-train record`` records only conditions with a share."""

import csv
import json

import pytest

import fake_app
from conftest import WORDS, takes_config, write_wav
from fake_audio import app_take, pcm16
from wt_train import conditions, evaluate, per_condition, plan
from wt_train.dataset import build, load_recordings
from wt_train.recorder import server
from wt_train.recorder.session import Session
from wt_train.sentences import Sentence
from wt_train.spelling import load_spelling


def test_mac_whisper_is_a_condition():
    c = conditions.condition("mac-whisper")
    assert (c.device, c.style) == ("mac", "whisper") and c.label == "Mac'en, hvisket"
    assert conditions.condition_id("mac", "whisper") == "mac-whisper"
    assert conditions.IDS == ("phone-whisper", "phone-normal", "mac-normal", "mac-whisper")


def test_a_mac_whisper_session_records_with_the_whisper_limits(tmp_path):
    rows = [Sentence("s0001", "Kan du deploye til staging?", "terms")]
    s = Session(root=tmp_path / "recordings", condition=conditions.condition("mac-whisper"), items=rows,
                texts={r.id: r.text for r in rows})
    answer = s.hello({"version": "0.2.1", "phones": [], "input": "MacBook Pro-mikrofon"})
    assert (answer["device"], answer["style"], answer["phone"]) == ("mac", "whisper", None)
    assert s.mac_start()
    # Whispered at -45 dBFS: a normal voice would be "quiet" there, a whisper is fine.
    take = pcm16(app_take([("silence", 0.4), ("speech", 2.0), ("silence", 0.4)], style="whisper", level_dbfs=-45))
    result = s.take({"prompt": "s0001", "source": "mac", "missing": 0}, take)
    assert result["saved"] and result["check"] == "ok"
    meta = json.loads((tmp_path / "recordings" / "mac-whisper" / "s0001.json").read_text())
    assert (meta["condition"], meta["device"], meta["style"], meta["microphone"]) == (
        "mac-whisper", "mac", "whisper", "MacBook Pro-mikrofon")


def write_takes(root, n=24):
    """n sentences round robin over all four conditions, with metadata."""
    rows = ["id,text,kind"]
    for i, word in enumerate(WORDS[:n]):
        sid, cid = f"s{i:04d}", conditions.IDS[i % 4]
        c = conditions.condition(cid)
        text = f"Der er en {word} i haven."
        rows.append(f'{sid},"{text}",plain')
        write_wav(root / "recordings" / cid / f"{sid}.wav", seed=i)
        (root / "recordings" / cid / f"{sid}.txt").write_text(text + "\n", encoding="utf-8")
        (root / "recordings" / cid / f"{sid}.json").write_text(json.dumps(
            {"condition": cid, "device": "iphone" if c.device == "phone" else "mac", "style": c.style}))
    (root / "sentences.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    (root / "spelling.yaml").write_text("terms:\n  deploy:\n    forms: [deploye]\n", encoding="utf-8")
    return root / "recordings", root / "sentences.csv", root / "spelling.yaml"


def test_mac_whisper_takes_are_built_and_scored_per_condition(tmp_path, fleurs_root, monkeypatch):
    rec, sentences, spelling = write_takes(tmp_path)
    items, _ = load_recordings(rec, sentences, load_spelling(spelling))
    whispered = [i for i in items if i.condition == "mac-whisper"]
    assert len(whispered) == 6 and all((i.device, i.style) == ("mac", "whisper") for i in whispered)
    assert whispered[0].id.endswith(".mac-whisper")
    b = build(takes_config(rec, sentences, spelling, rehearsal={"share": 0.0, "validation_share": 0.0}),
              out_dir=tmp_path / "b", fleurs_root=fleurs_root)
    assert sum(s["by_condition"].get("mac-whisper", 0) for s in b.summary["splits"].values()) == 6

    # Scored per condition through the app, like the others.
    work = tmp_path / "work"
    monkeypatch.setenv("WT_WORK_DIR", str(work))
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    manifest = tmp_path / "all.jsonl"
    manifest.write_text("".join((b.dir / f"{s}.jsonl").read_text() for s in ("train", "validation", "test")))
    results = tmp_path / "results.csv"
    report = evaluate.run(["--backend", "gguf", "--model", "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
                           "--dataset", str(manifest), "--app-bin", str(binary), "--no-fleurs",
                           "--results", str(results)], log=print)
    assert list(report["by_condition"]) == list(conditions.IDS)
    assert report["by_condition"]["mac-whisper"]["n"] == 6
    assert report["metrics"]["all/mac-whisper/wer"] == 0.0
    with results.open(newline="") as f:
        assert "all@mac-whisper" in [r["dataset"] for r in csv.DictReader(f)]
    rows = [{"condition": "mac-whisper", "sub": 1, "del": 0, "ins": 0, "ref_words": 4, "ref_chars": 20,
             "char_errors": 2, "terms": 0, "terms_strict": 0, "terms_lenient": 0, "hypothesis": "x"}]
    assert per_condition.summaries(rows)["mac-whisper"]["wer"] == 0.25
    assert per_condition.for_logging(per_condition.summaries(rows)["mac-whisper"], per_condition.summaries(rows),
                                     "exam")["exam/mac-whisper/wer"] == 0.25


def record_args(tmp_path, *extra):
    rows = [Sentence(f"s{i:04d}", f"Sætning nummer {i} om katten.", "plain") for i in range(20)]
    csv_path = tmp_path / "sentences.csv"
    csv_path.write_text("id,text,kind\n" + "".join(f'{s.id},"{s.text}",{s.kind}\n' for s in rows), encoding="utf-8")
    exam = tmp_path / "exam.yaml"
    exam.write_text("paragraphs:\n  - id: e01\n    title: Mandag\n    text: God morgen allesammen.\n",
                    encoding="utf-8")
    return ["--sentences", str(csv_path), "--plan", str(tmp_path / "plan.csv"), "--exam-file", str(exam),
            "--recordings", str(tmp_path / "recordings"), "--no-browser", "--port", "0", *extra]


@pytest.fixture
def served(monkeypatch):
    seen = {}

    def fake_serve(session, **kw):
        seen.update(session=session, **kw)
        return 0

    monkeypatch.setattr(server, "serve", fake_serve)
    return seen


def test_record_refuses_a_condition_without_a_share(tmp_path, served, capsys):
    assert server.main(record_args(tmp_path, "--condition", "mac-whisper")) == 2
    err = capsys.readouterr().err
    assert "mac-whisper has no share in the mix" in err and "wt-train plan --mix" in err
    assert not served
    # The exam is read in any condition.
    assert server.main(record_args(tmp_path, "--condition", "mac-whisper", "--exam")) == 0
    assert served["session"].condition.id == "mac-whisper" and served["session"].exam


def test_record_takes_mac_whisper_once_the_mix_gives_it_a_share(tmp_path, served, capsys):
    args = record_args(tmp_path)
    assert server.main(args) == 0  # the progress, and the plan and its mix written
    out = capsys.readouterr().out
    assert "mix: phone-whisper 40 %, phone-normal 40 %, mac-normal 20 %" in out
    assert "mac-whisper" not in out.split("mix:")[0]  # no row for a condition without a share
    plan.ensure(plan.load_sentences(tmp_path / "sentences.csv"), tmp_path / "plan.csv",
                mix=plan.parse_mix("phone-whisper=50,mac-whisper=50"), recorded={})
    assert server.main(args + ["--condition", "mac-whisper"]) == 0
    session = served["session"]
    # Half of the twenty, to within the deal per split and kind.
    assert session.condition.id == "mac-whisper" and 8 <= len(session.items) <= 12
    assert [r["id"] for r in served["rows"]] == ["phone-whisper", "mac-whisper"]
    # phone-normal has no share now.
    assert server.main(args + ["--condition", "phone-normal"]) == 2
