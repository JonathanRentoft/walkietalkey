/* The fake studio for `vite --mode fake` (fake-api.ts) and the tests: every request of
   training/studio/API.md answered from fixtures, with a little state so the buttons do what the
   real server does. A phone session records by itself, a training draws its loss, jobs run for a
   few seconds. Dev only: nothing here is in the built page. */
import type {
  ConditionOption,
  DataView,
  DiffOp,
  EvalRun,
  Job,
  Journal,
  JournalPage,
  LastTake,
  LearnListing,
  LearnNotebook,
  Limits,
  Overview,
  Pick,
  Pilot,
  PilotComparison,
  PilotSetup,
  Point,
  Progress,
  RecordingOptions,
  RecordingState,
  Row,
  Take,
  TrainingConfig,
  TrainingProgress,
  TrainingRun,
  TrainingState,
  Versions,
} from "./types.ts";

/* ------------------------------------------------------------- helpers */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;

/** Local time as ISO 8601 with its offset, as the server writes it. */
export function iso(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(off / 60)}:${pad(off % 60)}`
  );
}

/** Words as align.py normalises them: lower case, no punctuation. */
export function normalise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/* ------------------------------------------------------------ sentences */

// From training/data/sentences.csv and pilot.csv.
export const SENTENCES: [string, "plain" | "terms"][] = [
  ["Hvor længe skal tokens gælde, før man skal logge ind igen?", "terms"],
  [
    "Deadlines er fine, men de skal komme fra dem, der laver arbejdet.",
    "terms",
  ],
  ["Vercel er nemt at starte med, men det kan blive dyrt.", "terms"],
  ["Hunden vil ikke ud, når det regner.", "plain"],
  ["Featuren er slået fra indtil videre.", "terms"],
  [
    "Vi har skrevet hele den nye app i TypeScript og React, og det har været en god oplevelse.",
    "terms",
  ],
  ["Jeg elsker, når det dufter af regn på varm asfalt.", "plain"],
  ["Skal vi slå de commits sammen, før vi merger?", "terms"],
  ["Deploy ikke om fredagen, medmindre det er en akut rettelse.", "terms"],
  ["Staging er nede, så vi kan ikke prøve noget i øjeblikket.", "terms"],
  ["Fiskesuppen på kroen i Ribe er værd at køre efter.", "plain"],
  [
    "Vi deployer kun om formiddagen, så der er folk på arbejde, hvis noget går galt.",
    "terms",
  ],
  ["Vi har lavet et internt API til at sende beskeder.", "terms"],
  ["Det er den varmeste sommer, jeg kan huske.", "plain"],
  ["Hvor mange PR'er har du åbne lige nu?", "terms"],
  ["Vi har brug for et nyt endpoint til at hente fakturaer.", "terms"],
  ["Frontenden er lavet i React, og backenden kører på Node.", "terms"],
  ["Morgensolen kommer ind ad køkkenvinduet om sommeren.", "plain"],
  ["Kan du give mig adgang til staging, så jeg kan prøve det selv?", "terms"],
  ["Generer et nyt token, det gamle er lækket i en skærmoptagelse.", "terms"],
  ["Vi grillede pølser og majs i haven i går.", "plain"],
  ["Jeg har slået featuren fra igen, fordi kunderne klagede.", "terms"],
  ["Prod har været nede i ti minutter.", "terms"],
  ["Vi får et crash, hver gang nogen sender en stor fil.", "terms"],
  ["Har du husket at købe gave til din søsters fødselsdag?", "plain"],
  ["Der er så mange previews, at vi snart løber tør for plads.", "terms"],
  ["Jeg har flyttet domænet til Vercel, men mailen virker stadig.", "terms"],
  ["Hunden skal til dyrlæge på fredag klokken halv ni.", "plain"],
  ["Kubernetes er nok for meget, men kunden insisterer.", "terms"],
  ["Åbn projektet i VS Code.", "terms"],
  [
    "Jeg har givet din pull request et hurtigt review og skrevet to kommentarer.",
    "terms",
  ],
  ["I morgen bliver det op til 25 grader i København.", "plain"],
  ["API'et svarer med en tom liste i stedet for en fejl.", "terms"],
  ["Kan du mocke API'et, så vi kan teste frontenden alene?", "terms"],
  ["Husk, at vi skifter til sommertid på søndag.", "plain"],
  ["Vi har hævet timeouten.", "terms"],
  [
    "Frontenden er klar, men backenden mangler stadig to endpoints, før det hele hænger sammen.",
    "terms",
  ],
  ["Migrationen er kørt uden fejl.", "terms"],
  ["Min bil har kørt 180.000 kilometer.", "plain"],
  [
    "Vi skal have en rollback klar, før vi releaser, for sidste gang gik det galt midt om natten.",
    "terms",
  ],
  [
    "Tauri-appen er skrevet i Rust, og frontenden i den er en almindelig React-app.",
    "terms",
  ],
  ["Vi skal have gæster til middag lørdag aften.", "plain"],
  [
    "Claude Code kan ikke se vores hemmelige nøgler, og sådan skal det blive.",
    "terms",
  ],
  [
    "React-komponenten genindlæser hele listen, hver gang man skriver et bogstav.",
    "terms",
  ],
];

export const PILOT_SENTENCES: [string, "plain" | "terms"][] = [
  ["Jeg har pushet rettelsen til branchen, så du kan reviewe den nu.", "terms"],
  ["Mødet med kunden er flyttet til torsdag klokken ti.", "plain"],
  ["Buildet fejler på CI'en, fordi der mangler en dependency.", "terms"],
  [
    "Husk at sende fakturaen til bogholderiet inden udgangen af måneden.",
    "plain",
  ],
  [
    "Vi deployer den nye feature til staging i eftermiddag og til prod i morgen.",
    "terms",
  ],
  ["Jeg holder fri i næste uge, så skriv til Mette, hvis det haster.", "plain"],
  [
    "Endpointet giver en timeout, når databasen har travlt om morgenen.",
    "terms",
  ],
  [
    "Tak for et godt møde i går, jeg sender et referat i løbet af dagen.",
    "plain",
  ],
  [
    "Jeg har oprettet et issue i Linear og skrevet til resten af holdet i Slack.",
    "terms",
  ],
  ["Kan vi rykke vores samtale til efter frokost?", "plain"],
  [
    "Kan du merge PR'en i eftermiddag, så vi kan lave en release i morgen?",
    "terms",
  ],
  [
    "Budgettet for næste år skal godkendes af ledelsen, før vi kan ansætte flere.",
    "plain",
  ],
];

const EXAM_PARAGRAPHS = [
  "Vi har haft en travl uge. Mandag flyttede vi hele backenden til en ny server, og tirsdag opdagede vi, at loggen ikke kom med. Det er rettet nu, men husk at tjekke dashboardet, før du går hjem.",
  "Min mormor bager stadig rugbrød hver lørdag. Hun bruger den samme surdej, som hun har haft i tredive år, og hun siger, at hemmeligheden er tålmodighed og lidt for meget salt.",
  "Når du laver en pull request, så skriv kort, hvad den gør, og hvorfor. Link til issuet, og tilføj et skærmbillede, hvis du har ændret noget i brugerfladen.",
  "Toget til Aarhus var forsinket i morges, så jeg nåede ikke mødet klokken ni. Jeg har skrevet til Mette, og vi tager det i stedet over video efter frokost.",
  "Vores API svarer langsomt, når mange brugere logger ind på samme tid. Vi tror, det er databasen, så vi prøver at lægge en cache foran og måle igen på fredag.",
  "Om sommeren cykler jeg på arbejde langs vandet. Det tager en halv time, og det er den bedste del af dagen, især når solen lige er stået op.",
  "Husk at opdatere dine dependencies, før du releaser. Sidst glemte vi det, og så fejlede buildet på CI'en midt om natten.",
  "Vi skal have gæster på lørdag, så jeg handler ind fredag eftermiddag. Kan du købe vin og blomster på vejen hjem?",
];

/* -------------------------------------------------------------- conditions */

interface ConditionDef {
  id: string;
  label: string;
  device: "phone" | "mac";
  style: "whisper" | "normal";
  share: number;
  planned: number;
}

export const CONDITIONS: ConditionDef[] = [
  {
    id: "phone-whisper",
    label: "Telefonen, hvisket",
    device: "phone",
    style: "whisper",
    share: 40,
    planned: 416,
  },
  {
    id: "phone-normal",
    label: "Telefonen, almindelig stemme",
    device: "phone",
    style: "normal",
    share: 40,
    planned: 416,
  },
  {
    id: "mac-normal",
    label: "Mac'en, almindelig stemme",
    device: "mac",
    style: "normal",
    share: 20,
    planned: 209,
  },
  {
    id: "mac-whisper",
    label: "Mac'en, hvisket",
    device: "mac",
    style: "whisper",
    share: 0,
    planned: 0,
  },
];

export const PILOT_SETUPS: PilotSetup[] = [
  {
    name: "iphone-whisper",
    label: "iPhone, hvisket",
    device: "phone",
    style: "whisper",
    done: 12,
    total: 12,
    suggested: true,
  },
  {
    name: "iphone-normal",
    label: "iPhone, almindelig stemme",
    device: "phone",
    style: "normal",
    done: 12,
    total: 12,
  },
  {
    name: "mac-normal",
    label: "MacBook-mikrofonen, almindelig stemme",
    device: "mac",
    style: "normal",
    done: 12,
    total: 12,
    suggested: true,
  },
  {
    name: "mac-whisper",
    label: "MacBook-mikrofonen, hvisket",
    device: "mac",
    style: "whisper",
    done: 7,
    total: 12,
  },
  {
    name: "airpods-normal",
    label: "AirPods, almindelig stemme",
    device: "mac",
    style: "normal",
    done: 12,
    total: 12,
  },
  {
    name: "studio",
    label: "Studiemikrofon",
    device: "mac",
    style: "normal",
    done: 0,
    total: 12,
  },
];

export const LIMITS: Record<"whisper" | "normal", Limits> = {
  // check.LOUD_DBFS for a whisper; good is 5 dB above quiet to 6 dB below loud (API.md).
  whisper: {
    quiet_dbfs: -50,
    silent_dbfs: -62,
    loud_dbfs: -25,
    good_dbfs: [-45, -31],
  },
  normal: {
    quiet_dbfs: -35,
    silent_dbfs: -50,
    loud_dbfs: -6,
    good_dbfs: [-30, -12],
  },
};

/* ------------------------------------------------------------------ takes */

function envelope(seed: number, level: number, noise: number): number[] {
  const r = rng(seed);
  const out: number[] = [];
  const start = 4 + Math.floor(r() * 3);
  const end = 44 - Math.floor(r() * 4);
  for (let i = 0; i < 48; i++) {
    if (i < start || i > end) out.push(round(noise - 2 + r() * 4));
    else {
      const wobble = Math.sin(i * 0.9 + seed) * 5 + (r() - 0.5) * 8;
      out.push(round(Math.min(-1, level + wobble)));
    }
  }
  return out;
}

function eqDiff(text: string): DiffOp[] {
  return normalise(text).map((w) => ({ op: "eq", ref: w, hyp: w }));
}

/** A diff with a substitution at word i (and optionally a deletion or an insertion). */
function diffWith(
  text: string,
  edits: { sub?: [number, string]; del?: number; ins?: [number, string] },
): DiffOp[] {
  const ops: DiffOp[] = [];
  normalise(text).forEach((w, i) => {
    if (edits.ins && edits.ins[0] === i)
      ops.push({ op: "ins", ref: null, hyp: edits.ins[1] });
    if (edits.sub && edits.sub[0] === i)
      ops.push({ op: "sub", ref: w, hyp: edits.sub[1] });
    else if (edits.del === i) ops.push({ op: "del", ref: w, hyp: null });
    else ops.push({ op: "eq", ref: w, hyp: w });
  });
  return ops;
}

/** Edda's text as the app writes it: a capital first letter and a full stop, like a dictation. */
function heardFrom(diff: DiffOp[]): string {
  const words = diff
    .filter((d) => d.op !== "del")
    .map((d) => d.hyp)
    .join(" ");
  return words ? `${words[0].toUpperCase()}${words.slice(1)}.` : "";
}

function werOf(diff: DiffOp[]): number {
  const ref = diff.filter((d) => d.op !== "ins").length || 1;
  const errors = diff.filter((d) => d.op !== "eq").length;
  return round(errors / ref, 4);
}

interface TakeSpec {
  folder: string;
  id: string;
  text: string;
  seed: number;
  style: "whisper" | "normal";
  microphone: string;
  at: number;
  n?: number;
  level?: number;
  peak?: number;
  noise?: number;
  problems?: Take["problems"];
  diff?: DiffOp[] | null;
  transcribing?: boolean;
  eddaError?: string | null;
  review?: Take["review"];
}

function makeTake(s: TakeSpec): Take {
  const r = rng(s.seed * 7 + 3);
  const base = s.style === "whisper" ? -38 : -21;
  const level = s.level ?? round(base + (r() - 0.5) * 8);
  const noise =
    s.noise ?? round((s.style === "whisper" ? -62 : -58) + (r() - 0.5) * 4);
  const peak = s.peak ?? round(level + 14 + r() * 8);
  const diff = s.diff === undefined ? eqDiff(s.text) : s.diff;
  const words = normalise(s.text).length;
  return {
    n: s.n ?? 1,
    url: `/api/takes/${s.folder}/${s.id}.wav`,
    seconds: round(0.9 + words * 0.38 + r() * 0.6),
    recorded_at: iso(s.at),
    microphone: s.microphone,
    level_dbfs: level,
    peak_dbfs: peak,
    noise_dbfs: noise,
    snr_db: round(level - noise),
    envelope: envelope(s.seed, level, noise),
    problems: s.problems ?? [],
    transcribing: s.transcribing ?? false,
    heard: diff ? heardFrom(diff) : null,
    wer: diff ? werOf(diff) : null,
    diff,
    edda_error: s.eddaError ?? null,
    review:
      s.review === undefined ? { status: "approved", by: "check" } : s.review,
  };
}

/* ------------------------------------------------------------------- rows */

export interface SessionSpec {
  pick: Pick;
  folder: string;
  texts: [string, string][];
  microphone: string;
}

/** The phone-whisper session in progress of API.md: every row status, every kind of check. */
export function phoneWhisperRows(now: number): Row[] {
  const folder = "phone-whisper";
  const mic = "iPhone-mikrofon";
  const rows: Row[] = [];
  for (let i = 0; i < 120; i++) {
    const [text, kind] = SENTENCES[i % SENTENCES.length];
    const id = `s${String(i + 1).padStart(4, "0")}`;
    rows.push({
      id,
      text,
      kind,
      status: "waiting",
      skipped: false,
      take: null,
    });
  }
  const at = (i: number) => now - (20 - i) * 41_000;
  const spec = (i: number, extra: Partial<TakeSpec> = {}): Take =>
    makeTake({
      folder,
      id: rows[i].id,
      text: rows[i].text,
      seed: i + 1,
      style: "whisper",
      microphone: mic,
      at: at(i),
      ...extra,
    });
  for (let i = 0; i < 15; i++) {
    rows[i].status = "approved";
    rows[i].take = spec(i);
  }
  // A word heard as another (s0002), a missing word (s0005), an extra word (s0008).
  rows[1].take = spec(1, {
    diff: diffWith(rows[1].text, { sub: [0, "deadline"] }),
  });
  rows[4].take = spec(4, {
    diff: diffWith(rows[4].text, { sub: [0, "featuren"], del: 3 }),
  });
  rows[7].take = spec(7, {
    diff: diffWith(rows[7].text, { sub: [4, "comits"], ins: [5, "lige"] }),
  });
  // Warnings only: kept (s0003 loud, s0006 noisy).
  rows[2].take = spec(2, {
    level: -22,
    peak: -2.5,
    problems: [{ kind: "loud", detail: "-2 dBFS peak" }],
  });
  rows[5].take = spec(5, {
    noise: -48,
    problems: [{ kind: "noisy", detail: "SNR 9 dB" }],
  });
  // Sent back by the check, then approved by the owner (s0010).
  rows[9].take = spec(9, {
    level: -52.4,
    problems: [{ kind: "quiet", detail: "-52 dBFS" }],
    review: { status: "approved", by: "owner" },
  });
  // Edda could not listen (s0012): the audio checks alone decided.
  rows[11].take = spec(11, {
    diff: null,
    eddaError: "batch interface missing",
    review: { status: "approved", by: "check" },
  });
  // Sent back by the check (s0016): too quiet and Edda heard something else.
  rows[15].status = "redo";
  rows[15].take = spec(15, {
    level: -53.1,
    problems: [
      { kind: "quiet", detail: "-53 dBFS" },
      { kind: "mismatch", detail: "WER 0.40" },
    ],
    diff: diffWith(rows[15].text, { sub: [5, "en"], del: 7 }),
    review: { status: "redo", by: "check" },
  });
  // Sent back by the owner (s0017).
  rows[16].status = "redo";
  rows[16].take = spec(16, { review: { status: "redo", by: "owner" } });
  // Received, Edda is listening (s0018).
  rows[17].status = "received";
  rows[17].take = spec(17, { diff: null, transcribing: true, review: null });
  // Recording now (s0019); s0021 was skipped this round.
  rows[18].status = "recording";
  rows[20].skipped = true;
  return rows;
}

function freshRows(spec: SessionSpec, done: number, now: number): Row[] {
  const style = spec.pick.style;
  return spec.texts.map(([text, kind], i) => {
    const id =
      spec.pick.kind === "pilot"
        ? `pilot-${String(i + 1).padStart(2, "0")}`
        : kind === "exam"
          ? `e${String(i + 1).padStart(2, "0")}`
          : `s${String(i + 1).padStart(4, "0")}`;
    const row: Row = {
      id,
      text,
      kind,
      status: "waiting",
      skipped: false,
      take: null,
    };
    if (i < done) {
      row.status = "approved";
      row.take = makeTake({
        folder: spec.folder,
        id,
        text,
        seed: 100 + i,
        style,
        microphone: spec.microphone,
        at: now - (done - i) * 50_000,
      });
    }
    return row;
  });
}

/* --------------------------------------------------------------- reports */

export function reportHtml(name: string): string {
  return `<!doctype html><html lang="da"><head><meta charset="utf-8"><title>${name}</title>
