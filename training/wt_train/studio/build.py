"""Building Værkstedet's page before serving it: ``bun run --cwd training/studio build``.

The page (``training/studio/``, Vite + React, with the design system in
``packages/ui/``) is built into ``training/studio/dist/`` (git-ignored). On start the
server hashes the page's sources, ``training/studio``'s ``src/``, ``index.html``,
``package.json``, ``vite.config.ts`` and ``tsconfig*.json`` and ``packages/ui``'s
``src/``, ``assets/`` and ``package.json`` (paths and contents, ``node_modules`` and
``dist`` never), and builds when ``dist/index.html`` is missing or the hash differs from
``dist/.source-hash``; after a build that hash is written. ``bun`` is ``WT_BUN`` or the
one on ``PATH``. When there is no bun or the build fails, an earlier build is served
with a warning; with none the server cannot start.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .. import paths

HASH_FILE = ".source-hash"
STUDIO_SOURCES = ("src", "index.html", "package.json", "vite.config.ts", "tsconfig*.json")
UI_SOURCES = ("src", "assets", "package.json")
SKIP = {"node_modules", "dist", ".DS_Store"}
BUILD_TIMEOUT_S = 600


@dataclass(frozen=True)
class Outcome:
    """``built``, ``fresh`` (nothing changed), ``stale`` (serving an old build after a
    failure) or ``failed`` (nothing to serve); ``message`` is English, for the terminal."""

    status: str
    message: str = ""

    @property
    def ok(self) -> bool:
        return self.status != "failed"


def _files(root: Path, patterns: tuple[str, ...]) -> list[Path]:
    out: list[Path] = []
    for pattern in patterns:
        for top in sorted(root.glob(pattern)):
            if top.is_file():
                out.append(top)
            elif top.is_dir():
                out += [p for p in sorted(top.rglob("*")) if p.is_file()
                        and not any(part in SKIP for part in p.relative_to(root).parts)]
    return out


def source_hash(studio: Path, ui: Path | None = None) -> str:
    """SHA-256 over the page's sources: each file's path (relative to its root) and content."""
    h = hashlib.sha256()
    for name, root, patterns in (("studio", studio, STUDIO_SOURCES), ("ui", ui, UI_SOURCES)):
        if root is None or not Path(root).is_dir():
            continue
        for f in _files(Path(root), patterns):
            h.update(f"{name}/{f.relative_to(root).as_posix()}\0".encode("utf-8"))
            h.update(hashlib.sha256(f.read_bytes()).digest())
    return h.hexdigest()


def _say(message: str) -> None:
    print(message, flush=True)


def bun() -> str | None:
    return os.environ.get("WT_BUN") or shutil.which("bun")


def ensure_built(dist: Path, *, studio: Path | None = None, ui: Path | None = None, log=None) -> Outcome:
    """Build the page into ``dist`` when its sources changed (see the module docstring)."""
    dist = Path(dist)
    studio = Path(studio) if studio is not None else dist.parent
    ui = Path(ui) if ui is not None else paths.REPO / "packages" / "ui"
    index = dist / "index.html"
    wanted = source_hash(studio, ui)
    marker = dist / HASH_FILE
    if index.is_file() and marker.is_file() and marker.read_text(encoding="utf-8").strip() == wanted:
        return Outcome("fresh")
    tool = bun()
    if tool is None:
        problem = "bun is not installed (or set WT_BUN to it), so the page cannot be built"
    else:
        (log or _say)(f"building the page: bun run --cwd {studio} build")
        try:
            done = subprocess.run([tool, "run", "--cwd", str(studio), "build"], capture_output=True,
                                  timeout=BUILD_TIMEOUT_S)
        except (OSError, subprocess.SubprocessError) as e:
            problem = f"the build could not run: {e}"
        else:
            if done.returncode == 0 and index.is_file():
                marker.write_text(wanted + "\n", encoding="utf-8")
                return Outcome("built", "the page is built")
            tail = (done.stdout + done.stderr).decode("utf-8", "replace").strip().splitlines()[-15:]
            problem = f"the build failed (exit {done.returncode}):\n  " + "\n  ".join(tail)
    if index.is_file():
        return Outcome("stale", f"warning: {problem}; serving the earlier build in {dist}")
    return Outcome("failed", f"error: {problem}; there is no earlier build in {dist} to serve")
