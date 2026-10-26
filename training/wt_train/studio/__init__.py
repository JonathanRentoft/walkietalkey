"""``wt-train studio``: Værkstedet, the training workbench as a small local app.

The owner opens it with one click (the launcher, ``training/studio/launcher/``) or from
the terminal; it serves a page on 127.0.0.1 and opens the browser. Everything the
workbench does is a screen there: recording through the app, with every take checked
as it comes in (and base Edda listening); the data and its splits; training with live
curves; evaluations and their pages; model versions; the lab journal. The contract
between the page and the server is ``training/studio/API.md``.

See :mod:`.server` (routes, guards, starting and stopping), :mod:`.recording` (the
recording screen), :mod:`.review` (each take's checks and the Edda worker),
:mod:`.sources`, :mod:`.data`, :mod:`.training`, :mod:`.runs`, :mod:`.notebook`,
:mod:`.jobs`, :mod:`.build`, :mod:`.places` and :mod:`.labels`.
"""


def main(argv: list[str]) -> int:
    from .server import main as run

    return run(argv)


__all__ = ["main"]
