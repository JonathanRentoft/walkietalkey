"""The sentence list loader checks its header, ids and kinds."""

import pytest

from wt_train.sentences import load_sentences, word_count


def write(tmp_path, body: str):
    path = tmp_path / "sentences.csv"
    path.write_text(body, encoding="utf-8")
    return path


def test_reads_rows(tmp_path):
    rows = load_sentences(write(tmp_path, 'id,text,kind\ns0001,"Vi merger PR\'en, når testene er grønne.",terms\n'))
    assert rows[0].id == "s0001" and rows[0].kind == "terms"
    assert word_count(rows[0].text) == 7


@pytest.mark.parametrize(
    "body, message",
    [
        ("id,sentence,kind\n", "header"),
        ("id,text,kind\na,Hej med dig,plain\na,Hej igen,plain\n", "duplicate"),
        ("id,text,kind\na,Hej med dig,english\n", "kind"),
    ],
)
def test_rejects_bad_files(tmp_path, body, message):
    with pytest.raises(ValueError, match=message):
        load_sentences(write(tmp_path, body))
