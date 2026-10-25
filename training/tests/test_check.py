"""wt-train check: the latest session across recordings/ and pilot/, its levels, every kind of
problem with its sentence ids, the match through the (fake) app, the 25-line limit, --json,
--no-transcribe and the exit codes. Synthetic takes only; the app is always the fake."""

from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

import fake_app
from wt_train import app as app_module
from wt_train import check, paths

RATE = 16000
SID_A, SID_B, SID_C = "aaaa1111bbbb2222", "cccc3333dddd4444", "eeee5555ffff6666"


def speech(seconds=2.5, level=0.1, noise=0.001, lead=0.5, tail=0.5, seed=0):
    """Room noise, a burst of 'speech' (amplitude-modulated noise), room noise."""
    rng = np.random.default_rng(seed)
    n = int(RATE * seconds)
    x = rng.standard_normal(n) * noise
    a, b = int(RATE * lead), n - int(RATE * tail)
    t = np.arange(b - a) / RATE
    x[a:b] += rng.standard_normal(b - a) * level * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))
    return np.clip(x, -1, 1).astype(np.float32)


def words(seconds=2.0, level=0.1, noise=0.001, word=0.25, gap=0.1, seed=0):
    """'Words' from the first sample to the last, with short pauses between them, as a take
    whose button went down late and up early."""
    rng = np.random.default_rng(seed)
    n = int(RATE * seconds)
    x = rng.standard_normal(n) * noise
    step, w = int(RATE * (word + gap)), int(RATE * word)
    for a in range(0, n, step):
        b = min(n, a + w)
        x[a:b] += rng.standard_normal(b - a) * level
    x[-w:] += rng.standard_normal(w) * level  # the last word reaches the end
    return np.clip(x, -1, 1).astype(np.float32)


def silence(seconds=2.0, seed=0):
    return (np.random.default_rng(seed).standard_normal(int(RATE * seconds)) * 0.0005).astype(np.float32)


