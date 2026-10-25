/**
 * Run 6: the exact Safari steps to put WalkieTalkey on the home screen, for the visitor's iOS version (PHONE-04).
 *
 * iOS 26 made the compact tab bar Safari's default: Share sits behind ••• next to the address field, and the share
 * sheet shows Add to Home Screen only after View More (the down arrow). Older iOS has Share in the toolbar.
 *
 * Since iOS 26, Safari freezes the OS version in its user agent at 18.x and reports its own version, which follows
 * iOS, in `Version/NN` (WebKit bugs 298260 and 298473). Other iOS browsers (Chrome's CriOS, Firefox's FxiOS, Edge's
 * EdgiOS) have no `Version/` token; they report the real OS version, and the visitor is asked to open Safari.
 */
import { T } from "./strings";

export type InstallFlow = "compact" | "classic";
export type InstallIcon = "more" | "share" | "viewMore" | "addToHome" | "add";

export interface InstallStep {
  id: InstallIcon;
  /** the sentence, Danish */
  text: string;
  /** the button as Danish iOS names it */
  da: string;
  /** the button as English iOS names it (the owner's iPhone may run in English) */
  en: string;
}

/** Safari's major version, or null in another browser. */
export function safariMajor(userAgent: string): number | null {
  if (/CriOS|FxiOS|EdgiOS|OPiOS|GSA\//.test(userAgent)) return null;
  const m = /Version\/(\d+)/.exec(userAgent);
  return m ? Number(m[1]) : null;
}

/** The iOS major version a non-Safari browser reports. */
function osMajor(userAgent: string): number | null {
  const m = /OS (\d+)_\d+/.exec(userAgent);
  return m ? Number(m[1]) : null;
}

/** First iOS (and Safari) version with the compact tab bar as default. */
export const COMPACT_FROM = 26;

export function installFlow(userAgent: string): {
  flow: InstallFlow;
  safari: boolean;
} {
  const safari = safariMajor(userAgent);
  const version = safari ?? osMajor(userAgent) ?? COMPACT_FROM;
  return {
    flow: version >= COMPACT_FROM ? "compact" : "classic",
    safari: safari !== null,
  };
}

const BUTTON: Record<InstallIcon, { da: string; en: string }> = {
  more: { da: "•••", en: "•••" },
  share: { da: "Del", en: "Share" },
  viewMore: { da: "Vis mere", en: "View More" },
  addToHome: { da: "Føj til hjemmeskærm", en: "Add to Home Screen" },
  add: { da: "Tilføj", en: "Add" },
};

const step = (id: InstallIcon, text: string): InstallStep => ({
  id,
  text,
  ...BUTTON[id],
});

export const INSTALL_STEPS: Record<InstallFlow, InstallStep[]> = {
  compact: [
    step("more", T.installCompact.more),
    step("share", T.installCompact.share),
    step("viewMore", T.installCompact.viewMore),
    step("addToHome", T.installCompact.addToHome),
    step("add", T.installCompact.add),
  ],
  classic: [
    step("share", T.installClassic.share),
    step("addToHome", T.installClassic.addToHome),
    step("add", T.installClassic.add),
  ],
};
