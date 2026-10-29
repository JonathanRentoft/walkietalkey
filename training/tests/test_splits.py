"""The split record (run 12): every term measured, the kinds in proportion, takes frozen, held-out
terms in test only, the lock closing test, the owner's own sentences never in test."""

from __future__ import annotations

from collections import Counter

import pytest

from conftest import write_wav
from wt_train import paths, plan, splits
from wt_train.config import ConfigError, load_config
from wt_train.sentences import Sentence, load_sentences
from wt_train.spelling import Spelling, Term, load_spelling

P = splits.Params(seed=1, validation_fraction=0.1, test_fraction=0.1)


def term_names(n: int) -> list[str]:
    return [f"term{chr(97 + i // 26)}{chr(97 + i % 26)}" for i in range(n)]


def corpus(n_terms: int = 30, plain: int = 120, uses=lambda i: 6 + i % 10, extra: dict[str, int] | None = None,
           start: int = 0) -> tuple[list[Sentence], Spelling]:
    """Terms sentences (every fourth holds a second term) and plain ones; ``extra`` adds terms
    with exactly that many sentences."""
    names = term_names(n_terms)
    counts = {t: uses(i) for i, t in enumerate(names)} | dict(extra or {})
    out, n = [], start
    for i, (t, k) in enumerate(counts.items()):
        for j in range(k):
            other = names[(i + 7) % len(names)] if names and j % 4 == 3 and t in names else None
            text = f"Sætning {n} handler om {t}" + (f" og {other}" if other and other != t else "") + "."
            out.append(Sentence(f"s{n:04d}", text, "terms"))
            n += 1
    for _ in range(plain):
        out.append(Sentence(f"s{n:04d}", f"Almindelig sætning nummer {n} uden fagord.", "plain"))
        n += 1
    return out, Spelling([Term(t, (t,)) for t in counts])


def by_split(assignment: dict[str, str]) -> Counter:
    return Counter(assignment.values())


def kind_counts(assignment: dict[str, str], sentences: list[Sentence]) -> Counter:
    return Counter((assignment[s.id], s.kind) for s in sentences)


# --- dealing ------------------------------------------------------------------------------


def test_every_term_gets_two_test_and_one_validation_sentence():
    sentences, spelling = corpus()
    assignment, warnings = splits.deal(sentences, spelling, P)
    assert set(assignment) == {s.id for s in sentences} and set(assignment.values()) == set(splits.SPLITS)
    coverage = splits.coverage(assignment, sentences, spelling)
    assert set(coverage) == {t.name for t in spelling.terms}
    for term, c in coverage.items():
        assert c["test"] >= 2 and c["validation"] >= 1 and c["train"] >= 1, (term, c)
    assert warnings == []


def test_the_kinds_keep_their_shares_and_the_fractions_are_targets():
    sentences, spelling = corpus()
    assignment, _ = splits.deal(sentences, spelling, P)
    n = len(sentences)
    counts = kind_counts(assignment, sentences)
    share = sum(s.kind == "terms" for s in sentences) / n
    sizes = by_split(assignment)
    for split, fraction in (("test", P.test_fraction), ("validation", P.validation_fraction)):
        # Coverage may push a split above its fraction, never below; the kinds hold their share.
        assert sizes[split] >= round(fraction * n)
        assert abs(counts[(split, "terms")] - share * sizes[split]) <= 1, (split, counts)
    assert sizes["test"] <= 0.2 * n  # "a little above"
    # Without terms to cover, the fractions hold to a sentence.
    plain_only = [s for s in sentences if s.kind == "plain"]
    sizes = by_split(splits.deal(plain_only, Spelling([]), P)[0])
    assert sizes["test"] == round(0.1 * len(plain_only)) == sizes["validation"]


def test_a_term_with_too_few_sentences_gets_what_it_can_and_a_warning():
    sentences, spelling = corpus(n_terms=10, extra={"rarethree": 3, "rareone": 1})
    assignment, warnings = splits.deal(sentences, spelling, P)
    coverage = splits.coverage(assignment, sentences, spelling)
    # Test first, and never a term's last sentence that training could have.
    assert coverage["rarethree"] == {"train": 1, "validation": 0, "test": 2}
    assert coverage["rareone"] == {"train": 1, "validation": 0, "test": 0}
    assert len(warnings) == 2
    assert any("rarethree" in w and "3 sentence" in w for w in warnings)
    assert any("rareone" in w for w in warnings)
    assert all("termaa" not in w for w in warnings)


