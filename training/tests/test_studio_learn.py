"""Værkstedet's "Lær det" screen (run 11): the learning notebooks listed by their contract
(tests/test_notebooks.py), each opened in VS Code as a working copy in the work folder, so the
committed notebooks never get outputs or edits; "Start forfra" puts the original back.

Nothing here launches VS Code or ``open``: the launcher is a hook that records its arguments,
or (for the real launcher) WT_OPEN and WT_CODE name small stand-in scripts."""

import json
import sys
import time
from pathlib import Path

import pytest

from fake_studio import get, post, request, start_server, stop_server, write_places
from wt_train import paths
from wt_train.studio import learn


def notebook(number: int, title: str, summary: str | None = "En linje om det.", minutes: int | None = 4,
             outputs: bool = False, wt: bool = True) -> dict:
    """A notebook as the contract has it: the title heading first, metadata.wt beside the kernel."""
    code = {"cell_type": "code", "metadata": {}, "source": ["print('hej')\n"],
            "outputs": [{"output_type": "stream", "name": "stdout", "text": ["hej\n"]}] if outputs else [],
            "execution_count": 1 if outputs else None}
    meta = {"kernelspec": {"name": "python3", "display_name": "Python 3", "language": "python"}}
    if wt:
        meta["wt"] = {"number": number, "summary": summary, "minutes": minutes}
    return {"nbformat": 4, "nbformat_minor": 5, "metadata": meta,
            "cells": [{"cell_type": "markdown", "metadata": {}, "source": [f"# {number:02d} · {title}"]},
                      code, {"cell_type": "markdown", "metadata": {}, "source": ["## Næste skridt"]}]}


def write_notebooks(folder: Path) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    for name, nb in {
        "02-edda-indefra": notebook(2, "Edda indefra", "Se, hvad Edda gør med lyden, lag for lag.", 5),
        "01-lyden": notebook(1, "Lyden", "Hør og se en optagelse, som Edda får den.", 3),
        "05-fejlanalyse": notebook(5, "Fejlanalyse", None, None, wt=False),
    }.items():
        (folder / f"{name}.ipynb").write_text(json.dumps(nb, ensure_ascii=False, indent=1), encoding="utf-8")
    (folder / "03-broken.ipynb").write_text("{not json", encoding="utf-8")
    (folder / "04-list.ipynb").write_text("[]", encoding="utf-8")
    (folder / ".hidden.ipynb").write_text(json.dumps(notebook(9, "Skjult")), encoding="utf-8")
    (folder / "notes.md").write_text("# not a notebook\n", encoding="utf-8")
    return folder


class Launcher:
    """Records every launch; answers each with the next exit code (0 when none is left)."""

    def __init__(self, *codes: int):
        self.calls: list[list[str]] = []
        self.codes = list(codes)

    def __call__(self, argv):
        self.calls.append(list(argv))
        return self.codes.pop(0) if self.codes else 0


@pytest.fixture
def places(tmp_path, monkeypatch):
    import dataclasses

    p = write_places(tmp_path, monkeypatch)
    return dataclasses.replace(p, notebooks=write_notebooks(tmp_path / "notebooks"))


@pytest.fixture
def launcher():
    return Launcher()


@pytest.fixture
def server(places, launcher):
    srv = start_server(places, launch=launcher)
    yield srv
    stop_server(srv)


def copy_of(places, name: str) -> Path:
    return places.work / "notebooks" / f"{name}.ipynb"


# --- the list ------------------------------------------------------------------------


def test_the_notebooks_are_listed_by_their_contract(server, places):
    status, listing = get(server, "/api/learn")
    assert status == 200
    assert listing["copies"] == str(places.work / "notebooks")
    rows = listing["notebooks"]
    # In number order; a file that does not parse, a dot file and a non-notebook are left out.
    assert [r["name"] for r in rows] == ["01-lyden", "02-edda-indefra", "05-fejlanalyse"]
    assert rows[0] == {"name": "01-lyden", "number": 1, "title": "Lyden",
                       "summary": "Hør og se en optagelse, som Edda får den.", "minutes": 3,
                       "copy": False, "ran": False, "saved": None}
    assert rows[1]["title"] == "Edda indefra" and rows[1]["minutes"] == 5
    # Without metadata.wt: the number from the heading, no summary or minutes.
    assert (rows[2]["number"], rows[2]["title"], rows[2]["summary"], rows[2]["minutes"]) == (
        5, "Fejlanalyse", None, None)


def test_no_notebooks_yet(places, tmp_path):
    import dataclasses

    srv = start_server(dataclasses.replace(places, notebooks=tmp_path / "none"), launch=Launcher())
    try:
        assert get(srv, "/api/learn")[1]["notebooks"] == []
    finally:
        stop_server(srv)


