"""``wt-train report`` (run 7): one HTML page per evaluation, or two compared (``--vs``),
written to the reports folder and attached to the evaluation's MLflow run. Every
``wt-train eval`` leaves one too. Run 11: the pages are in Danish, numbers and all."""

import csv
import json
import re
from datetime import datetime

import pytest

import fake_app
from conftest import write_fleurs
from wt_train import align, evaluate, htmlpage, metrics, paths, per_condition, report, tracking
from wt_train.harness import Counts, bootstrap_ci
from wt_train.spelling import load_spelling

FLEURS = evaluate.FLEURS_TEST
SPELLING = ("terms:\n  deploy:\n    forms: [deploye, deployede]\n"
            "  commit:\n    forms: [commit, commits]\n")


@pytest.fixture
def spelling_file(tmp_path):
    path = tmp_path / "spelling.yaml"
    path.write_text(SPELLING, encoding="utf-8")
    return path


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_TRACKING", "1")


@pytest.fixture
def work(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    return tmp_path / "work"


def write_run(folder, clips, make_wav, *, dataset=FLEURS, backend="gguf", model="m", spelling=None,
              wavs=None, summary_patch=None):
    """An eval run folder as ``wt-train eval`` leaves it: clips are (id, reference,
    hypothesis) or (id, reference, hypothesis, condition)."""
    folder.mkdir(parents=True, exist_ok=True)
    wavs = wavs if wavs is not None else folder.parent / "wavs"
    rows = []
    for i, clip in enumerate(clips):
        cid, ref, hyp, condition = (*clip, "")[:4]
        wav = wavs / f"{cid}.wav"
        if not wav.exists() and "nowav" not in cid:
            make_wav(wav, seed=i, seconds=0.3)
        rows.append({**metrics.score_clip(cid, ref, hyp, spelling), "wav": str(wav), "condition": condition})
    summary = metrics.summarize(rows)
    by_condition = per_condition.summaries(rows)
    if summary_patch:
        summary.update(summary_patch)
    (folder / f"{evaluate._slug(dataset)}.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    (folder / "summary.json").write_text(json.dumps(
        {"backend": backend, "model": model, "results": {dataset: summary}, "by_condition": by_condition,
         "metrics": per_condition.for_logging(summary, by_condition, dataset)}, indent=2, ensure_ascii=False))
    return folder


def letters(i):
    """0 -> a, 25 -> z, 26 -> ba: distinct words without digits (the normaliser spells digits out)."""
    out = ""
    while True:
        out = "abcdefghijklmnopqrstuvwxyz"[i % 26] + out
        i //= 26
        if not i:
            return out


def words(n, start=0):
    return " ".join(f"ord{letters(start + i)}" for i in range(n))


def with_errors(n_words, n_errors, start=0):
    """A reference of n_words and a hypothesis with the first n_errors substituted."""
    ref = words(n_words, start).split()
    hyp = ["fejl"] * n_errors + ref[n_errors:]
    return " ".join(ref), " ".join(hyp)


def small_fleurs_run(tmp_path, make_wav, name="20261025-015628-gguf-m", **kw):
    clips = [
        ("c1", "det er en god dag", "ja det var en dag"),  # 1 sub, 1 del, 1 ins
        ("c2", "vi ses i morgen", "vi ses i morgen"),
        ("c3", "Vi deployede den i går.", "vi deployede den i går"),
        ("c4", "Han skal deploye nu.", "han skal deployede nu"),  # strict miss, lenient hit
        ("c5", "To commits i dag.", "to komits i dag"),  # strict and lenient miss
    ]
    spelling = load_spelling(tmp_path / "spelling.yaml") if (tmp_path / "spelling.yaml").exists() else None
    return write_run(tmp_path / "runs" / name, clips, make_wav, spelling=spelling, **kw)


def render(folder, tmp_path, *extra):
    out = tmp_path / "page.html"
    assert report.main([str(folder), "--no-open", "--out", str(out), *extra], log=lambda *_: None) == 0
    return out.read_text(encoding="utf-8")


def rows_of(folder, dataset=FLEURS):
    path = folder / f"{evaluate._slug(dataset)}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


def clip_ids(html):
    return re.findall(r'<section class="clip" id="clip-([^"]+)"', html)


