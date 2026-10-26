/* What this build of the site is, chosen at build time.

   Run 8: the front page comes as three finished pages for the owner to pick from, each deployed to its own Cloudflare
   Pages preview (scripts/deploy-previews.ts). They share the hero (concept B's lit stage), the privacy section, getting
   started and the price, and the production front page's feature demos (src/components/final/); they differ in the
   hero's background and in the order, grouping and transitions of the rest. Without SITE_CONCEPT the build is the
   current front page, the one in production, so a production deploy from main stays the same until the owner picks.
     SITE_CONCEPT=waves | bars | metal (or 1, 2, 3)   which front page (src/concepts/<name>/Home.astro)
     SITE_DRAFT=1                                     a draft preview: also shows the claims nobody has measured yet,
                                                      visibly marked TODO(claim) (components/home/Claim.astro)
   astro.config.mjs points the import alias @concept at the chosen folder, so a build holds one front page only. */

export const CONCEPTS = ["waves", "bars", "metal"] as const;
export type Concept = (typeof CONCEPTS)[number];

export interface ConceptInfo {
  /** 1, 2 or 3 in the brief */
  n: 1 | 2 | 3;
  /** the hero's background, which names the page */
  title: string;
  /** the class prefix of the page's own rules; the sections they share use SHARED_PREFIX */
  prefix: string;
}

export const CONCEPT_INFO: Record<Concept, ConceptInfo> = {
  waves: { n: 1, title: "LightWaves", prefix: "fw-" },
  bars: { n: 2, title: "BarField", prefix: "fb-" },
  metal: { n: 3, title: "FluidMesh Nat", prefix: "fm-" },
};

/** The class prefix of the sections the three pages share (src/components/final/). */
export const SHARED_PREFIX = "fp-";

/** The concept for a SITE_CONCEPT value; empty is the current front page. An unknown value stops the build. */
export function pickConcept(value: string | undefined): Concept | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  const byNumber = CONCEPTS.find((c) => String(CONCEPT_INFO[c].n) === v);
  if (byNumber) return byNumber;
  if ((CONCEPTS as readonly string[]).includes(v)) return v as Concept;
  throw new Error(
    `SITE_CONCEPT must be one of ${CONCEPTS.join(", ")} (or 1, 2, 3), not "${value}"`,
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

/** The Cloudflare Pages preview branch of a page; production is the branch main, which a preview never uses. */
export function previewBranch(c: Concept): string {
  return "final-" + CONCEPT_INFO[c].n;
}
export const PREVIEW_BRANCHES = CONCEPTS.map(previewBranch);

/** The concept and draft mode of this build. */
export const BUILD = {
  concept: pickConcept(process.env.SITE_CONCEPT),
  draft: draftClaims(process.env.SITE_DRAFT),
};
