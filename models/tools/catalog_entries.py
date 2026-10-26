"""Write ready-to-paste entries for the app's model catalog
(src-tauri/src/catalog/catalog.json, schema 2) for Ekko v1 Tiny and Edda:
the `models[]` object and the `results{}` cell, from models/manifest.json and a
harness summary (models/eval/run.sh).

    python3 models/tools/catalog_entries.py <harness-out>/summary.json

Writes models/ekko-v1-tiny/catalog-entry.json and models/edda/catalog-entry.json.
`revision` names the GitHub release the files are published in (models-v1). `results`
carries accuracy only: the catalog's performance numbers are real-time factors
on Handy's benchmark machine (Ryzen 7 PRO 4750U), which we did not measure.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

MODELS = Path(__file__).resolve().parents[1]

ENTRIES = {
    "ekko-v1-tiny": {
        "summary_key": "ekko-v1-tiny-q8_0",
        "description": "Fast Danish model for computers without a GPU. No punctuation of its own",
        "description_da": "Hurtig dansk talemodel til computere uden grafikkort.",
        "parameters": "110M",
        "capabilities": {"streaming": False, "translate": False, "languageDetection": False, "timestamps": True},
        "out": MODELS / "ekko-v1-tiny" / "catalog-entry.json",
    },
    "edda-v0.2": {
        "summary_key": "edda-v0.2-q8_0",
        "description": "Most accurate Danish model. Needs a GPU or Apple Silicon to be fast",
        "description_da": "Den mest præcise danske talemodel.",
        "parameters": "809M",
        # Timestamps are false on purpose: Edda drops words with Whisper's
        # segment timestamps on, so the app must decode with TimestampKind::None.
        "capabilities": {"streaming": False, "translate": False, "languageDetection": False, "timestamps": False},
        "out": MODELS / "edda" / "catalog-entry.json",
    },
}


def main() -> int:
    summary = json.loads(Path(sys.argv[1]).read_text())
    manifest = json.loads((MODELS / "manifest.json").read_text())
    by_id = {m["id"]: m for m in manifest["models"]}
    for mid, spec in ENTRIES.items():
        m = by_id[mid]
        s = summary["models"][spec["summary_key"]]
        f = m["files"][0]
        entry = {
            "id": mid,
            "name": m["name"],
            "description": spec["description"],
            "repository": "walkietalkey/" + mid + ("-gguf" if f["name"].endswith(".gguf") else ""),
            "revision": "models-v1",
            "previousRevisions": [],
            "license": m["license"],
            "family": m["family"],
            "parameters": spec["parameters"],
            "languages": ["da"],
            "capabilities": spec["capabilities"],
            "quant": f["quant"],
            "role": "asr",
            "curated": True,
            "minEngine": m["minEngine"],
            "files": {f["quant"]: {"filename": f["name"], "size": f["size"], "sha256": f["sha256"]}},
        }
        results = {mid: {"accuracy": {"da": {
            "error": round(s["wer"] * 100, 2),
            "ciLower": round(s["wer_ci95"][0] * 100, 2),
        }}}}
        out = {
            "_comment": [
                "Paste `model` into catalog.json models[] and `results` into catalog.json results{}.",
                f"Accuracy: WER on FLEURS da_dk test ({s['clips']} clips), Q8_0, language da, timestamps "
                f"{s['timestamps']}, normaliser of models/eval (ciLower: 2.5th percentile of a clip bootstrap).",
                "Files download from the GitHub release models-v1 (models/release.sh); description_da is UI copy the owner approved (run 8).",
            ],
            "model": entry,
            "description_da": spec["description_da"],
            "results": results,
        }
        spec["out"].write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"wrote {spec['out']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