# --- the numbers -------------------------------------------------------------------


def test_the_page_carries_the_summary_numbers(tmp_path, make_wav, spelling_file):
    folder = small_fleurs_run(tmp_path, make_wav)
    s = json.loads((folder / "summary.json").read_text())["results"][FLEURS]
    html = render(folder, tmp_path, "--spelling", str(spelling_file))
    assert html.startswith("<!doctype html>") and '<html lang="da">' in html
    assert htmlpage.pct(s["wer"]) in html and htmlpage.pct(s["cer"]) in html
    assert "," in htmlpage.pct(s["wer"]), "a decimal comma"
    lo, hi = s["wer_ci95"]
    assert f"95 %: {htmlpage.num(lo * 100, 2)} til {htmlpage.num(hi * 100, 2)}" in html
    assert f"{s['reference_words']} ord i referencerne" in html
    # The run's readable name, as Værkstedet lists it; the folder in the subtitle.
    assert "<title>m i appen · FLEURS</title>" in html and folder.name in html
    assert "Sådan er tallene lavet" in html and "normalisering 1" in html  # a 25 October folder
    # nothing from another origin
    assert not re.search(r"""(src|href)=["']https?://""", html)


def test_the_wer_interval_is_the_summary_one_or_recomputed(tmp_path, make_wav):
    folder = small_fleurs_run(tmp_path, make_wav, summary_patch={"wer_ci95": [0.0123, 0.4567]})
    assert "95 %: 1,23 til 45,67" in render(folder, tmp_path)
    rows = rows_of(folder)
    counts = [Counts(sub=r["sub"], dele=r["del"], ins=r["ins"], ref=r["ref_words"]) for r in rows]
    assert report.stats(rows).wer_ci == pytest.approx(bootstrap_ci(counts))


def test_the_cer_gets_a_bootstrap_interval_over_clips(tmp_path, make_wav):
    folder = small_fleurs_run(tmp_path, make_wav)
    rows = rows_of(folder)
    s = report.stats(rows)
    want = align.bootstrap_ratio_ci([r["char_errors"] for r in rows], [r["ref_chars"] for r in rows])
    assert s.cer_ci == want
    assert s.cer == pytest.approx(sum(r["char_errors"] for r in rows) / sum(r["ref_chars"] for r in rows))
    assert f"95 %: {htmlpage.ci_text(want)}" in render(folder, tmp_path)


def test_substitutions_deletions_and_insertions_with_their_share(tmp_path, make_wav, spelling_file):
    folder = small_fleurs_run(tmp_path, make_wav)
    rows = rows_of(folder)
    s = report.stats(rows)
    assert (s.sub, s.dele, s.ins) == (3, 1, 1)  # c1: 1/1/1, c4 and c5: one sub each
    assert s.words == sum(r["ref_words"] for r in rows) == 22
    html = render(folder, tmp_path, "--spelling", str(spelling_file))
    assert re.search(r'<td>Erstatninger</td><td class="num">3</td><td class="num">13,64 %</td>'
                     r'<td class="num">60,0 %</td>', html)
    assert re.search(r'<td>Udeladelser</td><td class="num">1</td><td class="num">4,55 %</td>', html)
    assert re.search(r'<td>Tilføjelser</td><td class="num">1</td><td class="num">4,55 %</td>', html)


def test_accuracy_per_english_term_strict_and_lenient(tmp_path, make_wav, spelling_file):
    folder = small_fleurs_run(tmp_path, make_wav, dataset="takes")
    rows = rows_of(folder, "takes")
    spelling = load_spelling(spelling_file)
    terms = {t.term: t for t in report.term_stats(rows, spelling)}
    assert (terms["deploy"].clips, terms["deploy"].total, terms["deploy"].strict, terms["deploy"].lenient) == (2, 2, 1, 2)
    assert (terms["commit"].clips, terms["commit"].total, terms["commit"].strict, terms["commit"].lenient) == (1, 1, 0, 0)
    assert dict(terms["deploy"].missed) == {"deploye": 1} and dict(terms["commit"].missed) == {"commits": 1}
    # per term, the counts add up to what the evaluation counts
    total = [metrics.term_counts(spelling, r["reference"], r["hypothesis"]) for r in rows]
    assert sum(t.total for t in terms.values()) == sum(c.total for c in total)
    assert sum(t.strict for t in terms.values()) == sum(c.strict for c in total)
    assert sum(t.lenient for t in terms.values()) == sum(c.lenient for c in total)
    html = render(folder, tmp_path, "--spelling", str(spelling_file))
    # most missed first
    assert html.index("<td>commit</td>") < html.index("<td>deploy</td>")
    assert re.search(r'<td>deploy</td><td class="num">2</td><td class="num">2</td><td class="num">1 \(50,0 %\)</td>'
                     r'<td class="num">2 \(100,0 %\)</td><td>deploye</td>', html)


