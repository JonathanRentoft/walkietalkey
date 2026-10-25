/* Run 6, concept A (editorial): the page's little motion, in a few lines of vanilla JavaScript (no React, SITE-06).
   Few things move, and slowly:
     - the cover's liquid gradient drifts (CSS), and rests when the cover is out of sight (data-paused);
     - Fig. 1, the one computer window, loops through one dictation: fn goes down and the pill says "Lytter" while the
       mail stays empty, then fn comes up and the line lands at once (DESK-46). data-step picks what shows, CSS moves;
     - each small demo in the numbered list plays once, the first time it comes into view (ed-in).
   The HTML holds every finished state: without JavaScript, and with prefers-reduced-motion, the line stands in the
   window and every demo stands finished. Out of sight or in a hidden tab, nothing runs. */

export type PlateStep = "idle" | "held" | "landed" | "clear";

/** [step, how long it shows in ms]: one dictation, about twelve seconds */
export const PLATE_STEPS: readonly (readonly [PlateStep, number])[] = [
  ["idle", 1600],
  ["held", 3600],
  ["landed", 5800],
  ["clear", 900],
];
/** The step in the HTML, and the one shown without motion: the line has landed. */
export const PLATE_FINAL: PlateStep = "landed";

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)");

/** Runs `onChange(true)` while at least `share` of `el` is in sight and the tab is visible, `onChange(false)`
    otherwise. */
function whileInSight(
  el: Element,
  onChange: (run: boolean) => void,
  share = 0,
): void {
  let visible = false;
  const sync = () => onChange(visible && !document.hidden);
  new IntersectionObserver(
    (es) => {
      const e = es[es.length - 1];
      visible = e.isIntersecting && e.intersectionRatio >= share;
      sync();
    },
    { threshold: share ? [0, share] : 0 },
  ).observe(el);
  document.addEventListener("visibilitychange", sync);
}

/** How much of Fig. 1 must be in sight before the dictation starts, so nobody arrives in the middle of it. */
export const PLATE_IN_SIGHT = 0.4;

/** The cover's gradient drifts only while the cover is in sight. */
export function restOutOfSight(
  backdrop: HTMLElement,
  cover: HTMLElement,
): void {
  whileInSight(cover, (run) => backdrop.toggleAttribute("data-paused", !run));
}

/** Plays Fig. 1 while it is in sight; out of sight it waits at the start, with reduced motion on the landed line. */
export function playPlate(plate: HTMLElement): void {
  const motion = reduced();
  const key = plate.querySelector<HTMLElement>("[data-ed-key]");
  const time = plate.querySelector<HTMLElement>(
    ".wt-pill--listening .wt-pill-time",
  );
  let inSight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;

  function show(step: PlateStep) {
    plate.dataset.step = step;
    key?.toggleAttribute("data-down", step === "held");
    clearInterval(tick);
    if (step === "held" && time) {
      const from = Date.now();
      time.textContent = clock(0);
      tick = setInterval(
        () => (time.textContent = clock(Date.now() - from)),
        250,
      );
    }
  }
  function go(i: number) {
    const [step, ms] = PLATE_STEPS[i];
    show(step);
    timer = setTimeout(() => go((i + 1) % PLATE_STEPS.length), ms);
  }
  function sync() {
    const run = inSight && !motion.matches;
    plate.toggleAttribute("data-paused", !run);
    if (run && timer === undefined) go(0);
    if (!run) {
      clearTimeout(timer);
      timer = undefined;
      show(motion.matches ? PLATE_FINAL : "idle");
    }
  }
  whileInSight(
    plate,
    (run) => {
      inSight = run;
      sync();
    },
    PLATE_IN_SIGHT,
  );
  motion.addEventListener("change", sync);
}

/** Each small demo plays once, the first time it comes into view. */
export function revealOnce(demos: Iterable<HTMLElement>): void {
  const io = new IntersectionObserver(
    (es) => {
      for (const e of es)
        if (e.isIntersecting) {
          e.target.classList.add("ed-in");
          io.unobserve(e.target);
        }
    },
    { rootMargin: "0px 0px -12% 0px" },
  );
  for (const d of demos) io.observe(d);
}
