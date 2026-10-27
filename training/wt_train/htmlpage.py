"""HTML primitives for the workbench's report pages (run 7): ``wt-train report``,
``wt-train pilot report``.

Every page is one self-contained file: the styles are inline, the audio is
embedded as MP3 in ``data:`` URLs (about 4 kB per second of speech), and nothing
loads from another origin, so a page opens from disk, from an MLflow artifact or
from an e-mail, and works offline. Text is escaped on the way in; ``Raw`` marks
HTML a caller built itself (a player, a diff).

Run 11: the pages are in Danish, like the rest of Værkstedet, and so are their numbers: a
decimal comma, a point between thousands and a real minus ("6,32 %", "1.041", "−17,7 dBFS",
"95 %: 5,86 til 6,79", "+0,40 point"), and dates as "26. okt. 2026 kl. 17.07".
"""

from __future__ import annotations

import base64
import html
import io
from pathlib import Path
from datetime import datetime
from typing import Iterable, Sequence

from .align import Op
from .studio.labels import MONTHS

MINUS = "\u2212"
# Run 11: which page format a file is. A page without it (English, before run 11) is out of date:
# Værkstedet writes it again instead of showing it.
FORMAT = "wt-train page 2"

CSS = """
:root{--paper:#faf8f4;--card:#fff;--ink:#1b1a19;--muted:#625d56;--line:#e6e0d6;--sub:#f1dcb4;--del:#f3cdc7;
--ins:#cfe2cf;--bad:#9c2f25;--good:#2f6b3a}
@media (prefers-color-scheme:dark){:root{--paper:#171615;--card:#211f1d;--ink:#f4f1ec;--muted:#a9a39a;
--line:#3a3632;--sub:#5a4526;--del:#5c2c27;--ins:#28452c;--bad:#f0a198;--good:#9fd3a6}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",
system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:32px 24px 64px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 12px}h3{font-size:16px;margin:20px 0 8px}
p.sub{color:var(--muted);margin:0 0 24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.card span{color:var(--muted);font-size:13px}
.card small{display:block;color:var(--muted);font-size:12px;margin-top:2px;font-variant-numeric:tabular-nums}
p.note{color:var(--muted);font-size:13px;margin:8px 0 0}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;
overflow:hidden;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:13px}tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;white-space:nowrap}
.table-wrap{overflow-x:auto;border-radius:12px}
.clip{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:12px 0}
.clip header{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;color:var(--muted);font-size:13px}
.clip header b{color:var(--ink);font-size:14px}.clip audio{height:32px;max-width:100%}
.clip dl{display:grid;grid-template-columns:110px 1fr;gap:6px 12px;margin:10px 0 0}
.clip dt{color:var(--muted);font-size:13px}.clip dd{margin:0}
.w{padding:0 2px;border-radius:3px;text-decoration:none}
del.w.sub,del.w.del{background:var(--del);text-decoration:line-through}ins.w.sub{background:var(--sub)}
ins.w.ins{background:var(--ins)}
.legend{display:flex;gap:16px;color:var(--muted);font-size:13px;margin:4px 0 12px}
.better{color:var(--good)}.worse{color:var(--bad)}.muted{color:var(--muted)}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
"""


class Raw(str):
    """HTML built by the caller; inserted as it is."""


def esc(text: object) -> str:
    return html.escape(str(text), quote=True)


def cell(value: object) -> str:
    return value if isinstance(value, Raw) else esc(value)


def page(title: str, body: str, subtitle: str = "") -> str:
    sub = f'<p class="sub">{esc(subtitle)}</p>' if subtitle else ""
    return ("<!doctype html>\n<html lang=\"da\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            f"<meta name=\"generator\" content=\"{FORMAT}\">"
            f"<title>{esc(title)}</title><style>{CSS}</style></head>"
            f"<body><main><h1>{esc(title)}</h1>{sub}{body}</main></body></html>\n")


def num(value: float, digits: int = 1) -> str:
    """A number the Danish way: -1234.5 as "−1.234,5"; never "−0,0"."""
    text = f"{abs(value):,.{digits}f}".replace(",", "\0").replace(".", ",").replace("\0", ".")
    return (MINUS if value < 0 and text.strip("0.,") else "") + text


def count(n: int) -> str:
    """A whole number with points between thousands: 1041 as "1.041"."""
    return num(n, 0)


def signed(n: int) -> str:
    """A change in a count: "+3", "−3", "0"."""
    return f"+{count(n)}" if n > 0 else num(n, 0)


def is_current(path: Path) -> bool:
    """Whether a page on disk is in today's format (``FORMAT``)."""
    try:
        with Path(path).open("rb") as f:
            head = f.read(4096)
    except OSError:
        return False
    return f'<meta name="generator" content="{FORMAT}">'.encode() in head


def pct(value: float | None, digits: int = 2) -> str:
    return "–" if value is None else f"{num(value * 100, digits)} %"


def ci_text(ci: Sequence[float], digits: int = 2, unit: str = "") -> str:
    """A 95 % interval of two fractions in percent: "5,86 til 6,79"."""
    return f"{num(ci[0] * 100, digits)} til {num(ci[1] * 100, digits)}{unit}"


