import struct
import wave
from pathlib import Path

from wt_eval.vadsplit import cut_segments, parse_segments


VAD_OUTPUT = """speech segments: 3
  segment: 0 start=32 end=51168 t0=0.002 t1=3.198
  segment: 1 start=54304 end=123872 t0=3.394 t1=7.742
  segment: 2 start=139808 end=190432 t0=8.738 t1=11.902
  frames:     619 (512 samples each)
"""


def test_parse_segments():
    assert parse_segments(VAD_OUTPUT) == [(32, 51168), (54304, 123872), (139808, 190432)]


def write_pcm16(path: Path, samples: list[int]):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))


def read_pcm16(path: Path) -> list[int]:
    with wave.open(str(path)) as w:
        raw = w.readframes(w.getnframes())
    return list(struct.unpack(f"<{len(raw) // 2}h", raw))


def test_cut_segments_pads_and_clamps(tmp_path):
    src = tmp_path / "clip.wav"
    write_pcm16(src, list(range(32000)))  # 2 s
    out = cut_segments(src, [(100, 1000), (31000, 32000)], tmp_path / "seg", pad=160)
    assert [p.name for p in out] == ["clip-000.wav", "clip-001.wav"]
    first, last = read_pcm16(out[0]), read_pcm16(out[1])
    assert first[0] == 0 and first[-1] == 1159        # 100-160 clamped to 0, 1000+160
    assert last[0] == 30840 and last[-1] == 31999     # 31000-160, end clamped


def test_no_speech_keeps_the_whole_clip(tmp_path):
    src = tmp_path / "quiet.wav"
    write_pcm16(src, [0] * 1600)
    out = cut_segments(src, [], tmp_path / "seg", pad=160)
    assert len(out) == 1 and read_pcm16(out[0]) == [0] * 1600
