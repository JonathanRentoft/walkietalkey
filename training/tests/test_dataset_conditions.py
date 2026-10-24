"""The dataset builder with takes from every condition: one split per sentence for all of its
recordings, the condition mix in each split, run 4's browser takes, and the exam kept out."""

import json
import shutil

import pytest

from conftest import WORDS, takes_config, write_wav
from wt_train import dataset
from wt_train.dataset import LeakageError, build, exam_held_out, load_recordings
from wt_train.spelling import load_spelling

EXAM = """paragraphs:
  - id: e01
    title: Mandag
    text: God morgen allesammen, vi starter standuppen nu og tager det hele i rækkefølge.
  - id: e02
    title: Nat
    text: I nat crashede backenden to gange, og ingen vidste hvorfor.
"""


def write_condition_take(root, condition, sid, text, seed, exam=False, **meta):
    folder = root / ("exam" if exam else "") / condition
    write_wav(folder / f"{sid}.wav", seed=seed)
    (folder / f"{sid}.txt").write_text(text + "\n", encoding="utf-8")
    device = {"phone-whisper": "iphone", "phone-normal": "iphone", "mac-normal": "mac"}[condition]
    style = "whisper" if condition == "phone-whisper" else "normal"
    body = {"id": sid, "condition": condition, "device": device, "style": style,
            "microphone": "iPhone-mikrofon" if device == "iphone" else "MacBook Pro-mikrofon", **meta}
    (folder / f"{sid}.json").write_text(json.dumps(body), encoding="utf-8")


def setup(tmp_path, n=24, every_condition=()):
    """n sentences, each recorded in one condition (round robin); the ids in ``every_condition``
    are recorded in all three, and s0000 also by run 4's browser recorder."""
    root = tmp_path / "recordings"
    rows = ["id,text,kind"]
    conditions = ["phone-whisper", "phone-normal", "mac-normal"]
    for i, word in enumerate(WORDS[:n]):
        sid = f"s{i:04d}"
        text = f"Vi skal deploy'e {word} i dag." if i % 3 == 0 else f"Der er en {word} i haven."
        rows.append(f'{sid},"{text}",{"terms" if i % 3 == 0 else "plain"}')
        for k, c in enumerate(conditions if sid in every_condition else [conditions[i % 3]]):
            write_condition_take(root, c, sid, text, seed=100 * i + k)
        if sid == "s0000":
            write_wav(root / "s0000.wav", seed=9999)
            (root / "s0000.txt").write_text(text + "\n", encoding="utf-8")
    sentences = tmp_path / "sentences.csv"
    sentences.write_text("\n".join(rows) + "\n", encoding="utf-8")
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text("terms:\n  deploy:\n    forms: [deploye, deployer]\n    also:\n      deploy'e: deploye\n",
                        encoding="utf-8")
    exam = tmp_path / "exam.yaml"
    exam.write_text(EXAM, encoding="utf-8")
    return root, sentences, spelling, exam


def test_takes_of_every_condition_and_the_browser_takes_load(tmp_path):
    root, sentences, spelling, _ = setup(tmp_path, n=6, every_condition={"s0000"})
    items, skipped = load_recordings(root, sentences, load_spelling(spelling))
    assert not skipped
    by_id = {i.id: i for i in items}
    assert set(by_id) >= {"s0000", "s0000.phone-whisper", "s0000.phone-normal", "s0000.mac-normal",
                          "s0001.phone-normal"}
    browser = by_id["s0000"]
    assert (browser.sentence, browser.condition, browser.device, browser.style, browser.capture) == (
        "s0000", "mac-normal", "mac", "normal", "browser")
    whisper = by_id["s0000.phone-whisper"]
    assert (whisper.sentence, whisper.condition, whisper.device, whisper.style, whisper.capture) == (
        "s0000", "phone-whisper", "iphone", "whisper", "app")
    assert whisper.microphone == "iPhone-mikrofon"
    assert whisper.text == "Vi skal deploye kat i dag."
    assert len({i.audio_sha256 for i in items}) == len(items)


