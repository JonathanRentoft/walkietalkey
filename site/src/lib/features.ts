/* Everything the front page says (src/pages/index.astro, src/components/front/). Danish, sentence case, no em dashes,
   no exclamation marks (spec Appendix A, design system). Only claims that are true and measured (spec 2.6): what
   nobody has measured yet is left out of the page entirely, with a TODO(claim) comment where it would go.

   The owner approved this text in run 8 (it comes from the production front page and run 6's concepts B and C), so
   it carries no TODO(copy) marker. Strings that are new or changed in run 10 carry TODO(copy) where they are written.

   TODO(claim): whispering into the phone (the phone row and the questions) and how Edda writes English words inside
   Danish sentences (the word list row) stay off the page until they are measured (spec 2.6, DESK-67; the workbench
   records a whisper condition and developer-term sentences).

   Words always land at release: the app transcribes while you talk, but the text appears only when you let go
   (DESK-46, DESK-52). Every demo shows it that way. */

export type FeatureKey =
  | "fn"
  | "phone"
  | "corrections"
  | "words"
  | "notify"
  | "privacy"
  | "oss"
  | "free"
  | "start"
  | "faq";

export interface Feature {
  key: FeatureKey;
  /** a short heading, a few words */
  title: string;
  /** one line, for lists and tiles */
  short: string;
  /** two or three sentences, for a row of its own */
  body: string;
}

/** The slogan (design system, verbatim). */
export const SLOGAN = "Tal. Slip. Indsæt.";

/** The product in one sentence (spec 1, shortened). */
export const ONE_LINER =
  "Dansk tale til tekst. Hold fn nede, tal, og slip, så står teksten der, hvor du skriver.";

/** The line under the hero's buttons. */
export const FINE_PRINT =
  "Gratis og open source · Mac og Windows · Ingen konto";

/** Calls to action. */
export const CTA = {
  download: "Hent gratis",
  how: "Sådan virker det",
  contact: "Skriv til os",
  business: "WalkieTalkey til virksomheder",
  repo: "Se koden på GitHub",
  allQuestions: "Alle spørgsmål og svar",
};

/** What the product itself says in the pill and on the phone (spec Appendix A, verbatim). */
export const PRODUCT = {
  holdFn: "Hold fn for at tale",
  listening: "Lytter",
  processing: "Renskriver",
  pasted: "Indsat",
  ready: "Tekst klar til at indsætte",
  pressPaste: "Tryk ⌘V for at indsætte",
  phoneHold: "Hold for at tale",
  phoneRelease: "Slip for at sende",
  phoneSending: "Sender til {computer}",
  phoneReady: "Klar på {computer}",
  encrypted: "Krypteret fra telefon til computer",
};

/** The dictation the hero's stage lands in the mail: something a person would say at work, in Danish. */
export const SAMPLES = {
  mail: "Jeg sender referatet fra mødet i morgen tidlig, så vi kan tage beslutningen torsdag.",
};

