"""The WER normaliser. Applied identically to reference and hypothesis.

The rule behind every step: the same spoken words score the same however they
are written. FLEURS references and the model write numbers, abbreviations and
compounds in different ways for the same speech, so both sides are brought to
one spoken form before words are counted.

Steps, in order:
1. Vulgar fractions as words, before NFKC (which would glue "29¾" into
   "293⁄4"): "½" -> "en halv", "¾" -> "tre fjerdedele", "1½" -> "halvanden".
2. Unicode NFKC (folds full-width digits, ligatures and similar), then accents
   dropped except the ring of "å" ("idé" -> "ide", "Erdoğan" -> "Erdogan":
   Danish writes "idé" and "ide" alike, and the model writes foreign names
   either way).
3. Abbreviations as their words (run 8): "f.eks." and "fx" -> "for eksempel",
   "dvs." -> "det vil sige", "o.l." -> "og lignende", "m.m." -> "med mere",
   "e.Kr." -> "efter kristus", "f.v.t." -> "før vor tidsregning", "kl." ->
   "klokken", "ca." -> "cirka", ... (``_ABBREVIATIONS``); "kr." -> "kroner" and
   units ("km" -> "kilometer", "m" -> "meter", "km/t" -> "kilometer i timen")
   only after a number; "s." -> "side" only before one.
4. Acronyms spelled letter by letter or with full stops become one word:
   "S W A P O" -> "SWAPO", "p.m." -> "pm" (after the abbreviations, so "o.l."
   is "og lignende", not "ol").
5. Signs that are read aloud: "5$" and "$5" -> "fem dollar" (also € and £),
   "~500" -> "cirka 500", "x" or "×" before a number -> "gange".
6. Number expressions:
   - a dash between numbers is read "til" ("10-60 minutter", "1000–1300")
   - clock times: "11:35", and "11.35" after "klokken", -> "elleve
     femogtredive"; a whole hour drops its minutes ("12:00" -> "tolv")
   - a ratio "3:2" -> "tre til to"
   - ordinals: 1-3 digits with a full stop before a lower-case word or a comma
     ("det 11., 12. samt 13. århundrede" -> "ellevte tolvte ... trettende"),
     and a day before a month name, with or without the stop ("15 august" ->
     "femtende august")
7. Numbers as spoken Danish (wt_eval.danish_numbers):
   - "800.000" (dot-grouped thousands) -> 800000 -> "otte hundrede tusind"
   - "3,5" / "2.5" (decimal) -> "tre komma fem" (the fraction is read as a whole
     number, each leading zero as "nul": "0,05" -> "nul komma nul fem")
   - a lone 4-digit 1100-1999 is read as a year: "1976" -> "nitten hundrede og
     seksoghalvfjerds"; every other integer as a cardinal: "2024" -> "to tusind
     og fireogtyve"
   - "%" -> "procent", "&" -> "og"
   Numbers are cut free of attached letters, so "4g" -> "fire g".
8. Lower case, then punctuation stripped: every character that is not a letter,
   digit or whitespace (and "_") becomes a space, so hyphenated compounds split
   the same way on both sides ("Riga-fredstraktaten" -> "riga fredstraktaten";
   ``normalize_pair`` joins them where the other side writes them closed).
9. Word folds: spelling variants ("tusinde" -> "tusind", "én"/"ét" -> "en"/"et",
   "dollars" -> "dollar", "trefjerdedele" -> "tre fjerdedele", "selv om" ->
   "selvom", "ud over" -> "udover", "efter Kristi fødsel" -> "efter kristus");
   number words written as one word split ("ottehundredetusind" -> "otte
   hundrede tusind"); "et" before "hundrede"/"tusind" dropped; and a number
   1100-1999 read as a count becomes the year reading ("tusind fem hundrede"
   -> "femten hundrede"), so "1.100", "1100" and "et tusind et hundrede" meet.
10. Whitespace collapsed.

Known limits (accepted, documented in docs/MODELS.md): clock times written with
a full stop outside "klokken" ("10.30" reads as a decimal) or as "halv syv",
Roman numerals ("III"), compounds written apart in one text and closed in the
other without a hyphen ("bagud kompatibel"), and abbreviations outside the list
are not folded.
"""

from __future__ import annotations

import re
import unicodedata

from .danish_numbers import _ONES, _TENS, cardinal, ordinal, year

# --- 1. vulgar fractions ---------------------------------------------------------------

