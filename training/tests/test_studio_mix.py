"""Run 12, the mix in Værkstedet: the shares of the four conditions, a preview that writes
nothing, dealing again exactly as ``wt-train plan --mix`` does, and the time each condition
takes at the owner's own pace (the pilot's medians until his takes say otherwise).

Every test works on temporary copies of the committed sentence list, plan and mix: the
committed mix.yaml never changes."""

import dataclasses
import json
import shutil
from datetime import datetime, timedelta

import pytest

from fake_studio import get, post, start_server, stop_server, write_places
from wt_train import paths, plan
from wt_train.sentences import load_sentences
from wt_train.studio import mix

T0 = datetime(2026, 10, 28, 10, 0, 0).astimezone()


def at(seconds: float) -> str:
    return (T0 + timedelta(seconds=seconds)).isoformat(timespec="seconds")


# --- the pace --------------------------------------------------------------------------------


def test_the_pace_is_the_median_gap_inside_a_session_without_breaks():
    takes = [{"condition": "phone-whisper", "session": "a", "recorded_at": at(s)} for s in (0, 6, 12, 100, 106)]
    takes += [{"condition": "phone-whisper", "session": "b", "recorded_at": at(s)} for s in (1000, 1010, 1020)]
    # Two sessions interleaved in time stay apart; a take without a time or a session is left out.
    takes += [{"condition": "mac-normal", "session": "c", "recorded_at": at(s)} for s in (3, 9)]
    takes += [{"condition": "mac-normal", "session": "c", "recorded_at": None},
              {"condition": "mac-normal", "session": None, "recorded_at": at(4)}]
    gaps = mix.gaps(takes)
    assert sorted(gaps["phone-whisper"]) == [6, 6, 6, 10, 10]
    assert gaps["mac-normal"] == [6]
    p = mix.pace(takes)
    assert p["phone-whisper"] == {"seconds": 6.0, "source": "takes", "gaps": 5}
    # Too few gaps of his own: the pilot's measured medians.
    assert p["mac-normal"] == {"seconds": 8.0, "source": "pilot", "gaps": 1}
    assert p["phone-normal"] == {"seconds": 11.0, "source": "pilot", "gaps": 0}
    assert p["mac-whisper"] == {"seconds": 5.0, "source": "pilot", "gaps": 0}


def write_take(folder, item, meta):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{item}.wav").write_bytes(b"RIFF")
    (folder / f"{item}.json").write_text(json.dumps(meta), encoding="utf-8")


def test_the_takes_of_the_pilot_and_the_recordings_both_count(tmp_path):
    rec, pilot = tmp_path / "recordings", tmp_path / "pilot"
    for n in range(6):
        write_take(rec / "phone-normal", f"s000{n}", {"session": "r1", "recorded_at": at(n * 9)})
        write_take(pilot / "iphone-whisper", f"pilot-0{n}", {"condition": "phone-whisper", "session": "p1",
                                                             "recorded_at": at(n * 7)})
    # The exam's paragraphs are not sentences; a metadata file without its take is not a take.
    write_take(rec / "exam" / "phone-normal", "e01", {"session": "r1", "recorded_at": at(500)})
    (rec / "phone-normal" / "s0099.json").write_text(json.dumps({"session": "r1", "recorded_at": at(50)}))
    p = mix.pace(mix.take_times(rec, pilot))
    assert p["phone-normal"] == {"seconds": 9.0, "source": "takes", "gaps": 5}
    assert p["phone-whisper"] == {"seconds": 7.0, "source": "takes", "gaps": 5}


# --- the screen ------------------------------------------------------------------------------


@pytest.fixture
def places(tmp_path, monkeypatch):
    """The committed sentence list, plan and mix, copied: the studio deals on the copies."""
    p = write_places(tmp_path, monkeypatch)
    data = tmp_path / "committed"
    data.mkdir()
    for name in ("sentences.csv", "plan.csv", "mix.yaml"):
        shutil.copyfile(paths.DATA / name, data / name)
    return dataclasses.replace(p, sentences=data / "sentences.csv", plan=data / "plan.csv")


def record_some(places, n=30):
    """Takes of the first ``n`` sentences planned in phone-whisper and mac-normal (each in its
    own condition), so dealing again keeps them where they are."""
    sentences = {s.id: s.text for s in load_sentences(places.sentences)}
    planned = plan.read_plan(places.plan)
    kept = {}
    for cid in ("phone-whisper", "mac-normal"):
        ids = sorted(sid for sid, c in planned.items() if c == cid)[:n]
        for i, sid in enumerate(ids):
            folder = places.recordings / cid
            write_take(folder, sid, {"session": f"{cid}-1", "recorded_at": at(i * 10)})
            (folder / f"{sid}.txt").write_text(sentences[sid] + "\n", encoding="utf-8")
            kept[sid] = cid
    return kept


@pytest.fixture
def server(places):
    srv = start_server(places)
    yield srv
    stop_server(srv)


