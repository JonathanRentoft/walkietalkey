"""``wt-train smoke``: the whole chain on 20 FLEURS clips, then every trace removed.

Twenty FLEURS da_dk **train** clips (distinct sentences) stand in for the
owner's takes, so the test split stays clean, and ``configs/smoke.yaml`` runs
the chain once, one epoch:

    fetch       FLEURS da_dk train and test, when missing (kept: real runs need them)
    stand-ins   the 20 clips as <id>.wav + <id>.txt, a sentences.csv and a spelling.yaml
    build       splits, rehearsal and the leakage check
    train       encoder cache, one epoch of LoRA, validation WER
    eval        the merged adapter (lora backend) on its test split and 5 FLEURS test clips
    export      merge, GGUF, Q8_0, same-text check, install as edda-ft-smoke
    app         the app lists edda-ft-smoke and transcribes 2 FLEURS test clips with it
    cleanup     deletes the run, the cache entries it created, the eval rows, the
                export folder, the installed model and card, and the stand-ins

The scores go to a temporary results file (deleted with the rest);
training/results.csv is checked to be unchanged. ``--keep`` skips the cleanup
for debugging. Each step is timed and the times are printed as a table.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import shutil
import sys
import time
from pathlib import Path

from . import paths

STAND_INS = 20
SMOKE_SLUG = "smoke"
FLEURS_EVAL_CLIPS = 5
APP_CLIPS = 2


class Cleanup:
    """Everything the smoke test created, deleted at the end."""

    def __init__(self):
        self.items: list[Path] = []

    def add(self, *items: Path) -> None:
        self.items += [Path(i) for i in items]

    def run(self) -> tuple[int, int]:
        """(entries deleted, bytes freed)."""
        deleted = freed = 0
        for item in reversed(self.items):
            if item.is_dir():
                freed += sum(p.stat().st_size for p in item.rglob("*") if p.is_file())
                shutil.rmtree(item)
                deleted += 1
            elif item.exists():
                freed += item.stat().st_size
                item.unlink()
                deleted += 1
                parent = item.parent
                if parent.name and len(parent.name) == 2 and not any(parent.iterdir()):
                    parent.rmdir()  # an emptied encoder-cache shard folder
        return deleted, freed


def make_stand_ins(dest: Path, n: int, seed: int, fleurs_root: Path | None = None) -> tuple[Path, Path, Path]:
    """n FLEURS train clips of distinct sentences as takes; returns (takes, sentences.csv, spelling.yaml)."""
    from . import fleurs
    from .dataset import sentence_key

    clips = fleurs.load_split("train", fleurs_root)
    groups: dict[str, list] = {}
    for c in clips:
        groups.setdefault(sentence_key(c.text), []).append(c)
    keys = sorted(groups)
    chosen = random.Random(f"smoke:{seed}").sample(keys, n)
    takes = dest / "recordings"
    takes.mkdir(parents=True)
    rows = ["id,text,kind"]
    for i, key in enumerate(sorted(chosen)):
        clip = sorted(groups[key], key=lambda c: c.id)[0]
        sid = f"smoke{i:03d}"
        shutil.copyfile(clip.wav, takes / f"{sid}.wav")
        (takes / f"{sid}.txt").write_text(clip.text + "\n", encoding="utf-8")
        rows.append(f'{sid},"{clip.text.replace(chr(34), chr(39))}",plain')
    sentences = dest / "sentences.csv"
    sentences.write_text("\n".join(rows) + "\n", encoding="utf-8")
    spelling = dest / "spelling.yaml"
    if paths.SPELLING_YAML.is_file():
        shutil.copyfile(paths.SPELLING_YAML, spelling)
    else:
        spelling.write_text("terms:\n  deploy:\n    forms: [deploy, deploye, deployer, deployede, deployet]\n",
                            encoding="utf-8")
    return takes, sentences, spelling


def _sha(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def format_timings(timings: list[tuple[str, float, str]]) -> str:
    width = max(len(s) for s, _, _ in timings)
    lines = [f"{'step':<{width}}  {'seconds':>8}  result", f"{'-' * width}  {'-' * 8}  ------"]
    lines += [f"{s:<{width}}  {t:>8.1f}  {r}" for s, t, r in timings]
    lines.append(f"{'total':<{width}}  {sum(t for _, t, _ in timings):>8.1f}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train smoke", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--app-bin", type=Path, help="WalkieTalkey binary for the app step")
    p.add_argument("--device", choices=["auto", "mps", "cpu"], help="instead of smoke.yaml's training.device")
    p.add_argument("--keep", action="store_true", help="leave the artifacts in place (debugging)")
    a = p.parse_args(argv)

    from . import dataset, evaluate, export, fleurs, train
    from .app import find_app
    from .config import load_config, with_overrides
    from .export import install_paths, model_id

    root = paths.work_dir() / "smoke"
    if root.exists():
        shutil.rmtree(root)  # left over from an interrupted smoke test
    root.mkdir(parents=True)
    results = root / "results.csv"
    results_before = _sha(paths.RESULTS_CSV)
    cleanup = Cleanup()
    cleanup.add(root)
    timings: list[tuple[str, float, str]] = []

    def timed(step: str, fn, describe=lambda r: ""):
        print(f"\n== {step}", flush=True)
        started = time.time()
        out = fn()
        timings.append((step, round(time.time() - started, 1), describe(out)))
        return out

    # New runs, cache entries and eval folders are found by comparing listings, so
    # even a step that fails half-way leaves nothing behind.
    def listing(folder: Path, pattern: str) -> set[Path]:
        return set(folder.glob(pattern)) if folder.is_dir() else set()

    watched = [(paths.runs_dir(), "*"), (paths.encoder_cache_dir(), "*/*.npy"), (paths.eval_runs_dir(), "*")]
    before = [listing(folder, pattern) for folder, pattern in watched]
    mid = model_id(SMOKE_SLUG)
    gguf_target, card_target = install_paths(mid, paths.app_models_dir())
    ok = False
    try:
        timed("fetch", lambda: [fleurs.ensure(s) for s in fleurs.SPLITS], lambda _: "FLEURS da_dk train + test")
        cfg = load_config(paths.CONFIGS / "smoke.yaml")
        takes, sentences, spelling = timed(
            "stand-ins", lambda: make_stand_ins(root, STAND_INS, cfg.data.seed),
            lambda r: f"{STAND_INS} FLEURS train clips")
        cfg = with_overrides(cfg, data={"recordings": str(takes), "sentences": str(sentences),
                                        "spelling": str(spelling)})
        if a.device:
            cfg = with_overrides(cfg, training={"device": a.device})
        b = timed("build", lambda: dataset.build(cfg, out_dir=root / "build"),
                  lambda b: ", ".join(f"{s} {b.summary['splits'][s]['clips']}" for s in dataset.SPLITS))
        print(dataset.format_summary(b))

        def describe_run(r: Path) -> str:
            best = json.loads((r / "best.json").read_text())
            return f"best epoch {best['epoch']}, validation WER {best['validation_wer'] * 100:.2f} %"

        run_dir = timed("train", lambda: train.run(cfg, build=b), describe_run)

        def eval_lora():
            code = evaluate.main(["--backend", "lora", "--run", str(run_dir), "--dataset", "test",
                                  "--fleurs-limit", str(FLEURS_EVAL_CLIPS), "--results", str(results),
                                  "--notes", "smoke"])
            if code != 0:
                raise RuntimeError("lora evaluation reported failed clips")

        timed("eval (lora)", eval_lora, lambda _: f"test split + {FLEURS_EVAL_CLIPS} FLEURS test clips")
        cleanup.add(paths.exports_dir() / mid, gguf_target, card_target)
        exported = timed("export", lambda: export.export_run(run_dir, force=True),
                         lambda r: f"{r['model_id']}, same text {r['verify']['exact_matches']}/{r['verify']['n']}")

        def in_app():
            app = find_app(a.app_bin)
            entry = app.check_model(mid)
            if entry.get("name") != exported["name"]:
                raise RuntimeError(f"the app shows {mid} as {entry.get('name')!r}, expected {exported['name']!r}")
            code = evaluate.main(["--backend", "gguf", "--model", mid, "--app-bin", str(app.bin),
                                  "--dataset", "fleurs-test", "--limit", str(APP_CLIPS), "--results", str(results),
                                  "--notes", "smoke"])
            if code != 0:
                raise RuntimeError(f"the app failed to transcribe with {mid}")
            return app

        timed("app", in_app, lambda app: f"{mid} listed and transcribing ({app.bin})")
        ok = True
    finally:
        for (folder, pattern), seen in zip(watched, before):
            cleanup.add(*sorted(listing(folder, pattern) - seen))
        if a.keep:
            print(f"\n--keep: smoke artifacts left in place ({len(cleanup.items)} entries)")
        else:
            started = time.time()
            deleted, freed = cleanup.run()
            timings.append(("cleanup", round(time.time() - started, 1),
                            f"{deleted} entries, {freed / 1e9:.2f} GB freed"))
        if _sha(paths.RESULTS_CSV) != results_before:
            print("error: training/results.csv changed during the smoke test", file=sys.stderr)
            ok = False
        print("\n" + format_timings(timings))
    print("smoke test passed" if ok else "smoke test FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
