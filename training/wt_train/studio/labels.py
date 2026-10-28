"""The few Danish words Værkstedet's server hands the page (the page holds the rest of its
text): a one-line label for every setting of an experiment config (``config.py``), the
pilot's recording setups, the leakage checks of the data screen and the jobs' titles; run 11
adds the evaluations' readable names and what the four first settings of Træning do.

Every field of every dataclass in ``config.py`` has a label here (a test keeps it so);
none has an em dash.
"""

from __future__ import annotations

import re
from datetime import datetime

from .. import paths
from ..conditions import BY_ID

# The sections of a config, as the training screen heads them.
SECTIONS = {
    "base_model": "Grundmodel",
    "data": "Data",
    "rehearsal": "Almindeligt dansk ved siden af",
    "lora": "LoRA-adapteren",
    "training": "Træning",
    "evaluation": "Validering",
    "export": "Eksport",
}

# One line per setting, keyed as ``section.field`` (``name`` alone).
SETTINGS = {
    "name": "Forsøgets navn",
    "base_model.repo": "Grundmodellen, der finjusteres (på Hugging Face)",
    "base_model.revision": "Den præcise udgave af grundmodellen",
    "data.recordings": "Mappen med dine optagelser",
    "data.sentences": "Listen med sætningerne",
    "data.spelling": "Sådan staves de engelske fagord",
    "data.validation_fraction": "Andel af sætningerne, der bruges til at vælge den bedste epoke",
    "data.test_fraction": "Andel af sætningerne, der gemmes til den endelige test",
    "data.seed": "Tal, der bestemmer, hvordan sætningerne fordeles",
    "rehearsal.share": "Andel af træningen, der er almindeligt dansk fra FLEURS",
    "rehearsal.validation_share": "Andel af valideringen, der er almindeligt dansk fra FLEURS",
    "lora.rank": "Hvor meget adapteren kan lære (dens størrelse)",
    "lora.alpha": "Hvor kraftigt det lærte slår igennem",
    "lora.dropout": "Hvor meget der tilfældigt udelades, så modellen ikke lærer udenad",
    "lora.decoder": "Hvilke dele af dekoderen der trænes",
    "lora.projections": "Hvilke dele af opmærksomheden der trænes",
    "lora.encoder_top_layers": "Hvor mange af encoderens øverste lag der også trænes",
    "lora.encoder": "Hvilke dele af de øverste encoderlag der trænes",
    "training.learning_rate": "Hvor store skridt modellen tager, når den lærer",
    "training.warmup_fraction": "Andel af træningen, hvor skridtene langsomt bliver større",
    "training.schedule": "Hvordan skridtene bliver mindre undervejs",
    "training.epochs": "Hvor mange gange modellen hører alle optagelserne",
    "training.batch_size": "Hvor mange optagelser der regnes på ad gangen",
    "training.gradient_accumulation": "Hvor mange portioner der lægges sammen til ét skridt",
    "training.weight_decay": "Hvor meget vægtene trækkes mod nul",
    "training.max_grad_norm": "Loft over hvor stort ét skridt må være",
    "training.seed": "Tal, der gør træningen gentagelig",
    "training.device": "Hvor træningen kører: Mac'ens grafikkort eller processor",
    "evaluation.batch_size": "Hvor mange optagelser der skrives ud ad gangen ved validering",
    "evaluation.max_new_tokens": "Hvor lang en udskrift højst må blive",
    "evaluation.baseline": "Mål grundmodellen før første epoke",
    "export.slug": "Kort navn i modellens id",
    "export.name": "Navnet, appen viser for modellen",
    "export.verify_clips": "Hvor mange optagelser eksporten kontrolleres på",
    "export.max_differing_clips": "Hvor mange af dem der må give en anden tekst",
}

# A pilot setup's name, word by word: the first part names where it records.
SETUP_DEVICES = {
    "iphone": "iPhone",
    "phone": "Telefonen",
    "android": "Android-telefonen",
    "airpods": "AirPods",
    "studio": "Studiemikrofon",
    "mac": "Mac'en",
}
STYLES = {"whisper": "hvisket", "normal": "almindelig stemme"}

# The jobs' titles on the page ("Træning: first-frozen-encoder").
JOBS = {"train": "Træning", "export": "Eksport", "pilot": "Pilotens sammenligning", "report": "Rapport",
        # Run 12: a measurement (kind eval) on the validation, or on the test set.
        "eval": "Måling på valideringen", "test": "Måling på testsættet"}

LEAKAGE = {
    "splits": "Træning, validering og test deler ingen sætninger",
    "fleurs-test": "FLEURS-testen er ikke med i træningen",
    "exam": "Eksamensafsnittene er ikke med",
    "pilot": "Pilotens sætninger er ikke med",
}


def setting(key: str) -> str:
    return SETTINGS[key]


def setup_label(name: str, style: str) -> str:
    """``iphone-whisper`` as "iPhone, hvisket"; a name of the owner's own keeps its first part."""
    first = name.split("-")[0]
    return f"{SETUP_DEVICES.get(first, first)}, {STYLES.get(style, style)}"


