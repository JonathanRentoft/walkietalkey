/* Concept C (hands-on), the tiles' demos (Bento.astro, Get.astro). Every tile's HTML is its finished state; these
   only make it react: hold the phone's button and the text lands on the computer you sit at, pick that computer,
   flip AI-oprydning, add a name to the word list, pick a program, light up an English word, send another encrypted
   recording, copy the command, flip the two permissions and slide the number of computers. Nothing loops, and with
   reduced motion every change is a plain swap. */
import { fill, holdable, reduced, replay, say } from "./hold";

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) =>
  root.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => [
  ...root.querySelectorAll<T>(sel),
];
const pressed = (el: Element, on: boolean) =>
  el.setAttribute("aria-pressed", String(on));
const checked = (el: Element) => el.getAttribute("aria-checked") === "true";

/* ------------------------------------------------------------- phone and notify */
/** the computer you sit at, shared by the phone (it sends there) and the notify tile (it lands there) */
const at = { name: "", win: false };
const SENT = "ho:sent";
const SIT = "ho:sit";

function phone(tile: HTMLElement) {
  const app = $(tile, ".wt-app");
  const btn = $<HTMLButtonElement>(tile, ".wt-app-btn");
  const face = $(tile, ".wt-app-face");
  const mic = $<HTMLTemplateElement>(tile, "template[data-mic]");
  if (!app || !btn || !face || !mic) return;
  const label = $(app, ".wt-app-label > span:last-child");
  const sub = $(app, ".wt-app-sub > span");
  const time = $(app, ".wt-app-time");
  const bars = $(app, ".wt-bars");
  const dev = $(app, ".wt-app-dev");
  const T: Record<string, string> = JSON.parse(tile.dataset.text || "{}");
  const check = face.innerHTML;
  const micSvg = mic.innerHTML;
  let t0 = 0;
  let tick = 0;
  let wait = 0;

  function set(s: "idle" | "rec" | "send" | "ready", note = "") {
    app!.className = app!.className.replace(/wt-app--\w+/, "wt-app--" + s);
    const v = { computer: at.name, key: at.win ? "Ctrl+V" : "⌘V" };
    if (label) label.textContent = fill(T[s] || "", v);
    if (sub) sub.textContent = note || (s === "ready" ? fill(T.hint, v) : "");
    bars?.classList.toggle("wt-bars--off", s !== "rec");
    face!.innerHTML = s === "ready" ? check : micSvg;
  }
  document.addEventListener(SIT, () => {
    if (dev?.lastChild) dev.lastChild.textContent = at.name;
    if (app.classList.contains("wt-app--ready")) set("ready");
  });

  holdable(btn, {
    start() {
      clearTimeout(wait);
      t0 = performance.now();
      if (time) time.textContent = "0:00";
      clearInterval(tick);
      tick = window.setInterval(() => {
        const s = Math.floor((performance.now() - t0) / 1000);
        if (time)
          time.textContent =
            Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
      }, 250);
      set("rec");
    },
    tap() {
      clearInterval(tick);
      set("idle", T.short);
    },
    cancel() {
      clearInterval(tick);
      set("idle");
    },
    done() {
      clearInterval(tick);
      set("send");
      wait = window.setTimeout(() => {
        set("ready");
        document.dispatchEvent(
          new CustomEvent(SENT, { detail: tile.dataset.sample || "" }),
        );
        wait = window.setTimeout(() => set("idle"), 4500);
      }, 900);
    },
  });
  set("idle");
}

function notify(tile: HTMLElement) {
  const comps = $$(tile, "[data-comp]");
  const names: string[] = JSON.parse(tile.dataset.names || "[]");
  const live = $(tile, "[data-live]");
  let on = 0;
  at.name = names[0] || at.name;

  function land(i: number, text?: string) {
    comps.forEach((c, k) => {
      const n = $(c, ".wt-notice");
      c.toggleAttribute("data-on", k === i);
      const hit = $(c, ".ho-comp-hit");
      if (hit) pressed(hit, k === i);
      if (!n) return;
      if (k !== i) return n.classList.remove("wt-notice--in");
      if (text) {
        const p = $(n, ".wt-notice-preview");
        if (p) p.textContent = text;
      }
      n.classList.remove("wt-notice--in");
      void n.offsetWidth;
      n.classList.add("wt-notice--in");
    });
    say(live, fill(tile.dataset.landed || "", { computer: names[i] || "" }));
  }
  comps.forEach((c, i) =>
    $(c, ".ho-comp-hit")?.addEventListener("click", () => {
      if (i === on) return;
      on = i;
      at.name = names[i] || at.name;
      at.win = c.classList.contains("ho-comp--win");
      land(i);
      document.dispatchEvent(new CustomEvent(SIT));
    }),
  );
  document.addEventListener(SENT, (e) =>
    land(on, (e as CustomEvent<string>).detail),
  );
}

/* ------------------------------------------------------------- writing */
function corrections(tile: HTMLElement) {
  const sw = $(tile, "[data-switch]");
  const cutEl = $(tile, "[data-cut]");
  const live = $(tile, "[data-live]");
  sw?.addEventListener("click", () => {
    const on = !checked(sw);
    sw.setAttribute("aria-checked", String(on));
    tile.toggleAttribute("data-raw", !on);
    cutEl?.setAttribute("aria-hidden", String(on));
    say(live, (on ? live?.dataset.on : live?.dataset.off) || "");
  });
}