def test_a_run_without_terms_says_so(tmp_path, make_wav, spelling_file):
    folder = write_run(tmp_path / "runs" / "r", [("a", "en to tre", "en to tre")], make_wav, dataset="takes")
    assert "ingen engelske fagord fra spelling.yaml" in render(folder, tmp_path, "--spelling", str(spelling_file))


def test_fleurs_pages_show_no_term_accuracy(tmp_path, make_wav, spelling_file):
    # Run 8: the "terms" spelling.yaml finds in FLEURS are ordinary Danish words ("test", "bug").
    folder = small_fleurs_run(tmp_path, make_wav)  # its references hold "deployede" and "commits"
    html = render(folder, tmp_path, "--spelling", str(spelling_file))
    for shown in ("Engelske fagord rigtige", "Fagord, samme form", "Fagord, enhver form", "<td>deploy</td>",
                  "Rigtige, samme form"):
        assert shown not in html
    assert "tælles ikke på FLEURS" in html
    run_a, run_b = two_runs(tmp_path, make_wav)
    compared = render(run_a, tmp_path, "--vs", str(run_b), "--spelling", str(spelling_file))
    for shown in ("Engelske fagord, samme form", "Samme form A", "Fagord, samme form"):
        assert shown not in compared
    assert "tælles ikke på FLEURS" in compared
    # the owner's takes keep theirs
    takes = small_fleurs_run(tmp_path, make_wav, name="20261026-100000-gguf-m", dataset="takes")
    own = render(takes, tmp_path, "--spelling", str(spelling_file))
    assert "Engelske fagord rigtige, samme form" in own and "Fagord, samme form" in own and "<td>deploy</td>" in own


def test_one_row_per_recording_condition_or_one_group_for_fleurs(tmp_path, make_wav):
    clips = [("p1", "en to tre fire", "en to tre fem", "phone-whisper"),
             ("m1", "en to tre fire", "en to tre fire", "mac-normal"),
             ("p2", "fem seks syv", "fem seks", "phone-whisper")]
    folder = write_run(tmp_path / "runs" / "takes", clips, make_wav, dataset="takes")
    rows = rows_of(folder, "takes")
    groups = report.groups(rows)
    assert [g for g, _ in groups] == ["phone-whisper", "mac-normal"]  # conditions.IDS order
    want = per_condition.summaries(rows)
    html = render(folder, tmp_path)
    # Named in Danish, as the recorder names them.
    assert html.index("<td>Telefonen, hvisket</td>") < html.index("<td>Mac&#x27;en, almindelig stemme</td>")
    assert htmlpage.pct(want["phone-whisper"]["wer"]) in html
    fleurs = small_fleurs_run(tmp_path, make_wav)
    assert [g for g, _ in report.groups(rows_of(fleurs))] == ["Alle klip (uden optageforhold)"]


# --- the clips ---------------------------------------------------------------------


def test_the_25_worst_clips_most_errors_then_highest_wer(tmp_path, make_wav):
    clips = [("big", *with_errors(50, 5)),  # 5 errors, 10 %
             ("short", *with_errors(5, 3)),  # 3 errors, 60 %
             ("b-three", *with_errors(10, 3)),  # 3 errors, 30 %: ties with a-three, which sorts first
             ("a-three", *with_errors(10, 3))]
    clips += [(f"one-{i:02d}", *with_errors(4 + i, 1)) for i in range(26)]  # 1 error each, WER falling
    clips += [("clean", "helt rigtigt", "helt rigtigt")]
    folder = write_run(tmp_path / "runs" / "worst", clips, make_wav)
    rows = rows_of(folder)
    want = ["big", "short", "a-three", "b-three"] + [f"one-{i:02d}" for i in range(21)]
    assert [r["id"] for r in report.worst(rows)] == want
    html = render(folder, tmp_path)
    assert clip_ids(html) == want
    assert html.count("data:audio/mpeg;base64,") == 25  # audio for the worst clips only, not for every clip


