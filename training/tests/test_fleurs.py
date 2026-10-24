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
