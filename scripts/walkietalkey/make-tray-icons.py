#!/usr/bin/env python3
"""Render the tray icons (DESK-95) from the WalkieTalkey mark.

The mark is a solid shape, so every icon is the mark plus a small state glyph:
ready (the mark alone), listening (a dot; a second, fainter dot frame gives the
subtle pulse), transcribing (three dots) and the Secure Input warning (a bar).
macOS shows them as template images (only alpha counts); Windows and Linux pick
the light or dark file by taskbar theme, as Handy did.

Usage: make-tray-icons.py <walkietalkey-mark.svg> <out-dir>
Needs rsvg-convert (Homebrew: librsvg).
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

INK = "#1b1a19"
PAPER = "#faf8f4"
MARK_W, MARK_H = 127.34, 100.0
HEIGHT_PX = 64


def mark_path(svg: str) -> str:
    match = re.search(r'<path[^>]*\sd="([^"]+)"', svg)
    if not match:
        sys.exit("no <path d=...> in the mark SVG")
    return match.group(1)


def glyph(state: str, color: str) -> str:
    x = MARK_W + 22
    if state == "recording":
        return f'<circle cx="{x}" cy="78" r="16" fill="{color}"/>'
    if state == "recording_pulse":
        return f'<circle cx="{x}" cy="78" r="16" fill="{color}" fill-opacity="0.4"/>'
    if state == "transcribing":
        return "".join(
            f'<circle cx="{x - 22 + i * 22}" cy="92" r="7" fill="{color}"/>' for i in range(3)
        )
    if state == "warning":
        return (
            f'<rect x="{x - 6}" y="20" width="12" height="46" rx="6" fill="{color}"/>'
            f'<circle cx="{x}" cy="84" r="7" fill="{color}"/>'
        )
    return ""


def svg_for(path_d: str, state: str, color: str) -> str:
    width = MARK_W + (44 if state != "idle" else 0)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 {width + 4} {MARK_H + 4}">'
        f'<path fill="{color}" d="{path_d}"/>{glyph(state, color)}</svg>'
    )


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    path_d = mark_path(Path(sys.argv[1]).read_text())
    out = Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    # File names are Handy's, so tray.rs keeps working: the plain name is the
    # light icon for dark taskbars, `_dark` the dark icon for light ones.
    states = {
        "idle": "tray_idle",
        "recording": "tray_recording",
        "recording_pulse": "tray_recording_pulse",
        "transcribing": "tray_transcribing",
        "warning": "tray_idle_warning",
    }
    with tempfile.TemporaryDirectory() as tmp:
        for state, name in states.items():
            for suffix, color in (("", PAPER), ("_dark", INK)):
                svg = Path(tmp) / f"{name}{suffix}.svg"
                svg.write_text(svg_for(path_d, state, color))
                png = out / f"{name}{suffix}.png"
                subprocess.run(
                    ["rsvg-convert", "-h", str(HEIGHT_PX), "-o", str(png), str(svg)], check=True
                )
                print(png)
        # Linux "colored" theme and other in-app uses: the ink mark.
        for state, name in (("idle", "walkietalkey"), ("recording", "recording"), ("transcribing", "transcribing")):
            svg = Path(tmp) / f"{name}.svg"
            svg.write_text(svg_for(path_d, state, INK))
            subprocess.run(["rsvg-convert", "-h", "128", "-o", str(out / f"{name}.png"), str(svg)], check=True)
            print(out / f"{name}.png")


if __name__ == "__main__":
    main()
