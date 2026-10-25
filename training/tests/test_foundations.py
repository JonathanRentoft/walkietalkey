"""Run 7's shared pieces: the word alignment behind every diff, the audio
measurements behind the pilot and the check, and the HTML primitives every
report page is built from."""

import base64
import random
import re

import numpy as np
import pytest
import soundfile as sf

from wt_train import align, audiostats, htmlpage
from wt_train.harness import word_errors


# --- align -----------------------------------------------------------------------


def test_the_alignment_shows_every_kind_of_edit():
    ops = align.align("det er en god dag".split(), "ja det var en dag".split())
    assert [(o.kind, o.ref, o.hyp) for o in ops] == [
        ("ins", None, "ja"), ("eq", "det", "det"), ("sub", "er", "var"), ("eq", "en", "en"),
        ("del", "god", None), ("eq", "dag", "dag")]
    assert align.counts(ops) == (1, 1, 1)
    # equally short alignments: substitutions first, as the WER counts them
    assert align.counts(align.align("en god dag".split(), "en dag nu".split())) == (2, 0, 0)


@pytest.mark.parametrize("seed", range(40))
def test_the_alignment_counts_what_the_wer_counts(seed):
    """The diff never disagrees with the numbers: same minimum edits, same tie-breaks."""
    rng = random.Random(seed)
    vocab = ["a", "b", "c", "d", "e"]
    ref = [rng.choice(vocab) for _ in range(rng.randint(0, 12))]
    hyp = [rng.choice(vocab) for _ in range(rng.randint(0, 12))]
    ops = align.align(ref, hyp)
    want = word_errors(ref, hyp)
    assert align.counts(ops) == (want.sub, want.dele, want.ins)
    assert [o.ref for o in ops if o.ref is not None] == ref
    assert [o.hyp for o in ops if o.hyp is not None] == hyp


def test_a_ratio_gets_a_bootstrap_interval_that_holds_its_value():
    errors, totals = [1, 0, 2, 0, 1, 3, 0, 0], [10, 8, 12, 9, 11, 14, 7, 10]
    lo, hi = align.bootstrap_ratio_ci(errors, totals)
    value = sum(errors) / sum(totals)
    assert lo <= value <= hi and lo < hi
    assert align.bootstrap_ratio_ci(errors, totals) == (lo, hi)  # fixed seed
    assert align.bootstrap_ratio_ci([], []) == (0.0, 0.0)


# --- audiostats --------------------------------------------------------------------


def _speech_like(rate=16000, seconds=3.0, level=0.1, noise=0.002, lead=0.8, tail=0.8, seed=0):
    """Room noise, then a burst of 'speech' (amplitude-modulated noise), then noise."""
    rng = np.random.default_rng(seed)
    n = int(rate * seconds)
    x = rng.standard_normal(n) * noise
    a, b = int(rate * lead), n - int(rate * tail)
    t = np.arange(b - a) / rate
    x[a:b] += rng.standard_normal(b - a) * level * (0.6 + 0.4 * np.sin(2 * np.pi * 4 * t))
    return x.astype(np.float32)


def test_a_clean_take_is_measured_level_noise_snr_and_length(tmp_path):
    wav = tmp_path / "take.wav"
    sf.write(wav, _speech_like(), 16000, subtype="PCM_16")
    s = audiostats.measure(wav)
    assert s.seconds == pytest.approx(3.0, abs=0.01)
    assert -25 < s.level_dbfs < -15
    assert -60 < s.noise_dbfs < -45
    assert s.snr_db == pytest.approx(s.level_dbfs - s.noise_dbfs)
    assert s.snr_db > 25
    assert s.peak_dbfs <= 0 and s.peak_dbfs > s.level_dbfs
    assert s.clipped_samples == 0
    assert s.speech_seconds == pytest.approx(1.4, abs=0.2)
    assert not s.cut_start and not s.cut_end and not s.silent


