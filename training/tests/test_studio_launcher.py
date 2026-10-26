"""`wt-train studio --install-app`: the "WalkieTalkey Værksted.app" launcher (training/studio/launcher/).

The bundle is assembled with a fake compiler and a fake codesign, so these run anywhere; one test
builds the real app (when `xcrun swiftc` is there), runs its binary directly with a fake `uv`
that prints the server's ready line, and stops it with SIGTERM, which must reach the fake server.
Nothing here installs into the real ~/Applications or writes the real log folder.
"""

from __future__ import annotations

import json
import os
import plistlib
import shutil
import signal
import stat
import subprocess
import sys
import time
import tomllib
from pathlib import Path

import pytest

from wt_train.studio import launcher

REPO = Path(__file__).resolve().parents[2]
APP = "WalkieTalkey Værksted.app"
EXE = "WalkieTalkey Værksted"


class FakeTools:
    """Stands in for `xcrun swiftc` and `codesign`: records each call; swiftc writes its -o file."""

    def __init__(self, fail_default_sdk: bool = False, fail: bool = False):
        self.calls: list[tuple[list[str], dict]] = []
        self.fail_default_sdk = fail_default_sdk
        self.fail = fail

    def __call__(self, cmd, env=None, **kw):
        self.calls.append((list(cmd), dict(env or {})))
        if cmd[:2] == ["xcrun", "swiftc"]:
            sdk = (env or {}).get("SDKROOT")
            if self.fail or (self.fail_default_sdk and sdk != str(launcher.CLT_SDK)):
                return subprocess.CompletedProcess(cmd, 1, "", "error: this SDK is not supported by the compiler")
            out = Path(cmd[cmd.index("-o") + 1])
            out.write_text("#!/bin/sh\nexit 0\n")
            out.chmod(0o755)
            return subprocess.CompletedProcess(cmd, 0, "", "")
        if cmd[0] == "codesign":
            (Path(cmd[-1]) / "Contents" / "_CodeSignature").mkdir()
            return subprocess.CompletedProcess(cmd, 0, "", "")
        raise AssertionError(f"unexpected command {cmd}")

    def commands(self, name: str) -> list[list[str]]:
        return [c for c, _ in self.calls if name in c[:2]]


@pytest.fixture
def tools(monkeypatch, tmp_path):
    fake = FakeTools()
    monkeypatch.setattr(launcher, "_run", fake)
    monkeypatch.setattr(launcher, "_macos", lambda: True)
    monkeypatch.setattr(launcher, "find_uv", lambda: "/opt/homebrew/bin/uv")
    monkeypatch.setattr(launcher, "find_bun", lambda: "/Users/x/.bun/bin/bun")
    clt = tmp_path / "CLT" / "MacOSX.sdk"
    clt.mkdir(parents=True)
    monkeypatch.setattr(launcher, "CLT_SDK", clt)
    return fake


def test_the_info_plist_names_the_app_and_its_icon():
    p = launcher.info_plist("0.1.0")
    assert p["CFBundleName"] == "WalkieTalkey Værksted"
    assert p["CFBundleDisplayName"] == "WalkieTalkey Værksted"
    assert p["CFBundleExecutable"] == EXE
    assert p["CFBundleIdentifier"] == "com.walkietalkey.workshop"
    assert p["CFBundleIconFile"] == "AppIcon"
    assert p["CFBundlePackageType"] == "APPL"
    assert p["CFBundleShortVersionString"] == "0.1.0"
    assert p["CFBundleVersion"] == "0.1.0"
    assert p["LSMinimumSystemVersion"] == launcher.MIN_MACOS
    assert p["NSHighResolutionCapable"] is True
    assert p["LSApplicationCategoryType"] == "public.app-category.developer-tools"
    # A Dock app: not an agent, and a principal class AppKit knows.
    assert "LSUIElement" not in p
    assert p["NSPrincipalClass"] == "NSApplication"
    plistlib.loads(plistlib.dumps(p))


def test_launch_json_has_absolute_tools_and_the_repository():
    cfg = launcher.launch_config(uv="/opt/homebrew/bin/uv", repo=REPO, bun=None)
    assert cfg == {"uv": "/opt/homebrew/bin/uv", "repo": str(REPO), "bun": None}
    assert launcher.launch_config(uv="/u/uv", repo=REPO, bun="/b/bun")["bun"] == "/b/bun"
    with pytest.raises(ValueError):
        launcher.launch_config(uv="uv", repo=REPO, bun=None)


def test_the_workbench_version_is_the_bundles():
    project = tomllib.loads((REPO / "training" / "pyproject.toml").read_text())["project"]
    assert launcher.workbench_version() == project["version"]


