/** Navigation between the phone app's screens. The controller holds everything else. */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { PairingPayload } from "@walkietalkey/protocol";
import type { PhoneController } from "../core/controller";
import { suggestPhoneName } from "../lib/pairingLink";
import type { Platform } from "../lib/platform";
import { T } from "../lib/strings";
import { MainScreen } from "./MainScreen";
import { Loading, NameScreen, PairScreen, ScanScreen } from "./screens";
import {
  DetailsSheet,
  NoticeDialog,
  PickerSheet,
  SettingsScreen,
} from "./settings";

/** Dispatched on window by the iOS shell (App Intent "Start diktering"). */
export const SHELL_START_EVENT = "wt-shell-start";

type View =
  | { name: "home" }
  | { name: "pair" }
  | { name: "scan" }
  | { name: "name"; payload: PairingPayload }
  | { name: "settings" };

export interface AppProps {
  controller: PhoneController;
  platform: Platform;
  allowInsecureLocalhost: boolean;
  /** A pairing link the app was opened with, or that arrived later (iOS shell, hashchange). */
  link: { payload: PairingPayload | null; invalid: boolean; seq: number };
  /** The home-screen app's first launch without a link: open the scanner at once (Phase 5). */
  scanOnStart?: boolean;
}

export function App({
  controller,
  platform,
  allowInsecureLocalhost,
  link,
  scanOnStart = false,
}: AppProps) {
  const snap = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );
  const [view, setView] = useState<View>(
    scanOnStart ? { name: "scan" } : { name: "home" },
  );
  const [sheet, setSheet] = useState<"picker" | "details" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (link.payload) {
      controller.clearPairingError();
      setView({ name: "name", payload: link.payload });
    } else if (link.invalid) {
      setMessage(T.notACode);
      setView({ name: "pair" });
    }
  }, [link, controller]);

  // The iOS shell's "Start diktering": back to the main screen and record hands-free. Ignored
  // while pairing (scanner, name) and when not paired (the controller checks that).
  const viewRef = useRef(view);
  viewRef.current = view;
  useEffect(() => {
    const onStart = () => {
      const v = viewRef.current.name;
      if (v === "scan" || v === "name") return;
      if (!controller.shellStart()) return;
      setSheet(null);
      setMessage(null);
      setView({ name: "home" });
    };
    window.addEventListener(SHELL_START_EVENT, onStart);
    return () => window.removeEventListener(SHELL_START_EVENT, onStart);
  }, [controller]);

  const onScanned = useCallback(
    (payload: PairingPayload) => {
      controller.clearPairingError();
      setView({ name: "name", payload });
    },
    [controller],
  );

  const home = () => {
    setMessage(null);
    setView({ name: "home" });
  };

  if (!snap.loaded) return <Loading />;

  const paired = snap.rooms.length > 0;
  let screen;
  if (view.name === "scan") {
    screen = (
      <ScanScreen
        onResult={onScanned}
        onCancel={home}
        allowInsecureLocalhost={allowInsecureLocalhost}
      />
    );
  } else if (view.name === "name") {
    screen = (
      <NameScreen
        key={view.payload.n + view.payload.a.join(",")}
        payload={view.payload}
        defaultName={
          snap.settings.deviceName ??
          suggestPhoneName(view.payload.n, platform.device)
        }
        pairing={snap.pairing}
        onPair={async (name) => {
          if (await controller.pair(view.payload, name)) home();
        }}
        onRescan={() => {
          controller.clearPairingError();
          setView({ name: "scan" });
        }}
        onCancel={() => {
          controller.clearPairingError();
          home();
        }}
      />
    );
  } else if (view.name === "settings") {
    screen = (
      <SettingsScreen
        snap={snap}
        onBack={home}
        onPair={() => setView({ name: "pair" })}
        onRemove={(roomId) => controller.removeRoom(roomId)}
        onHaptics={(on) => controller.setHaptics(on)}
      />
    );
  } else if (view.name === "pair" || !paired) {
    screen = (
      <PairScreen
        message={message}
        onScan={() => {
          setMessage(null);
          setView({ name: "scan" });
        }}
        onBack={paired ? home : undefined}
      />
    );
  } else {
    screen = (
      <MainScreen
        controller={controller}
        snap={snap}
        onPicker={() => setSheet("picker")}
        onDetails={() => setSheet("details")}
      />
    );
  }

  const notice = snap.notices[0];
  return (
    <>
      {screen}
      {sheet === "picker" && view.name === "home" && paired ? (
        <PickerSheet
          rooms={snap.rooms}
          target={snap.target}
          onPick={(roomId) => {
            controller.selectTarget(roomId);
            setSheet(null);
          }}
          onPair={() => {
            setSheet(null);
            setView({ name: "pair" });
          }}
          onSettings={() => {
            setSheet(null);
            setView({ name: "settings" });
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "details" && view.name === "home" ? (
        <DetailsSheet
          detail={snap.machine.detail}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {notice ? (
        <NoticeDialog
          notice={notice}
          onPair={() => {
            controller.dismissNotice(notice.id);
            setView({ name: "pair" });
          }}
          onClose={() => controller.dismissNotice(notice.id)}
        />
      ) : null}
    </>
  );
}
