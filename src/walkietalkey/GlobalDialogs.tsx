// Dialogs and notices that can appear over any screen: "Var det dig?" after
// a phone joins (DESK-62), the pairing window (spec 5.3), in-window notices
// when system notifications are unavailable (DESK-56), and the pause state.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { commands } from "@/bindings";
import type { WtPlatform } from "./lib/helpers";
import { useTauriEvent } from "./lib/hooks";
import type { NoticeEvent, PhoneJoinedEvent } from "./lib/types";
import { useUi } from "./lib/uiStore";
import { Button, Dialog, Status } from "./ui/controls";
import { PairingCode } from "./ui/pairing";

export function GlobalDialogs(_props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const [joined, setJoined] = useState<PhoneJoinedEvent[]>([]);
  const [removeFailed, setRemoveFailed] = useState(false);
  const lastJoinedAt = useRef(0);
  const pairingOpen = useUi((s) => s.pairingOpen);
  const openPairing = useUi((s) => s.openPairing);
  const closePairing = useUi((s) => s.closePairing);
  const openHistory = useUi((s) => s.openHistory);
  const setPaused = useUi((s) => s.setPaused);

  useTauriEvent<PhoneJoinedEvent>("wt-phone-joined", (p) => {
    lastJoinedAt.current = Date.now();
    // The code has been used: the pairing window has done its job.
    closePairing();
    setJoined((list) => [...list.filter((x) => x.id !== p.id), p]);
  });
  useTauriEvent("wt-open-pairing", () => openPairing());
  useTauriEvent<number | null>("wt-open-history", (id) =>
    openHistory(typeof id === "number" ? id : null),
  );
  useTauriEvent<boolean>("wt-paused", (p) => setPaused(!!p));
  // A window that opens while paused shows it at once (DESK-96).
  useEffect(() => {
    commands
      .wtIsPaused()
      .then((p) => setPaused(!!p))
      .catch(() => {});
  }, [setPaused]);
  useTauriEvent<NoticeEvent>("wt-notify", (n) => {
    // A new phone gets the "Var det dig?" dialog instead of a notice.
    if (n.history_id == null && Date.now() - lastJoinedAt.current < 3000)
      return;
    const id = n.history_id;
    toast(n.title, {
      description: n.body || undefined,
      action:
        id != null
          ? { label: t("wt.history.show"), onClick: () => openHistory(id) }
          : undefined,
    });
  });

  const current = joined[0];
  const dismiss = () => {
    setRemoveFailed(false);
    setJoined((list) => list.slice(1));
  };
  const remove = async () => {
    if (!current) return;
    try {
      const r = await commands.wtPhoneRemove(current.id);
      if (r.status === "error") {
        setRemoveFailed(true);
        return;
      }
    } catch {
      setRemoveFailed(true);
      return;
    }
    dismiss();
  };

  return (
    <>
      <Dialog
        open={pairingOpen}
        wide
        title={t("wt.pairing.title")}
        onCancel={closePairing}
        actions={<Button onClick={closePairing}>{t("wt.common.close")}</Button>}
      >
        {pairingOpen ? <PairingCode /> : null}
      </Dialog>
      <Dialog
        open={!!current}
        alert
        title={
          current ? t("wt.notify.phoneJoined", { name: current.name }) : ""
        }
        onCancel={dismiss}
        actions={
          <>
            <Button variant="danger" onClick={() => void remove()}>
              {t("wt.common.remove")}
            </Button>
            <Button variant="primary" data-autofocus onClick={dismiss}>
              {t("wt.common.yes")}
            </Button>
          </>
        }
      >
        <p>{t("wt.phone.joinedHelp")}</p>
        {removeFailed ? (
          <Status tone="warn">{t("wt.phone.removeFailed")}</Status>
        ) : null}
      </Dialog>
    </>
  );
}