def test_the_default_folders():
    p = learn.StudioPaths()
    assert p.notebooks == paths.TRAINING / "notebooks"
    assert p.workspace == paths.TRAINING
    assert p.notebook_copies == p.work / "notebooks"


# --- opening ---------------------------------------------------------------------------


def test_opening_copies_the_notebook_and_opens_vs_code_on_the_copy(server, places, launcher):
    original = places.notebooks / "01-lyden.ipynb"
    before = original.read_bytes()
    status, answer = post(server, "/api/learn/open", {"name": "01-lyden"})
    assert status == 200, answer
    copy = copy_of(places, "01-lyden")
    assert copy.read_bytes() == before and original.read_bytes() == before
    assert launcher.calls == [["open", "-b", "com.microsoft.VSCode", str(paths.TRAINING), str(copy)]]
    assert answer["created"] is True and answer["with"] == "open"
    assert answer["notebook"]["copy"] is True and answer["notebook"]["ran"] is False
    assert answer["notebook"]["saved"]


def test_opening_again_keeps_the_owners_copy(server, places, launcher):
    post(server, "/api/learn/open", {"name": "01-lyden"})
    copy = copy_of(places, "01-lyden")
    ran = notebook(1, "Lyden", outputs=True)
    ran["cells"].append({"cell_type": "markdown", "metadata": {}, "source": ["## Min egen note"]})
    copy.write_text(json.dumps(ran), encoding="utf-8")
    status, answer = post(server, "/api/learn/open", {"name": "01-lyden"})
    assert status == 200 and answer["created"] is False
    assert json.loads(copy.read_text())["cells"][-1]["source"] == ["## Min egen note"]
    assert len(launcher.calls) == 2 and launcher.calls[1][-1] == str(copy)
    rows = {r["name"]: r for r in get(server, "/api/learn")[1]["notebooks"]}
    assert rows["01-lyden"]["copy"] is True and rows["01-lyden"]["ran"] is True
    assert rows["02-edda-indefra"]["copy"] is False
    # The committed notebook is never touched.
    assert json.loads((places.notebooks / "01-lyden.ipynb").read_text())["cells"][1]["outputs"] == []


def test_start_forfra_puts_the_original_back_and_keeps_the_old_copy(server, places):
    post(server, "/api/learn/open", {"name": "02-edda-indefra"})
    copy = copy_of(places, "02-edda-indefra")
    copy.write_text(json.dumps(notebook(2, "Edda indefra", outputs=True)), encoding="utf-8")
    status, answer = post(server, "/api/learn/reset", {"name": "02-edda-indefra"})
    assert status == 200, answer
    assert copy.read_bytes() == (places.notebooks / "02-edda-indefra.ipynb").read_bytes()
    assert answer["notebook"]["ran"] is False and answer["notebook"]["copy"] is True
    kept = Path(answer["kept"])
    assert kept.parent == places.work / "notebooks" / ".replaced" and kept.name.startswith("02-edda-indefra-")
    assert json.loads(kept.read_text())["cells"][1]["outputs"], "the run copy is kept aside"
    # Without a copy, starting over just makes one.
    status, fresh = post(server, "/api/learn/reset", {"name": "01-lyden"})
    assert status == 200 and fresh["kept"] is None and copy_of(places, "01-lyden").is_file()


def test_unknown_names_and_the_guards(server, places, launcher):
    for bad in ("nope", "../01-lyden", "03-broken", ".hidden", "01-lyden.ipynb", "", None, 3):
        status, body = post(server, "/api/learn/open", {"name": bad})
        assert (status, body["error"]) == (404, "unknown"), bad
    assert post(server, "/api/learn/reset", {"name": "nope"})[1]["error"] == "unknown"
    body = json.dumps({"name": "01-lyden"}).encode()
    assert request(server, "POST", "/api/learn/open", body, {"Content-Type": "application/json"})[0] == 403
    status, _, _ = request(server, "POST", "/api/learn/open", body,
                           {"X-WT-Studio": "1", "Origin": "http://evil.example"})
    assert status == 403
    assert launcher.calls == [] and not (places.work / "notebooks").exists()


def test_the_screen_reloads_as_a_page(server):
    status, _, body = request(server, "GET", "/laer")
    assert status == 200 and b'<div id="root">' in body


# --- the real launcher, with stand-in programs ------------------------------------------


def stand_in(tmp_path: Path, name: str, code: int) -> Path:
    """A program that writes its arguments (one per line) to <name>.args and exits with code."""
    script = tmp_path / name
    script.write_text(f"#!{sys.executable}\nimport sys\n"
                      f"open({str(tmp_path / (name + '.args'))!r}, 'w').write('\\n'.join(sys.argv[1:]))\n"
                      f"sys.exit({code})\n")
    script.chmod(0o755)
    return script


