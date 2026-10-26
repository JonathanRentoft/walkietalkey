"""``wt-train pilot``: try the recording setups for a few minutes before the real recordings.

Twelve sentences (``training/data/pilot.csv``: six of plain Danish, six with English
developer terms in spelling.yaml's forms) are read once per recording setup, so a
poor microphone, a noisy room or a whisper too quiet for the model shows after
minutes, not after hours of recording.

``wt-train pilot record --setup <name>``
    records the twelve in one setup through the app, with the recorder
    (``wt_train/recorder/``: its page, the app's API, the checks). The name is the
    owner's own, lower-case letters, digits and ``-`` (``iphone-whisper``,
    ``mac-normal``, ``airpods-normal``, ``studio``), and it says how to record:

    * a name starting with ``iphone``, ``phone`` or ``android`` records on the phone,
      through its pairing; any other name on the Mac's own input (pick the
      microphone, AirPods or a studio mic, in the app first);
    * a name containing ``whisper`` is whispered, with the recorder's whisper limits
      (``recorder/checks.py``); any other is read in a normal voice.

    Takes go to ``training/data/pilot/<setup>/<id>.wav|txt|json`` (git-ignored),
    earlier takes to ``pilot/.replaced/<setup>/`` and the session log to
    ``pilot/sessions.jsonl``. Each take's metadata names the device, the microphone,
    the style, the setup and ``pilot: true``. The app sees an ordinary session (the
    hello answer is a device and a style), so it needs nothing new.

``wt-train pilot report``
    transcribes every setup's takes with the shipped Edda through the app (its
    batch pipeline, headless, in a process of its own; the installed app first) and
    writes one self-contained HTML page: a table of the setups (WER, CER, term
    accuracy, speech level, peak, noise floor in the pauses, SNR, clipped clips,
    length), then every clip of each setup with its audio and a word diff. The page
    goes to ``<work>/reports/pilot-<date>.html``, opens in the browser (``--no-open``:
    not; run 9: ``--json-out <file>`` also keeps the numbers per setup as JSON, for
    Værkstedet), and is logged
    to MLflow as a run of kind ``pilot`` (``wt.change`` ``data``, tag ``wt.pilot``)
    with the numbers per setup (``iphone-whisper/wer``). A setup without takes is
    skipped with a note.

Pilot takes are never trained on: the dataset builder never reads ``pilot/``, and its
leakage check refuses any pilot sentence, take or file in a split (``dataset.py``).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import webbrowser
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from . import audiostats, console, paths, per_condition, tracking
from .align import align
from .audio import file_sha256
from .conditions import Condition, condition, condition_id
from .htmlpage import LEGEND, Raw, audio_tag, cards, db, diff_html, esc, page, pct, table
from .metrics import summarize
from .recorder.checks import LIMITS
from .recorder.takes import SAFE_SETUP, SESSIONS_LOG, TakeStore
from .sentences import Sentence, load_sentences

PHONE_PREFIXES = ("iphone", "phone", "android")
WHISPER = "whisper"


# --- setups --------------------------------------------------------------------------


@dataclass(frozen=True)
class Setup:
    """A recording setup the owner names: where it records (phone or mac) and how (style)."""

    name: str
    device: str
    style: str

    @property
    def condition(self) -> Condition:
        return condition(condition_id(self.device, self.style))

    def describe(self) -> str:
        where = "the phone" if self.device == "phone" else "the Mac's input"
        return f"{where}, {'whispered' if self.style == WHISPER else 'normal voice'}"


def parse_setup(name: str) -> Setup:
    """The setup of a name: the phone for ``iphone*``, ``phone*`` and ``android*``, else the
    Mac; whispered when the name holds ``whisper``. Names are lower-case letters, digits and
    ``-``, so they are safe as folder names."""
    if not isinstance(name, str) or not SAFE_SETUP.fullmatch(name):
        hint = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")[:40]
        example = f"; for example {hint}" if hint and SAFE_SETUP.fullmatch(hint) else ""
        raise ValueError(f"setup name {name!r}: use lower-case letters, digits and '-' (at most 40 characters, "
                         f"starting and ending with a letter or digit){example}")
    device = "phone" if name.startswith(PHONE_PREFIXES) else "mac"
    return Setup(name=name, device=device, style=WHISPER if WHISPER in name else "normal")


def load_pilot(path: Path = paths.PILOT_CSV) -> list[Sentence]:
    """The pilot sentences (``id,text,kind``, like sentences.csv)."""
    return load_sentences(path)


def known_setups(root: Path = paths.PILOT) -> list[str]:
    """The setups with a folder of takes or a session in the log, sorted."""
    root = Path(root)
    names: set[str] = set()
    if root.is_dir():
        names |= {p.name for p in root.iterdir() if p.is_dir() and SAFE_SETUP.fullmatch(p.name)}
    log = root / SESSIONS_LOG
    if log.is_file():
        for line in log.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            setup = event.get("setup") if isinstance(event, dict) else None
            if isinstance(setup, str) and SAFE_SETUP.fullmatch(setup):
                names.add(setup)
    return sorted(names)


def store(root: Path, setup: Setup, sentences: list[Sentence]) -> TakeStore:
    return TakeStore(root, setup.condition.id, {s.id: s.text for s in sentences}, setup=setup.name)


# --- wt-train pilot record --------------------------------------------------------------


def record(argv: list[str]) -> int:
    p = argparse.ArgumentParser(
        prog="wt-train pilot record",
        description="Read the twelve pilot sentences in one recording setup, through the WalkieTalkey app. A setup "
                    "named iphone..., phone... or android... records on the phone, any other on the Mac's input (pick "
                    "the microphone in the app); a name with 'whisper' in it is whispered. Takes go to "
                    "training/data/pilot/<setup>/ and are never trained on.")  # fmt: skip
    p.add_argument("--setup", required=True,
                   help="the setup's name, e.g. iphone-whisper, iphone-normal, mac-normal, mac-whisper, "
                        "airpods-normal, studio")  # fmt: skip
    p.add_argument("--phone", help="part of the phone's name, when several phones are paired")
    p.add_argument("--port", type=int, default=8765, help="port on 127.0.0.1 (default 8765; 0 picks a free one)")
    p.add_argument("--no-browser", action="store_true", help="do not open the page in the browser")
    p.add_argument("--app-bin", type=Path, help="the WalkieTalkey binary that hands the session to the app")
    p.add_argument("--app-url-file", type=Path, help="write the app's link (with its token) to this file (tests)")
    p.add_argument("--sentences", type=Path, default=paths.PILOT_CSV, help="the pilot sentences (id,text,kind)")
    p.add_argument("--pilot-dir", type=Path, default=paths.PILOT, help="folder for the pilot's takes")
    a = p.parse_args(argv)
    try:
        setup = parse_setup(a.setup)
    except ValueError as e:
        p.error(str(e))

    from .recorder.server import serve
    from .recorder.session import Session

    sentences = load_pilot(a.sentences)
    texts = {s.id: s.text for s in sentences}
    session = Session(root=a.pilot_dir, condition=setup.condition, items=sentences, texts=texts, phone=a.phone,
                      setup=setup.name)
    names = sorted(set(known_setups(a.pilot_dir)) | {setup.name})
    setups = [parse_setup(n) for n in names]
    rows = [{"id": s.name, "label": s.name, "device": s.device, "style": s.style} for s in setups]

    def progress() -> dict:
        return {s.name: {"done": len(store(a.pilot_dir, s, sentences).recorded()), "total": len(sentences)}
                for s in setups}

    print(f"pilot setup {setup.name}: {setup.describe()} (recorded as {setup.condition.id})"
          + ("; pick the microphone in WalkieTalkey first" if setup.device == "mac" else ""))
    return serve(session, port=a.port, progress=progress, rows=rows, app_bin=a.app_bin, app_url_file=a.app_url_file,
                 no_browser=a.no_browser,
                 describe=f"pilot {setup.name}: {session.state()['done']} of {len(sentences)} recorded; takes in "
                          f"{Path(a.pilot_dir) / setup.name}")  # fmt: skip


# --- wt-train pilot report ---------------------------------------------------------------


@dataclass(frozen=True)
class PilotClip:
    setup: str
    id: str
    wav: Path
    # The text as shown when it was read (the take's .txt).
    reference: str
    kind: str
    meta: dict


def _meta(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def pilot_clips(root: Path, setup: str, kinds: dict[str, str] | None = None) -> list[PilotClip]:
    """The current takes of a setup: ``<id>.wav`` with its ``.txt`` (and ``.json``)."""
    folder = Path(root) / setup
    if not folder.is_dir():
        return []
    out = []
    for wav in sorted(folder.glob("*.wav")):
        txt = wav.with_suffix(".txt")
        if not txt.is_file():
            continue
        meta = _meta(wav.with_suffix(".json"))
        kind = (kinds or {}).get(wav.stem) or str(meta.get("kind") or "")
        out.append(PilotClip(setup=setup, id=wav.stem, wav=wav.resolve(),
                             reference=txt.read_text(encoding="utf-8").strip(), kind=kind, meta=meta))
    return out


def setup_notes(style: str, audio: dict, scores: dict, flagged: dict[str, int]) -> list[str]:
    """What to look at in a setup: a quiet voice (the recorder's limit for its style), clipping,
    speech cut at an edge, silent or failed clips, and the recorder's own checks."""
    limits = LIMITS.get(style, LIMITS["normal"])
    clips = audio.get("clips", 0)
    out = []
    if clips and audio["level_dbfs"] < limits.quiet_dbfs:
        out.append(f"quiet: speech at {audio['level_dbfs']:.1f} dBFS, below the recorder's {limits.quiet_dbfs:.0f} "
                   f"dBFS for a {'whisper' if style == WHISPER else 'normal voice'}")
    if audio.get("clipped_clips"):
        out.append(f"clipped in {audio['clipped_clips']} of {clips} clips")
    if audio.get("cut_clips"):
        out.append(f"speech at the very start or end in {audio['cut_clips']} clips (start sooner, stop later)")
    if audio.get("silent_clips"):
        out.append(f"no speech found in {audio['silent_clips']} clips")
    if scores.get("failed"):
        out.append(f"{scores['failed']} clips failed in the app")
    if flagged:
        out.append("the recorder flagged " + ", ".join(f"{n} {problem}" for problem, n in sorted(flagged.items())))
    return out


def evaluate_setups(root: Path, sentences: list[Sentence], transcriber, spelling, *,
                    setups: list[str] | None = None, log=console.log) -> dict:
    """Every setup's takes transcribed in one go (the model loads once), scored with
    ``metrics.score_clip`` and measured with ``audiostats``. Returns ``setups`` (name ->
    numbers), ``rows`` (one per clip) and ``skipped`` (setups without takes)."""
    from .evaluate import EvalClip, score

    names = list(setups) if setups else known_setups(root)
    kinds = {s.id: s.kind for s in sentences}
    by_setup = {n: pilot_clips(root, parse_setup(n).name, kinds) for n in names}
    used = [n for n in names if by_setup[n]]
    skipped = [n for n in names if not by_setup[n]]
    clips = [c for n in used for c in by_setup[n]]
    if not clips:
        return {"setups": {}, "rows": [], "skipped": skipped}
    evals = [EvalClip(f"{c.id}.{c.setup}", c.wav, c.reference, parse_setup(c.setup).condition.id) for c in clips]
    rows, _ = score(transcriber, evals, spelling, "pilot", log)
    stats = {}
    for row, clip in zip(rows, clips):
        stats[row["id"]] = audiostats.measure(clip.wav)
        checks = clip.meta.get("checks") if isinstance(clip.meta.get("checks"), dict) else {}
        row.update(setup=clip.setup, sentence=clip.id, kind=clip.kind, audio=stats[row["id"]].as_dict(),
                   microphone=str(clip.meta.get("microphone") or ""), recorder_check=str(checks.get("check") or ""),
                   recorder_problems=list(checks.get("problems") or []))
    out = {}
    for n in used:
        s = parse_setup(n)
        part = [r for r in rows if r["setup"] == n]
        audio = audiostats.summarize([stats[r["id"]] for r in part])
        scores = summarize(part)
        flagged: dict[str, int] = {}
        for r in part:
            for problem in r["recorder_problems"]:
                flagged[problem] = flagged.get(problem, 0) + 1
        out[n] = {"setup": n, "device": s.device, "style": s.style, "condition": s.condition.id,
                  "microphones": sorted({r["microphone"] for r in part if r["microphone"]}),
                  "scores": scores, "audio": audio, "notes": setup_notes(s.style, audio, scores, flagged)}
    return {"setups": out, "rows": rows, "skipped": skipped}


def metrics_for_logging(result: dict) -> dict[str, float]:
    """``<setup>/wer``, ``<setup>/cer``, ``<setup>/term_accuracy_strict``, ``<setup>/level_dbfs``, ..."""
    out: dict[str, float] = {}
    for name, s in result["setups"].items():
        out.update(per_condition.for_logging(s["scores"], {}, name))
        out.update(tracking.flatten_numbers({name: s["audio"]}))
    return out


def _terms(s: dict) -> str:
    if not s["terms"]:
        return "–"
    return f"{s['terms_strict']} of {s['terms']} (any form {s['terms_lenient']})"


def _setup_table(result: dict) -> str:
    headers = ["Setup", "Microphone", "Clips", "WER", "CER", "Terms right", "Speech level", "Peak", "Noise floor",
               "SNR", "Clipped", "Length", "Notes"]
    rows = []
    for name, s in result["setups"].items():
        sc, au = s["scores"], s["audio"]
        rows.append([Raw(f'<b style="white-space:nowrap">{esc(name)}</b><br><span class="muted">{esc(parse_setup(name).describe())}</span>'),
                     ", ".join(s["microphones"]) or "–", sc["n"], pct(sc["wer"]), pct(sc["cer"]), _terms(sc),
                     db(au["level_dbfs"]), db(au["peak_dbfs"]), db(au["noise_dbfs"]), db(au["snr_db"], "dB"),
                     f"{au['clipped_clips']} of {au['clips']}", f"{au['seconds']:.1f} s",
                     "; ".join(s["notes"]) or "none"])
    return table(headers, rows, numeric=(2, 3, 4, 6, 7, 8, 9, 10, 11))


def _clip(row: dict, wav: str) -> str:
    au = row["audio"]
    errors = row["sub"] + row["del"] + row["ins"]
    wer = errors / row["ref_words"] if row["ref_words"] else 0.0
    flags = []
    if au["clipped_samples"]:
        flags.append("clipped")
    if au["cut_start"] or au["cut_end"]:
        flags.append("speech at the edge")
    if au["silent"]:
        flags.append("no speech found")
    flags += [f"recorder: {p}" for p in row.get("recorder_problems") or []]
    head = (f"<header><b>{esc(row['sentence'])}</b><span>{esc(row.get('kind') or '')}</span>"
            f"<span>WER {pct(wer, 1)} ({errors} of {row['ref_words']} words)</span>"
            f"<span>level {db(au['level_dbfs'])} · noise {db(au['noise_dbfs'])} · SNR {db(au['snr_db'], 'dB')} · "
            f"peak {db(au['peak_dbfs'])} · {au['seconds']:.1f} s</span>"
            + "".join(f'<span class="worse">{esc(f)}</span>' for f in flags) + "</header>")
    ops = align(row["ref_norm"].split(), row["hyp_norm"].split())
    wrote = esc(row["hypothesis"]) if not row.get("error") else f'<span class="worse">{esc(row["error"])}</span>'
    details = [("Read", esc(row["reference"])), ("Edda wrote", wrote), ("Diff", diff_html(ops) or "–")]
    if row.get("terms_missed"):
        details.append(("Terms missed", esc(", ".join(row["terms_missed"]))))
    dl = "".join(f"<dt>{k}</dt><dd>{v}</dd>" for k, v in details)
    return f'<div class="clip">{head}{audio_tag(wav)}<dl>{dl}</dl></div>'


def render(result: dict, *, model: str, app: str, when: datetime, sentences_csv: Path) -> str:
    """The comparison page: cards, the table of setups, then every clip per setup."""
    setups = result["setups"]
    clips = sum(s["scores"]["n"] for s in setups.values())
    best = min(setups.items(), key=lambda kv: (kv[1]["scores"]["wer"], kv[0]))
    quietest_room = max(setups.items(), key=lambda kv: (kv[1]["audio"]["snr_db"], kv[0]))
    body = [cards([("setups", str(len(setups))), ("clips", str(clips)),
                   ("lowest WER", f"{best[0]}: {pct(best[1]['scores']['wer'], 1)}"),
                   ("highest SNR", f"{quietest_room[0]}: {db(quietest_room[1]['audio']['snr_db'], 'dB')}")])]
    body.append("<h2>Setups</h2>")
    body.append(_setup_table(result))
    if result["skipped"]:
        body.append(f'<p class="muted">No takes yet, so skipped: {esc(", ".join(result["skipped"]))}.</p>')
    body.append(
        '<p class="muted">WER and CER: word and character errors against the sentence as read, after the accuracy '
        "job's normaliser. Terms right: English terms in the same form (spelling.yaml); any form counts any ending. "
        "Speech level: the 97th percentile 10 ms frame, the recorder's measure (median over the clips). Noise floor: "
        "the median frame in the pauses. SNR: level minus noise. Peak: the loudest sample of any clip. Clipped: clips "
        "with samples at full scale. Length: all clips together. Notes use the recorder's limits for the style.</p>")
    body.append("<h2>Every clip</h2>")
    body.append(LEGEND)
    wavs = {r["id"]: r["wav"] for r in result["rows"]}
    for name, s in setups.items():
        mics = ", ".join(s["microphones"]) or "microphone not named"
        body.append(f"<h3>{esc(name)}</h3><p class=\"sub\">{esc(parse_setup(name).describe())} · {esc(mics)} · "
                    f"WER {pct(s['scores']['wer'])} · speech {db(s['audio']['level_dbfs'])} · "
                    f"SNR {db(s['audio']['snr_db'], 'dB')}</p>")
        for row in (r for r in result["rows"] if r["setup"] == name):
            body.append(_clip(row, wavs[row["id"]]))
    subtitle = (f"{when:%Y-%m-%d %H:%M} · the shipped Edda ({model}) through the app ({app}) · "
                f"{clips} clips of {sentences_csv.name}, never trained on")
    return page("Pilot: the recording setups compared", "".join(body), subtitle)


def report_main(argv: list[str], *, transcriber=None, log=console.log) -> dict:
    """Runs ``wt-train pilot report``; returns ``exit_code``, ``page`` and the numbers
    (``evaluate_setups``). ``transcriber`` replaces the app (tests)."""
    p = argparse.ArgumentParser(prog="wt-train pilot report",
                                description="Compare the pilot's recording setups: the shipped Edda through the app, "
                                            "the audio measured, one HTML page and an MLflow run.")  # fmt: skip
    p.add_argument("--setups", help="only these setups, comma separated (default: every one recorded)")
    p.add_argument("--pilot-dir", type=Path, default=paths.PILOT, help="the pilot's takes")
    p.add_argument("--sentences", type=Path, default=paths.PILOT_CSV, help="the pilot sentences (for their kind)")
    p.add_argument("--spelling", type=Path, default=paths.SPELLING_YAML, help="spelling.yaml for term accuracy")
    p.add_argument("--model", default=paths.SHIPPED_EDDA_ID, help="the app's model id (default: the shipped Edda)")
    p.add_argument("--app-bin", type=Path, help="the WalkieTalkey binary (default: the installed app first)")
    p.add_argument("--out", type=Path, help="the page (default <work>/reports/pilot-<date>.html)")
    p.add_argument("--no-open", action="store_true", help="do not open the page in the browser")
    p.add_argument("--json-out", type=Path,
                   help="also write the comparison (every setup's numbers and notes) to this JSON file (Værkstedet)")
    a = p.parse_args(argv)
    names = None
    if a.setups:
        try:
            names = [parse_setup(n.strip()).name for n in a.setups.split(",") if n.strip()]
        except ValueError as e:
            p.error(str(e))

    from .spelling import load_spelling

    sentences = load_pilot(a.sentences)
    spelling = load_spelling(a.spelling) if a.spelling and Path(a.spelling).is_file() else None
    if not any(pilot_clips(a.pilot_dir, n) for n in (names or known_setups(a.pilot_dir))):
        # Nothing to transcribe: the app is not started at all.
        log(f"no pilot takes in {a.pilot_dir}; record a setup with: wt-train pilot record --setup <name>")
        return {"exit_code": 1, "page": None, "setups": {}, "rows": [], "skipped": names or known_setups(a.pilot_dir)}
    app_name = "a stand-in transcriber"
    if transcriber is None:
        from .app import find_app
        from .evaluate import AppTranscriber

        app = find_app(a.app_bin, prefer_installed=True)
        app.check_model(a.model)
        app_name = str(app.bin)
        log(f"the shipped Edda through the app: {app.bin} ({'batch' if app.supports_batch else 'one call per file'}),"
            f" model {a.model}")
        transcriber = AppTranscriber(app, a.model)

    result = evaluate_setups(a.pilot_dir, sentences, transcriber, spelling, setups=names, log=log)
    for name in result["skipped"]:
        log(f"{name}: no takes yet, skipped")
    if not result["setups"]:
        log(f"no pilot takes in {a.pilot_dir}; record a setup with: wt-train pilot record --setup <name>")
        return {"exit_code": 1, "page": None, **result}

    when = datetime.now().astimezone()
    out = a.out or paths.reports_dir() / f"pilot-{when:%Y-%m-%d-%H%M%S}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    html = render(result, model=a.model, app=app_name, when=when, sentences_csv=Path(a.sentences))
    tmp = out.with_name(f".{out.name}.tmp")
    tmp.write_text(html, encoding="utf-8")
    tmp.replace(out)

    metrics = metrics_for_logging(result)
    used = list(result["setups"])
    with tracking.run("pilot", out.stem, tags={"wt.pilot": ",".join(used)}) as r:
        r.params({"model": a.model, "app": app_name, "setups": used, "skipped": result["skipped"],
                  "pilot_sentences": str(a.sentences), "pilot_sentences_sha256": file_sha256(a.sentences)})
        r.metrics(metrics)
        r.artifact(out)
        r.text(json.dumps({"setups": result["setups"], "skipped": result["skipped"],
                           "clips": [{k: v for k, v in row.items() if k != "wav"} for row in result["rows"]]},
                          indent=2, ensure_ascii=False) + "\n", "pilot.json")
        run_id = r.id

    if a.json_out:
        _write_json(a.json_out, {"generated_at": when.isoformat(timespec="seconds"), "page": str(out),
                                 "model": a.model, "app": app_name, "run_id": run_id,
                                 "setups": result["setups"], "skipped": result["skipped"]})
        log(f"comparison: {a.json_out}")
    log("")
    log(f"{'setup':<20} {'clips':>5} {'WER %':>6} {'CER %':>6} {'speech':>8} {'noise':>8} {'SNR':>6}  notes")
    for name, s in result["setups"].items():
        sc, au = s["scores"], s["audio"]
        log(f"{name[:20]:<20} {sc['n']:>5} {sc['wer'] * 100:>6.2f} {sc['cer'] * 100:>6.2f} {au['level_dbfs']:>8.1f} "
            f"{au['noise_dbfs']:>8.1f} {au['snr_db']:>6.1f}  {'; '.join(s['notes']) or 'none'}")
    log(f"page: {out}")
    if not a.no_open:
        webbrowser.open(out.resolve().as_uri())
    failed = sum(s["scores"]["failed"] for s in result["setups"].values())
    return {"exit_code": 1 if failed else 0, "page": out, "metrics": metrics, "run_id": run_id, **result}


def _write_json(path: Path, data: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


# --- wt-train pilot -------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="wt-train pilot", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("step", choices=["record", "report"], help="record one setup, or compare the setups")
    p.add_argument("args", nargs=argparse.REMAINDER, help="the step's options (wt-train pilot <step> --help)")
    a = p.parse_args(argv[:1])
    if a.step == "record":
        return record(argv[1:])
    return int(report_main(argv[1:])["exit_code"])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
