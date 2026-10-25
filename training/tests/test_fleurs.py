"""FLEURS da_dk: loading a split and fetching it once, offline (a fake downloader)."""

import io
import tarfile

import pytest

from wt_train import fleurs


def test_load_split_reads_ids_texts_and_sentence_ids(fleurs_root):
    train = fleurs.load_split("train", fleurs_root)
    assert len(train) == 14
    first = train[0]
    assert first.id == "fleurs-da_dk-1000" and first.split == "train"
    assert first.text == "Træningssætning nummer en her." and first.sentence_id == "t0"
    assert first.wav.is_file() and first.seconds == 0.5
    assert [c.id for c in train] == sorted(c.id for c in train)


def test_missing_audio_is_an_error(fleurs_root):
    (fleurs_root / "test" / "2001.wav").unlink()
    with pytest.raises(FileNotFoundError, match="missing"):
        fleurs.load_split("test", fleurs_root)


def test_fetch_downloads_unpacks_and_marks_once(tmp_path, make_wav):
    src = tmp_path / "src"
    wav = make_wav(src / "train" / "42.wav", seed=1)
    tsv = src / "train.tsv"
    tsv.write_text("s1\t42.wav\tHej med dig.\thej med dig\tx\t8000\tMALE\n", encoding="utf-8")
    archive = src / "train.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(wav, arcname="train/42.wav")
    calls = []

    def fake_download(repo, filename, *, repo_type, revision, local_dir):
        calls.append((repo, filename, repo_type, revision))
        out = local_dir / filename
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes((tsv if filename.endswith(".tsv") else archive).read_bytes())
        return out

    root = tmp_path / "datasets" / "fleurs-da_dk"
    fleurs.fetch("train", root, download=fake_download)
    assert [c[1] for c in calls] == ["data/da_dk/train.tsv", "data/da_dk/audio/train.tar.gz"]
    assert all(c[0] == "google/fleurs" and c[2] == "dataset" and c[3] == fleurs.paths.FLEURS_REVISION
               for c in calls)
    assert fleurs.is_ready("train", root) and not fleurs.is_ready("test", root)
    assert [c.text for c in fleurs.load_split("train", root)] == ["Hej med dig."]
    # The archive is gone; a second fetch downloads nothing.
    assert not (tmp_path / "datasets" / "fleurs-raw" / "data/da_dk/audio/train.tar.gz").exists()
    fleurs.fetch("train", root, download=fake_download)
    assert len(calls) == 2


def test_fetch_refuses_archive_paths_outside_the_folder(tmp_path):
    archive = tmp_path / "evil.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        data = b"x"
        info = tarfile.TarInfo("../outside.txt")
        info.size = len(data)
        tar.addfile(info, io.BytesIO(data))
    tsv = tmp_path / "t.tsv"
    tsv.write_text("", encoding="utf-8")

    def fake_download(repo, filename, **_):
        return tsv if filename.endswith(".tsv") else archive

    with pytest.raises(tarfile.TarError):
        fleurs.fetch("test", tmp_path / "root", download=fake_download)
    assert not (tmp_path / "outside.txt").exists()


def test_train_and_test_share_no_sentence_text_file_or_audio(fleurs_root):
    """Run 7: Edda was trained on FLEURS da_dk train (its model card); our regression check is
    FLEURS test, so the two must share nothing: no sentence, no text, no file, no audio."""
    from wt_train.fleurs import load_split, overlap

    result = overlap(load_split("train", fleurs_root), load_split("test", fleurs_root))
    assert result["clips"] == {"train": 14, "test": 4}
    assert result["sentences"] == {"train": 12, "test": 4}
    assert result["shared"] == {"sentence_ids": [], "texts": [], "files": [], "audio": []}
    assert result["clean"] is True


def test_a_test_clip_inside_train_is_found_by_text_file_and_audio(fleurs_root):
    import shutil

    from wt_train.fleurs import load_split, overlap

    train, test = load_split("train", fleurs_root), load_split("test", fleurs_root)
    # the same audio under another name, and the same text under another sentence id
    shutil.copyfile(train[0].wav, test[0].wav)
    moved = [*test[1:], test[0].__class__(**{**test[0].__dict__, "text": train[3].text})]
    result = overlap(train, moved)
    assert result["shared"]["audio"] == [test[0].id]
    assert result["shared"]["texts"] == [test[0].id]
    assert result["clean"] is False