def test_the_mix_its_sentences_and_the_time_each_condition_takes(server, places):
    record_some(places)
    status, v = get(server, "/api/mix")
    assert status == 200
    assert v["mix"] == plan.read_mix(paths.MIX_YAML) and v["recording"] is False
    rows = {r["id"]: r for r in v["conditions"]}
    assert list(rows) == ["phone-whisper", "phone-normal", "mac-normal", "mac-whisper"]
    assert v["sentences"] == len(load_sentences(places.sentences)) == sum(r["planned"] for r in rows.values())
    pw = rows["phone-whisper"]
    assert pw["label"] == "Telefonen, hvisket" and pw["done"] == 30 and pw["left"] == pw["planned"] - 30
    # Thirty takes ten seconds apart: his own pace, 10 s, for the sentences left.
    assert pw["pace"] == {"seconds": 10.0, "source": "takes", "gaps": 29}
    assert pw["minutes"] == round(pw["left"] * 10 / 60, 1)
    pn = rows["phone-normal"]
    assert pn["pace"]["source"] == "pilot" and pn["minutes"] == round(pn["planned"] * 11 / 60, 1)
    assert v["minutes"] == round(sum(r["minutes"] for r in rows.values()), 1)


def test_a_preview_shows_what_moves_and_writes_nothing(server, places):
    kept = record_some(places)
    before = {p: p.read_bytes() for p in (places.plan, plan.mix_path(places.plan))}
    new = {"phone-whisper": 30, "phone-normal": 30, "mac-normal": 20, "mac-whisper": 20}
    status, v = post(server, "/api/mix/preview", {"mix": new})
    assert status == 200 and v["changed"] is True and v["mix"] == new
    assert {p: p.read_bytes() for p in before} == before
    rows = {r["id"]: r for r in v["conditions"]}
    assert rows["mac-whisper"]["planned"] > 0 and rows["mac-whisper"]["done"] == 0
    assert rows["phone-whisper"]["done"] == 30  # the recorded ones stay where they are
    assert v["moved"]["total"] == sum(p["n"] for p in v["moved"]["pairs"]) > 0
    assert all(p["from"] != p["to"] for p in v["moved"]["pairs"])
    assert {p["to"] for p in v["moved"]["pairs"]} >= {"mac-whisper"}
    # The same mix as now moves nothing.
    same = post(server, "/api/mix/preview", {"mix": plan.read_mix(places.plan.with_name("mix.yaml"))})[1]
    assert same["changed"] is False and same["moved"] == {"total": 0, "pairs": []}
    assert len(kept) == 60


def test_dealing_again_is_exactly_wt_train_plan_mix(server, places, tmp_path):
    record_some(places)
    cli = tmp_path / "cli"
    cli.mkdir()
    for name in ("plan.csv", "mix.yaml"):
        shutil.copyfile(places.plan.with_name(name), cli / name)
    new = {"phone-whisper": 30, "phone-normal": 30, "mac-normal": 20, "mac-whisper": 20}
    preview = post(server, "/api/mix/preview", {"mix": new})[1]
    status, dealt = post(server, "/api/mix/deal", {"mix": new})
    assert status == 200
    assert plan.main(["--sentences", str(places.sentences), "--plan", str(cli / "plan.csv"), "--recordings",
                      str(places.recordings), "--mix", ",".join(f"{k}={v}" for k, v in new.items())]) == 0
    assert places.plan.read_bytes() == (cli / "plan.csv").read_bytes()
    assert plan.mix_path(places.plan).read_bytes() == (cli / "mix.yaml").read_bytes()
    assert dealt["moved"] == preview["moved"] and dealt["conditions"] == preview["conditions"]
    assert dealt["mix"] == new and get(server, "/api/mix")[1]["mix"] == new
    # The recording screen follows the new mix at once.
    shares = {c["id"]: c["share"] for c in get(server, "/api/recording/options")[1]["conditions"]}
    assert shares == new
    # The committed mix is untouched.
    assert plan.read_mix(paths.MIX_YAML) != new


def test_dealing_waits_until_no_recording_is_picked(server, places):
    new = {"phone-whisper": 50, "phone-normal": 30, "mac-normal": 20, "mac-whisper": 0}
    assert post(server, "/api/recording/start", {"kind": "condition", "id": "phone-whisper"})[0] == 200
    assert get(server, "/api/mix")[1]["recording"] is True
    before = places.plan.read_bytes()
    status, e = post(server, "/api/mix/deal", {"mix": new})
    assert (status, e["error"]) == (409, "recording") and places.plan.read_bytes() == before
    post(server, "/api/recording/pause")
    assert post(server, "/api/mix/deal", {"mix": new})[1]["error"] == "recording"
    post(server, "/api/recording/stop")
    assert post(server, "/api/mix/deal", {"mix": new})[0] == 200


@pytest.mark.parametrize("bad", [None, [], {"phone-whisper": 50}, {"phone-whisper": 50.5, "phone-normal": 49.5},
                                 {"phone-whisper": "40", "phone-normal": 60}, {"phone-whisper": True, "mac-normal": 99},
                                 {"tablet": 10, "phone-whisper": 90}, {"phone-whisper": 120, "mac-normal": -20}])
def test_a_mix_is_whole_percents_that_add_up_to_100(server, bad):
    for route in ("/api/mix/preview", "/api/mix/deal"):
        status, e = post(server, route, {"mix": bad})
        assert (status, e["error"]) == (400, "mix")
