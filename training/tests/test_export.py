"""Export: names and refusals, the same-text tolerance, the model card, and the whole chain with fakes."""

import json
from pathlib import Path

import pytest
import yaml

import fake_tcpp
from conftest import takes_config, write_takes
from wt_train import export, paths
from wt_train.dataset import build
from wt_train.gguf import read_metadata


def test_metadata_reader(tmp_path):
    path = fake_tcpp.write_gguf(tmp_path / "m.gguf", {"general.name": "Edda", "n": 7, "flag": True,
                                                      "tokens": ["a", "bc"], "ids": [1, 2]})
    assert read_metadata(path) == {"general.name": "Edda", "n": 7, "flag": True, "tokens": ["a", "bc"],
                                   "ids": [1, 2]}
    assert read_metadata(path, {"general.name"}) == {"general.name": "Edda"}
    (tmp_path / "x.gguf").write_bytes(b"nope")
    with pytest.raises(ValueError, match="not a GGUF"):
        read_metadata(tmp_path / "x.gguf")


@pytest.mark.parametrize("slug", ["", "My-Model", "a_b", "a/b", "edda v1"])
def test_bad_slugs_are_refused(slug):
    with pytest.raises(export.ExportError, match="slug"):
        export.model_id(slug)


def test_ids_are_prefixed():
    assert export.model_id("first-1") == "edda-ft-first-1"


def test_the_shipped_edda_and_foreign_files_are_never_replaced(tmp_path):
    with pytest.raises(export.ExportError, match="never replace the shipped"):
        export.check_install_target(tmp_path / paths.SHIPPED_EDDA_FILE, "edda-ft-x", force=True)
    target = tmp_path / "edda-ft-x.gguf"
    export.check_install_target(target, "edda-ft-x", force=False)  # nothing there yet
    fake_tcpp.write_gguf(target, {"stt.variant": "edda-ft-x"})
    with pytest.raises(export.ExportError, match="--force"):
        export.check_install_target(target, "edda-ft-x", force=False)
    export.check_install_target(target, "edda-ft-x", force=True)
    fake_tcpp.write_gguf(target, {"stt.variant": "something-else"})
    with pytest.raises(export.ExportError, match="not written by an export"):
        export.check_install_target(target, "edda-ft-x", force=True)


def test_same_text_tolerance():
    ok = export.compare(["Hej med dig.", "Godt.", "Ja"], ["Hej med dig.", "godt", "Nej"], max_differing=1)
    assert (ok["exact_matches"], ok["normalized_matches"], ok["differing"], ok["passed"]) == (1, 2, 1, True)
    assert [m["index"] for m in ok["mismatches"]] == [1, 2]
    assert not export.compare(["a", "b"], ["x", "y"], max_differing=1)["passed"]


def card_fields():
    keys = ["display_name", "model_id", "file_name", "size_bytes", "sha256", "transcribe_cpp_version", "created",
            "base_repo", "base_revision", "run_name", "config_source", "config_hash", "lora_knobs", "takes_train",
            "rehearsal_train", "validation_clips", "best_epoch", "validation_wer", "baseline_validation_wer",
            "verify_n", "verify_exact", "verify_normalized"]
    return {k: f"<{k}>" for k in keys}


def test_the_model_card_credits_edda_and_whisper_and_carries_the_terms():
    card = export.render_card(paths.MODEL_CARD_TEMPLATE.read_text(encoding="utf-8"), card_fields())
    assert "{{" not in card
    assert "Alexandra Institute (CoRal project), released by Danish" in card and "Apache License 2.0" in card
    assert "OpenAI" in card and "MIT" in card
    assert "impersonate a person" in card and "Attachment A" in card
    assert "decision 18.7" in card
    assert "never uploaded" in card
    with pytest.raises(export.ExportError, match="unknown field"):
        export.render_card("{{nope}}", {})


def test_the_model_card_front_matter_names_the_base_model():
    # Prettier formats the template; unquoted, {{base_repo}} would become "{ { base_repo } }".
    fields = card_fields() | {"base_repo": paths.EDDA_REPO}
    card = export.render_card(paths.MODEL_CARD_TEMPLATE.read_text(encoding="utf-8"), fields)
    front = yaml.safe_load(card.split("---")[1])
    assert front["base_model"] == paths.EDDA_REPO and front["license"] == "apache-2.0"


