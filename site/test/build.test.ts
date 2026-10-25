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
import { HERO } from "../src/lib/hero";
import { STAGE_WORDS } from "../src/lib/stage";

/** Run 5: the front page's whole JavaScript, inline and from files with their imports, uncompressed. */
const HOME_JS_BUDGET = 6 * 1024;

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

/** Every script a page runs: inline ones and files, with the files they import, and their size in bytes. */
function pageScripts(key: PageKey): { files: string[]; bytes: number } {
  const seen = new Set<string>();
  let bytes = 0;
  const load = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    bytes += Buffer.byteLength(code);
    for (const m of code.matchAll(
      /(?:import|export)\s*(?:[\w*{}\s,]+from\s*)?["']([^"']+\.js)["']|import\(\s*["']([^"']+\.js)["']\s*\)/g,
    ))
      load(resolve(dirname(file), m[1] ?? m[2]));
  };
  for (const s of doc(key).querySelectorAll("script")) {
    const src = s.getAttribute("src");
    if (src) load(join(dist, src));
    else bytes += Buffer.byteLength(s.textContent);
  }
  return { files: [...seen].map((f) => basename(f)), bytes };
}

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

/* Run 5, the owner's brief: calm premium, one idea per screen, at most five sections, and one signature animation
   (words appearing on the Mac while someone talks into the phone); everything else stands still. */
