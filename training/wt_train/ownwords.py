"""Run 12: the English words and phrases the owner says in his own dictations.

Værkstedet's "Dine egne ord" reads the WalkieTalkey app's dictation history on this Mac
(``history.db``, read-only, never copied), finds the English-looking words and phrases in
it that ``spelling.yaml`` does not cover yet, and lists them by how often he said them. He
ticks the ones to train on (``own-words.yaml``) and may write sentences of his own with them
(``sentences.csv`` in the same git-ignored folder, ``paths.LOCAL``). No sentence from the
history is shown or stored anywhere: only the words, how often, and in how many dictations.

Everything here is pure (texts in, counts out) except the three small readers and writers at
the end, so the rules are unit-tested on their own (``tests/test_studio_ownwords.py``).

How a word is judged
    * A token is Danish when it, or its stem without a Danish ending (-en, -erne, -ede, ...),
      is in the Danish vocabulary: the plain sentences of ``sentences.csv``, FLEURS da_dk's
      transcripts when they are in the work folder, and :data:`DANISH` (common words, the
      Danish -ing and -tion words, the loans everyone says). A token with æ, ø or å is
      Danish too.
    * Any other token is English-looking when it has a cue: a letter or cluster rare in
      Danish (c, q, w, x, z, th, sh, ee, oo, ea, ou, ay, ey, oa, gh, ph), an English ending
      (-ing, -tion, a -y after three letters), CamelCase (GitHub, macOS), ALLCAPS of two to
      five letters (AWS), a dot inside (Next.js), a digit beside letters (k8s), + or #
      (C++), a capital where no sentence starts (Grafana in the middle of a sentence), or a
      place in :data:`ENGLISH` (common developer words without any other cue: pipeline,
      frontend, build).
    * Once a word looks English somewhere, every time he said it counts, a sentence start
      included.
    * Danish endings on an English stem fold into the stem: an apostrophe ending always
      (PR'en, API'et), a bare one when the stem is seen on its own too (Dockeren with
      Docker), and -en or -et after a vowel always (Grafanaen with Grafana).
    * A phrase is two or three English-looking words next to each other (no punctuation
      between), said at least :data:`MIN_PHRASE` times.
    * Whatever ``spelling.yaml`` covers is left out: its forms and ``also`` spellings are
      cut out of each text before anything is counted, case-insensitive, and a word or
      phrase that is exactly one of them is dropped.
"""

from __future__ import annotations

import csv
import io
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote

import yaml

from .sentences import COLUMNS, Sentence, word_count

MIN_PHRASE = 2
PHRASE_LENGTHS = (2, 3)
# The shortest stem a Danish or an English ending is taken off.
MIN_STEM = 3
# A sentence of the owner's own, as the public list's are (tests/test_sentences_data.py).
MIN_WORDS, MAX_WORDS = 4, 20
MAX_SENTENCE_CHARS = 300
MAX_WORD_CHARS = 64
OWN_ID = re.compile(r"own-(\d+)")
OWN_KIND = "terms"

# Endings that make a Danish word of a Danish stem, longest first (the vocabulary check).
DANISH_ENDINGS = ("ernes", "erne", "enes", "ende", "ene", "este", "eres", "ede", "ere", "est", "ets", "ens",
                  "es", "en", "et", "er", "ne", "de", "te", "e", "s", "t", "n", "r")
# Danish endings on an English stem, longest first (Dockeren, featuren, commits).
STEM_ENDINGS = ("ernes", "erne", "enes", "ene", "ede", "ens", "ets", "es", "en", "et", "er", "ne", "e", "s", "n",
                "t")
# -en and -et fold into a stem that ends in one of these even when the stem is not seen alone
# (Kibanaen, Jiraen); not after an e, which an English word ends in before -en (screen, queen).
VOWELS = "aiouy"
RARE_LETTERS = set("cqwxz")
RARE_CLUSTERS = ("th", "sh", "ee", "oo", "ea", "ou", "ay", "ey", "oa", "gh", "ph")
ENGLISH_ENDINGS = ("ing", "tion", "tions")

# A token: letters or digits, with apostrophe endings, + and #, and dots inside (Next.js).
_TOKEN = re.compile(r"[^\W_][\w'’+#]*(?:\.[^\W_][\w'’+#]*)*")
# Between two tokens, these end a phrase; the first group also starts a new sentence.
_SENTENCE_END = re.compile(r"[.!?…\n]")
_PHRASE_BREAK = re.compile(r"[.!?…;:,()\[\]{}\"“”«»/\\|\n\t\u0000]")
_APOSTROPHE = re.compile(r"['’]")
_MASK = "\u0000"

