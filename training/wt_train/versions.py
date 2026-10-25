"""Model versions (run 6): every export is a version of one registered model.

``wt-train export`` installs a fine-tune in the app's models folder as
``edda-ft-<slug>-v<N>.gguf`` and registers it in MLflow's model registry as
version N of ``edda-da``, pointing at its export run (which sits under its
training run, with the metrics, the config and the model card). The weights
themselves stay in the app's folder; nothing is copied into MLflow or uploaded.

Next to each GGUF goes ``<id>.json``, the version's sidecar: its number, name,
run, date and validation WER. The app reads it to list the installed versions
in Indstillinger › Model, and the workbench reads it when tracking is off, so a
version number is never given twice: N is one more than the highest in the
registry or in the folder.

The base Edda is not a version: it is the model the app ships and keeps
installed (``wt-train use edda``). The registry alias ``app`` marks the version
the app was last switched to with ``wt-train use``; switching to Edda removes it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from . import paths

REGISTERED_MODEL = "edda-da"
APP_ALIAS = "app"
BASE = "edda"
BASE_NAME = "Edda v0.2"
SIDECAR_KEYS = ("model_id", "version", "name", "run", "created", "validation_wer", "sha256", "base_repo")


class VersionError(ValueError):
    pass


def sidecar_path(models_dir: Path, mid: str) -> Path:
    return Path(models_dir) / f"{mid}.json"


def write_sidecar(models_dir: Path, result: dict) -> Path:
    """The version's facts next to its GGUF, for the app's version list (run 6)."""
    data = {k: result.get(k) for k in SIDECAR_KEYS}
    data["registered_model"] = REGISTERED_MODEL
    data["base_repo"] = data["base_repo"] or paths.EDDA_REPO
    target = sidecar_path(models_dir, result["model_id"])
    target.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return target


def read_sidecars(models_dir: Path | None = None) -> list[dict]:
    """Every installed version's sidecar, oldest first. A sidecar whose GGUF is gone is still listed
    (``installed`` false), so the history stays readable."""
    folder = Path(models_dir or paths.app_models_dir())
    out = []
    for f in sorted(folder.glob("edda-ft-*.json")) if folder.is_dir() else []:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict) or not data.get("model_id"):
            continue
        data["installed"] = (folder / f"{data['model_id']}.gguf").is_file()
        out.append(data)
    return sorted(out, key=lambda d: (d.get("version") or 0, d["model_id"]))


def _client():
    from . import tracking

    if not tracking.enabled():
        return None, None
    return tracking.client()


def registered_versions() -> list:
    """The registry's versions of ``edda-da``, oldest first (none when tracking is off)."""
    c, _ = _client()
    if c is None:
        return []
    try:
        found = c.search_model_versions(f"name='{REGISTERED_MODEL}'")
    except Exception:  # no registered model yet
        return []
    return sorted(found, key=lambda m: int(m.version))


def next_version(models_dir: Path | None = None) -> int:
    numbers = [int(m.version) for m in registered_versions()]
    numbers += [int(d["version"]) for d in read_sidecars(models_dir) if d.get("version")]
    return max(numbers, default=0) + 1


def register(export_run_id: str, result: dict) -> int:
    """Registers an export as the next version of ``edda-da``; returns its number."""
    c, _ = _client()
    if c is None:
        return 0
    try:
        c.get_registered_model(REGISTERED_MODEL)
    except Exception:
        c.create_registered_model(
            REGISTERED_MODEL,
            description="Edda v0.2 fine-tuned with the WalkieTalkey workbench. Each version is one `wt-train export`; "
                        "the weights are in the app's models folder, never uploaded.",
            tags={"wt.base_repo": paths.EDDA_REPO, "wt.base_model_id": paths.SHIPPED_EDDA_ID})
    tags = {"wt.model_id": result["model_id"], "wt.file": Path(result["path"]).name, "wt.sha256": result["sha256"],
            "wt.train_run": result.get("run") or "", "wt.config_hash": result.get("config_hash") or "",
            "wt.change": "model"}
    if result.get("validation_wer") is not None:
        tags["wt.validation_wer"] = f"{result['validation_wer']:.4f}"
    made = c.create_model_version(REGISTERED_MODEL, source=f"runs:/{export_run_id}/model", run_id=export_run_id,
                                  tags=tags, description=result.get("name") or result["model_id"])
    number = int(made.version)
    if result.get("version") and number != int(result["version"]):
        # The file was named before registering; say so rather than rename an installed model.
        c.set_model_version_tag(REGISTERED_MODEL, made.version, "wt.file_version", str(result["version"]))
    return number


def resolve(spec: str) -> str:
    """The app's model id for ``edda``, a version number (``3`` or ``v3``) or an id."""
    spec = spec.strip()
    if spec.lower() == BASE:
        return paths.SHIPPED_EDDA_ID
    m = re.fullmatch(r"[vV]?(\d+)", spec)
    if not m:
        if spec.startswith("edda-ft-") or spec == paths.SHIPPED_EDDA_ID:
            return spec
        raise VersionError(f"{spec!r} is not edda, a version number or an edda-ft- model id")
    number = int(m.group(1))
    for v in registered_versions():
        if int(v.version) == number and v.tags.get("wt.model_id"):
            return v.tags["wt.model_id"]
    for d in read_sidecars():
        if d.get("version") == number:
            return d["model_id"]
    raise VersionError(f"there is no version {number}; wt-train use --list shows them")


def version_of(mid: str) -> int | None:
    for v in registered_versions():
        if v.tags.get("wt.model_id") == mid:
            return int(v.version)
    for d in read_sidecars():
        if d["model_id"] == mid:
            return d.get("version")
    return None


def mark_in_app(mid: str) -> None:
    """The registry alias ``app`` follows ``wt-train use``: on the version in use, none for Edda."""
    c, _ = _client()
    if c is None:
        return
    number = version_of(mid) if mid != paths.SHIPPED_EDDA_ID else None
    try:
        if number:
            c.set_registered_model_alias(REGISTERED_MODEL, APP_ALIAS, str(number))
        else:
            c.delete_registered_model_alias(REGISTERED_MODEL, APP_ALIAS)
    except Exception:  # no registered model or no alias yet
        pass


def listing() -> list[dict]:
    """Edda and every version: the registry's and the folder's, merged by model id."""
    rows: dict[str, dict] = {}
    for d in read_sidecars():
        rows[d["model_id"]] = dict(d)
    for v in registered_versions():
        mid = v.tags.get("wt.model_id")
        if not mid:
            continue
        row = rows.setdefault(mid, {"model_id": mid, "installed": False})
        row.setdefault("version", int(v.version))
        row["registered"] = True
        if row.get("validation_wer") is None and v.tags.get("wt.validation_wer"):
            row["validation_wer"] = float(v.tags["wt.validation_wer"])
        row.setdefault("run", v.tags.get("wt.train_run"))
    base = {"model_id": paths.SHIPPED_EDDA_ID, "version": None, "name": BASE_NAME, "installed": True, "base": True}
    return [base, *sorted(rows.values(), key=lambda r: (r.get("version") or 0, r["model_id"]))]
