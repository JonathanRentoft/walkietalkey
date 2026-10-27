"""The few Danish words Værkstedet's server hands the page (the page holds the rest of its
text): a one-line label for every setting of an experiment config (``config.py``), the
pilot's recording setups, the leakage checks of the data screen and the jobs' titles.

Every field of every dataclass in ``config.py`` has a label here (a test keeps it so);
none has an em dash.
"""

from __future__ import annotations

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
JOBS = {"train": "Træning", "export": "Eksport", "pilot": "Pilotens sammenligning", "report": "Rapport"}

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