# Common Danish words, and the Danish words that carry an "English" cue (-ing, -tion, c,
# x, z, w, ea, ou ...), lower case. The vocabulary from sentences.csv and FLEURS adds to it.
DANISH = frozenset("""
af alle allerede alligevel alt altid andet andre anden at bag bare bedre bedst begge bliver blev blevet blive
både da dag dage dagen dags de dem den denne dens der deres derfor derefter dermed dernæst dets det dette
din dine dit dog du efter eftermiddag egen egentlig egne eller ellers en end endnu ene eneste enhver ens
er et ét fik for foran fordi fra frem fx få får gang gange gerne gik giver godt gør gøre gå går har havde
have hej hele hen hende hendes her hos hun hvad hvem hver hvert hvilke hvilken hvilket hvis hvor hvordan
hvorfor hvornår hun i igen ikke ind inden indtil ingen intet ja jeg jer jeres jo kan kom komme kommer
kun kunne lidt lige lille lang langt lave laver lavet lige man mange med meget mellem men mens mere mest
mig min mindre mine mit mod måske ned nej nemlig netop noget nogen nogle nok nu ny nye nyt nær næste
næsten når og også om omkring op os over overfor på rigtig rigtigt sagde sammen se selv selvom ser sidste
sig sige siger sin sine sit skal skulle slet små snart som stadig stor store står så sådan tage tager
til tit tre tror under ud uden udover vi via vil ville vores vær være været var ved vej vel vi vist væk
øh øhm aha nå okay ok oki jamen altså hmm mm

ting regering løsning udvikling opdatering forbedring betaling handling samling ordning mening tegning
styring afdeling fordeling indstilling udstilling beslutning forskning rapportering ladning kobling
afstemning lovgivning stilling ring spring sving dronning erfaring behandling omkostning regning bygning
ledning indledning formulering vurdering registrering reservering investering organisering koordinering
træning testning måling optagning parring sikring kæmpning tænkning planlægning øvning bevægelsesstyring
nedlukning opsætning indspilning indtaling dækning ændring kørsel retning mødning udgivning varsling
melding tilmelding afmelding meddelelse bestilling levering leverance håndtering fejlsøgning
station situation information funktion position tradition nation organisation produktion generation
konstruktion operation relation reaktion kommunikation integration kombination motivation dokumentation
konfiguration installation transaktion definition koalition præsentation applikation institution
administration konkurrence direktion redaktion fraktion sektion lektion koncentration demonstration
evaluering validering version region religion diskussion kommission mission passion session

computer computere computeren cykel cykle cykler cyklen centrum center centret cirka café caféen chef chefen
chance chancen check chokolade citron camping container chauffør celle cellen cigaret citat cola cpr
cd cv cykelsti
taxa ekstra extra sex max fax mix mixet zone zoo pizza jazz zebra weekend weekenden web wc whisky show
shorts shampoo teater teatret teatre real ideal areal idealist kreativ kreativt kreative realistisk
reaktioner journalist journalisten tour souvenir bouillon hey jersey
danmark danske dansk danskere københavn aarhus odense aalborg europa eu dr tv tv2 dsb skat su dk usa fn
mandag tirsdag onsdag torsdag fredag lørdag søndag januar februar marts april maj juni juli august
september oktober november december
anmodning forening fremstilling opfordring placering redning renovering sammenligning skrivning slutning
stemning strukturering tilpasning udfordring uddeling vejledning virkning deling binding blanding
befolkning belastning beregning betydning bevilling hilsning kodning kategorisering prioritering
afprøvning afvikling afslutning ansøgning beskæftigelse indretning fortsættelse optimering forsikring
gennemgang tilladelse godkendelse rettighed ladestation læsning skrivning tolkning oversættelse
aktion ambition auktion destination edition fiktion illustration inflation inspiration intention
kollektion kompensation konvention koordination korrektion lokation mutation navigation notation
opposition population proportion reception reduktion repetition reservation revolution rotation
sanktion selektion simulation spekulation substitution transformation variation ventilation
abstraktion adoption animation association attraktion evolution frustration innovation instruktion
interaktion kalkulation kondition kreation lokation moderation reflektion refleksion
cirkel cirkus civil civile cement chips taxi zink watt wok ideer ide idé idéer
""".split())

