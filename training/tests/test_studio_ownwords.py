"""Run 12, "Dine egne ord": the English words of the owner's own dictations, found in a fake
history.db (never the app's real one), ticked into own-words.yaml, with sentences of his own.

The history is opened read-only and never copied; no sentence from it is shown, stored or
logged, and no word is ever in a URL."""

import json
import os
import sqlite3

import pytest

from fake_studio import get, post, request, start_server, stop_server, write_history, write_places
from wt_train import ownwords
from wt_train.spelling import load_spelling

# Plain Danish for the vocabulary, as sentences.csv's plain rows give it.
PLAIN = ["Hunden vil ikke ud, når det regner.", "Vi grillede pølser i haven i går.",
         "Mødet er flyttet til torsdag.", "Projektlederen ringer i morgen."]
SPELLING = """terms:
  deploy:
    forms: [deploye, deployer, deployede]
    also:
      deploy'e: deploye
  Claude Code:
    forms: [Claude Code]
  Vercel:
    forms: [Vercel]
"""
DICTATIONS = [
    "Grafana er nede igen, så vi kigger på Grafanaen i morgen.",
    ("vi skal deploye terraform", "Vi skal deploye med Terraform, før Grafana virker."),
    "Kibanaen viser en load balancer fejl, og load balancer er nede.",
    "Projektlederen ringer om Dockeren, når Docker kører igen.",
    "Claude Code og claude code er dækket, Vercel og vercel også, og deploy'e med.",
    "Mødet er flyttet til torsdag.",
    "",
]


@pytest.fixture
def spelling(tmp_path):
    path = tmp_path / "spelling.yaml"
    path.write_text(SPELLING, encoding="utf-8")
    return load_spelling(path)


def found(texts, spelling=None, vocab=None):
    result = ownwords.find(texts, vocab if vocab is not None else ownwords.vocabulary(PLAIN), spelling)
    return {f.word: f for f in result.words}, result


# --- judging a word ------------------------------------------------------------------------


@pytest.mark.parametrize("word", ["GitHub", "macOS", "AWS", "Next.js", "k8s", "C++", "C#", "pipeline", "feature",
                                  "load", "webhook", "Terraform", "staging", "deploy"])
def test_english_cues(word):
    assert ownwords.looks_english(word, ownwords.vocabulary(PLAIN))


@pytest.mark.parametrize("word", ["station", "stationen", "informationerne", "regeringen", "mødelokalet",
                                  "projektlederen", "hunden", "TV", "okay", "10x", "Torsdag"])
def test_danish_words_and_plain_tokens_are_not(word):
    assert not ownwords.looks_english(word, ownwords.vocabulary(PLAIN))


def test_a_capital_counts_only_where_no_sentence_starts():
    vocab = ownwords.vocabulary(PLAIN)
    assert ownwords.looks_english("Kibana", vocab)
    assert not ownwords.looks_english("Kibana", vocab, at_start=True)


# --- finding them in dictations ------------------------------------------------------------


def test_danish_endings_fold_into_the_english_stem():
    words, _ = found(["Vi kigger på Grafanaen, og Grafana kører.", "Der er fejl i Dockeren, men Docker kører.",
                      "Vi tjekker Kibanaen.", "Vi har en ny screen og en Docker."])
    assert words["Grafana"].count == 2 and "Grafanaen" not in words
    assert words["Docker"].count == 3 and "Dockeren" not in words
    # A vowel before -en folds even without the stem seen alone; an English -en does not.
    assert "Kibana" in words
    assert "screen" in words and "scre" not in words


def test_counts_and_dictations_most_often_said_first(spelling):
    texts = [t if isinstance(t, str) else t[1] for t in DICTATIONS]
    words, result = found(texts, spelling)
    assert result.dictations == 6  # the empty one is not a dictation
    g = words["Grafana"]
    assert (g.count, g.dictations, g.phrase) == (3, 2, False)
    assert words["Terraform"].dictations == 1
    assert words["load balancer"].phrase and words["load balancer"].count == 2
    assert words["Docker"].count == 2
    counts = [f.count for f in result.words]
    assert counts == sorted(counts, reverse=True) and result.words[0].word == "Grafana"
    # Danish never: not the vocabulary's words, not the compounds, not the Danish -ing and -tion words.
    assert not {"Mødet", "torsdag", "Projektlederen", "kigger", "fejl", "nede"} & set(words)


def test_what_spelling_yaml_covers_is_left_out(spelling):
    words, _ = found(["Claude Code og claude code, Vercel og vercel, deploye og deploy'e og DEPLOYER.",
                      "Vi bruger Claude Code og Claude til det."], spelling)
    assert not {"Claude Code", "claude code", "Vercel", "vercel", "deploye", "deploy'e", "DEPLOYER"} & set(words)
    # "Claude" inside "Claude Code" is not counted; alone it is.
    assert words["Claude"].count == 1


