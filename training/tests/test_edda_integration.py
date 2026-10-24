"""Checks against the real Edda snapshot. Opt-in (they load 1.6 GB): set
WT_TRAIN_INTEGRATION=1 and WT_WORK_DIR to a work folder that holds dl/edda-v0.2."""

import os
from pathlib import Path

import pytest

from wt_train import paths

pytestmark = pytest.mark.skipif(
    os.environ.get("WT_TRAIN_INTEGRATION") != "1"
    or not (paths.snapshot_dir(paths.EDDA_REPO, paths.EDDA_REVISION) / "model.safetensors").is_file(),
    reason="opt-in: WT_TRAIN_INTEGRATION=1 with the Edda snapshot in the work folder",
)

CLIP = paths.REPO / "models" / "clips" / "da-fleurs-10s.wav"


@pytest.fixture(scope="module")
def edda():
    from wt_train.whisper import load_base

    return load_base(paths.EDDA_REPO, paths.EDDA_REVISION)


def test_labels_match_the_tokenizers_own_notimestamps_sequence(edda):
    from transformers import WhisperTokenizer

    from wt_train.whisper import IGNORE, example

    tok = WhisperTokenizer.from_pretrained(edda.path)
    tok.set_prefix_tokens(language="da", task="transcribe", predict_timestamps=False)
    text = "Vi deployede PR'en til staging i går."
    full = tok(text).input_ids
    inputs, labels = example(edda.tokens, text)
    assert inputs == full[:-1]
    assert labels == [IGNORE] * 3 + full[4:]


def test_cached_encoder_outputs_decode_like_audio(edda):
    import torch

    from wt_train import audio, whisper

    device = whisper.pick_device("auto")
    dtype = whisper.inference_dtype(device)
    model = edda.load(dtype, device)
    feats = torch.from_numpy(whisper.features(edda.feature_extractor, [audio.read_16k_mono(CLIP)])).to(device, dtype)
    enc = model.model.encoder
    with torch.inference_mode():
        hidden = whisper.encoder_top(enc, whisper.encoder_bottom(enc, feats, 32), 32)
        reference = enc(feats).last_hidden_state
    assert torch.allclose(hidden.float(), reference.float(), atol=1e-2)
    cached = torch.from_numpy(hidden.float().cpu().numpy().astype("float16")).to(device, dtype)
    a = whisper.generate(model, edda.tokens, input_features=feats)
    b = whisper.generate(model, edda.tokens, encoder_hidden=cached)
    expected = (Path(CLIP).with_suffix(".txt")).read_text(encoding="utf-8").strip()
    assert a == b
    from wt_train.harness import normalize

    assert normalize(a[0]) == normalize(expected)
