/* Run 8, page 2: the index beside the features marks the one in view (aria-current), so the column says where you
   are while the features pass. Without JavaScript it is a plain list of links. */
export function follow(doc: Document = document): void {
  const links = new Map(
    [...doc.querySelectorAll<HTMLAnchorElement>(".fb-index a")].map((a) => [
      a.hash.slice(1),
      a,
    ]),
  );
  if (!links.size || typeof IntersectionObserver === "undefined") return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        links.forEach((a) => a.removeAttribute("aria-current"));
        links.get(e.target.id)?.setAttribute("aria-current", "true");
      }
    },
    { rootMargin: "-40% 0px -55% 0px" },
  );
  doc
    .querySelectorAll<HTMLElement>(".fb-list [data-showcase]")
    .forEach((el) => io.observe(el));
}