def test_the_deal_is_deterministic_and_follows_the_seed():
    sentences, spelling = corpus()
    a, _ = splits.deal(sentences, spelling, P)
    assert splits.deal(list(reversed(sentences)), spelling, P)[0] == a
    assert splits.deal(sentences, spelling, splits.Params(seed=2))[0] != a


def test_the_same_sentence_written_twice_is_one_sentence():
    sentences, spelling = corpus(n_terms=4, plain=40)
    twin = Sentence("s9999", sentences[-1].text.upper().replace(".", "!"), "plain")
    assignment, _ = splits.deal(sentences + [twin], spelling, P)
    assert assignment["s9999"] == assignment[sentences[-1].id]


def test_held_out_terms_go_to_test_only():
    sentences, spelling = corpus()
    held = splits.Params(seed=1, held_out_terms=("termab", "termac"))
    assignment, _ = splits.deal(sentences, spelling, held)
    terms = splits.terms_of(sentences, spelling)
    with_held = [s.id for s in sentences if terms[s.id] & {"termab", "termac"}]
    assert with_held and all(assignment[sid] == "test" for sid in with_held)
    # The rest of test keeps the kinds' shares; the held-out sentences come on top.
    rest = [s for s in sentences if s.id not in with_held]
    counts = kind_counts(assignment, rest)
    n_test = counts[("test", "terms")] + counts[("test", "plain")]
    share = sum(s.kind == "terms" for s in rest) / len(rest)
    assert abs(counts[("test", "terms")] - share * n_test) <= 1
    coverage = splits.coverage(assignment, sentences, spelling)
    assert all(c["test"] >= 2 and c["validation"] >= 1 for t, c in coverage.items() if t not in held.held_out_terms)


def test_a_held_out_term_must_be_a_term_of_the_spelling(tmp_path):
    sentences, spelling = corpus(n_terms=3, plain=10)
    with pytest.raises(ConfigError, match=r"data.held_out_terms: 'kafka' is not a term"):
        splits.ensure(sentences, spelling, tmp_path / "splits.csv", splits.Params(held_out_terms=("kafka",)))
    assert not (tmp_path / "splits.csv").exists()


# --- the record -----------------------------------------------------------------------------


def test_the_record_and_its_parameters_round_trip(tmp_path):
    sentences, spelling = corpus(n_terms=5, plain=20)
    path = tmp_path / "splits.csv"
    params = splits.Params(seed=4, validation_fraction=0.15, test_fraction=0.2, held_out_terms=("termab",))
    dealt = splits.ensure(sentences, spelling, path, params)
    assert dealt.written and path.read_text(encoding="utf-8").splitlines()[0] == "id,split"
    assert splits.read_record(path) == (dealt.assignment, params)
    text = (tmp_path / "split.yaml").read_text(encoding="utf-8")
    assert "seed: 4" in text and "held_out_terms:\n- termab" in text and text.startswith("# ")
    # Nothing changed: nothing written.
    again = splits.ensure(sentences, spelling, path)
    assert not again.written and again.assignment == dealt.assignment and again.params == params
    path.write_text("id,split\ns0001,tset\n", encoding="utf-8")
    with pytest.raises(ValueError, match="tset"):
        splits.read_record(path)


def test_a_take_freezes_a_sentence_across_list_and_parameter_changes(tmp_path):
    sentences, spelling = corpus()
    path = tmp_path / "splits.csv"
    first = splits.ensure(sentences, spelling, path, P).assignment
    taken = set()
    for split in splits.SPLITS:
        taken |= set(sorted(sid for sid, s in first.items() if s == split)[:3])
    removed = [s for s in sentences if s.id not in taken][:5]
    grown, _ = corpus(n_terms=0, plain=10, start=5000)
    listed = [s for s in sentences if s not in removed] + grown
    other = splits.Params(seed=7, validation_fraction=0.2, test_fraction=0.15)
    second = splits.ensure(listed, spelling, path, other, taken=taken)
    assert all(second.assignment[sid] == first[sid] for sid in taken)
    assert not {s.id for s in removed} & set(second.assignment)
    assert set(second.removed) == {s.id for s in removed} and set(second.added) == {s.id for s in grown}
    assert second.previous == P and second.params == other
    assert second.moved == {sid: (first[sid], to) for sid, to in second.assignment.items()
                            if sid in first and first[sid] != to}
    assert second.moved and not set(second.moved) & taken
    # The sentences without a take are dealt as if afresh, around the frozen ones.
    assert second.assignment == splits.deal(listed, spelling, other, given={sid: first[sid] for sid in taken})[0]
    assert splits.read_record(path) == (second.assignment, other)
    assert any("moved" in line for line in second.describe())