<style>body{font:16px/1.5 -apple-system,sans-serif;margin:32px;color:#1b1a19;background:#fff}
table{border-collapse:collapse}td,th{border-bottom:1px solid #e6e0d6;padding:6px 12px;text-align:left}
.bar{height:10px;background:#356ea6;border-radius:0 4px 4px 0}</style></head><body>
<h1>Rapport (falsk)</h1><p>Denne side kommer fra den falske API: <code>${name}</code>.</p>
<table><tr><th>Datasæt</th><th>WER</th><th></th></tr>
<tr><td>fleurs-da_dk-test</td><td>6,72 %</td><td><div class="bar" style="width:134px"></div></td></tr>
<tr><td>dine optagelser, test</td><td>11,9 %</td><td><div class="bar" style="width:238px"></div></td></tr></table>
<p id="js">Scripts kører ikke.</p><script>document.getElementById("js").textContent="Scripts kører i rapporten.";</script>
</body></html>`;
}

export const PLOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240">
<rect width="640" height="240" fill="#ffffff"/><g stroke="#ece7df"><line x1="48" y1="40" x2="620" y2="40"/><line x1="48" y1="110" x2="620" y2="110"/><line x1="48" y1="180" x2="620" y2="180"/></g>
<path d="M48,50 C150,90 230,120 330,140 S520,170 620,176" fill="none" stroke="#356ea6" stroke-width="2"/>
<g fill="#b5772f"><circle cx="48" cy="70" r="4"/><circle cx="238" cy="120" r="4"/><circle cx="428" cy="146" r="4"/><circle cx="620" cy="160" r="4"/></g>
<text x="48" y="220" font-family="sans-serif" font-size="13" fill="#625d56">Tab pr. trin (falsk plot)</text></svg>`;

/** A short WAV (16 kHz mono PCM) so the play buttons have something to play. */
export function wav(seconds = 1.2, seed = 1): Uint8Array {
  const rate = 16000;
  const n = Math.floor(seconds * rate);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) =>
    [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  const f = 180 + (seed % 7) * 20;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const env = Math.sin((Math.PI * i) / n) * (0.6 + 0.4 * Math.sin(t * 9));
    v.setInt16(
      44 + i * 2,
      Math.round(Math.sin(2 * Math.PI * f * t) * env * 5000),
      true,
    );
  }
  return new Uint8Array(buf);
}

/* ------------------------------------------------------------ the rest */

function trainLossPoints(upTo: number): Point[] {
  const r = rng(42);
  const out: Point[] = [];
  for (let s = 1; s <= upTo; s++) out.push([s, round(trainLossAt(s, r), 3)]);
  return out;
}
function trainLossAt(step: number, r: () => number): number {
  return 0.72 + 1.25 * Math.exp(-step / 26) + (r() - 0.5) * 0.18;
}

const CONFIG_SETTINGS = (
  name: string,
  epochs: number,
  lr: number,
  frozen: boolean,
  val: number,
): TrainingConfig => ({
  name,
  file: `configs/${name}.yaml`,
  settings: [
    {
      key: "name",
      section: null,
      section_label: null,
      value: name,
      label: "Forsøgets navn; datasættet og kørslerne hedder det samme",
    },
    {
      key: "base_model.repo",
      section: "base_model",
      section_label: "Grundmodel",
      value: "danish-foundation-models/edda-v0.2",
      label: "Den model, træningen starter fra",
    },
    {
      key: "base_model.revision",
      section: "base_model",
      section_label: "Grundmodel",
      value: "698f8d04b5970f963d31c4079c05a76fa7f4f5bb",
      label: "Den præcise udgave af modellen",
    },
    {
      key: "data.recordings",
      section: "data",
      section_label: "Data",
      value: null,
      label: "Mappen med dine optagelser (tom: standardmappen)",
    },
    {
      key: "data.validation_fraction",
      section: "data",
      section_label: "Data",
      value: val,
      label: "Andel af sætningerne til validering, der vælger den bedste epoke",
    },
    {
      key: "data.test_fraction",
      section: "data",
      section_label: "Data",
      value: val,
      label: "Andel af sætningerne til test, som træningen aldrig ser",
    },
    {
      key: "data.seed",
      section: "data",
      section_label: "Data",
      value: 7,
      label: "Tilfældighedsfrø, så opdelingen bliver den samme hver gang",
    },
    {
      key: "training.epochs",
      section: "training",
      section_label: "Træning",
      value: epochs,
      label: "Hvor mange gange modellen ser alle træningssætningerne",
    },
    {
      key: "training.learning_rate",
      section: "training",
      section_label: "Træning",
      value: lr,
      label: "Hvor store skridt modellen tager, når den lærer",
    },
    {
      key: "training.batch_size",
      section: "training",
      section_label: "Træning",
      value: 8,
      label: "Hvor mange optagelser modellen ser ad gangen",
    },
    {
      key: "training.warmup_steps",
      section: "training",
      section_label: "Træning",
      value: 10,
      label: "Trin, hvor skridtene langsomt bliver større i starten",
    },
    {
      key: "training.encoder_frozen",
      section: "training",
      section_label: "Træning",
      value: frozen,
      label: "Lad encoderen være, og træn kun decoderen",
    },
    {
      key: "lora.rank",
      section: "lora",
      section_label: "LoRA",
      value: 16,
      label:
        "Hvor meget LoRA-laget kan lære (højere: mere, men lettere at overtræne)",
    },
    {
      key: "lora.alpha",
      section: "lora",
      section_label: "LoRA",
      value: 32,
      label: "Hvor kraftigt LoRA-laget virker",
    },
    {
      key: "lora.dropout",
      section: "lora",
      section_label: "LoRA",
      value: 0.05,
      label: "Andel af LoRA-laget, der slås fra på hvert trin, mod overtræning",
    },
    {
      key: "lora.targets",
      section: "lora",
      section_label: "LoRA",
      value: ["q_proj", "v_proj"],
      label: "Hvilke dele af modellen LoRA-laget sidder på",
    },
    {
      key: "rehearsal.share",
      section: "rehearsal",
      section_label: "Genopfriskning",
      value: 0.3,
      label: "Andel af træningen, der er almindelig dansk tale",
    },
  ],
});

/* The four settings a beginner touches first (labels.ESSENTIALS, run 11). */
export const ESSENTIALS: Record<string, string> = {
  "training.learning_rate":
    "Højere: modellen lærer hurtigere, men kan blive ustabil og glemme almindeligt dansk. Lavere: roligere, men den skal bruge flere epoker.",
  "training.epochs":
    "Flere: modellen lærer dine optagelser bedre, men kan lære dem udenad. Færre: hurtigere, men den lærer måske for lidt.",
  "lora.rank":
    "Højere: adapteren kan lære mere, men lærer lettere udenad. Lavere: en mindre adapter, der ændrer Edda forsigtigt.",
  "rehearsal.share":
    "Højere: Edda holder bedre fast i almindeligt dansk, men lærer dine fagord langsommere. Lavere: mere af træningen er dine egne optagelser.",
};

function withEssentials(c: TrainingConfig): TrainingConfig {
  return {
    ...c,
    essentials: Object.keys(ESSENTIALS),
    settings: c.settings.map((s) => ({
      ...s,
      help: ESSENTIALS[s.key] ?? null,
    })),
  };
}

export const TRAINING_CONFIGS: TrainingConfig[] = [
  CONFIG_SETTINGS("first-frozen-encoder", 5, 0.0002, true, 0.1),
  CONFIG_SETTINGS("smoke", 1, 0.0005, true, 0.2),
  CONFIG_SETTINGS("top4-encoder", 6, 0.0001, false, 0.1),
].map(withEssentials);

const evalRun = (
  r: Omit<EvalRun, "kind" | "change" | "report"> & {
    kind?: string;
    change?: string | null;
    report?: string | null;
  },
): EvalRun => ({ kind: "eval", change: "pipeline", report: null, ...r });

export const EVAL_RUNS: EvalRun[] = [
  evalRun({
    id: "8f0c2a",
    name: "lora-test-split-2026-10-27",
    title: "Edda finjusteret (first-frozen-encoder) · Dine optagelser",
    normaliser: 2,
    date: "2026-10-27T12:42:10+01:00",
    dataset: "first-frozen-encoder-20261026-2112:test",
    model: "first-frozen-encoder-20261026-2112 (LoRA)",
    backend: "lora",
    clips: 104,
    wer: 0.1192,
    wer_ci: [0.0954, 0.1431],
    cer: 0.0512,
    change: "model",
  }),
  evalRun({
    id: "7b91d4",
    name: "gguf-test-split-2026-10-27",
    title: "Appen · Dine optagelser",
    normaliser: 2,
    date: "2026-10-27T12:30:02+01:00",
    dataset: "first-frozen-encoder-20261026-2112:test",
    model: "edda-v0.2 (app)",
    backend: "gguf",
    clips: 104,
    wer: 0.2034,
    wer_ci: [0.1712, 0.2356],
    cer: 0.0921,
    report: "/reports/eval-7b91d4.html",
  }),
  evalRun({
    id: "5a17e3",
    name: "20261026-170753-gguf-walkietalkey-edda-v0-2-gguf-edda-v0-2-q8-0-gguf",
    title: "Appen · FLEURS · 26. okt.",
    normaliser: 2,
    date: "2026-10-26T17:07:53+01:00",
    dataset: "fleurs-da_dk-test",
    model: "edda-v0.2 (app)",
    backend: "gguf",
    clips: 930,
    wer: 0.0672,
    wer_ci: [0.0626, 0.0718],
    cer: 0.024,
    report: "/reports/eval-5a17e3.html",
  }),
  evalRun({
    id: "4d22c1",
    name: "20261026-165446-hf-danish-foundation-models-edda-v0-2-698f8d04b597",
    title: "Edda, original · FLEURS · 26. okt.",
    normaliser: 2,
    date: "2026-10-26T16:54:46+01:00",
    dataset: "fleurs-da_dk-test",
    model: "edda-v0.2@698f8d04b597 (Transformers)",
    backend: "hf",
    clips: 930,
    wer: 0.0632,
    wer_ci: [0.0586, 0.0679],
    cer: 0.0229,
    report: "/reports/eval-4d22c1.html",
  }),
  evalRun({
    id: "3c44b0",
    name: "gguf-fleurs-da_dk-test-2026-10-25",
    title: "Appen · FLEURS · 25. okt.",
    normaliser: 1,
    date: "2026-10-25T02:16:19+02:00",
    dataset: "fleurs-da_dk-test",
    model: "edda-v0.2 (app)",
    backend: "gguf",
    clips: 930,
    wer: 0.0763,
    wer_ci: [0.071, 0.0818],
    cer: 0.0275,
    report: "/reports/eval-3c44b0.html",
  }),
  evalRun({
    id: "1e09aa",
    name: "gguf-fleurs-da_dk-test-2026-10-24",
    title: "Appen · FLEURS · 24. okt.",
    normaliser: 1,
    kind: "baseline",
    date: "2026-10-24T18:54:51+02:00",
    dataset: "fleurs-da_dk-test",
    model: "edda-v0.2 (app)",
    backend: "gguf",
    clips: 930,
    wer: 0.0844,
    wer_ci: [0.0784, 0.0905],
    cer: 0.0342,
  }),
  evalRun({
    id: "0b7f19",
    name: "hf-fleurs-da_dk-test-2026-10-24",
    title: "Edda, original · FLEURS · 24. okt.",
    normaliser: 1,
    kind: "baseline",
    change: "model",
    date: "2026-10-24T18:17:11+02:00",
    dataset: "fleurs-da_dk-test",
    model: "edda-v0.2@698f8d04b597 (Transformers)",
    backend: "hf",
    clips: 930,
    wer: 0.0721,
    wer_ci: [0.0666, 0.0778],
    cer: 0.0261,
  }),
];

/* The learning notebooks (run 11), as GET /api/learn lists them. */
export const NOTEBOOKS: LearnNotebook[] = [
  {
    name: "01-lyden",
    number: 1,
    title: "Lyden",
    summary:
      "Hør og se en optagelse, som Edda får den: bølgen, spektret og mel-billedet.",
    minutes: 4,
    copy: true,
    ran: true,
    saved: "2026-10-27T20:14:00+01:00",
  },
  {
    name: "02-edda-indefra",
    number: 2,
    title: "Edda indefra",
    summary: "Følg en sætning gennem encoderen og decoderen, ord for ord.",
    minutes: 5,
    copy: true,
    ran: false,
    saved: "2026-10-28T09:02:00+01:00",
  },
  {
    name: "03-maaling",
    number: 3,
    title: "Måling",
    summary: "Sådan tælles ordfejl, og hvorfor normaliseringen ændrer tallene.",
    minutes: 3,
    copy: false,
    ran: false,
    saved: null,
  },
  {
    name: "04-lora",
    number: 4,
    title: "LoRA",
    summary: "Se, hvor lidt en LoRA-adapter ændrer, og hvorfor det er nok.",
    minutes: 6,
    copy: false,
    ran: false,
    saved: null,
  },
  {
    name: "05-fejlanalyse",
    number: 5,
    title: "Fejlanalyse",
    summary: "Find de sætninger, Edda tager fejl af, og se mønstret i fejlene.",
    minutes: 4,
    copy: false,
    ran: false,
    saved: null,
  },
];

const JOURNAL_MD = (
  name: string,
  run: string,
  title: string,
  hypothesis: string,
  learned: string,
) => `# ${title}

Kørsel \`${run}\`, konfigurationen \`first-frozen-encoder\`. Siden er skrevet af \`wt-train card\`; tallene kommer fra MLflow.

## Numbers

| Datasæt | Edda før | Efter træning | Forskel |
|---|---|---|---|
| Dine optagelser, validering | 20,3 % | 12,0 % | -8,3 point |
| FLEURS, test | 6,72 % | 6,95 % | +0,23 point |
| Eksamen | 15,9 % | 11,2 % | -4,7 point |

![Tab under træningen](${name}/plot-loss.svg)

## Settings

- Epoker: 5, bedste epoke: 3
- Læringsrate: 0,0002
- Encoderen er frosset; kun decoderen trænes med LoRA (rang 16)

## Hypothesis

${hypothesis}

## What I learned

${learned}

## Files

1. \`runs/${run}/metrics.json\`
2. \`runs/${run}/adapter/\`
`;

/* ======================================================== the fake studio */

export interface FakeResponse {
  status: number;
  json?: unknown;
  body?: string | Uint8Array;
  type?: string;
}

export interface FakeStudioOptions {
  /** Let a phone session record by itself and a training draw its loss (default true). */
  simulate?: boolean;
  now?: () => number;
  /** Run 11: a first start, before anything was recorded, trained or evaluated. */
  empty?: boolean;
  /** Run 11: false when no VS Code can be found (POST /api/learn/open answers no-vscode). */
  vscode?: boolean;
}

interface RecState {
  version: number;
  active: boolean;
  paused: boolean;
  pick: Pick | null;
  link: RecordingState["link"];
  current: string | null;
  recording: RecordingState["recording"];
  rows: Row[];
  last: LastTake | null;
  error: string | null;
}

export interface FakeStudio {
  handle(
    method: string,
    url: string,
    headers: Record<string, string | undefined>,
    body: unknown,
  ): Promise<FakeResponse>;
  /** Move the simulation one step (the timer calls it; tests can too). */
  tick(): void;
  stop(): void;
}

const err = (status: number, error: string, message = error): FakeResponse => ({
  status,
  json: { error, message },
});
const ok = (json: unknown): FakeResponse => ({ status: 200, json });

export function createFakeStudio(opts: FakeStudioOptions = {}): FakeStudio {
  const now = opts.now ?? (() => Date.now());
  const simulate = opts.simulate ?? true;
  const empty = opts.empty ?? false;
  const t0 = now();

  /* ---- recording ---- */
  const sessions = new Map<string, Row[]>();
  sessions.set("condition:phone-whisper:", phoneWhisperRows(t0));
  const rec: RecState = {
    version: 42,
    active: true,
    paused: false,
    pick: {
      kind: "condition",
      id: "phone-whisper",
      label: "Telefonen, hvisket",
      device: "phone",
      style: "whisper",
      exam: false,
    },
    link: { status: "connected", detail: "0.2.2" },
    current: "s0019",
    recording: { prompt: "s0019", source: "phone", since: iso(t0 - 2000) },
    rows: sessions.get("condition:phone-whisper:")!,
    last: {
      prompt: "s0018",
      text: SENTENCES[17][0],
      check: "ok",
      saved: true,
      problems: [],
      seconds: 3.9,
      replaced: false,
    },
    error: null,
  };
  if (empty) {
    // A first start: nothing picked, nothing recorded.
    sessions.clear();
    Object.assign(rec, {
      active: false,
      pick: null,
      link: { status: "waiting", detail: "" },
      current: null,
      recording: null,
      rows: [],
      last: null,
    });
  }
  const waiters = new Set<() => void>();
  function bump() {
    rec.version++;
    waiters.forEach((w) => w());
    waiters.clear();
  }

  function micFor(pick: Pick | null): RecordingState["microphone"] {
    if (!pick) return null;
    if (pick.device === "mac")
      return {
        name:
          pick.kind === "pilot" && pick.id === "airpods-normal"
            ? "AirPods Pro"
            : "MacBook Pro-mikrofon",
        source: "mac",
      };
    const withTake = rec.rows.find((r) => r.take?.microphone);
    return { name: withTake?.take?.microphone ?? null, source: "phone" };
  }

  function counts(rows: Row[]) {
    const c = {
      total: rows.length,
      waiting: 0,
      recording: 0,
      received: 0,
      approved: 0,
      redo: 0,
    };
    for (const r of rows) c[r.status]++;
    return c;
  }

  function recMinutes(rows: Row[]): number {
    return round(rows.reduce((s, r) => s + (r.take?.seconds ?? 0), 0) / 60, 1);
  }

  function recordingState(): RecordingState {
    const style = rec.pick?.style ?? "whisper";
    return {
      version: rec.version,
      active: rec.active,
      paused: rec.paused,
      pick: rec.pick,
      link: rec.link,
      app: {
        connected: rec.link.status === "connected",
        version: "0.2.2",
        input: "MacBook Pro-mikrofon",
      },
      phone: { name: "Jonathans iPhone", platform: "ios", online: true },
      microphone: micFor(rec.pick),
      current: rec.current,
      recording: rec.recording,
      counts: counts(rec.rows),
      minutes: recMinutes(rec.rows),
      limits: rec.pick ? LIMITS[style] : null,
      rows: rec.rows,
      last: rec.last,
      error: rec.error,
    };
  }

  function nextCurrent(after: string | null): string | null {
    const rows = rec.rows;
    const start = after ? rows.findIndex((r) => r.id === after) + 1 : 0;
    const pending = (r: Row) =>
      (r.status === "waiting" || r.status === "redo") &&
      !r.skipped &&
      r.id !== after;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[(start + i) % rows.length];
      if (pending(r)) return r.id;
    }
    // The queue wraps round: skipped sentences come back.
    const skipped = rows.find((r) => r.skipped && r.status === "waiting");
    if (skipped) {
      rows.forEach((r) => (r.skipped = false));
      return skipped.id;
    }
    return null;
  }

  const rowById = (id: string | null) =>
    rec.rows.find((r) => r.id === id) ?? null;

  function replaceRow(row: Row) {
    // New objects for what changed, as the server's JSON would be.
    rec.rows = rec.rows.map((r) => (r.id === row.id ? row : r));
  }

  function finishTake(row: Row, source: "phone" | "mac") {
    const style = rec.pick?.style ?? "whisper";
    const folder =
      rec.pick?.kind === "pilot"
        ? `pilot-${rec.pick.id}`
        : rec.pick?.exam
          ? `exam-${rec.pick.id}`
          : (rec.pick?.id ?? "x");
    const take = makeTake({
      folder,
      id: row.id,
      text: row.text,
      seed: Math.floor(now() / 1000) % 997,
      style,
      microphone:
        source === "phone"
          ? "iPhone-mikrofon"
          : (micFor(rec.pick)?.name ?? "MacBook Pro-mikrofon"),
      at: now(),
      n: (row.take?.n ?? 0) + 1,
      diff: null,
      transcribing: true,
      review: null,
    });
    replaceRow({ ...row, status: "received", skipped: false, take });
    rec.last = {
      prompt: row.id,
      text: row.text,
      check: "ok",
      saved: true,
      problems: [],
      seconds: take.seconds,
      replaced: (row.take?.n ?? 0) > 0,
    };
  }

  /** A take the recorder refuses (nothing heard): only `last` says so, the row stays. */
  function refuseTake(row: Row) {
    replaceRow({
      ...row,
      status: row.take
        ? row.take.review?.status === "redo"
          ? "redo"
          : "approved"
        : "waiting",
    });
    rec.last = {
      prompt: row.id,
      text: row.text,
      check: "silent",
      saved: false,
      problems: ["silent"],
      seconds: 2.1,
      replaced: false,
    };
  }

  function eddaListens() {
    let n = 0;
    for (const row of rec.rows) {
      if (row.status !== "received" || !row.take) continue;
      n++;
      const idx = Number(row.id.replace(/\D/g, "")) || n;
      const bad = idx % 6 === 0;
      const diff = bad
        ? diffWith(row.text, { sub: [1, "nogen"] })
        : eqDiff(row.text);
      const take: Take = {
        ...row.take,
        transcribing: false,
        diff,
        heard: heardFrom(diff),
        wer: werOf(diff),
        problems: bad
          ? [{ kind: "mismatch", detail: `WER ${werOf(diff)}` }]
          : [],
        review: { status: bad ? "redo" : "approved", by: "check" },
      };
      replaceRow({ ...row, status: bad ? "redo" : "approved", take });
    }
    return n;
  }

  function startPick(body: Record<string, unknown>): FakeResponse {
    const kind = body.kind;
    const id = String(body.id ?? "");
    let pick: Pick;
    let spec: SessionSpec;
    if (kind === "condition") {
      const c = CONDITIONS.find((x) => x.id === id);
      if (!c) return err(404, "unknown", `no condition ${id}`);
      if (c.share === 0)
        return err(409, "no-share", `${id} has no share in the mix`);
      const exam = body.exam === true;
      pick = {
        kind: "condition",
        id,
        label: c.label,
        device: c.device,
        style: c.style,
        exam,
      };
      spec = {
        pick,
        folder: exam ? `exam-${id}` : id,
        texts: exam
          ? EXAM_PARAGRAPHS.map((p) => [p, "exam"])
          : SENTENCES.slice(0, 40).map(([t, k]) => [t, k]),
        microphone:
          c.device === "phone" ? "iPhone-mikrofon" : "MacBook Pro-mikrofon",
      };
    } else if (kind === "pilot") {
      const s = PILOT_SETUPS.find((x) => x.name === id);
      if (!s) return err(400, "bad-setup", `no setup ${id}`);
      pick = {
        kind: "pilot",
        id,
        label: s.label,
        device: s.device,
        style: s.style,
      };
      spec = {
        pick,
        folder: `pilot-${id}`,
        texts: PILOT_SENTENCES,
        microphone:
          s.device === "phone" ? "iPhone-mikrofon" : "MacBook Pro-mikrofon",
      };
    } else return err(400, "bad-request", "kind must be condition or pilot");
    const key = `${pick.kind}:${pick.id}:${pick.exam ? "exam" : ""}`;
    if (!sessions.has(key)) {
      const done =
        pick.kind === "pilot"
          ? PILOT_SETUPS.find((x) => x.name === pick.id)!.done
          : pick.exam
            ? 1
            : 5;
      sessions.set(
        key,
        freshRows(spec, Math.min(done, spec.texts.length), now()),
      );
    }
    rec.pick = pick;
    rec.rows = sessions.get(key)!;
    rec.active = true;
    rec.paused = false;
    rec.recording = null;
    rec.error = null;
    rec.link = {
      status: pick.device === "phone" ? "connecting" : "connected",
      detail: "0.2.2",
    };
    rec.current = nextCurrent(null);
    bump();
    if (pick.device === "phone")
      setTimeout(() => {
        if (rec.pick === pick && rec.active) {
          rec.link = { status: "connected", detail: "0.2.2" };
          bump();
        }
      }, 1200);
    return ok(recordingState());
  }

  /* ---- training ---- */
  const jobs = new Map<string, Job>();
  let jobSeq = 3;
  function newJob(kind: string, title: string): Job {
    const job: Job = {
      id: `j${++jobSeq}`,
      kind,
      title,
      status: "running",
      started: iso(now()),
      ended: null,
      exit: null,
      log: [],
      result: null,
    };
    jobs.set(job.id, job);
    return job;
  }
  /** A `report` job that already wrote its page (the request waits for it, API.md). */
  function reportJob(title: string): Job {
    const job = newJob("report", `Rapport: ${title}`);
    job.log.push("wrote the report");
    endJob(job, "done", 0);
    return job;
  }
  function endJob(job: Job, status: Job["status"], exit: number | null) {
    job.status = status;
    job.ended = iso(now());
    job.exit = exit;
  }

  const trainR = rng(7);
  let trainJob: Job | null = {
    id: "j3",
    kind: "train",
    title: "Træning: first-frozen-encoder",
    status: "running",
    started: iso(t0 - 31 * 9000 - 60_000),
    ended: null,
    exit: null,
    log: [
      "build: 1041 sentences, 120 takes, split by sentence (seed 7)",
      "build: train 96, validation 12, test 12 takes",
      "cache: encoder outputs for 120 takes (frozen encoder)",
      "plan: 5 epochs, 16 steps per epoch, 80 steps",
      "epoch 0 (base model): validation loss 1.700, WER 0.210",
      "epoch 1: train loss 1.62, validation loss 1.410, WER 0.170",
    ],
    result: null,
  };
  jobs.set(trainJob.id, trainJob);
  if (empty) {
    jobs.delete(trainJob.id);
    trainJob = null;
  }
  let progress: TrainingProgress | null = {
    config: "first-frozen-encoder",
    run: "first-frozen-encoder-20261027-120000",
    phase: "train",
    epoch: 2,
    epochs: 5,
    step: 31,
    total_steps: 80,
    train_loss: trainLossPoints(31),
    validation_loss: [
      [0, 1.7],
      [16, 1.41],
    ],
    validation_wer: [
      [0, 0.21],
      [16, 0.17],
    ],
    awake: true,
    dir: "/Users/jonathan/.../training/work/runs/first-frozen-encoder-20261027-120000",
    steps_per_epoch: 16,
    best_epoch: null,
    best_validation_wer: null,
    message: null,
  };
  if (empty) progress = null;
  const runs: TrainingRun[] = [
    {
      name: "first-frozen-encoder-20261026-2112",
      date: "2026-10-26T21:12:00+01:00",
      best_epoch: 3,
      best_validation_wer: 0.12,
      baseline_validation_wer: 0.2,
      finished: true,
      adapter: true,
    },
    {
      name: "smoke-20261026-1840",
      date: "2026-10-26T18:40:00+01:00",
      best_epoch: 1,
      best_validation_wer: 0.19,
      baseline_validation_wer: 0.2,
      finished: true,
      adapter: true,
    },
  ];

  if (empty) runs.length = 0;

  function trainTick() {
    if (!progress || !trainJob || trainJob.status !== "running") return;
    if (progress.phase === "build") {
      progress.phase = "cache";
      trainJob.log.push(
        "cache: encoder outputs for 120 takes (frozen encoder)",
      );
      return;
    }
    if (progress.phase === "cache") {
      progress.phase = "train";
      progress.epoch = 1;
      progress.validation_loss = [[0, 1.7]];
      progress.validation_wer = [[0, 0.21]];
      trainJob.log.push("plan: 5 epochs, 16 steps per epoch, 80 steps");
      return;
    }
    const step = (progress.step ?? 0) + 1;
    const total = progress.total_steps ?? 80;
    progress.step = step;
    progress.train_loss = [
      ...progress.train_loss,
      [step, round(trainLossAt(step, trainR), 3)],
    ];
    if (step % 16 === 0) {
      const epoch = step / 16;
      const vl = round(
        0.95 +
          0.75 * Math.exp(-epoch / 1.6) +
          (epoch > 3 ? 0.03 * (epoch - 3) : 0),
        3,
      );
      const vw = round(
        0.11 +
          0.1 * Math.exp(-epoch / 1.4) +
          (epoch > 3 ? 0.006 * (epoch - 3) : 0),
        3,
      );
      progress.validation_loss = [...progress.validation_loss, [step, vl]];
      progress.validation_wer = [...progress.validation_wer, [step, vw]];
      trainJob.log.push(
        `epoch ${epoch}: validation loss ${vl.toFixed(3)}, WER ${vw.toFixed(3)}`,
      );
      progress.epoch = Math.min(epoch + 1, progress.epochs ?? 5);
    }
    if (step >= total) {
      progress.phase = "done";
      progress.awake = false;
      progress.best_epoch = 3;
      progress.best_validation_wer = 0.12;
      endJob(trainJob, "done", 0);
      trainJob.log.push(`done: best epoch 3, best validation WER 0.12`);
      runs.unshift({
        name: progress.run ?? "run",
        date: iso(now()),
        best_epoch: 3,
        best_validation_wer: 0.12,
        baseline_validation_wer: 0.21,
        finished: true,
        adapter: true,
      });
    }
  }

  /* ---- pilot ---- */
  let pilotJob: Job | null = null;
  let comparison: PilotComparison | null = {
    generated_at: iso(t0 - 3 * 3600_000),
    report: "/reports/pilot-20261027-110000.html",
    model: "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
    setups: [
      {
        name: "iphone-whisper",
        label: "iPhone, hvisket",
        clips: 12,
        wer: 0.081,
        cer: 0.031,
        terms: 0.66,
        level_dbfs: -38,
        peak_dbfs: -12,
        noise_dbfs: -62,
        snr_db: 24,
        clipped: 0,
        seconds: 3.2,
        notes: [
          "Whisper is quiet but clean; the phone's gain keeps it above the quiet limit.",
        ],
      },
      {
        name: "iphone-normal",
        label: "iPhone, almindelig stemme",
        clips: 12,
        wer: 0.052,
        cer: 0.019,
        terms: 0.75,
        level_dbfs: -21,
        peak_dbfs: -4,
        noise_dbfs: -58,
        snr_db: 37,
        clipped: 1,
        seconds: 2.9,
        notes: ["One take touched the limiter."],
      },
      {
        name: "mac-normal",
        label: "MacBook-mikrofonen, almindelig stemme",
        clips: 12,
        wer: 0.064,
        cer: 0.024,
        terms: 0.71,
        level_dbfs: -24,
        peak_dbfs: -8,
        noise_dbfs: -55,
        snr_db: 31,
        clipped: 0,
        seconds: 3.0,
        notes: [],
      },
      {
        name: "mac-whisper",
        label: "MacBook-mikrofonen, hvisket",
        clips: 7,
        wer: 0.174,
        cer: 0.071,
        terms: 0.42,
        level_dbfs: -49,
        peak_dbfs: -27,
        noise_dbfs: -57,
        snr_db: 8,
        clipped: 0,
        seconds: 3.4,
        notes: ["Too close to the room noise: 8 dB."],
      },
      {
        name: "airpods-normal",
        label: "AirPods, almindelig stemme",
        clips: 12,
        wer: 0.098,
        cer: 0.038,
        terms: 0.58,
        level_dbfs: -27,
        peak_dbfs: -10,
        noise_dbfs: -60,
        snr_db: 33,
        clipped: 0,
        seconds: 3.1,
        notes: ["Bluetooth narrows the band; consonants blur."],
      },
    ],
  };

  if (empty) comparison = null;

  /* ---- versions ---- */
  const versions: Versions = {
    app: { found: true, version: "0.2.2", use: true },
    in_app: "edda-ft-first-v2",
    base: {
      id: "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
      name: "Edda",
      installed: true,
    },
    versions: [
      {
        version: 2,
        id: "edda-ft-first-v2",
        name: "Edda finjusteret (forsøg 1)",
        run: "first-frozen-encoder-20261026-2112",
        date: "2026-10-26T23:02:00+01:00",
        validation_wer: 0.12,
        installed: true,
        in_app: true,
      },
      {
        version: 1,
        id: "edda-ft-smoke-v1",
        name: "Edda finjusteret (røgtest)",
        run: "smoke-20261026-1840",
        date: "2026-10-26T19:05:00+01:00",
        validation_wer: 0.19,
        installed: true,
        in_app: false,
      },
    ],
    exportable: [
      {
        run: "first-frozen-encoder-20261026-2112",
        date: "2026-10-26T21:12:00+01:00",
        best_validation_wer: 0.12,
      },
      {
        run: "smoke-20261026-1840",
        date: "2026-10-26T18:40:00+01:00",
        best_validation_wer: 0.19,
      },
    ],
  };
  if (empty) {
    versions.in_app = versions.base.id;
    versions.versions = [];
    versions.exportable = [];
  }
  let exportJob: Job | null = null;

  /* ---- journal ---- */
  const pages = new Map<string, JournalPage>();
  const addPage = (
    name: string,
    run: string,
    title: string,
    hyp: string,
    learned: string,
  ) => {
    pages.set(name, {
      name,
      title,
      markdown: JOURNAL_MD(name, run, title, hyp, learned),
      hypothesis: hyp,
      learned,
      files: `/files/journal/${name}/`,
    });
  };
  addPage(
    "2026-10-26-first-frozen-encoder-20261026-2112",
    "first-frozen-encoder-20261026-2112",
    "Første træning med frossen encoder",
    "Hvis kun decoderen trænes, lærer Edda de engelske fagord uden at blive dårligere til almindelig dansk.",
    "",
  );
  addPage(
    "2026-10-26-smoke-20261026-1840",
    "smoke-20261026-1840",
    "Røgtest",
    "",
    "",
  );
  if (empty) pages.clear();
  const journalRuns = () =>
    empty
      ? []
      : [
          {
            run: "first-frozen-encoder-20261026-2112",
            id: "a91f",
            kind: "train",
            date: "2026-10-26T21:12:00+01:00",
            page: "2026-10-26-first-frozen-encoder-20261026-2112",
          },
          {
            run: "smoke-20261026-1840",
            id: "c2d0",
            kind: "train",
            date: "2026-10-26T18:40:00+01:00",
            page: "2026-10-26-smoke-20261026-1840",
          },
          ...EVAL_RUNS.slice(0, 3).map((e) => ({
            run: e.name,
            id: e.id,
            kind: "eval",
            date: e.date,
            page:
              [...pages.values()].find((p) => p.markdown.includes(e.name))
                ?.name ?? null,
          })),
        ];
  function section(md: string, heading: string, text: string): string {
    const lines = md.split("\n");
    const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
    if (start < 0) return `${md.trimEnd()}\n\n## ${heading}\n\n${text}\n`;
    let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
    if (end < 0) end = lines.length;
    return [
      ...lines.slice(0, start + 1),
      "",
      text,
      "",
      ...lines.slice(end),
    ].join("\n");
  }

  /* ---- the simulation ---- */
  let phoneStep = 0;
  function recTick() {
    if (
      rec.active &&
      !rec.paused &&
      rec.pick?.device === "phone" &&
      rec.link.status === "connected"
    ) {
      phoneStep++;
      let changed = eddaListens() > 0;
      if (rec.recording) {
        const row = rowById(rec.recording.prompt);
        rec.recording = null;
        // Now and then a take is too quiet to hear: refused, and the sentence stays.
        if (row && phoneStep % 9 === 5) refuseTake(row);
        else {
          if (row) finishTake(row, "phone");
          rec.current = nextCurrent(row?.id ?? rec.current);
        }
        changed = true;
      } else if (phoneStep % 2 === 0 && rec.current) {
        const row = rowById(rec.current);
        if (row) {
          replaceRow({ ...row, status: "recording" });
          rec.recording = {
            prompt: row.id,
            source: "phone",
            since: iso(now()),
          };
          changed = true;
        }
      }
      if (changed) bump();
    }
  }
  function tick() {
    recTick();
    trainTick();
  }
  const timers: ReturnType<typeof setInterval>[] = [];
  if (simulate) {
    timers.push(setInterval(recTick, 2600));
    timers.push(setInterval(trainTick, 1000));
  }

  async function waitFor(since: number, ms: number): Promise<void> {
    if (rec.version > since) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        waiters.delete(done);
        resolve();
      }
      waiters.add(done);
    });
  }

  function overview(): Overview {
    const running = [...jobs.values()].filter((j) => j.status === "running");
    return {
      app: {
        found: true,
        path: "/Applications/WalkieTalkey.app/Contents/MacOS/walkietalkey",
        version: "0.2.2",
        batch: true,
        connected: rec.link.status === "connected" && rec.active,
      },
      work: "/Users/jonathan/Desktop/CODING/Business/walkietalkey-app/training/work",
      recording: {
        active: rec.active,
        paused: rec.paused,
        label: rec.pick?.label ?? null,
      },
      training: {
        running: trainJob?.status === "running",
        config:
          trainJob?.status === "running" ? (progress?.config ?? null) : null,
      },
      jobs: running,
    };
  }

  function options(): RecordingOptions {
    return {
      conditions: CONDITIONS.map<ConditionOption>((c) => {
        const rows = sessions.get(`condition:${c.id}:`);
        const done =
          c.id === "phone-whisper"
            ? counts(rows ?? []).approved + 2
            : c.id === "phone-normal"
              ? 31
              : c.id === "mac-normal"
                ? 12
                : 0;
        return {
          id: c.id,
          label: c.label,
          device: c.device,
          style: c.style,
          share: c.share,
          planned: c.planned,
          done,
          redo:
            c.id === "phone-whisper"
              ? counts(rows ?? []).redo
              : c.id === "phone-normal"
                ? 1
                : 0,
          minutes:
            c.id === "phone-whisper"
              ? recMinutes(rows ?? [])
              : c.id === "phone-normal"
                ? 5.9
                : c.id === "mac-normal"
                  ? 2.4
                  : 0,
        };
      }),
      exam: { paragraphs: EXAM_PARAGRAPHS.length },
      pilot: { sentences: PILOT_SENTENCES.length, setups: PILOT_SETUPS },
    };
  }

  function progressView(): Progress {
    const o = options();
    return {
      mix: Object.fromEntries(CONDITIONS.map((c) => [c.id, c.share])),
      sentences: 1041,
      minutes: round(
        o.conditions.reduce((s, c) => s + c.minutes, 0),
        1,
      ),
      conditions: o.conditions.map((c) => ({
        id: c.id,
        label: c.label,
        share: c.share,
        planned: c.planned,
        done: c.done,
        redo: c.redo,
        minutes: c.minutes,
        exam_done: c.id === "phone-whisper" ? 2 : c.id === "mac-normal" ? 8 : 0,
        exam_total: EXAM_PARAGRAPHS.length,
      })),
    };
  }

  function dataView(config: string | null): DataView | FakeResponse {
    const name = config ?? "first-frozen-encoder";
    const cfg = TRAINING_CONFIGS.find((c) => c.name === name);
    if (!cfg) return err(404, "unknown", `no config ${name}`);
    const frac = Number(
      cfg.settings.find((s) => s.key === "data.validation_fraction")?.value ??
        0.1,
    );
    const cond = (
      id: string,
      label: string,
      takes: number,
      minutes: number,
    ) => {
      const v = Math.round(takes * frac);
      const t = Math.round(takes * frac);
      const tr = takes - v - t;
      const m = (n: number) => round((minutes * n) / Math.max(1, takes), 1);
      return {
        id,
        label,
        takes,
        minutes,
        split: {
          train: { takes: tr, minutes: m(tr) },
          validation: { takes: v, minutes: m(v) },
          test: { takes: t, minutes: m(t) },
        },
      };
    };
    const fleursMissing = name === "smoke";
    return {
      config: name,
      configs: TRAINING_CONFIGS.map((c) => c.name),
      fractions: { validation: frac, test: frac },
      sentences: { total: 1041, plain: 600, terms: 441, recorded: 120 },
      conditions: [
        cond("phone-whisper", "Telefonen, hvisket", 60, 3.4),
        cond("phone-normal", "Telefonen, almindelig stemme", 44, 5.9),
        cond("mac-normal", "Mac'en, almindelig stemme", 16, 2.4),
        cond("mac-whisper", "Mac'en, hvisket", 0, 0),
      ],
      skipped: [
        { id: "s0016.phone-whisper", reason: "marked for a new take" },
        { id: "s0017.phone-whisper", reason: "marked for a new take" },
        { id: "s0031.phone-normal", reason: "marked for a new take" },
      ],
      rehearsal: { share: 0.3, validation_share: 0.3 },
      leakage: {
        ran: true,
        ok: fleursMissing ? null : true,
        checks: [
          {
            id: "splits",
            label: "Træning, validering og test deler ingen sætninger",
            ok: true,
            overlap: 0,
          },
          fleursMissing
            ? {
                id: "fleurs-test",
                label: "FLEURS-testen er ikke med i træningen",
                ok: null,
                overlap: null,
                detail: "FLEURS is not downloaded",
              }
            : {
                id: "fleurs-test",
                label: "FLEURS-testen er ikke med i træningen",
                ok: true,
                overlap: 0,
              },
          {
            id: "exam",
            label: "Eksamensafsnittene er ikke med",
            ok: true,
            overlap: 0,
          },
          {
            id: "pilot",
            label: "Pilotens sætninger er ikke med",
            ok: true,
            overlap: 0,
          },
        ],
        message: null,
      },
    };
  }

  /* ---- Lær det ---- */
  const notebooks: LearnNotebook[] = empty
    ? []
    : NOTEBOOKS.map((n) => ({ ...n }));
  const COPIES =
    "/Users/jonathan/Desktop/CODING/Business/walkietalkey-app/training/work/notebooks";
  function learnListing(): LearnListing {
    return { notebooks: notebooks.map((n) => ({ ...n })), copies: COPIES };
  }
  function notebookAction(kind: "open" | "reset", name: unknown): FakeResponse {
    const nb = notebooks.find((n) => n.name === name);
    if (!nb) return err(404, "unknown", `no notebook ${String(name)}`);
    const had = nb.copy;
    nb.copy = true;
    nb.saved = iso(now());
    if (kind === "reset") {
      nb.ran = false;
      return ok({
        notebook: { ...nb },
        kept: had
          ? `${COPIES}/.replaced/${nb.name}-20261028-101500.ipynb`
          : null,
      });
    }
    if (opts.vscode === false)
      return err(409, "no-vscode", "VS Code was not found");
    return ok({ notebook: { ...nb }, created: !had, with: "open" });
  }

  /* ---- data before the first session ---- */
  function emptyData(view: DataView): DataView {
    return {
      ...view,
      sentences: { ...view.sentences, recorded: 0 },
      conditions: [],
      skipped: [],
      leakage: {
        ran: false,
        ok: null,
        checks: view.leakage.checks.map((c) => ({
          ...c,
          ok: null,
          overlap: null,
          detail: "no takes yet",
        })),
        message: null,
      },
    };
  }

  function trainingState(): TrainingState {
    return { job: trainJob, progress, runs };
  }

  async function handle(
    method: string,
    url: string,
    headers: Record<string, string | undefined>,
    body: unknown,
  ): Promise<FakeResponse> {
    const u = new URL(url, "http://127.0.0.1");
    const p = u.pathname;
    const b = (body && typeof body === "object" ? body : {}) as Record<
      string,
      unknown
    >;
    if (method === "POST" && headers["x-wt-studio"] !== "1")
      return err(403, "forbidden", "missing X-WT-Studio");

    if (method === "GET") {
      if (p === "/api/ping") return ok({ studio: true, pid: 4242 });
      if (p === "/api/overview") return ok(overview());
      if (p === "/api/recording/options") return ok(options());
      if (p === "/api/recording/state") {
        const since = u.searchParams.get("since");
        if (since !== null) await waitFor(Number(since), 20_000);
        return ok(recordingState());
      }
      if (p === "/api/progress") {
        const pv = progressView();
        return ok(
          empty
            ? {
                ...pv,
                minutes: 0,
                conditions: pv.conditions.map((c) => ({
                  ...c,
                  done: 0,
                  redo: 0,
                  minutes: 0,
                  exam_done: 0,
                })),
              }
            : pv,
        );
      }
      if (p === "/api/pilot")
        return ok({
          sentences: PILOT_SENTENCES.length,
          setups: empty
            ? PILOT_SETUPS.map((x) => ({ ...x, done: 0 }))
            : PILOT_SETUPS,
          comparison,
          job: pilotJob?.status === "running" ? pilotJob : null,
        } satisfies Pilot);
      if (p === "/api/data") {
        const d = dataView(u.searchParams.get("config"));
        return "status" in d ? d : ok(empty ? emptyData(d) : d);
      }
      if (p === "/api/training/configs") return ok(TRAINING_CONFIGS);
      if (p === "/api/training/state") return ok(trainingState());
      if (p === "/api/eval/runs") return ok(empty ? [] : EVAL_RUNS);
      if (p === "/api/learn") return ok(learnListing());
      if (p === "/api/versions") return ok(versions);
      if (p === "/api/journal") {
        const list: Journal = {
          pages: [...pages.values()].map((pg) => ({
            name: pg.name,
            title: pg.title,
            date: pg.name.slice(0, 10),
            run: pg.markdown.match(/Kørsel `([^`]+)`/)?.[1] ?? null,
            notes: {
              hypothesis: pg.hypothesis.trim() !== "",
              learned: pg.learned.trim() !== "",
            },
          })),
          runs: journalRuns(),
        };
        return ok(list);
      }
      const jp = p.match(/^\/api\/journal\/(.+)$/);
      if (jp) {
        const page = pages.get(decodeURIComponent(jp[1]));
        return page ? ok(page) : err(404, "unknown", "no such page");
      }
      const job = p.match(/^\/api\/jobs\/([^/]+)$/);
      if (job) {
        const j = jobs.get(decodeURIComponent(job[1]));
        return j ? ok(j) : err(404, "unknown", "no such job");
      }
      const takeM = p.match(/^\/api\/takes\/([^/]+)\/([^/]+)\.wav$/);
      if (takeM)
        return {
          status: 200,
          body: wav(1.2, takeM[2].length),
          type: "audio/wav",
        };
      const rep = p.match(/^\/reports\/([^/]+\.html)$/);
      if (rep)
        return {
          status: 200,
          body: reportHtml(rep[1]),
          type: "text/html; charset=utf-8",
        };
      if (/^\/files\/journal\/.+\.svg$/.test(p))
        return { status: 200, body: PLOT_SVG, type: "image/svg+xml" };
      return err(404, "not-found", p);
    }

    if (method !== "POST") return err(405, "method", method);

    switch (p) {
      case "/api/recording/start":
        return startPick(b);
      case "/api/recording/pause":
        if (!rec.pick) return ok(recordingState());
        rec.active = false;
        rec.paused = true;
        if (rec.recording) {
          const row = rowById(rec.recording.prompt);
          if (row)
            replaceRow({
              ...row,
              status: row.take
                ? row.take.review?.status === "redo"
                  ? "redo"
                  : "approved"
                : "waiting",
            });
        }
        rec.recording = null;
        rec.link = { status: "waiting", detail: null };
        bump();
        return ok(recordingState());
      case "/api/recording/resume":
        if (!rec.pick)
          return err(409, "no-pick", "nothing is picked to record");
        if (rec.active) return ok(recordingState());
        rec.active = true;
        rec.paused = false;
        rec.link = {
          status: rec.pick.device === "phone" ? "connecting" : "connected",
          detail: "0.2.2",
        };
        bump();
        setTimeout(() => {
          if (rec.active) {
            rec.link = { status: "connected", detail: "0.2.2" };
            bump();
          }
        }, 1200);
        return ok(recordingState());
      case "/api/recording/stop":
        rec.active = false;
        rec.paused = false;
        rec.pick = null;
        rec.recording = null;
        rec.current = null;
        rec.rows = [];
        rec.last = null;
        rec.link = { status: "waiting", detail: null };
        bump();
        return ok(recordingState());
      case "/api/recording/skip": {
        if (!rec.pick)
          return err(409, "no-pick", "nothing is picked to record");
        if (rec.recording) return err(409, "busy", "a take is recording");
        const row = rowById(rec.current);
        if (row) replaceRow({ ...row, skipped: true });
        rec.current = nextCurrent(rec.current);
        bump();
        return ok(recordingState());
      }
      case "/api/recording/go": {
        if (!rec.pick)
          return err(409, "no-pick", "nothing is picked to record");
        const row = rowById(String(b.id ?? ""));
        if (!row) return err(404, "unknown", "no such sentence");
        if (rec.recording) return err(409, "busy", "a take is recording");
        rec.current = row.id;
        bump();
        return ok(recordingState());
      }
      case "/api/recording/redo": {
        if (!rec.pick)
          return err(409, "no-pick", "nothing is picked to record");
        const row = rowById(String(b.id ?? ""));
        if (!row?.take) return err(404, "unknown", "no take");
        if (rec.recording) return err(409, "busy", "a take is recording");
        replaceRow({
          ...row,
          status: "redo",
          skipped: false,
          take: { ...row.take, review: { status: "redo", by: "owner" } },
        });
        rec.current = row.id;
        bump();
        return ok(recordingState());
      }
      case "/api/recording/approve": {
        if (!rec.pick)
          return err(409, "no-pick", "nothing is picked to record");
        const row = rowById(String(b.id ?? ""));
        if (!row?.take) return err(404, "unknown", "no take");
        replaceRow({
          ...row,
          status: "approved",
          take: { ...row.take, review: { status: "approved", by: "owner" } },
        });
        if (rec.current === row.id) rec.current = nextCurrent(row.id);
        bump();
        return ok(recordingState());
      }
      case "/api/recording/mac/start": {
        if (!rec.pick)
          return err(409, "no-pick", "nothing is picked to record");
        if (!rec.active) return err(409, "paused", "the session is paused");
        const row = rowById(rec.current);
        if (rec.pick.device !== "mac" || !row || rec.recording)
          return err(409, "mac-not-ready", "no Mac take can start now");
        replaceRow({ ...row, status: "recording" });
        rec.recording = { prompt: row.id, source: "mac", since: iso(now()) };
        bump();
        return ok(recordingState());
      }
      case "/api/recording/mac/stop": {
        if (!rec.pick)
          return err(409, "no-pick", "nothing is picked to record");
        if (!rec.active) return err(409, "paused", "the session is paused");
        if (!rec.recording) return ok(recordingState());
        const row = rowById(rec.recording.prompt);
        rec.recording = null;
        if (row) finishTake(row, "mac");
        rec.current = nextCurrent(row?.id ?? null);
        bump();
        setTimeout(() => {
          if (eddaListens() > 0) bump();
        }, 1500);
        return ok(recordingState());
      }
      case "/api/recording/mac/cancel": {
        if (!rec.pick)
          return err(409, "no-pick", "nothing is picked to record");
        if (!rec.active) return err(409, "paused", "the session is paused");
        if (rec.recording) {
          const row = rowById(rec.recording.prompt);
          if (row)
            replaceRow({
              ...row,
              status: row.take
                ? row.take.review?.status === "redo"
                  ? "redo"
                  : "approved"
                : "waiting",
            });
        }
        rec.recording = null;
        bump();
        return ok(recordingState());
      }
      case "/api/pilot/compare": {
        if (pilotJob?.status === "running") return ok(pilotJob);
        const job = newJob("pilot", "Pilot: sammenligning af opsætningerne");
        pilotJob = job;
        const lines = [
          "pilot report: 6 setups, 67 clips",
          "edda: listening to iphone-whisper (12)",
          "edda: listening to iphone-normal (12)",
          "edda: listening to mac-normal (12)",
          "edda: listening to mac-whisper (7)",
          "edda: listening to airpods-normal (12)",
          "wrote reports/pilot-new.html",
        ];
        let i = 0;
        const t = setInterval(() => {
          job.log.push(lines[i++]);
          if (i >= lines.length) {
            clearInterval(t);
            endJob(job, "done", 0);
            if (comparison)
              comparison = {
                ...comparison,
                generated_at: iso(now()),
                report: "/reports/pilot-new.html",
              };
          }
        }, 700);
        timers.push(t);
        return ok(job);
      }
      case "/api/training/start": {
        if (trainJob?.status === "running")
          return err(409, "busy", "a training runs");
        const name = String(b.config ?? "");
        const cfg = TRAINING_CONFIGS.find((c) => c.name === name);
        if (!cfg) return err(404, "unknown", `no config ${name}`);
        const epochs = Number(
          cfg.settings.find((s) => s.key === "training.epochs")?.value ?? 5,
        );
        trainJob = newJob("train", `Træning: ${name}`);
        trainJob.log.push(
          "build: 1041 sentences, 120 takes, split by sentence (seed 7)",
        );
        progress = {
          config: name,
          run: `${name}-${iso(now()).slice(0, 16).replace(/[-:T]/g, "")}`,
          phase: "build",
          epoch: 0,
          epochs,
          step: 0,
          total_steps: epochs * 16,
          train_loss: [],
          validation_loss: [],
          validation_wer: [],
          awake: true,
        };
        return ok(trainJob);
      }
      case "/api/training/stop": {
        if (!trainJob || trainJob.status !== "running")
          return err(409, "not-running", "no training runs");
        endJob(trainJob, "stopped", -2);
        trainJob.log.push("stopped (SIGINT)");
        if (progress) {
          progress.phase = "stopped";
          progress.awake = false;
        }
        return ok(trainJob);
      }
      case "/api/eval/report": {
        const run = EVAL_RUNS.find((r) => r.id === b.run);
        if (!run) return err(404, "unknown", "no run");
        if (run.report) return ok({ url: run.report });
        run.report = `/reports/eval-${run.id}.html`;
        return ok({ url: run.report, job: reportJob(run.name).id });
      }
      case "/api/eval/compare": {
        const a = EVAL_RUNS.find((r) => r.id === b.a);
        const bb = EVAL_RUNS.find((r) => r.id === b.b);
        if (!a || !bb) return err(404, "unknown", "no run");
        if (a.dataset !== bb.dataset)
          return err(409, "not-comparable", "B has no results for A's dataset");
        return ok({
          url: `/reports/vs-${a.id}-${bb.id}.html`,
          job: reportJob(`${a.name} / ${bb.name}`).id,
        });
      }
      case "/api/versions/use": {
        const v = b.version;
        if (v === "edda") {
          versions.in_app = versions.base.id;
        } else {
          if (typeof v !== "number") return err(400, "version", "no version");
          const found = versions.versions.find((x) => x.version === v);
          if (!found) return err(409, "use-failed", "no such version");
          if (!found.installed) return err(409, "use-failed", "not installed");
          versions.in_app = found.id;
        }
        versions.versions = versions.versions.map((x) => ({
          ...x,
          in_app: x.id === versions.in_app,
        }));
        return ok({
          ok: true,
          in_app: versions.in_app,
          message: "switched the running app",
        });
      }
      case "/api/versions/export": {
        const run = versions.exportable.find((r) => r.run === b.run);
        if (!run) return err(404, "unknown", "no run");
        if (exportJob?.status === "running")
          return err(409, "busy", "an export runs");
        const job = newJob("export", `Eksport: ${run.run}`);
        exportJob = job;
        const lines = [
          "export: merging the LoRA adapter into the decoder",
          "export: converting to GGUF (Q8_0)",
          "export: writing the model card",
          "export: installing into WalkieTalkey's models folder",
          "done",
        ];
        let i = 0;
        const t = setInterval(() => {
          job.log.push(lines[i++]);
          if (i >= lines.length) {
            clearInterval(t);
            endJob(job, "done", 0);
            const n = Math.max(...versions.versions.map((x) => x.version)) + 1;
            versions.versions = [
              {
                version: n,
                id: `edda-ft-v${n}`,
                name: `Edda finjusteret (version ${n})`,
                run: run.run,
                date: iso(now()),
                validation_wer: run.best_validation_wer,
                installed: true,
                in_app: false,
              },
              ...versions.versions,
            ];
          }
        }, 800);
        timers.push(t);
        return ok(job);
      }
      case "/api/learn/open":
        return notebookAction("open", b.name);
      case "/api/learn/reset":
        return notebookAction("reset", b.name);
      case "/api/journal": {
        const run = String(b.run ?? "");
        const r = journalRuns().find((x) => x.run === run || x.id === run);
        if (!r) return err(404, "unknown", "no run");
        if (r.page) return err(409, "exists", "page exists");
        const name = `${(r.date ?? iso(now())).slice(0, 10)}-${r.run}`;
        addPage(name, r.run, `Evaluering: ${r.run}`, "", "");
        return ok(pages.get(name));
      }
    }
    const jobStop = p.match(/^\/api\/jobs\/([^/]+)\/stop$/);
    if (jobStop) {
      const j = jobs.get(decodeURIComponent(jobStop[1]));
      if (!j) return err(404, "unknown", "no such job");
      if (j.status === "running") endJob(j, "stopped", -2);
      return ok(j);
    }
    const jp = p.match(/^\/api\/journal\/(.+)$/);
    if (jp) {
      const page = pages.get(decodeURIComponent(jp[1]));
      if (!page) return err(404, "unknown", "no such page");
      for (const k of ["hypothesis", "learned"])
        if (k in b && typeof b[k] !== "string")
          return err(400, "text", `${k} is not a string`);
      const hypothesis =
        typeof b.hypothesis === "string" ? b.hypothesis : page.hypothesis;
      const learned = typeof b.learned === "string" ? b.learned : page.learned;
      let md = section(page.markdown, "Hypothesis", hypothesis);
      md = section(md, "What I learned", learned);
      const next = { ...page, markdown: md, hypothesis, learned };
      pages.set(page.name, next);
      return ok(next);
    }
    return err(404, "not-found", p);
  }

  return {
    handle,
    tick,
    stop() {
      timers.forEach((t) => clearInterval(t));
      waiters.forEach((w) => w());
    },
  };
}
