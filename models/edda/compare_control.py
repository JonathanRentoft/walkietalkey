"""Summarise models/edda/validate.sh: Edda's tensor drift next to stock
Whisper turbo's on the same cases, build and machine (the "control").

    python models/edda/compare_control.py <work-dir>/runs/edda-validation
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROW = re.compile(r"^((?:enc|dec)\.[\w.]+)\s+(ok|FAIL)\s+\[[^\]]*\]\s+([0-9.e+-]+)\s+([0-9.e+-]+)", re.M)
SUMMARY = re.compile(r"^\d+/\d+ tensors within tolerance$", re.M)
# validate.py prints its "compare [...]" headers to stderr and the compare rows
# to stdout, so headers interleave unpredictably in a combined log. The row
# blocks themselves come out in manifest case order; the mel-parity pass runs
# with --quiet and prints no rows.
CASES = ["fleurs-da-6263195548503774343", "fleurs-da-17924706686437869147", "jfk"]


def parse(log: str) -> dict[str, dict[str, tuple[str, float, float]]]:
    blocks = []
    start = 0
    for m in SUMMARY.finditer(log):
        rows = {r[1]: (r[2], float(r[3]), float(r[4])) for r in ROW.finditer(log[start:m.start()])}
        if rows:
            blocks.append(rows)
        start = m.end()
    return dict(zip(CASES, blocks))


def transcripts(log: str) -> list[str]:
    return re.findall(r"(Transcript: ok \(exact\).*|FAIL transcript mismatch.*)", log)


def main() -> int:
    d = Path(sys.argv[1])
    edda, turbo = parse((d / "tensors.log").read_text()), parse((d / "control.log").read_text())
    print("| case | tensors within budget: Edda | turbo | worst max_abs: Edda | turbo |")
    print("|---|---:|---:|---:|---:|")
    for case in edda:
        e, t = edda[case], turbo.get(case, {})
        ok_e = sum(1 for v in e.values() if v[0] == "ok")
        ok_t = sum(1 for v in t.values() if v[0] == "ok")
        worst_e = max(e.items(), key=lambda kv: kv[1][1])
        worst_t = max(t.items(), key=lambda kv: kv[1][1]) if t else ("-", ("", 0.0, 0.0))
        print(f"| {case} | {ok_e}/{len(e)} | {ok_t}/{len(t)} | {worst_e[1][1]:.3g} ({worst_e[0]}) "
              f"| {worst_t[1][1]:.3g} ({worst_t[0]}) |")
    print()
    print("Per-tensor max_abs, Edda / turbo (tensors outside the budget for either model):")
    for case in edda:
        e, t = edda[case], turbo.get(case, {})
        names = sorted(n for n in e if e[n][0] == "FAIL" or t.get(n, ("ok",))[0] == "FAIL")
        cells = [f"{n} {e[n][1]:.2g}/{t[n][1]:.2g}" for n in names if n in t]
        print(f"- {case}: " + "; ".join(cells))
    print()
    print("Edda transcripts:", *transcripts((d / "tensors.log").read_text()), sep="\n  ")
    print("Turbo transcripts:", *transcripts((d / "control.log").read_text()), sep="\n  ")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
