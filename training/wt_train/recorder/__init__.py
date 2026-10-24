"""``wt-train record``: read the sentences aloud in the browser, one take per sentence.

A local page (127.0.0.1 only) shows one sentence at a time, records the chosen
Mac input raw, and the server trims, resamples to 16 kHz and saves
``training/data/recordings/<id>.wav`` and ``<id>.txt``. See :mod:`.server`
(the page and its API), :mod:`.audio` (trim, resample, checks) and
:mod:`.takes` (files, resume, redo).
"""

from .server import main

__all__ = ["main"]
