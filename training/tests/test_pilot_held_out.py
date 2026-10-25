"""Pilot takes never enter a split (run 7): the dataset builder never reads the pilot's folder,
and its leakage check refuses pilot sentences, pilot audio and pilot files, like the exam's."""

import json
import shutil

import pytest

from conftest import WORDS, takes_config, write_wav
from wt_train import dataset
from wt_train.dataset import LeakageError, build, load_recordings, pilot_held_out
from wt_train.spelling import load_spelling

PILOT_TEXTS = [("pilot-01", "Buildet fejler på CI'en i dag.", "terms"),
               ("pilot-02", "Mødet med kunden er flyttet til torsdag.", "plain")]


def setup(tmp_path, n=24):
    """n takes in the conditions' folders, a pilot of two sentences with takes in two setups."""
    root = tmp_path / "recordings"
    rows = ["id,text,kind"]
    for i, word in enumerate(WORDS[:n]):
        sid, cid = f"s{i:04d}", ["phone-whisper", "phone-normal", "mac-normal"][i % 3]
        text = f"Der er en {word} i haven."
        rows.append(f'{sid},"{text}",plain')
        write_wav(root / cid / f"{sid}.wav", seed=i)
        (root / cid / f"{sid}.txt").write_text(text + "\n", encoding="utf-8")
    sentences = tmp_path / "sentences.csv"
    sentences.write_text("\n".join(rows) + "\n", encoding="utf-8")
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text("terms:\n  deploy:\n    forms: [deploye]\n", encoding="utf-8")
    pilot_csv = tmp_path / "pilot.csv"
    pilot_csv.write_text("id,text,kind\n" + "".join(f'{i},"{t}",{k}\n' for i, t, k in PILOT_TEXTS), encoding="utf-8")
    pilot_dir = tmp_path / "pilot"
    for k, setup_name in enumerate(["iphone-whisper", "studio"]):
        for j, (pid, text, _) in enumerate(PILOT_TEXTS):
            write_wav(pilot_dir / setup_name / f"{pid}.wav", seed=500 + 10 * k + j)
            (pilot_dir / setup_name / f"{pid}.txt").write_text(text + "\n", encoding="utf-8")
            (pilot_dir / setup_name / f"{pid}.json").write_text(json.dumps({"setup": setup_name, "pilot": True}))
    write_wav(pilot_dir / ".replaced" / "studio" / "pilot-01.20261025T120000Z.wav", seed=777)
    return root, sentences, spelling, pilot_dir, pilot_csv


def test_the_pilot_is_held_out_by_text_audio_and_folder(tmp_path):
    root, sentences, spelling, pilot_dir, pilot_csv = setup(tmp_path, n=6)
    held = pilot_held_out(pilot_dir, pilot_csv)
    assert held.keys == {dataset.sentence_key(t) for _, t, _ in PILOT_TEXTS}
    # Every take, the replaced one too.
    assert len(held.hashes) == 5 and held.folder == pilot_dir.resolve()
    fleurs = dataset.HeldOut(keys=frozenset(), hashes=frozenset(), folder=tmp_path / "fleurs")

    def item(**kw):
        base = dict(id="x", audio=str(root / "phone-normal" / "x.wav"), text="Noget andet.", kind="plain",
                    source="recording", audio_sha256="hx", seconds=1.0)
        return dataset.Item(**{**base, **kw})

    cases = [
        (item(text="mødet med kunden er flyttet til torsdag"), "a pilot sentence"),
        (item(audio_sha256=sorted(held.hashes)[0]), "pilot audio"),
        (item(audio=str(pilot_dir / "studio" / "pilot-02.wav")), "a pilot file"),
    ]
    for split in ("train", "validation", "test"):
        for bad, message in cases:
            splits = {"train": [], "validation": [], "test": []}
            splits[split] = [bad]
            with pytest.raises(LeakageError, match=message):
                dataset.check_leakage(splits, fleurs, None, held)
    report = dataset.check_leakage({"train": [item()], "validation": [], "test": []}, fleurs, None, held)
    assert report["pilot_sentences"] == 2 and report["pilot_takes"] == 5
    assert "no pilot sentence or take in any split" in report["checks"]


