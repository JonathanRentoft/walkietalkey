"""The frozen test set (run 12): the first baseline on the owner's test split writes
training/data/test-lock.json; anything that would change the frozen set stops the build and the
evaluation; additions after the lock go to train or validation; every use of the test set is
logged in <work>/test-uses.jsonl."""

from __future__ import annotations

import hashlib
import json
import shutil
from datetime import datetime

import pytest

import fake_app
from conftest import owner_config, owner_takes, owner_text, write_condition_take, write_wav
from wt_train import dataset, evaluate, splits, testset
from wt_train.dataset import Item, build

MODEL = "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf"


def item(sid: str, cond: str = "phone-whisper", sha: str = "ab") -> Item:
    return Item(id=f"{sid}.{cond}", audio=f"/x/{sid}.wav", text="Hej.", kind="plain", source="recording",
                audio_sha256=sha, seconds=1.0, sentence=sid, condition=cond)


# --- the two files --------------------------------------------------------------------------


def test_the_lock_keeps_its_keys_and_its_sha256_recipe(tmp_path):
    lock = testset.make_lock(build="owner", params={"seed": 1, "validation_fraction": 0.1, "test_fraction": 0.1,
                                                     "held_out_terms": []},
                             clips=[item("s0002", sha="cd"), item("s0001"), item("s0001", "mac-normal", "ef")],
                             created="2026-10-28T12:00:00+01:00")
    assert list(lock) == ["created", "build", "params", "sentences", "clips", "sha256"]
    assert lock["sentences"] == ["s0001", "s0002"]
    assert lock["clips"] == [{"id": "s0001.mac-normal", "audio_sha256": "ef"},
                             {"id": "s0001.phone-whisper", "audio_sha256": "ab"},
                             {"id": "s0002.phone-whisper", "audio_sha256": "cd"}]
    body = {k: v for k, v in lock.items() if k != "sha256"}
    canonical = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    assert lock["sha256"] == hashlib.sha256(canonical.encode("utf-8")).hexdigest() == testset.lock_sha256(lock)
    path = tmp_path / "test-lock.json"
    assert testset.read_lock(path) is None
    testset.write_lock(path, lock)
    assert testset.read_lock(path) == lock
    edited = dict(lock, sentences=["s0001"])
    path.write_text(json.dumps(edited), encoding="utf-8")
    with pytest.raises(ValueError, match="sha256"):
        testset.read_lock(path)


def test_every_use_is_one_line_and_says_where_it_came_from(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    assert testset.read_uses() == []
    testset.log_use(runs=["owner-1"], backend="lora", build="owner", eval_run="20261028-120000-lora-owner-1")
    monkeypatch.setenv("WT_TEST_USE_SOURCE", "studio")
    testset.log_use(runs=["edda"], backend="gguf", build="owner", eval_run="20261028-120100-gguf-edda")
    path = tmp_path / "work" / "test-uses.jsonl"
    assert testset.uses_path() == path.resolve()
    with path.open("a", encoding="utf-8") as f:
        f.write("not json\n\n")
    uses = testset.read_uses()
    assert [u["source"] for u in uses] == ["cli", "studio"]
    assert list(uses[0]) == ["at", "runs", "backend", "build", "eval_run", "source"]
    assert uses[0]["runs"] == ["owner-1"] and uses[1]["eval_run"] == "20261028-120100-gguf-edda"
    assert datetime.fromisoformat(uses[0]["at"]).tzinfo is not None


# --- the owner's test split, end to end ------------------------------------------------------


@pytest.fixture
def owner(tmp_path, monkeypatch, fleurs_root):
    """Takes of 48 sentences, a config, its build in the work folder and the fake app."""
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    recordings, sentences, spelling = owner_takes(tmp_path)
    cfg = owner_config(recordings, sentences, spelling)
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)

    class Owner:
        def build(self, config=None):
            return build(config or cfg, fleurs_root=fleurs_root, log=lambda *_: None)

        def eval(self, split="test", *extra):
            return evaluate.run(["--backend", "gguf", "--model", MODEL, "--dataset", split, "--build", cfg.name,
                                 "--no-fleurs", "--app-bin", str(binary), "--spelling", str(spelling),
                                 "--results", str(tmp_path / "results.csv"), *extra], log=lambda *_: None)

    o = Owner()
    o.cfg, o.recordings, o.sentences, o.spelling = cfg, recordings, sentences, spelling
    o.lock = sentences.with_name("test-lock.json")
    o.uses = tmp_path / "work" / "test-uses.jsonl"
    return o