def test_every_recording_of_a_sentence_lands_in_one_split(tmp_path, fleurs_root):
    many = {f"s{i:04d}" for i in range(0, 24, 2)}
    root, sentences, spelling, exam = setup(tmp_path, every_condition=many)
    cfg = takes_config(root, sentences, spelling)
    b = build(cfg, out_dir=tmp_path / "b", fleurs_root=fleurs_root, exam_yaml=exam)
    where: dict[str, set[str]] = {}
    for name, items in b.splits.items():
        for i in items:
            if i.source == "recording":
                where.setdefault(i.sentence, set()).add(name)
    assert all(len(splits) == 1 for splits in where.values()), where
    report = b.summary["leakage_check"]
    assert report["passed"]
    assert report["sentences_recorded_more_than_once"] == len(many)
    assert "every recording of a sentence in one split" in report["checks"]
    assert "no exam paragraph in any split" in report["checks"]
    mix = {name: s["by_condition"] for name, s in b.summary["splits"].items()}
    assert sum(sum(m.values()) for m in mix.values()) == sum(
        1 for items in b.splits.values() for i in items if i.source == "recording")
    assert "phone-whisper" in dataset.format_summary(b)


def test_the_leakage_check_names_a_sentence_split_across_conditions(tmp_path):
    a = dataset.Item(id="s1.phone-whisper", audio="/x/a.wav", text="Hej med dig.", kind="plain",
                     source="recording", audio_sha256="ha", seconds=1.0, sentence="s1", condition="phone-whisper")
    b = dataset.Item(id="s1.mac-normal", audio="/x/b.wav", text="hej med dig", kind="plain", source="recording",
                     audio_sha256="hb", seconds=1.0, sentence="s1", condition="mac-normal")
    held = dataset.HeldOut(keys=frozenset(), hashes=frozenset(), folder=tmp_path / "fleurs")
    with pytest.raises(LeakageError, match="in both train and test"):
        dataset.check_leakage({"train": [a], "validation": [], "test": [b]}, held)


def test_the_exam_is_held_out_by_text_audio_and_folder(tmp_path):
    root, sentences, spelling, exam = setup(tmp_path, n=6)
    write_condition_take(root, "phone-normal", "e01", "God morgen allesammen.", seed=5, exam=True)
    held = exam_held_out(root, exam)
    assert "god morgen allesammen vi starter standuppen nu og tager det hele i rækkefølge" in held.keys
    assert len(held.hashes) == 1 and held.folder == (root / "exam").resolve()
    fleurs = dataset.HeldOut(keys=frozenset(), hashes=frozenset(), folder=tmp_path / "fleurs")

    def item(**kw):
        base = dict(id="x", audio=str(root / "phone-normal" / "x.wav"), text="Noget andet.", kind="plain",
                    source="recording", audio_sha256="hx", seconds=1.0)
        return dataset.Item(**{**base, **kw})

    cases = [
        (item(text="I nat crashede backenden to gange, og ingen vidste hvorfor."), "exam paragraph"),
        (item(audio_sha256=next(iter(held.hashes))), "exam audio"),
        (item(audio=str(root / "exam" / "phone-normal" / "e01.wav")), "an exam file"),
    ]
    for bad, message in cases:
        with pytest.raises(LeakageError, match=message):
            dataset.check_leakage({"train": [], "validation": [bad], "test": []}, fleurs, held)


def test_build_fails_when_exam_audio_is_among_the_takes(tmp_path, fleurs_root):
    root, sentences, spelling, exam = setup(tmp_path, n=24)
    write_condition_take(root, "phone-normal", "e01", "God morgen allesammen.", seed=5, exam=True)
    shutil.copyfile(root / "exam" / "phone-normal" / "e01.wav", root / "phone-normal" / "s0001.wav")
    with pytest.raises(LeakageError, match="exam audio"):
        build(takes_config(root, sentences, spelling), out_dir=tmp_path / "b", fleurs_root=fleurs_root,
              exam_yaml=exam)
    assert not (tmp_path / "b").exists()


def test_old_manifests_still_read(tmp_path):
    line = {"id": "s0001", "audio": "/x.wav", "text": "Hej.", "kind": "plain", "source": "recording",
            "audio_sha256": "h", "seconds": 1.0}
    path = tmp_path / "train.jsonl"
    path.write_text(json.dumps(line) + "\n", encoding="utf-8")
    (item,) = dataset.read_manifest(path)
    assert item.condition == "" and item.sentence == ""
