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
import { parseScanned, takePairingFragment } from "./lib/pairingLink";
import { detectPlatform, isIosSafariTab, readEnv } from "./lib/platform";
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
  // PHONE-15: read the pairing fragment and remove it from the address bar and history at once.
  const first = takePairingFragment(location, history, policy);
  const root: Root = createRoot(document.getElementById("root")!);

  if (isIosSafariTab(platform)) {
    // PHONE-04 and spec 5.3 step 2: a Safari tab never pairs and never creates keys.
    root.render(<InstallScreen fromLink={first.kind !== "none"} />);
    registerServiceWorker();
    return;
  }
  if (
    !window.isSecureContext ||
    !globalThis.crypto?.subtle ||
    typeof indexedDB === "undefined"
  ) {
    root.render(<Unsupported detail={T.detail.insecure!} />);
    return;
  }

  const storage = await PhoneStorage.open();
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
      payload: first.kind === "pairing" ? first.payload : null,
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

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") controller.foreground();
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) controller.foreground();
  });
  window.addEventListener("online", () => controller.network(true));
  // PHONE-35: the AudioContext may only start inside a user gesture; prepare it on the first touch.
  document.addEventListener("pointerdown", () => controller.prime(), {
    capture: true,
    once: true,
  });

  render();
  await controller.init();
  if (startOnLoad && first.kind === "none")
    window.dispatchEvent(new CustomEvent(SHELL_START_EVENT));
  registerServiceWorker();
}

void main();
