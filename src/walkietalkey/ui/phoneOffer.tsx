// Phone pairing after the first dictation that works, never before (run 5).
// Onboarding shows Telefon only after Prøv det worked; when it ended without
// a working dictation it leaves `phone_offer_pending`, and the main window
// offers pairing here, once, as soon as a dictation has worked (now, or one
// already in the history). The same banner tells an updated Mac that its
// phones must pair again: v0.2.0 has a new identity because v0.1's keys were
// in the keychain, which is never read again (`RelayView.pair_again`).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type RelayView } from "@/bindings";
import { dictationWorked } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import type { PillEndEvent } from "../lib/types";
import { useUi } from "../lib/uiStore";
import { useWtSettings, useWtStore } from "../lib/wtStore";
import { Button } from "./controls";

const PAIR_AGAIN_DISMISSED = "wt.pairAgainDismissed";

function pairAgainDismissed(): boolean {
  try {
    return localStorage.getItem(PAIR_AGAIN_DISMISSED) === "1";
  } catch {
    return false;
  }
}

function dismissPairAgain() {
  try {
    localStorage.setItem(PAIR_AGAIN_DISMISSED, "1");
  } catch {
    /* storage may be unavailable; the notice under Telefon stays */
  }
}

export function PhoneBanner() {
  const { t } = useTranslation();
  const wt = useWtSettings();
  const update = useWtStore((s) => s.update);
  const openPairing = useUi((s) => s.openPairing);
  const [worked, setWorked] = useState(false);
  const [relay, setRelay] = useState<RelayView | null>(null);
  const [hidePairAgain, setHidePairAgain] = useState(pairAgainDismissed);
  const pending = !!wt?.phone_offer_pending;
  const allowed = wt?.allow_phone_pairing ?? true;

  const refresh = useCallback(async () => {
    try {
      setRelay(await commands.wtRelayStatus());
    } catch {
      /* no relay status: nothing to say */
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useTauriEvent("wt-phones-changed", () => void refresh());

  // A dictation that works from now on, or one that already did.
  useTauriEvent<PillEndEvent>("wt-pill-end", (e) => {
    if (dictationWorked(e?.state)) setWorked(true);
  });
  useEffect(() => {
    if (!pending) return;
    let stop = false;
    void commands
      .wtHistoryList(null)
      .then((r) => {
        if (!stop && r.status === "ok" && r.data.length > 0) setWorked(true);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [pending]);

  if (!allowed) return null;

  const pair = (after: () => void) => {
    after();
    openPairing();
  };

  if (relay?.pair_again && !hidePairAgain) {
    const later = () => {
      dismissPairAgain();
      setHidePairAgain(true);
    };
    return (
      <div className="wt-banner wt-banner--access" role="status">
        <div className="wt-banner-text">
          <p>{t("wt.phoneOffer.pairAgain")}</p>
          <p className="wt-banner-sub">{t("wt.phoneOffer.pairAgainWhy")}</p>
        </div>
        <div className="wt-banner-actions">
          <Button onClick={later}>{t("wt.phoneOffer.later")}</Button>
          <Button variant="primary" onClick={() => pair(later)}>
            {t("wt.pairing.title")}
          </Button>
        </div>
      </div>
    );
  }

  if (!pending || !worked || (relay?.phones.length ?? 0) > 0) return null;
  const done = () => void update({ phone_offer_pending: false });
  return (
    <div className="wt-banner wt-banner--access" role="status">
      <div className="wt-banner-text">
        <p>{t("wt.onboarding.phone.lead")}</p>
        <p className="wt-banner-sub">{t("wt.onboarding.phone.why")}</p>
      </div>
      <div className="wt-banner-actions">
        <Button onClick={done}>{t("wt.phoneOffer.later")}</Button>
        <Button variant="primary" onClick={() => pair(done)}>
          {t("wt.pairing.title")}
        </Button>
      </div>
    </div>
  );
}
