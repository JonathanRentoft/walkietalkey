/* Checks on the built site (run `bun run build` first). SITE-01 to SITE-08, PRIV-02, 14.8. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse, type HTMLElement } from "node-html-parser";
import { describe, expect, it } from "vitest";
import {
  CONTACT_EMAIL,
  OPERATOR,
  PAGES,
  RELEASES_URL,
  REPO_URL,
  SECURITY_REPORT_URL,
  type PageKey,
} from "../src/lib/site";

const dist = resolve(__dirname, "../dist");
const fileFor = (path: string) =>
  join(dist, path === "/" ? "index.html" : path.slice(1) + ".html");
const html = (key: PageKey) => readFileSync(fileFor(PAGES[key].path), "utf8");
const doc = (key: PageKey) => parse(html(key));
const KEYS = Object.keys(PAGES) as PageKey[];

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
      ).toMatch(/^https:\/\/walkietalkey\.com\/.+\.jpg$/);
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
    expect(links).toContainEqual(["Skriv til os", "mailto:" + CONTACT_EMAIL]);
  });
});

describe("content of the other pages", () => {
  it("Hent links both platforms to the latest release, both always visible", () => {
    const d = doc("hent");
    const mac = d.querySelector('[data-platform="mac"] a[href]')!,
      win = d.querySelector('[data-platform="win"] a[href]')!;
    expect(mac.getAttribute("href")).toBe(RELEASES_URL);
    expect(win.getAttribute("href")).toBe(RELEASES_URL);
    for (const el of d.querySelectorAll("[data-platform]"))
      expect(el.hasAttribute("hidden")).toBe(false);
  });
  it("Privatliv states the data table, the operator, Cloudflare as processor and the contact (PRIV-02)", () => {
    const d = doc("privacy");
    const text = visibleText(d);
    expect(d.querySelectorAll("table.data tbody tr")).toHaveLength(10);
    expect(text).toContain(OPERATOR);
    expect(text).toContain("Cloudflare");
    expect(text).toContain("databehandler");
    expect(text).toContain("FileVault eller BitLocker");
    expect(d.querySelector(`a[href="mailto:${CONTACT_EMAIL}"]`)).not.toBeNull();
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
