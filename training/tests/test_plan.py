"""The session plan: one condition per sentence, the mix (40/40/20/0 by default, or what
``wt-train plan --mix`` sets) within every split."""

from __future__ import annotations

from collections import Counter

import pytest

from wt_train import plan
from wt_train.conditions import DEFAULT_MIX, IDS
from wt_train.dataset import sentence_key, split_of
from wt_train.paths import MIX_YAML, PLAN_CSV, SENTENCES_CSV
from wt_train.sentences import Sentence, load_sentences


def sentences(n: int, start: int = 0) -> list[Sentence]:
    return [Sentence(id=f"s{i:04d}", text=f"Sætning nummer {i} om {'deploy' if i % 3 else 'katten'}.",
                     kind="terms" if i % 3 else "plain") for i in range(start, start + n)]


def split(s: Sentence) -> str:
    return split_of(sentence_key(s.text), **plan.REFERENCE_SPLIT)


# The conditions the default mix deals to.
DEALT = [cid for cid in IDS if DEFAULT_MIX[cid] > 0]


def share(cid: str, mix_: dict[str, int] = DEFAULT_MIX) -> float:
    return mix_[cid] / 100


def mix(assigned: dict[str, str], items: list[Sentence]) -> dict[str, Counter]:
    out: dict[str, Counter] = {}
    for s in items:
        out.setdefault(split(s), Counter())[assigned[s.id]] += 1
    return out


def test_every_sentence_gets_one_condition_and_the_mix_holds_in_every_split():
    items = sentences(1000)
    assigned = plan.assign(items)
    assert set(assigned) == {s.id for s in items}
    assert set(assigned.values()) == set(DEALT) == {"phone-whisper", "phone-normal", "mac-normal"}
    by_split = mix(assigned, items)
    assert set(by_split) == {"train", "validation", "test"}
    for name, counts in by_split.items():
        n = sum(counts.values())
        for cid in IDS:
            # Within each split and kind the deal is exact to one sentence; two kinds: two.
            assert abs(counts[cid] - share(cid) * n) <= 2, (name, cid, counts)


def test_both_kinds_are_spread_over_the_conditions():
    items = sentences(600)
    assigned = plan.assign(items)
    for kind in ("terms", "plain"):
        group = [s for s in items if s.kind == kind]
        counts = Counter(assigned[s.id] for s in group)
        for cid in IDS:
            assert abs(counts[cid] - share(cid) * len(group)) <= 3, (kind, counts)


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
            assert abs(counts[cid] - share(cid) * n) <= 3


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
    assert changes == {"added": 5, "removed": 0, "moved": 0}
    assert {k: current[k] for k in before} == before
    assert plan.read_plan(path) == current
    assert plan.ensure(sentences(45), path)[1] == {"added": 0, "removed": 0, "moved": 0}


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
    committed = plan.read_mix(MIX_YAML)
    assert plan.mix_path(PLAN_CSV) == MIX_YAML and MIX_YAML.is_file()
    for name, counts in mix(assigned, items).items():
        n = sum(counts.values())
        for cid in IDS:
            assert abs(counts[cid] - share(cid, committed) * n) <= 2, (name, cid, counts)


# --- the mix (run 7) ---------------------------------------------------------------------


def test_the_default_mix_is_40_40_20_and_mac_whisper_none():
    assert DEFAULT_MIX == {"phone-whisper": 40, "phone-normal": 40, "mac-normal": 20, "mac-whisper": 0}
    # The committed mix is the default, so nothing changed for the owner unless he chose it.
    assert plan.read_mix(MIX_YAML) == DEFAULT_MIX


def test_the_mix_parser():
    assert plan.parse_mix("phone-whisper=40,phone-normal=40,mac-normal=20") == DEFAULT_MIX
    assert plan.parse_mix(" mac-whisper = 50, mac-normal=50 ,") == {
        "phone-whisper": 0, "phone-normal": 0, "mac-normal": 50, "mac-whisper": 50}
    assert plan.parse_mix("phone-normal=100")["phone-normal"] == 100


@pytest.mark.parametrize("text, message", [
    ("phone-whisper=40,phone-normal=40", "add up to 80 %"),
    ("phone-whisper=60,phone-normal=60", "add up to 120 %"),
    ("phone-loud=100", "unknown condition 'phone-loud'"),
    ("phone-normal=50,phone-normal=50", "given twice"),
    ("phone-normal=50.5,mac-normal=49.5", "whole percent"),
    ("phone-normal=-10,mac-normal=110", "whole percent"),
    ("phone-normal", "<condition>=<percent>"),
    ("", "add up to 0 %"),
])
def test_the_mix_parser_refuses(text, message):
    with pytest.raises(ValueError, match=message):
        plan.parse_mix(text)


def test_the_mix_file_round_trip_and_refusals(tmp_path):
    path = tmp_path / "mix.yaml"
    assert plan.read_mix(path) == DEFAULT_MIX  # none yet: the default
    m = plan.parse_mix("phone-whisper=30,phone-normal=30,mac-normal=20,mac-whisper=20")
    plan.write_mix(path, m)
    assert plan.read_mix(path) == m
    assert path.read_text(encoding="utf-8").startswith("# The recording mix")
    path.write_text("mix:\n  phone-normal: 100\n", encoding="utf-8")
    assert plan.read_mix(path)["phone-whisper"] == 0  # a condition left out gets 0
    for body, message in [("mix:\n  phone-normal: 90\n", "add up to 90"), ("mix:\n  phone-loud: 100\n", "phone-loud"),
                          ("share: 1\n", "expected only 'mix'"), ("mix:\n  phone-normal: true\n", "whole percent")]:
        path.write_text(body, encoding="utf-8")
        with pytest.raises(ValueError, match=message):
            plan.read_mix(path)


