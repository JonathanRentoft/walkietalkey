"""spelling.yaml conventions: rewriting other spellings and finding term forms."""

import re

import pytest

from wt_train.harness import normalize_pair
from wt_train.spelling import Spelling, Term, load_spelling


def conventions() -> Spelling:
    return Spelling(
        [
            Term("deploy", ("deploye", "deployer", "deployede", "deployet"), {"deploy'e": "deploye"}),
            Term("PR", ("PR", "PR'en", "PR'er", "PR'erne"), {"PR-en": "PR'en", "PRen": "PR'en"}),
            Term("pull request", ("pull request", "pull requesten", "pull requests")),
            Term("Claude Code", ("Claude Code",)),
        ]
    )


def test_apply_rewrites_other_spellings_to_the_convention():
    s = conventions()
    assert s.apply("Jeg skal deploy'e PR-en og PRen i dag.") == "Jeg skal deploye PR'en og PR'en i dag."
    assert s.apply("Ingen termer her.") == "Ingen termer her."


def test_find_terms_matches_whole_words_case_insensitively():
    s = conventions()
    hits = s.find_terms("Vi deployede PR'en, og pr'erne venter på Claude  Code.")
    assert [(h.term, h.form) for h in hits] == [
        ("deploy", "deployede"),
        ("PR", "PR'en"),
        ("PR", "PR'erne"),
        ("Claude Code", "Claude Code"),
    ]
    # Not inside longer words, and an apostrophe ending belongs to the word.
    assert s.find_terms("deployerne PRISEN PR'ens") == []


def test_longer_forms_win():
    hits = conventions().find_terms("Pull requesten er klar, og pull requests venter.")
    assert [h.form for h in hits] == ["pull requesten", "pull requests"]


def test_unconventional_spellings_are_reported():
    assert conventions().unconventional("PR-en er deploy'et") == ["PR-en"]


def test_contradictions_are_rejected():
    with pytest.raises(ValueError, match="not one of its forms"):
        Spelling([Term("merge", ("merge",), {"merg'e": "merget"})])
    with pytest.raises(ValueError, match="both"):
        Spelling([Term("a", ("PR",)), Term("b", ("pr",))])


def test_load_spelling_reads_the_yaml(tmp_path):
    path = tmp_path / "spelling.yaml"
    path.write_text(
        "terms:\n  merge:\n    forms: [merge, merger, mergede, merget]\n    also:\n      merged: mergede\n",
        encoding="utf-8",
    )
    s = load_spelling(path)
    assert s.apply("vi merged den") == "vi mergede den"
    assert [h.form for h in s.find_terms("Den er merget.")] == ["merget"]


def test_an_also_spelling_may_not_be_another_terms_form():
    # Whichever term comes first in the file.
    with pytest.raises(ValueError, match="both"):
        Spelling([Term("a", ("deploye",), {"PR-en": "deploye"}), Term("b", ("PR-en",))])


def test_an_also_spelling_belongs_to_one_term():
    with pytest.raises(ValueError, match="twice"):
        Spelling(
            [
                Term("PR", ("PR'en",), {"PRen": "PR'en"}),
                Term("pull request", ("pull requesten",), {"pRen": "pull requesten"}),
            ]
        )


def test_a_form_is_listed_once():
    with pytest.raises(ValueError, match="twice"):
        Spelling([Term("merge", ("merge", "merger", "Merge"))])


def test_apply_keeps_a_capital_first_letter():
    s = conventions()
    assert s.apply("Deploy'e den nu, og deploy'e den igen.") == "Deploye den nu, og deploye den igen."
    # A form with its own capitals keeps them.
    assert s.apply("pren er klar.") == "PR'en er klar."


@pytest.mark.parametrize(
    "body, message",
    [
        ("terms:\n  merge:\n    form: [merge]\n", "unknown key"),
        ("terms:\n  merge:\n    forms: [merge]\n    alsoo: {}\n", "unknown key"),
        ("terms:\n  merge:\n    forms: merge\n", "list"),
        ("terms:\n  merge:\n    forms: [merge]\n    also: [merged]\n", "also"),
        ("term:\n  merge:\n    forms: [merge]\n", "unknown key"),
    ],
)
def test_load_spelling_rejects_typos(tmp_path, body, message):
    path = tmp_path / "spelling.yaml"
    path.write_text(body, encoding="utf-8")
    with pytest.raises(ValueError, match=message):
        load_spelling(path)


# --- hyphens inside a form (run 12) ----------------------------------------------------------


def hyphenated() -> Spelling:
    return Spelling(
        [
            Term(
                "fine-tune",
                ("fine-tune", "fine-tuner", "fine-tunede", "fine-tuning"),
                {"finetune": "fine-tune", "fine tune": "fine-tune", "finetunede": "fine-tunede"},
            ),
            Term("merge", ("merge", "merger")),
            Term("merge conflict", ("merge-konflikt", "merge-konflikten"), {"mergekonflikten": "merge-konflikten"}),
            Term("test", ("test", "testen")),
            Term("end-to-end test", ("end-to-end test", "end-to-end testen")),
            Term("follow-up", ("follow-up", "follow-uppen")),
        ]
    )