def test_clipping_silence_and_cut_off_takes_are_noticed(tmp_path):
    loud = np.clip(_speech_like(level=1.5), -1, 1)
    sf.write(tmp_path / "loud.wav", loud, 16000, subtype="PCM_16")
    assert audiostats.measure(tmp_path / "loud.wav").clipped_samples > 100
    quiet = (np.random.default_rng(1).standard_normal(32000) * 0.0005).astype(np.float32)
    sf.write(tmp_path / "quiet.wav", quiet, 16000, subtype="PCM_16")
    assert audiostats.measure(tmp_path / "quiet.wav").silent
    cut = _speech_like(lead=0.0, tail=0.0)
    sf.write(tmp_path / "cut.wav", cut, 16000, subtype="PCM_16")
    s = audiostats.measure(tmp_path / "cut.wav")
    assert s.cut_start and s.cut_end


def test_float_wavs_and_other_rates_are_measured_too(tmp_path):
    """FLEURS is float WAV; a pilot setup may hand over anything the app saved."""
    sf.write(tmp_path / "f.wav", _speech_like(rate=22050), 22050, subtype="FLOAT")
    s = audiostats.measure(tmp_path / "f.wav")
    assert s.seconds == pytest.approx(3.0, abs=0.01) and s.snr_db > 25


def test_stats_for_a_group_of_takes(tmp_path):
    paths = []
    for i, level in enumerate((0.05, 0.1, 0.2)):
        paths.append(tmp_path / f"{i}.wav")
        sf.write(paths[-1], _speech_like(level=level, seed=i), 16000, subtype="PCM_16")
    g = audiostats.summarize([audiostats.measure(p) for p in paths])
    assert g["clips"] == 3
    assert g["level_dbfs"] == pytest.approx(audiostats.measure(paths[1]).level_dbfs, abs=0.01)  # median
    assert set(g) >= {"peak_dbfs", "noise_dbfs", "snr_db", "clipped_clips", "silent_clips", "cut_clips",
                      "seconds", "speech_seconds"}


# --- htmlpage -----------------------------------------------------------------------


def test_a_page_is_self_contained_and_escapes_what_it_shows(tmp_path):
    html = htmlpage.page("Rapport <1>", "<p>" + htmlpage.esc("<script>alert(1)</script> & ø") + "</p>")
    assert html.startswith("<!doctype html>") and "<title>Rapport &lt;1&gt;</title>" in html
    assert "&lt;script&gt;alert(1)&lt;/script&gt; &amp; ø" in html
    # nothing from another origin: no external scripts, stylesheets, fonts or images
    assert not re.search(r"""(src|href)=["']https?://""", html)
    assert "<meta charset=\"utf-8\">" in html


def test_audio_is_embedded_as_mp3_and_plays_without_a_server(tmp_path):
    wav = tmp_path / "a.wav"
    sf.write(wav, _speech_like(), 16000, subtype="PCM_16")
    tag = htmlpage.audio_tag(wav)
    m = re.search(r'src="data:audio/mpeg;base64,([A-Za-z0-9+/=]+)"', tag)
    assert tag.startswith("<audio") and "controls" in tag and m
    assert 1000 < len(base64.b64decode(m.group(1))) < 3.0 * 16000 * 2 / 4
    assert htmlpage.audio_tag(tmp_path / "missing.wav").startswith("<span")


def test_the_diff_colours_substitutions_deletions_and_insertions():
    html = htmlpage.diff_html(align.align("det er en god dag".split(), "ja det var en dag".split()))
    assert '<span class="w">det</span>' in html
    assert '<del class="w sub">er</del><ins class="w sub">var</ins>' in html
    assert '<del class="w del">god</del>' in html
    assert '<ins class="w ins">ja</ins>' in html
    assert htmlpage.diff_html(align.align(["<b>"], ["<b>"])) == '<span class="w">&lt;b&gt;</span>'


def test_tables_and_percentages():
    t = htmlpage.table(["Setup", "WER"], [["iphone-whisper", htmlpage.pct(0.0763)], ["<x>", "–"]])
    assert "<th>Setup</th>" in t and "<td>7.63 %</td>" in t and "<td>&lt;x&gt;</td>" in t
    assert htmlpage.pct(None) == "–"
    assert htmlpage.pct_ci(0.0763, (0.071, 0.0818)) == "7.63 % (7.10 to 8.18)"
