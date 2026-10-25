/* Concept C (hands-on), the hero toy (Hero.astro). Hold to dictate: the pill floats up listening ("Lytter", with its
   glow and the time), nothing is written yet; at release it says "Renskriver", the next sample lands in the note all
   at once (words land at release, DESK-46, DESK-52), the pill says "Indsat" and hides 1.5 s later (DESK-55).
   The keys: fn if the browser ever reports it (key "Fn" or "Globe", code "Fn"), otherwise the space bar, but only
   while the toy is in view and focus is not in a control, so Space still scrolls and still presses buttons elsewhere.
   The pill is one element that morphs between the states rendered in <template data-pill-states>, so its width
   eases from state to state as the app's does. */
import { fill, holdable, reduced, replay, say } from "./hold";

/** "Renskriver", then the text lands */
const WORK_MS = 650;
/** the pill hides this long after the text lands (DESK-55) */
const HIDE_MS = 1500;

type PillState = "listening" | "processing" | "pasted";

const isFn = (e: KeyboardEvent) =>
  e.key === "Fn" || e.key === "Globe" || e.code === "Fn";
const isSpace = (e: KeyboardEvent) => e.code === "Space" || e.key === " ";
const CONTROLS =
  "input, textarea, select, button, a, summary, label, [contenteditable], [role], [tabindex]";

