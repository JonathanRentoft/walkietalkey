/* Shared facts for every page. User-facing strings are Danish; a new one is marked TODO(copy) where it is written until
   the owner approves it (run 8: scripts/walkietalkey/copy-approved-texts.json lists the approved ones). */

/** Who operates the public relay and the website and is the data controller (decision 18.1; run 10: the owner
    personally, who also holds the copyright, the Apple account and the Cloudflare account). */
export const OPERATOR = "Jonathan Rentoft";

export const REPO_URL = "https://github.com/JonathanRentoft/walkietalkey";
export const ALL_RELEASES_URL = `${REPO_URL}/releases`;
export const SECURITY_REPORT_URL = `${REPO_URL}/security/advisories/new`;
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const TRADEMARKS_URL = `${REPO_URL}/blob/main/TRADEMARKS.md`;
export const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;

/* SITE-02, run 2 Phase 7.4: every release is a normal GitHub release (not a pre-release) with the same asset names
   (OSS-21), so these links always fetch the newest build without a stop on the release page. Mac: universal (Apple
   Silicon and Intel), macOS 13 or newer. Windows: the installer for Windows 10 22H2 or 11, 64-bit. */
export const MAC_DOWNLOAD_URL = `${REPO_URL}/releases/latest/download/WalkieTalkey-mac.dmg`;
export const WINDOWS_DOWNLOAD_URL = `${REPO_URL}/releases/latest/download/WalkieTalkey-windows.exe`;

/* Run 2, Phase 6: walkietalkey.com, app. and relay. answer with HTTPS and wss, and Cloudflare Email Routing forwards
   kontakt@ to the operator. The site sends visitors only there; the test deployments on pages.dev and workers.dev keep
   running for pairings made with v1, but no page points at them. */

/** The site's own address, the one constant behind every canonical and Open Graph URL (also astro.config.mjs). */
export const SITE_URL = "https://walkietalkey.com";
/** The phone app (SITE-03), the desktop app's default PhoneAppUrl. */
export const PHONE_APP_URL = "https://app.walkietalkey.com";
/** The public relay, the desktop app's default RelayUrl. */
export const RELAY_URL = "wss://relay.walkietalkey.com";
/** SITE-05: the contact is an e-mail address on the domain, no contact form. Vulnerabilities still go through
    GitHub's private reporting (SECURITY_REPORT_URL), and open questions may also go to Discussions. */
export const CONTACT_EMAIL = "kontakt@walkietalkey.com";
export const CONTACT_URL = `mailto:${CONTACT_EMAIL}`;

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
    description:
      "Hold fn nede, eller tal ind i telefonen. Talen bliver til tekst på din egen computer. Gratis og open source, ingen konto.",
  },
  hent: {
    path: "/hent",
    nav: "Hent",
    title: "Hent WalkieTalkey til Mac og Windows",
    description:
      "Hent WalkieTalkey gratis til Mac eller Windows. Appen henter den danske talemodel første gang og kører på din egen computer.",
  },
  how: {
    path: "/saadan-virker-det",
    nav: "Sådan virker det",
    title: "Sådan virker WalkieTalkey",
    description:
      "Fra tasten eller telefonen til tekst på din computer: talemodellen, krypteringen fra telefon til computer, og hvorfor der ikke er nogen konto.",
  },
  privacy: {
    path: "/privatliv",
    nav: "Privatliv",
    title: "Privatliv · WalkieTalkey",
    description:
      "Hvilke data der findes hvor, hvor længe, og hvem der kan læse dem. Ingen konto og ingen sporing.",
  },
  oss: {
    path: "/open-source",
    nav: "Open source",
    title: "Open source · WalkieTalkey",
    description:
      "WalkieTalkey er open source under Apache-2.0. Her er licensen, koden og licenserne for kode og modeller fra andre.",
  },
  business: {
    path: "/virksomheder",
    nav: "Virksomheder",
    title: "WalkieTalkey til virksomheder",
    description:
      "Gratis for alle, også virksomheder. Færdige indstillinger til udrulning, jeres eget relæ og betalt hjælp til opsætning.",
  },
  security: {
    path: "/sikkerhed",
    nav: "Sikkerhed",
    title: "Sikkerhed · WalkieTalkey",
    description:
      "Sådan er WalkieTalkey bygget, hvad krypteringen beskytter mod, og hvordan du melder en sårbarhed.",
  },
  trademark: {
    path: "/varemaerke",
    nav: "Varemærke",
    title: "Varemærke · WalkieTalkey",
    description:
      "Navnet WalkieTalkey og logoet er ikke omfattet af kodelicensen. Sådan må du bruge dem.",
  },
  faq: {
    path: "/spoergsmaal",
    nav: "Spørgsmål",
    title: "Spørgsmål og svar · WalkieTalkey",
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
