"""``wt-train pilot report`` (run 7): every setup scored with the shipped Edda through the app,
its audio measured, one self-contained page, and an MLflow run of kind ``pilot``. Run 11: the
page and the setups' notes are in Danish."""

import json
import os
from pathlib import Path

import numpy as np
import pytest

import fake_app
from fake_audio import app_take, pcm16
from wt_train import app as app_module
from wt_train import audiostats, paths, pilot, tracking
from wt_train.metrics import edit_distance
from wt_train.harness import normalize
from wt_train.recorder.takes import TakeStore, log_session
from wt_train.sentences import Sentence

ROWS = [
    Sentence("pilot-01", "Vi deployer den nye feature i dag.", "terms"),
    Sentence("pilot-02", "Mødet er flyttet til torsdag.", "plain"),
    Sentence("pilot-03", "Tak for et godt møde i går.", "plain"),
]
SPELLING = "terms:\n  deploy:\n    forms: [deploye, deployer, deployede]\n  feature:\n    forms: [feature, featuren]\n"
# What the stand-in model wrote, per setup and sentence; what is not here it got right.
WROTE = {
    "iphone-whisper/pilot-01": "Vi deployede den nye featuren i dag.",
    "iphone-whisper/pilot-03": "Tak for godt møde i går.",
}
# How each setup sounds: (style, speech level, room noise).
SOUND = {"iphone-whisper": ("whisper", -40.0, -60.0), "mac-normal": ("normal", -20.0, -72.0),
         "studio": ("normal", -2.0, -75.0)}


class StandIn:
    """A transcriber that writes WROTE, else the take's own text."""

    def __init__(self):
        self.calls = []

    def transcribe(self, wavs, progress=None):
        self.calls.append(list(wavs))
        out = []
        for w in wavs:
            w = Path(w)
            out.append((WROTE.get(f"{w.parent.name}/{w.stem}") or w.with_suffix(".txt").read_text().strip(), None))
        return out


def record(tmp_path) -> tuple[Path, Path, Path]:
    """Takes of the three sentences in three setups; a fourth setup started but with no take."""
    root = tmp_path / "pilot"
    texts = {s.id: s.text for s in ROWS}
    for setup, (style, level, noise) in SOUND.items():
        s = pilot.parse_setup(setup)
        store = TakeStore(root, s.condition.id, texts, setup=setup)
        for i, row in enumerate(ROWS):
            x = app_take([("silence", 0.4), ("speech", 1.6 + 0.2 * i), ("silence", 0.4)], style=style,
                         noise_dbfs=noise, level_dbfs=level)
            problems = ["clipped"] if setup == "studio" else []
            store.save(row.id, pcm16(x), {"id": row.id, "setup": setup, "pilot": True, "style": style,
                                          "microphone": {"studio": "Shure MV7"}.get(setup, "iPhone-mikrofon"),
                                          "checks": {"check": problems[0] if problems else "ok",
                                                     "problems": problems}})
    log_session(root, {"event": "start", "setup": "airpods-normal", "pilot": True})
    csv_path = tmp_path / "pilot.csv"
    csv_path.write_text("id,text,kind\n" + "".join(f'{s.id},"{s.text}",{s.kind}\n' for s in ROWS), encoding="utf-8")
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text(SPELLING, encoding="utf-8")
    return root, csv_path, spelling


def run(tmp_path, *extra, transcriber=None):
    root, csv_path, spelling = record(tmp_path)
    argv = ["--pilot-dir", str(root), "--sentences", str(csv_path), "--spelling", str(spelling), "--no-open", *extra]
    return pilot.report_main(argv, transcriber=transcriber or StandIn(), log=print)


