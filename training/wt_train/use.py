"""``wt-train use <version|edda>``: switch the WalkieTalkey app to a model version.

Every export is a version of ``edda-da`` (``wt_train.versions``), installed in
the app's models folder next to the base Edda, which the app always keeps. This
step selects one in the app, the way picking it in Indstillinger › Model does:
``walkietalkey --use-model <id>`` hands the choice to the running app, or, when
none runs, saves it for the next start. Rolling back is switching:
``wt-train use 2`` goes back to version 2, ``wt-train use edda`` to the base.
The registry alias ``app`` then marks the version in use (none for Edda).

``wt-train use --list`` shows Edda and every version: number, id, date,
validation WER, and whether it is installed.
"""

from __future__ import annotations

import argparse
import sys

from . import paths, versions
from .app import App, INSTALLED_APP, candidates


def _app(explicit: str | None) -> App | None:
    """The app that switches: ``--app-bin`` / ``WT_APP_BIN``, else the installed app (the one the
    owner runs, so a running instance gets the choice), else a build in this repository."""
    import os
    from pathlib import Path

    chosen = explicit or os.environ.get("WT_APP_BIN")
    found = [App(Path(chosen))] if chosen else [App(p) for p in [INSTALLED_APP, *candidates()[:2]]]
    found = [a for a in found if a.bin.is_file()]
    return next((a for a in found if a.supports_use), found[0] if found else None)


def show_list() -> int:
    rows = versions.listing()
    print(f"{'':4}  {'version':<8}  {'model id':<52}  {'created':<10}  {'val. WER':>8}  installed")
    for r in rows:
        spec = "edda" if r.get("base") else f"{r.get('version') or ''}"
        wer = f"{r['validation_wer'] * 100:.2f} %" if r.get("validation_wer") is not None else ""
        created = (r.get("created") or "")[:10]
        print(f"{'':4}  {spec:<8}  {r['model_id']:<52}  {created:<10}  {wer:>8}  "
              f"{'yes' if r.get('installed') else 'no'}")
    return 0


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train use", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("version", nargs="?", help="a version number (3 or v3), edda, or an edda-ft- model id")
    p.add_argument("--list", action="store_true", help="list Edda and every version")
    p.add_argument("--app-bin", help="the WalkieTalkey binary (default: the installed app)")
    a = p.parse_args(argv)
    if a.list:
        return show_list()
    if not a.version:
        p.error("name a version, edda, or --list")
    try:
        mid = versions.resolve(a.version)
    except versions.VersionError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    app = _app(a.app_bin)
    if app is None:
        print("error: no WalkieTalkey app found; install it, or pass --app-bin", file=sys.stderr)
        return 1
    if not app.supports_use:
        print(f"error: {app.bin} cannot switch models from the terminal; update WalkieTalkey", file=sys.stderr)
        return 1
    try:
        app.check_model(mid)
    except (ValueError, RuntimeError) as e:
        print(f"error: {mid} is not installed in WalkieTalkey ({e})", file=sys.stderr)
        return 1
    out = app._run(["--use-model", mid], timeout=120)
    if out.returncode != 0:
        tail = out.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or [""]
        print(f"error: {app.bin} exited with {out.returncode}: {tail[0][:300]}", file=sys.stderr)
        return 1
    versions.mark_in_app(mid)
    number = versions.version_of(mid) if mid != paths.SHIPPED_EDDA_ID else None
    label = f"version {number} ({mid})" if number else (versions.BASE_NAME if mid == paths.SHIPPED_EDDA_ID else mid)
    print(f"WalkieTalkey uses {label} now.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
