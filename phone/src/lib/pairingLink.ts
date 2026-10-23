/**
 * The pairing link `<phoneAppUrl>/p#<payload>` (spec 5.3, PROTOCOL.md 4). The secret part is the
 * fragment, which browsers never send to a server; the app reads it and removes it from the
 * address bar and history at once (PHONE-15).
 */
import { decodePairingFragment, decodePairingUrl, type PairingPayload, type UrlPolicy } from "@walkietalkey/protocol";

export type FragmentResult =
  | { kind: "none" }
  | { kind: "pairing"; payload: PairingPayload }
  | { kind: "invalid"; error: string };

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/** The app's own URL without fragment and query; `/p` (the pairing path) becomes the app root. */
export function cleanAppUrl(href: string): string {
  const u = new URL(href);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/p(\.html)?$/, "/");
  return u.href.replace(/#$/, "");
}

/** Reads and removes the fragment. Never leaves the secrets in history, even when invalid. */
export function takePairingFragment(location: { href: string }, history: HistoryLike, policy: UrlPolicy = {}): FragmentResult {
  const href = location.href;
  const i = href.indexOf("#");
  if (i < 0) return { kind: "none" };
  const fragment = href.slice(i + 1);
  history.replaceState(null, "", cleanAppUrl(href));
  if (!fragment) return { kind: "none" };
  try {
    return { kind: "pairing", payload: decodePairingFragment(fragment, policy) };
  } catch (e) {
    return { kind: "invalid", error: e instanceof Error ? e.message : String(e) };
  }
}

/** The text of a scanned QR code. Throws ProtocolError for anything that is not a pairing link. */
export function parseScanned(text: string, policy: UrlPolicy = {}): PairingPayload {
  return decodePairingUrl(text.trim(), policy);
}