def test_the_bundle_is_assembled_signed_and_nothing_else_is_left(tools, tmp_path, capsys):
    dest = tmp_path / "Apps"
    assert launcher.install(["--dest", str(dest)]) == 0
    app = dest / APP
    assert sorted(p.name for p in dest.iterdir()) == [APP], "the temp folder is gone"
    contents = app / "Contents"
    exe = contents / "MacOS" / EXE
    assert exe.is_file() and os.stat(exe).st_mode & stat.S_IXUSR
    plist = plistlib.loads((contents / "Info.plist").read_bytes())
    assert plist == launcher.info_plist(launcher.workbench_version())
    icon = contents / "Resources" / "AppIcon.icns"
    assert icon.read_bytes() == (REPO / "src-tauri" / "icons" / "icon.icns").read_bytes()
    cfg = json.loads((contents / "Resources" / "launch.json").read_text())
    assert cfg == {"uv": "/opt/homebrew/bin/uv", "repo": str(REPO), "bun": "/Users/x/.bun/bin/bun"}

    [swiftc] = tools.commands("swiftc")
    assert swiftc[:3] == ["xcrun", "swiftc", "-O"]
    assert str(REPO / "training" / "studio" / "launcher" / "Launcher.swift") in swiftc
    [sign] = tools.commands("codesign")
    assert sign[:-1] == ["codesign", "--force", "--sign", "-", "--timestamp=none"]
    # Signed in the temp folder, before it was swapped in.
    assert Path(sign[-1]).name == APP and Path(sign[-1]).parent != dest
    assert (contents / "_CodeSignature").is_dir()
    # The compiler's own temp files and module cache stay in the temp folder too.
    _, env = tools.calls[0]
    work = Path(env["TMPDIR"]).parent
    assert work.parent == dest and work.name.startswith(".")
    cache = swiftc[swiftc.index("-module-cache-path") + 1]
    assert Path(cache).is_relative_to(work)
    assert Path(swiftc[swiftc.index("-o") + 1]).is_relative_to(work)

    out = capsys.readouterr().out.strip().splitlines()
    assert len(out) == 1 and str(app) in out[0] and "Keep in Dock" in out[0]