# Run 11's words, everything below (approved by the owner in run 12).

# The evaluations' readable names (runs.eval_title): "<model> · <data>".
EVAL_MODELS = {
    "base": "Edda, original",
    "app": "Appen",
    "version": "Edda finjusteret v{n}",
    "lora": "Edda finjusteret ({config})",
    "in_app": "{model} i appen",
    "unknown": "Ukendt model",
}
EVAL_DATA = {
    "fleurs": "FLEURS",
    "own": "Dine optagelser",
    "validation": "Dine optagelser, validering",
    "train": "Dine optagelser, træning",
    "exam": "Dine optagelser, eksamen",
}
# A date in a name that would otherwise be shared: "24. okt.", then "24. okt. kl. 18.54".
MONTHS = ("jan.", "feb.", "mar.", "apr.", "maj", "jun.", "jul.", "aug.", "sep.", "okt.", "nov.", "dec.")

# The four settings a beginner touches first on Træning, in this order, each with what turning
# it up or down does. Every other setting is under "Alle indstillinger".
ESSENTIALS = {
    "training.learning_rate": "Højere: modellen lærer hurtigere, men kan blive ustabil og glemme almindeligt dansk. "
                              "Lavere: roligere, men den skal bruge flere epoker.",
    "training.epochs": "Flere: modellen lærer dine optagelser bedre, men kan lære dem udenad. "
                       "Færre: hurtigere, men den lærer måske for lidt.",
    "lora.rank": "Højere: adapteren kan lære mere, men lærer lettere udenad. "
                 "Lavere: en mindre adapter, der ændrer Edda forsigtigt.",
    "rehearsal.share": "Højere: Edda holder bedre fast i almindeligt dansk, men lærer dine fagord langsommere. "
                       "Lavere: mere af træningen er dine egne optagelser.",
}


_VERSION_ID = re.compile(r"-v(\d+)$")
_RUN_STAMP = re.compile(r"-\d{8}-\d{6}$")


def _model_title(backend: str, model: str, train_run: str | None) -> str:
    m = EVAL_MODELS
    short = model.rsplit("/", 1)[-1].split("@")[0].removesuffix(".gguf")
    if backend == "hf":
        return m["base"] if model.startswith(paths.EDDA_REPO) else (short or m["unknown"])
    if backend == "gguf":
        if model == paths.SHIPPED_EDDA_ID or model.endswith(paths.SHIPPED_EDDA_FILE):
            return m["app"]
        version = _VERSION_ID.search(short)
        if version:
            return m["version"].format(n=int(version.group(1)))
        return m["in_app"].format(model=short) if short else m["unknown"]
    if backend == "lora":
        run = train_run or model
        return m["lora"].format(config=_RUN_STAMP.sub("", run)) if run else m["unknown"]
    return short or m["unknown"]


def model_title(backend: str, model: str, train_run: str | None = None) -> str:
    """The model half of an evaluation's readable name (run 12: a measurement's job title)."""
    return _model_title(backend or "", model or "", train_run)


def _data_title(dataset: str) -> str:
    d = EVAL_DATA
    base, _, condition = dataset.partition("@")
    if base.startswith("fleurs"):
        out = d["fleurs"]
    elif base == "exam":
        out = d["exam"]
    elif ":" in base:
        split = base.rsplit(":", 1)[1]
        out = {"validation": d["validation"], "train": d["train"]}.get(split, d["own"])
    else:
        return dataset or d["own"]
    if condition in BY_ID:
        out += f" ({BY_ID[condition].label})"
    return out


def eval_title(backend: str, model: str, dataset: str, train_run: str | None = None) -> str:
    """An evaluation's readable name (run 11): the model, then the data. "Edda, original ·
    FLEURS" (base Edda through Transformers), "Appen · FLEURS" (the shipped Edda Q8_0 through
    the app), "Edda finjusteret v2 · Dine optagelser" (an exported version through the app),
    "Edda finjusteret (first-frozen-encoder) · Dine optagelser" (a training run's adapter)."""
    return f"{_model_title(backend or '', model or '', train_run)} · {_data_title(dataset or '')}"


def _day(when: datetime) -> str:
    return f"{when.day}. {MONTHS[when.month - 1]}"


def unique_titles(rows: list[dict]) -> list[str]:
    """Each row's ``title``, with its day added where two rows would share it, and its time too
    where they share the day (``when``: the time it was measured, or None)."""
    def counts(names):
        out: dict[str, int] = {}
        for n in names:
            out[n] = out.get(n, 0) + 1
        return out

    titles = [r["title"] for r in rows]
    shared = counts(titles)
    dated = [f"{t} · {_day(r['when'])}" if shared[t] > 1 and r["when"] else t for t, r in zip(titles, rows)]
    again = counts(dated)
    return [f"{t} kl. {r['when']:%H.%M}" if again[t] > 1 and r["when"] and t != base else t
            for t, base, r in zip(dated, titles, rows)]
