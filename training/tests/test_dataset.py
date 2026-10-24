"""The dataset builder: splits by sentence, rehearsal share, and a loud leakage check."""

import json
import shutil

import pytest

from conftest import WORDS, takes_config, write_takes
from wt_train import dataset
from wt_train.dataset import (
    HeldOut, Item, LeakageError, build, check_leakage, fleurs_test_held_out, load_build, rehearsal_count,
    split_by_sentence,
)
from wt_train.spelling import Spelling, Term


def make_takes(tmp_path, make_wav, n=24):
    return write_takes(tmp_path, n)


def config(folder, sentences, spelling, **overrides):
    return takes_config(folder, sentences, spelling, **overrides)


def item(i, text, split_hash=None, kind="plain", source="recording", audio=None):
    return Item(id=f"i{i}", audio=audio or f"/x/i{i}.wav", text=text, kind=kind, source=source,
                audio_sha256=split_hash or f"h{i}", seconds=1.0)


def test_split_by_sentence_keeps_a_sentence_in_one_split():
    # The same sentence read three times, differing only in case and punctuation.
    items = [item(0, "Hej med dig."), item(1, "hej med dig"), item(2, "HEJ, med dig!")]
    items += [item(10 + i, f"Sætning nummer {w}") for i, w in enumerate(WORDS)]
    splits = split_by_sentence(items, 0.2, 0.2, seed=1)
    where = {i.id: name for name, its in splits.items() for i in its}
    assert where["i0"] == where["i1"] == where["i2"]
    assert sum(len(v) for v in splits.values()) == len(items)


def test_splits_are_deterministic_and_stable_as_takes_are_added():
    items = [item(i, f"Sætning nummer {w}") for i, w in enumerate(WORDS)]
    a = split_by_sentence(items, 0.2, 0.2, seed=7)
    b = split_by_sentence(list(reversed(items)), 0.2, 0.2, seed=7)
    assert a == b
    more = split_by_sentence(items + [item(99, "En helt ny sætning")], 0.2, 0.2, seed=7)
    for name in a:
        assert set(i.id for i in a[name]) <= set(i.id for i in more[name])
    assert split_by_sentence(items, 0.2, 0.2, seed=8) != a


def test_rehearsal_share_is_a_fraction_of_the_final_split():
    assert rehearsal_count(700, 0.3) == 300
    assert rehearsal_count(12, 0.25) == 4
    assert rehearsal_count(10, 0.0) == 0 and rehearsal_count(0, 0.5) == 0


def held_out(**kw):
    return HeldOut(keys=frozenset(kw.get("keys", ())), hashes=frozenset(kw.get("hashes", ())),
                   folder=kw.get("folder", __import__("pathlib").Path("/fleurs/test")))


def test_leakage_check_passes_clean_splits():
    report = check_leakage({"train": [item(0, "a b")], "validation": [item(1, "c d")], "test": [item(2, "e f")]},
                           held_out(keys={"g h"}))
    assert report["passed"]


@pytest.mark.parametrize(
    "splits, held, message",
    [
        ({"train": [item(0, "Hej med dig.")], "validation": [item(1, "hej med dig")], "test": []}, {},
         "in both train and validation"),
        ({"train": [item(0, "a", "same")], "validation": [], "test": [item(1, "b", "same")]}, {},
         "the same audio twice"),
        ({"train": [item(0, "a", "same"), item(1, "b", "same")], "validation": [], "test": []}, {},
         "the same audio twice"),
        ({"train": [item(0, "Testsætning alfa.")], "validation": [], "test": []}, {"keys": {"testsætning alfa"}},
         "FLEURS test text in train"),
        ({"train": [], "validation": [item(0, "Testsætning alfa.")], "test": []}, {"keys": {"testsætning alfa"}},
         "FLEURS test text in validation"),
        ({"train": [], "validation": [], "test": [item(0, "x", "fh")]}, {"hashes": {"fh"}},
         "FLEURS test audio in test"),
        ({"train": [item(0, "x", audio="/fleurs/test/1.wav")], "validation": [], "test": []}, {},
         "a FLEURS test file in train"),
    ],
)
def test_leakage_check_fails_loudly(splits, held, message):
    with pytest.raises(LeakageError, match=message):
        check_leakage(splits, held_out(**held))


