"""The app as a transcriber: the batch interface when the binary has it, one call per file otherwise."""

import json

import pytest

import fake_app
from wt_train.app import App, find_app


@pytest.fixture
def clips(tmp_path, make_wav):
    folder = tmp_path / "clips"
    out = []
    for i, name in enumerate(["a", "b", "bad"]):
        out.append(make_wav(folder / f"{name}.wav", seed=i))
        (folder / f"{name}.txt").write_text(f"tekst {name}", encoding="utf-8")
    return out


@pytest.mark.parametrize("batch", [True, False])
def test_transcribe_returns_one_result_per_clip(tmp_path, monkeypatch, clips, batch):
    binary, log = fake_app.install(tmp_path, monkeypatch, batch=batch)
    here = tmp_path / "repo" / "training"
    here.mkdir(parents=True)
    monkeypatch.chdir(here)
    app = App(binary)
    assert app.supports_batch is batch
    seen = []
    results = app.transcribe(clips, "edda-ft-x", progress=lambda done, total: seen.append((done, total)))
    assert [r.text for r in results] == ["TEKST A", "TEKST B", ""]
    assert seen[-1] == (3, 3) and len(seen) == 3
    # The binary ran in a scratch folder: its ../src/bindings.ts never reaches the caller's tree.
    assert not (tmp_path / "repo" / "src").exists()
    assert results[0].error is None and results[2].error
    calls = [json.loads(line) for line in log.read_text().splitlines()]
    work = [c for c in calls if "--model" in c]
    if batch:
        assert len(work) == 1 and work[0][0] == "--transcribe-list" and "--json" in work[0]
    else:
        assert len(work) == 3 and all(c[0] == "-f" and c[c.index("--model") + 1] == "edda-ft-x" for c in work)


def test_check_model_lists_what_is_installed(tmp_path, monkeypatch):
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    app = App(binary)
    assert app.check_model("walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf")["is_downloaded"]
    with pytest.raises(ValueError, match="does not know model"):
        app.check_model("edda-ft-missing")


def test_find_app_prefers_a_binary_with_the_batch_interface(tmp_path, monkeypatch):
    old, _ = fake_app.install(tmp_path, monkeypatch, batch=False)
    monkeypatch.delenv("WT_APP_BIN", raising=False)
    import wt_train.app as app_module

    new_dir = tmp_path / "new"
    new_dir.mkdir()
    new = new_dir / "walkietalkey"
    new.write_text(old.read_text().replace(
        'batch = os.environ.get("FAKE_APP_BATCH") == "1"', "batch = True"), encoding="utf-8")
    new.chmod(0o755)
    monkeypatch.setattr(app_module, "candidates", lambda: [tmp_path / "missing", old, new])
    assert find_app().bin == new
    monkeypatch.setattr(app_module, "candidates", lambda: [old])
    assert find_app().bin == old
    monkeypatch.setenv("WT_APP_BIN", str(tmp_path / "nowhere"))
    with pytest.raises(FileNotFoundError):
        find_app()


def test_the_recorder_hands_its_session_to_the_running_app(tmp_path, monkeypatch):
    # wt-train record: `walkietalkey --training-session <url>` reaches the running app through
    # the single-instance handoff; with no app running the binary exits 3 instead of starting one.
    from wt_train.app import NOT_RUNNING_EXIT, handoff_training

    binary, log = fake_app.install(tmp_path, monkeypatch, batch=True)
    url = "http://127.0.0.1:8765/app/v1#token"
    monkeypatch.setenv("FAKE_APP_TRAINING_EXIT", "0")
    assert handoff_training(url, binary)[0] == "ok"
    assert json.loads(log.read_text().splitlines()[-1]) == ["--training-session", url]
    monkeypatch.setenv("FAKE_APP_TRAINING_EXIT", str(NOT_RUNNING_EXIT))
    status, detail = handoff_training(url, binary)
    assert status == "not_running" and "not running" in detail
    monkeypatch.setenv("FAKE_APP_TRAINING_EXIT", "1")
    assert handoff_training(url, binary)[0] == "failed"
    monkeypatch.delenv("FAKE_APP_TRAINING_EXIT")
    status, detail = handoff_training(url, binary)
    assert status == "unsupported" and "too old" in detail
    assert handoff_training(url, tmp_path / "nowhere")[0] == "missing"
