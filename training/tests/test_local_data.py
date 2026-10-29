"""The owner's own words and sentences (run 12), in the git-ignored training/data/local/: read by
the dataset builder, the evaluation and the recorder, dealt to train or validation only, never
named by their text in an error or a log."""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest

import fake_app
from conftest import owner_config, owner_takes, write_condition_take, write_wav
from wt_train import evaluate, local, paths, plan, splits
from wt_train.dataset import LeakageError, build, format_summary
from wt_train.spelling import load_spelling

MODEL = "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf"
OWN = [f"Grafana viser {w} for mig, nummer {i}." for i, w in
       enumerate(["køen", "lageret", "netværket", "databasen", "loggen", "brugerne", "fejlene", "tiden",
                  "trafikken", "hukommelsen", "processerne", "diskene"], 1)]


def write_own(folder, texts=OWN, words=("Grafana",)):
    folder.mkdir(parents=True, exist_ok=True)
    rows = "".join(f'own-{i:04d},"{t}",terms\n' for i, t in enumerate(texts, 1))
    (folder / "sentences.csv").write_text("id,text,kind\n" + rows, encoding="utf-8")
    (folder / "own-words.yaml").write_text("words: [" + ", ".join(words) + "]\n", encoding="utf-8")
    return folder


def test_the_local_folder_is_overridable_and_every_test_has_its_own(no_own_data):
    assert paths.LOCAL == paths.DATA / "local"
    assert paths.local_dir() == no_own_data.resolve() != paths.LOCAL.resolve()
    assert local.load_sentences() == [] and local.own_words() == []


def test_the_local_folder_is_never_committed():
    if shutil.which("git") is None or not (paths.REPO / ".git").exists():
        pytest.skip("not a git checkout")
    for name in ("sentences.csv", "own-words.yaml", "plan.csv", "splits.csv"):
        target = paths.LOCAL / name
        done = subprocess.run(["git", "-C", str(paths.REPO), "check-ignore", "-q", str(target)])
        assert done.returncode == 0, f"{target} is not git-ignored"


def test_own_words_become_terms_with_one_form(no_own_data):
    write_own(no_own_data, words=("Grafana", "deploye", "GRAFANA", "Terraform", "Deploy'e"))
    spelling = load_spelling(paths.SPELLING_YAML)
    words = local.own_words()
    assert words == ["Grafana", "deploye", "GRAFANA", "Terraform", "Deploy'e"]
    extended = local.with_own_words(spelling, words)
    added = [t for t in extended.terms if t not in spelling.terms]
    # A word spelling.yaml covers (a form or an `also`) and a repeat are left out.
    assert [(t.name, t.forms) for t in added] == [("Grafana", ("Grafana",)), ("Terraform", ("Terraform",))]
    assert [h.term for h in extended.find_terms("Grafana og terraform kører.")] == ["Grafana", "Terraform"]
    (no_own_data / "own-words.yaml").write_text("words: [Grafana, 3]\n", encoding="utf-8")
    with pytest.raises(ValueError, match="entry 2") as e:
        local.own_words()
    assert "Grafana" not in str(e.value)


def test_own_sentences_need_own_ids(no_own_data):
    (no_own_data / "sentences.csv").write_text('id,text,kind\ns0001,"Min hemmelige sætning.",plain\n',
                                               encoding="utf-8")
    with pytest.raises(ValueError, match="s0001") as e:
        local.load_sentences()
    assert "hemmelige" not in str(e.value)