def test_a_phrase_needs_two_hits_and_no_punctuation_between():
    words, _ = found(["Vi har code review her.", "Den code review tager tid.", "Se den code. Review den."])
    assert words["code review"].count == 2
    # Inside the listed phrase, its words are the phrase: each counts only where said on its own.
    assert words["code"].count == 1 and words["review"].count == 1
    # Only English-looking words make a phrase: "flag" is Danish.
    words, _ = found(["En feature flag her.", "Den feature flag igen."])
    assert "feature flag" not in words and words["feature"].count == 2


def test_a_word_said_only_inside_a_listed_phrase_is_not_listed_again():
    words, _ = found(["Vi har code freeze nu.", "Husk code freeze i morgen.", "Er der code freeze?",
                      "Den load balancer er nede.", "Vores load balancer svarer ikke.",
                      "Kør load balancer config nu.", "Ret load balancer config igen."])
    assert words["code freeze"].count == 3 and "code" not in words and "freeze" not in words
    # A two-word phrase inside a listed three-word one counts only on its own too.
    assert words["load balancer config"].count == 2 and words["load balancer"].count == 2
    assert "load" not in words and "balancer" not in words and "config" not in words
    assert words["load balancer"].dictations == 2


def test_an_apostrophe_ending_belongs_to_the_word():
    words, _ = found(["Vi merger PR'en og API'et i dag, og PR er klar."])
    assert words["PR"].count == 2 and words["API"].count == 1
    assert "PR'en" not in words


# --- the history ---------------------------------------------------------------------------


def test_the_history_is_read_read_only_preferring_the_post_processed_text(tmp_path):
    db = write_history(tmp_path / "history.db", DICTATIONS)
    before = (db.read_bytes(), os.stat(db).st_mtime_ns, sorted(p.name for p in tmp_path.iterdir()))
    texts = ownwords.read_history(db)
    assert texts[1] == "Vi skal deploye med Terraform, før Grafana virker."
    assert texts[0].startswith("Grafana er nede") and "" not in texts and len(texts) == 6
    assert (db.read_bytes(), os.stat(db).st_mtime_ns, sorted(p.name for p in tmp_path.iterdir())) == before


def test_a_post_processed_text_that_is_empty_falls_back_to_the_transcript(tmp_path):
    db = write_history(tmp_path / "history.db", [("Grafana kører", "   "), ("x", None)])
    assert ownwords.read_history(db) == ["Grafana kører", "x"]


def test_an_old_history_without_post_processing(tmp_path):
    db = write_history(tmp_path / "history.db", ["Grafana kører igen."], post_processing=False)
    assert ownwords.read_history(db) == ["Grafana kører igen."]


def test_the_read_only_open_falls_back_to_immutable(tmp_path, monkeypatch):
    db = write_history(tmp_path / "history.db", ["Grafana kører igen."])
    real = sqlite3.connect
    opened = []

    def connect(database, *a, **k):
        opened.append(database)
        assert k.get("uri") is True and "mode=ro" in database
        if "immutable=1" not in database:
            raise sqlite3.OperationalError("unable to open database file")
        return real(database, *a, **k)

    monkeypatch.setattr(ownwords.sqlite3, "connect", connect)
    assert ownwords.read_history(db) == ["Grafana kører igen."]
    assert opened[0].endswith("?mode=ro") and opened[1].endswith("?mode=ro&immutable=1")


def test_no_history_and_a_broken_one(tmp_path):
    assert ownwords.read_history(tmp_path / "nothing.db") is None
    broken = tmp_path / "broken.db"
    broken.write_bytes(b"Grafana " * 200)
    with pytest.raises(ownwords.HistoryError) as e:
        ownwords.read_history(broken)
    assert "Grafana" not in str(e.value)


# --- his own words and sentences -------------------------------------------------------------


def test_the_ticked_words_file_is_one_line_of_words(tmp_path):
    text = ownwords.own_words_text(["Grafana", "Terraform"])
    assert text.endswith("\nwords: [Grafana, Terraform]\n") and text.startswith("# ")
    path = tmp_path / "own-words.yaml"
    tricky = ["Next.js", "C#", "yes", "load balancer", "k8s", "Grafana"]
    path.write_text(ownwords.own_words_text(tricky), encoding="utf-8")
    assert ownwords.read_own_words(path) == tricky
    assert ownwords.read_own_words(tmp_path / "none.yaml") == []
    path.write_text("words: Grafana\n", encoding="utf-8")
    with pytest.raises(ValueError):
        ownwords.read_own_words(path)