export const FEATURES: Record<FeatureKey, Feature> = {
  fn: {
    key: "fn",
    title: "Hold fn, og tal",
    short: "Hold fn nede, tal, og slip. Teksten står, hvor du skriver.",
    body: "Hold fn nede på din Mac, og tal dansk. Når du slipper, står teksten i det program, du skriver i: mail, Slack, Word eller et kodevindue. På Windows er det højre Ctrl, og du kan vælge en anden tast.",
  },
  phone: {
    key: "phone",
    title: "Telefonen er din mikrofon",
    short:
      "Hold knappen på telefonen, tal, og slip. Teksten lander på din computer.",
    /* run 10 dropped "eller vil tale lavt": speaking quietly is not measured, like whispering */
    body: "Telefonappen er én stor knap. Hold den, tal, og slip, så ligger teksten klar på din computer. Godt, når du går rundt eller står ved tavlen.", // TODO(copy)
  },
  corrections: {
    key: "corrections",
    title: "Den retter, når du retter dig selv",
    short:
      "Siger du onsdag, nej, torsdag, står der torsdag. Med AI-oprydning, hvis du slår den til.",
    body: "Siger du onsdag, nej, torsdag, skriver den kun torsdag. Det gør AI-oprydning, som er valgfri og slået fra, indtil du selv slår den til. Så sendes teksten, ikke lyden, til den udbyder, du vælger, eller den bliver på din Mac med Apple Intelligence.",
  },
  words: {
    key: "words",
    title: "Din egen ordliste",
    short: "Navne og fagord, skrevet som du vil have dem.",
    body: "Skriv navne, kunder og fagord ind én gang, så hjælper de talemodellen med at stave dem. Og vælg selv, hvad der skal stå: når du siger walkie talkey, skriver den WalkieTalkey.",
  },
  notify: {
    key: "notify",
    title: "Teksten lander, hvor du sidder",
    short: "En lille besked på computeren: Tekst klar til at indsætte.",
    body: "Taler du i telefonen, lægger computeren teksten i udklipsholderen og viser en lille besked: Tekst klar til at indsætte. Tryk ⌘V, hvor du vil have den. Har du flere computere, lander den på den computer, du sidder ved, og kun der.",
  },
  privacy: {
    key: "privacy",
    title: "Din stemme bliver hos dig",
    short: "Talen bliver til tekst på din egen computer.",
    body: "En dansk talemodel kører på din Mac eller pc. Taler du i telefonen, er lyden krypteret hele vejen, og relæet imellem kan ikke læse den. Lyden gemmes ikke, og der er ingen konto og ingen sporing.",
  },
  oss: {
    key: "oss",
    title: "Open source",
    short: "Al koden ligger åbent under Apache-2.0.",
    body: "Al koden ligger åbent på GitHub under Apache-2.0. Alle kan se, hvad der sker med stemmen, bygge appen selv og foreslå forbedringer.",
  },
  free: {
    key: "free",
    title: "Gratis for alle, også for virksomheder",
    short: "0 kr. for alle. Betalt hjælp til opsætning, hvis I vil have den.",
    body: "WalkieTalkey koster ikke noget, heller ikke for virksomheder. Vil I have det sat op på alle computere, med fælles ordliste og jeres eget relæ, kan I købe hjælp til det.",
  },
  start: {
    key: "start",
    title: "Kom i gang på et minut",
    short: "Hent appen, giv to tilladelser, og hold fn.",
    body: "Appen henter selv den danske talemodel, mens du går gennem et par korte trin.",
  },
  faq: {
    key: "faq",
    title: "Det, folk plejer at spørge om",
    short: "Pris, privatliv, talemodellen og computerne.",
    body: "",
  },
};

/** Privacy in four facts that hold (spec 2.6, DESK-92, PRIV-01). The first two are Appendix A, verbatim. */
export const PRIVACY_FACTS: { title: string; body: string }[] = [
  {
    title: "Talen bliver til tekst på din egen computer",
    body: "En dansk talemodel kører lokalt. Ingen sky lytter med.",
  },
  {
    title: "Krypteret fra telefon til computer",
    body: "Telefonen krypterer lyden, og kun din computer kan låse den op. Relæet imellem kan ikke læse den.",
  },
  {
    title: "Ingen lyd gemmes",
    body: "Lyden slettes, så snart den er blevet til tekst, medmindre du selv slår Gem lyd til fejlfinding til.",
  },
  {
    title: "Ingen konto",
    body: "Intet login, ingen e-mail og ingen sporing. Telefonen og computeren finder hinanden med en kode.",
  },
];

/** Getting started (run 5's first run: two permissions, the model downloads by itself). */
export const STEPS: { title: string; body: string }[] = [
  {
    title: "Hent appen",
    body: "Til Mac og Windows. Den danske talemodel hentes i baggrunden og bliver på din computer.",
  },
  {
    title: "Giv to tilladelser",
    body: "Mikrofonen, så den kan høre dig, og tilgængelighed, så teksten kan sættes ind, hvor du skriver.",
  },
  {
    title: "Hold fn, og tal",
    body: "Slip, og teksten står der. Vil du også tale i telefonen, scanner du en kode.",
  },
];

