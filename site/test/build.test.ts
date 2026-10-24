/* Checks on the built site (run `bun run build` first). SITE-01 to SITE-08, PRIV-02, 11, 14.8, run 2 Phases 6 and 7.4. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { describe, expect, it } from "vitest";
import {
  ALL_RELEASES_URL,
  CONTACT_EMAIL,
  CONTACT_URL,
  DISCUSSIONS_URL,
  MAC_DOWNLOAD_URL,
  OPERATOR,
  PAGES,
  PHONE_APP_URL,
  RELAY_URL,
  REPO_URL,
  SECURITY_REPORT_URL,
  SITE_URL,
  WINDOWS_DOWNLOAD_URL,
  type PageKey,
} from "../src/lib/site";

const dist = resolve(__dirname, "../dist");
const fileFor = (path: string) =>
  join(dist, path === "/" ? "index.html" : path.slice(1) + ".html");
const html = (key: PageKey) => readFileSync(fileFor(PAGES[key].path), "utf8");
const doc = (key: PageKey) => parse(html(key));
const KEYS = Object.keys(PAGES) as PageKey[];
/** If iOS drops the pairing link, the home-screen app opens the scanner by itself (spec 5.3, PHONE-10). */
const IPHONE_FALLBACK =
  "Ellers åbner appen kameraet, og du scanner koden igen.";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(dist);
const textFiles = files.filter((f) =>
  /\.(html|js|mjs|css|json|txt|xml|svg)$/.test(f),
);

/** visible text: no scripts, styles or aria-hidden decoration */
function visibleText(root: HTMLElement): string {
  const clone = parse(root.toString());
  clone
    .querySelectorAll("script, style, template, [aria-hidden=true]")
    .forEach((n) => n.remove());
  return clone.querySelector("body")!.textContent.replace(/\s+/g, " ");
}
/** visible text of one element */
const textOf = (el: HTMLElement) =>
  visibleText(parse(`<body>${el.toString()}</body>`));

describe("pages (SITE-02)", () => {
  it.each(KEYS)(
    "%s exists with lang da, a title and a description (SITE-07)",
    (key) => {
      expect(existsSync(fileFor(PAGES[key].path)), PAGES[key].path).toBe(true);
      const d = doc(key);
      expect(d.querySelector("html")!.getAttribute("lang")).toBe("da");
      expect(d.querySelector("title")!.textContent).toBe(PAGES[key].title);
      expect(
        d.querySelector('meta[name="description"]')!.getAttribute("content"),
      ).toBe(PAGES[key].description);
      expect(
        d.querySelector('meta[property="og:title"]')!.getAttribute("content"),
      ).toBe(PAGES[key].title);
      expect(
        d.querySelector('meta[property="og:image"]')!.getAttribute("content"),
      ).toMatch(new RegExp(`^${SITE_URL.replace(/\./g, "\\.")}/.+\\.jpg$`));
      const canonical = key === "home" ? SITE_URL : SITE_URL + PAGES[key].path;
      expect(
        d.querySelector('link[rel="canonical"]')!.getAttribute("href"),
      ).toBe(canonical);
      expect(
        d.querySelector('meta[property="og:url"]')!.getAttribute("content"),
      ).toBe(canonical);
      expect(d.querySelector('link[rel="icon"]')!.getAttribute("href")).toMatch(
        /\.svg$/,
      );
      expect(d.querySelector('meta[name="viewport"]')).not.toBeNull();
      expect(d.querySelectorAll("h1")).toHaveLength(1);
    },
  );

  it.each(KEYS)("%s links to every page", (key) => {
    const hrefs = new Set(
      doc(key)
        .querySelectorAll("a[href]")
        .map((a) => a.getAttribute("href")),
    );
    for (const k of KEYS)
      expect(
        hrefs.has(PAGES[k].path),
        `${PAGES[key].path} -> ${PAGES[k].path}`,
      ).toBe(true);
  });

  it("has a 404 page", () => {
    expect(existsSync(join(dist, "404.html"))).toBe(true);
  });
});

