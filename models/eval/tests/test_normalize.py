import pytest

from wt_eval.normalize import normalize


@pytest.mark.parametrize(
    "text, expected",
    [
        # lower case, punctuation stripped, whitespace collapsed
        ("Hej, mit navn er Emil.", "hej mit navn er emil"),
        ("  Hvordan   går det?  ", "hvordan går det"),
        # hyphens and quotes become word breaks on both sides alike
        ("bevarelses- og adgangsgebyrer", "bevarelses og adgangsgebyrer"),
        ('et sandt "usynligt hold”', "et sandt usynligt hold"),
        # numbers as spoken Danish
        ("I 1976 var 30 procent genetableret", "i nitten hundrede og seksoghalvfjerds var tredive procent genetableret"),
        ("30%", "tredive procent"),
        ("30 %", "tredive procent"),
        ("over 800.000 soldater", "over otte hundrede tusind soldater"),
        ("3,5 millioner", "tre komma fem millioner"),
        ("2.5 kg", "to komma fem kg"),
        ("80 km", "firs km"),
        ("i 1920'erne", "i nitten hundrede og tyve erne"),
        ("uafgjort med 6-6", "uafgjort med seks seks"),
        ("2024", "to tusind og fireogtyve"),
        # spelled-out and digit forms meet
        ("et hundrede og tyve", "hundrede og tyve"),
        ("tusinde", "tusind"),
        # NFKC: full-width digits and ligatures fold
        ("１２", "tolv"),
        # Danish letters survive
        ("Æble, ØL og Å", "æble øl og å"),
        ("", ""),
    ],
)
def test_normalize(text, expected):
    assert normalize(text) == expected


def test_both_sides_agree_on_digits_and_words():
    assert normalize("Han fik 21 point.") == normalize("han fik enogtyve point")