@pytest.mark.parametrize("text, problem", [
    ("Grafana er nede.", "length"),
    ("Grafana er nede igen " + "og igen " * 10 + "i dag.", "length"),
    ("Grafana er nede — igen i dag.", "dash"),
    ("Grafana er nede – igen i dag.", "dash"),
    ("Kibana er nede igen i dag.", "no-word"),
    ("Hunden vil ikke ud når det regner Grafana.", None),
    ("Vi kigger på grafanaen i morgen tidlig.", None),
    ("hunden vil IKKE ud, når det regner!", "duplicate"),
])
def test_a_sentence_of_his_own_is_checked_like_the_public_list(text, problem):
    existing = ["Hunden vil ikke ud, når det regner.", "Vi kigger på Kibana i dag."]
    word = "Grafana" if problem != "duplicate" else "hunden"
    assert ownwords.check_sentence(text, word, existing) == problem


# --- the screen ------------------------------------------------------------------------------


@pytest.fixture
def places(tmp_path, monkeypatch):
    p = write_places(tmp_path, monkeypatch)
    p.spelling.write_text(SPELLING, encoding="utf-8")
    write_history(p.history_db, DICTATIONS)
    return p


@pytest.fixture
def server(places):
    srv = start_server(places)
    yield srv
    stop_server(srv)


def test_the_screen_lists_the_new_words_without_a_sentence_from_the_history(server, places):
    status, view = get(server, "/api/ownwords")
    assert status == 200
    assert view["history"] == {"found": True, "readable": True, "path": str(places.history_db), "dictations": 6}
    words = {w["word"]: w for w in view["words"]}
    assert words["Grafana"] == {"word": "Grafana", "count": 3, "dictations": 2, "share": round(2 / 6, 4),
                                "phrase": False}
    assert words["load balancer"]["phrase"] is True
    assert view["words"][0]["word"] == "Grafana" and view["ticked"] == [] and view["found"] == len(view["words"])
    raw = json.dumps(view, ensure_ascii=False)
    for fragment in ("nede igen", "kigger på", "virker", "Mødet er flyttet"):
        assert fragment not in raw


def test_ticking_writes_own_words_yaml(server, places):
    post(server, "/api/ownwords/tick", {"word": "Grafana", "ticked": True})
    status, view = post(server, "/api/ownwords/tick", {"word": "Terraform", "ticked": True})
    assert status == 200
    path = places.local / "own-words.yaml"
    assert path.read_text(encoding="utf-8").splitlines()[-1] == "words: [Grafana, Terraform]"
    assert [t["word"] for t in view["ticked"]] == ["Grafana", "Terraform"]
    assert view["ticked"][0]["count"] == 3 and view["ticked"][0]["sentences"] == []
    assert "Grafana" not in {w["word"] for w in view["words"]}
    # Case does not count, and a word is ticked once.
    view = post(server, "/api/ownwords/tick", {"word": "grafana", "ticked": True})[1]
    assert [t["word"] for t in view["ticked"]] == ["Terraform", "grafana"]
    view = post(server, "/api/ownwords/tick", {"word": "GRAFANA", "ticked": False})[1]
    assert [t["word"] for t in view["ticked"]] == ["Terraform"]
    assert path.read_text(encoding="utf-8").splitlines()[-1] == "words: [Terraform]"
    assert "Grafana" in {w["word"] for w in view["words"]}
    for bad in ({"word": "", "ticked": True}, {"word": "x" * 65, "ticked": True}, {"word": "a\u0007b", "ticked": True},
                {"word": "Grafana", "ticked": "yes"}, {"word": 3, "ticked": True}):
        status, e = post(server, "/api/ownwords/tick", bad)
        assert status == 400 and e["error"] == "word"


