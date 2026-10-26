import pytest

from wt_eval.normalize import normalize, normalize_pair


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
        ("80 km", "firs kilometer"),
        ("i 1920'erne", "i nitten hundrede og tyve erne"),
        ("uafgjort med 6-6", "uafgjort med seks til seks"),
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


# Run 8: FLEURS references write the same spoken words in ways the model does not (and the
# other way round); each pair is one reference form and one model form of the same speech.
SAME_SPEECH = [
    # vulgar fractions: NFKC used to turn "29¾" into "293⁄4", read "to hundrede og treoghalvfems fire"
    ("det måler 29¾ tommer", "det måler 29 trefjerdedele tommer"),
    ("det måler 29¾ tommer", "det måler niogtyve tre fjerdedele tommer"),
    ("24½ tommer", "24 en halv tommer"),
    ("24½ tommer", "fireogtyve en halv tommer"),
    ("1½ time", "halvanden time"),
    ("⅓ af dem", "en tredjedel af dem"),
    ("⅔ af dem", "totredjedele af dem"),
    # abbreviations and their spoken words
    ("siden cirka 400 e.kr. og indtil 1.100 e.kr.", "siden cirka 400 efter Kristi fødsel og indtil 1100 efter Kristus"),
    ("1000–1300 e.Kr.", "1000 til 1300 efter Kristi fødsel"),
    ("omkring år 50 f.Kr.", "omkring år 50 før Kristi fødsel"),
    ("i det tredje århundrede f.v.t. og", "i det tredje århundrede før vor tidsregning og"),
    ("ekshalerer (dvs. udånder)", "ekshalerer, det vil sige udånder"),
    ("billeder af mistænkte o.l.", "billeder af mistænkte og lignende"),
    ("ost, tunfisk m.m.", "ost, tunfisk med mere"),
    ("ost, tunfisk mm.", "ost, tunfisk med mere"),
    ("lære nyt - f.eks. at bruge", "lære nyt, for eksempel at bruge"),
    ("lære nyt - fx at bruge", "lære nyt, f. eks. at bruge"),
    ("blandt andet", "bl.a."),
    ("ca. 500 franc", "cirka 500 franc"),
    ("~500 congolesiske franc", "cirka 500 congolesiske franc"),
    ("og så videre", "osv."),
    ("Jens, Ida m.fl. kom", "Jens, Ida med flere kom"),
    ("Jens o.a. kom", "Jens og andre kom"),
    ("iflg. planen", "ifølge planen"),
    ("vedr. mødet", "vedrørende mødet"),
    ("tlf. 12", "telefon 12"),
    ("på grund af regnen", "pga. regnen"),
    ("nummer 5", "nr. 5"),
    ("10 pct. flere", "10 procent flere"),
    ("(1989, s. 109)", "1989 side 109"),
    ("koster 50 kr.", "koster 50 kroner"),
    ("koster 1.500 kr", "koster 1500 kroner"),
    # units after a number
    ("50 kilometer", "50 km"),
    ("15 meter", "15 m."),
    ("35mm film", "35 millimeter film"),
    ("70 km/h", "70 km i timen"),
    ("70 km/t", "70 kilometer i timen"),
    # currency signs and the multiplication sign
    ("canadiske 5$ og 100$ sedler", "canadiske 5 dollars og 100 dollar sedler"),
    ("$5", "fem dollar"),
    ("29 tommer x 24 tommer", "29 tommer gange 24 tommer"),
    ("3 × 4", "tre gange fire"),
    # clock times, ratios and ranges
    ("klokken 11:35 pm", "klokken 11.35 p.m."),
    ("kl. 12", "klokken 12:00"),
    ("Mellem 10: 00-11: 00 MDT", "Mellem 10 til 11 MDT"),
    ("klokken 06:30", "klokken seks tredive"),
    ("format er 3:2", "format er 3 til 2"),
    ("(10-60 minutter)", "ti til tres minutter"),
    ("bagud med 25-30 år", "bagud med 25 til 30 år"),
    # ordinals: a number with a full stop before a lower-case word or a comma, and dates
    ("i det 11., 12. samt 13. århundrede", "i det ellevte, tolvte samt trettende århundrede"),
    ("Den 15. august 1940", "Den 15 august 1940"),
    ("Den 15. august", "den femtende august"),
    ("den 21. januar", "den enogtyvende januar"),
    ("2. verdenskrig", "anden verdenskrig"),
    # 1100-1999: read as a year or as a count, "1.100" and "1100" are the same number
    ("omkring 1.100", "omkring 1100"),
    ("omkring 1.100", "omkring elleve hundrede"),
    ("omkring 1.100", "omkring et tusind et hundrede"),
    ("1500 soldater", "tusind fem hundrede soldater"),
    # number words written as one word
    ("over 800.000 soldater", "over ottehundredetusind soldater"),
    ("200 år", "tohundrede år"),
    # spellings Danish allows both ways
    ("en bedre idé om", "en bedre ide om"),
    ("olympiske komites brev", "Olympiske Komités brev"),
    ("Erdoğan", "Erdogan"),
    ("Selvom ingen ved", "Selv om ingen ved"),
    ("i forhold ud over det verdslige", "i forhold udover det verdslige"),
    # acronyms spelled letter by letter or with full stops
    ("organisation (SWAPO)", "organisation S W A P O"),
    ("spektroskopi (FTIR).", "spektroskopi F T I R."),
    ("Washington D.C.", "Washington DC"),
]