def pct_ci(value: float | None, ci: Sequence[float] | None) -> str:
    if value is None:
        return "–"
    if not ci:
        return pct(value)
    return f"{pct(value)} ({ci_text(ci)})"


def points(delta: float, digits: int = 2) -> str:
    """A change of a fraction in percentage points: "+0,40 point", "−0,40 point", "0,00 point"."""
    text = num(delta * 100, digits)
    return f"{'+' if delta > 0 and text.strip('0.,') else ''}{text} point"


def db(value: float | None, unit: str = "dBFS") -> str:
    if value is None:
        return "–"
    return f"{num(0.0 if abs(value) < 0.05 else value, 1)} {unit}"  # never "−0,0"


def when(moment: datetime | None) -> str:
    """ "26. okt. 2026 kl. 17.07", or "–"."""
    if moment is None:
        return "–"
    return f"{moment.day}. {MONTHS[moment.month - 1]} {moment.year} kl. {moment:%H.%M}"


def table(headers: Sequence[str], rows: Iterable[Sequence[object]], numeric: Sequence[int] = ()) -> str:
    def th(i: int, h: str) -> str:
        return f'<th class="num">{esc(h)}</th>' if i in numeric else f"<th>{esc(h)}</th>"

    def td(i: int, v: object) -> str:
        return f'<td class="num">{cell(v)}</td>' if i in numeric else f"<td>{cell(v)}</td>"

    head = "".join(th(i, h) for i, h in enumerate(headers))
    body = "".join("<tr>" + "".join(td(i, v) for i, v in enumerate(r)) + "</tr>" for r in rows)
    # A wide table (the pilot's thirteen columns) scrolls sideways instead of being cut off.
    return Raw(f'<div class="table-wrap"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>')


def cards(items: Iterable[Sequence[str]]) -> str:
    """Big numbers: ``(label, value)`` or ``(label, value, note)`` per card; the note
    (an interval, a count) goes small under the label."""

    def card(item: Sequence[str]) -> str:
        label, value, *rest = item
        note = f"<small>{esc(rest[0])}</small>" if rest and rest[0] else ""
        return f'<div class="card"><b>{esc(value)}</b><span>{esc(label)}</span>{note}</div>'

    return Raw('<div class="cards">' + "".join(card(i) for i in items) + "</div>")


def change(delta: float | None, text: str, lower_is_better: bool = True) -> str:
    """``text`` (a formatted difference) coloured by whether the change helps: green
    when it goes the good way, red when not, muted when there is none."""
    if not delta:
        return Raw(f'<span class="muted">{esc(text)}</span>')
    good = (delta < 0) == lower_is_better
    return Raw(f'<span class="{"better" if good else "worse"}">{esc(text)}</span>')


def clip_card(anchor: str, title: str, facts: Sequence[object], fields: Sequence[tuple[str, object]],
              audio: str = "") -> str:
    """One clip: a header (title, facts, player) over a list of labelled fields (the
    reference, a diff). ``anchor`` becomes ``id="clip-<anchor>"`` so a page can link to it."""
    head = f"<b>{esc(title)}</b>" + "".join(f"<span>{cell(f)}</span>" for f in facts) + cell(audio)
    body = "".join(f"<dt>{esc(k)}</dt><dd>{cell(v)}</dd>" for k, v in fields)
    return Raw(f'<section class="clip" id="clip-{esc(anchor)}"><header>{head}</header><dl>{body}</dl></section>')


def audio_tag(path: Path | str | None) -> str:
    """An inline player with the clip as MP3 (WAV if MP3 cannot be written)."""
    import soundfile as sf

    if not path or not Path(path).is_file():
        return Raw('<span class="muted">(lyden blev ikke fundet)</span>')
    data, rate = sf.read(str(path), dtype="float32", always_2d=False)
    buf = io.BytesIO()
    try:
        sf.write(buf, data, rate, format="MP3")
        mime = "audio/mpeg"
    except (sf.LibsndfileError, TypeError, ValueError):
        buf = io.BytesIO()
        sf.write(buf, data, rate, format="WAV", subtype="PCM_16")
        mime = "audio/wav"
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return Raw(f'<audio controls preload="none" src="data:{mime};base64,{encoded}"></audio>')


def diff_html(ops: Sequence[Op]) -> str:
    """The model's text against the reference: substituted words as struck-through
    reference plus the model's word, deletions struck through, insertions marked."""
    out = []
    for o in ops:
        if o.kind == "eq":
            out.append(f'<span class="w">{esc(o.hyp)}</span>')
        elif o.kind == "sub":
            out.append(f'<del class="w sub">{esc(o.ref)}</del><ins class="w sub">{esc(o.hyp)}</ins>')
        elif o.kind == "del":
            out.append(f'<del class="w del">{esc(o.ref)}</del>')
        else:
            out.append(f'<ins class="w ins">{esc(o.hyp)}</ins>')
    return Raw(" ".join(out))


# TODO(copy): run 11 drafted every Danish string in this file (the reports' shared words).
LEGEND = Raw('<div class="legend"><span><del class="w sub">sagt</del><ins class="w sub">skrevet</ins> '
             'erstattet</span><span><del class="w del">ord</del> mangler (udeladt)</span>'
             '<span><ins class="w ins">ord</ins> ekstra (tilføjet)</span></div>')