def args_of(tmp_path: Path, name: str) -> list[str]:
    path = tmp_path / f"{name}.args"
    deadline = time.time() + 5
    while not path.exists() and time.time() < deadline:
        time.sleep(0.05)
    return path.read_text().split("\n") if path.exists() else []


def test_vs_code_is_opened_by_its_bundle_id(places, tmp_path, monkeypatch):
    monkeypatch.setenv("WT_OPEN", str(stand_in(tmp_path, "open", 0)))
    monkeypatch.setenv("WT_CODE", str(stand_in(tmp_path, "code", 0)))
    srv = start_server(places, launch=learn.run_command)
    try:
        status, answer = post(srv, "/api/learn/open", {"name": "01-lyden"})
        assert status == 200 and answer["with"] == "open"
        assert args_of(tmp_path, "open") == ["-b", "com.microsoft.VSCode", str(paths.TRAINING),
                                             str(copy_of(places, "01-lyden"))]
        assert not (tmp_path / "code.args").exists()
    finally:
        stop_server(srv)


def test_without_the_bundle_a_code_command_on_the_path_opens_it(places, tmp_path, monkeypatch):
    monkeypatch.setenv("WT_OPEN", str(stand_in(tmp_path, "open", 1)))  # "Unable to find application"
    monkeypatch.setenv("WT_CODE", str(stand_in(tmp_path, "code", 0)))
    srv = start_server(places, launch=learn.run_command)
    try:
        status, answer = post(srv, "/api/learn/open", {"name": "01-lyden"})
        assert status == 200 and answer["with"] == "code"
        assert args_of(tmp_path, "code") == [str(paths.TRAINING), str(copy_of(places, "01-lyden"))]
    finally:
        stop_server(srv)


def test_no_vs_code_at_all_is_a_clear_error_and_the_copy_stays(places, tmp_path, monkeypatch):
    monkeypatch.setenv("WT_OPEN", str(stand_in(tmp_path, "open", 1)))
    monkeypatch.setenv("WT_CODE", "")
    monkeypatch.setenv("PATH", str(tmp_path / "empty-path"))
    srv = start_server(places, launch=learn.run_command)
    try:
        status, answer = post(srv, "/api/learn/open", {"name": "01-lyden"})
        assert (status, answer["error"]) == (409, "no-vscode")
        assert "com.microsoft.VSCode" in answer["message"]
        assert copy_of(places, "01-lyden").is_file()
    finally:
        stop_server(srv)


def test_a_program_that_is_missing_counts_as_not_found(tmp_path):
    assert learn.run_command([str(tmp_path / "no-such-program")]) != 0


def test_the_openers_follow_the_environment(monkeypatch, tmp_path):
    monkeypatch.setenv("WT_OPEN", "/x/open")
    monkeypatch.setenv("WT_CODE", "/x/code")
    assert learn.openers() == [("open", ["/x/open", "-b", "com.microsoft.VSCode"]), ("code", ["/x/code"])]
    monkeypatch.setenv("WT_CODE", "")
    assert learn.openers() == [("open", ["/x/open", "-b", "com.microsoft.VSCode"])]
    monkeypatch.delenv("WT_OPEN")
    monkeypatch.delenv("WT_CODE")
    monkeypatch.setenv("PATH", str(tmp_path))
    assert learn.openers() == [("open", ["open", "-b", "com.microsoft.VSCode"])]


# --- the reading -----------------------------------------------------------------------


def test_a_notebook_is_read_by_its_heading_and_metadata(tmp_path):
    path = tmp_path / "03-maaling.ipynb"
    nb = notebook(3, "Måling", "Sådan tælles ordfejl.", 2)
    nb["cells"][0]["source"] = "# 03 · Måling\n"  # a string, not a list of lines
    path.write_text(json.dumps(nb), encoding="utf-8")
    assert learn.read_notebook(path) == {"number": 3, "title": "Måling", "summary": "Sådan tælles ordfejl.",
                                         "minutes": 2}
    nb["metadata"]["wt"] = {"number": "tre", "summary": 7, "minutes": "to"}
    nb["cells"][0]["source"] = ["# Uden nummer"]
    path.write_text(json.dumps(nb), encoding="utf-8")
    assert learn.read_notebook(path) == {"number": 3, "title": "Uden nummer", "summary": None, "minutes": None}
    nb["cells"] = []
    path.write_text(json.dumps(nb), encoding="utf-8")
    assert learn.read_notebook(path)["title"] == "03-maaling"
    path.write_text('{"cells": 3}', encoding="utf-8")
    assert learn.read_notebook(path) is None


def test_ran_means_a_cell_has_outputs():
    assert learn.has_outputs(notebook(1, "x", outputs=True))
    assert not learn.has_outputs(notebook(1, "x"))
    assert not learn.has_outputs({"cells": "nope"})
