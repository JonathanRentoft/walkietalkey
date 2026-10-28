"""The committed sentence list (training/data/sentences.csv) and spelling.yaml.

The owner reads these sentences aloud, in id order, for fine-tuning. The checks
keep the list the size and mix the brief asks for, varied, consistent with the
spelling conventions, and apart from the owner's held-out test sentences.

Run 12: the term list covers how the owner talks (about 200 terms, BRIEF_TERMS),
and every term is read in 8 to 25 sentences, so no term crowds out the others
and the list stays as short as that coverage allows (the owner records every
sentence).
"""

from __future__ import annotations

import itertools
import re
import statistics
from collections import Counter, defaultdict
from functools import cache

from wt_train.paths import SENTENCES_CSV, SPELLING_YAML
from wt_train.sentences import KINDS, load_sentences, word_count
from wt_train.spelling import load_spelling

# The owner's run-2 accuracy sentences (four with English terms). They stay a
# held-out check, so the list must not contain them or close variants.
OWNER_TEST_SENTENCES = (
    "Vi mødes i kantinen klokken tolv i morgen.",
    "Jeg har lige lavet en pull request til dig.",
    "Kan du sende mig rapporten inden fredag?",
    "Husk at deploye til staging før mødet.",
    "Min datter skal til tandlæge på torsdag.",
    "Vi skal merge branchen, når testene er grønne.",
    "Det regner meget i København i dag.",
    "Jeg refactorer koden og laver et commit bagefter.",
    "Kan du tjekke, om det nye endpoint virker?",
    "Tak for hjælpen, vi ses på mandag.",
)

# The forms the brief names: each is read aloud several times.
BRIEF_FORMS = (
    "deployer", "deployede", "merget", "PR'en", "refactore", "pushe", "committe",
    "endpoint", "staging", "Claude Code", "GitHub", "Vercel", "Supabase", "Azure",
    "Tauri", "Rust", "React",
)  # fmt: skip

# Run 12: the terms the brief names, by group. Each is a term name in spelling.yaml, except
# the ones in BRIEF_TERM_NAMES, which spelling.yaml covers under other names.
BRIEF_TERMS = {
    "Git and GitHub": (
        "clone", "fork", "checkout", "stash", "cherry-pick", "squash", "revert", "diff",
        "merge conflict", "tag", "changelog", "GitHub Actions", "workflow",
    ),
    "Cloud and operations": (
        "container", "server", "serverless", "CDN", "DNS", "SSL", "logs", "monitoring", "alert",
        "incident", "downtime", "Sentry", "AWS",
    ),
    "Data and APIs": (
        "Postgres", "Redis", "schema", "query", "index", "queue", "cron job", "webhook", "SDK", "CLI",
        "OAuth", "SSO", "JWT", "session", "cookie", "CORS", "rate limit", "JSON", "YAML", "CSV",
    ),
    "Code and testing": (
        "component", "props", "state", "hook", "async", "error", "exception", "stack trace",
        "unit test", "integration test", "end-to-end test", "coverage", "linter", "framework",
        "library", "package",
    ),
    "Apps and platforms": (
        "CSS", "HTML", "Tailwind", "Vite", "iOS", "macOS", "Android", "App Store", "TestFlight",
        "Xcode", "Swift", "Chrome extension",
    ),
    "AI work": (
        "agent", "fine-tune", "LoRA", "embedding", "vector database", "RAG", "eval", "benchmark",
        "inference", "context window", "hallucination", "MCP", "GPU", "dataset", "Hugging Face",
        "OpenAI", "Anthropic", "Claude", "Codex", "Copilot", "Gemini", "Whisper",
    ),
    "Product and business": (
        "onboarding", "MVP", "roadmap", "scope", "feedback", "demo", "pricing", "churn", "lead",
        "CRM", "SaaS", "KPI", "analytics", "follow-up",
    ),
    "Everyday tools": (
        "Notion", "Jira", "Teams", "Outlook", "Gmail", "Google Drive", "Excel", "PowerPoint",
        "Zoom", "Stripe", "LinkedIn",
    ),
}  # fmt: skip
# A brief term that spelling.yaml covers as more than one term: "Chrome extension" is the name
# Chrome and the noun extension, so "Chrome-appen" and "en extension til Slack" count as well.
BRIEF_TERM_NAMES = {"Chrome extension": ("Chrome", "extension")}

