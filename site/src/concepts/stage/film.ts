/* Run 6, concept B: the page's one script, and all it does is help the CSS (stage.css), which plays the film on each
   shot's view timeline by itself.
   - Out of sight, the loops rest: every [data-ps-live] part gets data-paused while it is off screen, so the light,
     the halos and the meters only move where someone can see them.
   - Where the browser has no scroll-driven animations, each shot plays its sequence once by time, from the moment
     its stage is mostly in view (data-on); until then it waits at the start (the class ps-js, set inline before the
     page is parsed, holds it there). Without this script the sequences simply run at load and stand finished.
   With reduced motion nothing plays: the CSS shows every shot finished, and this script only pauses. */

export function start(): void {
  if (typeof IntersectionObserver === "undefined") {
    document.documentElement.classList.remove("ps-js");
    return;
  }

  const rest = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        e.target.toggleAttribute("data-paused", !e.isIntersecting);
    },
    { rootMargin: "20% 0px" },
  );
  document.querySelectorAll("[data-ps-live]").forEach((el) => rest.observe(el));

  const scrollDriven =
    typeof CSS !== "undefined" && CSS.supports("animation-timeline: view()");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (scrollDriven || reduced) return;

  const play = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.closest("[data-ps-shot]")?.setAttribute("data-on", "");
        play.unobserve(e.target);
      }
    },
    { threshold: 0.55 },
  );
  document
    .querySelectorAll("[data-ps-shot] .ps-panel")
    .forEach((el) => play.observe(el));
}