def test_new_sentences_fill_the_gaps_and_the_rest_stays(tmp_path):
    sentences, spelling = corpus()
    path = tmp_path / "splits.csv"
    first = splits.ensure(sentences, spelling, path, P).assignment
    # A new term with its own sentences, and more plain ones.
    more, more_spelling = corpus(n_terms=0, plain=20, extra={"nyterm": 8}, start=6000)
    both = Spelling(list(spelling.terms) + list(more_spelling.terms))
    second = splits.ensure(sentences + more, both, path)
    assert {sid: second.assignment[sid] for sid in first} == first and second.moved == {}
    coverage = splits.coverage(second.assignment, sentences + more, both)["nyterm"]
    assert coverage["test"] >= 2 and coverage["validation"] >= 1
    # A deal again on purpose may move the sentences without a take.
    third = splits.ensure(sentences + more, both, path, redeal=True)
    assert third.assignment == splits.deal(sentences + more, both, P)[0]


def test_taken_counts_every_take_current_or_replaced(tmp_path):
    rec = tmp_path / "recordings"
    write_wav(rec / "phone-whisper" / "s0001.wav", seed=1)
    write_wav(rec / ".replaced" / "mac-normal" / "s0002.20261028T101010000000Z.wav", seed=2)
    write_wav(rec / "s0003.wav", seed=3)  # run 4's browser take
    write_wav(rec / ".replaced" / "s0004.20261028T101010000000Z-2.wav", seed=4)
    write_wav(rec / "exam" / "phone-normal" / "s0005.wav", seed=5)  # the exam is not a sentence
    (rec / "phone-normal").mkdir(parents=True)
    (rec / "phone-normal" / "s0006.txt").write_text("no audio\n", encoding="utf-8")
    write_wav(rec / "mac-whisper" / "s0099.wav", seed=6)  # not in the list
    ids = [f"s{i:04d}" for i in range(1, 8)]
    assert splits.taken(rec, ids) == {"s0001", "s0002", "s0003", "s0004"}
    assert splits.taken(tmp_path / "none", ids) == set()


def test_after_the_lock_test_holds_the_locked_sentences_only(tmp_path):
    sentences, spelling = corpus()
    path = tmp_path / "splits.csv"
    first = splits.ensure(sentences, spelling, path, P).assignment
    test = sorted(sid for sid, s in first.items() if s == "test")
    locked = set(test[:6])
    # One test sentence got a take after the lock was written: it was not frozen with it.
    late = test[6]
    added, _ = corpus(n_terms=0, plain=30, start=7000)
    second = splits.ensure(sentences + added, spelling, path, taken=locked | {late}, locked=locked)
    assert {sid for sid, s in second.assignment.items() if s == "test"} == locked
    assert second.assignment[late] != "test"
    assert all(second.assignment[s.id] in ("train", "validation") for s in added)
    assert second.locked and any("locked" in w for w in second.warnings)
    # Other parameters cannot move a locked sentence either.
    third = splits.ensure(sentences + added, spelling, path, splits.Params(seed=9, test_fraction=0.3),
                          taken=locked, locked=locked)
    assert {sid for sid, s in third.assignment.items() if s == "test"} == locked


def test_the_owners_own_sentences_go_to_train_or_validation_only(tmp_path):
    own = [Sentence(f"own-{i:04d}", f"Min egen sætning nummer {i}.", "plain" if i % 2 else "terms")
           for i in range(1, 41)]
    dealt = splits.ensure(own, Spelling([]), tmp_path / "local" / "splits.csv", P, local=True)
    sizes = by_split(dealt.assignment)
    assert sizes["test"] == 0 and sizes["validation"] == round(0.1 * len(own))
    assert (tmp_path / "local" / "split.yaml").is_file()


# --- the plan follows the record ---------------------------------------------------------------