def test_dest_defaults_to_applications_in_home_and_is_created(tools, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    assert launcher.install([]) == 0
    assert (tmp_path / "home" / "Applications" / APP / "Contents" / "Info.plist").is_file()


def test_the_default_sdk_failing_is_retried_with_the_command_line_tools_sdk(tools, tmp_path):
    tools.fail_default_sdk = True
    assert launcher.install(["--dest", str(tmp_path)]) == 0
    sdks = [env.get("SDKROOT") for c, env in tools.calls if c[:2] == ["xcrun", "swiftc"]]
    assert len(sdks) == 2 and sdks[1] == str(launcher.CLT_SDK)


def test_an_older_copy_is_replaced(tools, tmp_path):
    old = tmp_path / APP / "Contents"
    (old / "MacOS").mkdir(parents=True)
    (old / "MacOS" / "old-binary").write_text("old")
    (old / "Resources").mkdir()
    (old / "Resources" / "launch.json").write_text('{"uv": "/old/uv"}')
    assert launcher.install(["--dest", str(tmp_path)]) == 0
    app = tmp_path / APP
    assert not (app / "Contents" / "MacOS" / "old-binary").exists()
    assert json.loads((app / "Contents" / "Resources" / "launch.json").read_text())["uv"] == "/opt/homebrew/bin/uv"
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted([APP, "CLT"])


def test_a_failed_build_keeps_the_older_copy_and_leaves_nothing_behind(tools, tmp_path, capsys):
    tools.fail = True
    old = tmp_path / "Apps" / APP / "Contents"
    old.mkdir(parents=True)
    (old / "Info.plist").write_text("old")
    assert launcher.install(["--dest", str(tmp_path / "Apps")]) != 0
    assert (old / "Info.plist").read_text() == "old"
    assert sorted(p.name for p in (tmp_path / "Apps").iterdir()) == [APP]
    assert "SDK is not supported" in capsys.readouterr().err


def test_without_uv_nothing_is_built(tools, tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(launcher, "find_uv", lambda: None)
    assert launcher.install(["--dest", str(tmp_path / "Apps")]) != 0
    assert tools.calls == []
    assert not (tmp_path / "Apps").exists()
    assert "uv" in capsys.readouterr().err


def test_uv_and_bun_are_found_where_they_usually_are(tmp_path, monkeypatch):
    home = tmp_path / "home"
    local = home / ".local" / "bin"
    local.mkdir(parents=True)
    (local / "uv").write_text("#!/bin/sh\n")
    (local / "uv").chmod(0o755)
    bun = home / ".bun" / "bin"
    bun.mkdir(parents=True)
    (bun / "bun").write_text("#!/bin/sh\n")
    (bun / "bun").chmod(0o755)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    monkeypatch.delenv("UV", raising=False)
    monkeypatch.setattr(launcher, "_FALLBACK_DIRS", ())
    assert launcher.find_uv() == str(local / "uv")
    assert launcher.find_bun() == str(bun / "bun")
    # Not on PATH: the uv that runs this interpreter (`uv run` sets UV) comes next.
    monkeypatch.setenv("UV", str(bun / "bun"))
    assert launcher.find_uv() == str(bun / "bun")
    on_path = tmp_path / "path"
    on_path.mkdir()
    (on_path / "uv").write_text("#!/bin/sh\n")
    (on_path / "uv").chmod(0o755)
    monkeypatch.setenv("PATH", str(on_path))
    assert launcher.find_uv() == str(on_path / "uv")


# ---- the real app ---------------------------------------------------------------------------


def _swiftc_works() -> bool:
    if sys.platform != "darwin" or not shutil.which("xcrun") or not shutil.which("codesign"):
        return False
    return subprocess.run(["xcrun", "--find", "swiftc"], capture_output=True).returncode == 0


def _wait(cond, what: str, timeout: float = 30.0) -> None:
    end = time.monotonic() + timeout
    while not cond():
        if time.monotonic() > end:
            raise AssertionError(f"timed out waiting for {what}")
        time.sleep(0.05)


@pytest.mark.skipif(not _swiftc_works(), reason="needs macOS with xcrun swiftc and codesign")
def test_the_real_app_starts_the_server_in_its_own_group_and_stops_it_on_sigterm(tmp_path, monkeypatch):
    marker = tmp_path / "marker"
    tools = tmp_path / "tools"
    tools.mkdir()
    fake_uv = tools / "uv"
    fake_uv.write_text(
        "#!/bin/sh\n"
        f"m='{marker}'\n"
        'printf "%s\\n" "$@" > "$m.args"\n'
        'pwd > "$m.cwd"\n'
        'printf "%s\\n" "$PATH" > "$m.path"\n'
        'printf "%s\\n" "${WT_BUN-}" > "$m.bun"\n'
        'ps -o pgid= -p $$ | tr -d " " > "$m.pgid"\n'
        'echo $$ > "$m.pid"\n'
        "trap 'echo TERM > \"$m.term\"; exit 0' TERM\n"
        'echo "starting"\n'
        'echo "Værkstedet: http://127.0.0.1:8799/"\n'
        "while :; do sleep 0.1; done\n"
    )
    fake_uv.chmod(0o755)
    bun_dir = tmp_path / "bun"
    bun_dir.mkdir()
    (bun_dir / "bun").write_text("#!/bin/sh\n")
    (bun_dir / "bun").chmod(0o755)
    monkeypatch.setattr(launcher, "find_uv", lambda: str(fake_uv))
    monkeypatch.setattr(launcher, "find_bun", lambda: str(bun_dir / "bun"))
    dest = tmp_path / "Apps"
    assert launcher.install(["--dest", str(dest)]) == 0
    app = dest / APP
    subprocess.run(["codesign", "--verify", "--strict", str(app)], check=True)

    logs = tmp_path / "logs"
    env = {**os.environ, "WT_STUDIO_NO_BROWSER": "1", "WT_STUDIO_LOG_DIR": str(logs)}
    proc = subprocess.Popen([str(app / "Contents" / "MacOS" / EXE)], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    server_pid = None
    try:
        log = logs / "studio.log"
        _wait(lambda: log.is_file() and "not opening http://127.0.0.1:8799/" in log.read_text(),
              "the ready line, parsed")
        assert "Værkstedet: http://127.0.0.1:8799/" in log.read_text()
        args = marker.with_suffix(".args").read_text().splitlines()
        assert args == ["run", "--project", f"{REPO}/training", "wt-train", "studio",
                        "--parent-pid", str(proc.pid), "--no-browser"]
        assert Path(marker.with_suffix(".cwd").read_text().strip()).resolve() == REPO.resolve()
        assert marker.with_suffix(".path").read_text().strip() == (
            f"{tools}:{bun_dir}:/usr/bin:/bin:/usr/sbin:/sbin")
        assert marker.with_suffix(".bun").read_text().strip() == str(bun_dir / "bun")
        server_pid = int(marker.with_suffix(".pid").read_text())
        # Its own process group, apart from the launcher's.
        assert int(marker.with_suffix(".pgid").read_text()) == server_pid
        assert os.getpgid(server_pid) != os.getpgid(proc.pid)

        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=20) == 0
        assert marker.with_suffix(".term").read_text().strip() == "TERM"
        _wait(lambda: not _alive(server_pid), "the fake server to be gone", timeout=10)
        assert "stopping the server" in log.read_text()
    finally:
        if proc.poll() is None:
            proc.kill()
        if server_pid and _alive(server_pid):
            os.killpg(server_pid, signal.SIGKILL)


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