def test_the_converter_wrapper_registers_the_name_and_runs_upstream_unchanged(tmp_path):
    tools = fake_tcpp.install(tmp_path / "tcpp")
    model = tmp_path / "hf"
    model.mkdir()
    (model / "model.safetensors").write_bytes(b"x")
    (model / "config.json").write_text("{}")
    out = tmp_path / "out" / "m.gguf"
    export.convert(tools, model, out, "edda-ft-a", "Edda finjusteret", paths.EDDA_REPO)
    meta = read_metadata(out)
    assert meta["general.name"] == "Edda finjusteret" and meta["stt.variant"] == "edda-ft-a"
    record = json.loads((out.parent / "converter-argv.json").read_text())
    assert record["argv"][1:] == [str(model), str(out), "--repo-id", paths.EDDA_REPO, "--variant", "edda-ft-a"]
    # The wrapper's folder (wt_train/, which has a gguf.py) must not shadow the converter's imports.
    wt_train_dir = str(Path(export.__file__).parent)
    assert all(Path(p).resolve() != Path(wt_train_dir).resolve() for p in record["sys_path"] if p)


@pytest.fixture
def tiny_run(tmp_path, tiny_base, fleurs_root, monkeypatch):
    from wt_train import train

    monkeypatch.setenv("WT_WORK_DIR", str(tmp_path / "work"))
    monkeypatch.setenv("WT_APP_MODELS_DIR", str(tmp_path / "app-models"))
    folder, sentences, spelling = write_takes(tmp_path, 12)
    cfg = takes_config(folder, sentences, spelling, training={"epochs": 1, "device": "cpu"},
                       evaluation={"max_new_tokens": 4, "batch_size": 4}, lora={"rank": 2},
                       export={"slug": "tiny", "name": "Edda (lille test)", "verify_clips": 2,
                               "max_differing_clips": 0})
    b = build(cfg, out_dir=tmp_path / "build", fleurs_root=fleurs_root)
    return train.run(cfg, base=tiny_base, build=b, log=lambda *_: None)


def test_export_installs_the_model_and_its_card(tmp_path, tiny_run, tiny_base):
    tools = fake_tcpp.install(tmp_path / "tcpp")
    seen = {}

    def same(wavs):
        seen["wavs"] = wavs
        return ["hej"] * len(wavs)

    result = export.export_run(tiny_run, tools=tools, base=tiny_base, reference_texts=same, gguf_texts=same,
                               log=lambda *_: None)
    models = tmp_path / "app-models"
    target = models / "edda-ft-tiny.gguf"
    assert result["model_id"] == "edda-ft-tiny" and result["path"] == str(target)
    assert read_metadata(target, {"general.name", "stt.variant"}) == {"general.name": "Edda (lille test)",
                                                                      "stt.variant": "edda-ft-tiny"}
    card = (models / "edda-ft-tiny.README.md").read_text()
    assert "Edda (lille test)" in card and result["sha256"] in card and tiny_run.name in card
    assert json.loads((tiny_run / "export.json").read_text())["model_id"] == "edda-ft-tiny"
    # The verification used validation clips, the owner's takes first.
    assert len(seen["wavs"]) == 2 and all("recordings" in str(w) for w in seen["wavs"])
    # The merged folder (float16, with the base's tokenizer files) and the F16/Q8_0 work files are gone.
    work = tmp_path / "work" / "exports" / "edda-ft-tiny"
    assert sorted(p.name for p in work.iterdir()) == ["converter-argv.json", "export.json", "verify.json"]
    # A second export needs --force, and then replaces its own file.
    with pytest.raises(export.ExportError, match="--force"):
        export.export_run(tiny_run, tools=tools, base=tiny_base, reference_texts=same, gguf_texts=same,
                          log=lambda *_: None)
    export.export_run(tiny_run, tools=tools, base=tiny_base, reference_texts=same, gguf_texts=same, force=True,
                      keep_intermediate=True, log=lambda *_: None)
    merged = work / "hf"
    assert (merged / "model.safetensors").is_file() and (merged / "tokenizer.json").is_file()
    assert json.loads((merged / "config.json").read_text())["dtype"] == "float16"


def test_a_failed_same_text_check_installs_nothing(tmp_path, tiny_run, tiny_base):
    tools = fake_tcpp.install(tmp_path / "tcpp")
    with pytest.raises(export.ExportError, match="differs from the merged model"):
        export.export_run(tiny_run, tools=tools, base=tiny_base, reference_texts=lambda w: ["hej"] * len(w),
                          gguf_texts=lambda w: ["farvel"] * len(w), log=lambda *_: None)
    assert not (tmp_path / "app-models" / "edda-ft-tiny.gguf").exists()
    assert not (tiny_run / "export.json").exists()
