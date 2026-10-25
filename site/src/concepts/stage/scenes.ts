/* Run 6, concept B (Product stage): the film's shots. One set (a laptop, a phone, a few props on a silver stage, drawn
   in World.astro) filmed from a different camera for every feature, so the devices are the protagonists and every
   feature is a scene they act out. Scroll is the timeline: each shot pins its stage while its sequence plays
   (hold, release, land), driven by the shot's view timeline in CSS (stage.css), or once by time where scroll-driven
   animations are missing (film.ts). Words always land at release (DESK-46, DESK-52): while a key or the phone button
   is held, the stage shows only what you say, as a film subtitle; the text appears on the computer after you let go.

   The finished state (land) is the base style of every element, so without JavaScript, with reduced motion or in a
   browser without scroll-driven animations, each shot stands in its finished state.

   Everything a visitor reads comes from lib/features.ts. The few new strings below are this concept's own
   microcopy and the pictures' descriptions for screen readers: TODO(copy), all of them. */
import type { FeatureKey } from "../../lib/features";
import { SAMPLES } from "../../lib/features";

/** The design size of the set, in world pixels. The camera scales a rectangle of it to fit its view. */
export const WORLD = { w: 1800, h: 1000 } as const;

/** A rectangle of the set to frame: centre x, centre y, width, height (world px). */
export type Rect = readonly [number, number, number, number];

/* The camera (stage.css, .ps-world): a transform that scales a rectangle to fit the view's box (--bx, --by: its centre;
   --bw, --bh: its size, in container units of the view) and centres it there. tan(atan2(a, b)) is a / b as a plain
   number, so the scale needs no JavaScript and every stage has its final size before anything loads. */

export type ShotKey = "hero" | "fn" | "phone" | "notify" | "corrections" | "mixed" | "words";

export interface ShotDef {
  key: ShotKey;
  /** the feature this shot shows (the hero shows none) */
  feature?: FeatureKey;
  /** camera in a wide view (desktop) and a tall one (phone); a second rectangle pans the camera on release */
  wide: Rect;
  tall: Rect;
  wide1?: Rect;
  tall1?: Rect;
  /** what you say, shown as a film subtitle while the key or button is held */
  said?: string;
  /** the picture's description for screen readers. TODO(copy) */
  label: string;
}

/** The kicker over each scene's title. TODO(copy) */
export const KICKER: Partial<Record<ShotKey, string>> = {
  fn: "På din Mac eller pc",
  phone: "I telefonen",
  notify: "På computeren",
  corrections: "AI-oprydning",
  mixed: "Udviklerord",
  words: "Ordlisten",
};

/** The subtitle's speaker. TODO(copy) */
export const SAYS = "Du siger";

// TODO(copy): every label below
export const SHOTS: Record<ShotKey, ShotDef> = {
  hero: {
    key: "hero",
    wide: [890, 545, 1180, 690],
    tall: [700, 560, 760, 740],
    label:
      "En bærbar computer og en telefon på en lys scene. Telefonen viser Hold for at tale, og computeren viser Hold fn for at tale.",
  },
  fn: {
    key: "fn",
    feature: "fn",
    wide: [1020, 560, 1080, 860],
    tall: [1060, 590, 700, 740],
    said: SAMPLES.mail,
    label:
      "Du holder fn-tasten nede og taler, og computeren lytter. Først når du slipper, står teksten i mailen, og statuspillen siger Indsat.",
  },
  phone: {
    key: "phone",
    feature: "phone",
    wide: [470, 610, 470, 640],
    tall: [465, 615, 330, 580],
    wide1: [900, 545, 1200, 700],
    said: SAMPLES.phone,
    label:
      "Du holder knappen på telefonen og taler, og telefonen siger Slip for at sende. Computeren viser intet endnu. Når du slipper, sender telefonen lyden, og på computeren kommer beskeden Tekst klar til at indsætte. Telefonen siger Klar på MacBook.",
  },
  notify: {
    key: "notify",
    feature: "notify",
    wide: [1220, 570, 1120, 800],
    tall: [1110, 600, 660, 760],
    label:
      "Beskeden Tekst klar til at indsætte står på den computer, du sidder ved. Du trykker ⌘V, og teksten står i mailen. Skærmen i baggrunden får ingenting.",
  },
  corrections: {
    key: "corrections",
    feature: "corrections",
    wide: [1000, 470, 660, 520],
    tall: [1000, 495, 520, 470],
    said: SAMPLES.correctionSaid,
    label:
      "Du siger: Lad os mødes onsdag, nej, torsdag klokken ti. Med AI-oprydning slået til står der: Lad os mødes torsdag klokken ti.",
  },
  mixed: {
    key: "mixed",
    feature: "mixed",
    wide: [1000, 480, 700, 540],
    tall: [1000, 495, 520, 470],
    said: SAMPLES.mixed,
    label:
      "Du siger en dansk sætning med engelske ord: Jeg merger din pull request efter standup og deployer til staging. Ordlisten Udviklerord kender de engelske ord.",
  },
  words: {
    key: "words",
    feature: "words",
    wide: [1010, 470, 820, 520],
    tall: [905, 500, 560, 480],
    said: SAMPLES.wordsSaid,
    label:
      "Din ordliste med Mette Holm og Navigent. Du siger send det til mette holm fra navigent, og der står: Send det til Mette Holm fra Navigent.",
  },
};

/** The order the film plays them in: the Mac first, then the phone sends and the computer receives, then the screen. */
export const FILM: ShotKey[] = ["fn", "phone", "notify", "corrections", "mixed", "words"];

/** The English words in the mixed sentence, which the screen marks. */
export const ENGLISH = ["merger", "pull request", "standup", "deployer", "staging"];
/** The names the word list fixes. */
export const NAMES = ["Mette Holm", "Navigent"];

/** Splits a sentence into parts, marking every occurrence of the given phrases. */
export function marked(text: string, phrases: string[]): { t: string; mark: boolean }[] {
  const re = new RegExp(`(${phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  return text
    .split(re)
    .filter((t) => t !== "")
    .map((t) => ({ t, mark: phrases.includes(t) }));
}

/** The word list on the screen (the user's own, DESK-66): what is written, and for the last one what is said. TODO(copy) */
export const WORD_LIST: { word: string; said?: string }[] = [
  { word: "Mette Holm" },
  { word: "Navigent" },
  { word: "WalkieTalkey", said: "walkie talkey" },
];
export const WORD_LIST_TITLE = "Ordliste";

/** Small labels on the stage. TODO(copy) */
export const STAGE = {
  relay: "Relæ",
  model: "Henter talemodellen",
  mic: "Mikrofon",
  access: "Tilgængelighed",
  privacyMore: "Læs om privatliv",
  subject: "Mødet i morgen",
  to: "Mette Holm",
  newMessage: "Ny besked",
};
