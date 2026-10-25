/* Run 6: what this build of the site is, chosen at build time.

   The front page comes in three complete concepts for the owner to compare, each deployed to its own Cloudflare Pages
   preview (scripts/deploy-previews.ts). Without SITE_CONCEPT the build is the current front page, the one in
   production, so a production deploy from main stays the same until the owner picks.
     SITE_CONCEPT=editorial | stage | hands-on   which front page (src/concepts/<name>/Home.astro)
     SITE_DRAFT=1                                a draft preview: also shows the claims nobody has measured yet,
                                                 visibly marked TODO(claim) (components/home/Claim.astro)
   astro.config.mjs points the import alias @concept at the chosen folder, so a build holds one front page only. */

export const CONCEPTS = ["editorial", "stage", "hands-on"] as const;
export type Concept = (typeof CONCEPTS)[number];

export interface ConceptInfo {
  /** A, B or C in the brief */
  letter: "a" | "b" | "c";
  /** the brief's name for it */
  title: string;
  /** the class prefix of everything the concept adds, so no two concepts share a rule */
  prefix: string;
}

export const CONCEPT_INFO: Record<Concept, ConceptInfo> = {
  editorial: { letter: "a", title: "Editorial", prefix: "ed-" },
  stage: { letter: "b", title: "Product stage", prefix: "ps-" },
  "hands-on": { letter: "c", title: "Hands-on", prefix: "ho-" },
};

/** The concept for a SITE_CONCEPT value; empty is the current front page. An unknown value stops the build. */
export function pickConcept(value: string | undefined): Concept | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  const byLetter = CONCEPTS.find((c) => CONCEPT_INFO[c].letter === v);
  if (byLetter) return byLetter;
  if ((CONCEPTS as readonly string[]).includes(v)) return v as Concept;
  throw new Error(
    `SITE_CONCEPT must be one of ${CONCEPTS.join(", ")} (or a, b, c), not "${value}"`,
  );
}

/** The folder under src/concepts/ that holds a build's front page. */
export function conceptDir(c: Concept | null): string {
  return c ?? "current";
}

/** SITE_DRAFT=1: a preview for the owner, which also shows the unmeasured claims, visibly marked. */
export function draftClaims(value: string | undefined): boolean {
  return value === "1";
}

/** The Cloudflare Pages preview branch of a concept; production is the branch main, which a preview never uses. */
export function previewBranch(c: Concept): string {
  return "concept-" + CONCEPT_INFO[c].letter;
}
export const PREVIEW_BRANCHES = CONCEPTS.map(previewBranch);

/** The concept and draft mode of this build. */
export const BUILD = {
  concept: pickConcept(process.env.SITE_CONCEPT),
  draft: draftClaims(process.env.SITE_DRAFT),
};
