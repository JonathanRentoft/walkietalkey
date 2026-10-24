"""The session plan: one condition per sentence, 40/40/20 within every split."""

from __future__ import annotations

from collections import Counter

import pytest

from wt_train import plan
from wt_train.conditions import BY_ID, IDS
from wt_train.dataset import sentence_key, split_of
from wt_train.paths import PLAN_CSV, SENTENCES_CSV
from wt_train.sentences import Sentence, load_sentences


def sentences(n: int, start: int = 0) -> list[Sentence]:
    return [Sentence(id=f"s{i:04d}", text=f"Sætning nummer {i} om {'deploy' if i % 3 else 'katten'}.",
                     kind="terms" if i % 3 else "plain") for i in range(start, start + n)]


def split(s: Sentence) -> str:
    return split_of(sentence_key(s.text), **plan.REFERENCE_SPLIT)


def mix(assigned: dict[str, str], items: list[Sentence]) -> dict[str, Counter]:
    out: dict[str, Counter] = {}
    for s in items:
        out.setdefault(split(s), Counter())[assigned[s.id]] += 1
    return out


def test_every_sentence_gets_one_condition_and_the_mix_holds_in_every_split():
    items = sentences(1000)
    assigned = plan.assign(items)
    assert set(assigned) == {s.id for s in items}
    assert set(assigned.values()) == set(IDS)
    by_split = mix(assigned, items)
    assert set(by_split) == {"train", "validation", "test"}
    for name, counts in by_split.items():
        n = sum(counts.values())
        for cid in IDS:
            # Within each split and kind the deal is exact to one sentence; two kinds: two.
            assert abs(counts[cid] - BY_ID[cid].share * n) <= 2, (name, cid, counts)


def test_both_kinds_are_spread_over_the_conditions():
    items = sentences(600)
    assigned = plan.assign(items)
    for kind in ("terms", "plain"):
        group = [s for s in items if s.kind == kind]
        counts = Counter(assigned[s.id] for s in group)
        for cid in IDS:
            assert abs(counts[cid] - BY_ID[cid].share * len(group)) <= 3, (kind, counts)


def test_a_sentence_keeps_its_condition_when_sentences_are_added_or_removed():
    first = plan.assign(sentences(300))
    grown = plan.assign(sentences(360), existing=first)
    assert {k: grown[k] for k in first} == first
    shrunk = plan.assign(sentences(200), existing=grown)
    assert set(shrunk) == {f"s{i:04d}" for i in range(200)}
    assert all(shrunk[k] == first[k] for k in shrunk)
    # The added sentences fill the gaps: the mix still holds.
    for counts in mix(grown, sentences(360)).values():
        n = sum(counts.values())
        for cid in IDS:
            assert abs(counts[cid] - BY_ID[cid].share * n) <= 3


def test_the_plan_is_deterministic():
    items = sentences(120)
    assert plan.assign(items) == plan.assign(list(reversed(items)))


def test_plan_file_round_trip_and_unknown_conditions(tmp_path):
    path = tmp_path / "plan.csv"
    assigned = plan.assign(sentences(30))
    plan.write_plan(path, assigned)
    assert path.read_text(encoding="utf-8").splitlines()[0] == "id,condition"
    assert plan.read_plan(path) == assigned
    path.write_text("id,condition\ns0001,phone-loud\n", encoding="utf-8")
    with pytest.raises(ValueError, match="phone-loud"):
        plan.read_plan(path)


def test_ensure_extends_the_plan_file_for_new_sentences(tmp_path):
    path = tmp_path / "plan.csv"
    plan.write_plan(path, plan.assign(sentences(40)))
    before = plan.read_plan(path)
    current, changes = plan.ensure(sentences(45), path)
    assert changes == {"added": 5, "removed": 0}
    assert {k: current[k] for k in before} == before
    assert plan.read_plan(path) == current
    assert plan.ensure(sentences(45), path)[1] == {"added": 0, "removed": 0}


def test_progress_counts_per_condition():
    items = sentences(10)
    assigned = plan.assign(items)
    recorded = {cid: set() for cid in IDS}
    first = next(s.id for s in items if assigned[s.id] == "phone-whisper")
    recorded["phone-whisper"].add(first)
    # A take in a condition the plan did not give the sentence is counted as extra.
    other = next(s.id for s in items if assigned[s.id] == "mac-normal")
    recorded["phone-whisper"].add(other)
    p = plan.progress(assigned, recorded)
    assert p["phone-whisper"]["done"] == 1
    assert p["phone-whisper"]["extra"] == 1
    assert p["phone-whisper"]["total"] == sum(1 for v in assigned.values() if v == "phone-whisper")
    assert sum(p[c]["total"] for c in IDS) == 10


def test_the_committed_plan_covers_the_sentence_list_with_the_mix():
    # training/data/plan.csv is made by `wt-train plan` and committed, so a sentence keeps its
    # condition (and its recordings stay planned) when the list grows.
    items = load_sentences(SENTENCES_CSV)
    assigned = plan.read_plan(PLAN_CSV)
    assert set(assigned) == {s.id for s in items}
    for name, counts in mix(assigned, items).items():
        n = sum(counts.values())
        for cid in IDS:
            assert abs(counts[cid] - BY_ID[cid].share * n) <= 2, (name, cid, counts)
