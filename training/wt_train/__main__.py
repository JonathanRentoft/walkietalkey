"""``wt-train <step> ...``: one entry point for every workbench step.

Each step lives in its own module with a ``main(argv) -> int``; it is imported
only when run, so ``wt-train record`` never loads PyTorch.
"""

from __future__ import annotations

import importlib
import sys

STEPS = {
    "plan": ("wt_train.plan", "give every sentence its recording condition"),
    "record": ("wt_train.recorder", "record the sentences through the app, on the phone or the Mac"),
    "fetch": ("wt_train.fleurs", "download FLEURS da_dk train and test"),
    "build": ("wt_train.dataset", "build train/validation/test splits"),
    "train": ("wt_train.train", "train a LoRA adapter from a YAML config"),
    "eval": ("wt_train.evaluate", "score a model and append to results.csv"),
    "export": ("wt_train.export", "merge, convert to GGUF Q8_0, install in the app and register a version"),
    "use": ("wt_train.use", "switch the app to a model version, or back to edda"),
    "smoke": ("wt_train.smoke", "run the whole chain on 20 FLEURS clips"),
    "ui": ("wt_train.ui", "open the MLflow UI for the tracked runs"),
    "card": ("wt_train.journal", "write a lab-journal page for a run"),
}


def usage() -> str:
    width = max(map(len, STEPS))
    lines = ["usage: wt-train <step> [options]", "", "steps:"]
    lines += [f"  {name:<{width}}  {help_}" for name, (_, help_) in STEPS.items()]
    lines += ["", "wt-train <step> --help shows a step's options."]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if not args or args[0] in ("-h", "--help"):
        print(usage())
        return 0
    step = STEPS.get(args[0])
    if step is None:
        print(f"unknown step: {args[0]}\n\n{usage()}", file=sys.stderr)
        return 2
    module = importlib.import_module(step[0])
    return int(module.main(args[1:]) or 0)


if __name__ == "__main__":
    sys.exit(main())
