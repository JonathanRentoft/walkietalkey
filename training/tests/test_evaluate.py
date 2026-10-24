"""wt-train eval: datasets, the fixed results.csv header, and a gguf run through a fake app."""

import csv
import json
from pathlib import Path

import pytest

import fake_app
from conftest import takes_config, write_fleurs, write_takes
from wt_train import evaluate
from wt_train.config import config_hash, to_dict


def row(**kw):
    base = {c: "" for c in evaluate.RESULT_COLUMNS}
    return {**base, **kw}


def test_results_csv_has_a_fixed_header_and_appends(tmp_path):
    path = tmp_path / "results.csv"
    evaluate.append_result(path, row(backend="hf", n=3))
    evaluate.append_result(path, row(backend="gguf", n=4, notes="a, b"))
    with path.open(newline="") as f:
        rows = list(csv.reader(f))
    assert rows[0] == evaluate.RESULT_COLUMNS
    assert [r[2] for r in rows[1:]] == ["hf", "gguf"] and rows[2][-1] == "a, b"
    other = tmp_path / "other.csv"
    other.write_text("a,b\n1,2\n")
    with pytest.raises(ValueError, match="another header"):
        evaluate.append_result(other, row())


def test_the_committed_results_file_uses_the_header():
    from wt_train import paths

    if paths.RESULTS_CSV.is_file():
        with paths.RESULTS_CSV.open(newline="") as f:
            assert next(csv.reader(f)) == evaluate.RESULT_COLUMNS


def test_datasets_from_a_folder_a_manifest_a_run_and_a_build(tmp_path, make_wav, monkeypatch):
    folder = tmp_path / "clips"
    for i, name in enumerate("abc"):
        make_wav(folder / f"{name}.wav", seed=i)
        (folder / f"{name}.txt").write_text(f"Tekst {name}.", encoding="utf-8")
    make_wav(folder / "orphan.wav", seed=9)
    label, clips = evaluate.load_dataset(str(folder))
    assert label == "clips" and [c.id for c in clips] == ["a", "b", "c"]
    assert [c.id for c in evaluate.load_dataset(str(folder), limit=2)[1]] == ["a", "b"]

    item = {"id": "x1", "audio": str(folder / "a.wav"), "text": "Hej.", "kind": "plain", "source": "recording",
            "audio_sha256": "h", "seconds": 0.5}
    run = tmp_path / "runs" / "exp-1"
    (run / "dataset").mkdir(parents=True)
    (run / "dataset" / "test.jsonl").write_text(json.dumps(item) + "\n")
    label, clips = evaluate.load_dataset("test", run=run)
    assert label == "exp-1:test" and clips[0].reference == "Hej."
    assert evaluate.load_dataset(str(run / "dataset" / "test.jsonl"))[0] == "test"
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    build = tmp_path / "work" / "builds" / "exp"
    build.mkdir(parents=True)
    (build / "validation.jsonl").write_text(json.dumps(item) + "\n")
    assert evaluate.load_dataset("validation", build="exp")[0] == "exp:validation"
    with pytest.raises(ValueError, match="needs --run or --build"):
        evaluate.load_dataset("test")
    with pytest.raises(ValueError, match="unknown dataset"):
        evaluate.load_dataset("nowhere")


