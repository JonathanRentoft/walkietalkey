"""Stand-ins for transcribe.cpp's converter and quantiser, and a tiny GGUF writer.

The fake converter is a Python module with the upstream converter's interface
(``VARIANT_DISPLAY_NAMES`` and ``main(argv)``); it writes a metadata-only GGUF
with ``general.name`` from the registered display name and ``stt.variant``,
and records its argv. The fake quantiser copies its input.
"""

import sys

GGUF_WRITER = r'''
import struct

def write_gguf(path, kv):
    def s(x):
        b = x.encode("utf-8")
        return struct.pack("<Q", len(b)) + b
    out = b"GGUF" + struct.pack("<IQQ", 3, 0, len(kv))
    for key, value in kv.items():
        out += s(key)
        if isinstance(value, str):
            out += struct.pack("<I", 8) + s(value)
        elif isinstance(value, bool):
            out += struct.pack("<I?", 7, value)
        elif isinstance(value, int):
            out += struct.pack("<II", 4, value)
        elif all(isinstance(v, str) for v in value):
            out += struct.pack("<IIQ", 9, 8, len(value)) + b"".join(s(v) for v in value)
        else:
            out += struct.pack("<IIQ", 9, 5, len(value)) + b"".join(struct.pack("<i", v) for v in value)
    open(path, "wb").write(out)
'''

CONVERTER = GGUF_WRITER + r'''
import json, sys
from pathlib import Path

VARIANT_DISPLAY_NAMES = {"whisper-tiny": "Whisper Tiny"}

def main(argv):
    model_dir, out = Path(argv[1]), Path(argv[2])
    variant = argv[argv.index("--variant") + 1]
    repo = argv[argv.index("--repo-id") + 1]
    assert (model_dir / "model.safetensors").is_file() and (model_dir / "config.json").is_file()
    write_gguf(out, {"general.name": VARIANT_DISPLAY_NAMES[variant], "stt.variant": variant,
                     "general.organization": repo.split("/")[0], "tokenizer.tokens": ["a", "b"],
                     "stt.whisper.suppress_tokens": [1, 2, 3]})
    (out.parent / "converter-argv.json").write_text(json.dumps(argv))
    return 0
'''

QUANTIZE = r'''
import shutil, sys
assert sys.argv[3:] == ["--quant", "Q8_0"], sys.argv
shutil.copyfile(sys.argv[1], sys.argv[2])
'''


def install(root):
    """A fake transcribe.cpp tree under ``root``; returns its Tools."""
    import os

    from wt_train.gguf import Tools

    class FakeTools(Tools):
        def python(self):
            return [sys.executable]

    tools = FakeTools(root)
    tools.converter.parent.mkdir(parents=True, exist_ok=True)
    tools.converter.write_text(CONVERTER, encoding="utf-8")
    tools.quantize.parent.mkdir(parents=True, exist_ok=True)
    tools.quantize.write_text(f"#!{sys.executable}\n" + QUANTIZE, encoding="utf-8")
    os.chmod(tools.quantize, 0o755)
    tools.cli.parent.mkdir(parents=True, exist_ok=True)
    tools.cli.write_text("#!/bin/sh\nexit 1\n")
    os.chmod(tools.cli, 0o755)
    return tools


def write_gguf(path, kv):
    namespace = {}
    exec(GGUF_WRITER, namespace)
    namespace["write_gguf"](path, kv)
    return path
