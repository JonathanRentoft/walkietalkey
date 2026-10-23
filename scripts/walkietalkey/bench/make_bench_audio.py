#!/usr/bin/env python3
"""Build the DESK-43/46 bench inputs from Danish speech clips.

Concatenates distinct sentences from a FLEURS-style folder (a TSV of
`id<TAB>file<TAB>transcript...` and a folder of 16 kHz mono WAVs, float or
16-bit) with a short pause between sentences, as people pause when dictating,
until each target length is reached. Writes 16 kHz mono 16-bit WAVs (what the
app's headless mode reads) and the reference text next to each.

Usage: make_bench_audio.py <clips_dir> <transcripts.tsv> <out_dir> [seconds ...]
Default lengths: 15 and 120 seconds. Standard library only.
"""
import struct
import sys
import wave
from pathlib import Path

RATE = 16_000
PAUSE_SECONDS = 0.5
# Recording starts when the key goes down, a moment before the first word.
LEAD_SECONDS = 0.3


def read_wav(path: Path) -> list[float]:
    """Mono 16 kHz WAV as floats in [-1, 1]; 16-bit int or 32-bit float."""
    data = path.read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError(f"{path}: not a WAV file")
    fmt = None
    pos = 12
    while pos + 8 <= len(data):
        tag, size = data[pos : pos + 4], struct.unpack("<I", data[pos + 4 : pos + 8])[0]
        body = data[pos + 8 : pos + 8 + size]
        if tag == b"fmt ":
            fmt = struct.unpack("<HHIIHH", body[:16])
        elif tag == b"data":
            if fmt is None:
                raise ValueError(f"{path}: data before fmt")
            audio_format, channels, rate, _, _, bits = fmt
            if channels != 1 or rate != RATE:
                raise ValueError(f"{path}: need 16 kHz mono, got {rate} Hz / {channels} ch")
            if audio_format == 3 and bits == 32:
                return list(struct.unpack(f"<{len(body) // 4}f", body[: len(body) // 4 * 4]))
            if audio_format == 1 and bits == 16:
                return [s / 32768 for s in struct.unpack(f"<{len(body) // 2}h", body[: len(body) // 2 * 2])]
            if audio_format == 0xFFFE and bits == 32:
                return list(struct.unpack(f"<{len(body) // 4}f", body[: len(body) // 4 * 4]))
            raise ValueError(f"{path}: unsupported format {audio_format}/{bits}-bit")
        pos += 8 + size + (size & 1)
    raise ValueError(f"{path}: no data chunk")


def write_wav(path: Path, samples: list[float]) -> None:
    pcm = struct.pack(
        f"<{len(samples)}h", *(max(-32768, min(32767, round(s * 32767))) for s in samples)
    )
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(pcm)


def main() -> None:
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    clips_dir, tsv, out_dir = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    targets = [float(s) for s in sys.argv[4:]] or [15.0, 120.0]
    out_dir.mkdir(parents=True, exist_ok=True)

    seen: set[str] = set()
    sentences: list[tuple[Path, str]] = []
    for line in tsv.read_text(encoding="utf-8").splitlines():
        fields = line.split("\t")
        if len(fields) < 3 or fields[2] in seen:
            continue
        seen.add(fields[2])
        sentences.append((clips_dir / fields[1], fields[2]))
    sentences.sort(key=lambda item: item[0].name)

    pause = [0.0] * int(PAUSE_SECONDS * RATE)
    for target in targets:
        # Sentences in order, skipping any that would overshoot the target by
        # more than a second, until the audio is within a second of it.
        audio: list[float] = [0.0] * int(LEAD_SECONDS * RATE)
        texts: list[str] = []
        for wav, text in sentences:
            if len(audio) >= (target - 1.0) * RATE:
                break
            clip = read_wav(wav)
            gap = pause if texts else []
            if len(audio) + len(gap) + len(clip) > (target + 1.0) * RATE:
                continue
            audio.extend(gap)
            audio.extend(clip)
            texts.append(text)
        name = f"bench-{int(target)}s"
        write_wav(out_dir / f"{name}.wav", audio)
        (out_dir / f"{name}.txt").write_text(" ".join(texts) + "\n", encoding="utf-8")
        print(f"{name}: {len(audio) / RATE:.1f}s from {len(texts)} sentences")


if __name__ == "__main__":
    main()
