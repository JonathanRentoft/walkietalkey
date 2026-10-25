"""HTML primitives for the workbench's report pages (run 7): ``wt-train report``,
``wt-train pilot report``.

Every page is one self-contained file: the styles are inline, the audio is
embedded as MP3 in ``data:`` URLs (about 4 kB per second of speech), and nothing
loads from another origin, so a page opens from disk, from an MLflow artifact or
from an e-mail, and works offline. Text is escaped on the way in; ``Raw`` marks
HTML a caller built itself (a player, a diff).
"""

from __future__ import annotations

import base64
import html
import io
from pathlib import Path
from typing import Iterable, Sequence

from .align import Op

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
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;
overflow:hidden;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:13px}tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right;white-space:nowrap}
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
    return ("<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            f"<title>{esc(title)}</title><style>{CSS}</style></head>"
            f"<body><main><h1>{esc(title)}</h1>{sub}{body}</main></body></html>\n")


def pct(value: float | None, digits: int = 2) -> str:
    return "–" if value is None else f"{value * 100:.{digits}f} %"


def pct_ci(value: float | None, ci: Sequence[float] | None) -> str:
    if value is None:
        return "–"
    if not ci:
        return pct(value)
    return f"{pct(value)} ({ci[0] * 100:.2f} to {ci[1] * 100:.2f})"


def db(value: float | None, unit: str = "dBFS") -> str:
    return "–" if value is None else f"{value:.1f} {unit}"


def table(headers: Sequence[str], rows: Iterable[Sequence[object]], numeric: Sequence[int] = ()) -> str:
    def th(i: int, h: str) -> str:
        return f'<th class="num">{esc(h)}</th>' if i in numeric else f"<th>{esc(h)}</th>"

    def td(i: int, v: object) -> str:
        return f'<td class="num">{cell(v)}</td>' if i in numeric else f"<td>{cell(v)}</td>"

    head = "".join(th(i, h) for i, h in enumerate(headers))
    body = "".join("<tr>" + "".join(td(i, v) for i, v in enumerate(r)) + "</tr>" for r in rows)
    return Raw(f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>")


def cards(items: Iterable[tuple[str, str]]) -> str:
    return Raw('<div class="cards">' + "".join(
        f'<div class="card"><b>{esc(v)}</b><span>{esc(k)}</span></div>' for k, v in items) + "</div>")


def audio_tag(path: Path | str | None) -> str:
    """An inline player with the clip as MP3 (WAV if MP3 cannot be written)."""
    import soundfile as sf

    if not path or not Path(path).is_file():
        return Raw('<span class="muted">(audio not found)</span>')
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


LEGEND = Raw('<div class="legend"><span><del class="w sub">said</del><ins class="w sub">written</ins> '
             'substituted</span><span><del class="w del">word</del> missing (deleted)</span>'
             '<span><ins class="w ins">word</ins> added (inserted)</span></div>')