def test_a_sentence_of_his_own_goes_to_the_local_list(server, places):
    post(server, "/api/ownwords/tick", {"word": "Grafana", "ticked": True})
    status, view = post(server, "/api/ownwords/sentence",
                        {"word": "Grafana", "text": "  Vi tjekker   Grafana,\nfør vi går hjem. "})
    assert status == 200 and view["sentence"] == {"id": "own-0001", "text": "Vi tjekker Grafana, før vi går hjem.",
                                                  "kind": "terms"}
    view = post(server, "/api/ownwords/sentence", {"word": "Grafana", "text": "Grafanaen viser alt for mange fejl."})[1]
    assert view["sentence"]["id"] == "own-0002"
    assert (places.local / "sentences.csv").read_text(encoding="utf-8") == (
        "id,text,kind\nown-0001,\"Vi tjekker Grafana, før vi går hjem.\",terms\n"
        "own-0002,Grafanaen viser alt for mange fejl.,terms\n")
    assert [s["id"] for s in view["ticked"][0]["sentences"]] == ["own-0001", "own-0002"]
    # It loads as a sentence list.
    from wt_train.sentences import load_sentences

    assert [s.id for s in load_sentences(places.local / "sentences.csv")] == ["own-0001", "own-0002"]
    cases = [({"word": "Grafana", "text": "Grafana er nede."}, 400, "length"),
             ({"word": "Grafana", "text": "Grafana er nede — igen i dag."}, 400, "dash"),
             ({"word": "Grafana", "text": "Kibana er nede igen i dag."}, 400, "no-word"),
             ({"word": "Grafana", "text": "vi tjekker grafana før vi går hjem"}, 409, "duplicate"),
             # The public list counts too.
             ({"word": "deploy", "text": "Kan du deploye til staging?"}, 409, "duplicate"),
             ({"word": "Grafana", "text": 5}, 400, "text")]
    for body, code, error in cases:
        status, e = post(server, "/api/ownwords/sentence", body)
        assert (status, e["error"]) == (code, error), body
        assert "Grafana" not in e["message"] and "Kibana" not in e["message"]
    assert len((places.local / "sentences.csv").read_text(encoding="utf-8").splitlines()) == 3


def test_a_public_duplicate_is_refused(server, places):
    status, e = post(server, "/api/ownwords/sentence", {"word": "Aarhus", "text": "Det regner i Aarhus i dag!"})
    assert (status, e["error"]) == (409, "duplicate")


def test_every_word_ticked(server):
    view = get(server, "/api/ownwords")[1]
    for w in view["words"]:
        view = post(server, "/api/ownwords/tick", {"word": w["word"], "ticked": True})[1]
    assert view["words"] == [] and view["found"] == len(view["ticked"]) > 0


def test_no_history_found(places, tmp_path):
    import dataclasses

    srv = start_server(dataclasses.replace(places, history_db=tmp_path / "elsewhere" / "history.db"))
    try:
        view = get(srv, "/api/ownwords")[1]
        assert view["history"]["found"] is False and view["words"] == [] and view["found"] == 0
        assert view["history"]["path"] == str(tmp_path / "elsewhere" / "history.db")
    finally:
        stop_server(srv)


def test_a_history_without_new_words(places, tmp_path):
    import dataclasses

    db = write_history(tmp_path / "plain" / "history.db", ["Mødet er flyttet til torsdag.", "Vercel og deploye."])
    srv = start_server(dataclasses.replace(places, history_db=db))
    try:
        view = get(srv, "/api/ownwords")[1]
        assert view["history"]["found"] is True and view["history"]["dictations"] == 2
        assert view["words"] == [] and view["found"] == 0
    finally:
        stop_server(srv)


def test_a_broken_own_words_file_is_never_overwritten(server, places):
    places.local.mkdir(parents=True)
    path = places.local / "own-words.yaml"
    path.write_text("words: [unclosed\n", encoding="utf-8")
    status, e = post(server, "/api/ownwords/tick", {"word": "Grafana", "ticked": True})
    assert (status, e["error"]) == (409, "own-words")
    assert path.read_text(encoding="utf-8") == "words: [unclosed\n"


def test_words_are_never_in_urls_logs_or_other_files(server, places, capfd):
    view = get(server, "/api/ownwords")[1]
    words = [w["word"] for w in view["words"]]
    post(server, "/api/ownwords/tick", {"word": "Grafana", "ticked": True})
    post(server, "/api/ownwords/sentence", {"word": "Grafana", "text": "Kibana er nede igen i dag."})
    post(server, "/api/ownwords/sentence", {"word": "Grafana", "text": "Vi tjekker Grafana, før vi går hjem."})
    # The actions are POSTs with a body; there is no route that takes a word in its path.
    assert request(server, "GET", "/api/ownwords/tick")[0] == 404
    assert request(server, "GET", "/api/ownwords/sentence")[0] == 404
    out, err = capfd.readouterr()
    for w in words + ["nede igen"]:
        assert w not in out and w not in err
    # Nothing but his own two files holds a word: not the work folder, not Værkstedet's files.
    for root, _, files in os.walk(places.work):
        for name in files:
            with open(os.path.join(root, name), "rb") as f:
                data = f.read()
            assert not any(w.encode() in data for w in ("Grafana", "Terraform", "Kibana")), name
    assert sorted(p.name for p in places.local.iterdir()) == ["own-words.yaml", "sentences.csv"]
