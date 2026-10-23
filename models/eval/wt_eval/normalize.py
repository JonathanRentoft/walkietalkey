"""The WER normaliser. Applied identically to reference and hypothesis.

Steps, in order:
1. Unicode NFKC (folds full-width digits, ligatures and similar), then lower case.
2. Numbers as spoken Danish (wt_eval.danish_numbers):
   - "800.000" (dot-grouped thousands) -> 800000 -> "otte hundrede tusind"
   - "3,5" / "2.5" (decimal) -> "tre komma fem" (the fraction is read as a whole
     number, each leading zero as "nul": "0,05" -> "nul komma nul fem")
   - a lone 4-digit 1100-1999 is read as a year: "1976" -> "nitten hundrede og
     seksoghalvfjerds"; every other integer as a cardinal: "2024" -> "to tusind
     og fireogtyve"
   - "%" -> "procent", "&" -> "og"
   Numbers are cut free of attached letters, so "4g" -> "fire g".
3. Punctuation stripped: every character that is not a letter, digit or
   whitespace (and "_") becomes a space, so hyphenated compounds split the
   same way on both sides ("Riga-fredstraktaten" -> "riga fredstraktaten").
4. Spelling variants of number words folded: "tusinde" -> "tusind",
   "én"/"ét" -> "en"/"et", and "et" before "hundrede"/"tusind" dropped.
5. Whitespace collapsed.

Known limits (accepted, documented in docs/MODELS.md): ordinals ("5. maj"
becomes "fem maj", not "femte maj"), clock times ("10.30" reads as a decimal),
and abbreviations ("f.eks." vs "for eksempel") are not folded.
"""

from __future__ import annotations

import re
import unicodedata

from .danish_numbers import cardinal, year

_NUMBER = re.compile(r"\d{1,3}(?:\.\d{3})+(?!\d)|\d+[,.]\d+|\d+")
_NON_WORD = re.compile(r"[^\w\s]|_")
_FOLD = {"tusinde": "tusind", "én": "en", "ét": "et"}


def _spoken(match: re.Match[str]) -> str:
    token = match.group(0)
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", token):
        return f" {cardinal(int(token.replace('.', '')))} "
    if "," in token or "." in token:
        whole, frac = re.split(r"[,.]", token, maxsplit=1)
        zeros = len(frac) - len(frac.lstrip("0"))
        frac_words = ["nul"] * zeros + ([cardinal(int(frac))] if frac.lstrip("0") else [])
        return f" {cardinal(int(whole))} komma {' '.join(frac_words)} "
    n = int(token)
    if len(token) == 4:
        return f" {year(n)} "
    return f" {cardinal(n)} "


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    text = _NUMBER.sub(_spoken, text)
    text = text.replace("%", " procent ").replace("&", " og ")
    text = _NON_WORD.sub(" ", text)
    words = [_FOLD.get(w, w) for w in text.split()]
    out: list[str] = []
    for i, w in enumerate(words):
        if w == "et" and i + 1 < len(words) and words[i + 1] in ("hundrede", "tusind"):
            continue
        out.append(w)
    return " ".join(out)
