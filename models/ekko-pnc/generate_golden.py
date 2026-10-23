"""Generate models/ekko-pnc/golden.json with the reference tool.

Every output comes from ekko-stt's own `ekko.Punctuator` (0.1.2, onnxruntime
1.29.0, tokenizers 0.22.2) with its defaults (128-token windows, 12 words of
overlap). crates/ekko-pnc must reproduce each one exactly.

    models/ekko-pnc/download.sh <pnc-dir>
    models/eval/fetch_fleurs.sh <data-dir>          # for the long inputs
    cd models/ekko-pnc && uv run python generate_golden.py <pnc-dir> <data-dir>/fleurs-da_dk/test.tsv

Inputs: hand-written dictation-style text (Danish, mixed Danish/English,
numbers, casing, abbreviations, odd whitespace and characters), plus long
unpunctuated inputs built from FLEURS da_dk test transcriptions (google/fleurs,
CC BY 4.0) that span several windows.
"""

from __future__ import annotations

import csv
import hashlib
import json
import platform
import sys
from importlib.metadata import version
from pathlib import Path

from ekko import Punctuator

HANDWRITTEN: list[tuple[str, str]] = [
    ("readme-example", "hej mit navn er emil hvordan går det i dag jeg har været på kontoret og bagefter skal jeg hjem"),
    ("request", "kan du sende mig rapporten inden fredag så jeg kan nå at læse den igennem"),
    ("maybe-tomorrow", "jeg tror ikke vi når det i dag men vi kan prøve i morgen tidlig"),
    ("meeting-moved", "mødet er flyttet til torsdag klokken ti i det store mødelokale"),
    ("question-pair", "hvad synes du om det nye design er det for mørkt eller passer det fint"),
    ("thanks", "tak for i går det var en rigtig hyggelig aften"),
    ("shopping", "husk at købe mælk æg og brød på vej hjem"),
    ("mixed-deploy", "vi skal have deployet den nye version før standup i morgen"),
    ("mixed-pull-request", "kan du lave en pull request så jeg kan reviewe koden inden vi merger til main"),
    ("mixed-switch", "the meeting is at three but jeg kommer nok lidt for sent"),
    ("mixed-frontend", "har du set den nye frontend den ser virkelig godt ud synes jeg"),
    ("self-correction", "nej vent det var onsdag ikke torsdag"),
    ("fillers", "øh jeg ved ikke helt hvad jeg skal sige øhm måske kan vi tale om det senere"),
    ("price", "prisen er 249 kroner og 95 øre inklusive moms"),
    ("sales-figures", "vi har solgt 1.250 enheder i år mod 980 sidste år det er en stigning på 27 procent"),
    ("train-times", "toget kører klokken 7.45 fra københavn h og er fremme i aarhus klokken 10.30"),
    ("phone-number", "ring til mig på 12 34 56 78 hvis der er noget"),
    ("date-ordinal", "den 3. januar 2027 starter projektet officielt"),
    ("decimal-comma", "renten steg fra 3,5 til 4,25 procent i løbet af 2023"),
    ("already-cased", "Hej Emil hvordan går det med projektet"),
    ("brand-casing", "iPhone og MacBook virker fint men min iPad er gået i stykker"),
    ("acronyms", "DR og TV 2 sendte begge nyheder om valget i aftes"),
    ("abbreviation", "f.eks. kan vi bruge den gamle løsning indtil videre"),
    ("email-url", "send en mail til jonathan@example.com eller besøg walkietalkey.com"),
    ("single-word", "hej"),
    ("empty", ""),
    ("whitespace-only", "   \t  "),
    ("yes", "ja"),
    ("okay", "okay det lyder godt"),
    ("danish-letters", "æblerne i haven er modne nu så vi skal plukke dem i weekenden"),
    ("why-question", "hvorfor er det altid mig der skal rydde op efter festen"),
    ("agreement", "jeg er helt enig med dig i at det er en god ide at vente"),
    ("exclamation", "det er simpelthen fantastisk at vi endelig har fået lov"),
    ("server-down", "kan du ikke lige tjekke om serveren kører den har været nede siden i morges"),
    ("english-only", "first we need to fix the bug then we can ship the release"),
    ("booking", "jeg har booket et møde med kunden på mandag klokken 13 og sendt dem en agenda"),
    ("never-came", "hun sagde at hun ville komme men hun kom aldrig"),
    ("odd-whitespace", "hej  med\tdig\nhvordan går det　i dag"),
    ("python-only-whitespace", "hej\u001cmed\u001fdig"),
    ("pre-punctuated", "hej, jeg hedder anna. hvad hedder du"),
    ("over-long-word", "dette er et meget langt ord " + "x" * 120 + " og så videre"),
    ("control-char-word", "hej \u0007 dig og farvel"),
    ("emoji", "det var sjovt 😀 vi ses i morgen"),
    ("hyphenated", "et e-mail-baseret system til to-faktor-godkendelse er på vej"),
    ("quotes", 'han sagde "kom nu" og gik sin vej'),
    ("german-eszett", "straße und weg sind wörter"),
    ("ligature", "ﬁnn var den første der kom"),
    ("long-dictation-mixed",
     "okay så jeg tænkte vi kunne starte med at gennemgå status på projektet vi har haft en travl uge "
     "hvor teamet har arbejdet på den nye onboarding og der er stadig et par bugs der skal fikses før vi "
     "kan lave en release candidate peter har kigget på performance problemerne i backend og han mener at "
     "det skyldes en database query der ikke bruger det rigtige index det burde være en hurtig fix men vi "
     "skal lige teste det ordentligt på staging før vi deployer det til produktion derudover har vi fået "
     "feedback fra tre kunder der alle sammen synes at det nye dashboard er meget nemmere at bruge end det "
     "gamle men en af dem savnede muligheden for at eksportere data til excel så det har jeg lagt ind som en "
     "feature request i backloggen jeg foreslår at vi tager den med i næste sprint hvis der er plads til det "
     "til sidst vil jeg bare minde jer om at vi har julefrokost fredag den 12. december og at tilmeldingen "
     "lukker på mandag så skynd jer at skrive jer på listen hvis i ikke allerede har gjort det har nogen "
     "spørgsmål eller skal vi bare komme i gang"),
    ("long-numbers",
     "budgettet for 2027 er på 4,2 millioner kroner hvilket er en stigning på 12 procent i forhold til 2026 "
     "den største post er lønninger som udgør 2,7 millioner efterfulgt af husleje på 640.000 kroner og it på "
     "380.000 kroner vi forventer at ansætte 3 nye medarbejdere i første kvartal og 2 mere i tredje kvartal "
     "hvis omsætningen fortsætter med at vokse med omkring 8 procent om året kan vi gå i nul allerede i 2028 "
     "men det kræver at vi holder omkostningerne under 350.000 kroner om måneden og at vi lander mindst 15 nye "
     "kunder inden udgangen af juni regnskabet for 2026 viser et underskud på 1,1 millioner kroner hvilket er "
     "cirka 300.000 kroner mindre end vi havde budgetteret med i januar og det skyldes primært at vi udskød to "
     "ansættelser til efteråret"),
]


