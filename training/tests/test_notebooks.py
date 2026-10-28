"""The learning notebooks (run 11): five Jupyter notebooks in training/notebooks/ that the owner
runs top to bottom in VS Code, in the workbench's own environment, to see how Edda hears, how
it is measured and how it is fine-tuned.

The structure checks run everywhere (CI too): the five files exist, are committed without
outputs, carry the kernel and Værkstedet's metadata, keep their words to one-line Danish
headings, and show the code in their cells. Running them needs Edda and FLEURS, so that check
is opt-in: WT_RUN_NOTEBOOKS=1 runs each one with nbclient, keeps the executed copy and its time
in <work>/notebooks/ (git-ignored), and fails one that takes longer than LIMIT_SECONDS."""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

import pytest

from wt_train import paths

NOTEBOOKS = paths.TRAINING / "notebooks"
NAMES = ["01-lyden", "02-edda-indefra", "03-maaling", "04-lora", "05-fejlanalyse"]
# "A few minutes each" on the owner's M1 Pro.
LIMIT_SECONDS = 360
EM_DASH = "—"
# English words that would give an English sentence away in a heading.
ENGLISH = re.compile(r"\b(the|and|with|of|from|this|that|is|are|how|what|into)\b", re.I)


def load(name: str) -> dict:
    return json.loads((NOTEBOOKS / f"{name}.ipynb").read_text(encoding="utf-8"))


def source(cell: dict) -> str:
    src = cell.get("source", "")
    return "".join(src) if isinstance(src, list) else src


@pytest.mark.parametrize("name", NAMES)
def test_the_notebook_is_valid_nbformat_4(name):
    import nbformat

    nb = nbformat.read(str(NOTEBOOKS / f"{name}.ipynb"), as_version=4)
    nbformat.validate(nb)
    assert nb.nbformat == 4


@pytest.mark.parametrize("name", NAMES)
def test_it_is_committed_without_outputs(name):
    for cell in load(name)["cells"]:
        if cell["cell_type"] == "code":
            assert cell.get("outputs") == [], f"{name}: a code cell has saved outputs"
            assert cell.get("execution_count") is None, f"{name}: a code cell has an execution count"


@pytest.mark.parametrize("name", NAMES)
def test_it_runs_on_the_workbench_kernel_and_tells_vaerkstedet_what_it_is(name):
    meta = load(name)["metadata"]
    assert meta["kernelspec"]["name"] == "python3"
    assert meta["kernelspec"]["language"] == "python"
    wt = meta["wt"]
    # Værkstedet's "Lær det" screen lists these.
    assert wt["number"] == int(name[:2])
    summary = wt["summary"]
    assert summary and "\n" not in summary and len(summary) <= 140, name
    assert EM_DASH not in summary and not ENGLISH.search(summary), summary
    assert isinstance(wt["minutes"], int) and 1 <= wt["minutes"] <= 6, name


@pytest.mark.parametrize("name", NAMES)
def test_its_words_are_one_line_danish_headings(name):
    cells = load(name)["cells"]
    markdown = [source(c).strip() for c in cells if c["cell_type"] == "markdown"]
    assert markdown, name
    first = markdown[0]
    # The title: "# 01 · Lyden", and Værkstedet's title is the part after the dot.
    assert re.fullmatch(rf"# {name[:2]} · \S.*", first), first
    for text in markdown:
        assert "\n" not in text, f"{name}: a markdown cell has more than one line: {text!r}"
        assert re.match(r"#{1,3} \S", text), f"{name}: not a heading: {text!r}"
        assert EM_DASH not in text and not ENGLISH.search(text), text
    assert len(markdown) >= 4, f"{name}: a notebook has a few sections"


@pytest.mark.parametrize("name", NAMES)
def test_the_code_is_in_the_cells(name):
    """The important code is shown, not hidden in a helper: no notebook-only module, and from the
    workbench only where the data and the model live, how it reads audio and its scoring."""
    cells = load(name)["cells"]
    code = "\n".join(source(c) for c in cells if c["cell_type"] == "code")
    assert len([c for c in cells if c["cell_type"] == "code"]) >= 5, name
    assert not list(NOTEBOOKS.glob("*.py")), "no helper module next to the notebooks"
    allowed = {"paths", "fleurs", "audio", "harness", "metrics", "config", "spelling", "tracking", "evaluate"}
    used = set(re.findall(r"^\s*(?:from|import)\s+wt_train\.(\w+)", code, re.M))
    for names in re.findall(r"^\s*from\s+wt_train\s+import[ \t]+\(?([ \t\w,]+)", code, re.M):
        used |= {n.split(" as ")[0].strip() for n in names.split(",") if n.strip()}
    assert not re.search(r"^\s*import\s+wt_train\s*$", code, re.M), f"{name}: import the module you use"
    assert used <= allowed, f"{name}: {sorted(used - allowed)}"


def test_the_first_cell_finds_training_from_anywhere():
    """VS Code runs a notebook in its own folder; Værkstedet opens a working copy in
    <work>/notebooks/. The first code cell finds training/ by walking up to its pyproject.toml."""
    for name in NAMES:
        first = next(source(c) for c in load(name)["cells"] if c["cell_type"] == "code")
        assert "pyproject.toml" in first, name


# --- running them (opt-in) -------------------------------------------------------------------


def _ready() -> bool:
    edda = paths.snapshot_dir(paths.EDDA_REPO, paths.EDDA_REVISION) / "model.safetensors"
    return edda.is_file() and (paths.fleurs_dir() / "test.tsv").is_file()


@pytest.mark.skipif(os.environ.get("WT_RUN_NOTEBOOKS") != "1" or not _ready(),
                    reason="opt-in: WT_RUN_NOTEBOOKS=1 with Edda and FLEURS in the work folder")
@pytest.mark.parametrize("name", [n for n in NAMES if n in os.environ.get("WT_NOTEBOOKS", " ".join(NAMES))])
def test_it_runs_top_to_bottom_in_a_few_minutes(name):
    import nbformat
    from nbclient import NotebookClient

    nb = nbformat.read(str(NOTEBOOKS / f"{name}.ipynb"), as_version=4)
    out = paths.work_dir() / "notebooks" / "executed"
    out.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    NotebookClient(nb, timeout=LIMIT_SECONDS, kernel_name="python3",
                   resources={"metadata": {"path": str(NOTEBOOKS)}}).execute()
    seconds = round(time.monotonic() - start, 1)
    nbformat.write(nb, str(out / f"{name}.ipynb"))
    timings = out / "timings.json"
    times = json.loads(timings.read_text()) if timings.is_file() else {}
    times[name] = seconds
    timings.write_text(json.dumps(times, indent=2, sort_keys=True) + "\n")
    errors = [o for c in nb.cells if c.cell_type == "code" for o in c.outputs if o.output_type == "error"]
    assert not errors
    assert seconds <= LIMIT_SECONDS, f"{name} took {seconds} s"