def test_the_first_test_evaluation_locks_the_test_set_and_every_use_is_logged(owner):
    b = owner.build()
    assert not owner.lock.exists() and b.summary["split_record"]["locked"] is False
    # Validation is not the test set: no lock, no use.
    report = owner.eval("validation")
    assert not owner.lock.exists() and not owner.uses.exists()
    assert json.loads((report["out"] / "summary.json").read_text())["split"] == "validation"

    report = owner.eval("test", "--limit", "3")
    lock = testset.read_lock(owner.lock)
    test = b.splits["test"]
    assert lock["build"] == "owner" and lock["sentences"] == sorted({i.sentence for i in test})
    # The whole split is frozen, whatever --limit scored.
    assert lock["clips"] == [{"id": i.id, "audio_sha256": i.audio_sha256} for i in sorted(test, key=lambda i: i.id)]
    assert lock["params"] == {"seed": 3, "validation_fraction": 0.2, "test_fraction": 0.2, "held_out_terms": []}
    summary = json.loads((report["out"] / "summary.json").read_text())
    assert summary["split"] == "test" and summary["build"] == "owner" and summary["test_lock"] == lock["sha256"]
    (use,) = testset.read_uses()
    assert use["eval_run"] == report["out"].name and use["build"] == "owner" and use["backend"] == "gguf"
    assert use["runs"] == [MODEL] and use["source"] == "cli"

    # The lock is written once; the next evaluation checks it and is logged too.
    created = lock["created"]
    owner.build()
    owner.eval("test")
    assert testset.read_lock(owner.lock)["created"] == created and len(testset.read_uses()) == 2
    assert b.summary["split_record"]["params"]["seed"] == 3


def test_after_the_lock_new_sentences_go_to_train_or_validation(owner):
    owner.build()
    record, _ = splits.read_record(owner.sentences.with_name("splits.csv"))
    owner.eval("test")
    lock = testset.read_lock(owner.lock)
    # A sentence dealt to test that had no take when the lock was written is not frozen with it.
    lines = owner.sentences.read_text(encoding="utf-8").splitlines()
    for i in range(48, 78):
        text, kind = owner_text(i)
        lines.append(f's{i:04d},"{text}",{kind}')
    owner.sentences.write_text("\n".join(lines) + "\n", encoding="utf-8")
    for i in range(48, 78):
        write_condition_take(owner.recordings, "phone-normal", f"s{i:04d}", owner_text(i)[0], seed=3000 + i)
    b = owner.build()
    assert sorted({i.sentence for i in b.splits["test"]}) == lock["sentences"]
    after, _ = splits.read_record(owner.sentences.with_name("splits.csv"))
    assert {sid for sid, s in after.items() if s == "test"} == set(lock["sentences"])
    assert all(after[f"s{i:04d}"] in ("train", "validation") for i in range(48, 78))
    assert {sid: s for sid, s in after.items() if sid in record and s != "test"} == \
        {sid: s for sid, s in record.items() if s != "test"}
    # Other parameters cannot move a locked sentence.
    other = owner_config(owner.recordings, owner.sentences, owner.spelling, seed=11, test_fraction=0.3)
    assert sorted({i.sentence for i in owner.build(other).splits["test"]}) == lock["sentences"]


def locked_take(owner) -> tuple[str, str]:
    lock = testset.read_lock(owner.lock)
    clip = lock["clips"][0]["id"]
    sid, cond = clip.split(".")
    return sid, cond


def change_text(owner, sid, cond):
    lines = owner.sentences.read_text(encoding="utf-8").splitlines()
    lines = [line.replace("nummer", "tal") if line.startswith(sid + ",") else line for line in lines]
    owner.sentences.write_text("\n".join(lines) + "\n", encoding="utf-8")