# Common developer words with no other English cue (no c, w, th, CamelCase ...), lower case.
ENGLISH = frozenset("""
pipeline pipelines frontend backend build builds bug bugs standup standups prompt prompts repo repos online
offline update updates upload uploads download downloads deadline deadlines feature features release releases
token tokens login logout signup user users admin dashboard dashboards bundle bundler linter lint template
templates route router routes endpoint endpoints runtime framework frameworks library libraries tool tooling
module modules plugin plugins issue issues ticket tickets sprint sprints story stories board boards merge
merged rebase pull push fetch branch branches hotfix patch patches deploy deployed deployment rollback rollout
staging production prod dev devops cluster pod pods server servers serverless lambda function functions
handler handlers hook hooks state reducer selector props layout layouts component components style styles
theme themes dark light input inputs output outputs field fields button buttons modal modals popup tooltip
dropdown sidebar navbar header footer slider toggle checkbox spinner loader error errors warning warnings log
logs logging trace traces debug debugger breakpoint breakpoints unit mock mocks stub stubs fixture fixtures
snapshot snapshots coverage benchmark benchmarks profiler profiling latency throughput uptime downtime outage
incident incidents alert alerts monitoring metric metrics pager oncall backlog roadmap milestone milestones
epic epics estimate estimates review reviews reviewer approve approved feedback onboarding offboarding meeting
meetings call calls workshop retrospective kickoff scope scoping spec specs requirement requirements usecase
mockup mockups wireframe wireframes figma slack notion jira trello linear asana miro zoom teams github gitlab
bitbucket vercel netlify heroku supabase firebase docker kubernetes terraform ansible helm grafana prometheus
datadog sentry kafka redis postgres mongo mongodb mysql sqlite graphql grpc webhook webhooks api apis sdk sdks
cli gui ui ux fullstack stack
""".split())

_ALLCAPS = re.compile(r"[A-Z]{2,5}")
_CAMEL = re.compile(r"[a-z][A-Z]")


@dataclass(frozen=True)
class Found:
    """A word or phrase he said: how often, and in how many dictations."""

    word: str
    count: int
    dictations: int
    phrase: bool = False


@dataclass(frozen=True)
class Result:
    words: list[Found]
    # Dictations read (each counted once; empty ones left out).
    dictations: int


# --- the vocabulary ------------------------------------------------------------------------


def words_of(text: str) -> list[str]:
    """The tokens of a text, as written."""
    return [m.group(0) for m in _TOKEN.finditer(text)]


def vocabulary(texts: Iterable[str] = ()) -> frozenset[str]:
    """:data:`DANISH` and every token of ``texts`` (plain Danish), lower case."""
    out = set(DANISH)
    for text in texts:
        out.update(_fold(w) for w in words_of(text))
    return frozenset(out)


def _fold(word: str) -> str:
    return unicodedata.normalize("NFC", word).casefold()


def _base(token: str) -> str:
    """The token without an apostrophe ending (PR'en: PR, API'et: API)."""
    m = _APOSTROPHE.search(token)
    if m:
        head, tail = token[:m.start()], token[m.end():]
        if head and tail.isalpha() and len(tail) <= 5:
            return head
    return token


def is_danish(word: str, vocab: frozenset[str] | set[str]) -> bool:
    """In the vocabulary, as it is or with a Danish ending taken off; or with æ, ø or å."""
    folded = _fold(word)
    if any(c in folded for c in "æøå"):
        return True
    if folded in vocab:
        return True
    for ending in DANISH_ENDINGS:
        if folded.endswith(ending) and len(folded) - len(ending) >= MIN_STEM and folded[:-len(ending)] in vocab:
            return True
    return False


def has_cue(word: str, *, at_start: bool = False) -> bool:
    """Whether a word not in the Danish vocabulary looks English (see the module's text)."""
    letters = sum(c.isalpha() for c in word)
    if letters and ("+" in word or "#" in word):
        return True  # C++, C#
    if letters < 2:
        return False
    if _CAMEL.search(word) or _ALLCAPS.fullmatch(word) or "." in word:
        return True
    if any(c.isdigit() for c in word):
        return True
    folded = _fold(word)
    if RARE_LETTERS & set(folded) or any(c in folded for c in RARE_CLUSTERS):
        return True
    if folded.endswith(ENGLISH_ENDINGS) or (folded.endswith("y") and len(folded) >= 4):
        return True
    if folded in ENGLISH:
        return True
    return word[0].isupper() and not at_start


def looks_english(word: str, vocab: frozenset[str] | set[str], *, at_start: bool = False) -> bool:
    return not is_danish(word, vocab) and has_cue(word, at_start=at_start)


# --- finding them ----------------------------------------------------------------------------


