"""The WalkieTalkey app as a transcriber: its own batch pipeline, headless.

A GGUF is scored through the app, not through transcribe-cli alone, because the
app is what the owner dictates with: it chunks long audio at pauses, adds
punctuation (Ekko PnC) and applies its Danish finishing. Two interfaces:

* ``walkietalkey --transcribe-list <file> --model <id> --json``: one WAV path
  per line, the model loaded once, one JSON line per file
  (``{"file", "text", "audio_secs", "transcribe_ms"}`` or ``{"file", "error"}``),
  exit status 1 if any file failed. Used when the binary has it.
* otherwise, one call per file: ``walkietalkey -f <wav> --model <id> --json``,
  which prints one JSON object with ``"text"`` (older builds, such as the
  installed /Applications app before the batch flag).

The binary is ``--app-bin`` / ``WT_APP_BIN``, else the first of
``src-tauri/target/release``, ``src-tauri/target/debug`` (in this repository)
and ``/Applications/WalkieTalkey.app`` that has the batch interface, else the
first of them that exists.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

from . import paths

INSTALLED_APP = Path("/Applications/WalkieTalkey.app/Contents/MacOS/walkietalkey")


def candidates() -> list[Path]:
    exe = "walkietalkey.exe" if sys.platform == "win32" else "walkietalkey"
    target = paths.REPO / "src-tauri" / "target"
    return [target / "release" / exe, target / "debug" / exe, INSTALLED_APP]


def find_app(explicit: Path | str | None = None) -> "App":
    chosen = explicit or os.environ.get("WT_APP_BIN")
    if chosen:
        app = App(Path(chosen))
        if not app.bin.is_file():
            raise FileNotFoundError(f"no WalkieTalkey binary at {app.bin}")
        return app
    existing = [App(p) for p in candidates() if p.is_file()]
    if not existing:
        raise FileNotFoundError("no WalkieTalkey binary found; build the app or pass --app-bin")
    return next((a for a in existing if a.supports_batch), existing[0])


@dataclass(frozen=True)
class AppResult:
    file: str
    text: str
    error: str | None = None
    audio_secs: float | None = None
    transcribe_ms: float | None = None


def _json_lines(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


class App:
    def __init__(self, binary: Path, timeout: float = 600.0):
        self.bin = Path(binary)
        self.timeout = timeout

    def __repr__(self) -> str:
        return f"App({self.bin})"

    def _run(self, args: list[str], timeout: float | None = None) -> subprocess.CompletedProcess:
        return subprocess.run([str(self.bin), *args], capture_output=True, timeout=timeout or self.timeout)

    @cached_property
    def supports_batch(self) -> bool:
        try:
            out = self._run(["--help"], timeout=60)
        except (OSError, subprocess.SubprocessError):
            return False
        return b"--transcribe-list" in out.stdout + out.stderr

    def list_models(self) -> list[dict]:
        out = self._run(["--list-models", "--json"], timeout=120)
        if out.returncode != 0:
            raise RuntimeError(f"{self.bin} --list-models failed: {out.stderr.decode(errors='replace')[-1000:]}")
        text = out.stdout.decode("utf-8", errors="replace")
        return json.loads(text[text.index("["):])

    def check_model(self, model_id: str) -> dict:
        """The app's entry for ``model_id``; an error unless it is installed."""
        models = {m["id"]: m for m in self.list_models()}
        if model_id not in models:
            raise ValueError(f"the app does not know model {model_id!r}; installed: "
                             + ", ".join(sorted(i for i, m in models.items() if m.get("is_downloaded"))))
        if not models[model_id].get("is_downloaded"):
            raise ValueError(f"model {model_id!r} is not downloaded in the app")
        return models[model_id]

    def transcribe(self, wavs: list[Path], model_id: str, progress=None) -> list[AppResult]:
        wavs = [Path(w).resolve() for w in wavs]
        if self.supports_batch:
            return self._batch(wavs, model_id)
        results = []
        for n, wav in enumerate(wavs, 1):
            results.append(self._one(wav, model_id))
            if progress:
                progress(n, len(wavs))
        return results

    def _batch(self, wavs: list[Path], model_id: str) -> list[AppResult]:
        with tempfile.TemporaryDirectory() as td:
            listing = Path(td) / "clips.list"
            listing.write_text("".join(f"{w}\n" for w in wavs), encoding="utf-8")
            out = self._run(["--transcribe-list", str(listing), "--model", model_id, "--json"],
                            timeout=max(self.timeout, 60.0 * len(wavs)))
        rows = {str(Path(r["file"]).resolve()): r for r in _json_lines(out.stdout.decode("utf-8", "replace"))
                if "file" in r}
        if out.returncode not in (0, 1) or (out.returncode != 0 and not rows):
            raise RuntimeError(f"{self.bin} --transcribe-list failed ({out.returncode}): "
                               f"{out.stderr.decode('utf-8', 'replace')[-2000:]}")
        results = []
        for wav in wavs:
            row = rows.get(str(wav))
            if row is None:
                results.append(AppResult(file=str(wav), text="", error="no output for this file"))
            else:
                results.append(AppResult(file=str(wav), text=(row.get("text") or "").strip(), error=row.get("error"),
                                         audio_secs=row.get("audio_secs"), transcribe_ms=row.get("transcribe_ms")))
        return results

    def _one(self, wav: Path, model_id: str) -> AppResult:
        try:
            out = self._run(["-f", str(wav), "--model", model_id, "--json"])
        except subprocess.TimeoutExpired:
            return AppResult(file=str(wav), text="", error="timed out")
        rows = [r for r in _json_lines(out.stdout.decode("utf-8", "replace")) if "text" in r or "error" in r]
        if out.returncode != 0 or not rows:
            tail = out.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["no JSON output"]
            return AppResult(file=str(wav), text="", error=f"exit {out.returncode}: {tail[0][:300]}")
        row = rows[-1]
        ms = row.get("transcribe_ms")
        return AppResult(file=str(wav), text=(row.get("text") or "").strip(), error=row.get("error"),
                         audio_secs=row.get("audio_secs"), transcribe_ms=ms[0] if isinstance(ms, list) and ms else ms)
