/* Run 5: the front page's hero comes in three variants over the same page, chosen at build time so the owner can
   compare them on Cloudflare Pages previews (scripts/deploy-previews.ts):
     SITE_HERO=fn | phone | privacy   which hero; without it the fn-led one, the production default
     SITE_DRAFT=1                      a draft preview: shows the claims nobody has measured yet, marked TODO(claim)
   Everything a visitor reads is Danish; all of it is new copy, so all of it is TODO(copy). */

export const HERO_VARIANTS = ["fn", "phone", "privacy"] as const;
export type HeroVariant = (typeof HERO_VARIANTS)[number];
export const DEFAULT_HERO: HeroVariant = "fn";

/** The variant for a SITE_HERO value. An unknown value stops the build rather than ship the wrong page. */
export function pickHero(value: string | undefined): HeroVariant {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return DEFAULT_HERO;
  if ((HERO_VARIANTS as readonly string[]).includes(v)) return v as HeroVariant;
  throw new Error(
    `SITE_HERO must be one of ${HERO_VARIANTS.join(", ")}, not "${value}"`,
  );
}

/** SITE_DRAFT=1: a preview for the owner, which also shows the unmeasured claims, visibly marked. */
export function draftClaims(value: string | undefined): boolean {
  return value === "1";
}

/** The Cloudflare Pages preview branch of a variant; production is the branch main, which a preview never uses. */
export function previewBranch(v: HeroVariant): string {
  return "hero-" + v;
}
export const PREVIEW_BRANCHES = HERO_VARIANTS.map(previewBranch);

export interface HeroCopy {
  /** h1 */
  title: string;
  /** the sentence under the title; {fn} becomes a keycap */
  lead: string;
  /** a quieter second sentence */
  second: string;
  /** the line under the buttons, which starts with "Gratis og open source" */
  fine: string;
}

// TODO(copy): every string below (run 5, drafted from the owner's brief and spec 2.6)
export const HERO: Record<HeroVariant, HeroCopy> = {
  /* fn-led: the key on the Mac, then the phone as the alternative the stage shows */
  fn: {
    title: "Tal. Slip. Indsæt.",
    lead: "Hold {fn} nede, og tal dansk. Når du slipper, står teksten der, hvor du skriver.",
    second: "Eller tal ind i telefonen, så lander teksten på din computer.",
    fine: "Gratis og open source · Mac og Windows · Ingen konto",
  },
  /* phone-led: the stage's story told in words */
  phone: {
    title: "Tal i telefonen. Teksten lander på computeren.",
    lead: "Hold knappen, tal, og slip. Teksten ligger klar til at indsætte på den computer, du sidder ved.",
    second:
      "Krypteret fra telefon til computer. Ved tastaturet holder du bare {fn} nede.",
    fine: "Gratis og open source · iPhone og Android · Ingen konto",
  },
  /* privacy-led: the claim that holds, word for word (spec 2.6), as the title */
  privacy: {
    title: "Talen bliver til tekst på din egen computer.",
    lead: "Dansk diktering uden sky, konto eller sporing. Og al koden ligger åbent.",
    second:
      "Taler du i telefonen, er lyden krypteret fra telefon til computer.",
    fine: "Gratis og open source · Mac, Windows og telefonen",
  },
};

/** The variant and draft mode of this build. */
export const BUILD = {
  hero: pickHero(process.env.SITE_HERO),
  draft: draftClaims(process.env.SITE_DRAFT),
};