@dataclass
class _Token:
    base: str
    at_start: bool
    # Whether a phrase may run from the token before into this one.
    joined: bool


def _mask(text: str, spelling) -> str:
    """``text`` with every form and ``also`` spelling of ``spelling`` cut out."""
    if spelling is None:
        return text
    out, last = [], 0
    for start, end in spelling.spans(text):
        if start < last:
            continue
        out += [text[last:start], _MASK]
        last = end
    out.append(text[last:])
    return "".join(out)


def _tokens(text: str) -> list[_Token]:
    out, last = [], 0
    for m in _TOKEN.finditer(text):
        between = text[last:m.start()]
        first = not out
        out.append(_Token(base=_base(m.group(0)), at_start=first or bool(_SENTENCE_END.search(between)),
                          joined=not first and not _PHRASE_BREAK.search(between)))
        last = m.end()
    return out


def _stem(base: str, seen: set[str]) -> str:
    """The English stem a Danish ending was put on, or the word itself (see the module's text)."""
    folded = _fold(base)
    for ending in STEM_ENDINGS:
        if not folded.endswith(ending) or len(folded) - len(ending) < MIN_STEM:
            continue
        stem = folded[:-len(ending)]
        if stem in seen or (ending in ("en", "et") and stem[-1] in VOWELS):
            return base[:len(base) - len(ending)]
    return base


def find(texts: Iterable[str], vocab: frozenset[str] | set[str], spelling=None, *,
         min_phrase: int = MIN_PHRASE) -> Result:
    """The English-looking words and phrases in ``texts`` (one dictation each) that
    ``spelling`` (a :class:`~wt_train.spelling.Spelling`, or None) does not cover, most often
    said first."""
    dictations = [_tokens(_mask(t, spelling)) for t in texts if t and t.strip()]
    english = {_fold(t.base) for d in dictations for t in d if looks_english(t.base, vocab, at_start=t.at_start)}
    keys: set[str] = set()
    for d in dictations:
        for t in d:
            if looks_english(t.base, vocab, at_start=t.at_start):
                keys.add(_fold(_stem(t.base, english)))

    counts: Counter = Counter()
    where: dict[str, set[int]] = defaultdict(set)
    spelled: dict[str, Counter] = defaultdict(Counter)
    phrases: Counter = Counter()
    phrase_where: dict[tuple, set[int]] = defaultdict(set)
    for n, d in enumerate(dictations):
        run: list[str] = []
        for t in d:
            stem = _stem(t.base, english)
            key = _fold(stem)
            if key not in keys or is_danish(t.base, vocab):
                run = []
                continue
            counts[key] += 1
            where[key].add(n)
            spelled[key][stem] += 1
            run = (run if t.joined else []) + [key]
            for length in PHRASE_LENGTHS:
                if len(run) >= length:
                    phrase = tuple(run[-length:])
                    phrases[phrase] += 1
                    phrase_where[phrase].add(n)

    def shown(key: str) -> str:
        return spelled[key].most_common(1)[0][0]

    found = [Found(shown(k), c, len(where[k])) for k, c in counts.items()]
    found += [Found(" ".join(shown(k) for k in p), c, len(phrase_where[p]), phrase=True)
              for p, c in phrases.items() if c >= min_phrase]
    if spelling is not None:
        found = [f for f in found if not spelling.covers(f.word)]
    found.sort(key=lambda f: (-f.count, -f.dictations, _fold(f.word)))
    return Result(words=found, dictations=len(dictations))


# --- the history -----------------------------------------------------------------------------


def read_history(db: Path) -> list[str] | None:
    """Each dictation's text from the app's ``history.db`` (the post-processed text when there
    is one, else the transcript), or None when there is no such file. The file is opened
    read-only (``mode=ro``; ``immutable=1`` when that fails, as it does in a folder the
    reader may not write its lock files to), never written and never copied."""
    db = Path(db)
    if not db.is_file():
        return None
    uri = f"file:{quote(str(db.resolve()))}"
    last: sqlite3.Error | None = None
    for options in ("mode=ro", "mode=ro&immutable=1"):
        try:
            con = sqlite3.connect(f"{uri}?{options}", uri=True)
        except sqlite3.Error as e:
            last = e
            continue
        try:
            return _rows(con)
        except sqlite3.Error as e:
            last = e
        finally:
            con.close()
    raise HistoryError(f"the history cannot be read ({type(last).__name__})")


class HistoryError(Exception):
    """The history is there but cannot be read (the message names no text from it)."""


