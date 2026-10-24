"""The ``wt-train`` entry point lists every step and rejects unknown ones."""

from wt_train.__main__ import STEPS, main


def test_help_lists_every_step(capsys):
    assert main(["--help"]) == 0
    out = capsys.readouterr().out
    for step in STEPS:
        assert f"  {step}" in out


def test_unknown_step_is_an_error(capsys):
    assert main(["fly"]) == 2
    assert "unknown step: fly" in capsys.readouterr().err


def test_recordings_are_git_ignored():
    from wt_train.paths import REPO

    ignored = (REPO / ".gitignore").read_text().splitlines()
    assert "training/data/recordings/" in ignored
    assert "training/work/" in ignored