describe("no third parties (SITE-04)", () => {
  const isLocal = (u: string) =>
    (u.startsWith("/") && !u.startsWith("//")) ||
    u.startsWith("./") ||
    u.startsWith("data:") ||
    u.startsWith("#") ||
    u.startsWith("%23") ||
    /^[\w-]+\.(js|css|svg|png|jpg|woff2)/.test(u);

  it.each(KEYS)(
    "%s loads scripts, styles, fonts and images only from its own origin",
    (key) => {
      const d = doc(key);
      const refs = [
        ...d.querySelectorAll("script[src]").map((e) => e.getAttribute("src")!),
        ...d
          .querySelectorAll("link[href]")
          .filter((e) => e.getAttribute("rel") !== "canonical")
          .map((e) => e.getAttribute("href")!),
        ...d
          .querySelectorAll(
            "img[src], source[src], video[src], audio[src], iframe[src], embed[src], track[src]",
          )
          .map((e) => e.getAttribute("src")!),
        ...d.querySelectorAll("img[srcset], source[srcset]").flatMap((e) =>
          e
            .getAttribute("srcset")!
            .split(",")
            .map((s) => s.trim().split(" ")[0]),
        ),
        ...d
          .querySelectorAll("use[href], image[href]")
          .map((e) => e.getAttribute("href")!),
        ...[...html(key).matchAll(/url\(\s*['"]?([^'")]+)/g)].map((m) => m[1]),
      ];
      expect(refs.length).toBeGreaterThan(0);
      for (const r of refs) expect(isLocal(r), r).toBe(true);
    },
  );

  it("CSS files load nothing from other origins", () => {
    for (const f of files.filter((x) => x.endsWith(".css"))) {
      const css = readFileSync(f, "utf8");
      for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)/g))
        expect(isLocal(m[1]), `${f}: ${m[1]}`).toBe(true);
      expect(css).not.toMatch(/@import\s+(url\()?['"]?https?:/);
    }
  });

  it("nothing writes cookies or loads analytics", () => {
    const markers =
      /document\.cookie|google-analytics|googletagmanager|gtag\(|plausible|umami|matomo|segment\.(com|io)|hotjar|cloudflareinsights|posthog|mixpanel|usefathom|clarity\.ms|sentry/i;
    for (const f of textFiles)
      expect(readFileSync(f, "utf8"), f).not.toMatch(markers);
  });

  it("sets a strict content security policy for Cloudflare Pages", () => {
    const headers = readFileSync(join(dist, "_headers"), "utf8");
    expect(headers).toMatch(/Content-Security-Policy: default-src 'self'/);
    expect(headers).toMatch(/font-src 'self'/);
    expect(headers).toMatch(/connect-src 'self'/);
  });
});

describe("updates (SITE-08, DESK-112)", () => {
  it("serves a valid placeholder Tauri updater manifest at /updates/beta.json", () => {
    const m = JSON.parse(readFileSync(join(dist, "updates/beta.json"), "utf8"));
    expect(m.version).toBe("0.0.0");
    expect(m.platforms).toEqual({});
    expect(typeof m.notes).toBe("string");
    expect(Number.isNaN(Date.parse(m.pub_date))).toBe(false);
  });
});

describe("licence and trademark files (spec 11, 14.8)", () => {
  const fonts = files.filter((f) => /\/albert-sans[^/]*\.woff2$/.test(f));
  const ofl = readFileSync(
    resolve(__dirname, "../../packages/ui/assets/fonts/OFL.txt"),
    "utf8",
  );
  it("ships the SIL Open Font License next to every copy of Albert Sans", () => {
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts)
      expect(readFileSync(join(dirname(font), "OFL.txt"), "utf8"), font).toBe(
        ofl,
      );
  });
  it("carries the trademark note next to the logo copy in public/, and never deploys it", () => {
    expect(
      readFileSync(resolve(__dirname, "../public/README.md"), "utf8"),
    ).toContain("Ikke omfattet af kodelicensen. Se TRADEMARKS.md.");
    expect(files.filter((f) => basename(f) === "README.md")).toEqual([]);
  });
});

/* Run 2, Phase 6: walkietalkey.com, app. and relay. answer with HTTPS and wss, and kontakt@ forwards to the operator
   (Cloudflare Email Routing). The site sends visitors to the domain, never to the test deployments on pages.dev and
   workers.dev, which only keep working for old pairings. Canonical and Open Graph URLs come from SITE_URL. */
describe("on walkietalkey.com (SITE-03, SITE-05, PRIV-02)", () => {
  const all: [string, HTMLElement][] = [
    ...KEYS.map((k): [string, HTMLElement] => [PAGES[k].path, doc(k)]),
    ["/404", parse(readFileSync(join(dist, "404.html"), "utf8"))],
  ];
  it("takes the site's own address from SITE_URL, also in the Astro config", () => {
    expect(SITE_URL).toBe("https://walkietalkey.com");
    const config = readFileSync(
      resolve(__dirname, "../astro.config.mjs"),
      "utf8",
    );
    expect(config).toMatch(/site: SITE_URL/);
    expect(config).not.toMatch(/walkietalkey\.com/);
  });
  it("points the phone app, the relay and the contact at the domain", () => {
    expect(PHONE_APP_URL).toBe("https://app.walkietalkey.com");
    expect(RELAY_URL).toBe("wss://relay.walkietalkey.com");
    expect(CONTACT_EMAIL).toBe("kontakt@walkietalkey.com");
    expect(CONTACT_URL).toBe("mailto:kontakt@walkietalkey.com");
  });
  it.each(all)(
    "%s sends nobody to a test deployment, and links on the domain only to the phone app and kontakt@",
    (_path, d) => {
      for (const a of d.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href")!;
        expect(href).not.toMatch(/pages\.dev|workers\.dev/);
        if (/walkietalkey\.com/.test(href))
          expect([PHONE_APP_URL, CONTACT_URL]).toContain(href);
        if (href.startsWith("mailto:")) expect(href).toBe(CONTACT_URL);
      }
      expect(visibleText(d)).not.toMatch(/pages\.dev|workers\.dev/);
    },
  );
  it.each(all)(
    "%s has a Kontakt link in the footer to kontakt@walkietalkey.com",
    (_path, d) => {
      const kontakt = d
        .querySelectorAll("footer a")
        .find((a) => a.textContent === "Kontakt")!;
      expect(kontakt.getAttribute("href")).toBe(CONTACT_URL);
    },
  );
  it.each(["privacy", "business", "trademark", "faq"] as const)(
    "%s names kontakt@walkietalkey.com as the contact and links it",
    (key) => {
      const d = doc(key);
      const links = d
        .querySelectorAll(`main a[href="${CONTACT_URL}"]`)
        .map((a) => a.textContent);
      expect(links).toContain(CONTACT_EMAIL);
      expect(visibleText(d)).not.toMatch(/GitHubs private formular/);
    },
  );
  it("keeps GitHub's private form for vulnerabilities only (Sikkerhed), never as the contact", () => {
    for (const k of KEYS.filter((k) => k !== "security"))
      expect(
        doc(k).querySelector(`a[href="${SECURITY_REPORT_URL}"]`),
        k,
      ).toBeNull();
    expect(
      doc("security").querySelector(`a[href="${SECURITY_REPORT_URL}"]`),
    ).not.toBeNull();
  });
  it("keeps GitHub Discussions as a place for open questions", () => {
    expect(DISCUSSIONS_URL).toBe(REPO_URL + "/discussions");
    for (const k of ["faq", "oss"] as const)
      expect(
        doc(k).querySelector(`main a[href="${DISCUSSIONS_URL}"]`),
        k,
      ).not.toBeNull();
  });
  it("links the phone app on Hent and lists the domain's defaults for companies", () => {
    const link = doc("hent").querySelector(`main a[href="${PHONE_APP_URL}"]`)!;
    expect(link.textContent).toBe("app.walkietalkey.com");
    const business = visibleText(doc("business"));
    expect(business).toContain(PHONE_APP_URL);
    expect(business).toContain(RELAY_URL);
  });
  /* SITE-05: no contact form, so there is no form data to store. */
  it.each(all)("%s has no form", (_path, d) => {
    expect(d.querySelectorAll("form")).toHaveLength(0);
  });
});

describe("copy rules (spec 2.6, design system)", () => {
  it.each(KEYS)(
    "%s has no em dash, exclamation mark, 'direkte' or 'gratis for private'",
    (key) => {
      const text = visibleText(doc(key));
      expect(text).not.toMatch(/[—!]/);
      expect(text).not.toMatch(/direkte/i);
      expect(text).not.toMatch(/gratis for private/i);
    },
  );
});

describe("Forside is ForsideKomplet", () => {
  const d = doc("home");
  it("has the hero with RelayDemo", () => {
    expect(d.querySelector("header.wt-liquid h1")!.textContent).toBe(
      "Tal. Slip. Indsæt.",
    );
    expect(d.querySelector(".wt-flip")).not.toBeNull();
    expect(d.querySelector('.demo .wt-relay[role="img"]')).not.toBeNull();
    expect(d.querySelector(".hero .fine")!.textContent).toBe(
      "Apache-2.0 · Ingen konto · Dansk talemodel",
    );
  });
  it("has the three promises that hold", () => {
    expect(d.querySelectorAll(".trust li").map((l) => l.textContent)).toEqual([
      "Talen bliver til tekst på din egen computer",
      "Krypteret fra telefon til computer",
      "Ingen konto, ingen sporing",
    ]);
  });
  it("has the feature grid of ShowcaseCards", () => {
    expect(
      d.querySelectorAll(".bento .wt-show-title").map((t) => t.textContent),
    ).toEqual([
      "Hold fn, tal, slip",
      "Eller tal ind i telefonen",
      "Den retter dig, når du retter dig selv",
      "Dansk og engelsk i samme sætning",
      "Lander som en notifikation",
      "Til den computer, du sidder ved",
      "Dine ord, stavet rigtigt",
    ]);
  });
  it("has the three steps with the model download, the pairing code and the pill", () => {
    expect(d.querySelectorAll(".step h3").map((t) => t.textContent)).toEqual([
      "Hent appen",
      "Par telefonen",
      "Hold og tal",
    ]);
    expect(d.querySelector('.steps [role="progressbar"]')).not.toBeNull();
    expect(d.querySelector('.steps .qr[role="img"]')).not.toBeNull();
    expect(d.querySelector(".steps .wt-pill")).not.toBeNull();
  });
  it("has privacy on LightWaves in a dark section, open source, business, questions and the footer intro", () => {
    expect(
      d.querySelector('section.privacy[data-theme="dark"] .wt-waves'),
    ).not.toBeNull();
    expect(d.querySelector(".privacy .wt-show .wt-sc-local")).not.toBeNull();
    expect(d.querySelector(".oss .badge")!.textContent).toBe("Apache-2.0");
    expect(d.querySelector(".biz.wt-gbg h2")!.textContent).toBe(
      "Gratis for alle, også for jer",
    );
    expect(d.querySelectorAll(".faq details")).toHaveLength(4);
    expect(d.querySelector("footer .wt-intro")).not.toBeNull();
  });
  it("loads the design system CSS before the page's own rules (the page must win, as in the preview)", () => {
    const css = d
      .querySelectorAll('link[rel="stylesheet"]')
      .map((l) => readFileSync(join(dist, l.getAttribute("href")!), "utf8"))
      .join("\n");
    expect(css.indexOf(".wt-appicon{")).toBeGreaterThanOrEqual(0);
    expect(css.indexOf(".wt-appicon{")).toBeLessThan(css.indexOf(".qr-mark{"));
  });
  it("uses only one WebGL surface (LightWaves)", () => {
    expect(d.querySelectorAll(".wt-gl")).toHaveLength(1);
  });
  it("links its calls to action", () => {
    const links = d
      .querySelectorAll("a.wt-shiny")
      .map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toContainEqual(["Hent gratis", "/hent"]);
    expect(links).toContainEqual(["Se koden på GitHub", REPO_URL]);
    expect(links).toContainEqual(["Skriv til os", CONTACT_URL]);
  });
  /* Review finding 6: other computers never get the text (spec 12.1, PHONE-40/41), as Privatliv and Sådan virker det say. */
  it("says that only the computer you use gets the text", () => {
    const card = d
      .querySelectorAll(".bento .wt-show")
      .find(
        (c) =>
          c.querySelector(".wt-show-title")?.textContent ===
          "Til den computer, du sidder ved",
      )!;
    const text = card.querySelector(".wt-show-text")!.textContent;
    expect(text).toContain("Den computer, du bruger, får teksten.");
    expect(text).toContain("De andre får den ikke.");
    expect(visibleText(d)).not.toMatch(/historikken/);
    expect(visibleText(doc("privacy"))).toContain(
      "Den sendes aldrig til telefonen eller til andre computere.",
    );
    expect(visibleText(doc("how"))).toContain(
      "Teksten lander kun på den, du sender til.",
    );
  });
  /* Review finding 17: self-corrections need the optional AI cleanup, which is off by default (spec 6.10, PRIV-04). */
  it("ties every self-correction claim to the optional AI cleanup", () => {
    const claims = /omformuleringer|onsdag, nej, torsdag|nej, jeg mente/i;
    const blocks = d
      .querySelectorAll("main p")
      .filter((p) => claims.test(p.textContent));
    expect(blocks.length).toBe(3);
    for (const p of blocks)
      expect(p.textContent, p.textContent).toMatch(
        /slår du AI-oprydning til|med AI-oprydning, hvis du slår den til/i,
      );
  });
});

/* Run 2, Phase 7.4: a non-technical visitor clicks Hent and gets an app that just works. The release v0.1.0 is a normal
   GitHub release with stable asset names, so releases/latest/download/<name> always fetches the newest build. */
describe("Hent (SITE-02)", () => {
  const d = doc("hent");
  const hero = () => d.querySelector("header .get")!;
  it("downloads the latest release's files by their stable names", () => {
    expect(MAC_DOWNLOAD_URL).toBe(
      REPO_URL + "/releases/latest/download/WalkieTalkey-mac.dmg",
    );
    expect(WINDOWS_DOWNLOAD_URL).toBe(
      REPO_URL + "/releases/latest/download/WalkieTalkey-windows.exe",
    );
    expect(ALL_RELEASES_URL).toBe(REPO_URL + "/releases");
  });
  it("has a large download button for each computer at the top, both in the HTML without JavaScript", () => {
    const big = (p: string) =>
      hero().querySelector(`[data-platform="${p}"] a.wt-shiny--lg`)!;
    expect(big("mac").getAttribute("href")).toBe(MAC_DOWNLOAD_URL);
    expect(textOf(big("mac")).trim()).toBe("Hent til Mac");
    expect(big("win").getAttribute("href")).toBe(WINDOWS_DOWNLOAD_URL);
    expect(textOf(big("win")).trim()).toBe("Hent til Windows");
    for (const el of d.querySelectorAll("[data-platform], [data-for]"))
      expect(el.hasAttribute("hidden")).toBe(false);
  });
  it("offers the other computer as a small link", () => {
    const alt = (p: string) =>
      hero().querySelector(`.get-alt[data-for="${p}"] a`)!;
    expect(alt("mac").getAttribute("href")).toBe(WINDOWS_DOWNLOAD_URL);
    expect(alt("mac").textContent).toBe("Hent til Windows");
    expect(alt("win").getAttribute("href")).toBe(MAC_DOWNLOAD_URL);
    expect(alt("win").textContent).toBe("Hent til Mac");
  });
  it("detects the computer before the first paint, so nothing moves", () => {
    const script = d
      .querySelectorAll("script")
      .find((s) => /data-os/.test(s.textContent))!;
    expect(script.getAttribute("src")).toBeUndefined();
    expect(script.getAttribute("type")).toBeUndefined();
    expect(html("hent").indexOf(script.textContent)).toBeLessThan(
      html("hent").indexOf('class="get'),
    );
  });
  it("sends phone visitors to the phone app first and tells them to install the computer app", () => {
    const phone = hero().querySelector('[data-platform="phone"]')!;
    const button = phone.querySelector("a.wt-shiny--lg")!;
    expect(button.getAttribute("href")).toBe(PHONE_APP_URL);
    expect(textOf(phone)).toContain("din Mac eller pc");
  });
  it("shows the phone app link and a QR code drawn at build time as inline SVG", () => {
    const qr = d.querySelector(".phone-qr svg")!;
    expect(qr.getAttribute("role")).toBe("img");
    expect(qr.getAttribute("aria-label")).toContain("app.walkietalkey.com");
    expect(qr.getAttribute("viewBox")).toMatch(/^0 0 (\d+) \1$/);
    expect(qr.querySelector("path")!.getAttribute("d")!.length).toBeGreaterThan(
      200,
    );
    expect(qr.querySelectorAll("image, use, script")).toHaveLength(0);
    const link = d.querySelector(`.phone-qr a[href="${PHONE_APP_URL}"]`)!;
    expect(link.textContent).toBe("app.walkietalkey.com");
  });
  /* Review finding 20: until the signing secrets exist, the builds are not signed by Apple or Microsoft (OSS-21). */
  it("says on each card that the builds are unsigned, and how to open them the first time", () => {
    const card = (p: string) =>
      d.querySelector(`.platforms [data-platform="${p}"]`)!;
    const mac = textOf(card("mac")),
      win = textOf(card("win"));
    expect(mac).toContain("WalkieTalkey-mac.dmg");
    expect(mac).toContain("Programmer");
    expect(mac).toMatch(/endnu ikke (er )?signeret af Apple/);
    expect(mac).toContain("Systemindstillinger › Anonymitet og sikkerhed");
    expect(mac).toContain("Åbn alligevel");
    expect(win).toContain("WalkieTalkey-windows.exe");
    expect(win).toMatch(/endnu ikke (er )?signeret af Microsoft/);
    expect(win).toContain("Flere oplysninger › Kør alligevel");
    // Review finding (run 2): before SmartScreen, Edge usually blocks a new unsigned download.
    expect(win).toContain("ikke er almindeligt downloadet");
    expect(win).toContain("Behold › Vis mere › Behold alligevel");
    expect(win.indexOf("Behold alligevel")).toBeLessThan(
      win.indexOf("Kør alligevel"),
    );
    expect(card("mac").querySelector("a.wt-shiny")!.getAttribute("href")).toBe(
      MAC_DOWNLOAD_URL,
    );
    expect(card("win").querySelector("a.wt-shiny")!.getAttribute("href")).toBe(
      WINDOWS_DOWNLOAD_URL,
    );
  });
  it("walks through the new onboarding with the model downloading by itself", () => {
    expect(
      d.querySelectorAll(".onboard li h3").map((h) => h.textContent),
    ).toEqual([
      "Velkommen",
      "Mikrofon",
      "Tilgængelighed",
      "Prøv det",
      "Telefon",
      "Klar",
    ]);
    const text = visibleText(d);
    expect(text).toContain("i baggrunden");
    expect(text).not.toMatch(/Inputovervågning|Vælg tasten/);
  });
  it("explains tap or hold", () => {
    const text = textOf(d.querySelector(".tap-hold")!);
    expect(text).toContain("Hold fn nede, tal, og slip.");
    expect(text).toContain("Tryk på fn én gang");
    expect(text).toMatch(/tryk(ke)? igen/i);
    expect(text).toContain("højre Ctrl");
  });
  it("tells how the iPhone pairs: scan the computer's code, add to the home screen", () => {
    const text = textOf(d.querySelector(".phone-get")!);
    expect(text).toContain("Scan koden med telefonens kamera.");
    expect(text).toContain("hjemmeskærmen");
    // Not yet confirmed on a real iPhone that iOS keeps the link (spec 5.3): the honest fallback.
    expect(text).toContain(IPHONE_FALLBACK);
  });
  it("links to all releases", () => {
    expect(d.querySelector(`a[href="${ALL_RELEASES_URL}"]`)).not.toBeNull();
  });
});

/* Run 2 changed the product: Accessibility is the only key permission on the Mac, the key works by tap or hold, and
   the iPhone pairs by scanning the computer's code and adding the app to the home screen. */
describe("no outdated copy (run 2)", () => {
  it.each(KEYS)("%s never asks for Input Monitoring", (key) => {
    expect(visibleText(doc(key))).not.toMatch(
      /Inputovervågning|Input Monitoring|Vælg tasten/,
    );
  });
  it("Sådan virker det explains tap or hold and the new pairing", () => {
    const text = visibleText(doc("how"));
    expect(text).toMatch(/tryk(ke)? igen/i);
    expect(text).toContain("Scan koden med telefonens kamera.");
    expect(text).toContain("hjemmeskærmen");
    expect(text).toContain(IPHONE_FALLBACK);
    expect(text).not.toContain("tryk Par med en computer");
  });
  it("the homepage's third step says tap or hold", () => {
    const step = doc("home")
      .querySelectorAll(".step")
      .find((s) => s.querySelector("h3")!.textContent === "Hold og tal")!;
    expect(step.querySelector("p")!.textContent).toMatch(/tryk(ke)? igen/i);
  });
  /* DESK-32 (run 2): our models are assets of the GitHub release models-v1, not on Hugging Face. */
  it.each(["privacy", "business"] as const)(
    "%s says the models come from GitHub",
    (key) => {
      const text = visibleText(doc(key));
      expect(text).not.toMatch(/Hugging Face|huggingface/);
      expect(text).toContain("models-v1");
    },
  );
});

describe("content of the other pages", () => {
  it("Privatliv states the data table, the operator, Cloudflare as processor and the contact (PRIV-02)", () => {
    const d = doc("privacy");
    const text = visibleText(d);
    expect(d.querySelectorAll("table.data tbody tr")).toHaveLength(10);
    expect(OPERATOR).toBe("Navigent.io ApS (CVR 46285395)");
    expect(text).toContain(OPERATOR);
    expect(text).toContain("Cloudflare");
    expect(text).toContain("databehandler");
    expect(text).toContain("FileVault eller BitLocker");
    expect(d.querySelector(`main a[href="${CONTACT_URL}"]`)).not.toBeNull();
  });
  /* Review finding (run 2): the warm phone microphone (PHONE-30, PHONE-33) and the debugging
     audio that phone dictations now keep too (DESK-92), in plain Danish. */
  it("Privatliv says the phone's microphone stays open, what is kept between dictations and what is sent (PRIV-02)", () => {
    const text = visibleText(doc("privacy"));
    expect(text).toContain(
      "Mens telefonappen er åben og parret, er telefonens mikrofon tændt",
    );
    expect(text).toContain(
      "Mellem dikteringerne ligger højst de seneste 0,3 sekunder lyd i telefonens hukommelse",
    );
    expect(text).toContain(
      "kommer op til 0,3 sekunder fra lige før trykket med i dikteringen",
    );
    expect(text).toContain("Ellers bliver intet sendt eller gemt.");
    expect(text).toContain("lyden fra både tasten og telefonen");
  });
  it("Sikkerhed explains private reporting through GitHub, answered within 7 days", () => {
    const d = doc("security");
    expect(d.querySelector(`a[href="${SECURITY_REPORT_URL}"]`)).not.toBeNull();
    expect(visibleText(d)).toContain("Report a vulnerability");
    expect(visibleText(d)).toContain("7 dage");
    expect(
      d.querySelectorAll("table.threats tbody tr").length,
    ).toBeGreaterThanOrEqual(9);
  });
  /* Review finding 5: no claim of Apple notarisation or Authenticode until signed releases exist (principle 6). */
  it("Sikkerhed claims only the signature the updates really have", () => {
    const text = visibleText(doc("security"));
    expect(text).not.toMatch(
      /notarisering|Authenticode|styresystemets signatur/i,
    );
    expect(text).toContain("Opdateringer er signeret med vores egen nøgle.");
    expect(text).toContain("Signering fra Apple og Microsoft kommer senere.");
  });
  it("Open source names the licence, Handy and every credit", () => {
    const text = visibleText(doc("oss"));
    for (const s of [
      "Apache-2.0",
      "Handy",
      "MIT",
      "transcribe.cpp",
      "Edda",
      "Ekko PnC",
      "ONNX Runtime",
      "Silero VAD",
      "Albert Sans",
      "SIL Open Font License",
    ])
      expect(text).toContain(s);
    expect(doc("oss").querySelector(`a[href="${REPO_URL}"]`)).not.toBeNull();
  });
  /* Run 3 (DESK-01, OSS-02): WalkieTalkey is its own product. No page calls it a fork or says
     it is built on Handy; Handy is named only as a licence credit in the open-source table. */
  it.each(KEYS)("%s does not present WalkieTalkey as built on Handy", (key) => {
    const d = doc(key);
    const text = visibleText(d);
    expect(text).not.toMatch(
      /bygge[rt]? (oven )?på Handy|baseret på Handy|fork af Handy|Handy-fork/i,
    );
    const meta = d
      .querySelector('meta[name="description"]')!
      .getAttribute("content")!;
    expect(meta).not.toMatch(/Handy/);
    if (key !== "oss") expect(text).not.toMatch(/\bHandy/);
  });
  /* The desktop app's Secure Input warning links here ("Sådan løser du det", run 3). */
  it("Questions explains Secure Input at the anchor the app links to, opened by the link", () => {
    const d = doc("faq");
    const item = d.querySelector("details#secure-input")!;
    expect(item).not.toBeNull();
    expect(textOf(item)).toMatch(/Secure Input/);
    expect(textOf(item)).toMatch(/adgangskode/);
    const scripts = d
      .querySelectorAll("script")
      .map((s) => s.textContent)
      .join("\n");
    expect(scripts).toMatch(/location\.hash/);
  });
  it("Open source names Handy only in the licence table", () => {
    const d = parse(html("oss"));
    const table = d.querySelector("table.credits")!;
    expect(textOf(table)).toContain("Handy");
    table.remove();
    expect(visibleText(d)).not.toMatch(/\bHandy/);
  });
  /* Review finding 19: Ekko v1 Tiny, the fast model, with its layered licence (spec 11, DESK-35). */
  it("Open source credits Ekko v1 Tiny with NVIDIA's notice", () => {
    const d = doc("oss");
    const row = d
      .querySelectorAll("table.credits tbody tr")
      .find((r) => r.querySelector("td")!.textContent === "Ekko v1 Tiny")!;
    expect(row.querySelector("a")!.getAttribute("href")).toBe(
      "https://huggingface.co/RyeAI/ekko-v1-tiny",
    );
    const cells = textOf(row);
    for (const s of [
      "RyeAI",
      "NVIDIA Open Model License",
      "CC BY 4.0",
      "CoRal",
    ])
      expect(cells).toContain(s);
    expect(visibleText(d)).toContain(
      "Licensed by NVIDIA Corporation under the NVIDIA Open Model License",
    );
  });
  it("Virksomheder lists the managed settings, self-hosting and paid help as a service", () => {
    const text = visibleText(doc("business"));
    for (const k of [
      "RelayUrl",
      "PhoneAppUrl",
      "ModelBaseUrl",
      "AllowPhonePairing",
      "CleanupMode",
      "CleanupProvider",
      "AllowCloudCleanup",
      "CleanupBaseUrl",
      "CleanupApiKey",
      "VocabularySource",
      "OutputMode",
      "ShowTextInNotifications",
      "HistoryRetentionDays",
      "AutoUpdate",
      "UpdateChannel",
      "Model",
    ])
      expect(text).toContain(k);
    expect(text).toContain("Styret af din organisation");
    expect(text).toContain("wrangler deploy");
    expect(text).toMatch(/ikke en licens/);
  });
  it("Varemærke carries the trademark note (14.8)", () => {
    expect(visibleText(doc("trademark"))).toContain(
      "Ikke omfattet af kodelicensen. Se TRADEMARKS.md.",
    );
  });
});