def test_moved_sentences_are_dealt_a_condition_again_and_the_mix_holds_per_split(tmp_path):
    sentences, spelling = corpus(n_terms=40, plain=300)
    path = tmp_path / "plan.csv"
    record = splits.ensure(sentences, spelling, splits.record_path(path), P)
    first, _ = plan.ensure(sentences, path, splits=record.assignment)
    other = splits.ensure(sentences, spelling, splits.record_path(path), splits.Params(seed=5))
    second, changes = plan.ensure(sentences, path, splits=other.assignment, moved=set(other.moved))
    assert changes["moved"] <= len(other.moved)
    assert all(second[sid] == first[sid] for sid in first if sid not in other.moved)
    counts: dict[str, Counter] = {}
    for s in sentences:
        counts.setdefault(other.assignment[s.id], Counter())[second[s.id]] += 1
    for split, c in counts.items():
        n = sum(c.values())
        for cid, share in (("phone-whisper", 0.4), ("phone-normal", 0.4), ("mac-normal", 0.2)):
            assert abs(c[cid] - share * n) <= 3, (split, c)


def test_wt_train_plan_deals_the_record_with_a_configs_parameters(tmp_path, capsys):
    sentences, spelling = corpus(n_terms=8, plain=40)
    csv_path, spelling_path = tmp_path / "sentences.csv", tmp_path / "spelling.yaml"
    csv_path.write_text("id,text,kind\n" + "".join(f'{s.id},"{s.text}",{s.kind}\n' for s in sentences),
                        encoding="utf-8")
    spelling_path.write_text("terms:\n" + "".join(f"  {t.name}:\n    forms: [{t.name}]\n" for t in spelling.terms),
                             encoding="utf-8")
    config = tmp_path / "c.yaml"
    config.write_text("name: c\ndata:\n  seed: 3\n  validation_fraction: 0.2\n  test_fraction: 0.2\n"
                      "  held_out_terms: [termab]\n", encoding="utf-8")
    rec = tmp_path / "recordings"
    args = ["--sentences", str(csv_path), "--plan", str(tmp_path / "plan.csv"), "--spelling", str(spelling_path),
            "--recordings", str(rec)]
    assert plan.main(args + ["--config", str(config)]) == 0
    out = capsys.readouterr().out
    record, params = splits.read_record(tmp_path / "splits.csv")
    assert params == splits.Params(seed=3, validation_fraction=0.2, test_fraction=0.2, held_out_terms=("termab",))
    assert "split record" in out and "seed 3" in out and "test" in out
    assert set(plan.read_plan(tmp_path / "plan.csv")) == set(record)
    # A take freezes its sentence; the record's parameters stay until another config comes.
    sid = next(s for s, split in sorted(record.items()) if split == "train")
    write_wav(rec / "phone-normal" / f"{sid}.wav", seed=1)
    assert plan.main(args) == 0 and splits.read_record(tmp_path / "splits.csv")[1] == params
    assert plan.main(args + ["--redeal", "--config", str(paths.CONFIGS / "first-frozen-encoder.yaml")]) == 0
    out = capsys.readouterr().out
    after, params = splits.read_record(tmp_path / "splits.csv")
    assert after[sid] == "train" and params == splits.Params()
    assert "moved" in out


# --- the committed record ----------------------------------------------------------------------


def test_the_committed_record_is_current_and_measures_every_term():
    # training/data/splits.csv and split.yaml come from `wt-train plan --redeal` with the shipped
    # configs' split parameters; this fails when sentences.csv or spelling.yaml changed since.
    record, params = splits.read_record(paths.SPLITS_CSV)
    for name in ("first-frozen-encoder", "top4-encoder"):
        assert splits.Params.of(load_config(paths.CONFIGS / f"{name}.yaml").data) == params
    sentences, spelling = load_sentences(paths.SENTENCES_CSV), load_spelling(paths.SPELLING_YAML)
    dealt = splits.ensure(sentences, spelling, paths.SPLITS_CSV, write=False)
    assert dealt.assignment == record and not dealt.moved and not dealt.added and not dealt.removed
    assert dealt.assignment == splits.deal(sentences, spelling, params)[0], "run: wt-train plan --redeal"
    assert dealt.warnings == []
    coverage = splits.coverage(record, sentences, spelling)
    assert all(c["test"] >= 2 and c["validation"] >= 1 for c in coverage.values())