export function toy(root: HTMLElement) {
  const hero = root.closest<HTMLElement>("section") ?? root;
  const button = root.querySelector<HTMLButtonElement>("[data-hold]");
  const dock = root.querySelector<HTMLElement>("[data-dock]");
  const pill = dock?.querySelector<HTMLElement>(".wt-pill");
  const doc = root.querySelector<HTMLElement>("[data-doc]");
  const tpl = root.querySelector<HTMLTemplateElement>(
    "template[data-pill-states]",
  );
  if (!button || !dock || !pill || !doc || !tpl) return;
  const live = root.querySelector<HTMLElement>("[data-live]");
  const msg = root.querySelector<HTMLElement>("[data-msg]");
  const slogan = hero.querySelector<HTMLElement>("[data-slogan]");
  const samples: string[] = JSON.parse(root.dataset.samples || "[]");
  const T: Record<string, string> = JSON.parse(root.dataset.text || "{}");
  const touch = matchMedia("(hover: none) and (pointer: coarse)");

  const states: Partial<Record<PillState, HTMLElement>> = {};
  tpl.content.querySelectorAll<HTMLElement>(".wt-pill").forEach((p) => {
    const s = (["listening", "processing", "pasted"] as const).find((k) =>
      p.classList.contains("wt-pill--" + k),
    );
    if (s) states[s] = p;
  });

  let next = 0;
  let timer = 0;
  let tick = 0;
  let t0 = 0;
  /** the text of the last hold is still on its way; a hold now is ignored */
  let busy = false;
  /** this hold counts (it did not start while busy) */
  let real = false;

  /* ------------------------------------------------------------------ the pill */
  const clip = () => pill.querySelector<HTMLElement>(".wt-pill-clip");
  function setPill(s: PillState) {
    const src = states[s];
    const c = clip();
    const inner = src?.querySelector(".wt-pill-inner")?.cloneNode(true) as
      HTMLElement | undefined;
    if (!src || !c || !inner) return;
    pill!.style.width = pill!.offsetWidth + "px";
    pill!.className = src.className + " ho-pill";
    c.replaceChildren(inner);
    pill!.style.width = Math.ceil(inner.offsetWidth) + "px";
  }
  const show = (on: boolean) => dock.toggleAttribute("data-show", on);
  function hideLater() {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      show(false);
      step(null);
    }, HIDE_MS);
  }

  /* the slogan follows the toy: Tal while you hold, Slip at release, Indsæt when the text lands */
  function step(s: "hold" | "work" | "done" | null) {
    if (!slogan) return;
    if (s) slogan.dataset.at = s;
    else delete slogan.dataset.at;
  }

  let clearMsg = 0;
  /** a note in place of the hint; a note after a tap or a cancel goes again after a while */
  function hint(text: string, stay = true) {
    if (!msg) return;
    clearTimeout(clearMsg);
    msg.textContent = text;
    root.toggleAttribute("data-has-msg", !!text);
    if (text && !stay) clearMsg = window.setTimeout(() => hint(""), 3500);
  }

  function seconds() {
    const s = Math.floor((performance.now() - t0) / 1000);
    const el = pill!.querySelector(".wt-pill-time");
    if (el)
      el.textContent =
        Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  /* ------------------------------------------------------------------ the text */
  function land(text: string) {
    const caret = doc!.querySelector(".ho-caret");
    doc!.querySelector("[data-placeholder]")?.remove();
    root!.removeAttribute("data-empty");
    const line = document.createElement("p");
    line.className = "ho-line";
    const span = document.createElement("span");
    span.className = "ho-paste";
    span.textContent = text;
    line.append(span);
    if (caret) line.append(caret);
    doc!.append(line);
    /* the note keeps what fits: the oldest lines go */
    while (
      doc!.scrollHeight > doc!.clientHeight + 1 &&
      doc!.children.length > 1
    )
      doc!.firstElementChild?.remove();
    if (!reduced()) replay(span, "ho-landed");
  }

  /* ------------------------------------------------------------------ the hold */
  const hold = holdable(button, {
    start() {
      real = !busy;
      if (!real) return;
      clearTimeout(timer);
      t0 = performance.now();
      setPill("listening");
      show(true);
      step("hold");
      root.dataset.state = "hold";
      hint(touch.matches ? T.holdingTouch : T.holding);
      say(live, T.listening);
      clearInterval(tick);
      tick = window.setInterval(seconds, 250);
    },
    tap() {
      if (!real) return;
      stop();
      show(false);
      step(null);
      hint(T.short, false);
      say(live, T.short);
    },
    cancel() {
      if (!real) return;
      stop();
      show(false);
      step(null);
      hint(T.cancelled, false);
      say(live, T.cancelled);
    },
    done() {
      if (!real) return;
      stop();
      busy = true;
      root.dataset.state = "work";
      setPill("processing");
      step("work");
      hint("");
      say(live, T.processing);
      timer = window.setTimeout(() => {
        const text = samples[next++ % samples.length];
        land(text);
        setPill("pasted");
        step("done");
        busy = false;
        root.dataset.state = "done";
        say(live, fill(T.pasted, { text }));
        hideLater();
      }, WORK_MS);
    },
  });
  function stop() {
    clearInterval(tick);
    delete root.dataset.state;
  }

  /* ------------------------------------------------------------------ the keys */
  function sawFn() {
    if (root.hasAttribute("data-fn")) return;
    root.setAttribute("data-fn", "");
    root
      .querySelectorAll("[data-keyname]")
      .forEach((k) => (k.textContent = T.fn));
  }
  /** Space belongs to the toy only while at least a third of it is on screen */
  function inView() {
    const r = root!.getBoundingClientRect();
    return (
      Math.min(r.bottom, innerHeight) - Math.max(r.top, 0) >=
      Math.min(r.height, innerHeight) / 3
    );
  }
  function spaceOk(t: EventTarget | null) {
    if (!inView()) return false;
    return (
      !(t instanceof Element) || t === document.body || !t.closest(CONTROLS)
    );
  }
  window.addEventListener("keydown", (e) => {
    if (isFn(e)) {
      sawFn();
      if (!e.repeat) hold.down("key");
      return;
    }
    if (isSpace(e) && (hold.active || spaceOk(e.target))) {
      e.preventDefault();
      if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) hold.down("key");
    }
  });
  window.addEventListener("keyup", (e) => {
    if (hold.by !== "key") return;
    if (isFn(e) || isSpace(e)) {
      e.preventDefault();
      hold.up();
    }
  });

  /* the finished example is for the page without JavaScript: here the note starts empty, the pill hidden */
  doc.querySelector("[data-example]")?.remove();
  dock.removeAttribute("data-example");
  show(false);
  root.setAttribute("data-empty", "");
}
