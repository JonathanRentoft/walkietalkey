import struct
from pathlib import Path

import pytest

from wt_eval.datasets import Clip, load_clips_dir, load_fleurs, prepare_audio, wav_info


def test_prepare_audio_converts_only_what_the_engine_cannot_read(tmp_path):
    good = tmp_path / "good.wav"
    write_wav(good)  # 16 kHz mono PCM16
    stereo = tmp_path / "stereo.wav"
    write_wav(stereo, rate=48000, channels=2, frames=4800)
    clips = [Clip("good", good, "a", 0.1), Clip("stereo", stereo, "b", 0.1)]
    calls = []

    def fake_convert(src: Path, dst: Path) -> None:
        calls.append((src, dst))
        write_wav(dst)

    out = prepare_audio(clips, tmp_path / "cache", convert=fake_convert)
    assert out[0] == clips[0]
    assert out[1].wav == tmp_path / "cache" / "stereo.wav" and out[1].reference == "b"
    assert calls == [(stereo, tmp_path / "cache" / "stereo.wav")]


def write_wav(path: Path, *, rate=16000, channels=1, bits=16, fmt=1, frames=1600):
    block = channels * bits // 8
    data = b"\x00" * (frames * block)
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, fmt, channels, rate, rate * block, block, bits)
    header += b"data" + struct.pack("<I", len(data))
    path.write_bytes(header + data)


def test_wav_info(tmp_path):
    p = tmp_path / "a.wav"
    write_wav(p, rate=48000, channels=2, frames=4800)
    info = wav_info(p)
    assert (info.rate, info.channels, info.bits, info.format) == (48000, 2, 16, 1)
    assert info.seconds == pytest.approx(0.1)


def test_load_fleurs_uses_raw_transcription_and_sorts(tmp_path):
    (tmp_path / "test").mkdir()
    tsv = tmp_path / "test.tsv"
    tsv.write_text(
        "7\tb.wav\tHej, med dig.\thej med dig\th e j\t32000\tMALE\n"
        "3\ta.wav\tGod dag.\tgod dag\tg o d\t16000\tFEMALE\n",
        encoding="utf-8",
    )
    for name in ("a.wav", "b.wav"):
        write_wav(tmp_path / "test" / name)
    clips = load_fleurs(tmp_path)
    assert [c.id for c in clips] == ["fleurs-da_dk-a", "fleurs-da_dk-b"]
    assert clips[0] == Clip(id="fleurs-da_dk-a", wav=tmp_path / "test" / "a.wav", reference="God dag.", seconds=1.0)
    assert clips[1].seconds == 2.0


def test_load_fleurs_limit_takes_an_evenly_spread_deterministic_subset(tmp_path):
    (tmp_path / "test").mkdir()
    lines = []
    for i in range(10):
        name = f"{i:02d}.wav"
        write_wav(tmp_path / "test" / name)
        lines.append(f"{i}\t{name}\tTekst {i}.\ttekst\tt\t16000\tMALE\n")
    (tmp_path / "test.tsv").write_text("".join(lines), encoding="utf-8")
    ids = [c.id for c in load_fleurs(tmp_path, limit=3)]
    assert ids == ["fleurs-da_dk-00", "fleurs-da_dk-03", "fleurs-da_dk-06"]


def test_load_clips_dir_pairs_wav_and_txt(tmp_path):
    write_wav(tmp_path / "one.wav")
    (tmp_path / "one.txt").write_text("Første diktat.\n", encoding="utf-8")
    write_wav(tmp_path / "two.wav")  # no transcript: skipped
    (tmp_path / "three.txt").write_text("no audio", encoding="utf-8")
    clips = load_clips_dir(tmp_path)
    assert [(c.id, c.reference) for c in clips] == [("one", "Første diktat.")]


def test_load_clips_dir_refuses_paths_inside_the_repository(tmp_path):
    repo = Path(__file__).resolve().parents[3]
    with pytest.raises(ValueError, match="outside the repository"):
        load_clips_dir(repo / "models")
