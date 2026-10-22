import json
import stat
import sys
from pathlib import Path

from tests.test_datasets import write_wav
from wt_eval.cli import main

# A fake engine that "hears" a fixed text per file name.
FAKE_CLI = r'''#!{python}
import json, sys
args = sys.argv[1:]
listing = args[args.index("--batch") + 1]
model = args[args.index("-m") + 1]
texts = {{"a.wav": "God dag.", "b.wav": "hej med dig"}}
print(json.dumps({{"type": "batch_header", "load_ms": 1.0}}))
for line in open(listing):
    path = line.strip()
    name = path.rsplit("/", 1)[-1]
    text = texts.get(name, "")
    if "bad" in model:
        text = "noget helt andet"
    print(json.dumps({{"file": path, "text": text, "mel_ms": 1, "encode_ms": 1, "decode_ms": 1}}))
'''


def setup(tmp_path: Path):
    cli = tmp_path / "transcribe-cli"
    cli.write_text(FAKE_CLI.format(python=sys.executable))
    cli.chmod(cli.stat().st_mode | stat.S_IEXEC)
    fleurs = tmp_path / "fleurs"
    (fleurs / "test").mkdir(parents=True)
    (fleurs / "test.tsv").write_text(
        "1\ta.wav\tGod dag.\tgod dag\tx\t16000\tMALE\n"
        "2\tb.wav\tHej med dig.\thej med dig\tx\t16000\tMALE\n",
        encoding="utf-8",
    )
    for n in ("a.wav", "b.wav"):
        write_wav(fleurs / "test" / n)
    return cli, fleurs


def test_run_writes_per_clip_rows_and_summary(tmp_path):
    cli, fleurs = setup(tmp_path)
    out = tmp_path / "out"
    rc = main([
        "run", "--cli", str(cli), "--fleurs-dir", str(fleurs), "--out", str(out),
        "--model", f"good={tmp_path / 'good.gguf'}", "--model", f"bad={tmp_path / 'bad.gguf'}",
    ])
    assert rc == 0
    summary = json.loads((out / "summary.json").read_text())
    good = summary["models"]["good"]
    assert good["clips"] == 2
    assert good["wer"] == 0.0
    # "God dag." has 1 mark in 2 words; "hej med dig" has none -> 1 of 2 clips trigger PnC
    assert good["pnc_trigger_clips"] == 1
    assert good["pnc_trigger_rate"] == 0.5
    assert good["marks_per_25_words"] == 1 / 5 * 25
    bad = summary["models"]["bad"]
    assert bad["wer"] == 1.0 + 1 / 5  # 5 ref words, 5 substitutions + 1 insertion
    rows = [json.loads(l) for l in (out / "good.jsonl").read_text().splitlines()]
    assert rows[0]["id"] == "fleurs-da_dk-a" and rows[0]["errors"] == 0
    table = (out / "summary.md").read_text()
    assert "| good |" in table and "| bad |" in table


def test_clips_dir_is_used_instead_of_fleurs(tmp_path):
    cli, _ = setup(tmp_path)
    own = tmp_path / "own"
    own.mkdir()
    write_wav(own / "a.wav")
    (own / "a.txt").write_text("God dag.", encoding="utf-8")
    out = tmp_path / "out"
    rc = main(["run", "--cli", str(cli), "--clips-dir", str(own), "--out", str(out),
               "--model", f"good={tmp_path / 'good.gguf'}"])
    assert rc == 0
    summary = json.loads((out / "summary.json").read_text())
    assert summary["dataset"]["name"] == "clips-dir"
    assert summary["models"]["good"]["clips"] == 1


def test_score_recomputes_summary_from_rows(tmp_path):
    cli, fleurs = setup(tmp_path)
    out = tmp_path / "out"
    main(["run", "--cli", str(cli), "--fleurs-dir", str(fleurs), "--out", str(out),
          "--model", f"good={tmp_path / 'good.gguf'}"])
    first = json.loads((out / "summary.json").read_text())
    (out / "summary.json").unlink()
    assert main(["score", str(out)]) == 0
    again = json.loads((out / "summary.json").read_text())
    assert again["models"] == first["models"]
