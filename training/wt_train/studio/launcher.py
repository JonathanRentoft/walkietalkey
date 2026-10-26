"""``wt-train studio --install-app``: builds "WalkieTalkey Værksted.app", Værkstedet in the Dock.

The app is training/studio/launcher/Launcher.swift, a minimal AppKit launcher compiled with
``xcrun swiftc -O`` (no Xcode project), in a bundle with the W icon (src-tauri/icons/icon.icns)
and ``Contents/Resources/launch.json``: the absolute paths of ``uv``, this repository and
``bun`` (or null). It starts ``wt-train studio`` from this checkout, so the app keeps working
when the code changes; it has to be built again only when uv or the checkout moves.

Everything is written into a temporary folder inside ``--dest`` first (the compiler's own temp
files and module cache too), signed ad hoc, and then swapped in atomically, replacing an older
copy. Nothing is written outside ``--dest`` and that folder.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import plistlib
import platform
import shutil
import subprocess
import sys
import tempfile
from importlib import metadata
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SOURCE = REPO / "training" / "studio" / "launcher" / "Launcher.swift"
ICON = REPO / "src-tauri" / "icons" / "icon.icns"

NAME = "WalkieTalkey Værksted"
APP = f"{NAME}.app"
BUNDLE_ID = "com.walkietalkey.workshop"
MIN_MACOS = "13.0"
# When the default SDK does not match the compiler (a beta SDK, say), AGENTS.md's fallback.
CLT_SDK = Path("/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk")
# Where uv and bun usually are when they are not on PATH (Homebrew, then the classic prefix).
_FALLBACK_DIRS: tuple[str, ...] = ("/opt/homebrew/bin", "/usr/local/bin")


def _run(cmd: list[str], env: dict[str, str] | None = None, **kw) -> subprocess.CompletedProcess:
    """Runs a build tool (the tests swap this for fakes)."""
    return subprocess.run(cmd, env=env, capture_output=True, text=True, **kw)


def _executable(p: str | Path | None) -> str | None:
    if p and os.path.isfile(p) and os.access(p, os.X_OK):
        return str(Path(p).absolute())
    return None


def _find(name: str, home_dirs: list[str], env_var: str | None = None) -> str | None:
    """The tool by its absolute path, symlinks kept (Homebrew's stays valid across upgrades)."""
    candidates: list[str | None] = [shutil.which(name)]
    if env_var:
        candidates.append(os.environ.get(env_var))
    home = Path.home()
    candidates += [str(home / d / name) for d in home_dirs]
    candidates += [str(Path(d) / name) for d in _FALLBACK_DIRS]
    for c in candidates:
        if found := _executable(c):
            return found
    return None


def find_uv() -> str | None:
    """uv on PATH, else the uv running this workbench (`uv run` sets UV), ~/.local/bin, Homebrew."""
    return _find("uv", [".local/bin", ".cargo/bin"], env_var="UV")


def find_bun() -> str | None:
    """bun, for building the page (WT_BUN): on PATH, ~/.bun/bin, Homebrew."""
    return _find("bun", [".bun/bin"], env_var="WT_BUN")


def workbench_version() -> str:
    try:
        return metadata.version("wt-train")
    except metadata.PackageNotFoundError:
        import tomllib

        return tomllib.loads((REPO / "training" / "pyproject.toml").read_text())["project"]["version"]


def info_plist(version: str) -> dict:
    return {
        "CFBundleDevelopmentRegion": "da",
        "CFBundleDisplayName": NAME,
        "CFBundleExecutable": NAME,
        "CFBundleIconFile": "AppIcon",
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": NAME,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": version,
        "CFBundleVersion": version,
        "LSApplicationCategoryType": "public.app-category.developer-tools",
        "LSMinimumSystemVersion": MIN_MACOS,
        "NSHighResolutionCapable": True,
        "NSPrincipalClass": "NSApplication",
    }


def launch_config(uv: str, repo: Path, bun: str | None) -> dict:
    """Contents/Resources/launch.json."""
    for p in (uv, bun):
        if p is not None and not os.path.isabs(p):
            raise ValueError(f"not an absolute path: {p}")
    return {"uv": uv, "repo": str(repo), "bun": bun}


def _compile(out: Path, work: Path) -> subprocess.CompletedProcess:
    arch = "arm64" if platform.machine() == "arm64" else "x86_64"
    cmd = ["xcrun", "swiftc", "-O", "-target", f"{arch}-apple-macos{MIN_MACOS}",
           "-module-cache-path", str(work / "module-cache"), "-o", str(out), str(SOURCE)]
    env = dict(os.environ)
    # The compiler's own temp files go into the work folder too; swiftc 6.3 crashes (SIGTRAP)
    # on a TMPDIR that is not ASCII, so an unusual --dest keeps the system's.
    tmp = work / "tmp"
    if str(tmp).isascii():
        tmp.mkdir(exist_ok=True)
        env["TMPDIR"] = f"{tmp}/"
    done = _run(cmd, env=env)
    if done.returncode != 0 and CLT_SDK.is_dir() and env.get("SDKROOT") != str(CLT_SDK):
        # The default SDK may be newer than the compiler (a beta): the Command Line Tools' SDK.
        done = _run(cmd, env={**env, "SDKROOT": str(CLT_SDK)})
    return done


def _assemble(work: Path, uv: str, bun: str | None) -> Path:
    app = work / APP
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources").mkdir()
    built = _compile(contents / "MacOS" / NAME, work)
    if built.returncode != 0:
        raise RuntimeError(f"swiftc failed:\n{(built.stderr or built.stdout).strip()}")
    (contents / "Info.plist").write_bytes(plistlib.dumps(info_plist(workbench_version())))
    shutil.copyfile(ICON, contents / "Resources" / "AppIcon.icns")
    (contents / "Resources" / "launch.json").write_text(
        json.dumps(launch_config(uv, REPO, bun), indent=2) + "\n", encoding="utf-8")
    signed = _run(["codesign", "--force", "--sign", "-", "--timestamp=none", str(app)])
    if signed.returncode != 0:
        raise RuntimeError(f"codesign failed:\n{(signed.stderr or signed.stdout).strip()}")
    return app


_RENAME_SWAP = 0x2


def _swap(new: Path, target: Path) -> None:
    """Puts `new` at `target` in one step; an older `target` ends up at `new` (then removed)."""
    if not target.exists():
        os.rename(new, target)
        return
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renamex_np(os.fsencode(new), os.fsencode(target), _RENAME_SWAP) == 0:
            return
    except (AttributeError, OSError):
        pass
    old = new.with_name(new.name + ".old")
    os.rename(target, old)
    os.rename(new, target)


def _macos() -> bool:
    return sys.platform == "darwin"


def install(argv: list[str]) -> int:
    p = argparse.ArgumentParser(
        prog="wt-train studio --install-app",
        description=f"Build {APP} (Værkstedet in the Dock) from this checkout.")
    p.add_argument("--dest", type=Path, default=None,
                   help="folder to put the app in (default ~/Applications, created if missing)")
    a = p.parse_args(argv)
    if not _macos():
        print("The launcher app is for macOS only.", file=sys.stderr)
        return 2
    uv = find_uv()
    if uv is None:
        print("uv was not found (looked at $UV, PATH, ~/.local/bin and /opt/homebrew/bin).", file=sys.stderr)
        return 1
    bun = find_bun()
    dest = (a.dest or Path.home() / "Applications").expanduser().absolute()
    dest.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=".walkietalkey-workshop-", dir=dest))
    try:
        app = _assemble(work, uv, bun)
        target = dest / APP
        _swap(app, target)
    except (RuntimeError, OSError) as e:
        print(f"Could not build {APP}: {e}", file=sys.stderr)
        return 1
    finally:
        shutil.rmtree(work, ignore_errors=True)
    print(f"Installed {target}; open it once, then right-click its Dock icon and choose "
          "Options > Keep in Dock.")
    return 0