def test_the_numbers_per_setup(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    stand_in = StandIn()
    report = run(tmp_path, transcriber=stand_in)
    assert report["exit_code"] == 0
    # One call for every setup's takes: the model loads once.
    assert len(stand_in.calls) == 1 and len(stand_in.calls[0]) == 9
    assert list(report["setups"]) == ["iphone-whisper", "mac-normal", "studio"]
    assert report["skipped"] == ["airpods-normal"]
    whisper = report["setups"]["iphone-whisper"]["scores"]
    # Two substitutions (deployer, feature) and a deletion (et) of 7 + 5 + 7 reference words.
    assert whisper["n"] == 3 and whisper["reference_words"] == 19
    assert whisper["wer"] == pytest.approx(3 / 19)
    chars = [(normalize(r), normalize(h)) for r, h in [
        (ROWS[0].text, WROTE["iphone-whisper/pilot-01"]), (ROWS[1].text, ROWS[1].text),
        (ROWS[2].text, WROTE["iphone-whisper/pilot-03"])]]
    assert whisper["cer"] == pytest.approx(sum(edit_distance(r, h) for r, h in chars) / sum(len(r) for r, _ in chars))
    # Both terms said in another form: none strict, both lenient.
    assert (whisper["terms"], whisper["terms_strict"], whisper["terms_lenient"]) == (2, 0, 2)
    for name in ("mac-normal", "studio"):
        s = report["setups"][name]["scores"]
        assert s["wer"] == 0 and s["cer"] == 0 and s["term_accuracy_strict"] == 1.0
    assert report["setups"]["iphone-whisper"]["condition"] == "phone-whisper"
    assert report["setups"]["studio"]["microphones"] == ["Shure MV7"]


def test_the_audio_numbers_per_setup(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    report = run(tmp_path)
    root = tmp_path / "pilot"
    for name in SOUND:
        expected = audiostats.summarize([audiostats.measure(w) for w in sorted((root / name).glob("*.wav"))])
        assert report["setups"][name]["audio"] == expected
    w, m, s = (report["setups"][n]["audio"] for n in ("iphone-whisper", "mac-normal", "studio"))
    # The whisper is about 20 dB quieter than the normal voice; the rooms as recorded.
    assert -46 < w["level_dbfs"] < -34 and -26 < m["level_dbfs"] < -14
    assert w["noise_dbfs"] == pytest.approx(-60, abs=3) and m["noise_dbfs"] == pytest.approx(-72, abs=3)
    assert m["snr_db"] > w["snr_db"] + 20
    assert w["clipped_clips"] == m["clipped_clips"] == 0 and s["clipped_clips"] == 3
    assert s["peak_dbfs"] == pytest.approx(0.0, abs=0.1)
    assert w["seconds"] == pytest.approx(3 * 0.8 + 1.6 + 1.8 + 2.0, abs=0.01)
    notes = report["setups"]["studio"]["notes"]
    assert "forvrænget i 3 af 3 klip" in notes and "optageren markerede 3 forvrængede" in notes
    assert report["setups"]["mac-normal"]["notes"] == []


def test_a_quiet_setup_is_named_with_the_recorders_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    SOUND["mac-quiet"] = ("normal", -42.0, -70.0)
    try:
        report = run(tmp_path)
    finally:
        del SOUND["mac-quiet"]
    assert any(n.startswith("svag: talen ligger på") and "under optagerens \u221235 dBFS for almindelig stemme" in n
               for n in report["setups"]["mac-quiet"]["notes"])
    # A whisper at -40 dBFS is not quiet for a whisper (its limit is -50 dBFS).
    assert not any(n.startswith("svag") for n in report["setups"]["iphone-whisper"]["notes"])


def test_the_page(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    report = run(tmp_path)
    page = report["page"]
    assert page.parent == paths.reports_dir() and page.name.startswith("pilot-") and page.suffix == ".html"
    html = page.read_text(encoding="utf-8")
    assert '<html lang="da">' in html and "<title>Piloten: opsætningerne sammenlignet</title>" in html
    # Each setup by its Danish name, as Værkstedet shows it, with the setup's own name beside it.
    for name, label in (("iphone-whisper", "iPhone, hvisket"), ("mac-normal", "Mac&#x27;en, almindelig stemme"),
                        ("studio", "Studiemikrofon, almindelig stemme")):
        assert f'<b style="white-space:nowrap">{label}</b>' in html and f"<h3>{label}</h3>" in html
        assert f"<code>{name}</code>" in html
    assert "Ingen optagelser endnu, så sprunget over: airpods-normal." in html
    for header in ("WER", "CER", "Fagord rigtige", "Taleniveau", "Top", "Støjgulv", "SNR", "Forvrænget", "Længde"):
        assert f">{header}</th>" in html
    assert "15,79 %" in html  # iphone-whisper's WER
    assert "0 af 2 (i enhver form 2)" in html and "telefonen, hvisket" in html
    # Every clip with its player (embedded, self-contained) and its diff.
    assert html.count("<audio controls") == 9 and html.count('src="data:audio/') == 9
    assert '<del class="w sub">deployer</del><ins class="w sub">deployede</ins>' in html
    assert '<del class="w del">et</del>' in html
    assert "Shure MV7" in html and "forvrænget i 3 af 3 klip" in html and "Edda skrev" in html
    assert "http://" not in html and "https://" not in html


def test_the_mlflow_run(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_TRACKING", "1")
    report = run(tmp_path)
    (got,) = tracking.find_runs(kind="pilot")
    assert got.info.run_id == report["run_id"] and got.info.status == "FINISHED"
    assert got.info.run_name == report["page"].stem
    assert got.data.tags["wt.change"] == "data"
    assert got.data.tags["wt.pilot"] == "iphone-whisper,mac-normal,studio"
    m = got.data.metrics
    assert m["iphone-whisper/wer"] == pytest.approx(3 / 19) and m["mac-normal/wer"] == 0
    assert m["iphone-whisper/term_accuracy_strict"] == 0 and m["iphone-whisper/term_accuracy_lenient"] == 1
    assert m["studio/clipped_clips"] == 3
    assert m["mac-normal/level_dbfs"] == report["setups"]["mac-normal"]["audio"]["level_dbfs"]
    assert m["iphone-whisper/snr_db"] == report["setups"]["iphone-whisper"]["audio"]["snr_db"]
    assert json.loads(got.data.params["setups"]) == ["iphone-whisper", "mac-normal", "studio"]
    assert json.loads(got.data.params["skipped"]) == ["airpods-normal"]
    c, _ = tracking.client()
    files = {a.path for a in c.list_artifacts(got.info.run_id)}
    assert {report["page"].name, "pilot.json"} <= files


def test_only_the_named_setups_and_none_without_takes(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    report = run(tmp_path, "--setups", "mac-normal,airpods-normal")
    assert list(report["setups"]) == ["mac-normal"] and report["skipped"] == ["airpods-normal"]
    assert "airpods-normal: no takes yet, skipped" in capsys.readouterr().out
    # No takes at all: no page, and the app is never started.
    monkeypatch.setenv("WT_APP_BIN", str(tmp_path / "no-such-app"))
    empty = pilot.report_main(["--pilot-dir", str(tmp_path / "none"), "--sentences", str(tmp_path / "pilot.csv"),
                               "--no-open"], log=print)
    assert empty["exit_code"] == 1 and empty["page"] is None
    assert "wt-train pilot record --setup" in capsys.readouterr().out
    assert pilot.main(["report", "--pilot-dir", str(tmp_path / "none"), "--sentences", str(tmp_path / "pilot.csv"),
                       "--no-open"]) == 1
    with pytest.raises(SystemExit):
        run(tmp_path, "--setups", "Mac Normal")


def test_through_the_app_in_one_batch_with_the_shipped_edda(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    binary, log = fake_app.install(tmp_path, monkeypatch, batch=True)
    monkeypatch.setenv("WT_APP_BIN", str(binary))
    root, csv_path, spelling = record(tmp_path)
    out = tmp_path / "page.html"
    opened = []
    monkeypatch.setattr("webbrowser.open", lambda url: opened.append(url))
    code = pilot.main(["report", "--pilot-dir", str(root), "--sentences", str(csv_path), "--spelling", str(spelling),
                       "--out", str(out)])
    assert code == 0 and out.is_file()
    assert opened == [out.resolve().as_uri()]
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    batches = [c for c in calls if "--transcribe-list" in c]
    assert len(batches) == 1 and batches[0][batches[0].index("--model") + 1] == paths.SHIPPED_EDDA_ID
    assert not any("--training-session" in c or "--use-model" in c for c in calls)
    # The fake app writes each take's own text: no errors anywhere.
    html = out.read_text(encoding="utf-8")
    assert html.count("<audio controls") == 9 and str(binary) in html


def test_the_installed_app_comes_first_for_the_pilot(tmp_path, monkeypatch):
    monkeypatch.delenv("WT_APP_BIN", raising=False)
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    installed, release, debug = (tmp_path / n for n in ("installed", "release", "debug"))
    for p in (installed, release, debug):
        p.write_text(binary.read_text())
        os.chmod(p, 0o755)
    monkeypatch.setattr(app_module, "INSTALLED_APP", installed)
    monkeypatch.setattr(app_module, "candidates", lambda: [release, debug, installed])
    # wt-train eval keeps preferring the repository's builds; the pilot (and wt-train check) the
    # app the owner records with.
    assert app_module.find_app().bin == release
    assert app_module.find_app(prefer_installed=True).bin == installed
    # An installed app without the batch interface is passed over for a build that has it.
    installed.write_text("#!/bin/sh\necho 'Usage: walkietalkey [OPTIONS]'\n")
    assert app_module.find_app(prefer_installed=True).bin == release
    # --app-bin / WT_APP_BIN still win.
    assert app_module.find_app(debug, prefer_installed=True).bin == debug
    monkeypatch.setenv("WT_APP_BIN", str(debug))
    assert app_module.find_app(prefer_installed=True).bin == debug


def test_takes_are_scored_against_the_text_as_read(tmp_path, monkeypatch):
    """A pilot sentence edited after it was read: the take is scored against what was read."""
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    root, csv_path, spelling = record(tmp_path)
    clips = pilot.pilot_clips(root, "mac-normal", {"pilot-02": "plain"})
    assert [c.id for c in clips] == ["pilot-01", "pilot-02", "pilot-03"]
    assert clips[1].reference == ROWS[1].text and clips[1].kind == "plain"
    assert clips[0].meta["setup"] == "mac-normal" and np.isfinite(audiostats.measure(clips[0].wav).level_dbfs)


def test_json_out_keeps_the_comparison_for_vaerkstedet(tmp_path, monkeypatch):
    # Run 9: Værkstedet runs the report as a job and reads the comparison from this file.
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    out = tmp_path / "studio" / "pilot-comparison.json"
    report = run(tmp_path, "--json-out", str(out))
    saved = json.loads(out.read_text(encoding="utf-8"))
    assert saved["page"] == str(report["page"]) and saved["model"] == paths.SHIPPED_EDDA_ID
    assert saved["generated_at"] and saved["skipped"] == ["airpods-normal"]
    assert saved["setups"] == json.loads(json.dumps(report["setups"]))
    assert "rows" not in saved


def test_a_take_marked_for_a_new_take_is_not_scored(tmp_path, monkeypatch):
    # Run 9: Værkstedet's "Tag om" (or its checks) writes review.status = redo; the pilot leaves
    # such a take out, as the dataset builder does, with the same reason.
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    root, csv_path, spelling = record(tmp_path)
    store = TakeStore(root, "phone-whisper", {s.id: s.text for s in ROWS}, setup="iphone-whisper")
    store.update_meta("pilot-01", {"review": {"status": "redo", "by": "owner"}})
    stand_in = StandIn()
    argv = ["--pilot-dir", str(root), "--sentences", str(csv_path), "--spelling", str(spelling), "--no-open"]
    report = pilot.report_main(argv, transcriber=stand_in, log=print)
    assert report["setups"]["iphone-whisper"]["scores"]["n"] == 2
    assert all(Path(w).stem != "pilot-01" or Path(w).parent.name != "iphone-whisper" for w in stand_in.calls[0])
    assert report["left_out"] == [{"id": "pilot-01.iphone-whisper", "reason": "marked for a new take"}]
    from wt_train.dataset import REDO_REASON

    assert REDO_REASON == "marked for a new take"