describe("Forside: five calm sections (run 5)", () => {
  const d = doc("home");
  const section = (name: string) =>
    d.querySelector(`[data-section="${name}"]`)!;
  it("has exactly five sections: hero, how it works, privacy, free, questions", () => {
    expect(
      d
        .querySelectorAll("[data-section]")
        .map((s) => s.getAttribute("data-section")),
    ).toEqual(["hero", "how", "privacy", "free", "faq"]);
    expect(d.querySelectorAll("main > *")).toHaveLength(4);
  });
  it("gives every section one idea: one heading each", () => {
    expect(section("hero").querySelectorAll("h1")).toHaveLength(1);
    for (const s of ["how", "privacy", "free", "faq"])
      expect(section(s).querySelectorAll("h2"), s).toHaveLength(1);
  });
  /* Run 6: without SITE_CONCEPT the build is the current front page, so production stays as it is until the owner
     picks one of the three concepts (lib/build.ts). */
  it("builds the current front page, the fn-led hero, when no concept is chosen", () => {
    expect(d.querySelector("body")!.getAttribute("data-concept")).toBe("current");
    const hero = section("hero");
    expect(hero.getAttribute("data-hero")).toBe("fn");
    expect(hero.querySelector("h1")!.textContent).toBe(HERO.title);
    expect(textOf(hero.querySelector(".hero-lead")!).trim()).toBe(
      HERO.lead.replace("{fn}", "fn"),
    );
  });
  it("shows the italic W mark in the hero, in liquid metal on night", () => {
    const icon = section("hero").querySelector(".hero-mark.wt-appicon")!;
    expect(icon.querySelector("svg.wt-logo")!.toString()).toContain(
      "<linearGradient",
    );
  });
  it("links its calls to action", () => {
    const links = d
      .querySelectorAll("a.wt-shiny")
      .map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toContainEqual(["Hent gratis", "/hent"]);
    expect(links).toContainEqual(["Sådan virker det", PAGES.how.path]);
    expect(links).toContainEqual(["Skriv til os", CONTACT_URL]);
  });
  it("has the signature animation as one described picture, in its calm final state without JavaScript", () => {
    const stage = section("hero").querySelector("[data-stage]")!;
    expect(stage.getAttribute("role")).toBe("img");
    expect(stage.getAttribute("aria-label")).toMatch(/telefon/);
    expect(stage.getAttribute("aria-label")).toMatch(/computer/);
    expect(stage.getAttribute("data-step")).toBe("ready");
    /* every word is in the HTML from the start, so nothing moves when they appear */
    expect(
      stage
        .querySelectorAll("[data-words] .w")
        .map((w) => w.textContent)
        .join(" "),
    ).toBe(STAGE_WORDS.join(" "));
    /* the product says what the product says (design system, spec Appendix A) */
    const said = stage.toString();
    for (const s of [
      "Lytter",
      "Renskriver",
      "Tekst klar til at indsætte",
      "Klar på MacBook",
      "Tryk ⌘V for at indsætte",
      "Krypteret fra telefon til computer",
    ])
      expect(said, s).toContain(s);
    expect(
      stage.querySelector(".wt-phone .wt-app.wt-app--ready"),
    ).not.toBeNull();
    expect(stage.querySelector(".wt-laptop .wt-win")).not.toBeNull();
  });
  it("runs no React on the front page: no islands, no demos, no WebGL, a still footer", () => {
    expect(d.querySelectorAll("astro-island")).toHaveLength(0);
    for (const sel of [
      ".wt-flip",
      ".wt-show",
      ".wt-relay",
      ".wt-waves",
      ".wt-gl",
      "footer .wt-intro",
    ])
      expect(d.querySelectorAll(sel), sel).toHaveLength(0);
    expect(d.querySelector("footer svg.wt-logo")).not.toBeNull();
  });
  it(`keeps the front page's JavaScript under ${HOME_JS_BUDGET / 1024} KB (SITE-06)`, () => {
    const js = pageScripts("home");
    expect(js.files.join(" ")).not.toMatch(/client|react|src\./);
    expect(js.bytes).toBeLessThanOrEqual(HOME_JS_BUDGET);
  });
  it("loads the design system CSS before the page's own rules (the page must win)", () => {
    const css = d
      .querySelectorAll('link[rel="stylesheet"]')
      .map((l) => readFileSync(join(dist, l.getAttribute("href")!), "utf8"))
      .join("\n");
    expect(css.indexOf(".wt-appicon{")).toBeGreaterThanOrEqual(0);
    expect(css.indexOf(".wt-appicon{")).toBeLessThan(css.indexOf(".stage{"));
  });
  it("explains how it works in three steps and links to the page with the detail", () => {
    const how = section("how");
    expect(how.querySelectorAll(".step h3").map((h) => h.textContent)).toEqual([
      "Hent appen",
      "Tal",
      "Slip",
    ]);
    expect(how.querySelector(`a[href="${PAGES.how.path}"]`)).not.toBeNull();
  });
  it("says privacy in three facts that hold: local, encrypted from the phone, open source (spec 2.6)", () => {
    const p = section("privacy");
    expect(p.getAttribute("data-theme")).toBe("dark");
    expect(p.querySelectorAll(".pillar h3").map((h) => h.textContent)).toEqual([
      "Talen bliver til tekst på din egen computer",
      "Krypteret fra telefon til computer",
      "Open source",
    ]);
    expect(textOf(p)).toContain("Relæet imellem kan ikke læse den.");
    expect(textOf(p)).toContain("Ingen konto og ingen sporing.");
    for (const k of ["privacy", "security", "oss"] as const)
      expect(p.querySelector(`a[href="${PAGES[k].path}"]`), k).not.toBeNull();
    expect(p.querySelector(`a[href="${REPO_URL}"]`)).not.toBeNull();
  });
  it("is free for everyone, with paid setup help for companies as a service, not a licence", () => {
    const f = section("free");
    expect(f.querySelector("h2")!.textContent).toBe(
      "Gratis for alle, også for virksomheder",
    );
    expect(f.querySelectorAll(".plan")).toHaveLength(2);
    expect(textOf(f)).toContain("0 kr.");
    expect(textOf(f)).toMatch(/ikke en licens/);
    expect(f.querySelector(`a[href="${CONTACT_URL}"]`)).not.toBeNull();
    expect(f.querySelector(`a[href="${PAGES.business.path}"]`)).not.toBeNull();
  });
  it("has a short FAQ that links to the rest", () => {
    const q = section("faq");
    const n = q.querySelectorAll("details").length;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(6);
    expect(q.querySelector(`a[href="${PAGES.faq.path}"]`)).not.toBeNull();
  });
  /* Run 5: claims nobody has measured yet (whispering, speed) are marked TODO(claim) in the source and never shown
     as facts: the production build leaves them out, draft previews show them with a visible marker. */
  it("shows no unmeasured claim in the production build", () => {
    expect(d.querySelectorAll("[data-claim]")).toHaveLength(0);
    expect(visibleText(d)).not.toMatch(/TODO|hvisk/i);
  });
  /* Review finding 6: other computers never get the text (spec 12.1, PHONE-40/41), as Privatliv and Sådan virker det say. */
  it("never says other computers get the text", () => {
    expect(visibleText(d)).not.toMatch(/historikken|alle dine computere/);
    expect(textOf(section("how"))).toContain("den computer, du sidder ved");
    expect(visibleText(doc("privacy"))).toContain(
      "Den sendes aldrig til telefonen eller til andre computere.",
    );
    expect(visibleText(doc("how"))).toContain(
      "Teksten lander kun på den, du sender til.",
    );
  });
  /* Review finding 17: self-corrections need the optional AI cleanup, which is off by default (spec 6.10, PRIV-04). */
  it("ties any self-correction claim to the optional AI cleanup", () => {
    const claims = /omformuleringer|onsdag, nej, torsdag|nej, jeg mente/i;
    for (const p of d
      .querySelectorAll("main p")
      .filter((p) => claims.test(p.textContent)))
      expect(p.textContent, p.textContent).toMatch(
        /slår du AI-oprydning til|med AI-oprydning, hvis du slår den til/i,
      );
    expect(textOf(section("privacy"))).toContain(
      "AI-oprydning er valgfri og slået fra",
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
    expect(mac).toContain(
      "Systemindstillinger › Anonymitet og sikkerhed › Åbn alligevel",
    );
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
  /* Run 5: macOS 26 blocks the first open of an app without a Developer ID. Three short steps, the way macOS words
     them; the button in System Settings shows only for a while after the first try, and only the first open asks.
     Run 6: every macOS name in both Danish and English, because many Macs (the owner's too) run in English. */
  it("guides the Mac's first open past Gatekeeper in three steps, naming macOS's buttons in Danish and English", () => {
    const card = d.querySelector('.platforms [data-platform="mac"]')!;
    const items = card.querySelectorAll(".gatekeeper > li");
    expect(items).toHaveLength(3);
    const steps = items.map((li) => textOf(li).trim());
    expect(steps[0]).toContain("WalkieTalkey-mac.dmg");
    expect(steps[0]).toContain("Programmer");
    expect(steps[0]).toContain("Applications");
    expect(steps[1]).toMatch(/luk advarslen/i);
    /* opened from the disk image, macOS runs a read-only copy that cannot update itself (run 6) */
    expect(steps[1]).toContain("fra Programmer, ikke fra diskbilledet");
    expect(steps[1]).toContain("Done");
    expect(steps[2]).toContain("Systemindstillinger › Anonymitet og sikkerhed › Åbn alligevel");
    expect(steps[2]).toContain("System Settings › Privacy & Security › Open Anyway");
    expect(steps[2]).toContain("Touch ID");
    /* the English names are marked as English for screen readers */
    const en = card.querySelectorAll('.gatekeeper [lang="en"]').map((e) => e.textContent);
    expect(en).toEqual(expect.arrayContaining(["Applications", "Done", "System Settings › Privacy & Security › Open Anyway"]));
    const note = textOf(card.querySelector(".gatekeeper-note")!);
    expect(note).toContain("Kun første gang.");
    expect(note).toContain("Åbn alligevel");
    expect(note).toContain("Open Anyway");
    expect(note).not.toMatch(/papirkurv|Trash/i);
    /* the hero sends a Mac visitor straight to those steps */
    expect(
      d.querySelector('header [data-platform="mac"] a[href="#foerste-gang"]'),
    ).not.toBeNull();
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
    /* Run 6: Safari's exact steps for each iOS, the buttons in Danish and English (phone/src/lib/install.ts) */
    const ios = d.querySelectorAll(".ios-steps > li").map((li) => textOf(li).trim());
    expect(ios).toHaveLength(2);
    expect(ios[0]).toMatch(/^iOS 26 og nyere/);
    expect(ios[0]).toContain("••• › Del › Vis mere › Føj til hjemmeskærm › Tilføj");
    expect(ios[0]).toContain("••• › Share › View More › Add to Home Screen › Add");
    expect(ios[1]).toMatch(/^Ældre iOS/);
    expect(ios[1]).toContain("Del › Føj til hjemmeskærm › Tilføj");
    expect(ios[1]).toContain("Share › Add to Home Screen › Add");
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
  it("the homepage's step with the key says tap or hold", () => {
    const step = doc("home")
      .querySelectorAll(".step")
      .find((s) => s.querySelector("h3")!.textContent === "Tal")!;
    const text = step.querySelector("p")!.textContent;
    expect(text).toContain("Hold fn nede");
    expect(text).toMatch(/tryk(ke)? igen/i);
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
  /* SEC-11 (v0.2.0): the Mac keeps its keys in WalkieTalkey's own folder, never the keychain; Windows in Credential
     Manager (SEC-10); the phone as a key that cannot be read out (SEC-09). */
  it("Sikkerhed says where each device keeps its keys (SEC-09, SEC-10, SEC-11)", () => {
    const text = visibleText(doc("security"));
    expect(text).not.toMatch(/ligger den i nøgleringen/);
    expect(text).toContain(
      "På Mac ligger den i en privat mappe, som kun WalkieTalkey bruger, aldrig i nøgleringen.",
    );
    expect(text).toContain("Mappen er bundet til netop den Mac.");
    expect(text).toContain(
      "På Windows ligger den i Credential Manager, og på telefonen som en nøgle, der ikke kan læses ud.",
    );
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