def test_a_worst_clip_shows_reference_audio_and_the_coloured_diff(tmp_path, make_wav):
    clips = [("c1", "Det er en god dag.", "Ja, det var en dag."), ("c2-nowav", "hej med dig", "hej med")]
    folder = write_run(tmp_path / "runs" / "diff", clips, make_wav)
    html = render(folder, tmp_path)
    ops = align.align("det er en god dag".split(), "ja det var en dag".split())
    assert htmlpage.diff_html(ops) in html
    assert '<del class="w sub">er</del><ins class="w sub">var</ins>' in html
    assert "Det er en god dag." in html and "Ja, det var en dag." in html  # as written, punctuation and all
    assert html.count("data:audio/mpeg;base64,") == 1
    assert "(lyden blev ikke fundet)" in html  # c2's WAV is gone; the clip is still shown
    assert htmlpage.LEGEND in html


def test_a_missing_wav_is_looked_up_in_the_fleurs_folder(tmp_path, make_wav, work):
    folder = write_run(tmp_path / "runs" / "moved", [("x1", "en to", "en tre")], make_wav)
    rows = rows_of(folder)
    rows[0]["wav"] = "/elsewhere/datasets/fleurs-da_dk/test/x1.wav"
    (folder / "fleurs-da-dk-test.jsonl").write_text(json.dumps(rows[0]) + "\n", encoding="utf-8")
    make_wav(paths.fleurs_dir() / "test" / "x1.wav", seed=1, seconds=0.3)
    assert "data:audio/mpeg;base64," in render(folder, tmp_path)


# --- two runs compared ---------------------------------------------------------------


def two_runs(tmp_path, make_wav):
    # (id, errors in B, errors in A), 10 words each
    plan = [("k0", 0, 1), ("k1", 2, 0), ("k2", 5, 5), ("k3", 1, 4), ("k4", 3, 3), ("k5", 4, 1)]
    a = [(cid, *with_errors(10, ea, start=i * 10)) for i, (cid, _, ea) in enumerate(plan)]
    b = [(cid, *with_errors(10, eb, start=i * 10)) for i, (cid, eb, _) in enumerate(plan)]
    a.append(("only-a", "en to tre", "en to tre"))
    b.append(("only-b", "en to tre", "en"))
    run_b = write_run(tmp_path / "runs" / "20261024-181712-gguf-m", b, make_wav)
    run_a = write_run(tmp_path / "runs" / "20261025-015628-gguf-m", a, make_wav)
    return run_a, run_b


def test_clips_that_got_better_or_worse_matched_by_id(tmp_path, make_wav):
    run_a, run_b = two_runs(tmp_path, make_wav)
    ch = report.changes(rows_of(run_a), rows_of(run_b))
    assert [ra["id"] for ra, _ in ch.worse] == ["k3", "k0"]  # +3 before +1
    assert [ra["id"] for ra, _ in ch.better] == ["k5", "k1"]  # -3 before -2
    assert sorted(ra["id"] for ra, _ in ch.same) == ["k2", "k4"]
    assert ch.only_a == ["only-a"] and ch.only_b == ["only-b"]


