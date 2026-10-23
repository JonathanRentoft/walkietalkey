import { expect, preparePage, test } from "./helpers";

test.describe("installable web app (PHONE-01)", () => {
  test("manifest, icons, Universal Links file and headers", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.headers()["content-type"]).toContain("application/manifest+json");
    const m = await res.json();
    expect(m).toMatchObject({ name: "WalkieTalkey", lang: "da", display: "standalone", start_url: "./", scope: "./" });
    for (const icon of m.icons as { src: string; sizes: string }[]) {
      const r = await request.get(`/${icon.src}`);
      expect(r.status()).toBe(200);
      expect(r.headers()["content-type"]).toBe("image/png");
    }
    expect(m.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);

    const aasa = await request.get("/.well-known/apple-app-site-association");
    expect(aasa.headers()["content-type"]).toBe("application/json");
    const links = await aasa.json();
    expect(links.applinks.details[0].appIDs).toEqual(["TEAMID.com.walkietalkey.ios"]);
    expect(links.applinks.details[0].components[0]["/"]).toBe("/p");

    const page = await request.get("/");
    expect(page.headers()["content-security-policy"]).toContain("connect-src 'self' wss:");
    expect(page.headers()["permissions-policy"]).toContain("microphone=(self)");
    // The pairing path serves the same app.
    const p = await request.get("/p");
    expect(await p.text()).toBe(await page.text());
  });

  test("the service worker caches the app shell, never audio, and the app opens offline", async ({ page, browserName, context }) => {
    await preparePage(page, browserName);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Par med en computer" })).toBeVisible();
    const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
    expect(scope).toBe(new URL("/", page.url()).href);
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const urls: string[] = [];
      for (const k of keys) for (const r of await (await caches.open(k)).keys()) urls.push(new URL(r.url).pathname);
      return { keys, urls };
    });
    expect(cached.keys.length).toBe(1);
    expect(cached.keys[0]).toMatch(/^walkietalkey-shell-/);
    expect(cached.urls).toContain("/");
    expect(cached.urls.some((u) => u.endsWith(".js"))).toBe(true);
    expect(cached.urls.some((u) => /audio|\.wav|\.pcm/.test(u))).toBe(false);

    // Playwright's WebKit reports an internal error for a reload while emulating offline.
    if (browserName === "webkit") return;
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Par med en computer" })).toBeVisible();
    await context.setOffline(false);
  });
});