def fleurs_long_inputs(tsv: Path) -> list[tuple[str, str]]:
    """Unpunctuated runs of FLEURS normalised transcriptions (column 4),
    distinct sentences in sentence-id order: 12, 30 and 60 sentences."""
    seen: dict[int, str] = {}
    with tsv.open(encoding="utf-8", newline="") as f:
        for row in csv.reader(f, delimiter="\t", quoting=csv.QUOTE_NONE):
            if len(row) >= 4 and int(row[0]) not in seen:
                seen[int(row[0])] = row[3].strip()
    sentences = [seen[k] for k in sorted(seen)]
    return [
        ("fleurs-12-sentences", " ".join(sentences[0:12])),
        ("fleurs-30-sentences", " ".join(sentences[12:42])),
        ("fleurs-60-sentences", " ".join(sentences[42:102])),
    ]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    pnc_dir, tsv = Path(sys.argv[1]), Path(sys.argv[2])
    pnc = Punctuator(pnc_dir)
    cases = []
    for source, items in (("handwritten", HANDWRITTEN), ("fleurs-da_dk-test", fleurs_long_inputs(tsv))):
        for name, text in items:
            words = text.split()
            tokens = len(pnc.tokenizer.encode(words, is_pretokenized=True).ids) if words else 0
            cases.append({
                "name": name, "source": source, "input": text, "output": pnc(text),
                "words": len(words), "tokens": tokens,
            })
    golden = {
        "schema": "walkietalkey-ekko-pnc-golden-v1",
        "generator": {
            "script": "models/ekko-pnc/generate_golden.py",
            "ekko_stt": version("ekko-stt"),
            "onnxruntime": version("onnxruntime"),
            "tokenizers": version("tokenizers"),
            "python": platform.python_version(),
            "platform": f"{platform.system()} {platform.machine()}",
        },
        "model": {
            "repo": "RyeAI/ekko-pnc",
            "revision": "d3129544e4e0155093e192cac58a9e69a4dea1ff",
            "files": {n: sha256(pnc_dir / n) for n in ("pnc.int8.onnx", "tokenizer.json", "config.json")},
        },
        "options": {"max_length": pnc.max_length, "overlap_words": pnc.overlap_words},
        "attribution": "Inputs with source fleurs-da_dk-test are FLEURS (google/fleurs, da_dk, test) "
                       "transcriptions, CC BY 4.0. The other inputs are written for this test set.",
        "cases": cases,
    }
    out = Path(__file__).with_name("golden.json")
    out.write_text(json.dumps(golden, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    long = sum(1 for c in cases if c["tokens"] > pnc.max_length)
    print(f"wrote {out}: {len(cases)} cases, {long} longer than {pnc.max_length} tokens")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
