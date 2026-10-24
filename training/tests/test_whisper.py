"""Labels as Edda was trained, the two-part encoder, and decoding from cached outputs."""

import numpy as np
import pytest
import torch

from conftest import DA, EOT, NOTIMESTAMPS, SOT, TRANSCRIBE, fake_tokens
from wt_train import whisper


def test_example_is_the_notimestamps_sequence_with_loss_on_the_text_only():
    tokens = fake_tokens()
    inputs, labels = whisper.example(tokens, "hej")
    text = tokens.encode("hej")
    assert inputs == [SOT, DA, TRANSCRIBE, NOTIMESTAMPS, *text]
    # inputs[i] predicts labels[i]: the prompt's own tokens are not trained.
    assert labels == [whisper.IGNORE] * 3 + [*text, EOT]
    assert len(inputs) == len(labels)


def test_overlong_transcripts_are_refused():
    with pytest.raises(ValueError, match="tokens"):
        whisper.example(fake_tokens(), "a" * 60, max_positions=48)


def test_collate_pads_inputs_with_eot_and_labels_with_ignore():
    tokens = fake_tokens()
    inputs, labels = whisper.collate([whisper.example(tokens, "ab"), whisper.example(tokens, "a")], EOT)
    assert inputs.shape == labels.shape == (2, 6)
    assert inputs[1, -1].item() == EOT and labels[1, -1].item() == whisper.IGNORE


def test_encoder_halves_equal_the_encoder(tiny_base):
    model = tiny_base.load(torch.float32, "cpu")
    rng = np.random.default_rng(0)
    feats = torch.from_numpy(whisper.features(tiny_base.feature_extractor,
                                              [rng.standard_normal(8000).astype(np.float32) * 0.1]))
    enc = model.model.encoder
    with torch.no_grad():
        full = enc(feats).last_hidden_state
        assert torch.allclose(whisper.encoder_top(enc, whisper.encoder_bottom(enc, feats, 3), 3), full, atol=1e-6)
        assert torch.allclose(whisper.encoder_top(enc, whisper.encoder_bottom(enc, feats, 1), 1), full, atol=1e-6)


def test_generating_from_encoder_outputs_equals_generating_from_features(tiny_base):
    model = tiny_base.load(torch.float32, "cpu")
    rng = np.random.default_rng(1)
    feats = torch.from_numpy(whisper.features(
        tiny_base.feature_extractor, [rng.standard_normal(n).astype(np.float32) * 0.1 for n in (4000, 9000)]))
    with torch.no_grad():
        hidden = model.model.encoder(feats).last_hidden_state
    a = whisper.generate(model, tiny_base.tokens, input_features=feats, max_new_tokens=10)
    b = whisper.generate(model, tiny_base.tokens, encoder_hidden=hidden, max_new_tokens=10)
    assert a == b and len(a) == 2


def test_pick_device_honours_cpu():
    assert whisper.pick_device("cpu") == "cpu"
    assert whisper.inference_dtype("cpu") == torch.float32
