// The design system switches to dark with data-theme="dark" (its CSS and
// components such as GradientBackground read the attribute). Handy's
// "system" theme removes the attribute and leaves the choice to a media
// query, which the components cannot see, so a dark Mac got a light
// onboarding background under a dark card. While the theme is "system",
// this keeps data-theme in step with the OS.
import { useEffect, useState } from "react";
import { getStoredTheme } from "@/lib/utils/theme";

let following = false;

export function followSystemTheme() {
  if (following || typeof window === "undefined" || !window.matchMedia) return;
  following = true;
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const root = document.documentElement;
  const sync = () => {
    if (getStoredTheme() !== "system") return;
    const want = mq.matches ? "dark" : "light";
    if (root.dataset.theme !== want) root.dataset.theme = want;
  };
  sync();
  mq.addEventListener?.("change", sync);
  new MutationObserver(sync).observe(root, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
}

/** The scheme the screens are drawn in. */
export function useColorScheme(): "light" | "dark" {
  const read = () =>
    document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  const [scheme, setScheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setScheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    setScheme(read());
    return () => observer.disconnect();
  }, []);
  return scheme;
}
