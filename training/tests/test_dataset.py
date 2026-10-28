"""The dataset builder: splits by sentence, rehearsal share, and a loud leakage check."""

import json
import shutil

import pytest

from conftest import WORDS, takes_config, write_takes
from wt_train import dataset, splits
from wt_train.dataset import (
    HeldOut, Item, LeakageError, build, check_leakage, fleurs_test_held_out, load_build, rehearsal_count,
    split_by_record,
)
from wt_train.spelling import Spelling, Term


def make_takes(tmp_path, make_wav, n=24):
    return write_takes(tmp_path, n)


def config(folder, sentences, spelling, **overrides):
    return takes_config(folder, sentences, spelling, **overrides)


def item(i, text, split_hash=None, kind="plain", source="recording", audio=None):
    return Item(id=f"i{i}", audio=audio or f"/x/i{i}.wav", text=text, kind=kind, source=source,
                audio_sha256=split_hash or f"h{i}", seconds=1.0)


def test_every_take_of_a_sentence_goes_to_the_split_of_its_sentence_in_the_record():
    items = [Item(id=f"s1.{c}", audio=f"/x/{c}.wav", text="Hej med dig.", kind="plain", source="recording",
                  audio_sha256=c, seconds=1.0, sentence="s1", condition=c) for c in ("phone-whisper", "mac-normal")]
    items += [item(10 + i, f"Sætning nummer {w}") for i, w in enumerate(WORDS)]
    record = {"s1": "test"} | {f"i{10 + i}": ("validation" if i % 4 == 0 else "train") for i in range(len(WORDS))}
    parts, skipped = split_by_record(items, record)
    assert [i.id for i in parts["test"]] == ["s1.mac-normal", "s1.phone-whisper"] and not skipped
    assert sum(len(v) for v in parts.values()) == len(items)
    assert {i.id for i in parts["validation"]} == {f"i{10 + i}" for i in range(0, len(WORDS), 4)}
    # A take of a train or validation sentence with a held-out term is left out, with the reason.
    spelling = Spelling([Term("hund", ("hund",))])
    parts, skipped = split_by_record(items, record, held_out_terms=("hund",), spelling=spelling)
    assert skipped == [{"id": "i11", "reason": "holds the held-out term hund (its sentence is in train)"}]


def test_the_build_follows_the_split_record_and_says_what_each_split_covers(tmp_path, make_wav, fleurs_root):
    folder, sentences, spelling = make_takes(tmp_path, make_wav)
    b = build(config(folder, sentences, spelling), out_dir=tmp_path / "build", fleurs_root=fleurs_root,
              log=lambda *_: None)
    record, params = splits.read_record(sentences.with_name("splits.csv"))
    assert params == splits.Params(seed=3, validation_fraction=0.25, test_fraction=0.25)
    for name, items in b.splits.items():
        assert all(record[i.sentence] == name for i in items if i.source == "recording")
    info = b.summary["split_record"]
    assert info["path"] == str(sentences.with_name("splits.csv")) and info["locked"] is False
    assert info["sentences"] == {s: list(record.values()).count(s) for s in ("train", "validation", "test")}
    assert info["warnings"] == [] and info["moved"] == 0
    assert all(b.summary["splits"][name]["terms_below"] == [] for name in ("train", "validation", "test"))
    text = dataset.format_summary(b)
    assert "split record" in text and "seed 3" in text
    # A term without enough recorded test sentences is named, per split.
    for i in b.splits["test"]:
        if i.kind == "terms":
            __import__("pathlib").Path(i.audio).unlink()
    b = build(config(folder, sentences, spelling), out_dir=tmp_path / "build", fleurs_root=fleurs_root,
              log=lambda *_: None)
    assert b.summary["splits"]["test"]["terms_below"] == [{"term": "deploy", "sentences": 0}]
    assert b.summary["splits"]["validation"]["terms_below"] == []
    assert "below" in dataset.format_summary(b) and "deploy" in dataset.format_summary(b)


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
    assert (fleurs_root / "test.pcm-f32-sha256.json").is_file()
    assert fleurs_test_held_out(fleurs_root) == first and len(first.hashes) == 4
    assert "testsætning alfa" in first.keys


def test_unconventional_spellings_are_rewritten_with_the_owners_conventions():
    s = Spelling([Term("merge", ("merge", "merget"), {"merged": "merget"})])
    assert s.apply("Den er merged.") == "Den er merget."
