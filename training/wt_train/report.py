"""``wt-train report <run>``: an evaluation as one HTML page; ``--vs <run>`` compares two.

Before the owner records hours of speech he wants to see how a model is judged,
so the page shows the numbers and the clips behind them:

* overall WER and CER with 95 % intervals: the WER's from summary.json
  (recomputed with ``wt_eval.wer.bootstrap_ci`` when it is missing), the CER's a
  bootstrap over the clips' character edits (``align.bootstrap_ratio_ci``);
* a table per recording condition (the owner's takes carry one, ``conditions.py``;
  FLEURS clips have none and form one group);
* substitutions, deletions and insertions, as counts and as a share of the
  reference words;
* accuracy per English term of ``training/data/spelling.yaml``, strict (the same
  form) and lenient (any form of the term), counted per term exactly as
  ``metrics.term_counts`` counts them all together, with the current spelling.yaml;
* the 25 worst clips (most word errors, then highest WER), each with its audio,
  the reference, the model's text as written and a word diff coloured the way the
  WER counts it (``align.py``).

``--vs <runB>`` puts two runs of the same dataset side by side: A is the run named
first (normally the newer), B the one it is compared with. The change in WER over
the clips both scored gets a paired bootstrap interval, and the clips that got
worse and better (matched by clip id, the largest changes first) are shown with
both diffs and the audio.

``<run>`` is an eval run folder, its name under ``<work>/runs/eval/``, ``latest``
(the newest there), or a tracked MLflow run (name or id) whose ``wt.eval_dir`` tag
names its folder. The page goes to ``<work>/reports/`` (``--out`` for another
path) and opens in the browser (``--no-open`` to skip). It is attached to the
folder's MLflow run under ``report/`` (a comparison to A's run). A folder's run is
the one tagged with it, the eval run named after it (``wt-train eval`` names runs
so), or the ``results.csv`` row it produced: the same backend, model, dataset and
WER to two decimals, written after the folder's start time; that row's run is
then tagged ``wt.eval_dir`` so its name finds the folder from then on.

``wt-train eval`` writes and attaches its page at the end, without a browser
(``after_eval``). A page is one file (``htmlpage.py``): styles inline, audio as MP3
in data URLs for the clips shown only, nothing from another origin.
"""

from __future__ import annotations

import argparse
import json
import re
import webbrowser
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Sequence

from . import console, paths, tracking
from .align import align, bootstrap_ratio_ci
from .conditions import IDS
from .harness import Counts, bootstrap_ci
from .htmlpage import (LEGEND, Raw, audio_tag, cards, change, clip_card, diff_html, esc, page, pct, pct_ci,
                       table)
from .spelling import Spelling, load_spelling

WORST = 25
NO_CONDITION = "all clips (no recording condition)"
OTHER_CONDITION = "no recording condition"
FOLDER_TIME = "%Y%m%d-%H%M%S"  # wt-train eval's folder names start with the time it started
BACKENDS = {"hf": "Transformers", "lora": "Transformers with a LoRA adapter", "gguf": "the app's pipeline"}


class ReportError(Exception):
    """A run that cannot be found or read; the message says which and why."""


# --- finding and reading runs ---------------------------------------------------------


@dataclass
class EvalRun:
    """One eval run folder and the dataset of it a page is about."""

    folder: Path
    summary: dict
    dataset: str
    rows: list[dict]

    @property
    def results(self) -> dict:
        return self.summary.get("results") or {}

    @property
    def dataset_summary(self) -> dict:
        return self.results.get(self.dataset) or {}

    @property
    def main_dataset(self) -> bool:
        return next(iter(self.results), None) == self.dataset

    @property
    def started(self) -> datetime | None:
        try:
            return datetime.strptime(self.folder.name[:15], FOLDER_TIME)
        except ValueError:
            return None


def _has_summary(folder: Path) -> bool:
    return (folder / "summary.json").is_file()


def resolve(arg: str) -> Path:
    """The eval run folder ``arg`` names: a folder, a name under the eval runs folder,
    ``latest``, or a tracked run's name or id."""
    evals = paths.eval_runs_dir()
    if arg == "latest":
        found = sorted(f for f in evals.iterdir() if _has_summary(f)) if evals.is_dir() else []
        if not found:
            raise ReportError(f"no eval runs in {evals} yet")
        return found[-1].resolve()
    for candidate in (Path(arg).expanduser(), evals / arg):
        if _has_summary(candidate):
            return candidate.resolve()
    folder = _tracked_folder(arg)
    if folder is not None:
        return folder
    tracked = ", not a tracked run" if tracking.enabled() else ""
    raise ReportError(f"no eval run {arg!r}: not a folder with summary.json, not a name in {evals}{tracked}")


def _tracked_folder(arg: str) -> Path | None:
    if not tracking.enabled() or "'" in arg:
        return None
    runs = tracking.find_runs(name=arg)
    run = runs[0] if runs else None
    if run is None and re.fullmatch(r"[0-9a-f]{32}", arg):
        c, _ = tracking.client()
        try:
            run = c.get_run(arg)
        except Exception:  # mlflow raises its own exception types for unknown ids
            run = None
    if run is None:
        return None
    tagged = run.data.tags.get("wt.eval_dir")
    for candidate in ([Path(tagged)] if tagged else []) + [paths.eval_runs_dir() / run.info.run_name]:
        if _has_summary(candidate):
            return candidate.resolve()
    raise ReportError(f"the tracked run {arg!r} names no eval folder (no wt.eval_dir tag); give its folder")