_FRACTIONS = {
    "½": "en halv", "⅓": "en tredjedel", "⅔": "to tredjedele", "¼": "en fjerdedel",
    "¾": "tre fjerdedele", "⅕": "en femtedel", "⅖": "to femtedele", "⅗": "tre femtedele",
    "⅘": "fire femtedele", "⅙": "en sjettedel", "⅚": "fem sjettedele", "⅐": "en syvendedel",
    "⅛": "en ottendedel", "⅜": "tre ottendedele", "⅝": "fem ottendedele", "⅞": "syv ottendedele",
    "⅑": "en niendedel", "⅒": "en tiendedel",
}
_FRACTION = re.compile("[" + "".join(_FRACTIONS) + "]")
_ONE_AND_A_HALF = re.compile(r"(?<![\d.,])1\s?½")


def _fractions(text: str) -> str:
    text = _ONE_AND_A_HALF.sub(" halvanden ", text)
    return _FRACTION.sub(lambda m: f" {_FRACTIONS[m.group(0)]} ", text)


# --- 2. accents --------------------------------------------------------------------------

_RING = "\u030a"  # the ring of å and Å, the one accent Danish spells with


def _drop_accents(text: str) -> str:
    if text.isascii():
        return text
    kept = "".join(c for c in unicodedata.normalize("NFD", text)
                   if c == _RING or unicodedata.category(c) != "Mn")
    return unicodedata.normalize("NFC", kept)


# --- 3. abbreviations, units -------------------------------------------------------------

# (pattern, words): each pattern matches a whole abbreviation, case-insensitively.
_ABBREVIATIONS = [
    (r"e\.\s?kr\.?", "efter kristus"), (r"f\.\s?kr\.?", "før kristus"),
    (r"f\.\s?v\.\s?t\.?", "før vor tidsregning"), (r"e\.\s?v\.\s?t\.?", "efter vor tidsregning"),
    (r"f\.\s?eks\.?", "for eksempel"), (r"fx\.?", "for eksempel"),
    (r"bl\.\s?a\.?", "blandt andet"), (r"ca\.", "cirka"), (r"dvs\.?", "det vil sige"),
    (r"osv\.?", "og så videre"), (r"m\.\s?m\.", "med mere"), (r"o\.\s?l\.", "og lignende"),
    (r"m\.\s?v\.|mv\.", "med videre"), (r"pga\.?", "på grund af"), (r"mht\.?", "med hensyn til"),
    (r"ift\.", "i forhold til"), (r"vha\.", "ved hjælp af"), (r"evt\.", "eventuelt"),
    (r"inkl\.", "inklusive"), (r"ekskl\.", "eksklusive"), (r"etc\.", "et cetera"),
    (r"jf\.|jvf\.", "jævnfør"), (r"hhv\.", "henholdsvis"), (r"kl\.", "klokken"), (r"nr\.", "nummer"),
    (r"pct\.?", "procent"), (r"m\.\s?fl\.", "med flere"), (r"o\.\s?a\.", "og andre"), (r"iflg\.", "ifølge"),
    (r"vedr\.", "vedrørende"), (r"tlf\.", "telefon"),
]
_ABBREVIATION = [(re.compile(r"(?<![\w.])(?:" + p + r")(?!\w)", re.IGNORECASE), f" {w} ")
                 for p, w in _ABBREVIATIONS]
# Units and kroner only after a number: "80 km" is "firs kilometer", "Kr." on its own is not kroner.
_UNITS = {"km/t": "kilometer i timen", "km/h": "kilometer i timen", "km": "kilometer", "cm": "centimeter",
          "mm": "millimeter", "m": "meter", "kr": "kroner"}
_UNIT = re.compile(r"(\d)\s*(km/[th]|km|cm|mm|m|kr)\.?(?![\w/])", re.IGNORECASE)
# "mm." on its own is "med mere", as "m.m.".
_MED_MERE = re.compile(r"(?<![\w.])mm\.?(?!\w)", re.IGNORECASE)
_PAGE = re.compile(r"(?<![\w.])s\.\s*(?=\d)", re.IGNORECASE)


def _abbreviations(text: str) -> str:
    for pattern, words in _ABBREVIATION:
        text = pattern.sub(words, text)
    text = _UNIT.sub(lambda m: f"{m.group(1)} {_UNITS[m.group(2).lower()]} ", text)
    text = _MED_MERE.sub(" med mere ", text)
    return _PAGE.sub(" side ", text)


# --- 4. acronyms ----------------------------------------------------------------------

