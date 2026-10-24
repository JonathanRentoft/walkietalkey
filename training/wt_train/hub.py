"""Hugging Face downloads: public files only, anonymously, into the work folder.

Every download goes through here so that it never uses a token (``token=False``
on every call, and implicit tokens disabled), never sends telemetry, and keeps
its metadata in the work folder's own ``HF_HOME`` instead of the user's cache.
"""

from __future__ import annotations

import os
from pathlib import Path

from . import paths
from .audio import file_sha256


def hub_environment() -> None:
    """Point huggingface_hub at the work folder; call before importing it."""
    os.environ.setdefault("HF_HOME", str(paths.hf_home()))
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    # Xet's local chunk cache would keep a second copy of every download.
    os.environ.setdefault("HF_XET_CHUNK_CACHE_SIZE_BYTES", "0")


def download_file(repo_id: str, filename: str, *, revision: str, local_dir: Path,
                  repo_type: str = "model") -> Path:
    """One file of a public repo at a pinned revision, saved under ``local_dir``."""
    hub_environment()
    from huggingface_hub import hf_hub_download

    return Path(hf_hub_download(repo_id, filename, repo_type=repo_type, revision=revision,
                                local_dir=str(local_dir), token=False))


def model_snapshot(repo: str, revision: str) -> Path:
    """A local snapshot of a Whisper checkpoint at ``revision``.

    The pinned Edda is reused from ``dl/edda-v0.2`` when models/edda/convert.sh
    already downloaded it, and its weights are checked against the SHA-256 the
    shipped GGUF was converted from (once; the result is remembered next to it).
    """
    target = paths.snapshot_dir(repo, revision)
    if not ((target / "model.safetensors").is_file() and (target / "config.json").is_file()):
        hub_environment()
        from huggingface_hub import snapshot_download

        snapshot_download(repo, revision=revision, local_dir=str(target), token=False,
                          allow_patterns=["*.json", "*.txt", "model.safetensors"])
    if repo == paths.EDDA_REPO and revision == paths.EDDA_REVISION:
        verify_once(target / "model.safetensors", paths.EDDA_SAFETENSORS_SHA256)
    return target


def verify_once(path: Path, expected_sha256: str) -> None:
    """Check a large file's SHA-256, remembering a pass by size and mtime."""
    stat = path.stat()
    marker = path.with_name(f".{path.name}.wt-train-verified")
    stamp = f"{stat.st_size} {stat.st_mtime_ns} {expected_sha256}"
    if marker.is_file() and marker.read_text().strip() == stamp:
        return
    actual = file_sha256(path)
    if actual != expected_sha256:
        raise RuntimeError(f"{path}: SHA-256 {actual}, expected {expected_sha256}")
    marker.write_text(stamp + "\n")