@pytest.mark.parametrize("reference, hypothesis", SAME_SPEECH)
def test_the_same_speech_normalises_alike(reference, hypothesis):
    assert normalize(reference) == normalize(hypothesis)


@pytest.mark.parametrize(
    "text, expected",
    [
        ("det måler 29¾ tommer x 24½ tommer", "det måler niogtyve tre fjerdedele tommer gange fireogtyve en halv tommer"),
        ("siden cirka 400 e.kr.", "siden cirka fire hundrede efter kristus"),
        ("i det 11., 12. samt 13. århundrede", "i det ellevte tolvte samt trettende århundrede"),
        ("klokken 12:00 GMT", "klokken tolv gmt"),
        ("klokken 10:05", "klokken ti nul fem"),
        ("omkring 1.100 e.kr.", "omkring elleve hundrede efter kristus"),
        ("Den 1. maj", "den første maj"),
    ],
)
def test_run_8_readings(text, expected):
    assert normalize(text) == expected


@pytest.mark.parametrize(
    "text, expected",
    [
        # a full stop that ends a sentence is no ordinal
        ("Befolkningen er omkring 800. Det er det mindste land.", "befolkningen er omkring otte hundrede det er det mindste land"),
        ("Den stod færdig i 2011. Det åbnede i 2017.", "den stod færdig i to tusind og elleve det åbnede i to tusind og sytten"),
        # kr. is kroner only after a number
        ("Kr. og kroner", "kr og kroner"),
        # a dot between digits is still a decimal outside a clock time
        ("10.30", "ti komma tredive"),
        # m and mm are units only after a number
        ("5 mm", "fem millimeter"),
        ("m", "m"),
        # x is a times sign only before a number
        ("Malcolm X sagde", "malcolm x sagde"),
        # the number words that are not 1100-1999 stay as they are
        ("elleve tusind fem hundrede", "elleve tusind fem hundrede"),
        ("tusind og fem", "tusind og fem"),
        # a capital letter alone is no acronym; dotted initials need two letters
        ("I går så I A-holdet", "i går så i a holdet"),
        ("Henrik P. Hansen", "henrik p hansen"),
        # words that only look like number words are not split
        ("tusindfryd og tretten", "tusindfryd og tretten"),
        # æ, ø and å keep their letters when other accents go
        ("Æblet, øen og ålen, café", "æblet øen og ålen cafe"),
    ],
)
def test_run_8_leaves_alone(text, expected):
    assert normalize(text) == expected


# Run 8: a compound written with a hyphen on one side and closed on the other is one word; split
# on the other side it stays split, as before.
@pytest.mark.parametrize(
    "reference, hypothesis, ref_norm, hyp_norm",
    [
        ("Hjemkomst-chok", "Hjemkomstchok", "hjemkomstchok", "hjemkomstchok"),
        ("en boda-boda (motorcykel-taxa)", "en bodaboda motorcykeltaxa", "en bodaboda motorcykeltaxa",
         "en bodaboda motorcykeltaxa"),
        ("kaktusfinken", "kaktus-finken", "kaktusfinken", "kaktusfinken"),
        ("FN-bataljon", "FN bataljon", "fn bataljon", "fn bataljon"),
        ("Super-G", "Super-G", "super g", "super g"),
        ("1800-tallet", "1800 tallet", "atten hundrede tallet", "atten hundrede tallet"),
        ("forårs- og frugtbarhedsritual", "forårs og frugtbarhedsritual", "forårs og frugtbarhedsritual",
         "forårs og frugtbarhedsritual"),
        ("Riga-fredstraktaten", "Riga fredstraktaten", "riga fredstraktaten", "riga fredstraktaten"),
    ],
)
def test_normalize_pair_joins_hyphenated_compounds(reference, hypothesis, ref_norm, hyp_norm):
    assert normalize_pair(reference, hypothesis) == (ref_norm, hyp_norm)


def test_normalize_pair_is_normalize_without_a_compound():
    ref, hyp = "Den 15. august 1940 kl. 12:00", "den 15 august 1940 klokken 12"
    assert normalize_pair(ref, hyp) == (normalize(ref), normalize(hyp))
