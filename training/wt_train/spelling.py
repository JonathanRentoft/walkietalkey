"""Spelling conventions for English developer terms in Danish text.

``training/data/spelling.yaml`` lists each term with the forms Danish grammar
gives it ("deploye", "deployer", "deployede", "deployet") and, under ``also``,
other spellings of those same forms ("deploy'e" -> "deploye"). The owner edits
that file; everything else follows it:

* the dataset builder rewrites every ``also`` spelling in a transcript into the
  conventional form before training (:meth:`Spelling.apply`), so the model
  learns one spelling per form;
* the evaluation finds the terms in a reference (:meth:`Spelling.find_terms`)
  and counts one as right when the hypothesis has the same form.

Matching is case-insensitive and on whole words: a form never matches inside a
longer word, and an apostrophe ending belongs to the word, so "PR" does not
match in "PR'en". Longer forms win over shorter ones that overlap them
("pull requesten" before "pull request").
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .paths import SPELLING_YAML

# A word character, or an apostrophe joining a Danish ending to an English stem.
_WORD = r"[\w'’]"


@dataclass(frozen=True)
class Term:
    """One English term: its conventional forms and other spellings of them."""

    name: str
    forms: tuple[str, ...]
    also: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class TermHit:
    """A conventional form found in a text, at ``text[start:end]``."""

    term: str
    form: str
    start: int
    end: int


def _pattern(spellings: list[str]) -> re.Pattern[str]:
    alternatives = sorted(set(spellings), key=len, reverse=True)
    body = "|".join(re.escape(s).replace(r"\ ", r"\s+") for s in alternatives)
    return re.compile(rf"(?<!{_WORD})(?:{body})(?!{_WORD})", re.IGNORECASE)


class Spelling:
    """The conventions of one spelling.yaml."""

    def __init__(self, terms: list[Term]):
        self.terms = tuple(terms)
        self._form_of: dict[str, tuple[str, str]] = {}
        self._also: dict[str, str] = {}
        for term in self.terms:
            for form in term.forms:
                key = form.casefold()
                if key in self._form_of and self._form_of[key][0] != term.name:
                    raise ValueError(
                        f"{form!r} is a form of both {self._form_of[key][0]!r} and {term.name!r}"
                    )
                self._form_of[key] = (term.name, form)
            for other, form in term.also.items():
                if form not in term.forms:
                    raise ValueError(
                        f"{term.name}: also {other!r} -> {form!r}, which is not one of its forms"
                    )
                if other.casefold() in self._form_of:
                    raise ValueError(f"{term.name}: {other!r} is listed both as a form and under also")
                self._also[other.casefold()] = form
        self._forms_re = _pattern(list(self._form_of_original()))
        self._also_re = _pattern(list(self._also_original())) if self._also else None

    def _form_of_original(self) -> list[str]:
        return [form for term in self.terms for form in term.forms]

    def _also_original(self) -> list[str]:
        return [other for term in self.terms for other in term.also]

    def apply(self, text: str) -> str:
        """``text`` with every ``also`` spelling replaced by its conventional form."""
        if self._also_re is None:
            return text
        return self._also_re.sub(lambda m: self._also[_squash(m.group(0))], text)

    def find_terms(self, text: str) -> list[TermHit]:
        """Every conventional form in ``text``, left to right, longest match first."""
        hits = []
        for m in self._forms_re.finditer(text):
            name, form = self._form_of[_squash(m.group(0))]
            hits.append(TermHit(term=name, form=form, start=m.start(), end=m.end()))
        return hits

    def unconventional(self, text: str) -> list[str]:
        """The ``also`` spellings in ``text`` (a sentence list should have none)."""
        if self._also_re is None:
            return []
        return [m.group(0) for m in self._also_re.finditer(text)]


def _squash(spelling: str) -> str:
    return re.sub(r"\s+", " ", spelling).casefold()


def load_spelling(path: Path = SPELLING_YAML) -> Spelling:
    """Read spelling.yaml: ``terms: {name: {forms: [...], also: {other: form}}}``."""
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    terms = []
    for name, entry in (raw.get("terms") or {}).items():
        if not isinstance(entry, dict) or not entry.get("forms"):
            raise ValueError(f"{path}: term {name!r} needs a list of forms")
        forms = tuple(str(f) for f in entry["forms"])
        also = {str(k): str(v) for k, v in (entry.get("also") or {}).items()}
        terms.append(Term(name=str(name), forms=forms, also=also))
    return Spelling(terms)