def test_the_comparison_page_side_by_side(tmp_path, make_wav):
    run_a, run_b = two_runs(tmp_path, make_wav)
    html = render(run_a, tmp_path, "--vs", str(run_b))
    sa = report.stats(rows_of(run_a))
    sb = report.stats(rows_of(run_b))
    assert htmlpage.pct(sa.wer) in html and htmlpage.pct(sb.wer) in html
    # the paired change over the matched clips: A's errors minus B's, over the reference words
    matched = report.changes(rows_of(run_a), rows_of(run_b))
    delta = report.paired_change(matched)
    assert delta.value == pytest.approx((14 - 15) / 60)
    assert delta.ci[0] <= delta.value <= delta.ci[1]
    assert htmlpage.points(delta.value) in html and htmlpage.points(delta.value).startswith("\u2212")
    worse = html.index("Klip, der blev værre")
    better = html.index("Klip, der blev bedre")
    assert worse < better
    ids = clip_ids(html)
    assert ids == ["k3", "k0", "k5", "k1"]
    # each changed clip: both diffs and the audio
    k3 = html[html.index('id="clip-k3"'):html.index('id="clip-k0"')]
    assert k3.count('class="w sub"') >= 2 * 4 and "data:audio/mpeg;base64," in k3
    assert "1 → 4" in k3
    assert "kun i A" in html and "kun i B" in html
    for label in ("Erstatninger", "Udeladelser", "Tilføjelser"):
        assert f"<td>{label}</td>" in html
    # Two runs that would share a name are told apart by their day, in the title and the table.
    assert "<title>m i appen · FLEURS · 25. okt. mod m i appen · FLEURS · 24. okt.</title>" in html
    assert "<td>Navn</td><td>m i appen · FLEURS · 25. okt.</td><td>m i appen · FLEURS · 24. okt.</td>" in html
    # Both from before 26 October: one normaliser, no warning.
    assert "hver sin normalisering" not in html


def test_a_comparison_across_the_normaliser_fix_says_so_under_the_verdict(tmp_path, make_wav):
    # Run 11: 26 October's runs were counted by normaliser 2, 25 October's by 1.
    plan = [("k0", 2, 1), ("k1", 3, 1)]
    a = [(cid, *with_errors(10, ea, start=i * 10)) for i, (cid, _, ea) in enumerate(plan)]
    b = [(cid, *with_errors(10, eb, start=i * 10)) for i, (cid, eb, _) in enumerate(plan)]
    run_b = write_run(tmp_path / "runs" / "20261025-015628-gguf-m", b, make_wav)
    run_a = write_run(tmp_path / "runs" / "20261026-170753-gguf-m", a, make_wav, summary_patch=None)
    summary = json.loads((run_a / "summary.json").read_text())
    summary["normaliser"] = 2
    (run_a / "summary.json").write_text(json.dumps(summary))
    html = render(run_a, tmp_path, "--vs", str(run_b))
    warning = html.index("A og B er talt med hver sin normalisering (1 og 2)")
    assert html.index("Intervallet er parret") < warning < html.index("<h2>De to kørsler</h2>")
    assert "<td>Normalisering</td><td>2</td><td>1</td>" in html


def test_the_comparison_needs_the_same_dataset(tmp_path, make_wav):
    run_a = write_run(tmp_path / "runs" / "a", [("x", "en", "en")], make_wav, dataset="takes")
    run_b = write_run(tmp_path / "runs" / "b", [("x", "en", "en")], make_wav)
    messages = []
    assert report.main([str(run_a), "--vs", str(run_b), "--no-open", "--out", str(tmp_path / "x.html")],
                       log=messages.append) == 1
    assert "takes" in messages[-1]


# --- finding runs ------------------------------------------------------------------------


def test_a_run_is_found_by_folder_name_or_latest(tmp_path, make_wav, work):
    old = small_fleurs_run(tmp_path, make_wav, name="20261024-181712-gguf-m")
    new = small_fleurs_run(tmp_path, make_wav, name="20261025-015628-gguf-m")
    evals = paths.eval_runs_dir()
    evals.mkdir(parents=True)
    for f in (old, new):
        f.rename(evals / f.name)
    (evals / "20261026-000000-half-written").mkdir()  # no summary.json: not a run
    assert report.resolve(str(evals / old.name)) == (evals / old.name).resolve()
    assert report.resolve(old.name) == (evals / old.name).resolve()
    assert report.resolve("latest") == (evals / new.name).resolve()
    with pytest.raises(report.ReportError):
        report.resolve("no-such-run")
    messages = []
    assert report.main(["no-such-run", "--no-open"], log=messages.append) == 1
    assert "no-such-run" in messages[-1]


def test_the_page_lands_in_the_reports_folder_and_opens_unless_told_not_to(tmp_path, make_wav, work, monkeypatch):
    folder = small_fleurs_run(tmp_path, make_wav)
    opened = []
    monkeypatch.setattr(report, "open_page", opened.append)
    assert report.main([str(folder)], log=lambda *_: None) == 0
    page = paths.reports_dir() / f"{folder.name}.html"
    assert page.is_file() and opened == [page]
    assert report.main([str(folder), "--no-open"], log=lambda *_: None) == 0
    assert opened == [page]
    run_a, run_b = two_runs(tmp_path / "pair", make_wav)
    assert report.main([str(run_a), "--vs", str(run_b), "--no-open"], log=lambda *_: None) == 0
    assert (paths.reports_dir() / "20261025-015628-gguf-vs-20261024-181712-gguf.html").is_file()