MIN_TERMS, MAX_TERMS = 190, 215
MIN_USES_PER_TERM = 8
# Run 12: no term in more than 25 sentences, so the common ones (test, deploy, merge) leave
# room for the rest and the list stays short.
MAX_USES_PER_TERM = 25
MIN_USES_PER_BRIEF_FORM = 3
MIN_PLAIN = 300
# Run 11's list had a mean of 9.9 words and a median of 10; the new list keeps that rhythm.
MEAN_WORDS = (8.9, 10.9)
MEDIAN_WORDS = (9, 11)
# Word-set overlap (Jaccard) at or above which two sentences count as near-duplicates.
NEAR_DUPLICATE = 0.7
OWNER_NEAR_DUPLICATE = 0.5


@cache
def sentences():
    return tuple(load_sentences(SENTENCES_CSV))


@cache
def spelling():
    return load_spelling(SPELLING_YAML)


def squash(text: str) -> str:
    """Lower case, punctuation (apostrophes too) to spaces, single spaces."""
    return " ".join(re.sub(r"[^\w\s]|_", " ", text.casefold()).split())


def jaccard(a: str, b: str) -> float:
    x, y = set(squash(a).split()), set(squash(b).split())
    return len(x & y) / len(x | y)


def uses() -> tuple[Counter, dict[str, set[str]]]:
    """In how many sentences each term is read (a sentence counts once per term, however
    many of its forms it has), and in which forms."""
    count: Counter = Counter()
    forms: dict[str, set[str]] = defaultdict(set)
    for s in sentences():
        hits = spelling().find_terms(s.text)
        count.update({hit.term for hit in hits})
        for hit in hits:
            forms[hit.term].add(hit.form)
    return count, forms


def test_spelling_yaml_loads_without_contradictions():
    terms = spelling().terms
    assert MIN_TERMS <= len(terms) <= MAX_TERMS, len(terms)
    assert {"pull request", "PR", "deploy", "merge", "Claude Code", "GitHub"} <= {t.name for t in terms}


def test_spelling_yaml_has_every_term_the_brief_names():
    names = {t.name for t in spelling().terms}
    missing = [
        (group, term)
        for group, terms in BRIEF_TERMS.items()
        for term in terms
        if not set(BRIEF_TERM_NAMES.get(term, (term,))) <= names
    ]
    assert missing == []


def test_size_and_mix():
    rows = sentences()
    # Run 12: about 200 terms in at least 8 sentences each, two or three terms to a sentence,
    # and the 300 plain sentences: just over a thousand rows. More would be padding.
    assert 1000 <= len(rows) <= 1100, len(rows)
    kinds = Counter(s.kind for s in rows)
    assert set(kinds) <= set(KINDS)
    assert kinds["plain"] >= MIN_PLAIN
    assert 0.65 <= kinds["terms"] / len(rows) <= 0.75


def test_sentence_lengths_keep_their_rhythm():
    lengths = [word_count(s.text) for s in sentences()]
    assert MEAN_WORDS[0] <= statistics.mean(lengths) <= MEAN_WORDS[1], statistics.mean(lengths)
    assert MEDIAN_WORDS[0] <= statistics.median(lengths) <= MEDIAN_WORDS[1]


def test_ids_run_in_order():
    rows = sentences()
    assert [s.id for s in rows] == [f"s{i:04d}" for i in range(1, len(rows) + 1)]


def test_the_kinds_are_mixed_through_the_list():
    """The recorder goes in id order, so every stretch has both kinds."""
    rows = sentences()
    longest = max(len(list(run)) for _, run in itertools.groupby(s.kind for s in rows))
    assert longest <= 6
    for start in range(0, len(rows) - 99, 100):
        block = rows[start : start + 100]
        plain = sum(s.kind == "plain" for s in block)
        assert 20 <= plain <= 40, f"rows {start + 1}-{start + 100}: {plain} plain"


