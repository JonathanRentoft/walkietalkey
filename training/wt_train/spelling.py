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
    """The conventions of one spelling.yaml.

    Raises ValueError on a contradiction: a form listed twice or under two
    terms, an ``also`` spelling that is also a form or is listed twice, or an
    ``also`` target that is not one of its term's forms. Case does not count:
    "PR" and "pr" are the same spelling.
    """

    def __init__(self, terms: list[Term]):
        self.terms = tuple(terms)
        self._form_of: dict[str, tuple[str, str]] = {}
        self._also: dict[str, str] = {}
        for term in self.terms:
            for form in term.forms:
                key = _squash(form)
                if key in self._form_of:
                    owner = self._form_of[key][0]
                    if owner == term.name:
                        raise ValueError(f"{term.name}: form {form!r} is listed twice")
                    raise ValueError(f"{form!r} is a form of both {owner!r} and {term.name!r}")
                self._form_of[key] = (term.name, form)
        # Only now that every form is known, so the order of the terms does not matter.
        also_of: dict[str, str] = {}
        for term in self.terms:
            for other, form in term.also.items():
                key = _squash(other)
                if form not in term.forms:
                    raise ValueError(
                        f"{term.name}: also {other!r} -> {form!r}, which is not one of its forms"
                    )
                if key in self._form_of:
                    raise ValueError(
                        f"{other!r} is both a form of {self._form_of[key][0]!r} "
                        f"and under also of {term.name!r}"
                    )
                if key in also_of:
                    raise ValueError(
                        f"{other!r} is listed twice under also ({also_of[key]!r} and {term.name!r})"
                    )
                also_of[key] = term.name
                self._also[key] = form
        self._forms_re = _pattern(list(self._form_of_original()))
        self._also_re = _pattern(list(self._also_original())) if self._also else None

    def _form_of_original(self) -> list[str]:
        return [form for term in self.terms for form in term.forms]

    def _also_original(self) -> list[str]:
        return [other for term in self.terms for other in term.also]

    def apply(self, text: str) -> str:
        """``text`` with every ``also`` spelling replaced by its conventional form.

        A capital first letter stays (a sentence start): "Deploy'e" -> "Deploye".
        """
        if self._also_re is None:
            return text

        def replace(m: re.Match[str]) -> str:
            form = self._also[_squash(m.group(0))]
            if m.group(0)[:1].isupper() and form[:1].islower():
                return form[:1].upper() + form[1:]
            return form

        return self._also_re.sub(replace, text)

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


_ENTRY_KEYS = {"forms", "also"}


def load_spelling(path: Path = SPELLING_YAML) -> Spelling:
    """Read spelling.yaml: ``terms: {name: {forms: [...], also: {other: form}}}``.

    Typos fail loudly (an unknown key, ``forms`` that is not a list, ``also``
    that is not a mapping), so a convention is never silently dropped.
    """
    raw = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict) or set(raw) - {"terms"}:
        raise ValueError(f"{path}: unknown key at the top; expected only 'terms'")
    terms = []
    for name, entry in (raw.get("terms") or {}).items():
        if not isinstance(entry, dict):
            raise ValueError(f"{path}: term {name!r} needs a list of forms")
        unknown = set(entry) - _ENTRY_KEYS
        if unknown:
            raise ValueError(f"{path}: term {name!r} has unknown key(s) {sorted(unknown)}")
        forms_raw = entry.get("forms")
        if not isinstance(forms_raw, list) or not forms_raw:
            raise ValueError(f"{path}: term {name!r} needs a list of forms")
        also_raw = entry.get("also") or {}
        if not isinstance(also_raw, dict):
            raise ValueError(f"{path}: term {name!r}: also must map other spellings to forms")
        forms = tuple(str(f) for f in forms_raw)
        also = {str(k): str(v) for k, v in also_raw.items()}
        terms.append(Term(name=str(name), forms=forms, also=also))
    return Spelling(terms)