# Capitals standing alone, between spaces, brackets, quotes or a closing stop; never next to a
# hyphen ("I A-holdet" is no acronym).
_SPELLED = re.compile(r"(?<![^\s(\[\"'“])[A-ZÆØÅ](?: [A-ZÆØÅ])+(?![^\s.,;:!?)\]\"'”])")
_DOTTED = re.compile(r"(?<![\w.])(?:[^\W\d_]\.){2,}(?!\w)")


def _acronyms(text: str) -> str:
    text = _SPELLED.sub(lambda m: m.group(0).replace(" ", ""), text)
    return _DOTTED.sub(lambda m: m.group(0).replace(".", "") + " ", text)


# --- 5. signs read aloud ------------------------------------------------------------------

_CURRENCIES = {"$": "dollar", "€": "euro", "£": "pund"}
_SIGN_AFTER = re.compile(r"(\d)\s*([$€£])")
_SIGN_BEFORE = re.compile(r"([$€£])\s*(\d[\d.,]*\d|\d)")
_SIGN = re.compile(r"[$€£]")
_ABOUT = re.compile(r"~\s*(?=\d)")
_TIMES = re.compile(r"(?<!\S)x(?=\s*\d)|×", re.IGNORECASE)


def _signs(text: str) -> str:
    text = _SIGN_AFTER.sub(lambda m: f"{m.group(1)} {_CURRENCIES[m.group(2)]} ", text)
    text = _SIGN_BEFORE.sub(lambda m: f" {m.group(2)} {_CURRENCIES[m.group(1)]} ", text)
    text = _SIGN.sub(lambda m: f" {_CURRENCIES[m.group(0)]} ", text)
    text = _ABOUT.sub(" cirka ", text)
    return _TIMES.sub(" gange ", text)


# --- 6. ranges, clock times, ratios, ordinals ---------------------------------------------

_RANGE = re.compile(r"(?<=\d)\s*[-–]\s*(?=\d)")
_CLOCK_AFTER_KLOKKEN = re.compile(r"(?<!\w)(klokken\s+)(\d{1,2})[.:]\s?(\d{2})(?![\d.,]\d)", re.IGNORECASE)
_CLOCK = re.compile(r"(?<![\d.,:])(\d{1,2}):\s?(\d{2})(?![\d.,]?\d)")
_RATIO = re.compile(r"(?<![\d.,:])(\d+):(\d)(?![\d.,]?\d)")
_MONTHS = ("januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober",
           "november", "december")
_DATE = re.compile(r"(?<![\d.,])(\d{1,2})\.?(\s+)(" + "|".join(_MONTHS) + r")(?!\w)", re.IGNORECASE)
_ORDINAL = re.compile(r"(?<![\d.,])(\d{1,3})\.(?=\s*,|\s+[^\W\d_A-ZÆØÅ])")


def _clock(hour: str, minutes: str) -> str:
    words = cardinal(int(hour))
    if int(minutes):
        words += " " + ("nul " if minutes[0] == "0" else "") + cardinal(int(minutes))
    return f" {words} "


def _expressions(text: str) -> str:
    text = _RANGE.sub(" til ", text)
    text = _CLOCK_AFTER_KLOKKEN.sub(lambda m: m.group(1) + _clock(m.group(2), m.group(3)), text)
    text = _CLOCK.sub(lambda m: _clock(m.group(1), m.group(2)), text)
    text = _RATIO.sub(r"\1 til \2", text)
    text = _DATE.sub(lambda m: f" {ordinal(int(m.group(1)))}{m.group(2)}{m.group(3)}", text)
    return _ORDINAL.sub(lambda m: f" {ordinal(int(m.group(1)))} ", text)


# --- 7. numbers --------------------------------------------------------------------------

_NUMBER = re.compile(r"\d{1,3}(?:\.\d{3})+(?!\d)|\d+[,.]\d+|\d+")
_NON_WORD = re.compile(r"[^\w\s]|_")


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


# --- 9. word folds -------------------------------------------------------------------------

_FOLD = {
    "tusinde": "tusind", "én": "en", "ét": "et", "dollars": "dollar",
    "trefjerdedel": "tre fjerdedele", "trefjerdedele": "tre fjerdedele",
    "totredjedel": "to tredjedele", "totredjedele": "to tredjedele",
}
# Word sequences with one spoken form (Danish allows both spellings, or the same phrase).
_PHRASES = [
    (("selv", "om"), ("selvom",)), (("ud", "over"), ("udover",)),
    (("efter", "kristi", "fødsel"), ("efter", "kristus")), (("før", "kristi", "fødsel"), ("før", "kristus")),
]
_ONES_WORDS = _ONES[1:10]
_NUMBER_PARTS = sorted({*(_ONES[1:]), *_TENS.values(), *(f"{o}og{t}" for o in _ONES[1:10] for t in _TENS.values()),
                        "hundrede", "tusind"}, key=len, reverse=True)
