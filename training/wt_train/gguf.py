"""GGUF metadata, and the transcribe.cpp 0.4.0 tools an export runs.

``read_metadata`` reads the key/value header of a GGUF file (format versions 2
and 3) without loading any tensor, so an export can check the ``general.name``
and ``stt.variant`` it wrote, and refuse to replace a file it did not write.

The tools are the ones models/edda/convert.sh used for the shipped Edda, built
by models/tools/setup-transcribe-cpp.sh in ``<work>/src/transcribe.cpp-0.4.0``
(the setup script runs once when they are missing):

* ``scripts/convert-whisper.py`` in its own uv environment
  (``scripts/envs/whisper``), wrapped by ``convert_gguf.py``;
* ``build/bin/transcribe-quantize`` (F16 -> Q8_0);
* ``build-release/bin/transcribe-cli`` (the release engine, Metal on a Mac).
"""

from __future__ import annotations

import struct
import subprocess
from dataclasses import dataclass
from pathlib import Path

from . import paths

_SCALARS = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}
_STRING, _ARRAY = 8, 9


def _read(f, fmt: str):
    size = struct.calcsize(fmt)
    data = f.read(size)
    if len(data) != size:
        raise ValueError("truncated GGUF header")
    return struct.unpack(fmt, data)[0]


def _string(f) -> str:
    n = _read(f, "<Q")
    return f.read(n).decode("utf-8", errors="replace")


def _value(f, vtype: int, keep: bool):
    if vtype in _SCALARS:
        return _read(f, _SCALARS[vtype])
    if vtype == _STRING:
        return _string(f)
    if vtype == _ARRAY:
        itype, count = _read(f, "<I"), _read(f, "<Q")
        if not keep and itype in _SCALARS:
            f.seek(struct.calcsize(_SCALARS[itype]) * count, 1)
            return None
        items = [_value(f, itype, keep) for _ in range(count)]
        return items if keep else None
    raise ValueError(f"unknown GGUF value type {vtype}")


def read_metadata(path: Path, wanted: set[str] | None = None) -> dict:
    """The header's key/value pairs (only ``wanted`` keys, when given)."""
    out = {}
    with Path(path).open("rb") as f:
        if f.read(4) != b"GGUF":
            raise ValueError(f"{path} is not a GGUF file")
        version = _read(f, "<I")
        if version < 2:
            raise ValueError(f"{path}: GGUF version {version} is not supported")
        _read(f, "<Q")  # tensor count
        for _ in range(_read(f, "<Q")):
            key = _string(f)
            keep = wanted is None or key in wanted
            value = _value(f, _read(f, "<I"), keep)
            if keep:
                out[key] = value
            if wanted is not None and wanted <= out.keys():
                break
    return out


@dataclass(frozen=True)
class Tools:
    root: Path

    @property
    def converter(self) -> Path:
        return self.root / "scripts" / "convert-whisper.py"

    @property
    def converter_env(self) -> Path:
        return self.root / "scripts" / "envs" / "whisper"

    @property
    def quantize(self) -> Path:
        return self.root / "build" / "bin" / "transcribe-quantize"

    @property
    def cli(self) -> Path:
        return self.root / "build-release" / "bin" / "transcribe-cli"

    def python(self) -> list[str]:
        """The command that runs a script inside the converter's environment."""
        return ["uv", "run", "--project", str(self.converter_env), "python"]

    def ready(self) -> bool:
        return self.converter.is_file() and self.quantize.is_file() and self.cli.is_file()


def transcribe_cpp(setup: bool = True, log=print) -> Tools:
    tools = Tools(paths.transcribe_cpp_dir())
    if not tools.ready():
        if not setup:
            raise FileNotFoundError(f"transcribe.cpp {paths.TRANSCRIBE_CPP_VERSION} is not built in {tools.root}")
        log(f"building transcribe.cpp {paths.TRANSCRIBE_CPP_VERSION} in {tools.root} (once) ...")
        subprocess.run(["bash", str(paths.SETUP_TRANSCRIBE_CPP), str(paths.work_dir())], check=True)
    return tools