def test_the_build_trains_on_own_sentences_and_never_tests_on_them(tmp_path, fleurs_root, no_own_data):
    recordings, sentences, spelling = owner_takes(tmp_path)
    write_own(no_own_data)
    for i, text in enumerate(OWN, 1):
        write_condition_take(recordings, "phone-normal", f"own-{i:04d}", text, seed=5000 + i)
    lines = []
    b = build(owner_config(recordings, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root,
              log=lines.append)
    own = {name: [i for i in items if i.sentence.startswith("own-")] for name, items in b.splits.items()}
    assert own["test"] == [] and len(own["train"]) + len(own["validation"]) == len(OWN) and own["validation"]
    assert b.summary["inputs"]["local"] == {"sentences": len(OWN), "own_words": 1}
    # Their plan and split live beside them; the committed-style files hold none of them.
    record, _ = splits.read_record(sentences.with_name("splits.csv"))
    assert not any(sid.startswith("own-") for sid in record)
    assert not any(sid.startswith("own-") for sid in plan.read_plan(sentences.with_name("plan.csv")))
    own_record, _ = splits.read_record(no_own_data / "splits.csv")
    assert set(own_record) == {f"own-{i:04d}" for i in range(1, len(OWN) + 1)}
    assert set(plan.read_plan(no_own_data / "plan.csv")) == set(own_record)
    # Names and counts only: no own text in the summary or the log.
    text = (tmp_path / "b" / "summary.json").read_text(encoding="utf-8") + format_summary(b) + "\n".join(lines)
    assert not any(t in text for t in OWN) and "Grafana" not in text


@pytest.mark.parametrize("copy, check", [("public", "sentences.csv"), ("pilot", "pilot")])
def test_an_own_sentence_equal_to_a_held_out_or_public_one_is_refused_by_id(tmp_path, fleurs_root, no_own_data,
                                                                           copy, check):
    recordings, sentences, spelling = owner_takes(tmp_path)
    pilot_csv = tmp_path / "pilot.csv"
    pilot_csv.write_text('id,text,kind\npilot-01,"Mødet med kunden er flyttet til torsdag.",plain\n',
                         encoding="utf-8")
    twin = "VI SKAL DEPLOYE KAT NUMMER 0 I DAG!" if copy == "public" else "Mødet med kunden er flyttet til torsdag"
    write_own(no_own_data, texts=[OWN[0], twin])
    with pytest.raises(LeakageError) as e:
        build(owner_config(recordings, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root,
              pilot_dir=tmp_path / "pilot", pilot_csv=pilot_csv, log=lambda *_: None)
    message = str(e.value)
    assert "own-0002" in message and check in message
    assert twin not in message and twin.lower() not in message and "torsdag" not in message


def test_the_recorder_offers_own_sentences_with_their_own_plan(tmp_path, monkeypatch, no_own_data):
    recordings, sentences, spelling = owner_takes(tmp_path)
    write_own(no_own_data)
    prepared = plan.prepare(sentences, sentences.with_name("plan.csv"), spelling_path=spelling,
                            recordings=recordings)
    ids = [s.id for s in prepared.sentences]
    assert ids[:48] == [f"s{i:04d}" for i in range(48)] and ids[48:] == [f"own-{i:04d}" for i in range(1, 13)]
    assert set(prepared.plan) == set(ids) and set(prepared.splits) == set(ids)
    assert all(prepared.splits[sid] in ("train", "validation") for sid in ids[48:])
    assert (no_own_data / "plan.csv").is_file() and (no_own_data / "splits.csv").is_file()

    from wt_train.recorder import server

    seen = {}

    def fake_serve(session, **kw):
        seen.update(session=session)
        return 0

    exam = tmp_path / "exam.yaml"
    exam.write_text("paragraphs:\n  - id: e01\n    title: Mandag\n    text: God morgen allesammen.\n",
                    encoding="utf-8")
    monkeypatch.setattr(server, "serve", fake_serve)
    condition = prepared.plan["own-0001"]
    assert server.main(["--sentences", str(sentences), "--plan", str(sentences.with_name("plan.csv")),
                        "--spelling", str(spelling), "--exam-file", str(exam), "--recordings", str(recordings),
                        "--no-browser", "--port", "0", "--condition", condition]) == 0
    offered = {i.id for i in seen["session"].items}
    assert "own-0001" in offered and seen["session"].store.text("own-0001") == OWN[0]


def test_the_evaluation_counts_own_words_as_terms(tmp_path, monkeypatch, no_own_data):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    clips = tmp_path / "clips"
    write_wav(clips / "a.wav", seed=1)
    (clips / "a.txt").write_text("Grafana viser køen.", encoding="utf-8")
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text("terms:\n  deploy:\n    forms: [deploye]\n", encoding="utf-8")
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)

    def terms() -> int:
        result = evaluate.run(["--backend", "gguf", "--model", MODEL, "--dataset", str(clips), "--no-fleurs",
                               "--app-bin", str(binary), "--spelling", str(spelling),
                               "--results", str(tmp_path / "r.csv")], log=lambda *_: None)
        return json.loads((result["out"] / "summary.json").read_text())["results"]["clips"]["terms"]

    assert terms() == 0
    write_own(no_own_data)
    assert terms() == 1