_NUMBER_WORDS = {*_NUMBER_PARTS, "nul", "million", "millioner", "milliard", "milliarder"}
_SCALES = {"hundrede", "tusind"}


def _number_parts(word: str) -> list[str] | None:
    """``word`` as number words written together ("ottehundredetusind" -> otte, hundrede,
    tusind), or None if it is not wholly made of them."""
    if not word:
        return []
    for part in _NUMBER_PARTS:
        if word.startswith(part):
            rest = _number_parts(word[len(part):])
            if rest is not None:
                return [part, *rest]
    return None


def _split_number_word(word: str) -> list[str]:
    if word in _NUMBER_WORDS or len(word) < 6:
        return [word]
    parts = _number_parts(word)
    return parts if parts and len(parts) > 1 and _SCALES & set(parts) else [word]


def _phrases(words: list[str]) -> list[str]:
    out: list[str] = []
    i = 0
    while i < len(words):
        for seq, repl in _PHRASES:
            if tuple(words[i:i + len(seq)]) == seq:
                out.extend(repl)
                i += len(seq)
                break
        else:
            out.append(words[i])
            i += 1
    return out


def _hundreds_of_a_year(words: list[str]) -> list[str]:
    """A count of 1100-1999 ("tusind fem hundrede", "tusind hundrede") as the year reading
    ("femten hundrede", "elleve hundrede"), when the "tusind" starts the number."""
    out: list[str] = []
    i = 0
    while i < len(words):
        starts = words[i] == "tusind" and not (out and out[-1] in _NUMBER_WORDS)
        if starts and i + 1 < len(words) and words[i + 1] == "hundrede":
            out += ["elleve", "hundrede"]
            i += 2
        elif (starts and i + 2 < len(words) and words[i + 1] in _ONES_WORDS and words[i + 2] == "hundrede"):
            out += [_ONES[10 + _ONES.index(words[i + 1])], "hundrede"]
            i += 3
        else:
            out.append(words[i])
            i += 1
    return out


def _fold_words(words: list[str]) -> list[str]:
    folded = [part for w in words for part in _FOLD.get(w, w).split()]
    split = [part for w in folded for part in _split_number_word(w)]
    phrased = _phrases(split)
    kept = [w for i, w in enumerate(phrased)
            if not (w == "et" and i + 1 < len(phrased) and phrased[i + 1] in ("hundrede", "tusind"))]
    return _hundreds_of_a_year(kept)


# --- the normaliser --------------------------------------------------------------------------


def normalize(text: str) -> str:
    text = _drop_accents(unicodedata.normalize("NFKC", _fractions(text)))
    text = _acronyms(_abbreviations(text))
    text = _signs(text)
    text = _expressions(text)
    text = _NUMBER.sub(_spoken, text).lower()
    text = text.replace("%", " procent ").replace("&", " og ")
    text = _NON_WORD.sub(" ", text)
    return " ".join(_fold_words(text.split()))


# A compound written with hyphens between letters: "Schengen-land", "boda-boda".
_HYPHENATED = re.compile(r"(?<![\w-])[^\W\d_]+(?:-[^\W\d_]+)+(?![\w-])")


def normalize_pair(reference: str, hypothesis: str) -> tuple[str, str]:
    """``normalize`` of both texts, with one joint step: a compound with hyphens in one text
    ("Hjemkomst-chok") is written closed when the other text has it closed ("Hjemkomstchok"),
    and stays split otherwise ("FN-bataljon" against "FN bataljon"). A hyphen is the
    writer's choice of how to show a compound, not a spoken difference; a compound written
    apart without a hyphen is not joined (Danish counts that as a spelling error)."""
    ref_words, hyp_words = set(normalize(reference).split()), set(normalize(hypothesis).split())

    def join_where_closed(text: str, other: set[str]) -> str:
        def joined(m: re.Match[str]) -> str:
            closed = m.group(0).replace("-", "")
            return closed if normalize(closed) in other else m.group(0)

        return _HYPHENATED.sub(joined, text)

    return (normalize(join_where_closed(reference, hyp_words)),
            normalize(join_where_closed(hypothesis, ref_words)))
