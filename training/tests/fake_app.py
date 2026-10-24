"""A stand-in for the walkietalkey binary, written into a test's tmp folder.

``FAKE_APP_BATCH=1`` gives it the ``--transcribe-list`` interface; otherwise it
only has ``-f``. It knows the models listed in ``FAKE_APP_MODELS`` (comma
separated) plus every ``*.gguf`` in ``WT_APP_MODELS_DIR``. A transcript is
the text of the ``<clip>.txt`` next to the clip, upper-cased; a clip whose
name contains "bad", or that is not 16-bit PCM (like the real app), fails.
Every call is logged to ``FAKE_APP_LOG``.
"""

SCRIPT = r'''
import json, os, sys
from pathlib import Path

args = sys.argv[1:]
with open(os.environ["FAKE_APP_LOG"], "a") as log:
    log.write(json.dumps(args) + "\n")
batch = os.environ.get("FAKE_APP_BATCH") == "1"

def unreadable(wav):
    import soundfile
    info = soundfile.info(wav)
    if info.subtype != "PCM_16":
        return f"expected 16 kHz mono 16-bit PCM WAV, got {info.subtype}"
    return None

def text_for(wav):
    txt = Path(wav).with_suffix(".txt")
    return txt.read_text(encoding="utf-8").strip().upper() if txt.is_file() else "hej"

if "--help" in args:
    print("Usage: walkietalkey [OPTIONS]\n  -f, --transcribe-file <WAV>\n  --model <MODEL>\n  --json")
    if batch:
        print("      --transcribe-list <FILE>  Transcribe every WAV listed")
    sys.exit(0)
if "--list-models" in args:
    ids = [m for m in os.environ.get("FAKE_APP_MODELS", "").split(",") if m]
    folder = Path(os.environ.get("WT_APP_MODELS_DIR", "/nonexistent"))
    ids += [p.stem for p in folder.glob("*.gguf")] if folder.is_dir() else []
    print(json.dumps([{"id": i, "name": i, "is_downloaded": True} for i in ids]))
    sys.exit(0)
model = args[args.index("--model") + 1]
if "--transcribe-list" in args and batch:
    listing = Path(args[args.index("--transcribe-list") + 1])
    failed = False
    for line in listing.read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        problem = "cannot open" if "bad" in Path(line).name else unreadable(line)
        if problem:
            print(json.dumps({"error": problem, "file": line}))
            failed = True
        else:
            print(json.dumps({"audio_secs": 0.5, "file": line, "text": text_for(line), "transcribe_ms": 12}))
    sys.exit(1 if failed else 0)
if "-f" in args:
    wav = args[args.index("-f") + 1]
    if "bad" in Path(wav).name or unreadable(wav):
        print("error: cannot open", file=sys.stderr)
        sys.exit(1)
    print(json.dumps({"audio_secs": 0.5, "model": model, "text": text_for(wav), "transcribe_ms": [12]}))
    sys.exit(0)
sys.exit(2)
'''


def install(folder, monkeypatch, *, batch: bool, models=("walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",)):
    import os
    import sys

    path = folder / "walkietalkey"
    path.write_text(f"#!{sys.executable}\n" + SCRIPT, encoding="utf-8")
    os.chmod(path, 0o755)
    log = folder / "calls.log"
    monkeypatch.setenv("FAKE_APP_LOG", str(log))
    monkeypatch.setenv("FAKE_APP_BATCH", "1" if batch else "0")
    monkeypatch.setenv("FAKE_APP_MODELS", ",".join(models))
    return path, log