# --- MLflow ------------------------------------------------------------------------------


def artifacts(run_id, folder="report"):
    c, _ = tracking.client()
    return [a.path for a in c.list_artifacts(run_id, folder)]


def test_a_report_is_attached_to_its_eval_run(store, tmp_path, make_wav):
    run_a, run_b = two_runs(tmp_path, make_wav)
    with tracking.run("eval", run_a.name, tags={"wt.eval_dir": str(run_a)}) as ra:
        pass
    with tracking.run("eval", run_b.name) as rb:  # named after its folder, as wt-train eval names it
        pass
    assert report.main([str(run_b), "--no-open"], log=lambda *_: None) == 0
    assert artifacts(rb.id) == [f"report/{run_b.name}.html"]
    assert report.main([str(run_a), "--vs", str(run_b), "--no-open"], log=lambda *_: None) == 0
    assert artifacts(ra.id) == ["report/20261025-015628-gguf-vs-20261024-181712-gguf.html"]
    assert artifacts(rb.id) == [f"report/{run_b.name}.html"]  # a comparison goes to A only


def local(text):
    """A results.csv timestamp in this machine's time zone, like wt-train eval writes."""
    return datetime.fromisoformat(text).astimezone().isoformat(timespec="seconds")


def imported_rows(tmp_path):
    rows = [("2026-10-24T18:17:11", "hf", "edda@698f", "7.21", "baseline: hf"),
            ("2026-10-24T18:54:51", "gguf", "m", "8.44", "baseline: app"),
            ("2026-10-25T02:16:19", "gguf", "m", "7.63", "run 5")]
    path = tmp_path / "results.csv"
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=evaluate.RESULT_COLUMNS, lineterminator="\n")
        w.writeheader()
        for ts, backend, model, wer, notes in rows:
            w.writerow({"timestamp": local(ts), "backend": backend, "model": model, "dataset": FLEURS, "n": "6",
                        "wer_pct": wer, "notes": notes})
    tracking.import_results(path)
    return {r.info.run_name: r for r in tracking.find_runs()}


def fleurs_run_with_wer(tmp_path, make_wav, name, wer, backend="gguf", model="m"):
    folder = small_fleurs_run(tmp_path, make_wav, name=name)
    summary = json.loads((folder / "summary.json").read_text())
    summary.update(backend=backend, model=model)
    summary["results"][FLEURS]["wer"] = wer
    (folder / "summary.json").write_text(json.dumps(summary))
    return folder


def test_an_imported_results_row_is_matched_tagged_and_resolvable(store, tmp_path, make_wav):
    runs = imported_rows(tmp_path)
    run4 = fleurs_run_with_wer(tmp_path, make_wav, "20261024-181712-gguf-m", 0.0844067135)
    run5 = fleurs_run_with_wer(tmp_path, make_wav, "20261025-015628-gguf-m", 0.0762587822)
    hf = fleurs_run_with_wer(tmp_path, make_wav, "20261024-180425-hf-edda", 0.0720628415, "hf", "edda@698f")
    for folder, name in ((run4, "gguf-fleurs-da_dk-test-2026-10-24"), (run5, "gguf-fleurs-da_dk-test-2026-10-25"),
                         (hf, "hf-fleurs-da_dk-test-2026-10-24")):
        assert report.main([str(folder), "--no-open"], log=lambda *_: None) == 0
        run = tracking.find_runs(name=name)[0]
        assert run.data.tags["wt.eval_dir"] == str(folder.resolve())
        assert artifacts(run.info.run_id) == [f"report/{folder.name}.html"]
    # now the tracked run's name finds the folder
    assert report.resolve("gguf-fleurs-da_dk-test-2026-10-24") == run4.resolve()
    assert report.resolve(runs["gguf-fleurs-da_dk-test-2026-10-25"].info.run_id) == run5.resolve()