def _slug(text: str) -> str:
    """As ``wt-train eval`` names a dataset's rows file."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "model"


def load(folder: Path, dataset: str | None = None) -> EvalRun:
    """A run folder's summary and the per-clip rows of ``dataset`` (default: its main one)."""
    try:
        summary = json.loads((Path(folder) / "summary.json").read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as e:
        raise ReportError(f"{folder}: no readable summary.json ({e})") from e
    results = summary.get("results") or {}
    if dataset is None:
        if not results:
            raise ReportError(f"{folder}: summary.json lists no datasets")
        dataset = next(iter(results))
    elif dataset not in results:
        raise ReportError(f"{Path(folder).name} has no {dataset!r} results (it has {', '.join(results) or 'none'})")
    for name in (_slug(dataset), dataset):
        path = Path(folder) / f"{name}.jsonl"
        if path.is_file():
            rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
            return EvalRun(Path(folder), summary, dataset, rows)
    raise ReportError(f"{folder}: no per-clip rows for {dataset} ({_slug(dataset)}.jsonl)")


# --- the numbers ------------------------------------------------------------------------


@dataclass(frozen=True)
class Stats:
    n: int
    words: int
    sub: int
    dele: int
    ins: int
    wer: float
    wer_ci: tuple[float, float]
    chars: int
    char_errors: int
    cer: float
    cer_ci: tuple[float, float]
    failed: int
    empty: int

    @property
    def errors(self) -> int:
        return self.sub + self.dele + self.ins


def stats(rows: Sequence[dict], wer_ci: Sequence[float] | None = None) -> Stats:
    """WER, CER (each with a 95 % interval) and the edits of a set of clips. ``wer_ci``
    is the interval summary.json holds; without it the WER's bootstrap is rerun."""
    counts = [Counts(sub=r["sub"], dele=r["del"], ins=r["ins"], ref=r["ref_words"]) for r in rows]
    words = sum(c.ref for c in counts)
    sub, dele, ins = (sum(c.sub for c in counts), sum(c.dele for c in counts), sum(c.ins for c in counts))
    char_errors = [r["char_errors"] for r in rows]
    chars = [r["ref_chars"] for r in rows]
    return Stats(
        n=len(rows), words=words, sub=sub, dele=dele, ins=ins,
        wer=(sub + dele + ins) / words if words else 0.0,
        wer_ci=tuple(wer_ci) if wer_ci else tuple(bootstrap_ci(counts)),
        chars=sum(chars), char_errors=sum(char_errors),
        cer=sum(char_errors) / sum(chars) if sum(chars) else 0.0,
        cer_ci=bootstrap_ratio_ci(char_errors, chars),
        failed=sum(1 for r in rows if r.get("error")), empty=sum(1 for r in rows if not r.get("hypothesis")))


def run_stats(run: EvalRun) -> Stats:
    """The run's overall numbers, with summary.json's WER interval when it covers these rows."""
    summary = run.dataset_summary
    ci = summary.get("wer_ci95") if summary.get("n") == len(run.rows) else None
    return stats(run.rows, ci)


def condition_of(row: dict) -> str:
    return row.get("condition") or ""


def groups(rows: Sequence[dict]) -> list[tuple[str, list[dict]]]:
    """Clips per recording condition (in ``conditions.IDS`` order); clips without one
    form one group (all of them, for FLEURS)."""
    present = {condition_of(r) for r in rows}
    order = [c for c in IDS if c in present] + sorted(present - set(IDS) - {""})
    out = [(c, [r for r in rows if condition_of(r) == c]) for c in order]
    rest = [r for r in rows if not condition_of(r)]
    if rest:
        out.append((OTHER_CONDITION if out else NO_CONDITION, rest))
    return out


def clip_errors(row: dict) -> int:
    return row["sub"] + row["del"] + row["ins"]


def clip_wer(row: dict) -> float:
    return clip_errors(row) / row["ref_words"] if row["ref_words"] else float(clip_errors(row))


def worst(rows: Sequence[dict], n: int = WORST) -> list[dict]:
    """The clips with the most word errors, then the highest WER, then by id."""
    bad = [r for r in rows if clip_errors(r)]
    return sorted(bad, key=lambda r: (-clip_errors(r), -clip_wer(r), str(r["id"])))[:n]


# --- English terms ----------------------------------------------------------------------


@dataclass
class TermStat:
    """One term over a set of clips: in how many clips, how often, how often right."""

    term: str
    clips: int = 0
    total: int = 0
    strict: int = 0
    lenient: int = 0
    missed: Counter = field(default_factory=Counter)


def term_hits(spelling: Spelling, reference: str, hypothesis: str) -> dict[str, tuple[int, int, int, list[str]]]:
    """Per term in the reference: (occurrences, strict hits, lenient hits, forms missed).
    Summed over the terms these are ``metrics.term_counts``' totals: the hypothesis is
    re-spelled first, forms are matched as multisets, a form belongs to one term."""
    ref = spelling.find_terms(reference)
    hyp = spelling.find_terms(spelling.apply(hypothesis))
    out = {}
    for term in dict.fromkeys(h.term for h in ref):
        ref_forms = Counter(h.form.casefold() for h in ref if h.term == term)
        hyp_forms = Counter(h.form.casefold() for h in hyp if h.term == term)
        left, missed = Counter(hyp_forms), []
        for h in ref:
            if h.term != term:
                continue
            if left[h.form.casefold()] > 0:
                left[h.form.casefold()] -= 1
            else:
                missed.append(h.form)
        total = sum(ref_forms.values())
        out[term] = (total, sum((ref_forms & hyp_forms).values()), min(total, sum(hyp_forms.values())), missed)
    return out


def term_stats(rows: Sequence[dict], spelling: Spelling) -> list[TermStat]:
    """Every term the references hold, the least often right (strict) first."""
    by_term: dict[str, TermStat] = {}
    for r in rows:
        for term, (total, strict, lenient, missed) in term_hits(spelling, r["reference"],
                                                                r.get("hypothesis") or "").items():
            t = by_term.setdefault(term, TermStat(term))
            t.clips += 1
            t.total += total
            t.strict += strict
            t.lenient += lenient
            t.missed.update(missed)
    return sorted(by_term.values(), key=lambda t: (t.strict / t.total, -t.total, t.term))


def term_totals(terms: Sequence[TermStat]) -> tuple[int, int, int]:
    return (sum(t.total for t in terms), sum(t.strict for t in terms), sum(t.lenient for t in terms))


# --- two runs ----------------------------------------------------------------------------


@dataclass
class Changes:
    """Clips matched by id: ``pairs`` (A's row, B's row) in A's order, split into worse,
    better and the same (by word errors), and the ids only one run scored."""

    pairs: list[tuple[dict, dict]]
    worse: list[tuple[dict, dict]]
    better: list[tuple[dict, dict]]
    same: list[tuple[dict, dict]]
    only_a: list[str]
    only_b: list[str]


def _delta(pair: tuple[dict, dict]) -> int:
    return clip_errors(pair[0]) - clip_errors(pair[1])


def _wer_delta(pair: tuple[dict, dict]) -> float:
    return clip_wer(pair[0]) - clip_wer(pair[1])


def changes(rows_a: Sequence[dict], rows_b: Sequence[dict]) -> Changes:
    """What changed from B to A, clip by clip; the largest changes first."""
    b_by_id = {str(r["id"]): r for r in rows_b}
    a_ids = {str(r["id"]) for r in rows_a}
    pairs = [(ra, b_by_id[str(ra["id"])]) for ra in rows_a if str(ra["id"]) in b_by_id]
    worse = sorted((p for p in pairs if _delta(p) > 0), key=lambda p: (-_delta(p), -_wer_delta(p), str(p[0]["id"])))
    better = sorted((p for p in pairs if _delta(p) < 0), key=lambda p: (_delta(p), _wer_delta(p), str(p[0]["id"])))
    return Changes(pairs=pairs, worse=worse, better=better, same=[p for p in pairs if _delta(p) == 0],
                   only_a=[str(r["id"]) for r in rows_a if str(r["id"]) not in b_by_id],
                   only_b=[str(r["id"]) for r in rows_b if str(r["id"]) not in a_ids])


@dataclass(frozen=True)
class Paired:
    """The change in WER from B to A over the clips both scored, with its interval."""

    value: float
    ci: tuple[float, float]
    clips: int


def paired_change(ch: Changes) -> Paired:
    """A's word errors minus B's, over the reference words, resampling the matched clips
    together (one draw takes a clip from both runs): far narrower than the two runs' own
    intervals, because the sentences' own difficulty cancels out."""
    diffs = [clip_errors(a) - clip_errors(b) for a, b in ch.pairs]
    words = [a["ref_words"] for a, _ in ch.pairs]
    total = sum(words)
    return Paired(sum(diffs) / total if total else 0.0, bootstrap_ratio_ci(diffs, words), len(ch.pairs))


# --- page parts -------------------------------------------------------------------------


def _ci_note(ci: Sequence[float]) -> str:
    return f"95 %: {ci[0] * 100:.2f} to {ci[1] * 100:.2f}"


def _pp(delta: float) -> str:
    return f"{delta * 100:+.2f} pp"


def _signed(n: int) -> str:
    return f"{n:+,}" if n else "0"


def _share(part: int, whole: int, digits: int = 2) -> str:
    return f"{part / whole * 100:.{digits}f} %" if whole else "–"


def _short_model(model: str) -> str:
    return model.rstrip("/").split("/")[-1] or model


def _when(run: EvalRun) -> str:
    return run.started.strftime("%Y-%m-%d %H:%M") if run.started else "–"


def find_wav(row: dict) -> Path | None:
    """The clip's audio: where the row says, or (a moved work folder) in this work
    folder's FLEURS test clips under the same name."""
    wav = row.get("wav")
    if not wav:
        return None
    path = Path(wav)
    if path.is_file():
        return path
    moved = paths.fleurs_dir() / "test" / path.name
    return moved if moved.is_file() else None


def _terms_label(total: int, strict: int, lenient: int) -> tuple[str, str]:
    if not total:
        return ("–", "–")
    return (f"{strict}/{total} ({strict / total * 100:.1f} %)", f"{lenient}/{total} ({lenient / total * 100:.1f} %)")


def headline(s: Stats, terms: Sequence[TermStat] | None) -> str:
    items = [("WER, word error rate", pct(s.wer), _ci_note(s.wer_ci)),
             ("CER, character error rate", pct(s.cer), _ci_note(s.cer_ci)),
             ("Clips", f"{s.n:,}", f"{s.words:,} reference words"),
             ("Word errors", f"{s.errors:,}", f"{s.sub:,} substituted, {s.dele:,} deleted, {s.ins:,} inserted")]
    total, strict, lenient = term_totals(terms or [])
    if total:
        items.append(("English terms right (strict)", _share(strict, total, 1),
                      f"{strict} of {total}; any form: {lenient} ({_share(lenient, total, 1)})"))
    if s.failed or s.empty:
        items.append(("Failed or empty", f"{s.failed} / {s.empty}", "clips the model failed on / gave no text"))
    return cards(items)


def datasets_table(run: EvalRun) -> str:
    if len(run.results) < 2:
        return ""
    rows = [[name + (" (this page)" if name == run.dataset else ""), f"{s.get('n', 0):,}",
             pct_ci(s.get("wer"), s.get("wer_ci95")), pct(s.get("cer"))] for name, s in run.results.items()]
    return ("<h2>Datasets in this run</h2>" + table(["Dataset", "Clips", "WER (95 %)", "CER"], rows, numeric=(1, 2, 3))
            + '<p class="note">The others: <code>wt-train report &lt;run&gt; --dataset &lt;name&gt;</code>.</p>')


def condition_table(rows: Sequence[dict], overall: Stats, spelling: Spelling | None) -> str:
    out = []
    for label, part in groups(rows):
        s = overall if len(part) == len(rows) else stats(part)
        strict, lenient = _terms_label(*term_totals(term_stats(part, spelling) if spelling else []))
        out.append([label, f"{s.n:,}", f"{s.words:,}", pct_ci(s.wer, s.wer_ci), pct_ci(s.cer, s.cer_ci),
                    f"{s.sub:,}", f"{s.dele:,}", f"{s.ins:,}", strict, lenient])
    return table(["Condition", "Clips", "Words", "WER (95 %)", "CER (95 %)", "Subs", "Dels", "Ins", "Terms strict",
                  "Terms lenient"], out, numeric=tuple(range(1, 10)))


def edits_table(s: Stats) -> str:
    rows = [[label, f"{n:,}", _share(n, s.words), _share(n, s.errors, 1)]
            for label, n in (("Substitutions", s.sub), ("Deletions", s.dele), ("Insertions", s.ins))]
    rows.append(["All word errors", f"{s.errors:,}", _share(s.errors, s.words), _share(s.errors, s.errors, 1)])
    return table(["Kind", "Count", "Share of reference words", "Share of errors"], rows, numeric=(1, 2, 3))


EDITS_NOTE = ('<p class="note">A substitution is a word heard as another word, a deletion a word the model '
              'left out, an insertion a word it added (a repeat, a made-up phrase). Their shares of the '
              'reference words add up to the WER.</p>')


def _missed(t: TermStat) -> str:
    return ", ".join(f"{form} ×{n}" if n > 1 else form for form, n in t.missed.most_common()) or "–"


def terms_section(run: EvalRun, terms: Sequence[TermStat] | None, spelling: Spelling | None) -> str:
    head = "<h2>English terms</h2>"
    if spelling is None:
        return head + "<p>No spelling.yaml, so no term accuracy.</p>"
    if not terms:
        return head + "<p>No English terms from spelling.yaml in these references.</p>"
    rows = [[t.term, f"{t.clips:,}", f"{t.total:,}", f"{t.strict} ({t.strict / t.total * 100:.1f} %)",
             f"{t.lenient} ({t.lenient / t.total * 100:.1f} %)", _missed(t)] for t in terms]
    note = (f"Counted with today's spelling.yaml ({len(spelling.terms)} terms), as wt-train eval counts them: "
            "strict means the same form as the reference (deployede for deployede), lenient any form of the "
            "term (deployer for deployede). Missed forms are the reference forms the model's text lacked.")
    stored = run.dataset_summary.get("terms")
    total = term_totals(terms)[0]
    if stored is not None and stored != total:
        note += f" summary.json counted {stored} occurrences, with the spelling.yaml of its day."
    return (head + table(["Term", "Clips", "In references", "Strict right", "Lenient right", "Missed forms"], rows,
                         numeric=(1, 2, 3, 4)) + f'<p class="note">{esc(note)}</p>')


def _errors_fact(row: dict) -> str:
    return (f"{clip_errors(row)} errors in {row['ref_words']} words ({row['sub']} S, {row['del']} D, "
            f"{row['ins']} I)")


def _diff(row: dict) -> str:
    return diff_html(align((row.get("ref_norm") or "").split(), (row.get("hyp_norm") or "").split()))


def clip_section(i: int, row: dict) -> str:
    facts = [_errors_fact(row), f"WER {pct(clip_wer(row), 1)}"] + ([condition_of(row)] if condition_of(row) else [])
    fields = [("Reference", row["reference"]), ("Diff", _diff(row)), ("Model wrote", row.get("hypothesis") or "")]
    if row.get("error"):
        fields.append(("Failed", row["error"]))
    return clip_card(str(row["id"]), f"#{i} {row['id']}", facts, fields, audio_tag(find_wav(row)))


def worst_section(rows: Sequence[dict], n: int) -> str:
    chosen = worst(rows, n)
    if not chosen:
        return "<h2>Worst clips</h2><p>Every clip came out right.</p>"
    note = ('<p class="note">Most word errors first, then the highest WER. The diff is over the normalised words '
            'the WER counts (lower case, numbers as words, no punctuation); "Model wrote" is the text as the '
            'model gave it.</p>')
    return (f"<h2>The {len(chosen)} worst clips</h2>" + note + LEGEND
            + "".join(clip_section(i, r) for i, r in enumerate(chosen, 1)))


METHOD = ("<h2>How the numbers are made</h2><p class=\"note\">Reference and model text are normalised as the "
          "accuracy job does (models/eval: lower case, numbers written as words, punctuation dropped), so capitals "
          "and punctuation do not count. WER is the word edits (substitutions, deletions, insertions) summed over "
          "the clips, divided by the reference words; CER the same over characters. The intervals are 95 % "
          "percentile bootstraps over the clips (1,000 resamples, fixed seed): a new sample of sentences like "
          "these would most likely land in that range. The WER interval is the one wt-train eval wrote to "
          "summary.json.</p>")


def _consistency(run: EvalRun, s: Stats) -> str:
    want = run.dataset_summary
    notes = []
    if want.get("n") is not None and want["n"] != s.n:
        notes.append(f"summary.json counts {want['n']} clips, the rows file {s.n}")
    if want.get("wer") is not None and abs(want["wer"] - s.wer) > 1e-9:
        notes.append(f"summary.json says WER {pct(want['wer'])}, the clip rows give {pct(s.wer)}")
    return f'<p class="worse">{esc("; ".join(notes))}.</p>' if notes else ""


def single_page(run: EvalRun, spelling: Spelling | None, n_worst: int = WORST, tracked_as: str = "") -> str:
    """The page of one run's dataset."""
    s = run_stats(run)
    terms = term_stats(run.rows, spelling) if spelling else None
    model = str(run.summary.get("model") or "?")
    backend = str(run.summary.get("backend") or "?")
    title = f"{run.dataset}: {_short_model(model)}, {BACKENDS.get(backend, backend)}"
    subtitle = (f"{backend} backend, model {model}. Eval run {run.folder.name}, started {_when(run)}"
                + (f", tracked in MLflow as {tracked_as}" if tracked_as else "") + ".")
    body = [headline(s, terms), _consistency(run, s), datasets_table(run),
            "<h2>Per recording condition</h2>", condition_table(run.rows, s, spelling),
            "<h2>Substitutions, deletions and insertions</h2>", edits_table(s), EDITS_NOTE,
            terms_section(run, terms, spelling), worst_section(run.rows, n_worst), METHOD]
    return page(title, "".join(body), subtitle)


# --- the comparison page -----------------------------------------------------------------


def runs_table(a: EvalRun, b: EvalRun, tracked: tuple[str, str]) -> str:
    def facts(run: EvalRun, name: str) -> list[str]:
        return [run.folder.name, _when(run), str(run.summary.get("backend") or "?"), str(run.summary.get("model") or "?"),
                name or "–", f"{len(run.rows):,}"]

    labels = ["Eval run", "Started", "Backend", "Model", "MLflow run", "Clips"]
    fa, fb = facts(a, tracked[0]), facts(b, tracked[1])
    return table(["", "A", "B"], [[label, x, y] for label, x, y in zip(labels, fa, fb)])


def compare_cards(sa: Stats, sb: Stats, delta: Paired, ch: Changes) -> str:
    lo, hi = delta.ci
    return cards([("WER of A", pct(sa.wer), _ci_note(sa.wer_ci)), ("WER of B", pct(sb.wer), _ci_note(sb.wer_ci)),
                  ("Change in WER, A minus B", _pp(delta.value),
                   f"95 %: {lo * 100:+.2f} to {hi * 100:+.2f} pp, paired over {delta.clips:,} clips"),
                  ("Clips", f"{len(ch.worse):,} worse, {len(ch.better):,} better",
                   f"{len(ch.same):,} with as many errors as before")])


def verdict(delta: Paired) -> str:
    lo, hi = delta.ci
    if hi < 0:
        text = "The interval of the change lies below 0: A makes fewer word errors than B on these clips, beyond chance."
    elif lo > 0:
        text = "The interval of the change lies above 0: A makes more word errors than B on these clips, beyond chance."
    else:
        text = ("The interval of the change includes 0: on these clips the two runs cannot be told apart from "
                "chance.")
    return (f'<p class="note">{esc(text)} The interval is paired: both runs\' errors on the same clips are '
            'resampled together, so the sentences\' own difficulty cancels out.</p>')


def _pair_row(label: str, a: str, b: str, delta: float | int | None, text: str, lower_is_better: bool = True):
    return [label, a, b, change(delta, text, lower_is_better) if delta is not None else "–"]


def overall_table(sa: Stats, sb: Stats, ta: Sequence[TermStat] | None, tb: Sequence[TermStat] | None) -> str:
    rows = [_pair_row("WER (95 %)", pct_ci(sa.wer, sa.wer_ci), pct_ci(sb.wer, sb.wer_ci), sa.wer - sb.wer,
                      _pp(sa.wer - sb.wer)),
            _pair_row("CER (95 %)", pct_ci(sa.cer, sa.cer_ci), pct_ci(sb.cer, sb.cer_ci), sa.cer - sb.cer,
                      _pp(sa.cer - sb.cer)),
            _pair_row("Word errors", f"{sa.errors:,}", f"{sb.errors:,}", sa.errors - sb.errors,
                      _signed(sa.errors - sb.errors))]
    (na, sa_t, la), (nb, sb_t, lb) = term_totals(ta or []), term_totals(tb or [])
    if na or nb:
        rows += [_pair_row("English terms, strict", _terms_label(na, sa_t, la)[0], _terms_label(nb, sb_t, lb)[0],
                           sa_t - sb_t, _signed(sa_t - sb_t), lower_is_better=False),
                 _pair_row("English terms, lenient", _terms_label(na, sa_t, la)[1], _terms_label(nb, sb_t, lb)[1],
                           la - lb, _signed(la - lb), lower_is_better=False)]
    rows += [_pair_row("Clips", f"{sa.n:,}", f"{sb.n:,}", None, ""),
             _pair_row("Reference words", f"{sa.words:,}", f"{sb.words:,}", None, ""),
             _pair_row("Failed clips", f"{sa.failed:,}", f"{sb.failed:,}", sa.failed - sb.failed,
                       _signed(sa.failed - sb.failed)),
             _pair_row("Empty transcripts", f"{sa.empty:,}", f"{sb.empty:,}", sa.empty - sb.empty,
                       _signed(sa.empty - sb.empty))]
    return table(["", "A", "B", "Change"], rows, numeric=(1, 2, 3))


def compare_conditions(a: EvalRun, b: EvalRun, sa: Stats, sb: Stats) -> str:
    ga, gb = dict(groups(a.rows)), dict(groups(b.rows))
    labels = list(ga) + [g for g in gb if g not in ga]
    rows = []
    for label in labels:
        pa = sa if len(ga.get(label, [])) == len(a.rows) else (stats(ga[label]) if label in ga else None)
        pb = sb if len(gb.get(label, [])) == len(b.rows) else (stats(gb[label]) if label in gb else None)
        both = pa is not None and pb is not None
        rows.append([label, f"{pa.n:,}" if pa else "–", f"{pb.n:,}" if pb else "–",
                     pct(pa.wer) if pa else "–", pct(pb.wer) if pb else "–",
                     change(pa.wer - pb.wer, _pp(pa.wer - pb.wer)) if both else "–",
                     pct(pa.cer) if pa else "–", pct(pb.cer) if pb else "–",
                     change(pa.cer - pb.cer, _pp(pa.cer - pb.cer)) if both else "–"])
    return table(["Condition", "Clips A", "Clips B", "WER A", "WER B", "Change", "CER A", "CER B", "Change"], rows,
                 numeric=tuple(range(1, 9)))


def compare_edits(sa: Stats, sb: Stats) -> str:
    rows = []
    for label, x, y in (("Substitutions", sa.sub, sb.sub), ("Deletions", sa.dele, sb.dele),
                        ("Insertions", sa.ins, sb.ins), ("All word errors", sa.errors, sb.errors)):
        rows.append([label, f"{x:,}", _share(x, sa.words), f"{y:,}", _share(y, sb.words), change(x - y, _signed(x - y))])
    return table(["Kind", "A", "Share of words", "B", "Share of words", "Change"], rows, numeric=(1, 2, 3, 4, 5))


def compare_terms(ta: Sequence[TermStat] | None, tb: Sequence[TermStat] | None, spelling: Spelling | None) -> str:
    head = "<h2>English terms</h2>"
    if spelling is None:
        return head + "<p>No spelling.yaml, so no term accuracy.</p>"
    da, db_ = {t.term: t for t in ta or []}, {t.term: t for t in tb or []}
    names = list(da) + [n for n in db_ if n not in da]
    if not names:
        return head + "<p>No English terms from spelling.yaml in these references.</p>"
    zero = TermStat("")
    rows = []
    for n in names:
        x, y = da.get(n, zero), db_.get(n, zero)
        rows.append([n, f"{x.total:,}", f"{x.strict}", f"{y.strict}", change(x.strict - y.strict, _signed(x.strict - y.strict),
                                                                            lower_is_better=False),
                     f"{x.lenient}", f"{y.lenient}"])
    return (head + table(["Term", "In references (A)", "Strict A", "Strict B", "Change", "Lenient A", "Lenient B"], rows,
                         numeric=(1, 2, 3, 4, 5, 6))
            + '<p class="note">Counted with today\'s spelling.yaml in both runs, so they are counted alike.</p>')


def pair_section(i: int, pair: tuple[dict, dict]) -> str:
    ra, rb = pair
    d = _delta(pair)
    facts = [f"word errors {clip_errors(rb)} → {clip_errors(ra)} ({d:+d})",
             f"WER {pct(clip_wer(rb), 1)} → {pct(clip_wer(ra), 1)}", f"{ra['ref_words']} words"]
    facts += [condition_of(ra)] if condition_of(ra) else []
    fields = [("Reference", ra["reference"]), ("B", _diff(rb)), ("A", _diff(ra))]
    if rb.get("reference") != ra.get("reference"):
        fields.insert(1, ("Reference in B", rb.get("reference") or ""))
    return clip_card(str(ra["id"]), f"#{i} {ra['id']}", facts, fields, audio_tag(find_wav(ra) or find_wav(rb)))


def _other_changes(pairs: Sequence[tuple[dict, dict]]) -> str:
    if not pairs:
        return ""
    rows = [[str(ra["id"]), f"{clip_errors(rb)}", f"{clip_errors(ra)}",
             change(_delta((ra, rb)), f"{_delta((ra, rb)):+d}"),
             (ra["reference"][:90] + "…") if len(ra["reference"]) > 90 else ra["reference"]] for ra, rb in pairs]
    return ("<h3>The other changed clips</h3>"
            + table(["Clip", "Errors B", "Errors A", "Change", "Reference"], rows, numeric=(1, 2, 3)))


def changed_section(title: str, pairs: Sequence[tuple[dict, dict]], n: int, start: int) -> str:
    if not pairs:
        return f"<h2>{esc(title)}</h2><p>None.</p>"
    shown = pairs[:n]
    more = f", the {len(shown)} largest changes shown with audio" if len(pairs) > n else ""
    return (f"<h2>{esc(title)} ({len(pairs):,}{more})</h2>" + LEGEND
            + "".join(pair_section(start + i, p) for i, p in enumerate(shown))
            + _other_changes(pairs[n:]))


def compare_page(a: EvalRun, b: EvalRun, spelling: Spelling | None, n_worst: int = WORST,
                 tracked: tuple[str, str] = ("", "")) -> str:
    """A against B, on A's dataset."""
    sa, sb = run_stats(a), run_stats(b)
    ta = term_stats(a.rows, spelling) if spelling else None
    tb = term_stats(b.rows, spelling) if spelling else None
    ch = changes(a.rows, b.rows)
    delta = paired_change(ch)
    title = f"{a.dataset}: A against B"
    subtitle = (f"A is {a.folder.name} ({_short_model(str(a.summary.get('model') or '?'))}, "
                f"{a.summary.get('backend')}); B is {b.folder.name} "
                f"({_short_model(str(b.summary.get('model') or '?'))}, {b.summary.get('backend')}). "
                "A change is A minus B: below zero is fewer errors in A.")
    same_text = sum(1 for ra, rb in ch.same if (ra.get("hyp_norm") or "") != (rb.get("hyp_norm") or ""))
    notes = [f"{len(ch.same):,} clips have as many word errors in both runs ({same_text:,} of them with other words)."]
    if ch.only_a or ch.only_b:
        notes.append(f"{len(ch.only_a):,} clips only in A and {len(ch.only_b):,} only in B are not compared.")
    body = [compare_cards(sa, sb, delta, ch), verdict(delta), _consistency(a, sa), _consistency(b, sb),
            "<h2>The two runs</h2>", runs_table(a, b, tracked),
            "<h2>Overall</h2>", overall_table(sa, sb, ta, tb),
            "<h2>Per recording condition</h2>", compare_conditions(a, b, sa, sb),
            "<h2>Substitutions, deletions and insertions</h2>", compare_edits(sa, sb), EDITS_NOTE,
            compare_terms(ta, tb, spelling),
            changed_section("Clips that got worse", ch.worse, n_worst, 1),
            changed_section("Clips that got better", ch.better, n_worst, len(ch.worse[:n_worst]) + 1),
            f'<p class="note">{esc(" ".join(notes))}</p>', METHOD]
    return page(title, "".join(body), subtitle)


# --- MLflow ------------------------------------------------------------------------------


def _local(timestamp: str | None) -> datetime | None:
    """A results.csv timestamp as local wall-clock time, like the folder names."""
    try:
        t = datetime.fromisoformat(timestamp or "")
    except ValueError:
        return None
    return t.astimezone().replace(tzinfo=None) if t.tzinfo else t


def _same_folder(tagged: str, folder: Path) -> bool:
    try:
        return Path(tagged).resolve() == folder
    except OSError:
        return False


def imported_match(run: EvalRun, runs: Sequence):
    """The untagged ``results.csv`` run this folder wrote: same backend, model, dataset and
    WER (two decimals), written after the folder's start; the soonest after it wins."""
    wer = run.dataset_summary.get("wer")
    if wer is None:
        return None
    best = None
    for r in runs:
        tags, params = r.data.tags, r.data.params
        if tags.get("wt.source") != "results.csv" or tags.get("wt.eval_dir"):
            continue
        if (params.get("backend"), params.get("model"), params.get("dataset")) != (
                run.summary.get("backend"), run.summary.get("model"), run.dataset):
            continue
        if abs(r.data.metrics.get("wer_pct", -1.0) - round(wer * 100, 2)) > 1e-6:
            continue
        ended, started = _local(params.get("timestamp")), run.started
        gap = (ended - started).total_seconds() if ended and started else None
        if gap is not None and gap < 0:
            continue
        key = gap if gap is not None else float("inf")
        if best is None or key < best[0]:
            best = (key, r)
    return best[1] if best else None


def tracked_run(run: EvalRun):
    """The MLflow run behind an eval folder, or None: the run tagged with the folder,
    the eval run named after it, or the results.csv row it wrote. The last two are
    tagged ``wt.eval_dir`` with the folder, so the run's name finds it later."""
    if not tracking.enabled():
        return None
    folder = run.folder.resolve()
    runs = tracking.find_runs()
    for r in runs:
        tagged = r.data.tags.get("wt.eval_dir")
        if tagged and _same_folder(tagged, folder):
            return r
    found = next((r for r in runs if r.info.run_name == folder.name and r.data.tags.get("wt.kind") == "eval"
                  and not r.data.tags.get("wt.eval_dir")), None) or imported_match(run, runs)
    if found is not None:
        c, _ = tracking.client()
        c.set_tag(found.info.run_id, "wt.eval_dir", str(folder))
    return found


# --- writing pages -----------------------------------------------------------------------


def page_name(a: EvalRun, b: EvalRun | None = None) -> str:
    """``<folder>.html``; ``<A>-vs-<B>.html`` with each run's time and backend; a dataset
    other than the run's main one adds its name."""
    def short(run: EvalRun) -> str:
        name = run.folder.name
        return "-".join(name.split("-")[:3]) if re.match(r"\d{8}-\d{6}-", name) else name

    extra = "" if a.main_dataset else f"-{_slug(a.dataset)}"
    if b is None:
        return f"{a.folder.name}{extra}.html"
    return f"{short(a)}-vs-{short(b)}{extra}.html"


def write(html: str, target: Path) -> Path:
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(html, encoding="utf-8")
    return target


def open_page(path: Path) -> None:
    webbrowser.open(Path(path).resolve().as_uri())


def _spelling(path) -> Spelling | None:
    return load_spelling(Path(path)) if path and Path(path).is_file() else None


def after_eval(result: dict, run_id: str = "", log=console.log) -> Path | None:
    """``wt-train eval``'s last step: its page in the reports folder, attached to its run.
    A page that cannot be made is reported, never fatal: the evaluation is saved already."""
    try:
        run = load(Path(result["out"]).resolve())
        spelling = _spelling(result.get("spelling"))
        target = write(single_page(run, spelling, tracked_as=run.folder.name if run_id else ""),
                       paths.reports_dir() / page_name(run))
    except Exception as e:  # noqa: BLE001 - see the docstring
        log(f"report: could not write the page ({type(e).__name__}: {e})")
        return None
    attached = tracking.attach(run_id, target, "report") if run_id else False
    log(f"report: {target}" + (" (attached to the MLflow run)" if attached else ""))
    return target


def main(argv: list[str], log=console.log) -> int:
    p = argparse.ArgumentParser(prog="wt-train report", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("run", help="an eval run: its folder, its name under <work>/runs/eval, latest, "
                               "or a tracked MLflow run's name or id")
    p.add_argument("--vs", metavar="RUN", help="compare with this run (B; the first run is A)")
    p.add_argument("--dataset", help="which dataset of the run (default: its main one, not the FLEURS check)")
    p.add_argument("--spelling", type=Path, default=paths.SPELLING_YAML, help="spelling.yaml for the terms")
    p.add_argument("--worst", type=int, default=WORST, help=f"clips shown with audio (default {WORST})")
    p.add_argument("--out", type=Path, help="the page's path (default: <work>/reports/<name>.html)")
    p.add_argument("--no-open", action="store_true", help="do not open the page in the browser")
    a = p.parse_args(argv)
    try:
        first = load(resolve(a.run), a.dataset)
        second = load(resolve(a.vs), first.dataset) if a.vs else None
    except ReportError as e:
        log(f"report: {e}")
        return 1
    spelling = _spelling(a.spelling)
    tracked = tracked_run(first)
    name_a = tracked.info.run_name if tracked is not None else ""
    if second is None:
        html = single_page(first, spelling, a.worst, name_a)
    else:
        other = tracked_run(second)
        html = compare_page(first, second, spelling, a.worst, (name_a, other.info.run_name if other else ""))
    target = write(html, a.out or paths.reports_dir() / page_name(first, second))
    log(f"wrote {target}")
    if tracked is not None and tracking.attach(tracked.info.run_id, target, "report"):
        log(f"attached to MLflow run {tracked.info.run_name} ({tracked.info.run_id})")
    elif tracking.enabled():
        log(f"not attached: no MLflow run for {first.folder.name}")
    if not a.no_open:
        open_page(target)
    return 0
