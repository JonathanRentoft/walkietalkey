/* Shared facts for every page. User-facing strings are Danish; everything new is marked TODO(copy) where it is written. */

/** OPEN DECISION 18.1 (owner): who operates the public relay and the website: Jonathan personally, or Navigent.io ApS.
    This is the only placeholder on the site; replace the value once the owner has decided. */
export const OPERATOR = "[Operatør: afventer ejerens beslutning]";

/** SITE-05: contact on the domain, forwarded with Cloudflare Email Routing. No contact form. */
export const CONTACT_EMAIL = "kontakt@walkietalkey.com";

export const REPO_URL = "https://github.com/JonathanRentoft/walkietalkey";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const SECURITY_REPORT_URL = `${REPO_URL}/security/advisories/new`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const TRADEMARKS_URL = `${REPO_URL}/blob/main/TRADEMARKS.md`;
export const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;
export const PHONE_APP_URL = "https://app.walkietalkey.com";
export const SITE_URL = "https://walkietalkey.com";

export interface PageInfo {
  path: string;
  /** label in the navigation */
  nav: string;
  /** <title> */
  title: string;
  /** <meta name="description"> */
  description: string;
}

/* SITE-02: the pages, with Danish slugs. */
export const PAGES = {
  home: {
    path: "/",
    nav: "Forside",
    title: "WalkieTalkey · Dansk tale til tekst, gratis og open source",
    // TODO(copy)
    description:
      "Hold fn nede, eller tal ind i telefonen. Talen bliver til tekst på din egen computer. Gratis og open source, ingen konto.",
  },
  hent: {
    path: "/hent",
    nav: "Hent",
    // TODO(copy)
    title: "Hent WalkieTalkey til Mac og Windows",
    // TODO(copy)
    description:
      "Hent WalkieTalkey gratis til Mac eller Windows. Appen henter den danske talemodel første gang og kører på din egen computer.",
  },
  how: {
    path: "/saadan-virker-det",
    nav: "Sådan virker det",
    // TODO(copy)
    title: "Sådan virker WalkieTalkey",
    // TODO(copy)
    description:
      "Fra tasten eller telefonen til tekst på din computer: talemodellen, krypteringen fra telefon til computer, og hvorfor der ikke er nogen konto.",
  },
  privacy: {
    path: "/privatliv",
    nav: "Privatliv",
    // TODO(copy)
    title: "Privatliv · WalkieTalkey",
    // TODO(copy)
    description:
      "Hvilke data der findes hvor, hvor længe, og hvem der kan læse dem. Ingen konto og ingen sporing.",
  },
  oss: {
    path: "/open-source",
    nav: "Open source",
    // TODO(copy)
    title: "Open source · WalkieTalkey",
    // TODO(copy)
    description:
      "WalkieTalkey er open source under Apache-2.0 og bygget på Handy. Her er licensen, koden og de projekter, vi bygger på.",
  },
  business: {
    path: "/virksomheder",
    nav: "Virksomheder",
    // TODO(copy)
    title: "WalkieTalkey til virksomheder",
    // TODO(copy)
    description:
      "Gratis for alle, også virksomheder. Færdige indstillinger til udrulning, jeres eget relæ og betalt hjælp til opsætning.",
  },
  security: {
    path: "/sikkerhed",
    nav: "Sikkerhed",
    // TODO(copy)
    title: "Sikkerhed · WalkieTalkey",
    // TODO(copy)
    description:
      "Sådan er WalkieTalkey bygget, hvad krypteringen beskytter mod, og hvordan du melder en sårbarhed.",
  },
  trademark: {
    path: "/varemaerke",
    nav: "Varemærke",
    // TODO(copy)
    title: "Varemærke · WalkieTalkey",
    // TODO(copy)
    description:
      "Navnet WalkieTalkey og logoet er ikke omfattet af kodelicensen. Sådan må du bruge dem.",
  },
  faq: {
    path: "/spoergsmaal",
    nav: "Spørgsmål",
    // TODO(copy)
    title: "Spørgsmål og svar · WalkieTalkey",
    // TODO(copy)
    description:
      "Svar på det, folk plejer at spørge om: pris, privatliv, talemodellen, telefonen og virksomheder.",
  },
} satisfies Record<string, PageInfo>;

export type PageKey = keyof typeof PAGES;

/** The links in the header (as in ForsideKomplet). */
export const HEADER_NAV: PageKey[] = ["how", "privacy", "oss", "business"];

/** The footer reaches every page. */
export const FOOTER_NAV: PageKey[] = [
  "home",
  "hent",
  "how",
  "privacy",
  "security",
  "oss",
  "business",
  "trademark",
  "faq",
];
