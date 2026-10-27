"""Værkstedet's smaller parts (run 9): a Danish label for every config setting, the page built
when its sources change, and jobs as child processes."""

import dataclasses
import os
import sys
import time

import pytest

from wt_train import config
from wt_train.studio import build, labels
from wt_train.studio.jobs import Jobs

EM_DASH = "—"


# --- labels ------------------------------------------------------------------------------


def test_every_field_of_every_config_dataclass_has_a_label():
    sections = {f.name: f.type for f in dataclasses.fields(config.Config) if f.name not in ("name", "source")}
    assert set(sections) == set(labels.SECTIONS)
    wanted = {"name"}
    for name in sections:
        section = getattr(config.Config(name="x"), name)
        wanted |= {f"{name}.{f.name}" for f in dataclasses.fields(section)}
    assert wanted == set(labels.SETTINGS)
    # Every dataclass in config.py is one of those.
    classes = {v for v in vars(config).values() if dataclasses.is_dataclass(v) and isinstance(v, type)}
    assert classes == {config.Config} | {type(getattr(config.Config(name="x"), n)) for n in sections}


def test_no_label_has_an_em_dash_and_none_is_empty():
    texts = [*labels.SECTIONS.values(), *labels.SETTINGS.values(), *labels.SETUP_DEVICES.values(),
             *labels.STYLES.values(), *labels.LEAKAGE.values(), *labels.JOBS.values()]
    assert all(t.strip() and EM_DASH not in t and "\n" not in t for t in texts)


def test_a_setup_is_named_where_and_how():
    assert labels.setup_label("iphone-whisper", "whisper") == "iPhone, hvisket"
    assert labels.setup_label("airpods-normal", "normal") == "AirPods, almindelig stemme"
    assert labels.setup_label("studio", "normal") == "Studiemikrofon, almindelig stemme"
    assert labels.setup_label("mac-whisper", "whisper") == "Mac'en, hvisket"


def test_the_files_with_new_danish_text_say_so_once():
    from pathlib import Path

    studio = Path(labels.__file__).parent
    for path in studio.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert text.count("TODO(copy)") <= 1, path.name
        assert EM_DASH not in text, path.name
    assert labels.__file__ and Path(labels.__file__).read_text(encoding="utf-8").startswith("# TODO(copy)")


# --- the build ---------------------------------------------------------------------------


@pytest.fixture
def page(tmp_path):
    studio = tmp_path / "studio"
    (studio / "src").mkdir(parents=True)
    (studio / "src" / "main.tsx").write_text("export {}\n")
    (studio / "index.html").write_text("<!doctype html>\n")
    (studio / "package.json").write_text("{}\n")
    (studio / "node_modules" / "x").mkdir(parents=True)
    (studio / "node_modules" / "x" / "y.js").write_text("ignored\n")
    ui = tmp_path / "ui"
    (ui / "src").mkdir(parents=True)
    (ui / "src" / "tokens.css").write_text(":root{}\n")
    return studio, ui


def fake_bun(tmp_path, code=0):
    """A bun that 'builds' by writing dist/index.html, and logs its calls."""
    script = tmp_path / "bun"
    script.write_text(f"""#!{sys.executable}
import sys, pathlib
args = sys.argv[1:]
cwd = pathlib.Path(args[args.index("--cwd") + 1])
(cwd.parent / "calls").open("a").write(" ".join(args) + "\\n")
if {code}:
    print("vite: something broke", file=sys.stderr)
    sys.exit({code})
(cwd / "dist").mkdir(exist_ok=True)
(cwd / "dist" / "index.html").write_text("built")
""")
    script.chmod(0o755)
    return script


def test_the_page_is_built_once_and_again_when_its_sources_change(tmp_path, page, monkeypatch):
    studio, ui = page
    monkeypatch.setenv("WT_BUN", str(fake_bun(tmp_path)))
    dist = studio / "dist"
    assert build.ensure_built(dist, studio=studio, ui=ui, log=lambda m: None).status == "built"
    assert (dist / ".source-hash").read_text().strip() == build.source_hash(studio, ui)
    assert build.ensure_built(dist, studio=studio, ui=ui).status == "fresh"
    (studio / "node_modules" / "x" / "y.js").write_text("still ignored\n")
    assert build.ensure_built(dist, studio=studio, ui=ui).status == "fresh"
    (ui / "src" / "tokens.css").write_text(":root{--x:1}\n")
    assert build.ensure_built(dist, studio=studio, ui=ui, log=lambda m: None).status == "built"
    calls = (tmp_path / "calls").read_text().splitlines()
    assert calls == [f"run --cwd {studio} build"] * 2