/** What is free, and what the paid setup help covers (principle 3). */
export const PLANS = {
  free: {
    title: "WalkieTalkey",
    price: "0 kr.",
    note: "For alle, også virksomheder",
    items: [
      "Mac og Windows",
      "Telefonappen til iPhone og Android",
      "Dansk talemodel på din egen computer",
      "Ingen konto og ingen sporing",
    ],
  },
  help: {
    title: "Hjælp til opsætning",
    price: "Betalt hjælp",
    note: "Til virksomheder, der vil have det sat op",
    items: [
      "Udrulning til alle computere med færdige indstillinger",
      "Fælles ordliste med kunder, produkter og fagord",
      "Jeres eget relæ og jeres egen telefonapp",
      "Svar til IT og jura om data og sikkerhed",
    ],
  },
  footnote:
    "Hjælpen er en service, ikke en licens. Appen er den samme for alle.",
};

export interface Question {
  q: string;
  a: string;
}

/** A short FAQ (the rest is on /spoergsmaal). TODO(claim): "Kan jeg hviske?" comes back once whispering is measured. */
export const FAQ: Question[] = [
  {
    q: "Er det virkelig gratis?",
    a: "Ja. Koden er open source under Apache-2.0, og appen koster ikke noget, heller ikke for virksomheder. Det eneste, der koster, er hjælp til opsætning, hvis I vil have den.",
  },
  {
    q: "Hvor bliver min stemme af?",
    a: "Den bliver til tekst på din egen computer. Taler du i telefonen, sendes lyden krypteret til din computer. Relæet imellem kan ikke læse den, og lyden gemmes ikke.",
  },
  {
    q: "Hvilken talemodel bruger I?",
    a: "Edda, en dansk udgave af Whisper fra Alexandra Instituttet, trænet på over 2.600 timers dansk tale. Den kører på din egen computer.",
  },
  {
    q: "Hvilke computere virker det på?",
    a: "Mac med macOS 13 Ventura eller nyere og Windows 10 (22H2) eller Windows 11 i 64-bit. Du skal bruge 8 GB RAM og omkring 2 GB fri plads til talemodellen.",
  },
  {
    q: "Skal jeg have en konto?",
    a: "Nej. Der er intet login, ingen e-mail og ingen adgangskode. Telefonen og computeren finder hinanden, når du scanner en kode.",
  },
];

/* ---------------------------------------------------------------------------------- The rows of the front page */

/** The feature rows (run 10): each with its own demo, a ShowcaseCard scene from the design system (the devices row
    has a frameless scene of its own). Titles and texts are the production cards'; `body` is the longer text from
    FEATURES. Every heading makes sense on its own (the owner's brief, run 10), so "Eller tal ind i telefonen" and
    "Lander som en notifikation" gave way to whole sentences. */
export type ShowcaseKey =
  "fn" | "phone" | "corrections" | "words" | "notify" | "devices";

export interface Showcase {
  key: ShowcaseKey;
  /** the design system's ShowcaseCard scene */
  scene:
    "fn" | "telefon" | "renskriv" | "notifikation" | "enheder" | "ordliste";
  title: string;
  text: string;
  body?: string;
  /** a measured fact, in plain words, under the body */
  fact?: string;
}

/** DESK-43, DESK-46: the wait after release, measured on the owner's 16-inch MacBook Pro (M1 Pro, Edda on Metal):
    0.92 s for 16 s and 0.99 s for a two-minute dictation (docs/MODELS.md, run 4; 1.03 s and 0.99 s in run 5).
    Nothing else is measured yet, so the sentence names the machine. */
export const SPEED =
  "Målt på en MacBook Pro med M1 Pro står teksten der omkring et sekund efter, at du slipper, også når du har talt i to minutter."; // TODO(copy)

/** DESK-67: the built-in list exists and is on from the start; what it does for English words is not measured
    (TODO(claim) in the header), so only that is said. */
export const DEV_WORDS =
  "Ordlisten Udviklerord med pull request, deploy, standup og andre engelske fagord er slået til fra start."; // TODO(copy)

