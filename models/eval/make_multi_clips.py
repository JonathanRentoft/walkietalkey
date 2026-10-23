"""Build multi-utterance test clips from FLEURS da_dk test: K consecutive
utterances (different sentences, file-name order), kept under 29.5 s so each
clip is one Whisper window. The output folder is a --clips-dir for
models/eval/run.sh (<name>.wav + <name>.txt).

Dictation chunks hold several sentences with pauses between them, which single
FLEURS utterances do not test. Greedy Whisper decoding can end a window at the
first pause (Edda does; see docs/MODELS.md).

    python3 models/eval/make_multi_clips.py <fleurs-da_dk-dir> <out-dir> --per-clip 2 --count 100
    python3 models/eval/make_multi_clips.py ... --gap 0.3

Default: utterances joined with the pauses they were recorded with. --gap S:
each utterance trimmed to its speech (first to last 20 ms frame within 35 dB
of the utterance's loudest frame) and joined with S seconds of silence.
"""

from __future__ import annotations

import argparse
import array
import csv
import subprocess
import wave
from pathlib import Path

RATE = 16000


def decode(path: Path) -> array.array:
    raw = subprocess.run(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", str(path), "-f", "s16le",
                          "-ac", "1", "-ar", str(RATE), "-"], capture_output=True, check=True).stdout
    pcm = array.array("h")
    pcm.frombytes(raw)
    return pcm


def trim(pcm: array.array, floor_db: float = 35.0) -> array.array:
    frame = RATE // 50
    energies = []
    for i in range(0, len(pcm), frame):
        chunk = pcm[i:i + frame]
        energies.append(sum(s * s for s in chunk) / max(1, len(chunk)))
    peak = max(energies) or 1.0
    limit = peak * 10 ** (-floor_db / 10)
    voiced = [i for i, e in enumerate(energies) if e >= limit]
    if not voiced:
        return pcm
    return pcm[voiced[0] * frame:(voiced[-1] + 1) * frame]


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("fleurs", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--per-clip", type=int, default=2)
    p.add_argument("--count", type=int, default=100)
    p.add_argument("--max-seconds", type=float, default=29.5)
    p.add_argument("--gap", type=float, default=None,
                   help="trim each utterance to its speech and join with this many seconds of silence")
    a = p.parse_args()
    rows = []
    with (a.fleurs / "test.tsv").open(encoding="utf-8", newline="") as f:
        for r in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            rows.append((r[1], int(r[0]), r[2].strip(), int(r[5]) / RATE))
    rows.sort()
    a.out.mkdir(parents=True, exist_ok=True)
    made, i = 0, 0
    while made < a.count and i + a.per_clip <= len(rows):
        group = rows[i:i + a.per_clip]
        i += a.per_clip
        if len({g[1] for g in group}) < a.per_clip or sum(g[3] for g in group) > a.max_seconds:
            continue
        pcm = array.array("h")
        for k, g in enumerate(group):
            part = decode(a.fleurs / "test" / g[0])
            if a.gap is not None:
                part = trim(part)
                if k:
                    pcm.extend([0] * int(round(a.gap * RATE)))
            pcm.extend(part)
        name = f"fleurs-multi{a.per_clip}-{made:03d}"
        with wave.open(str(a.out / f"{name}.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(pcm.tobytes())
        (a.out / f"{name}.txt").write_text(" ".join(g[2] for g in group) + "\n", encoding="utf-8")
        made += 1
    print(f"wrote {made} clips of {a.per_clip} utterances to {a.out}"
          + ("" if a.gap is None else f" (speech trimmed, {a.gap} s gaps)"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
