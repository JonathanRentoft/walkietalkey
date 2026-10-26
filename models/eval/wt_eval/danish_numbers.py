"""Integers as spoken Danish words, for the WER normaliser.

Conventions (one fixed choice per number, applied to reference and hypothesis
alike, so only the digit-versus-word difference is neutralised):
- 21..99 are one word with the ones first: "enogtyve", "nioghalvfems".
- 100 is "hundrede" and 1000 is "tusind" (no leading "et"); larger multiples
  are counted: "to hundrede", "firs tusind".
- "og" joins the last group when it is below 100: "hundrede og en",
  "tusind og fem", "tre hundrede og femogfyrre".
- million/milliard take "en" and a plural: "en million", "to millioner".
- year(): 1100-1999 read in hundreds ("nitten hundrede og seksoghalvfjerds");
  any other value falls back to cardinal().
- ordinal() (run 8): "femte", "enogtyvende", "halvtredsindstyvende"; from 100
  the hundreds stay cardinal and the rest is the ordinal ("hundrede og
  første"); a whole hundred reads as the cardinal ("tre hundrede").
"""

from __future__ import annotations

_ONES = ["nul", "en", "to", "tre", "fire", "fem", "seks", "syv", "otte", "ni",
         "ti", "elleve", "tolv", "tretten", "fjorten", "femten", "seksten",
         "sytten", "atten", "nitten"]
_TENS = {2: "tyve", 3: "tredive", 4: "fyrre", 5: "halvtreds", 6: "tres",
         7: "halvfjerds", 8: "firs", 9: "halvfems"}
_ORDINAL_ONES = ["nulte", "første", "anden", "tredje", "fjerde", "femte", "sjette", "syvende",
                 "ottende", "niende", "tiende", "ellevte", "tolvte", "trettende", "fjortende",
                 "femtende", "sekstende", "syttende", "attende", "nittende"]
_ORDINAL_TENS = {2: "tyvende", 3: "tredivte", 4: "fyrretyvende", 5: "halvtredsindstyvende",
                 6: "tresindstyvende", 7: "halvfjerdsindstyvende", 8: "firsindstyvende",
                 9: "halvfemsindstyvende"}
_LARGE = [(10**9, "milliard", "milliarder"), (10**6, "million", "millioner")]


def _below_100(n: int) -> str:
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    if ones == 0:
        return _TENS[tens]
    return f"{_ONES[ones]}og{_TENS[tens]}"


def _below_1000(n: int) -> list[str]:
    """Words for 1..999 as a list of parts, without the joining 'og'."""
    hundreds, rest = divmod(n, 100)
    parts: list[str] = []
    if hundreds:
        parts.append("hundrede" if hundreds == 1 else f"{_ONES[hundreds]} hundrede")
    if rest:
        parts.append(_below_100(rest))
    return parts


def _join(parts: list[str], last_below_100: bool) -> str:
    if len(parts) > 1 and last_below_100:
        return " ".join(parts[:-1]) + " og " + parts[-1]
    return " ".join(parts)


def cardinal(n: int) -> str:
    if n < 0:
        return "minus " + cardinal(-n)
    if n < 100:
        return _below_100(n)
    parts: list[str] = []
    rest = n
    for value, singular, plural in _LARGE:
        count, rest = divmod(rest, value)
        if count:
            parts.append(f"en {singular}" if count == 1 else f"{cardinal(count)} {plural}")
    thousands, rest = divmod(rest, 1000)
    if thousands:
        parts.append("tusind" if thousands == 1 else f"{' '.join(_below_1000(thousands))} tusind")
    if rest:
        low = _below_1000(rest)
        if rest < 100:
            parts.append(low[0])
            return _join(parts, last_below_100=True)
        hundreds_part, *tail = low
        parts.append(hundreds_part)
        if tail:
            parts.append(tail[0])
            return _join(parts, last_below_100=True)
    return " ".join(parts)


def year(n: int) -> str:
    if 1100 <= n <= 1999:
        hundreds, rest = divmod(n, 100)
        head = f"{_below_100(hundreds)} hundrede"
        return head if rest == 0 else f"{head} og {_below_100(rest)}"
    return cardinal(n)


def ordinal(n: int) -> str:
    """The ordinal of 0..999 ("15." -> "femtende"); the normaliser reads only 1-3 digit ordinals."""
    if n < 20:
        return _ORDINAL_ONES[n]
    if n < 100:
        tens, ones = divmod(n, 10)
        return _ORDINAL_TENS[tens] if ones == 0 else f"{_ONES[ones]}og{_ORDINAL_TENS[tens]}"
    hundreds, rest = divmod(n, 100)
    head = cardinal(hundreds * 100)
    return head if rest == 0 else f"{head} og {ordinal(rest)}"
