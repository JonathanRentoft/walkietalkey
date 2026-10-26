/* Run 8: the final pages' one script (plus the islands).

   One living background at a time. Every living background on the page has a host, [data-fp-bg]: the hero's, each
   demo card's surface, the privacy section's, the price's bars and page 2's last band. Only the one that fills the
   most of the screen runs; every other host gets data-paused (the HTML starts with all of them paused, so nothing
   runs before this has looked). CSS holds a paused host's CSS surfaces (final.css), and the WebGL and BarField
   islands read the attribute (Live.tsx). A host must beat the running one by a little to take over, so two that
   fill about the same space do not flicker between them. With reduced motion the surfaces stand still by themselves.

   And concept C's two small demos, getting started and the price: flip the two permissions, and the third step is
   ready; slide the number of computers, and the price stays 0 kr. Without JavaScript both show their finished state. */

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** "{name}" placeholders */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "");
}

/** The visible area of a box, in px². */
function shown(r: DOMRect, vw: number, vh: number): number {
  const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
  return w * h;
}

/** Picks the host that may run: the most visible, unless the running one is still about as visible. */
export function pickLive(
  areas: number[],
  current: number,
  margin = 1.12,
): number {
  let best = -1;
  for (let i = 0; i < areas.length; i++)
    if (areas[i] > 0 && (best < 0 || areas[i] > areas[best])) best = i;
  if (best < 0) return -1;
  if (current >= 0 && current !== best && areas[current] > 0)
    if (areas[best] < areas[current] * margin) return current;
  return best;
}

export function backgrounds(doc: Document = document): () => void {
  const hosts = [...doc.querySelectorAll<HTMLElement>("[data-fp-bg]")];
  let live = -1;
  let frame = 0;
  function decide() {
    frame = 0;
    const vw = innerWidth;
    const vh = innerHeight;
    const next = pickLive(
      hosts.map((h) => shown(h.getBoundingClientRect(), vw, vh)),
      live,
    );
    if (next === live) return;
    live = next;
    hosts.forEach((h, i) => h.toggleAttribute("data-paused", i !== live));
  }
  const ask = () => {
    if (!frame) frame = requestAnimationFrame(decide);
  };
  addEventListener("scroll", ask, { passive: true });
  addEventListener("resize", ask);
  /* the first look waits for the page to have loaded and painted: every host starts paused, so nothing is lost,
     and measuring now would force the page's first layout early */
  const first = () =>
    "requestIdleCallback" in window
      ? requestIdleCallback(ask, { timeout: 600 })
      : setTimeout(ask, 200);
  if (doc.readyState === "complete") first();
  else addEventListener("load", first, { once: true });
  return () => {
    removeEventListener("scroll", ask);
    removeEventListener("resize", ask);
    cancelAnimationFrame(frame);
  };
}

/* ------------------------------------------------------------- getting started and the price (concept C) */
const checked = (el: Element) => el.getAttribute("aria-checked") === "true";

function replay(el: Element | null, cls: string) {
  if (!el) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

function start(panel: HTMLElement) {
  const perms = [...panel.querySelectorAll<HTMLElement>("[data-perm]")];
  const final = panel.querySelector("[data-final]");
  const label = panel.querySelector("[data-ready-label]");
  const update = () => {
    const ok = perms.every(checked);
    final?.toggleAttribute("data-ready", ok);
    if (label)
      label.textContent =
        (ok ? panel.dataset.readyText : panel.dataset.waitText) || "";
  };
  perms.forEach((p) => {
    p.setAttribute("aria-checked", "false");
    p.addEventListener("click", () => {
      p.setAttribute("aria-checked", String(!checked(p)));
      update();
    });
  });
  update();
}

function price(panel: HTMLElement) {
  const range = panel.querySelector<HTMLInputElement>("[data-range]");
  const count = panel.querySelector("[data-count]");
  const n = panel.querySelector("[data-price]");
  const hint = panel.querySelector<HTMLElement>("[data-hint]");
  const help = panel.querySelector("[data-help]");
  const counts: number[] = JSON.parse(panel.dataset.counts || "[1]");
  if (!range || !count) return;
  const fmt = new Intl.NumberFormat("da-DK");
  range.addEventListener("input", () => {
    const c = counts[Number(range.value)] ?? 1;
    const text =
      c === 1
        ? panel.dataset.one || ""
        : fill(panel.dataset.many || "", { n: fmt.format(c) });
    count.textContent = text;
    range.setAttribute("aria-valuetext", text);
    const many = c >= 25;
    help?.toggleAttribute("data-lit", many);
    if (hint) hint.textContent = many ? hint.dataset.text || "" : "";
    if (!reduced()) replay(n, "fp-tick");
  });
}

export function demos(doc: ParentNode = document) {
  doc.querySelectorAll<HTMLElement>("[data-start]").forEach(start);
  doc.querySelectorAll<HTMLElement>("[data-free]").forEach(price);
}

/** The page's one script: both, the demos first (they only bind their controls). */
export function run() {
  demos();
  backgrounds();
}
