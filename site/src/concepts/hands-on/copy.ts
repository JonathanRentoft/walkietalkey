/* Concept C (hands-on): the few words this page needs beyond the shared copy in lib/features.ts. Danish, sentence case,
   du-form, no em dashes, no exclamation marks. Everything that is said about the product comes from lib/features.ts;
   this is only microcopy for the demos (labels, hints, what a control does).

   TODO(copy): every string in this file (run 6, concept C) */

export const HO = {
  hero: {
    /** the minimal document the toy writes into */
    docTitle: "Ny note",
    /** the hint under the button: "Hold [key] nede, og slip" */
    holdBefore: "Hold",
    holdAfter: "nede, og slip",
    keySpace: "mellemrum",
    keyFn: "fn",
    /** while the key is held */
    holding: "Slip, når du er færdig. Esc annullerer.",
    holdingTouch: "Slip, når du er færdig",
    /** a tap shorter than 300 ms (DESK-26) */
    short: "Hold lidt længere. Teksten kommer, når du slipper.",
    /** Esc while holding (DESK-25) */
    cancelled: "Annulleret. Der blev ikke skrevet noget.",
    /** honest about what the toy is */
    honest: "Siden lytter ikke. Den skriver en prøvesætning, som om du havde sagt den.",
    /** for screen readers, after the text lands */
    pastedSay: "Indsat: {text}",
  },
  bento: {
    eyebrow: "Prøv det selv",
    title: "Hvert kort er en lille prøve",
    lead: "Hold, tryk og skriv. Sådan virker resten af WalkieTalkey, også når du lader kortene være.",
  },
  /** the small hint in each tile that says what to do */
  try: {
    phone: "Hold knappen",
    notify: "Vælg en computer",
    corrections: "Slå den til og fra",
    words: "Skriv et navn",
    fn: "Vælg et program",
    mixed: "Tryk på et ord",
    privacy: "Send en ny",
    oss: "Kopiér",
  },
  phone: {
    button: "Hold telefonens knap for at tale",
  },
  notify: {
    computers: ["MacBook", "Kontor-pc"] as const,
    here: "Du sidder her",
    sit: "Sæt dig ved {computer}",
    landed: "Teksten landede på {computer}",
  },
  corrections: {
    said: "Du sagde",
    written: "Der står",
    on: "AI-oprydning er slået til",
    off: "AI-oprydning er slået fra",
  },
  words: {
    list: "Din ordliste",
    label: "Tilføj et navn",
    placeholder: "Skriv et navn",
    add: "Tilføj",
    said: "Du sagde",
    written: "Der står",
  },
  fn: {
    apps: ["Mail", "Slack", "Word", "Kode"] as const,
    mailTo: "Til:",
    mailSubject: "Emne:",
    subject: "Referat",
    channel: "# team",
    mac: "Mac",
    windows: "Windows",
    right: "højre",
  },
  mixed: {
    list: "Udviklerord",
  },
  privacy: {
    relay: "Relæet ser",
    computer: "Din computer ser",
    again: "Send en ny",
    more: "Læs om privatliv",
  },
  oss: {
    copy: "Kopiér",
    copied: "Kopieret",
    command: "Hent koden",
  },
  start: {
    title: "Prøv: slå dem til",
    ready: "Klar. Hold fn, og tal.",
    waiting: "Venter på tilladelserne",
    permissions: ["Mikrofon", "Tilgængelighed"] as const,
    get: "Hent til Mac eller Windows",
  },
  free: {
    label: "Hvor mange computere?",
    one: "for 1 computer",
    many: "for {n} computere",
    hint: "Mange computere? Vi hjælper gerne med at sætte dem op.",
  },
  faq: {
    eyebrow: "Spørgsmål",
  },
};

/** "{name}" placeholders, filled in at build time. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");
}