def _rows(con: sqlite3.Connection) -> list[str]:
    columns = {row[1] for row in con.execute("PRAGMA table_info(transcription_history)")}
    if "transcription_text" not in columns:
        raise sqlite3.DatabaseError("no transcription_history table")
    post = "post_processed_text" if "post_processed_text" in columns else "NULL"
    out = []
    for raw, processed in con.execute(f"SELECT transcription_text, {post} FROM transcription_history"):
        text = processed if isinstance(processed, str) and processed.strip() else raw
        if isinstance(text, str) and text.strip():
            out.append(text)
    return out


# --- the owner's own words and sentences -------------------------------------------------------

OWN_WORDS_HEADER = (
    "# The owner's own words to train on: English words from his dictations that\n"
    "# spelling.yaml does not cover yet, ticked in wt-train studio. Git-ignored.\n"
)


def clean_word(value) -> str | None:
    """A word or phrase as the page sends it: trimmed, single spaces, no control characters,
    at most :data:`MAX_WORD_CHARS`; None when it is not one."""
    if not isinstance(value, str):
        return None
    word = " ".join(value.split())
    if not word or len(word) > MAX_WORD_CHARS or any(unicodedata.category(c)[0] == "C" for c in word):
        return None
    return word


def read_own_words(path: Path) -> list[str]:
    """The ticked words (``words: [Grafana, Terraform]``); [] without the file. Raises
    ValueError when the file is there but is not that."""
    path = Path(path)
    if not path.is_file():
        return []
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        raise ValueError(f"{path.name} is not YAML") from None
    words = raw.get("words") if isinstance(raw, dict) else None
    if words is None and raw == {}:
        return []
    if not isinstance(words, list):
        raise ValueError(f"{path.name} has no list of words")
    out: list[str] = []
    for w in words:
        word = clean_word(str(w)) if isinstance(w, (str, int, float)) else None
        if word and _fold(word) not in {_fold(x) for x in out}:
            out.append(word)
    return out


def own_words_text(words: list[str]) -> str:
    """The file: a short comment, then ``words: [Grafana, Terraform]`` on one line."""
    body = yaml.safe_dump({"words": list(words)}, default_flow_style=None, allow_unicode=True,
                          width=1 << 20, sort_keys=False)
    return OWN_WORDS_HEADER + body


def read_own_sentences(path: Path) -> list[Sentence]:
    """His own sentences (``id,text,kind``, as sentences.csv); [] without the file. Raises
    ValueError on another header."""
    path = Path(path)
    if not path.is_file():
        return []
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != COLUMNS:
            raise ValueError(f"{path.name}: the header must be {','.join(COLUMNS)}")
        return [Sentence(id=(r["id"] or "").strip(), text=(r["text"] or "").strip(), kind=(r["kind"] or "").strip())
                for r in reader if (r.get("id") or "").strip()]


def squash(text: str) -> str:
    """Lower case, punctuation (apostrophes too) to spaces, single spaces: two sentences that
    differ only there are the same sentence."""
    return " ".join(re.sub(r"[^\w\s]|_", " ", _fold(text)).split())


def mentions(text: str, word: str) -> bool:
    """Whether ``text`` has ``word`` at a word's start (Grafanaen has Grafana), any case."""
    pattern = r"\s+".join(re.escape(part) for part in word.split())
    return re.search(rf"(?<![\w'’]){pattern}", text, re.IGNORECASE) is not None


def check_sentence(text: str, word: str, existing: Iterable[str]) -> str | None:
    """Why a sentence of his own cannot be added, as an error code, or None. The public list's
    rules: 4 to 20 words, no em or en dash, not a sentence that is there already; and it has
    the word in it."""
    n = word_count(text)
    if not MIN_WORDS <= n <= MAX_WORDS or len(text) > MAX_SENTENCE_CHARS:
        return "length"
    if "—" in text or "–" in text:
        return "dash"
    if not mentions(text, word):
        return "no-word"
    key = squash(text)
    if any(squash(t) == key for t in existing):
        return "duplicate"
    return None


def next_id(sentences: list[Sentence]) -> str:
    numbers = [int(m.group(1)) for s in sentences if (m := OWN_ID.fullmatch(s.id))]
    return f"own-{max(numbers, default=0) + 1:04d}"


def sentences_text(sentences: list[Sentence]) -> str:
    out = io.StringIO()
    w = csv.writer(out, lineterminator="\n")
    w.writerow(COLUMNS)
    for s in sentences:
        w.writerow([s.id, s.text, s.kind])
    return out.getvalue()
