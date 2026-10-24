/** Entry point. Every URL is relative, so the same build runs from any origin and path, and from
    the iOS shell's bundled files (PHONE-03). */
import "@walkietalkey/ui/styles.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PairingPayload } from "@walkietalkey/protocol";
import { Recorder } from "./audio/recorder";
import { PhoneController } from "./core/controller";
import { ScreenWake, haptic } from "./lib/device";
import {
  cleanAppUrl,
  pairingLinkId,
  parseScanned,
  peekPairingFragment,
  takePairingFragment,
} from "./lib/pairingLink";
import {
  IOS_MANIFEST_FILE,
  detectPlatform,
  isIosSafariTab,
  readEnv,
} from "./lib/platform";
import { PhoneStorage } from "./lib/storage";
import { T } from "./lib/strings";
import { App, SHELL_START_EVENT } from "./ui/App";
import { InstallScreen, Unsupported } from "./ui/screens";

declare global {
  interface Window {
    /** For the iOS shell: hand over a pairing link (a Universal Link) while the app is open. */
    walkieTalkey?: { openPairingUrl(url: string): boolean };
  }
}

/** ws:// to localhost only in debug builds and the e2e build (SEC-06). */
const policy = {
  allowInsecureLocalhost: import.meta.env.DEV || import.meta.env.MODE === "e2e",
};

function applyTheme(): void {
  const mq =
    typeof matchMedia === "function"
      ? matchMedia("(prefers-color-scheme: dark)")
      : null;
  const set = () =>
    document.documentElement.setAttribute(
      "data-theme",
      mq?.matches ? "dark" : "light",
    );
  set();
  mq?.addEventListener?.("change", set);
}

/**
 * Run 2, Phase 5: in a Safari tab on an iPhone, link the manifest without start_url, so "Føj til
 * hjemmeskærm" makes the home-screen app start at this page's URL, pairing link included.
 */
function linkIosManifest(): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (link) link.href = new URL(IOS_MANIFEST_FILE, link.href).href;
}

function registerServiceWorker(): void {
  if (import.meta.env.DEV || !("serviceWorker" in navigator)) return;
  // Never in the iOS shell (walkietalkey://localhost/): only http(s), and plain http only locally.
  if (location.protocol !== "https:" && location.protocol !== "http:") return;
  const local =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (location.protocol === "http:" && !local) return;
  void navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .catch(() => undefined);
}

async function main(): Promise<void> {
  applyTheme();
  const platform = detectPlatform(readEnv());
  // The iOS shell's cold start from "Start diktering" loads the page with ?start=1.
  const startOnLoad = new URLSearchParams(location.search).get("start") === "1";
  if (startOnLoad) {
    const u = new URL(location.href);
    u.searchParams.delete("start");
    history.replaceState(null, "", u.href);
  }
  const root: Root = createRoot(document.getElementById("root")!);

  if (isIosSafariTab(platform)) {
    // PHONE-04 and spec 5.3 step 2: a Safari tab never pairs and never creates keys. Run 2,
    // Phase 5: a valid pairing link stays in the address bar, and the manifest has no start_url,
    // so the home-screen app added from here starts with the link and pairs on its first launch.
    // The secrets in it are single-use and expire after 10 minutes.
    const show = () => {
      const peek = peekPairingFragment(location, policy);
      if (peek.kind === "invalid")
        history.replaceState(null, "", cleanAppUrl(location.href));
      root.render(
        <InstallScreen
          computer={peek.kind === "pairing" ? peek.payload.n : null}
          fromLink={peek.kind !== "none"}
        />,
      );
    };
    linkIosManifest();
    show();
    // Another code scanned while this tab is open only changes the fragment.
    window.addEventListener("hashchange", show);
    registerServiceWorker();
    return;
  }
  // PHONE-15: read the pairing fragment and remove it from the address bar and history at once.
  const first = takePairingFragment(location, history, policy);
  if (
    !window.isSecureContext ||
    !globalThis.crypto?.subtle ||
    typeof indexedDB === "undefined"
  ) {
    root.render(<Unsupported detail={T.detail.insecure!} />);
    return;
  }

  const storage = await PhoneStorage.open();
  // Phase 5: a home-screen app starts with the same URL every time, so the pairing link it was
  // added with is offered until it is handled (paired, cancelled, expired), and then never again.
  // A browser tab only opens a link when the user does, so it always offers it.
  let firstPayload = first.kind === "pairing" ? first.payload : null;
  if (
    firstPayload &&
    platform.standalone &&
    (await storage.hasSeenLink(await pairingLinkId(firstPayload)))
  )
    firstPayload = null;
  const linkHandled = (p: PairingPayload) => {
    void pairingLinkId(p)
      .then((id) => storage.markLinkSeen(id))
      .catch(() => undefined);
  };
  // Phase 5: if iOS dropped the link, the home-screen app's first launch opens the scanner itself.
  const scanOnStart =
    (await storage.firstRun()) &&
    platform.standalone &&
    first.kind === "none" &&
    (await storage.listRooms()).length === 0;
  const wake = new ScreenWake();
  const controller = new PhoneController({
    storage,
    platform,
    recorder: new Recorder(),
    haptic,
    wake,
  });

  let seq = 0;
  let link: { payload: PairingPayload | null; invalid: boolean; seq: number } =
    {
      payload: firstPayload,
      invalid: first.kind === "invalid",
      seq: 0,
    };
  const render = () =>
    root.render(
      <StrictMode>
        <App
          controller={controller}
          platform={platform}
          allowInsecureLocalhost={!!policy.allowInsecureLocalhost}
          link={link}
          scanOnStart={scanOnStart}
          onLinkHandled={linkHandled}
        />
      </StrictMode>,
    );
  const openLink = (payload: PairingPayload | null, invalid: boolean) => {
    link = { payload, invalid, seq: ++seq };
    render();
  };

  // PHONE-11: a pairing link that arrives while the app is open.
  window.addEventListener("hashchange", () => {
    const r = takePairingFragment(location, history, policy);
    if (r.kind !== "none")
      openLink(r.kind === "pairing" ? r.payload : null, r.kind === "invalid");
  });
  window.walkieTalkey = {
    openPairingUrl(url: string): boolean {
      try {
        openLink(parseScanned(url, policy), false);
        return true;
      } catch {
        return false;
      }
    },
  };

  // PHONE-30: the warm microphone closes in the background and opens again in the foreground.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") controller.foreground();
    else controller.hidden();
  });
  window.addEventListener("pagehide", () => controller.hidden());
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) controller.foreground();
  });
  window.addEventListener("online", () => controller.network(true));
  // PHONE-35: the AudioContext may only start inside a user gesture; prepare it on the first touch.
  document.addEventListener("pointerdown", () => controller.prime(), {
    capture: true,
    once: true,
  });
  // A touch or a key keeps the microphone warm (it closes after a few idle minutes).
  for (const type of ["pointerdown", "keydown"] as const)
    document.addEventListener(type, () => controller.activity(), {
      capture: true,
      passive: true,
    });

  render();
  await controller.init();
  if (startOnLoad && first.kind === "none")
    window.dispatchEvent(new CustomEvent(SHELL_START_EVENT));
  registerServiceWorker();
}

void main();
