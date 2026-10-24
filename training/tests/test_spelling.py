"""spelling.yaml conventions: rewriting other spellings and finding term forms."""

import pytest

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
