"""Progress output: printed and flushed at once, so a log file shows it as it happens."""

from __future__ import annotations


def log(*args) -> None:
    print(*args, flush=True)
