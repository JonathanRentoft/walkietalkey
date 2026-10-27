/* A tiny pathname router on the History API. The studio server answers index.html for every
   path that is not /api/, /app/, /reports/ or /files/, so these reload as they are. */
import {
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  createElement,
  type MouseEvent,
} from "react";

export type Screen =
  | "optag"
  | "data"
  | "traening"
  | "evaluering"
  | "versioner"
  | "journal"
  | "laer"
  | "rapport"
  | "ukendt";

/** The seven screens of the navigation, in order (run 11: Lær det after Journal). */
export const SCREENS = [
  "optag",
  "data",
  "traening",
  "evaluering",
  "versioner",
  "journal",
  "laer",
] as const;
export type NavScreen = (typeof SCREENS)[number];

export interface Route {
  screen: Screen;
  /** /journal/<name>: the page's name. */
  param: string | null;
  query: URLSearchParams;
  path: string;
}

const KNOWN = new Set<string>([...SCREENS, "rapport"]);

export function parseRoute(pathname: string, search = ""): Route {
  const query = new URLSearchParams(search);
  const parts = pathname.split("/").filter(Boolean);
  const path =
    pathname + (search && !search.startsWith("?") ? `?${search}` : search);
  if (parts.length === 0) return { screen: "optag", param: null, query, path };
  const [head, ...rest] = parts;
  if (!KNOWN.has(head)) return { screen: "ukendt", param: null, query, path };
  const screen = head as Screen;
  if (screen === "journal" && rest.length > 0) {
    let name: string;
    try {
      name = decodeURIComponent(rest.join("/"));
    } catch {
      return { screen: "ukendt", param: null, query, path };
    }
    return { screen, param: name, query, path };
  }
  if (rest.length > 0) return { screen: "ukendt", param: null, query, path };
  return { screen, param: null, query, path };
}

export function href(
  screen: NavScreen | "rapport",
  param?: string | null,
): string {
  if (screen === "journal" && param)
    return `/journal/${encodeURIComponent(param)}`;
  return `/${screen}`;
}

/** /rapport?url=/reports/x.html&fra=/evaluering, for a report shown inside Værkstedet. */
export function reportHref(url: string, from: string): string {
  const q = new URLSearchParams({ url, fra: from });
  return `/rapport?${q.toString()}`;
}

/** Only the studio's own report pages are framed. */
export function isReportUrl(url: string | null): url is string {
  return (
    !!url &&
    /^\/reports\/[^/?#]+\.html(\?[^#]*)?$/.test(url) &&
    !url.includes("..")
  );
}

/* ------------------------------------------------------- leave guards */

type Guard = () => string | null;
const guards = new Set<Guard>();

/** While registered, leaving the screen asks first (unsaved text in the journal). */
export function addLeaveGuard(guard: Guard): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

function blocked(): boolean {
  for (const g of guards) {
    const message = g();
    if (message && !window.confirm(message)) return true;
  }
  return false;
}

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

let current =
  typeof window !== "undefined"
    ? window.location.pathname + window.location.search
    : "/";

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    const next = window.location.pathname + window.location.search;
    if (next === current) return;
    if (blocked()) {
      // Undo the browser's step: put the screen we stayed on back in the address bar.
      window.history.pushState(null, "", current);
      return;
    }
    current = next;
    emit();
  });
}

/** Go to a path; returns false when a leave guard kept the page where it is. */
export function navigate(
  to: string,
  opts: { replace?: boolean } = {},
): boolean {
  const now = window.location.pathname + window.location.search;
  if (to === now) return true;
  if (blocked()) return false;
  if (opts.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  current = to;
  emit();
  return true;
}

export function useRoute(): Route {
  const [loc, setLoc] = useState(
    () => window.location.pathname + window.location.search,
  );
  useEffect(() => {
    const update = () =>
      setLoc(window.location.pathname + window.location.search);
    listeners.add(update);
    update();
    return () => {
      listeners.delete(update);
    };
  }, []);
  const i = loc.indexOf("?");
  return parseRoute(i < 0 ? loc : loc.slice(0, i), i < 0 ? "" : loc.slice(i));
}

/** An <a> that navigates without reloading (a modified click still opens a new tab). */
export function Link(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string },
) {
  const { onClick, ...rest } = props;
  return createElement("a", {
    ...rest,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(e);
      if (
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey ||
        (rest.target && rest.target !== "_self")
      )
        return;
      e.preventDefault();
      navigate(props.href);
    },
  });
}