export const SHOWCASE: Record<ShowcaseKey, Showcase> = {
  fn: {
    key: "fn",
    scene: "fn",
    title: "Hold fn, tal, slip",
    text: "Statuspillen lytter, mens du taler, og renskriver, når du slipper. Teksten ligger klar til ⌘V.",
    body: FEATURES.fn.body,
    fact: SPEED,
  },
  phone: {
    key: "phone",
    scene: "telefon",
    title: FEATURES.phone.title,
    text: "Hold knappen, tal, slip. Teksten lander på den computer, du sidder ved.",
    body: FEATURES.phone.body,
  },
  corrections: {
    key: "corrections",
    scene: "renskriv",
    title: "Den retter dig, når du retter dig selv",
    text: 'Slår du AI-oprydning til, bliver "onsdag, nej, torsdag" bare til torsdag. Fyldord forsvinder også uden den.',
    body: FEATURES.corrections.body,
  },
  words: {
    key: "words",
    scene: "ordliste",
    title: "Dine ord, stavet rigtigt",
    text: "Kundenavne, fagord og produktnavne fra din egen ordliste.",
    body: `${FEATURES.words.body} ${DEV_WORDS}`,
  },
  notify: {
    key: "notify",
    scene: "notifikation",
    title: "Teksten kommer som en notifikation", // TODO(copy): a whole sentence for "Lander som en notifikation"
    text: "Du vælger selv, hvor teksten skal stå.",
    /* run 10 left out the last sentence, which the next row says ("Har du flere computere, ...") */
    body: "Taler du i telefonen, lægger computeren teksten i udklipsholderen og viser en lille besked: Tekst klar til at indsætte. Tryk ⌘V, hvor du vil have den.", // TODO(copy)
  },
  devices: {
    key: "devices",
    scene: "enheder",
    title: FEATURES.notify.title,
    text: "Den computer, du bruger, får teksten. De andre får den ikke.",
    /* spec 5.5, PHONE-40 */
    body: "Er telefonen parret med flere computere, sender den til den, du sidst har brugt. Teksten findes kun på den computer og kopieres aldrig til de andre eller til telefonen.", // TODO(copy)
  },
};

/** The feature rows, in the order a visitor meets them. */
export const SHOWCASE_ORDER: ShowcaseKey[] = [
  "fn",
  "phone",
  "corrections",
  "words",
  "notify",
  "devices",
];

/** Every row of the page, features first: the box of each one sits on the other side of the one before it,
    starting on the right (the owner's "right, left, right, left", run 10). */
export type RowKey = ShowcaseKey | "privacy" | "oss" | "start" | "free";
export const ROW_ORDER: RowKey[] = [
  ...SHOWCASE_ORDER,
  "privacy",
  "oss",
  "start",
  "free",
];
/** Which side a row's box (its demo or picture) stands on beside its words; on a phone the words come first. */
export function boxSide(row: RowKey): "right" | "left" {
  const i = ROW_ORDER.indexOf(row);
  if (i < 0) throw new Error(`unknown row ${row}`);
  return i % 2 === 0 ? "right" : "left";
}

/** The intro over the features (production front page). */
export const SHOWCASE_INTRO = {
  eyebrow: "Funktioner",
  title: "Lavet til den måde, du taler på",
  lead: "Du taler, som du plejer. WalkieTalkey sætter tegn og staver dine egne ord rigtigt. Slår du AI-oprydning til, retter den også dine omformuleringer.",
};

/** Small labels on the stage and in the privacy picture. */
export const STAGE = {
  relay: "Relæ",
  privacyMore: "Læs om privatliv",
  subject: "Mødet i morgen",
  to: "Mette Holm",
  newMessage: "Ny besked",
  /** the hero's picture, for screen readers */
  heroLabel:
    "En bærbar computer og en telefon. Du holder fn-tasten nede og taler, og computeren lytter. Først når du slipper, står teksten i mailen, og statuspillen siger Indsat.",
  privacyLabel:
    "Telefonen krypterer lyden og sender den gennem relæet til din computer. Relæet kan ikke læse den. Talen bliver til tekst på computeren.",
  ossLabel: "En computer med WalkieTalkeys kode åben, og licensen Apache-2.0.",
};

/** Getting started and the price, the demos' words. */
export const TRY = {
  permissionsTitle: "Prøv: slå dem til",
  ready: "Klar. Hold fn, og tal.",
  waiting: "Venter på tilladelserne",
  permissions: ["Mikrofon", "Tilgængelighed"] as const,
  get: "Hent til Mac eller Windows",
  countLabel: "Hvor mange computere?",
  one: "for 1 computer",
  many: "for {n} computere",
  hint: "Mange computere? Vi hjælper gerne med at sætte dem op.",
};
