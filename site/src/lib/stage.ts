/* The front page's one signature animation (run 5): someone holds the button in the phone app and talks, and the words
   appear on the Mac while they talk; when they let go, the text is ready to paste. Everything the visitor sees is
   static HTML from the design system's components (components/home/Stage.astro); the stage's data-step attribute
   picks what shows, and CSS does all the moving (home.css). This file is the timeline and the few lines of
   JavaScript that step through it, so the page ships no React (SITE-06).

   Without JavaScript, and with prefers-reduced-motion, the stage stays on its calm final step: the finished text on
   the Mac and "Klar på MacBook" on the phone. The driver pauses whenever the hero is out of sight or the tab is
   hidden, and so does the hero's liquid gradient (data-paused). */

export type Step = "idle" | "rec" | "send" | "ready" | "reset";

/** [step, how long it shows in ms] */
export const STEPS: readonly (readonly [Step, number])[] = [
  ["idle", 1400],
  ["rec", 5600],
  ["send", 1000],
  ["ready", 3800],
  ["reset", 900],
];
export const LOOP_MS = /* @__PURE__ */ STEPS.reduce((a, [, ms]) => a + ms, 0);
/** The step shown without motion, and in the HTML before any script runs. */
export const FINAL_STEP: Step = "ready";

/** What is said: the design system's RelayDemo sentence, Danish with an English word in it (spec 2.5). */
export const STAGE_WORDS =
  /* @__PURE__ */ "Hej Mette. Jeg er ti minutter forsinket, så bare start uden mig. Jeg tager slides med.".split(
    " ",
  );
/** The first word appears this long after the button goes down, then one word every WORD_MS (home.css uses both). */
export const WORD_START_MS = 450;
export const WORD_MS = 300;

/** The step at a moment of the loop, and how long it has left. */
export function stepAt(ms: number): { step: Step; left: number } {
  let t = ((ms % LOOP_MS) + LOOP_MS) % LOOP_MS;
  for (const [step, len] of STEPS) {
    if (t < len) return { step, left: len - t };
    t -= len;
  }
  return { step: STEPS[0][0], left: STEPS[0][1] };
}

/** The phone app's state on each step (the design system's PhoneApp classes). */
const APP: Record<Step, string> = {
  idle: "idle",
  rec: "rec",
  send: "send",
  ready: "ready",
  reset: "idle",
};

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

/** Plays the stage while `hero` is in sight. */
export function play(stage: HTMLElement, hero: HTMLElement): void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const app = stage.querySelector<HTMLElement>(".wt-app");
  const live = stage.querySelector<HTMLElement>(".wt-mbar-wt");
  const meter = stage.querySelector<HTMLElement>(".wt-app-meter .wt-bars");
  const times = stage.querySelectorAll<HTMLElement>(
    ".wt-pill-time, .wt-app-time",
  );
  let visible = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  const time = (ms: number) =>
    times.forEach((t) => (t.textContent = clock(ms)));

  function show(s: Step) {
    stage.dataset.step = s;
    if (app)
      app.className = app.className.replace(
        /\bwt-app--\w+/,
        "wt-app--" + APP[s],
      );
    live?.classList.toggle("wt-mbar-wt--live", s === "rec");
    meter?.classList.toggle("wt-bars--off", s !== "rec");
    clearInterval(tick);
    if (s === "rec") {
      const from = Date.now();
      time(0);
      tick = setInterval(() => time(Date.now() - from), 250);
    }
  }
  function go(i: number) {
    const [s, ms] = STEPS[i];
    show(s);
    timer = setTimeout(() => go((i + 1) % STEPS.length), ms);
  }
  function sync() {
    const run = visible && !document.hidden && !reduce.matches;
    hero.toggleAttribute("data-paused", !run);
    if (run && timer === undefined) go(0);
    if (!run && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      /* out of sight it waits at the start; with reduced motion it rests on the finished text */
      show(reduce.matches ? FINAL_STEP : "idle");
    }
  }

  if (typeof IntersectionObserver !== "undefined")
    new IntersectionObserver((es) => {
      visible = es[es.length - 1].isIntersecting;
      sync();
    }).observe(hero);
  document.addEventListener("visibilitychange", sync);
  reduce.addEventListener("change", sync);
  sync();
}
