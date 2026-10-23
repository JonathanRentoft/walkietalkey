"""Run a GGUF model over clips with transcribe.cpp's transcribe-cli in batch
mode (the model is loaded once). Same engine and defaults as the app:
greedy decoding, language forced; timestamps left at the engine default
("auto", like Handy's RunOptions) unless set."""

from __future__ import annotations

import json
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Result:
    file: str
    text: str
    compute_ms: float
    error: str | None = None


@dataclass
class TranscribeCli:
    cli: Path
    backend: str = "auto"
    timestamps: str = "auto"  # "auto" passes no flag, exactly like the app's default
    threads: int | None = None

    def command(self, model: Path, listing: Path, language: str) -> list[str]:
        cmd = [str(self.cli), "-q", "-m", str(model), "-l", language,
               "--backend", self.backend, "--batch", str(listing), "--batch-jsonl"]
        if self.timestamps != "auto":
            cmd += ["--timestamps", self.timestamps]
        if self.threads:
            cmd += ["--threads", str(self.threads)]
        return cmd

    def transcribe(self, model: Path, wavs: list[Path], language: str = "da") -> list[Result]:
        with tempfile.TemporaryDirectory() as td:
            listing = Path(td) / "clips.list"
            listing.write_text("".join(f"{w}\n" for w in wavs), encoding="utf-8")
            proc = subprocess.run(self.command(model, listing, language), capture_output=True)
        # With segment timestamps a Whisper segment boundary can split a
        # multi-byte character, so the engine may print invalid UTF-8; keep the
        # rest and let the replacement character count as an error.
        stdout = proc.stdout.decode("utf-8", errors="replace")
        stderr = proc.stderr.decode("utf-8", errors="replace")
        rows = {}
        for line in stdout.splitlines():
            if not line.startswith("{"):
                continue
            row = json.loads(line)
            if "file" in row:
                rows[row["file"]] = row
        if proc.returncode != 0 and not rows:
            raise RuntimeError(f"transcribe-cli failed ({proc.returncode}): {stderr[-2000:]}")
        results = []
        for w in wavs:
            row = rows.get(str(w))
            if row is None:
                results.append(Result(file=str(w), text="", compute_ms=0.0, error="no output"))
                continue
            compute = sum(float(row.get(k, 0.0)) for k in ("mel_ms", "encode_ms", "decode_ms"))
            results.append(Result(file=str(w), text=(row.get("text") or "").strip(),
                                  compute_ms=compute, error=row.get("error")))
        return results
