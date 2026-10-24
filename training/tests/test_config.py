"""Experiment configs load strictly: unknown keys and bad values are errors."""

import pytest

from wt_train import paths
from wt_train.config import ConfigError, config_from_dict, config_hash, key_knobs, load_config, to_dict, with_overrides

SHIPPED = sorted(paths.CONFIGS.glob("*.yaml"))


def test_the_shipped_configs_load():
    names = {p.stem for p in SHIPPED}
    assert {"first-frozen-encoder", "top4-encoder", "smoke"} <= names
    for path in SHIPPED:
        cfg = load_config(path)
        assert cfg.name == path.stem
        assert cfg.base_model.repo == paths.EDDA_REPO and cfg.base_model.revision == paths.EDDA_REVISION
        assert cfg.source == path.resolve()


def test_the_shipped_configs_set_every_knob():
    """Every knob is written out (and commented) in the shipped configs."""
    import yaml

    full = to_dict(config_from_dict({"name": "x"}))
    for path in SHIPPED:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        for section, fields in full.items():
            if isinstance(fields, dict):
                assert set(raw[section]) == set(fields), f"{path.name}: {section}"


def test_first_experiment_freezes_the_encoder_and_the_variant_adapts_four_layers():
    assert load_config(paths.CONFIGS / "first-frozen-encoder.yaml").lora.encoder_top_layers == 0
    assert load_config(paths.CONFIGS / "top4-encoder.yaml").lora.encoder_top_layers == 4
    smoke = load_config(paths.CONFIGS / "smoke.yaml")
    assert smoke.training.epochs == 1 and smoke.export.slug == "smoke"


def test_floats_written_like_1e_4_are_numbers():
    cfg = config_from_dict({"name": "x", "training": {"learning_rate": "1e-4"}})
    assert cfg.training.learning_rate == pytest.approx(1e-4)


@pytest.mark.parametrize(
    "raw, message",
    [
        ({"name": "x", "lora": {"rnak": 8}}, "unknown key lora.rnak"),
        ({"name": "x", "extra": 1}, "unknown key extra"),
        ({"name": "X y"}, "name"),
        ({}, "name: is required"),
        ({"name": "x", "lora": {"rank": 0}}, "lora.rank"),
        ({"name": "x", "lora": {"rank": 8.5}}, "lora.rank: must be a whole number"),
        ({"name": "x", "lora": {"rank": True}}, "lora.rank: must be a whole number"),
        ({"name": "x", "lora": {"decoder": ["self_attn", "mlp"]}}, "unknown mlp"),
        ({"name": "x", "lora": {"decoder": []}}, "lora.decoder"),
        ({"name": "x", "lora": {"encoder_top_layers": 40}}, "encoder_top_layers"),
        ({"name": "x", "lora": {"dropout": 1.0}}, "lora.dropout"),
        ({"name": "x", "data": {"validation_fraction": 0.5, "test_fraction": 0.5}}, "leave something"),
        ({"name": "x", "data": {"validation_fraction": 0}}, "validation_fraction"),
        ({"name": "x", "rehearsal": {"share": 1.0}}, "rehearsal.share"),
        ({"name": "x", "training": {"learning_rate": "fast"}}, "learning_rate: must be a number"),
        ({"name": "x", "training": {"schedule": "step"}}, "schedule"),
        ({"name": "x", "training": {"device": "cuda"}}, "device"),
        ({"name": "x", "base_model": {"revision": "main"}}, "40-character"),
        ({"name": "x", "export": {"slug": "My Model"}}, "export.slug"),
        ({"name": "x", "export": {"verify_clips": 2, "max_differing_clips": 3}}, "max_differing_clips"),
        ({"name": "x", "evaluation": {"max_new_tokens": 500}}, "max_new_tokens"),
        ({"name": "x", "lora": "big"}, "lora: must be a mapping"),
    ],
)
def test_bad_configs_are_rejected(raw, message):
    with pytest.raises(ConfigError, match=message):
        config_from_dict(raw)


def test_load_config_names_the_file(tmp_path):
    path = tmp_path / "bad.yaml"
    path.write_text("name: x\nlora:\n  rnak: 8\n", encoding="utf-8")
    with pytest.raises(ConfigError, match=r"bad\.yaml: unknown key lora\.rnak"):
        load_config(path)


def test_hash_follows_the_knobs_not_the_comments(tmp_path):
    a = tmp_path / "a.yaml"
    b = tmp_path / "b.yaml"
    a.write_text("name: x\nlora:\n  rank: 8\n", encoding="utf-8")
    b.write_text("# a comment\nname: x\nlora:\n  rank: 8  # same\n", encoding="utf-8")
    assert config_hash(load_config(a)) == config_hash(load_config(b))
    assert config_hash(load_config(a)) != config_hash(with_overrides(load_config(a), lora={"rank": 16}))
    assert len(config_hash(load_config(a))) == 12


def test_data_paths_default_and_resolve_relative_to_training(tmp_path):
    cfg = config_from_dict({"name": "x"})
    assert cfg.data.path("recordings") == paths.RECORDINGS
    cfg = config_from_dict({"name": "x", "data": {"sentences": "data/other.csv", "spelling": str(tmp_path)}})
    assert cfg.data.path("sentences") == paths.TRAINING / "data" / "other.csv"
    assert cfg.data.path("spelling") == tmp_path


def test_overrides_are_checked_again():
    cfg = config_from_dict({"name": "x"})
    assert with_overrides(cfg, training={"epochs": 1}).training.epochs == 1
    with pytest.raises(ConfigError):
        with_overrides(cfg, training={"epochs": 0})


def test_key_knobs_for_results_csv():
    knobs = key_knobs(config_from_dict({"name": "x", "lora": {"rank": 4}}))
    assert knobs["rank"] == 4 and knobs["encoder_top_layers"] == 0 and "rehearsal_share" in knobs