def test_a_failed_build_serves_the_old_one_or_cannot_start(tmp_path, page, monkeypatch):
    studio, ui = page
    monkeypatch.setenv("WT_BUN", str(fake_bun(tmp_path, code=1)))
    dist = studio / "dist"
    out = build.ensure_built(dist, studio=studio, ui=ui, log=lambda m: None)
    assert out.status == "failed" and not out.ok and "vite: something broke" in out.message
    dist.mkdir()
    (dist / "index.html").write_text("old")
    out = build.ensure_built(dist, studio=studio, ui=ui, log=lambda m: None)
    assert out.status == "stale" and out.ok and "earlier build" in out.message


def test_without_bun_an_old_build_is_served(tmp_path, page, monkeypatch):
    studio, ui = page
    monkeypatch.delenv("WT_BUN", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    out = build.ensure_built(studio / "dist", studio=studio, ui=ui)
    assert out.status == "failed" and "bun is not installed" in out.message


def test_the_server_will_not_start_without_a_page(tmp_path, page, monkeypatch, capsys):
    from fake_studio import write_places
    from wt_train.studio import server

    places = write_places(tmp_path, monkeypatch)
    monkeypatch.setenv("WT_BUN", str(fake_bun(tmp_path, code=1)))
    monkeypatch.setattr(server, "running", lambda own: None)
    (places.dist / "index.html").unlink()
    code = server.main(["--no-browser", "--dist", str(places.dist), "--recordings", str(places.recordings)])
    assert code == 1 and "no earlier build" in capsys.readouterr().err


# --- jobs --------------------------------------------------------------------------------


def py(code: str) -> list[str]:
    return [sys.executable, "-c", code]


def test_a_job_keeps_its_last_lines_and_its_result(tmp_path):
    jobs = Jobs(cwd=tmp_path)
    job = jobs.start("report", "Rapport: x", py("for i in range(500): print(i)"), on_exit=lambda j: {"lines": 500})
    assert job.done.wait(20)
    d = job.as_dict()
    assert d["status"] == "done" and d["exit"] == 0 and d["ended"] and d["result"] == {"lines": 500}
    assert len(d["log"]) == 400 and d["log"][-1] == "499" and d["log"][0] == "100"
    assert d["id"] == "j1" and d["kind"] == "report" and d["title"] == "Rapport: x"


def test_a_job_that_fails(tmp_path):
    jobs = Jobs(cwd=tmp_path)
    job = jobs.start("export", "Eksport", py("import sys; print('boom', file=sys.stderr); sys.exit(3)"))
    assert job.done.wait(20)
    assert (job.status, job.exit, list(job.log)) == ("failed", 3, ["boom"])
    missing = jobs.start("export", "Eksport", ["/nonexistent/binary"])
    assert missing.status == "failed" and "could not start" in missing.log[0]


def test_stopping_sends_sigint_then_sigterm(tmp_path):
    jobs = Jobs(cwd=tmp_path)
    polite = jobs.start("train", "Træning", py(
        "import time\ntry:\n    time.sleep(30)\nexcept KeyboardInterrupt:\n    print('stopped cleanly')\n"))
    stubborn = jobs.start("train", "Træning", py(
        "import signal, time\nsignal.signal(signal.SIGINT, signal.SIG_IGN)\nprint('ready', flush=True)\n"
        "time.sleep(30)"))
    time.sleep(0.5)
    assert {j.id for j in jobs.running("train")} == {polite.id, stubborn.id}
    jobs.stop(polite.id)
    jobs.stop(stubborn.id, grace=0.5)
    assert polite.done.wait(10) and stubborn.done.wait(10)
    assert polite.status == "stopped" and "stopped cleanly" in polite.log
    assert stubborn.status == "stopped" and stubborn.exit == -15
    assert jobs.running() == []


def test_a_companion_ends_with_its_job_and_every_job_ends_with_the_server(tmp_path):
    jobs = Jobs(cwd=tmp_path)
    job = jobs.start("train", "Træning", py("import time; time.sleep(30)"))
    companion = jobs.attach(job, py("import time; time.sleep(60)"))
    assert companion.poll() is None
    jobs.stop_all()
    assert job.status == "stopped"
    assert companion.wait(5) is not None


def test_children_get_the_work_folder(tmp_path):
    jobs = Jobs(cwd=tmp_path, env={"WT_WORK_DIR": str(tmp_path / "w")})
    job = jobs.start("report", "x", py("import os; print(os.environ['WT_WORK_DIR'], os.getcwd())"))
    assert job.done.wait(20)
    assert job.log[0] == f"{tmp_path / 'w'} {os.path.realpath(tmp_path)}"


# --- the review's findings: process groups and the shutdown budget (run 9) ------------------


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


SPAWNER = ("import subprocess, sys, time\n"
           "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
           "print(child.pid, flush=True)\n"
           "time.sleep(60)\n")


def test_stopping_a_job_reaches_every_process_it_started(tmp_path):
    # The app's --transcribe-list under a pilot report, or the export's tools: they run in the
    # job's process group and must not survive it.
    jobs = Jobs(cwd=tmp_path)
    job = jobs.start("pilot", "Pilotens sammenligning", py(SPAWNER))
    deadline = time.time() + 10
    while not job.log and time.time() < deadline:
        time.sleep(0.05)
    grandchild = int(job.log[0])
    jobs.stop(job.id, grace=1.0, kill_grace=1.0)
    assert job.done.wait(10), "the job ends once its whole group is gone"
    assert job.status == "stopped"
    deadline = time.time() + 5
    while _alive(grandchild) and time.time() < deadline:
        time.sleep(0.05)
    assert not _alive(grandchild)


STUBBORN = ("import signal, time\n"
            "signal.signal(signal.SIGINT, signal.SIG_IGN)\n"
            "signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
            "print('ready', flush=True)\n"
            "time.sleep(60)\n")


def test_the_server_stops_every_job_within_the_launchers_wait(tmp_path, monkeypatch):
    from wt_train.studio import jobs as jobs_module
    from wt_train.studio import recording, server

    # SIGINT, 5 s, SIGTERM, 3 s, SIGKILL: with the session's end (at most 3 s, at the same time)
    # and the checks, about 10 s, well inside the launcher's 20 s before its SIGKILL.
    assert (jobs_module.SHUTDOWN_GRACE_S, jobs_module.SHUTDOWN_KILL_GRACE_S) == (5.0, 3.0)
    budget = max(recording.END_WAIT_S, jobs_module.SHUTDOWN_GRACE_S + jobs_module.SHUTDOWN_KILL_GRACE_S + 1)
    assert budget + server.REVIEW_STOP_S <= 12 < server.LAUNCHER_KILL_AFTER_S == 20
    monkeypatch.setattr(jobs_module, "SHUTDOWN_GRACE_S", 0.3)
    monkeypatch.setattr(jobs_module, "SHUTDOWN_KILL_GRACE_S", 0.3)
    jobs = Jobs(cwd=tmp_path)
    job = jobs.start("train", "Træning", py(STUBBORN))
    deadline = time.time() + 10
    while not job.log and time.time() < deadline:
        time.sleep(0.05)
    started = time.time()
    jobs.stop_all()
    assert time.time() - started < 3 and job.status == "stopped" and job.exit == -9


def test_the_launcher_waits_20_seconds_before_sigkill():
    from pathlib import Path

    launcher = Path(labels.__file__).parents[2] / "studio" / "launcher"
    swift = (launcher / "Launcher.swift").read_text(encoding="utf-8")
    assert "addingTimeInterval(20)" in swift and "within 20 s" in swift and "addingTimeInterval(8)" not in swift
    readme = (launcher / "README.md").read_text(encoding="utf-8")
    assert "wait up to 20 s" in readme and "8 s" not in readme
