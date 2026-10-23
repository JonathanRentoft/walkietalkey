"""DESK-41 applied to a harness run: Ekko PnC (crates/ekko-pnc, through its
`punctuate` example) on every clip whose hypothesis has fewer than 1 mark per
25 words; the punctuation measure before and after.

    cargo build --release --example punctuate --manifest-path crates/ekko-pnc/Cargo.toml
    python -m wt_eval.pnc_after --punctuate <target>/release/examples/punctuate \
        --pnc-dir <ekko-pnc files> <harness-out>/<model>.jsonl ...
"""

from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from .punctuation import count_marks, needs_pnc, word_count


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--punctuate", required=True, type=Path, help="crates/ekko-pnc examples/punctuate binary")
    p.add_argument("--pnc-dir", required=True, type=Path)
    p.add_argument("rows", nargs="+", type=Path)
    a = p.parse_args(argv)
    for jl in a.rows:
        rows = [json.loads(l) for l in jl.read_text(encoding="utf-8").splitlines() if l.strip()]
        cases = [{"name": r["id"], "input": r["hypothesis"]} for r in rows if r["pnc_trigger"]]
        with tempfile.TemporaryDirectory() as td:
            cj = Path(td) / "cases.json"
            cj.write_text(json.dumps({"cases": cases}, ensure_ascii=False), encoding="utf-8")
            proc = subprocess.run([str(a.punctuate), str(a.pnc_dir), "--json-cases", str(cj)],
                                  capture_output=True, text=True, check=True)
        out = json.loads(proc.stdout)
        final = [out.get(r["id"], r["hypothesis"]) if r["pnc_trigger"] else r["hypothesis"] for r in rows]
        before = sum(count_marks(r["hypothesis"]) for r in rows) / max(1, sum(word_count(r["hypothesis"]) for r in rows)) * 25
        after = sum(count_marks(t) for t in final) / max(1, sum(word_count(t) for t in final)) * 25
        ref = sum(r["ref_marks"] for r in rows) / max(1, sum(r["ref_words_raw"] for r in rows)) * 25
        still = sum(1 for t in final if needs_pnc(t))
        ends = sum(1 for t in final if t.rstrip().endswith((".", "?", "!")))
        print(f"{jl.stem}: PnC ran on {len(cases)}/{len(rows)} clips; marks per 25 words {before:.2f} -> {after:.2f} "
              f"(references {ref:.2f}); clips still under 1 per 25 words: {still}; ending in . ? !: {ends}/{len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
