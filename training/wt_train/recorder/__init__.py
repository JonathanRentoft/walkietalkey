"""``wt-train record``: read the sentences aloud through the app, one condition per session.

The recorder runs a local page (127.0.0.1 only) that shows the sentence and the
progress. The WalkieTalkey app on this Mac connects out to it with a per-session
token and records each take through its own audio path: on the phone, through the
existing pairing, end-to-end encrypted like a dictation; on the Mac, through the
app's own input. The app hands over the 16 kHz audio as received; the recorder
checks it and saves it with its metadata. See :mod:`.server` (the page and the
app's API), :mod:`.session` (prompts, takes, redo), :mod:`.takes` (files),
:mod:`.checks` and :mod:`.audio`.
"""


def main(argv: list[str]) -> int:
    from .server import main as run

    return run(argv)


__all__ = ["main"]
