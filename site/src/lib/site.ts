/* Shared facts for every page. User-facing strings are Danish; everything new is marked TODO(copy) where it is written. */

/** Who operates the public relay and the website (decision 18.1, decided in run 2). */
export const OPERATOR = "Navigent.io ApS (CVR 46285395)";

export const REPO_URL = "https://github.com/JonathanRentoft/walkietalkey";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const SECURITY_REPORT_URL = `${REPO_URL}/security/advisories/new`;
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const TRADEMARKS_URL = `${REPO_URL}/blob/main/TRADEMARKS.md`;
export const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;

/* walkietalkey.com is not registered yet (review finding 18), so nothing on the site may send a visitor there. Once
   the owner has the domain:
   - SITE_URL is already right: canonical and Open Graph URLs use it (also astro.config.mjs);
   - PHONE_APP_URL becomes https://app.walkietalkey.com and RELAY_URL wss://relay.walkietalkey.com (SITE-03), once
     those hosts answer;
   - CONTACT_URL becomes "mailto:kontakt@walkietalkey.com" once Cloudflare Email Routing forwards it (SITE-05), and the
     pages that name "Discussions på GitHub" or GitHub's private form in their text get their copy back. */

/** The site's own address, the one constant behind every canonical and Open Graph URL. */
export const SITE_URL = "https://walkietalkey.com";
/** The phone app (Pages project walkietalkey-app), the desktop app's default PhoneAppUrl. */
export const PHONE_APP_URL = "https://walkietalkey-app.pages.dev";
/** The public relay (Worker walkietalkey-relay), the desktop app's default RelayUrl. */
export const RELAY_URL = "wss://walkietalkey-relay.jonathan0912.workers.dev";
/** SITE-05: no contact form. Until the domain's e-mail works, questions go to GitHub Discussions, and anything that
    must stay private goes through GitHub's private form (SECURITY_REPORT_URL). */
export const CONTACT_URL = DISCUSSIONS_URL;

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
