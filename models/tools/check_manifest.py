"""Check models/manifest.json: structure, and (with --dir) that local files
match their size and SHA-256.

    python3 models/tools/check_manifest.py [--dir <models-final>] [--model ID ...]

<models-final> holds one folder per model id (edda-v0.2/, ekko-v1-tiny/,
ekko-pnc/), as the conversion scripts write them. Exit status 1 on any problem.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

MANIFEST = Path(__file__).resolve().parents[1] / "manifest.json"
SHA = re.compile(r"^[0-9a-f]{64}$")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dir", type=Path, help="folder with one sub-folder per model id")
    p.add_argument("--model", action="append", help="only these model ids")
    a = p.parse_args()
    m = json.loads(MANIFEST.read_text(encoding="utf-8"))
    problems: list[str] = []
    if not str(m.get("baseUrl", "")).endswith("/"):
        problems.append("baseUrl must end with /")
    assets = set()
    for model in m["models"]:
        for f in model["files"]:
            if not model.get("bundled"):
                assets.add(f["path"])
        for name, la in model.get("licenseAssets", {}).items():
            if name not in model.get("licenseFiles", []):
                problems.append(f"{model['id']}: licenseAssets lists {name}, not in licenseFiles")
            if not SHA.match(la["sha256"]):
                problems.append(f"{model['id']}/{name}: bad sha256")
            if la["asset"] in assets or "/" in la["asset"]:
                problems.append(f"{model['id']}/{name}: asset name {la['asset']} must be unique and flat")
            assets.add(la["asset"])
    ids = set()
    for model in m["models"]:
        mid = model["id"]
        if mid in ids:
            problems.append(f"duplicate id {mid}")
        ids.add(mid)
        if a.model and mid not in a.model:
            continue
        for f in model["files"]:
            if not SHA.match(f["sha256"]):
                problems.append(f"{mid}/{f['name']}: bad sha256")
            if not model.get("bundled") and f["path"] != f["name"]:
                problems.append(f"{mid}/{f['name']}: path must be the release asset name (flat)")
            if a.dir and not model.get("bundled"):
                local = a.dir / mid / f["name"]
                if not local.is_file():
                    problems.append(f"{mid}/{f['name']}: missing at {local}")
                    continue
                if local.stat().st_size != f["size"]:
                    problems.append(f"{mid}/{f['name']}: size {local.stat().st_size} != {f['size']}")
                elif sha256(local) != f["sha256"]:
                    problems.append(f"{mid}/{f['name']}: SHA-256 differs from the manifest")
                else:
                    print(f"ok {mid}/{f['name']}")
    for line in problems:
        print(f"error: {line}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
