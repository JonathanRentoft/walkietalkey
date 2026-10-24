"""The smoke test's own parts: stand-in takes from FLEURS train, cleanup and the timing table.
(The chain itself is run for real with ``wt-train smoke``.)"""

from wt_train import smoke
from wt_train.dataset import sentence_key
from wt_train.sentences import load_sentences
from wt_train.spelling import load_spelling


def test_stand_ins_are_distinct_fleurs_train_sentences(tmp_path, fleurs_root):
    takes, sentences, spelling = smoke.make_stand_ins(tmp_path / "smoke", 6, seed=1, fleurs_root=fleurs_root)
    rows = load_sentences(sentences)
    assert len(rows) == 6 and all(r.kind == "plain" for r in rows)
    assert len({sentence_key(r.text) for r in rows}) == 6
    for r in rows:
        assert (takes / f"{r.id}.wav").is_file()
        assert (takes / f"{r.id}.txt").read_text(encoding="utf-8").strip() == r.text
    assert load_spelling(spelling).terms


def test_cleanup_deletes_files_folders_and_emptied_cache_shards(tmp_path):
    cache = tmp_path / "cache" / "ab"
    cache.mkdir(parents=True)
    entry = cache / "abcd.npy"
    entry.write_bytes(b"x" * 10)
    folder = tmp_path / "run"
    (folder / "sub").mkdir(parents=True)
    (folder / "sub" / "f").write_bytes(b"y" * 5)
    c = smoke.Cleanup()
    c.add(folder, entry, tmp_path / "never-made")
    assert c.run() == (2, 15)
    assert not folder.exists() and not cache.exists() and (tmp_path / "cache").exists()


def test_timing_table():
    table = smoke.format_timings([("build", 1.25, "ok"), ("train", 10.0, "")])
    assert "build" in table and "11.2" in table.splitlines()[-1]