def remove_sentence(owner, sid, cond):
    lines = owner.sentences.read_text(encoding="utf-8").splitlines()
    owner.sentences.write_text("\n".join(x for x in lines if not x.startswith(sid + ",")) + "\n", encoding="utf-8")


def redo(owner, sid, cond):
    write_wav(owner.recordings / cond / f"{sid}.wav", seed=77)


def mark_redo(owner, sid, cond):
    meta = owner.recordings / cond / f"{sid}.json"
    meta.write_text(json.dumps({**json.loads(meta.read_text()), "review": {"status": "redo", "by": "owner"}}))


def move_aside(owner, sid, cond):
    target = owner.recordings / ".replaced" / cond
    target.mkdir(parents=True, exist_ok=True)
    for suffix in (".wav", ".txt", ".json"):
        shutil.move(owner.recordings / cond / f"{sid}{suffix}", target / f"{sid}.20261028T120000000000Z{suffix}")


def new_take(owner, sid, cond):
    other = next(c for c in ("phone-whisper", "phone-normal", "mac-normal") if c != cond)
    text = next(line for line in owner.sentences.read_text().splitlines() if line.startswith(sid + ","))
    write_condition_take(owner.recordings, other, sid, text.split('"')[1], seed=4242)


@pytest.mark.parametrize("change, says", [
    (redo, "other audio"),
    (mark_redo, "marked for a new take"),
    (move_aside, "missing"),
    (remove_sentence, "removed from"),
    (change_text, "text changed"),
    (new_take, "new take"),
])
def test_a_change_to_the_frozen_test_set_stops_the_build_and_the_evaluation(owner, change, says):
    owner.build()
    owner.eval("test")
    sid, cond = locked_take(owner)
    change(owner, sid, cond)
    with pytest.raises(testset.TestSetChanged) as stopped:
        owner.build()
    message = str(stopped.value)
    assert says in message and sid in message and "test-lock.json" in message
    assert "delete" in message and "cannot be compared" in message
    if change in (redo, mark_redo, move_aside, remove_sentence, change_text):
        # The evaluation checks the takes on disk against the lock, with the build it has.
        with pytest.raises(testset.TestSetChanged):
            owner.eval("test")
    assert len(testset.read_uses()) == 1


def test_the_stop_is_one_clean_message_on_the_command_line(owner, capsys):
    from conftest import write_fleurs
    from wt_train import paths

    write_fleurs(paths.fleurs_dir(), "test", [("x0", "2000", "Testsætning alfa.")], seed0=900)
    owner.build()
    owner.eval("test")
    sid, cond = locked_take(owner)
    redo(owner, sid, cond)
    cfg_file = owner.sentences.with_name("owner.yaml")
    cfg_file.write_text("name: owner\ndata:\n"
                        f"  recordings: {owner.recordings}\n  sentences: {owner.sentences}\n"
                        f"  spelling: {owner.spelling}\n  validation_fraction: 0.2\n  test_fraction: 0.2\n"
                        "  seed: 3\nrehearsal:\n  share: 0.0\n  validation_share: 0.0\n", encoding="utf-8")
    assert dataset.main([str(cfg_file)]) == 1
    err = capsys.readouterr().err
    assert "frozen test set" in err and sid in err and "Traceback" not in err


def test_fleurs_and_the_exam_never_lock(owner, tmp_path):
    owner.build()
    clips = tmp_path / "clips"
    write_wav(clips / "a.wav", seed=1)
    (clips / "a.txt").write_text("Hej.", encoding="utf-8")
    report = evaluate.run(["--backend", "gguf", "--model", MODEL, "--dataset", str(clips), "--no-fleurs",
                           "--app-bin", str(tmp_path / "walkietalkey"), "--results", str(tmp_path / "r.csv")],
                          log=lambda *_: None)
    assert json.loads((report["out"] / "summary.json").read_text())["split"] is None
    assert not owner.lock.exists() and testset.read_uses() == []