def test_every_sentence_has_4_to_20_words():
    bad = [(s.id, word_count(s.text)) for s in sentences() if not 4 <= word_count(s.text) <= 20]
    assert bad == []


def test_typography():
    bad = []
    for s in sentences():
        text = s.text
        if not text[0].isupper() or text[-1] not in ".?":
            bad.append((s.id, "capital first, full stop or question mark last"))
        if any(c in text for c in "—–\"’“”«»;"):
            bad.append((s.id, "dash, quote, curly apostrophe or semicolon"))
        if "  " in text or text != text.strip() or " ," in text or " ." in text:
            bad.append((s.id, "spacing"))
        if text[:-1].rstrip(".?") != text[:-1]:
            bad.append((s.id, "repeated end punctuation"))
    assert bad == []


def test_texts_are_unique_even_without_case_and_punctuation():
    counts = Counter(squash(s.text) for s in sentences())
    assert [text for text, n in counts.items() if n > 1] == []


def test_no_near_duplicates():
    rows = sentences()
    words = [set(squash(s.text).split()) for s in rows]
    close = []
    for i, j in itertools.combinations(range(len(rows)), 2):
        a, b = words[i], words[j]
        if len(a & b) / len(a | b) >= NEAR_DUPLICATE:
            close.append((rows[i].id, rows[j].id))
    assert close == []


def test_the_owner_test_sentences_are_held_out():
    for owner in OWNER_TEST_SENTENCES:
        for s in sentences():
            assert squash(s.text) != squash(owner), s.id
            assert jaccard(s.text, owner) < OWNER_NEAR_DUPLICATE, (s.id, owner)


def test_terms_rows_have_a_term_and_plain_rows_none():
    bad = []
    for s in sentences():
        hits = spelling().find_terms(s.text)
        if s.kind == "terms" and not hits:
            bad.append((s.id, "terms row without a term"))
        if s.kind == "plain" and hits:
            bad.append((s.id, f"plain row with {[h.form for h in hits]}"))
    assert bad == []


def test_only_conventional_spellings():
    bad = [(s.id, spelling().unconventional(s.text)) for s in sentences()]
    assert [b for b in bad if b[1]] == []


def test_names_and_abbreviations_keep_their_capitals():
    """Matching ignores case, so a Danish word spelled like a name counts as the name ("teams"
    as Teams, "rust" as Rust). The list writes every form with capitals exactly as listed, so
    each hit is the name it means."""
    bad = []
    for s in sentences():
        for hit in spelling().find_terms(s.text):
            if hit.form != hit.form.lower() and s.text[hit.start : hit.end] != hit.form:
                bad.append((s.id, s.text[hit.start : hit.end], hit.form))
    assert bad == []


def test_every_term_is_read_several_times_in_several_forms():
    count, forms = uses()
    rare = {t.name: count[t.name] for t in spelling().terms if count[t.name] < MIN_USES_PER_TERM}
    assert rare == {}
    common = {t.name: count[t.name] for t in spelling().terms if count[t.name] > MAX_USES_PER_TERM}
    assert common == {}
    one_form = [t.name for t in spelling().terms if len(t.forms) > 1 and len(forms[t.name]) < 2]
    assert one_form == []
    # Spread the forms: nearly every listed form is read at least once.
    listed = [(t.name, f) for t in spelling().terms for f in t.forms]
    unused = [(name, f) for name, f in listed if f not in forms[name]]
    assert len(unused) <= 0.05 * len(listed), unused


def test_the_brief_forms_are_read_several_times():
    form_count = Counter(h.form for s in sentences() for h in spelling().find_terms(s.text))
    assert {f: form_count[f] for f in BRIEF_FORMS if form_count[f] < MIN_USES_PER_BRIEF_FORM} == {}
