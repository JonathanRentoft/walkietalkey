"""Værkstedet's "Lær det" screen: the learning notebooks (``training/notebooks/``, run 11), each
opened in VS Code as a working copy.

The notebooks are committed without outputs (``tests/test_notebooks.py``). Opening one never
hands the owner the committed file: the server copies ``training/notebooks/<name>.ipynb`` to
``<work>/notebooks/<name>.ipynb`` (git-ignored) when that copy is missing, so his runs and edits
never dirty the repository, and opens VS Code with the training folder as its workspace
(``training/.vscode/settings.json`` picks the workbench's ``.venv`` as the kernel) and the copy
as the file: ``open -b com.microsoft.VSCode <training> <copy>``, by bundle id, since VS Code
may live anywhere (on the owner's Mac in ~/Downloads); else a ``code`` command on the PATH; else
the error ``no-vscode``. "Start forfra" puts the original back; the copy it replaces is kept in
``<work>/notebooks/.replaced/``.

A notebook is read by its contract (``test_notebooks.py``): the title is the first markdown
cell's heading after the "·" (``# 01 · Lyden``), the summary and the minutes are
``metadata.wt``, the number is ``metadata.wt.number`` (else the heading's, else the name's). A
file that does not parse as a notebook is left out. A copy has "ran" when one of its code cells
has outputs.

Tests never launch anything: ``launch`` is injectable (the server's ``launch=``), and
``WT_OPEN`` and ``WT_CODE`` name the programs (``WT_CODE=""``: no code command).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable

from .places import StudioPaths
from .recording import StudioError

__all__ = ["BUNDLE", "Learn", "StudioPaths", "has_outputs", "openers", "read_notebook", "run_command"]

BUNDLE = "com.microsoft.VSCode"
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")
LAUNCH_TIMEOUT_S = 20
_HEADING = re.compile(r"#+\s+(?:(\d+)\s*·\s*)?(.+?)\s*$")
_LEADING_NUMBER = re.compile(r"(\d+)")


def run_command(argv: list[str]) -> int:
    """Runs a launcher (``open``, ``code``) and returns its exit status; a program that cannot be
    started, or does not finish in time, counts as not found (127)."""
    try:
        return subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL, timeout=LAUNCH_TIMEOUT_S).returncode
    except (OSError, subprocess.TimeoutExpired):
        return 127


def openers() -> list[tuple[str, list[str]]]:
    """How VS Code can be opened here, in order: by bundle id, then a ``code`` command."""
    out = [("open", [os.environ.get("WT_OPEN") or "open", "-b", BUNDLE])]
    code = os.environ["WT_CODE"] if "WT_CODE" in os.environ else shutil.which("code")
    if code:
        out.append(("code", [code]))
    return out


def _text(source) -> str:
    return "".join(source) if isinstance(source, list) else str(source or "")


def read_notebook(path: Path) -> dict | None:
    """``number``, ``title``, ``summary`` and ``minutes`` of a notebook, or None for a file that
    is not one."""
    try:
        nb = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(nb, dict) or not isinstance(nb.get("cells"), list):
        return None
    meta = nb.get("metadata") if isinstance(nb.get("metadata"), dict) else {}
    wt = meta.get("wt") if isinstance(meta.get("wt"), dict) else {}
    title, heading_number = Path(path).stem, None
    first = next((c for c in nb["cells"] if isinstance(c, dict) and c.get("cell_type") == "markdown"), None)
    if first is not None:
        line = _text(first.get("source")).strip().split("\n")[0]
        m = _HEADING.fullmatch(line)
        if m:
            heading_number, title = (int(m.group(1)) if m.group(1) else None), m.group(2)
    number = wt.get("number")
    if not isinstance(number, int) or isinstance(number, bool):
        named = _LEADING_NUMBER.match(Path(path).stem)
        number = heading_number if heading_number is not None else (int(named.group(1)) if named else None)
    summary = wt.get("summary") if isinstance(wt.get("summary"), str) and wt["summary"].strip() else None
    minutes = wt.get("minutes") if isinstance(wt.get("minutes"), int) and not isinstance(wt["minutes"], bool) \
        else None
    return {"number": number, "title": title, "summary": summary, "minutes": minutes}


def has_outputs(nb) -> bool:
    cells = nb.get("cells") if isinstance(nb, dict) else None
    if not isinstance(cells, list):
        return False
    return any(isinstance(c, dict) and c.get("cell_type") == "code" and c.get("outputs") for c in cells)


def _copy(source: Path, target: Path) -> None:
    """``source`` to ``target`` through a temporary file beside it, so a copy is never half there."""
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".part", dir=target.parent)
    os.close(fd)
    try:
        shutil.copyfile(source, tmp)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


class Learn:
    def __init__(self, places: StudioPaths, launch: Callable[[list[str]], int] | None = None):
        self.places = places
        self.launch = launch or run_command
        self._lock = threading.Lock()

    @property
    def folder(self) -> Path:
        return Path(self.places.notebooks)

    @property
    def copies(self) -> Path:
        return Path(self.places.notebook_copies)

    def _originals(self) -> list[tuple[Path, dict]]:
        found = []
        for path in sorted(self.folder.glob("*.ipynb")) if self.folder.is_dir() else []:
            if not NAME.fullmatch(path.stem) or not path.is_file():
                continue
            info = read_notebook(path)
            if info is not None:
                found.append((path, info))
        return sorted(found, key=lambda pi: (pi[1]["number"] is None, pi[1]["number"] or 0, pi[0].stem))

    def _row(self, path: Path, info: dict) -> dict:
        copy = self.copies / path.name
        ran, saved = False, None
        if copy.is_file():
            saved = _iso(copy.stat().st_mtime)
            try:
                ran = has_outputs(json.loads(copy.read_text(encoding="utf-8")))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                ran = False
        return {"name": path.stem, **info, "copy": copy.is_file(), "ran": ran, "saved": saved}

    def listing(self) -> dict:
        return {"notebooks": [self._row(p, i) for p, i in self._originals()], "copies": str(self.copies)}

    def _find(self, name) -> tuple[Path, dict]:
        for path, info in self._originals():
            if isinstance(name, str) and path.stem == name:
                return path, info
        raise StudioError(404, "unknown", f"no notebook {name!r} in {self.folder}")

    def open(self, name) -> dict:
        path, info = self._find(name)
        copy = self.copies / path.name
        with self._lock:
            created = not copy.is_file()
            if created:
                _copy(path, copy)
        workspace = str(Path(self.places.workspace))
        for how, argv in openers():
            if self.launch([*argv, workspace, str(copy)]) == 0:
                return {"notebook": self._row(path, info), "created": created, "with": how}
        raise StudioError(409, "no-vscode", f"VS Code was not found: no app with bundle id {BUNDLE} "
                                            "and no code command on the PATH")

    def reset(self, name) -> dict:
        path, info = self._find(name)
        copy = self.copies / path.name
        kept = None
        with self._lock:
            if copy.is_file():
                aside = self.copies / ".replaced"
                aside.mkdir(parents=True, exist_ok=True)
                kept = aside / f"{path.stem}-{datetime.now():%Y%m%d-%H%M%S-%f}.ipynb"
                os.replace(copy, kept)
            _copy(path, copy)
        return {"notebook": self._row(path, info), "kept": str(kept) if kept else None}