def test_a_folder_without_a_matching_run_still_gets_its_page(store, tmp_path, make_wav):
    imported_rows(tmp_path)
    folder = fleurs_run_with_wer(tmp_path, make_wav, "20261024-181712-gguf-m", 0.0999)  # no row says 9.99
    messages = []
    assert report.main([str(folder), "--no-open"], log=messages.append) == 0
    assert (paths.reports_dir() / f"{folder.name}.html").is_file()
    assert any("not attached" in str(m) for m in messages)
    assert not any(r.data.tags.get("wt.eval_dir") for r in tracking.find_runs())


def test_wt_train_eval_writes_and_attaches_its_report(store, tmp_path, make_wav, monkeypatch):
    work = tmp_path / "work"
    write_fleurs(work / "datasets" / "fleurs-da_dk", "test",
                 [(f"x{i}", f"{3000 + i}", f"Sætning {i}.") for i in range(3)], seed0=40)
    folder = tmp_path / "clips"
    for i, (name, text) in enumerate({"a": "Vi deployede den i går.", "b": "Hej med dig."}.items()):
        make_wav(folder / f"{name}.wav", seed=i)
        (folder / f"{name}.txt").write_text(text, encoding="utf-8")
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text(SPELLING, encoding="utf-8")
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    opened = []
    monkeypatch.setattr(report, "open_page", opened.append)
    code = evaluate.main(["--backend", "gguf", "--model", "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
                          "--dataset", str(folder), "--app-bin", str(binary), "--spelling", str(spelling),
                          "--results", str(tmp_path / "results.csv")], log=lambda *_: None)
    assert code == 0 and opened == []  # no browser after an eval
    (out,) = list(paths.eval_runs_dir().iterdir())
    page = paths.reports_dir() / f"{out.name}.html"
    html = page.read_text(encoding="utf-8")
    assert "<td>deploy</td>" in html and "Klip" in html
    (run,) = tracking.find_runs(kind="eval")
    assert run.data.tags["wt.eval_dir"] == str(out.resolve())
    assert artifacts(run.info.run_id) == [f"report/{out.name}.html"]
    assert report.resolve(run.info.run_name) == out.resolve()


def test_wt_train_eval_writes_its_report_with_tracking_off(tmp_path, make_wav, monkeypatch, work):
    write_fleurs(work / "datasets" / "fleurs-da_dk", "test", [("x0", "3000", "Sætning nul.")], seed0=40)
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    code = evaluate.main(["--backend", "gguf", "--model", "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
                          "--app-bin", str(binary), "--results", str(tmp_path / "results.csv")], log=lambda *_: None)
    assert code == 0
    (out,) = list(paths.eval_runs_dir().iterdir())
    assert (paths.reports_dir() / f"{out.name}.html").is_file()


# --- primitives added for the report ---------------------------------------------------------


def test_cards_take_a_note_under_the_label():
    html = htmlpage.cards([("WER", "7.63 %", "95 %: 7.10 to 8.18"), ("Clips", "930")])
    assert "<b>7.63 %</b><span>WER</span><small>95 %: 7.10 to 8.18</small>" in html
    assert "<b>930</b><span>Clips</span></div>" in html


def test_a_change_is_coloured_by_whether_it_helps():
    assert htmlpage.change(-0.8, "-0.80 pp") == '<span class="better">-0.80 pp</span>'
    assert htmlpage.change(0.8, "+0.80 pp") == '<span class="worse">+0.80 pp</span>'
    assert htmlpage.change(3, "+3", lower_is_better=False) == '<span class="better">+3</span>'
    assert htmlpage.change(0, "0") == '<span class="muted">0</span>'


def test_a_clip_card_has_a_header_fields_and_a_player():
    html = htmlpage.clip_card("c<1>", "#1 c<1>", ["3 errors"], [("Reference", "a <b>"), ("Model", htmlpage.Raw("<i>x</i>"))],
                              audio=htmlpage.Raw("<audio></audio>"))
    assert html.startswith('<section class="clip" id="clip-c&lt;1&gt;">')
    assert "<b>#1 c&lt;1&gt;</b>" in html and "<span>3 errors</span>" in html and "<audio></audio>" in html
    assert "<dt>Reference</dt><dd>a &lt;b&gt;</dd>" in html and "<dt>Model</dt><dd><i>x</i></dd>" in html
