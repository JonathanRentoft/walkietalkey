"""Chunk joints from real Edda output, for the joint repair tests (run 4).

WalkieTalkey decodes a dictation one speech segment at a time, cut at pauses,
and Whisper writes every segment as if it were a whole utterance: a capital
first letter, often a full stop at the end. Where a pause falls inside a
sentence, the joined text gets "... og ikke bare Kaster mig ...". This script
makes real joints of both kinds from FLEURS da_dk test (Google, CC BY 4.0),
where the reference transcription says what is right:

* ``mid``: one FLEURS utterance cut at its longest inner pause. Mostly inside
  a sentence (the second part's first word then as the reference writes it:
  lower case unless it is a name); some utterances hold two sentences and the
  pause falls between them, which the reference shows too.
* ``boundary``: two different FLEURS sentences. The joint is a sentence
  boundary and the second part starts with a capital.

Each part is decoded the way the app decodes a chunk: Edda Q8_0 through
transcribe.cpp, language Danish, text only, the built-in developer vocabulary,
and the previous part's text as context (the first part gets the app's
first-chunk sentence). Usage, from the repository root:

    uv run --project training python scripts/walkietalkey/joints/make_fixtures.py \\
        --fleurs _kit/work/datasets/fleurs-da_dk \\
        --cli _kit/work/src/transcribe.cpp-0.4.0/build-release/bin/transcribe-cli \\
        --model _kit/work/models-final/edda-v0.2/edda-v0.2-Q8_0.gguf \\
        --out src-tauri/src/pipeline/da/testdata/joints-fleurs.json
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import subprocess
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf

RATE = 16_000
FRAME = RATE // 50  # 20 ms
# src-tauri/src/pipeline/da/context.rs and vocabulary.rs, as the app sends them.
FIRST_CHUNK_PROMPT_DA = "Hej. Det her er en diktering på dansk, med punktum, komma og store bogstaver."
DEVELOPER_WORDS = (
    "pull request, deploy, standup, merge, commit, frontend, backend, branch, rebase, code review, "
    "release, staging, production, bug, feature, sprint, backlog, API, endpoint, refactor, pipeline, "
    "repository, issue, hotfix, rollback, deadline, TypeScript, JavaScript, Kubernetes, GitHub"
)


def decode(cli: str, model: str, audio: np.ndarray, prompt: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        sf.write(f.name, audio, RATE, subtype="PCM_16")
        out = subprocess.run(
            [cli, "-q", "-m", model, "-l", "da", "--timestamps", "none",
             "--vocabulary", DEVELOPER_WORDS, "--prompt", prompt, f.name],
            capture_output=True, check=True,
        ).stdout.decode("utf-8", "replace")
    lines = [line[6:] for line in out.splitlines() if line.startswith("text: ")]
    return lines[0].strip() if lines else ""


def longest_inner_pause(audio: np.ndarray) -> int | None:
    """The middle (in samples) of the longest pause of at least 250 ms that lies
    in the middle 60 % of the speech, or None."""
    n = len(audio) // FRAME
    db = 20 * np.log10(np.sqrt(np.mean(audio[: n * FRAME].reshape(n, FRAME) ** 2, axis=1)) + 1e-9)
    quiet = db < db.max() - 35
    speech = np.flatnonzero(~quiet)
    if len(speech) < 50:
        return None
    first, last = speech[0], speech[-1]
    lo, hi = first + 0.2 * (last - first), last - 0.2 * (last - first)
    best, run_start = None, None
    for i in range(first, last + 1):
        if quiet[i] and run_start is None:
            run_start = i
        elif not quiet[i] and run_start is not None:
            length = i - run_start
            middle = (run_start + i) // 2
            if length >= 13 and lo <= middle <= hi and (best is None or length > best[0]):
                best = (length, middle)
            run_start = None
    return None if best is None else best[1] * FRAME


def bare(word: str) -> str:
    return re.sub(r"[^\w'-]", "", word).lower()


def expected_joint(reference: str, before: str, after: str) -> tuple[bool, bool] | None:
    """What the reference says about the joint: whether a sentence ends there
    and whether the first word of `after` has a capital. The reference word is
    the occurrence nearest to where the cut falls (the word count of `before`).
    None if it cannot be found."""
    words = reference.split()
    target = bare(after.split()[0]) if after.split() else ""
    hits = [i for i, w in enumerate(words) if bare(w) == target]
    if not target or not hits:
        return None
    nearest = min(hits, key=lambda i: abs(i - len(before.split())))
    if nearest == 0:
        return None
    first_letter = next((c for c in words[nearest] if c.isalpha()), "")
    return words[nearest - 1].endswith((".", "?", "!")), first_letter.isupper()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fleurs", type=Path, required=True)
    ap.add_argument("--cli", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--mid", type=int, default=60)
    ap.add_argument("--boundary", type=int, default=30)
    ap.add_argument("--relabel", action="store_true",
                    help="only recompute the expected joints of the cases in --out from their references")
    args = ap.parse_args()

    if args.relabel:
        data = json.loads(args.out.read_text(encoding="utf-8"))
        for case in data["cases"]:
            if case["kind"] == "mid":
                case["boundary"], case["next_upper"] = expected_joint(case["reference"], case["before"], case["after"])
        args.out.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        print("relabelled", len(data["cases"]), "cases in", args.out)
        return

    rows, seen = [], set()
    with open(args.fleurs / "test.tsv", encoding="utf-8") as f:
        for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if row[0] not in seen:
                seen.add(row[0])
                rows.append((row[0], row[1], row[2]))
    rows.sort(key=lambda r: int(r[0]))

    cases = []
    for sid, name, reference in rows:
        if sum(c["kind"] == "mid" for c in cases) >= args.mid:
            break
        audio, rate = sf.read(args.fleurs / "test" / name, dtype="float32")
        assert rate == RATE
        cut = longest_inner_pause(audio)
        if cut is None:
            continue
        before = decode(args.cli, args.model, audio[:cut], FIRST_CHUNK_PROMPT_DA)
        after = decode(args.cli, args.model, audio[cut:], before)
        joint = expected_joint(reference, before, after) if before and after else None
        if joint is None:
            continue
        cases.append({"id": f"mid-{sid}", "kind": "mid", "before": before, "after": after,
                      "reference": reference, "boundary": joint[0], "next_upper": joint[1]})
        print(len(cases), "mid", repr(before[-40:]), "|", repr(after[:40]))

    pairs = [(rows[i], rows[i + 1]) for i in range(0, len(rows) - 1, 2)]
    for (sid_a, name_a, ref_a), (sid_b, name_b, ref_b) in pairs[: args.boundary]:
        a, _ = sf.read(args.fleurs / "test" / name_a, dtype="float32")
        b, _ = sf.read(args.fleurs / "test" / name_b, dtype="float32")
        before = decode(args.cli, args.model, a, FIRST_CHUNK_PROMPT_DA)
        after = decode(args.cli, args.model, b, before)
        if before and after:
            cases.append({"id": f"boundary-{sid_a}-{sid_b}", "kind": "boundary", "before": before,
                          "after": after, "reference": f"{ref_a} {ref_b}", "boundary": True,
                          "next_upper": True})
            print(len(cases), "boundary", repr(before[-40:]), "|", repr(after[:40]))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({
        "source": "FLEURS da_dk test (google/fleurs, CC BY 4.0); parts decoded by Edda v0.2 Q8_0 "
                  "through transcribe.cpp 0.4.0 as the app decodes chunks "
                  "(scripts/walkietalkey/joints/make_fixtures.py)",
        "cases": cases,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print("wrote", len(cases), "cases to", args.out)


if __name__ == "__main__":
    main()