def test_build_writes_manifests_and_summary(tmp_path, make_wav, fleurs_root):
    folder, sentences, spelling = make_takes(tmp_path, make_wav)
    b = build(config(folder, sentences, spelling), out_dir=tmp_path / "build", fleurs_root=fleurs_root)
    own = [i for s in b.splits.values() for i in s if i.source == "recording"]
    assert len(own) == 24
    # Transcripts are re-spelled, kinds come from sentences.csv, takes stay where they are.
    deploy = next(i for i in own if i.id == "s0000")
    assert deploy.text == "Vi skal deploye kat i dag." and deploy.kind == "terms"
    assert deploy.audio == str((folder / "s0000.wav").resolve())
    # Rehearsal: FLEURS train only, plain, never in test, at the configured share.
    rehearsal = {name: [i for i in s if i.source == "fleurs-train"] for name, s in b.splits.items()}
    assert rehearsal["test"] == []
    own_train = len(b.splits["train"]) - len(rehearsal["train"])
    assert len(rehearsal["train"]) == rehearsal_count(own_train, 0.25)
    assert all(i.kind == "plain" and "fleurs-da_dk-1" in i.id for i in rehearsal["train"])
    # The same FLEURS sentence (read by two speakers) is never in two splits.
    keys = {name: {i.key for i in s} for name, s in b.splits.items()}
    assert not keys["train"] & keys["validation"]

    on_disk = load_build(tmp_path / "build")
    assert on_disk.splits == b.splits
    summary = json.loads((tmp_path / "build" / "summary.json").read_text())
    assert summary["leakage_check"]["passed"] and summary["inputs"]["takes_used"] == 24
    assert summary["splits"]["train"]["by_source"]["fleurs-train"] == len(rehearsal["train"])
    assert summary["rehearsal"]["share"] == 0.25
    assert len(summary["splits"]["test"]["manifest_sha256"]) == 64
    assert "leakage check: passed" in dataset.format_summary(b)


def test_build_skips_takes_without_text_or_sentence(tmp_path, make_wav, fleurs_root):
    folder, sentences, spelling = make_takes(tmp_path, make_wav)
    (folder / "s0001.txt").unlink()
    make_wav(folder / "zzz.wav", seed=77)
    (folder / "zzz.txt").write_text("Ukendt.", encoding="utf-8")
    b = build(config(folder, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root)
    assert {s["id"]: s["reason"] for s in b.summary["inputs"]["skipped"]} == {
        "s0001": "no .txt next to the .wav", "zzz": "id not in sentences.csv"}


def test_build_refuses_takes_that_are_not_16k_mono(tmp_path, make_wav, fleurs_root):
    folder, sentences, spelling = make_takes(tmp_path, make_wav)
    make_wav(folder / "s0002.wav", seed=2, rate=44100)
    with pytest.raises(ValueError, match="16 kHz mono"):
        build(config(folder, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root)


def test_build_fails_when_a_take_is_fleurs_test_audio(tmp_path, make_wav, fleurs_root):
    folder, sentences, spelling = make_takes(tmp_path, make_wav)
    shutil.copyfile(fleurs_root / "test" / "2000.wav", folder / "s0003.wav")
    with pytest.raises(LeakageError, match="FLEURS test audio"):
        build(config(folder, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root)
    assert not (tmp_path / "b").exists()


def test_build_fails_when_a_take_reads_a_fleurs_test_sentence(tmp_path, make_wav, fleurs_root):
    folder, sentences, spelling = make_takes(tmp_path, make_wav)
    # Find a take that lands in train, and make it read a FLEURS test sentence.
    for path in sorted(folder.glob("*.txt")):
        path.write_text("Testsætning alfa.", encoding="utf-8")
        try:
            build(config(folder, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root)
        except LeakageError as e:
            assert "FLEURS test text" in str(e)
            return
        except ValueError:
            pass
        path.write_text("Original.", encoding="utf-8")
    pytest.fail("no take landed in train or validation")


def test_too_much_rehearsal_is_an_error(tmp_path, make_wav, fleurs_root):
    folder, sentences, spelling = make_takes(tmp_path, make_wav)
    cfg = config(folder, sentences, spelling, rehearsal={"share": 0.9})
    with pytest.raises(ValueError, match="lower rehearsal.share"):
        build(cfg, out_dir=tmp_path / "b", fleurs_root=fleurs_root)


def test_fleurs_test_hashes_are_cached(fleurs_root):
    first = fleurs_test_held_out(fleurs_root)
    assert (fleurs_root / "test.content-sha256.json").is_file()
    assert fleurs_test_held_out(fleurs_root) == first and len(first.hashes) == 4
    assert "testsætning alfa" in first.keys


def test_unconventional_spellings_are_rewritten_with_the_owners_conventions():
    s = Spelling([Term("merge", ("merge", "merget"), {"merged": "merget"})])
    assert s.apply("Den er merged.") == "Den er merget."