class Folder:
    """A recordings/ or pilot/ folder in the recorder's layout. A pilot session names its setup
    beside the condition the setup records in, with ``pilot: true``, in its log lines and in
    its takes' metadata (``recorder/session.py``)."""

    def __init__(self, root: Path, pilot: bool = False):
        self.root, self.pilot = root, pilot
        root.mkdir(parents=True, exist_ok=True)

    def _names(self, name: str, condition: str) -> dict:
        return {"condition": condition, "setup": name, "pilot": True} if self.pilot else {"condition": name}

    def _log(self, event: dict) -> None:
        with (self.root / "sessions.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(event) + "\n")

    def start(self, session, name, time, items=12, exam=False, condition="phone-whisper"):
        self._log({"event": "start", "session": session, **self._names(name, condition), "exam": exam,
                   "items": items, "time": time})

    def end(self, session, name, time, condition="phone-whisper"):
        self._log({"event": "end", "session": session, **self._names(name, condition), "exam": False,
                   "saved": 0, "time": time})

    def take(self, session, take_id, samples, *, name, text="Der er en kat i haven i dag.", style="normal",
             device_class="phone", device="iphone", microphone="iPhone Microphone",
             recorded_at="2026-10-25T10:05:00+02:00", exam=False, replaced=False):
        folder = self.root / ("exam" if exam else "") / name
        stem = take_id
        if replaced:
            folder = self.root / ".replaced" / ("exam" if exam else "") / name
            stem = f"{take_id}.20261025T080000000000Z"
        folder.mkdir(parents=True, exist_ok=True)
        sf.write(str(folder / f"{stem}.wav"), samples, RATE, subtype="PCM_16")
        (folder / f"{stem}.txt").write_text(text + "\n", encoding="utf-8")
        meta = {"schema": 1, "id": take_id, "text": text, "kind": "plain", "exam": exam, "device": device,
                "device_class": device_class, "style": style, "microphone": microphone, "session": session,
                "take": 1, "recorded_at": recorded_at, "seconds": round(len(samples) / RATE, 3),
                **self._names(name, f"{device_class}-{style}")}
        (folder / f"{stem}.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


@pytest.fixture(autouse=True)
def no_real_app(tmp_path, monkeypatch):
    """Never the owner's app: no binary unless a test installs the fake."""
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_APP_BIN", str(tmp_path / "no-app" / "walkietalkey"))
    monkeypatch.setattr(app_module, "INSTALLED_APP", tmp_path / "Applications" / "walkietalkey")
    monkeypatch.setattr(app_module, "candidates", lambda: [tmp_path / "release" / "walkietalkey",
                                                           tmp_path / "debug" / "walkietalkey",
                                                           app_module.INSTALLED_APP])


@pytest.fixture
def folders(tmp_path):
    return Folder(tmp_path / "recordings"), Folder(tmp_path / "pilot", pilot=True)


def run(capsys, folders, *args):
    rec, pilot = folders
    code = check.main([*args, "--recordings", str(rec.root), "--pilot", str(pilot.root)])
    out = capsys.readouterr()
    return code, out.out, out.err


def fake_app_hearing(tmp_path, monkeypatch, heard: dict[str, str] | None = None):
    """The fake app, hearing ``heard[take id]`` where given (else the take's own text)."""
    binary, log = fake_app.install(tmp_path, monkeypatch, batch=True)
    script = binary.read_text(encoding="utf-8")
    hook = ('def text_for(wav):\n'
            '    heard = json.loads(Path(os.environ["CHECK_HEARD"]).read_text(encoding="utf-8"))\n'
            '    if Path(wav).stem in heard:\n'
            '        return heard[Path(wav).stem]\n')
    assert "def text_for(wav):\n" in script
    binary.write_text(script.replace("def text_for(wav):\n", hook, 1), encoding="utf-8")
    (tmp_path / "heard.json").write_text(json.dumps(heard or {}), encoding="utf-8")
    monkeypatch.setenv("CHECK_HEARD", str(tmp_path / "heard.json"))
    monkeypatch.setenv("WT_APP_BIN", str(binary))
    return binary, log


# --- which session ----------------------------------------------------------------------


def test_the_latest_session_across_both_folders_is_checked(capsys, folders):
    rec, pilot = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00")
    for i in range(3):
        rec.take(SID_A, f"s000{i}", speech(seed=i), name="phone-normal")
    pilot.start(SID_B, "iphone-whisper", "2026-10-25T11:00:00+02:00", items=12)
    for i in range(2):
        pilot.take(SID_B, f"p0{i}", speech(level=0.01, noise=0.0003, seed=10 + i), name="iphone-whisper",
                   style="whisper", recorded_at="2026-10-25T11:05:00+02:00")
    pilot.end(SID_B, "iphone-whisper", "2026-10-25T11:20:00+02:00")

    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 0
    first = out.splitlines()[0]
    assert SID_B in first and "pilot setup iphone-whisper" in first and "2 takes" in first
    assert "2026-10-25 11:00 to 11:20" in first
    assert "iphone (phone)" in out and "iPhone Microphone" in out and "whisper" in out
    assert out.splitlines()[-1].startswith("verdict: OK to continue")

    # A later session in recordings/ is the latest now (times compare across time zones).
    rec.start(SID_C, "mac-normal", "2026-10-25T10:30:00+00:00")
    rec.take(SID_C, "s0100", speech(seed=20), name="mac-normal", device_class="mac", device="mac",
             microphone="MacBook Pro Microphone", recorded_at="2026-10-25T10:31:00+00:00")
    code, out, _ = run(capsys, folders, "--no-transcribe")
    first = out.splitlines()[0]
    assert SID_C in first and "condition mac-normal" in first and "1 take" in first
    assert "mac (mac)" in out and "MacBook Pro Microphone" in out


def test_session_picks_another_session_and_a_prefix_will_do(capsys, folders):
    rec, pilot = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00")
    rec.take(SID_A, "s0001", silence(), name="phone-normal")
    pilot.start(SID_B, "iphone-normal", "2026-10-25T11:00:00+02:00")
    pilot.take(SID_B, "p01", speech(), name="iphone-normal")

    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 0 and SID_B in out
    code, out, _ = run(capsys, folders, "--no-transcribe", "--session", SID_A[:6])
    assert code == 1 and SID_A in out.splitlines()[0]
    assert "s0001" in out

    code, out, err = run(capsys, folders, "--no-transcribe", "--session", "0123456789")
    assert code == 2 and "no session 0123456789" in err
    assert SID_A in err and SID_B in err  # the sessions there are


def test_a_newer_session_without_takes_is_passed_over(capsys, folders):
    rec, _ = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00")
    rec.take(SID_A, "s0001", speech(), name="phone-normal")
    rec.start(SID_B, "phone-normal", "2026-10-25T12:00:00+02:00")
    rec.end(SID_B, "phone-normal", "2026-10-25T12:01:00+02:00")
    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 0 and SID_A in out.splitlines()[0]
    assert f"newer session without takes: {SID_B}" in out


def test_replaced_takes_and_files_without_audio_are_ignored(capsys, folders):
    rec, _ = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00", exam=True)
    rec.take(SID_A, "e01", speech(seconds=4.0, seed=1), name="phone-normal", exam=True,
             text="Et langt afsnit om en kat.")
    # the earlier take of e01, silent: it was redone, so it does not count
    rec.take(SID_A, "e01", silence(), name="phone-normal", exam=True, replaced=True)
    # metadata whose WAV never landed (a crash while saving) is not a take
    (rec.root / "exam" / "phone-normal" / "e02.json").write_text(json.dumps({"session": SID_A}), encoding="utf-8")
    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 0
    assert "1 take" in out.splitlines()[0] and "exam" in out.splitlines()[0]
    assert "problems: none" in out


def test_sessions_are_found_from_the_take_metadata_when_the_log_is_missing(capsys, folders):
    rec, _ = folders
    rec.take(SID_A, "s0001", speech(), name="phone-normal", recorded_at="2026-10-25T10:00:00+02:00")
    rec.take(SID_B, "s0002", speech(seed=2), name="phone-normal", recorded_at="2026-10-25T12:00:00+02:00")
    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 0 and SID_B in out.splitlines()[0] and "condition phone-normal" in out


def test_no_session_is_a_clear_error(capsys, folders):
    code, out, err = run(capsys, folders, "--no-transcribe")
    assert code == 2 and out == ""
    assert "no recording sessions" in err and "wt-train record" in err and "wt-train pilot" in err
    code, out, _ = run(capsys, folders, "--no-transcribe", "--json")
    assert code == 2 and "no recording sessions" in json.loads(out)["error"]


def test_a_session_as_the_recorder_writes_it(capsys, folders):
    """Takes saved by the recorder's own Session (log, folders, metadata) are what check reads."""
    from fake_audio import app_take, pcm16
    from wt_train.conditions import condition
    from wt_train.recorder.session import Session
    from wt_train.sentences import Sentence

    rec, _ = folders
    items = [Sentence(f"s000{i}", f"Der er en kat nummer {i} i haven.", "plain") for i in range(1, 4)]
    s = Session(root=rec.root, condition=condition("phone-whisper"), items=items,
                texts={i.id: i.text for i in items})
    phone = {"id": "cGhvbmUtaWQtMTIzNDU2Nw", "name": "Jonathans iPhone", "platform": "ios", "online": True}
    s.hello({"app": "walkietalkey", "version": "0.2.1", "os": "mac", "phones": [phone]})
    levels = {"s0001": -40.0, "s0002": -55.0, "s0003": -40.0}  # s0002: kept, but quiet for a whisper
    for item in items:
        samples = pcm16(app_take([("silence", 0.5), ("speech", 2.0), ("silence", 0.4)], style="whisper",
                                 level_dbfs=levels[item.id], noise_dbfs=-75.0))
        answer = s.take({"prompt": item.id, "source": "phone", "session": "c2Vzc2lvbi1pZC0xMjM0NQ",
                         "microphone": "iPhone-mikrofon", "chunks": 12, "missing": 0}, samples)
        assert answer["saved"]
    s.end()

    code, out, _ = run(capsys, folders, "--no-transcribe")
    lines = out.splitlines()
    assert code == 1
    assert s.id in lines[0] and "condition phone-whisper" in lines[0] and "3 takes of the 3" in lines[0]
    assert "iphone (phone)" in out and "iPhone-mikrofon" in out and "app 0.2.1" in out
    quiet = next(x for x in lines if "too quiet for a whisper" in x)
    assert "s0002" in quiet and "s0001" not in quiet
    assert lines[-1].startswith("verdict: redo 1 take: s0002")


# --- problems ------------------------------------------------------------------------------


def normal_session_with_problems(rec: Folder) -> None:
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00", items=400)
    rec.take(SID_A, "s0001", speech(seed=1), name="phone-normal")
    rec.take(SID_A, "s0002", silence(), name="phone-normal")
    rec.take(SID_A, "s0003", words(seed=3), name="phone-normal")
    rec.take(SID_A, "s0004", speech(level=1.5, seed=4), name="phone-normal")
    rec.take(SID_A, "s0005", speech(level=0.01, noise=0.0002, seed=5), name="phone-normal")
    rec.take(SID_A, "s0006", speech(level=0.1, noise=0.03, seed=6), name="phone-normal")
    rec.take(SID_A, "s0007", speech(seconds=2.0, lead=0.5, tail=0.7, seed=7), name="phone-normal",
             text="Der er en kat og en hund og en fisk og en fugl i haven i dag.")


def test_every_problem_kind_is_found_with_its_ids(capsys, folders):
    rec, _ = folders
    normal_session_with_problems(rec)
    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 1
    lines = out.splitlines()
    assert "7 takes" in lines[0] and "400" in lines[0]

    def line(start):
        (found,) = [x for x in lines if x.strip().startswith(start)]
        return found

    assert "s0002" in line("silent")
    assert "s0003 (start and end)" in line("cut off")
    assert "s0004" in line("clipped")
    assert "s0005" in line("too quiet for a normal voice") and "-35 dBFS" in line("too quiet")
    assert "s0006" in line("noisy")
    assert "s0007" in line("short")
    assert "problems in 6 of 7 takes" in out
    # a silent take is only silent, not also quiet, noisy and cut off
    assert "s0002" not in line("too quiet") and "s0002" not in line("noisy")
    # a noisy take's speech cannot be told from the noise at the edges: not called cut off
    assert "s0006" not in line("cut off")
    assert "s0001" not in out
    verdict = lines[-1]
    assert verdict.startswith("verdict: redo 6 takes:")
    for sid in ("s0002", "s0003", "s0004", "s0005", "s0006", "s0007"):
        assert sid in verdict
    assert "match: not checked" in out and "audio only" in verdict


def test_the_style_sets_the_limits_a_whisper_is_quiet_by_nature(capsys, folders):
    _, pilot = folders
    pilot.start(SID_B, "iphone-whisper", "2026-10-25T11:00:00+02:00")
    common = dict(name="iphone-whisper", style="whisper")
    pilot.take(SID_B, "p01", speech(level=0.01, noise=0.0003, seed=1), **common)    # about -40: a whisper
    pilot.take(SID_B, "p02", speech(level=0.0015, noise=0.0001, seed=2), **common)  # about -56: too quiet
    pilot.take(SID_B, "p03", speech(level=0.1, seed=3), **common)                   # a normal voice
    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 1
    quiet = next(x for x in out.splitlines() if "too quiet" in x)
    loud = next(x for x in out.splitlines() if "too loud" in x)
    assert "for a whisper" in quiet and "-50 dBFS" in quiet and "p02" in quiet and "p01" not in quiet
    assert "for a whisper" in loud and "p03" in loud and "p01" not in loud
    assert "p01" not in out.splitlines()[-1]


def test_a_problem_in_most_takes_points_at_the_setup(capsys, folders):
    rec, _ = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00")
    for i in range(5):
        rec.take(SID_A, f"s000{i}", speech(level=0.01, noise=0.0002, seed=i), name="phone-normal")
    rec.take(SID_A, "s0009", speech(seed=9), name="phone-normal")
    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 1
    verdict = out.splitlines()[-1]
    assert verdict.startswith("verdict: fix the setup") and "5 of 6 takes" in verdict
    assert "too quiet" in verdict and "closer" in verdict


def test_many_problems_still_fit_in_25_lines(capsys, folders):
    rec, _ = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00", items=400)
    makers = [lambda s: silence(seconds=1.2, seed=s),
              lambda s: speech(seconds=1.2, level=1.5, lead=0.3, tail=0.3, seed=s),
              lambda s: speech(seconds=1.2, level=0.01, noise=0.0002, lead=0.3, tail=0.3, seed=s),
              lambda s: words(seconds=1.2, seed=s)]
    for i in range(120):
        rec.take(SID_A, f"s{i:04d}", makers[i % 4](i), name="phone-normal", text="Der er en kat.")
    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 1
    lines = out.splitlines()
    assert len(lines) <= check.MAX_LINES
    shown = set(re.findall(r"s\d{4}", out))
    assert 0 < len(shown) < 60
    assert re.search(r"silent \(no speech found\), 30 takes: s\d{4}.* and \d+ more", out)
    assert lines[-1].startswith("verdict: redo 120 takes:") and "more" in lines[-1]

    code, out, _ = run(capsys, folders, "--no-transcribe", "--json")
    report = json.loads(out)
    assert code == 1 and len(report["redo"]) == 120 and len(report["problems"]["silent"]) == 30


# --- the match through the app ----------------------------------------------------------------


def test_takes_that_do_not_match_their_sentence_are_flagged(tmp_path, monkeypatch, capsys, folders):
    rec, _ = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00")
    texts = {"s0001": "Der er en kat i haven i dag.", "s0002": "Der er en hund i haven i dag.",
             "s0003": "Der er en fisk i haven i dag.", "s0004": "Der er en fugl i haven i dag.",
             "s0005": "Vi skal deploy'e den i dag."}
    for i, (sid, text) in enumerate(texts.items()):
        rec.take(SID_A, sid, speech(seed=i), name="phone-normal", text=text)
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text("terms:\n  deploy:\n    forms: [deploye]\n    also:\n      deploy'e: deploye\n",
                        encoding="utf-8")
    _, log = fake_app_hearing(tmp_path, monkeypatch, {
        "s0002": "Det regner meget i København.",  # another sentence
        "s0003": "",                               # nothing heard
        "s0004": "Der er en hest i haven i dag.",  # one word wrong: a slip, not a mismatch
        "s0005": "vi skal deploye den i dag",      # the reference is re-spelled like the training data
    })
    code, out, _ = run(capsys, folders, "--spelling", str(spelling))
    assert code == 1
    mismatch = next(x for x in out.splitlines() if x.strip().startswith("not matching"))
    assert "s0002 (WER 88 %)" in mismatch and "s0003 (nothing heard)" in mismatch
    assert "s0004" not in mismatch and "s0005" not in mismatch and "s0001" not in mismatch
    assert "match (base Edda through the app)" in out
    assert 'heard "Det regner meget i København."' in out
    # one batch, with the shipped Edda
    calls = [json.loads(x) for x in log.read_text().splitlines()]
    batches = [c for c in calls if "--transcribe-list" in c]
    assert len(batches) == 1 and batches[0][batches[0].index("--model") + 1] == paths.SHIPPED_EDDA_ID
    verdict = out.splitlines()[-1]
    assert verdict.startswith("verdict: redo 2 takes:") and "audio only" not in verdict

    code, out, _ = run(capsys, folders, "--json", "--spelling", str(spelling))
    report = json.loads(out)
    by_id = {t["id"]: t for t in report["takes"]}
    assert by_id["s0005"]["wer"] == 0.0 and by_id["s0004"]["wer"] == pytest.approx(1 / 8)
    assert by_id["s0003"]["transcript"] == "" and "mismatch" in by_id["s0003"]["problems"]
    assert report["transcription"]["ran"] and report["transcription"]["model"] == paths.SHIPPED_EDDA_ID


def test_clean_takes_through_the_app_are_ok(tmp_path, monkeypatch, capsys, folders):
    rec, _ = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00")
    for i in range(3):
        rec.take(SID_A, f"s000{i}", speech(seed=i), name="phone-normal")
    fake_app_hearing(tmp_path, monkeypatch)
    code, out, _ = run(capsys, folders)
    assert code == 0
    assert "WER 0.0 % over 3 takes" in out
    assert out.splitlines()[-1] == "verdict: OK to continue"


def test_no_transcribe_never_runs_the_app(tmp_path, monkeypatch, capsys, folders):
    rec, _ = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00")
    rec.take(SID_A, "s0001", speech(), name="phone-normal")
    _, log = fake_app_hearing(tmp_path, monkeypatch)
    code, out, _ = run(capsys, folders, "--no-transcribe")
    assert code == 0 and not log.exists()
    assert "match: not checked (--no-transcribe)" in out
    assert out.splitlines()[-1] == "verdict: OK to continue (audio only; the match check did not run)"


def test_without_an_app_the_audio_is_still_checked(capsys, folders):
    rec, _ = folders
    rec.start(SID_A, "phone-normal", "2026-10-25T10:00:00+02:00")
    rec.take(SID_A, "s0001", speech(), name="phone-normal")
    code, out, _ = run(capsys, folders)
    assert code == 0
    assert "match: not checked (no WalkieTalkey binary at" in out
    assert "audio only" in out.splitlines()[-1]


def test_the_installed_app_comes_before_repository_builds(tmp_path, monkeypatch):
    monkeypatch.delenv("WT_APP_BIN")
    with pytest.raises(FileNotFoundError):
        check.pick_app()
    for name in ("debug", "Applications"):
        (tmp_path / name).mkdir()
    built, _ = fake_app.install(tmp_path / "debug", monkeypatch, batch=True)
    assert check.pick_app().bin == built
    installed, _ = fake_app.install(tmp_path / "Applications", monkeypatch, batch=True)
    assert check.pick_app().bin == installed
    # an installed app too old for the batch interface gives way to a build that has it
    script = installed.read_text(encoding="utf-8")
    assert 'batch = os.environ.get("FAKE_APP_BATCH") == "1"' in script
    installed.write_text(script.replace('batch = os.environ.get("FAKE_APP_BATCH") == "1"', "batch = False"),
                         encoding="utf-8")
    assert check.pick_app().bin == built
    # WT_APP_BIN, and --app-bin over it, choose outright
    monkeypatch.setenv("WT_APP_BIN", str(installed))
    assert check.pick_app().bin == installed
    assert check.pick_app(built).bin == built


# --- output ------------------------------------------------------------------------------------


def test_json_has_the_full_details(capsys, folders):
    rec, _ = folders
    normal_session_with_problems(rec)
    code, out, _ = run(capsys, folders, "--no-transcribe", "--json")
    assert code == 1
    report = json.loads(out)
    assert report["session"]["id"] == SID_A and report["session"]["name"] == "phone-normal"
    assert report["session"]["pilot"] is False and report["session"]["items"] == 400
    assert len(report["takes"]) == 7
    take = next(t for t in report["takes"] if t["id"] == "s0005")
    assert take["problems"] == ["quiet"] and take["style"] == "normal" and take["device_class"] == "phone"
    assert {"level_dbfs", "noise_dbfs", "snr_db", "peak_dbfs", "clipped_samples", "seconds"} <= set(take["stats"])
    assert take["wav"].endswith("phone-normal/s0005.wav")
    assert report["problems"]["silent"] == ["s0002"]
    assert report["redo"] == ["s0002", "s0003", "s0004", "s0005", "s0006", "s0007"]
    assert report["transcription"] == {"ran": False, "reason": "--no-transcribe"}
    assert report["verdict"].startswith("redo 6 takes") and report["exit_code"] == 1
    assert set(report["summary"]) >= {"level_dbfs", "noise_dbfs", "snr_db", "seconds"}


def test_the_summary_is_plain_text_with_rounded_numbers(capsys, folders):
    rec, _ = folders
    normal_session_with_problems(rec)
    _, out, _ = run(capsys, folders, "--no-transcribe")
    assert "\x1b" not in out and not re.search(r"[─-╿—]", out)  # no colours, boxes, em dashes
    level = next(x for x in out.splitlines() if x.startswith("speech level"))
    assert re.search(r"median -\d+ dBFS", level) and not re.search(r"-\d+\.\d+ dBFS", level)
    assert all(len(x) <= 160 for x in out.splitlines())

