"""Værkstedet's journal screen: the lab journal's pages (``wt-train card``, ``journal.py``).

The pages are Markdown files in ``training/journal/`` (``--journal``), one per run, with
the numbers filled in and four headings for the owner (``journal.HEADINGS``). The page
lists them, writes one for a tracked run (``journal.write_card``; never over an existing
page), and edits two of the owner's sections in place: Hypothesis and What I learned.

Saving replaces only what is under those two headings, each up to the next line that
starts with ``## `` (or the end of the file); every other byte of the file stays as it
was, so numbers, plots and anything the owner wrote by hand elsewhere survive. A heading
that is missing is added at the end. Text is saved as UTF-8 with ``\\n`` line ends (a
``\\r\\n`` from the browser becomes ``\\n``). The files next to a page (its plots) are
served from ``/files/journal/<path>``, only from inside the journal folder.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from ..journal import HEADINGS
from .places import StudioPaths
from .recording import StudioError

HYPOTHESIS, LEARNED = HEADINGS[0], HEADINGS[3]
EDITABLE = {"hypothesis": HYPOTHESIS, "learned": LEARNED}
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}")
_HEADING = re.compile(r"^## (.*?)[ \t]*$", re.M)
_NEXT = re.compile(r"^## ", re.M)
_TITLE = re.compile(r"^# (.+?)[ \t]*$", re.M)
_RUN_TITLE = re.compile(r"^(.*) \((\d{4}-\d{2}-\d{2})\)$")


def _bounds(text: str, heading: str) -> tuple[int, int] | None:
    """Where the body under ``## heading`` starts and ends (the next ``## `` line or the end)."""
    for m in _HEADING.finditer(text):
        if m.group(1).strip() != heading:
            continue
        start = m.end()
        if text.startswith("\n", start):
            start += 1
        nxt = _NEXT.search(text, start)
        return start, nxt.start() if nxt else len(text)
    return None


def section(text: str, heading: str) -> str:
    """The text under a heading, without the blank lines around it."""
    where = _bounds(text, heading)
    return text[where[0]:where[1]].strip() if where else ""


def _clean(value) -> str:
    return str(value or "").replace("\r\n", "\n").replace("\r", "\n").strip("\n")


def _body(value: str, last: bool) -> str:
    """A section's body as the card writes it: a blank line, the text, a blank line before
    the next heading."""
    if not value.strip():
        return "\n"
    return "\n" + value + "\n" + ("" if last else "\n")


def replace_sections(text: str, values: dict[str, str]) -> str:
    """``text`` with the bodies under the given headings replaced (see the module docstring)."""
    out = text
    present = [(h, v) for h, v in values.items() if _bounds(out, h) is not None]
    # From the end of the file backwards, so the earlier positions stay where they are.
    for heading, value in sorted(present, key=lambda hv: _bounds(out, hv[0])[0], reverse=True):
        value = _clean(value)
        if section(out, heading) == value.strip():
            continue
        start, end = _bounds(out, heading)
        out = out[:start] + _body(value, end == len(out)) + out[end:]
    for heading, value in values.items():
        if _bounds(out, heading) is not None:
            continue
        if out and not out.endswith("\n"):
            out += "\n"
        out += ("\n" if out else "") + f"## {heading}\n" + _body(_clean(value), True)
    return out


def _title(text: str) -> str:
    m = _TITLE.search(text)
    return m.group(1) if m else ""


class Notebook:
    def __init__(self, places: StudioPaths):
        self.places = places

    @property
    def folder(self) -> Path:
        return Path(self.places.journal)

    def _path(self, name) -> Path:
        name = str(name or "")
        if not NAME.fullmatch(name) or ".." in name:
            raise StudioError(404, "unknown", f"no journal page {name!r}")
        return self.folder / f"{name}.md"

    def pages(self) -> list[dict]:
        out = []
        for path in sorted(self.folder.glob("*.md"), reverse=True) if self.folder.is_dir() else []:
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            title = _title(text)
            m = _RUN_TITLE.match(title)
            date = path.stem[:10] if re.fullmatch(r"\d{4}-\d{2}-\d{2}", path.stem[:10]) else (m.group(2) if m else None)
            out.append({"name": path.stem, "title": title, "date": date, "run": m.group(1) if m else None,
                        "notes": {"hypothesis": bool(section(text, HYPOTHESIS)),
                                  "learned": bool(section(text, LEARNED))}})
        return out

    def runs(self) -> list[dict]:
        """The tracked runs a page can be written for, training runs first, with their page."""
        from .. import tracking
        from ..journal import run_date, slug

        if not tracking.enabled():
            return []
        found = tracking.find_runs()
        found.sort(key=lambda r: r.data.tags.get("wt.kind") != "train")
        out = []
        for r in found:
            name = f"{run_date(r)}-{slug(r.info.run_name)}"
            out.append({"run": r.info.run_name, "id": r.info.run_id, "kind": r.data.tags.get("wt.kind"),
                        "date": run_date(r), "page": name if (self.folder / f"{name}.md").is_file() else None})
        return out

    def listing(self) -> dict:
        return {"pages": self.pages(), "runs": self.runs()}

    def read(self, name) -> dict:
        path = self._path(name)
        if not path.is_file():
            raise StudioError(404, "unknown", f"no journal page {name!r}")
        text = path.read_text(encoding="utf-8")
        return {"name": path.stem, "title": _title(text), "markdown": text, "hypothesis": section(text, HYPOTHESIS),
                "learned": section(text, LEARNED), "files": f"/files/journal/{path.stem}/"}

    def save(self, name, body: dict) -> dict:
        path = self._path(name)
        if not path.is_file():
            raise StudioError(404, "unknown", f"no journal page {name!r}")
        values = {heading: body[key] for key, heading in EDITABLE.items() if key in body}
        if any(not isinstance(v, str) for v in values.values()):
            raise StudioError(400, "text", "hypothesis and learned are text")
        text = path.read_text(encoding="utf-8")
        new = replace_sections(text, values)
        if new != text:
            part = path.with_name(f".{path.name}.part")
            part.write_bytes(new.encode("utf-8"))
            os.replace(part, path)
        return self.read(name)

    def create(self, run) -> dict:
        from .. import tracking
        from ..journal import CardError, write_card

        if not tracking.enabled():
            raise StudioError(409, "tracking-off", "tracking is off (WT_TRACKING=0); there are no runs")
        tracking.import_results()
        try:
            page = write_card(str(run or ""), self.folder)
        except CardError as e:
            if "exists" in str(e):
                raise StudioError(409, "exists", str(e)) from None
            raise StudioError(404, "unknown", str(e)) from None
        return self.read(page.stem)

    def file(self, rel: str) -> Path | None:
        """A file inside the journal folder (``None`` for anything else)."""
        parts = [p for p in rel.split("/") if p]
        if not parts or any(p in (".", "..") or p.startswith(".") for p in parts):
            return None
        root = self.folder.resolve()
        path = (self.folder / Path(*parts)).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            return None
        return path
