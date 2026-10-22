import json
import stat
import sys
from pathlib import Path

from wt_eval.engine import TranscribeCli


FAKE_CLI = r'''#!{python}
import json, sys
args = sys.argv[1:]
with open(sys.argv[0] + ".args", "w") as f:
    json.dump(args, f)
listing = args[args.index("--batch") + 1]
print(json.dumps({{"type": "batch_header", "load_ms": 12.5}}))
for line in open(listing):
    path = line.strip()
    if path.endswith("bad.wav"):
        print(json.dumps({{"file": path, "error": "decode failed"}}))
        continue
    print(json.dumps({{"file": path, "text": " tekst fra " + path.rsplit("/", 1)[-1] + " ",
                      "mel_ms": 1.0, "encode_ms": 2.0, "decode_ms": 3.0}}))
'''


def make_fake_cli(tmp_path: Path) -> Path:
    cli = tmp_path / "transcribe-cli"
    cli.write_text(FAKE_CLI.format(python=sys.executable))
    cli.chmod(cli.stat().st_mode | stat.S_IEXEC)
    return cli


def test_batch_transcribe_passes_language_backend_and_timestamps(tmp_path):
    cli = make_fake_cli(tmp_path)
    engine = TranscribeCli(cli=cli, backend="metal", timestamps="none", threads=4)
    wavs = [tmp_path / "a.wav", tmp_path / "b.wav"]
    results = engine.transcribe(tmp_path / "model.gguf", wavs, language="da")
    assert [r.text for r in results] == ["tekst fra a.wav", "tekst fra b.wav"]
    assert results[0].compute_ms == 6.0
    args = json.loads(Path(str(cli) + ".args").read_text())
    assert args[args.index("-m") + 1] == str(tmp_path / "model.gguf")
    assert args[args.index("-l") + 1] == "da"
    assert args[args.index("--backend") + 1] == "metal"
    assert args[args.index("--timestamps") + 1] == "none"
    assert args[args.index("--threads") + 1] == "4"
    assert "--batch-jsonl" in args


def test_auto_timestamps_omits_the_flag_like_the_app(tmp_path):
    cli = make_fake_cli(tmp_path)
    engine = TranscribeCli(cli=cli, backend="auto", timestamps="auto")
    engine.transcribe(tmp_path / "m.gguf", [tmp_path / "a.wav"], language="da")
    args = json.loads(Path(str(cli) + ".args").read_text())
    assert "--timestamps" not in args
    assert "--threads" not in args


def test_failed_file_becomes_empty_text_with_error(tmp_path):
    cli = make_fake_cli(tmp_path)
    engine = TranscribeCli(cli=cli)
    results = engine.transcribe(tmp_path / "m.gguf", [tmp_path / "bad.wav"], language="da")
    assert results[0].text == ""
    assert results[0].error == "decode failed"
