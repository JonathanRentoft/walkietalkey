// The pairing code (spec 5.3): a QR with a countdown to its expiry, and a
// cancel when it is no longer shown. Used by onboarding step 7 and by the
// pairing window (Indstillinger › Telefon › Par en telefon).
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type PairingView } from "@/bindings";
import { formatClock, secondsLeft } from "../lib/helpers";
import { useNow, useTauriEvent } from "../lib/hooks";
import { useWtSettings } from "../lib/wtStore";
import { Button, Status } from "./controls";

type State =
  | { kind: "loading" }
  | { kind: "shown"; pairing: PairingView }
  | { kind: "expired" }
  | { kind: "failed" };

export function PairingCode() {
  const { t } = useTranslation();
  const settings = useWtSettings();
  const [state, setState] = useState<State>({ kind: "loading" });
  const shown = state.kind === "shown";
  const now = useNow(shown);
  const generation = useRef(0);

  const start = useCallback(async () => {
    const mine = ++generation.current;
    setState({ kind: "loading" });
    try {
      const result = await commands.wtPairingStart();
      if (mine !== generation.current) return;
      setState(
        result.status === "ok"
          ? { kind: "shown", pairing: result.data }
          : { kind: "failed" },
      );
    } catch {
      if (mine === generation.current) setState({ kind: "failed" });
    }
  }, []);

  useEffect(() => {
    void start();
    return () => {
      generation.current++;
      // Closing the window cancels the code (spec 5.3 step 1).
      void commands.wtPairingCancel().catch(() => {});
    };
  }, [start]);

  useTauriEvent("wt-pairing-expired", () => setState({ kind: "expired" }));

  const left = shown ? secondsLeft(state.pairing.expires_at_ms, now) : 0;
  useEffect(() => {
    if (shown && left === 0) setState({ kind: "expired" });
  }, [shown, left]);

  const phoneApp = settings?.phone_app_url?.replace(/^https?:\/\//, "") ?? "";

  return (
    <div className="wt-pairing">
      <div className="wt-pairing-code">
        {state.kind === "shown" ? (
          <img
            className="wt-qr"
            alt={t("wt.pairing.qrLabel")}
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.pairing.qr_svg)}`}
          />
        ) : (
          <div className="wt-qr wt-qr--empty" aria-hidden />
        )}
      </div>
      <div className="wt-pairing-text">
        {state.kind === "shown" ? (
          <>
            <p>{t("wt.pairing.howTo")}</p>
            <p className="wt-pairing-timer">
              <span>{t("wt.pairing.validFor")}</span>{" "}
              <time
                className="wt-countdown"
                aria-label={t("wt.pairing.timeLeft", { time: formatClock(left) })}
              >
                {formatClock(left)}
              </time>
            </p>
          </>
        ) : null}
        {state.kind === "loading" ? (
          <Status tone="muted">{t("wt.pairing.loading")}</Status>
        ) : null}
        {state.kind === "expired" ? (
          <>
            <Status tone="warn">{t("wt.pairing.expired")}</Status>
            <Button onClick={() => void start()}>{t("wt.pairing.newCode")}</Button>
          </>
        ) : null}
        {state.kind === "failed" ? (
          <>
            <Status tone="warn">{t("wt.pairing.failed")}</Status>
            <Button onClick={() => void start()}>{t("wt.common.retry")}</Button>
          </>
        ) : null}
        <p className="wt-note">{t("wt.pairing.noScreenShare")}</p>
        {phoneApp ? (
          <p className="wt-note">{t("wt.pairing.getApp", { url: phoneApp })}</p>
        ) : null}
      </div>
    </div>
  );
}
