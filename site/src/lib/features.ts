/* Run 6: everything the front page says, shared by the three concepts (src/concepts/), so each one shows every
   feature with the same facts and only the way they are shown differs. Danish, sentence case, no em dashes, no
   exclamation marks (spec Appendix A, design system). Only claims that are true (spec 2.6): what nobody has measured
   yet sits in `claim` and is rendered through <Claim> (TODO(claim)), which production leaves out.

   Every string here is new copy for the owner to approve: TODO(copy). Strings quoted from spec Appendix A or the
   design system are marked "Appendix A" next to them.

   Words always land at release: the app transcribes while you talk, but the text appears only when you let go
   (DESK-46, DESK-52). Every demo shows it that way. */

export type FeatureKey =
  | "fn"
  | "phone"
  | "corrections"
  | "mixed"
  | "words"
  | "notify"
  | "privacy"
  | "oss"
  | "free"
  | "start"
  | "faq";

/** A sentence nobody has measured yet: shown only in draft previews, marked TODO(claim). */
export interface Claim {
  text: string;
  /** what has to be measured before it may be said */
  what: string;
}

export interface Feature {
  key: FeatureKey;
  /** a short heading, a few words */
  title: string;
  /** one line, for lists and tiles */
  short: string;
  /** two or three sentences, for the concepts that give a feature room */
  body: string;
  claim?: Claim;
}

// TODO(copy): every string in this file (run 6)

/** The slogan (design system, verbatim). */
export const SLOGAN = "Tal. Slip. Indsæt.";

/** The product in one sentence (spec 1, shortened). */
export const ONE_LINER =
  "Dansk tale til tekst. Hold fn nede, tal, og slip, så står teksten der, hvor du skriver.";

/** The line under every hero's buttons. */
export const FINE_PRINT = "Gratis og open source · Mac og Windows · Ingen konto";

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

/** Sample dictations for the demos. Each is something a person would say at work, in Danish. */
export const SAMPLES = {
  /** the hero sentence (spec 6.2, DESK-17, Appendix A uses "Hej, det her er min første diktering") */
  first: "Hej, det her er min første diktering.",
  mail: "Jeg sender referatet fra mødet i morgen tidlig, så vi kan tage beslutningen torsdag.",
  /** a self-correction, before and after AI cleanup (DESK-83) */
  correctionSaid: "Lad os mødes onsdag, nej, torsdag klokken ti.",
  correctionWritten: "Lad os mødes torsdag klokken ti.",
  /** Danish and English in one sentence (DESK-67, DESK-70) */
  mixed: "Jeg merger din pull request efter standup og deployer til staging.",
  /** the word list: a name and a term (DESK-66) */
  wordsSaid: "Send det til mette holm fra navigent",
  wordsWritten: "Send det til Mette Holm fra Navigent.",
  /** a phone dictation (DESK-52) */
  phone: "Husk at bestille bord til fredag.",
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
    short: "Hold knappen på telefonen, tal, og slip. Teksten lander på din computer.",
    body: "Telefonappen er én stor knap. Hold den, tal, og slip, så ligger teksten klar på din computer. Godt, når du går rundt, står ved tavlen eller vil tale lavt.",
    claim: {
      text: "Du kan også hviske, så du ikke forstyrrer i et åbent kontor.",
      what: "hvor godt talemodellen forstår hvisken i telefonen",
    },
  },
  corrections: {
    key: "corrections",
    title: "Den retter, når du retter dig selv",
    short: "Siger du onsdag, nej, torsdag, står der torsdag. Med AI-oprydning, hvis du slår den til.",
    body: "Siger du onsdag, nej, torsdag, skriver den kun torsdag. Det gør AI-oprydning, som er valgfri og slået fra, indtil du selv slår den til. Så sendes teksten, ikke lyden, til den udbyder, du vælger, eller den bliver på din Mac med Apple Intelligence.",
  },
  mixed: {
    key: "mixed",
    title: "Dansk og engelsk i samme sætning",
    short: "Tal, som du taler på arbejdet, med de engelske ord.",
    body: "Ingen skifter sprog midt i en sætning med vilje, men alle gør det. Ordlisten Udviklerord kender pull request, deploy, standup og de andre engelske ord, vi bruger på dansk.",
    claim: {
      text: "Den skriver de engelske ord, som du siger dem.",
      what: "hvor godt Edda skriver engelske ord i danske sætninger",
    },
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

/** The order a visitor meets them in, when a concept lists them all. */
export const FEATURE_ORDER: FeatureKey[] = [
  "fn",
  "phone",
  "corrections",
  "mixed",
  "words",
  "notify",
  "privacy",
  "oss",
  "free",
  "start",
  "faq",
];

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
  footnote: "Hjælpen er en service, ikke en licens. Appen er den samme for alle.",
};

export interface Question {
  q: string;
  a: string;
  /** an answer nobody has measured yet: the whole question is a claim */
  claim?: string;
}

/** A short FAQ (the rest is on /spoergsmaal). */
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
  {
    q: "Kan jeg hviske?",
    a: "Ja. Talemodellen forstår også, når du hvisker i telefonen, så du kan diktere i et åbent kontor uden at forstyrre.",
    claim: "hvor godt talemodellen forstår hvisken i telefonen",
  },
];