def test_fleurs_test_subset_matches_models_eval(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    write_fleurs(tmp_path / "work" / "datasets" / "fleurs-da_dk", "test",
                 [(f"x{i}", f"{3000 + i}", f"Sætning {i}.") for i in range(10)], seed0=40)
    label, clips = evaluate.load_dataset("fleurs-test", limit=3)
    assert label == "fleurs-da_dk-test"
    assert [c.id for c in clips] == ["fleurs-da_dk-3000", "fleurs-da_dk-3003", "fleurs-da_dk-3006"]


def test_gguf_model_ids(tmp_path, monkeypatch):
    monkeypatch.setenv("WT_APP_MODELS_DIR", str(tmp_path / "models"))
    assert evaluate.gguf_model_id("edda-ft-x", None) == "edda-ft-x"
    assert evaluate.gguf_model_id(str(tmp_path / "models" / "edda-ft-y.gguf"), None) == "edda-ft-y"
    with pytest.raises(ValueError, match="not in the app's models folder"):
        evaluate.gguf_model_id(str(tmp_path / "elsewhere" / "m.gguf"), None)
    run = tmp_path / "run"
    run.mkdir()
    with pytest.raises(ValueError, match="not been exported"):
        evaluate.gguf_model_id(None, run)
    (run / "export.json").write_text(json.dumps({"model_id": "edda-ft-z"}))
    assert evaluate.gguf_model_id(None, run) == "edda-ft-z"


def test_gguf_eval_through_the_app_appends_a_row(tmp_path, make_wav, monkeypatch, capsys):
    work = tmp_path / "work"
    monkeypatch.setenv("WT_WORK_DIR", str(work))
    write_fleurs(work / "datasets" / "fleurs-da_dk", "test",
                 [(f"x{i}", f"{3000 + i}", f"Sætning {i}.") for i in range(4)], seed0=40)
    folder = tmp_path / "clips"
    texts = {"a": "Vi deployede den i går.", "b": "Hej med dig."}
    for i, (name, text) in enumerate(texts.items()):
        make_wav(folder / f"{name}.wav", seed=i)
        (folder / f"{name}.txt").write_text(text, encoding="utf-8")
    spelling = tmp_path / "spelling.yaml"
    spelling.write_text("terms:\n  deploy:\n    forms: [deploye, deployede]\n", encoding="utf-8")
    binary, _ = fake_app.install(tmp_path, monkeypatch, batch=True)
    results = tmp_path / "results.csv"
    code = evaluate.main(["--backend", "gguf", "--model", "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
                          "--dataset", str(folder), "--app-bin", str(binary), "--spelling", str(spelling),
                          "--results", str(results), "--notes", "fake app"], log=print)
    assert code == 0
    with results.open(newline="") as f:
        (written,) = list(csv.DictReader(f))
    assert written["backend"] == "gguf" and written["dataset"] == "clips" and written["n"] == "2"
    assert written["wer_pct"] == "0.00" and written["terms"] == "1" and written["term_accuracy_strict_pct"] == "100.00"
    # The FLEURS test regression check ran too (the fake app answers "hej" there).
    assert written["fleurs_n"] == "4" and float(written["fleurs_wer_pct"]) > 0
    assert written["notes"] == "fake app"
    out = capsys.readouterr().out
    assert "fleurs-da_dk-test" in out and "terms strict" in out
    evals = list((work / "runs" / "eval").iterdir())
    assert len(evals) == 1 and (evals[0] / "summary.json").is_file()


def test_result_row_records_the_run_config(tmp_path):
    folder, sentences, spelling = write_takes(tmp_path, 4)
    cfg = takes_config(folder, sentences, spelling, lora={"rank": 4})
    summary = {"n": 2, "wer": 0.1, "wer_ci95": [0.05, 0.2], "cer": 0.05, "terms": 0, "terms_strict": 0,
               "terms_lenient": 0, "term_accuracy_strict": None, "term_accuracy_lenient": None}
    out = evaluate.result_row(backend="lora", model="t-1", dataset="t-1:test", main=summary, fleurs=summary,
                              run_config={"source": str(Path(evaluate.paths.CONFIGS / "x.yaml")),
                                          "config": to_dict(cfg)}, notes="")
    assert out["config"] == "training/configs/x.yaml" and out["config_hash"] == config_hash(cfg)
    assert json.loads(out["lora"])["rank"] == 4
    assert out["wer_pct"] == "10.00" and out["wer_ci95_pct"] == "5.00 to 20.00" and out["term_accuracy_strict_pct"] == ""


def test_lora_backend_merges_the_adapter(tmp_path, tiny_base, fleurs_root):
    import torch

    from wt_train import train
    from wt_train.dataset import build

    folder, sentences, spelling = write_takes(tmp_path, 12)
    cfg = takes_config(folder, sentences, spelling, training={"epochs": 1, "device": "cpu", "learning_rate": 0.05},
                       evaluation={"baseline": False, "max_new_tokens": 4, "batch_size": 4}, lora={"rank": 2})
    b = build(cfg, out_dir=tmp_path / "build", fleurs_root=fleurs_root)
    run = train.run(cfg, base=tiny_base, build=b, runs_root=tmp_path / "runs", cache_root=tmp_path / "cache",
                    log=lambda *_: None)
    merged = evaluate.merged_lora_model(run, tiny_base, torch.float32, "cpu")
    plain = tiny_base.load(torch.float32, "cpu")
    name = "model.decoder.layers.0.fc1.weight"
    assert not torch.equal(dict(merged.named_parameters())[name], dict(plain.named_parameters())[name])
    assert not any("lora" in n for n, _ in merged.named_parameters())
    wavs = [Path(i.audio) for i in b.splits["test"]]
    texts = evaluate.HFTranscriber(merged, tiny_base, "cpu", batch_size=2, max_new_tokens=4).transcribe(wavs)
    assert len(texts) == len(wavs) and all(err is None for _, err in texts)