def test_a_mix_deals_only_to_conditions_with_a_share_and_holds_in_every_split():
    items = sentences(1000)
    m = plan.parse_mix("phone-whisper=30,phone-normal=30,mac-normal=20,mac-whisper=20")
    assigned = plan.assign(items, mix=m)
    assert set(assigned.values()) == set(IDS)
    for name, counts in mix(assigned, items).items():
        n = sum(counts.values())
        for cid in IDS:
            assert abs(counts[cid] - share(cid, m) * n) <= 2, (name, cid, counts)
    only_two = plan.assign(items, mix=plan.parse_mix("phone-whisper=50,mac-whisper=50"))
    assert set(only_two.values()) == {"phone-whisper", "mac-whisper"}


def test_the_mix_is_kept_next_to_the_plan(tmp_path):
    path = tmp_path / "plan.csv"
    plan.ensure(sentences(30), path)
    assert plan.mix_path(path) == tmp_path / "mix.yaml"
    assert plan.read_mix(tmp_path / "mix.yaml") == DEFAULT_MIX
    m = plan.parse_mix("phone-normal=50,mac-whisper=50")
    plan.ensure(sentences(30), path, mix=m)
    assert plan.read_mix(tmp_path / "mix.yaml") == m
    # Without --mix, the plan follows the mix kept beside it.
    _, changes = plan.ensure(sentences(40), path)
    assert changes["added"] == 10 and changes["moved"] == 0
    assert set(plan.read_plan(path).values()) <= {"phone-normal", "mac-whisper"}


def test_a_new_mix_keeps_recorded_sentences_and_deals_the_rest_again(tmp_path):
    path = tmp_path / "plan.csv"
    items = sentences(600)
    before, _ = plan.ensure(items, path)
    # Some sentences have a take in their planned condition; one has a take only elsewhere.
    by_condition = {cid: [sid for sid, c in sorted(before.items()) if c == cid] for cid in IDS}
    recorded = {"phone-whisper": set(by_condition["phone-whisper"][:50]),
                "mac-normal": set(by_condition["mac-normal"][:20]),
                "phone-normal": {by_condition["mac-normal"][-1]}}
    m = plan.parse_mix("phone-whisper=20,phone-normal=40,mac-normal=10,mac-whisper=30")
    after, changes = plan.ensure(items, path, mix=m, recorded=recorded)
    kept = recorded["phone-whisper"] | recorded["mac-normal"]
    assert all(after[sid] == before[sid] for sid in kept)
    assert changes["added"] == changes["removed"] == 0
    assert changes["moved"] == sum(1 for sid in after if after[sid] != before[sid]) > 0
    assert plan.read_plan(path) == after and plan.read_mix(plan.mix_path(path)) == m
    # The unrecorded sentences were dealt so that each split fits the new mix.
    for name, counts in mix(after, items).items():
        n = sum(counts.values())
        for cid in IDS:
            assert abs(counts[cid] - share(cid, m) * n) <= 0.03 * n + 2, (name, cid, counts)
    # The same mix again changes nothing, and re-planning with it keeps every sentence.
    again, changes = plan.ensure(items, path, mix=m, recorded={})
    assert again == after and changes["moved"] == 0


def test_a_new_mix_without_takes_deals_everything_again(tmp_path):
    path = tmp_path / "plan.csv"
    items = sentences(300)
    plan.ensure(items, path)
    m = plan.parse_mix("phone-normal=50,mac-whisper=50")
    after, _ = plan.ensure(items, path, mix=m, recorded={})
    assert after == plan.assign(items, mix=m)


def test_wt_train_plan_mix_on_the_command_line(tmp_path, capsys):
    from conftest import write_wav

    csv_path = tmp_path / "sentences.csv"
    rows = sentences(60)
    csv_path.write_text("id,text,kind\n" + "".join(f'{s.id},"{s.text}",{s.kind}\n' for s in rows),
                        encoding="utf-8")
    plan_path, rec = tmp_path / "plan.csv", tmp_path / "recordings"
    assert plan.main(["--sentences", str(csv_path), "--plan", str(plan_path), "--recordings", str(rec)]) == 0
    first = plan.read_plan(plan_path)
    # One take, in its planned condition: it keeps that condition whatever the new mix says.
    sid = next(s for s, c in sorted(first.items()) if c == "phone-whisper")
    write_wav(rec / "phone-whisper" / f"{sid}.wav", seed=1)
    text = next(s.text for s in rows if s.id == sid)
    (rec / "phone-whisper" / f"{sid}.txt").write_text(text + "\n", encoding="utf-8")
    capsys.readouterr()
    assert plan.main(["--sentences", str(csv_path), "--plan", str(plan_path), "--recordings", str(rec),
                      "--mix", "phone-normal=50,mac-whisper=50"]) == 0
    out = capsys.readouterr().out
    after = plan.read_plan(plan_path)
    assert after[sid] == "phone-whisper"
    assert set(after.values()) == {"phone-whisper", "phone-normal", "mac-whisper"}
    assert "mix " in out and "phone-normal 50 %, mac-whisper 50 %" in out and "mac-whisper" in out.splitlines()[2]
    with pytest.raises(SystemExit):
        plan.main(["--sentences", str(csv_path), "--plan", str(plan_path), "--mix", "phone-normal=90"])
    assert "add up to 90 %" in capsys.readouterr().err
