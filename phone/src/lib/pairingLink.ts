/**
 * The pairing link `<phoneAppUrl>/p#<payload>` (spec 5.3, PROTOCOL.md 4). The secret part is the
 * fragment, which browsers never send to a server; the app reads it and removes it from the
 * address bar and history at once (PHONE-15).
 */
import {
  b64uEncode,
  decodePairingFragment,
  decodePairingUrl,
  sha256,
  type PairingPayload,
  type UrlPolicy,
} from "@walkietalkey/protocol";

export type FragmentResult =
  | { kind: "none" }
  | { kind: "pairing"; payload: PairingPayload }
  | { kind: "invalid"; error: string };

export interface HistoryLike {
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
}

/**
 * The app's own URL without fragment and query; the pairing path becomes the app root. That is
 * `/p` (or `/p.html`), and `/p/` on servers that redirect a folder to its trailing slash.
 */
export function cleanAppUrl(href: string): string {
  const u = new URL(href);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/\/p(?:\.html|\/(?:index\.html)?)?$/, "/");
  return u.href.replace(/#$/, "");
}

/** Reads and removes the fragment. Never leaves the secrets in history, even when invalid. */
export function takePairingFragment(
  location: { href: string },
  history: HistoryLike,
  policy: UrlPolicy = {},
): FragmentResult {
  const href = location.href;
  const i = href.indexOf("#");
  if (i < 0) return { kind: "none" };
  const fragment = href.slice(i + 1);
  history.replaceState(null, "", cleanAppUrl(href));
  if (!fragment) return { kind: "none" };
  try {
    return {
      kind: "pairing",
      payload: decodePairingFragment(fragment, policy),
    };
  } catch (e) {
    return {
      kind: "invalid",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Reads the fragment and leaves it where it is. Only for a Safari tab on an iPhone (PHONE-04):
 * the tab never pairs, and keeping the link in its address bar is how it reaches the home-screen
 * app, whose start URL is the page's URL (run 2, Phase 5; see main.tsx). The secrets in it are
 * single-use and expire after 10 minutes.
 */
export function peekPairingFragment(
  location: { href: string },
  policy: UrlPolicy = {},
): FragmentResult {
  const href = location.href;
  const i = href.indexOf("#");
  const fragment = i < 0 ? "" : href.slice(i + 1);
  if (!fragment) return { kind: "none" };
  try {
    return {
      kind: "pairing",
      payload: decodePairingFragment(fragment, policy),
    };
  } catch (e) {
    return {
      kind: "invalid",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Recognises a link the app has already handled: base64url SHA-256 of its single-use admission
 * secret `a` (the relay keeps the same hash). The home-screen app is started with the same URL
 * every time, so its pairing link must only pair once.
 */
export async function pairingLinkId(p: PairingPayload): Promise<string> {
  return b64uEncode(await sha256(p.a));
}

/**
 * PHONE-12: the phone's name, prefilled. Computers are usually named after their owner
 * ("Jonathans MacBook Pro", "Jonathan’s MacBook Air"), so the phone becomes "Jonathans iPhone";
 * otherwise the kind of phone.
 */
export function suggestPhoneName(computerName: string, device: string): string {
  const m = computerName
    .trim()
    .match(/^(\S(?:.*\S)?(?:['’]s|s))\s+(?:MacBook|iMac|Mac)\b/u);
  if (!m || m[1]!.length < 2) return device;
  return `${m[1]} ${device}`;
}

/** The text of a scanned QR code. Throws ProtocolError for anything that is not a pairing link. */
export function parseScanned(
  text: string,
  policy: UrlPolicy = {},
): PairingPayload {
  return decodePairingUrl(text.trim(), policy);
}