def test_a_hyphen_inside_a_form_is_part_of_the_form():
    s = hyphenated()
    hits = s.find_terms("Vi fine-tunede modellen i går, og fine-tuning-kørslen er færdig.")
    assert [(h.term, h.form) for h in hits] == [("fine-tune", "fine-tunede"), ("fine-tune", "fine-tuning")]
    # Neither half is a term on its own.
    assert s.find_terms("Det er fine, vi tuner den senere.") == []
    # Followed by a hyphen and a Danish word, the form is still found (a hyphen ends a word).
    assert [h.form for h in s.find_terms("Follow-up-mødet og follow-uppen.")] == ["follow-up", "follow-uppen"]


def test_the_longest_form_wins_over_a_form_inside_it():
    s = hyphenated()
    hits = s.find_terms("Merge-konflikten kom, da vi skulle merge.")
    assert [(h.term, h.form) for h in hits] == [("merge conflict", "merge-konflikten"), ("merge", "merge")]
    hits = s.find_terms("End-to-end testen fejler, men testen er grøn.")
    assert [(h.term, h.form) for h in hits] == [("end-to-end test", "end-to-end testen"), ("test", "testen")]


def test_closed_and_open_spellings_are_rewritten_into_the_hyphenated_form():
    s = hyphenated()
    assert s.apply("Vi finetunede den og skal fine tune igen.") == "Vi fine-tunede den og skal fine-tune igen."
    assert s.apply("Mergekonflikten er løst.") == "Merge-konflikten er løst."
    assert s.unconventional("Vi fine-tunede den.") == []


@pytest.mark.parametrize(
    "reference, hypothesis",
    [
        ("Vi fine-tunede modellen.", "Vi finetunede modellen."),
        ("Vi fine-tunede modellen.", "Vi fine tunede modellen."),
        ("Merge-konflikten er løst.", "Mergekonflikten er løst."),
        ("Merge-konflikten er løst.", "Merge konflikten er løst."),
        ("End-to-end testen fejler.", "End-to-end-testen fejler."),
        ("Tag en follow-up med kunden.", "Tag en followup med kunden."),
    ],
)
def test_the_wer_normaliser_scores_a_hyphenated_form_like_its_other_spellings(reference, hypothesis):
    ref, hyp = normalize_pair(reference, hypothesis)
    assert ref == hyp


# --- the committed spelling.yaml (run 12) --------------------------------------------------


def test_every_hyphenated_form_has_its_closed_spelling_under_also():
    """A model that writes "finetunede" or "mergekonflikten" is rewritten into the form before
    training, and its hypothesis counts as the term."""
    missing = []
    for term in load_spelling().terms:
        for form in term.forms:
            if " " not in form and re.search(r"\w-\w", form):
                closed = form.replace("-", "")
                if term.also.get(closed) != form:
                    missing.append((term.name, form, closed))
    assert missing == []


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Claude Code og Claude", [("Claude Code", "Claude Code"), ("Claude", "Claude")]),
        ("GitHub Actions på GitHub", [("GitHub Actions", "GitHub Actions"), ("GitHub", "GitHub")]),
        ("pull requesten og requesten", [("pull request", "pull requesten"), ("request", "requesten")]),
        ("unit testen og testen", [("unit test", "unit testen"), ("test", "testen")]),
        ("merge-konflikten, så merge", [("merge conflict", "merge-konflikten"), ("merge", "merge")]),
        ("serverless og serveren", [("serverless", "serverless"), ("server", "serveren")]),
        ("integrationstesten og testen", [("integration test", "integrationstesten"), ("test", "testen")]),
        ("vektordatabasen og databasen", [("vector database", "vektordatabasen"), ("database", "databasen")]),
        ("PostgreSQL og SQL", [("Postgres", "PostgreSQL"), ("SQL", "SQL")]),
        ("OpenAI og AI-agenten", [("OpenAI", "OpenAI"), ("AI", "AI"), ("agent", "agenten")]),
        ("Teams-mødet", [("Teams", "Teams")]),
    ],
)
def test_overlapping_terms_in_spelling_yaml(text, expected):
    assert [(h.term, h.form) for h in load_spelling().find_terms(text)] == expected


def test_the_bare_danish_tag_is_no_term():
    # "tag" is the imperative "take" and the noun "roof": in nearly every plain sentence. The
    # git tag is read in its other forms.
    s = load_spelling()
    assert s.find_terms("Tag den med, taget er utæt.") == []
    assert [h.form for h in s.find_terms("Tagget er pushet, og tags følger med.")] == ["tagget", "pushet", "tags"]
