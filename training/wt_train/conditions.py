"""Recording conditions: on which device and in which voice a take is spoken.

The owner dictates mostly into the phone, often whispering at work, so most
training takes come from there. A condition is a device class and a style, and
gets a share of the sentences (the default mix; ``wt-train plan --mix`` sets
another, kept in ``training/data/mix.yaml`` next to the plan):

    phone-whisper   the phone, whispered            40 % of the sentences
    phone-normal    the phone, a normal voice       40 %
    mac-normal      the Mac's own input, normal     20 %
    mac-whisper     the Mac's own input, whispered   0 % (run 7; recorded, built and
                                                     scored like the others once
                                                     the mix gives it a share)

Every take is recorded through the app's own audio path (the phone's dictation
capture, or the Mac's AudioRecordingManager), so a clip is what the model hears.
``wt-train plan`` gives every sentence one condition (``plan.py``); a session
records one condition. Takes from run 4's browser recorder (the top folder of
``training/data/recordings/``) were read on the Mac in a normal voice: they
count as ``mac-normal`` with ``capture: browser``.

Clip metadata names the concrete device too (``iphone``, ``android``, ``mac``):
the device class is what the plan and the evaluation group by.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass

DEVICES = ("phone", "mac")
STYLES = ("normal", "whisper")


@dataclass(frozen=True)
class Condition:
    id: str
    device: str
    style: str
    # Default share of the sentences recorded in this condition (the mix in mix.yaml overrides it).
    share: float
    # How the recorder page names it. TODO(copy)
    label: str


CONDITIONS = (
    Condition("phone-whisper", "phone", "whisper", 0.4, "Telefonen, hvisket"),
    Condition("phone-normal", "phone", "normal", 0.4, "Telefonen, almindelig stemme"),
    Condition("mac-normal", "mac", "normal", 0.2, "Mac'en, almindelig stemme"),
    # Run 7. Last, so the default plan deals exactly as before.
    Condition("mac-whisper", "mac", "whisper", 0.0, "Mac'en, hvisket"),
)
BY_ID = {c.id: c for c in CONDITIONS}
IDS = tuple(BY_ID)
# Run 4's browser takes: the Mac, a normal voice.
BROWSER_CONDITION = "mac-normal"

# The default mix in percent, every condition named (``plan.read_mix``).
DEFAULT_MIX = {c.id: round(c.share * 100) for c in CONDITIONS}

assert sum(DEFAULT_MIX.values()) == 100


def condition(cid: str) -> Condition:
    try:
        return BY_ID[cid]
    except KeyError:
        raise ValueError(f"unknown condition {cid!r}; one of {', '.join(IDS)}") from None


def condition_id(device: str, style: str) -> str:
    """The condition of a device class and a style, e.g. ("phone", "whisper")."""
    for c in CONDITIONS:
        if c.device == device and c.style == style:
            return c.id
    raise ValueError(f"no condition for {device} {style}")


def device_name(device_class: str, platform: str | None = None) -> str:
    """The concrete device in clip metadata: iphone, android or phone; mac or pc."""
    if device_class == "phone":
        return {"ios": "iphone", "android": "android"}.get((platform or "").lower(), "phone")
    if device_class == "mac":
        return "pc" if sys.platform == "win32" else "mac"
    raise ValueError(f"unknown device class {device_class!r}")