function words(tile: HTMLElement) {
  const form = $<HTMLFormElement>(tile, "[data-add]");
  const input = $<HTMLInputElement>(tile, "input");
  const chips = $(tile, "[data-chips]");
  const said = $(tile, "[data-said]");
  const hit = $(tile, "[data-hit]");
  if (!form || !input || !chips || !said || !hit) return;
  const base = tile.dataset.name || "";
  const heard = tile.dataset.said || "";
  const clean = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 28);
  const added: HTMLElement[] = [];

  function show(name: string) {
    const n = name || base;
    hit!.textContent = n;
    said!.textContent = heard.replace(base.toLowerCase(), n.toLowerCase());
  }
  input.addEventListener("input", () => {
    show(clean(input.value));
    replay(hit, "ho-hit--live");
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = clean(input.value);
    if (!name) return;
    const known = $$(chips, ".ho-chip").find(
      (c) => c.textContent?.toLowerCase() === name.toLowerCase(),
    );
    if (!known) {
      const li = document.createElement("li");
      li.className = "ho-chip ho-chip--new";
      li.textContent = name;
      chips.prepend(li);
      added.push(li);
      if (added.length > 2) added.shift()?.remove();
    }
    show(name);
    input.value = "";
  });
}

function apps(tile: HTMLElement) {
  const tabs = $$(tile, "[data-app]");
  const panes = $$(tile, "[data-pane]");
  tabs.forEach((t, i) =>
    t.addEventListener("click", () => {
      tabs.forEach((x, k) => pressed(x, k === i));
      panes.forEach((p, k) => (p.hidden = k !== i));
      if (!reduced()) replay($(panes[i], ".ho-paste"), "ho-landed");
    }),
  );
}

function mixed(tile: HTMLElement) {
  const chips = $$(tile, ".ho-chip[data-w]");
  const marks = $$(tile, "mark[data-w]");
  let cur = "";
  chips.forEach((c) =>
    c.addEventListener("click", () => {
      cur = cur === c.dataset.w ? "" : c.dataset.w || "";
      chips.forEach((x) => pressed(x, x.dataset.w === cur));
      tile.toggleAttribute("data-focus", !!cur);
      marks.forEach((m) => m.toggleAttribute("data-on", m.dataset.w === cur));
    }),
  );
}

/* ------------------------------------------------------------- privacy and code */
function privacy(tile: HTMLElement) {
  const btn = $(tile, "[data-again]");
  const noise = $(tile, "[data-noise]");
  const plain = $(tile, "[data-plain]");
  const texts: string[] = JSON.parse(tile.dataset.samples || "[]");
  if (!btn || !noise || !plain) return;
  let i = 0;
  let iv = 0;
  const hex = () =>
    (noise.textContent || "")
      .split(" ")
      .map(() =>
        Math.floor(Math.random() * 65536)
          .toString(16)
          .padStart(4, "0"),
      )
      .join(" ");
  btn.addEventListener("click", () => {
    clearInterval(iv);
    tile.setAttribute("data-busy", "");
    const finish = () => {
      clearInterval(iv);
      noise.textContent = hex();
      plain.textContent = texts[(i = (i + 1) % texts.length)];
      tile.removeAttribute("data-busy");
      if (!reduced()) replay(plain, "ho-landed");
    };
    if (reduced()) return finish();
    let n = 0;
    iv = window.setInterval(() => {
      noise.textContent = hex();
      if (++n > 9) finish();
    }, 60);
  });
}

function oss(tile: HTMLElement) {
  const btn = $(tile, "[data-copy]");
  const cmd = $(tile, "[data-cmd]");
  const label = $(tile, "[data-copy-label]");
  if (!btn || !cmd || !label) return;
  const idle = label.textContent;
  let t = 0;
  btn.addEventListener("click", async () => {
    const text = (cmd.textContent || "").trim();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* no clipboard here: select the command, so the visitor can copy it */
      const r = document.createRange();
      r.selectNodeContents(cmd);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(r);
    }
    label.textContent = btn.dataset.done || idle;
    clearTimeout(t);
    t = window.setTimeout(() => (label.textContent = idle), 2200);
  });
}

/* ------------------------------------------------------------- start and price */
function start(panel: HTMLElement) {
  const perms = $$(panel, "[data-perm]");
  const final = $(panel, "[data-final]");
  const label = $(panel, "[data-ready-label]");
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
  const range = $<HTMLInputElement>(panel, "[data-range]");
  const count = $(panel, "[data-count]");
  const n = $(panel, "[data-price]");
  const hint = $(panel, "[data-hint]");
  const help = $(panel, "[data-help]");
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
    if (!reduced()) replay(n, "ho-tick");
  });
}

/* ------------------------------------------------------------- rest when out of sight */
function rest(el: HTMLElement) {
  new IntersectionObserver(([en]) =>
    el.toggleAttribute("data-paused", !en.isIntersecting),
  ).observe(el);
}

export function demos(doc: ParentNode = document) {
  const each = (sel: string, f: (el: HTMLElement) => void) =>
    $$(doc, sel).forEach(f);
  each("[data-notify]", notify);
  each("[data-phone]", phone);
  each("[data-corr]", corrections);
  each("[data-words]", words);
  each("[data-apps]", apps);
  each("[data-mixed]", mixed);
  each("[data-privacy]", privacy);
  each("[data-oss]", oss);
  each("[data-start]", start);
  each("[data-free]", price);
  each("[data-ho-live], [data-phone]", rest);
}
