import pytest

from wt_eval.danish_numbers import cardinal, year


@pytest.mark.parametrize(
    "n, words",
    [
        (0, "nul"),
        (1, "en"),
        (7, "syv"),
        (10, "ti"),
        (11, "elleve"),
        (16, "seksten"),
        (19, "nitten"),
        (20, "tyve"),
        (21, "enogtyve"),
        (30, "tredive"),
        (40, "fyrre"),
        (45, "femogfyrre"),
        (50, "halvtreds"),
        (60, "tres"),
        (70, "halvfjerds"),
        (76, "seksoghalvfjerds"),
        (80, "firs"),
        (90, "halvfems"),
        (99, "nioghalvfems"),
        (100, "hundrede"),
        (101, "hundrede og en"),
        (120, "hundrede og tyve"),
        (200, "to hundrede"),
        (345, "tre hundrede og femogfyrre"),
        (1000, "tusind"),
        (1005, "tusind og fem"),
        (1100, "tusind hundrede"),
        (2000, "to tusind"),
        (2024, "to tusind og fireogtyve"),
        (80000, "firs tusind"),
        (800000, "otte hundrede tusind"),
        (1000000, "en million"),
        (2500000, "to millioner fem hundrede tusind"),
        (1000000000, "en milliard"),
        (3000000000, "tre milliarder"),
    ],
)
def test_cardinal(n, words):
    assert cardinal(n) == words


@pytest.mark.parametrize(
    "n, words",
    [
        (1976, "nitten hundrede og seksoghalvfjerds"),
        (1800, "atten hundrede"),
        (1100, "elleve hundrede"),
        (1905, "nitten hundrede og fem"),
    ],
)
def test_year(n, words):
    assert year(n) == words


def test_year_outside_1100_1999_is_cardinal():
    assert year(2010) == "to tusind og ti"
    assert year(1066) == "tusind og seksogtres"