def test_the_builder_never_reads_the_pilot_folder(tmp_path):
    root, sentences, spelling, pilot_dir, _ = setup(tmp_path, n=6)
    # A pilot setup may share a condition's name; the folder is refused all the same.
    shutil.copytree(pilot_dir / "studio", pilot_dir / "mac-normal")
    for folder in (pilot_dir, pilot_dir / "mac-normal"):
        with pytest.raises(ValueError, match="pilot"):
            load_recordings(folder, sentences, load_spelling(spelling), pilot_dir)
    items, _ = load_recordings(root, sentences, load_spelling(spelling), pilot_dir)
    assert items and not any(str(pilot_dir.resolve()) in i.audio for i in items)


def test_a_build_holds_the_pilot_out_of_every_split(tmp_path, fleurs_root):
    root, sentences, spelling, pilot_dir, pilot_csv = setup(tmp_path)
    b = build(takes_config(root, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root,
              pilot_dir=pilot_dir, pilot_csv=pilot_csv)
    report = b.summary["leakage_check"]
    assert report["passed"] and report["pilot_sentences"] == 2 and report["pilot_takes"] == 5
    every = [i for items in b.splits.values() for i in items]
    assert not any(i.audio.startswith(str(pilot_dir.resolve())) for i in every)
    assert not {i.key for i in every} & pilot_held_out(pilot_dir, pilot_csv).keys


def test_a_build_fails_when_a_take_is_pilot_audio(tmp_path, fleurs_root):
    root, sentences, spelling, pilot_dir, pilot_csv = setup(tmp_path)
    shutil.copyfile(pilot_dir / "iphone-whisper" / "pilot-01.wav", root / "phone-normal" / "s0001.wav")
    with pytest.raises(LeakageError, match="pilot audio"):
        build(takes_config(root, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root,
              pilot_dir=pilot_dir, pilot_csv=pilot_csv)
    assert not (tmp_path / "b").exists()


def test_a_build_fails_when_a_take_reads_a_pilot_sentence(tmp_path, fleurs_root):
    root, sentences, spelling, pilot_dir, pilot_csv = setup(tmp_path)
    # A pilot sentence copied into the sentence list and recorded: whichever split it lands in.
    lines = sentences.read_text(encoding="utf-8").splitlines()
    lines[2] = 's0001,"Mødet med kunden er flyttet til torsdag.",plain'
    sentences.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (root / "phone-normal" / "s0001.txt").write_text("Mødet med kunden er flyttet til torsdag.\n", encoding="utf-8")
    with pytest.raises(LeakageError, match="a pilot sentence"):
        build(takes_config(root, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root,
              pilot_dir=pilot_dir, pilot_csv=pilot_csv)


def test_rehearsal_never_draws_a_pilot_sentence(tmp_path, fleurs_root):
    root, sentences, spelling, pilot_dir, _ = setup(tmp_path)
    # The pilot reads eleven of the twelve FLEURS train sentences, and rehearsal needs one:
    # it must be the twelfth (drawn blindly, it would be a pilot sentence and fail the build).
    words = ["en", "to", "tre", "fire", "fem", "seks", "syv", "otte", "ni", "ti", "elleve", "tolv"]
    pilot_csv = tmp_path / "pilot-fleurs.csv"
    pilot_csv.write_text("id,text,kind\n" + "".join(
        f'pilot-{i:02d},"Træningssætning nummer {w} her.",plain\n' for i, w in enumerate(words[:11], 1)),
        encoding="utf-8")
    cfg = takes_config(root, sentences, spelling, rehearsal={"share": 0.05, "validation_share": 0.0})
    b = build(cfg, out_dir=tmp_path / "b", fleurs_root=fleurs_root, pilot_dir=pilot_dir, pilot_csv=pilot_csv)
    rehearsal = [i.key for i in b.splits["train"] if i.source == "fleurs-train"]
    assert rehearsal == ["træningssætning nummer tolv her"]
