// Indstillinger › Telefon (spec 5.3, 5.4, 6.14): paired phones with Fjern,
// and Par en telefon.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type RelayView } from "@/bindings";
import { dayNumber, lastSeen } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import { useUi } from "../lib/uiStore";
import { useLocked, useWtSettings } from "../lib/wtStore";
import { Button, Group, LockNote, Page, Status } from "../ui/controls";

export function PhoneSection() {
  const { t, i18n } = useTranslation();
  const wt = useWtSettings();
  const pairingLocked = useLocked("allow_phone_pairing");
  const openPairing = useUi((s) => s.openPairing);
  const [relay, setRelay] = useState<RelayView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRelay(await commands.wtRelayStatus());
    } catch (e) {
      console.warn("Relay status failed:", e);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useTauriEvent("wt-phones-changed", () => void refresh());
  useTauriEvent("wt-relay-status", () => void refresh());

  const remove = async (id: string, name: string) => {
    setFailed(null);
    try {
      const r = await commands.wtPhoneRemove(id);
      if (r.status === "error") setFailed(name);
    } catch {
      setFailed(name);
    }
    void refresh();
  };

  const allowed = wt?.allow_phone_pairing ?? true;
  const phones = relay?.phones ?? [];
  const seenLabel = (day: number | null | undefined) => {
    const seen = lastSeen(day, dayNumber(Date.now()));
    if (!seen) return t("wt.phone.offline");
    if (seen.kind !== "date") return t(`wt.phone.lastSeen.${seen.kind}`);
    const date = new Intl.DateTimeFormat(
      i18n.language === "da" ? "da-DK" : "en-GB",
      {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      },
    ).format(seen.date);
    return t("wt.phone.lastSeen.date", { date });
  };

  return (
    <Page title={t("wt.nav.phone")} description={t("wt.phone.intro")}>
      <Group title={t("wt.phone.paired")}>
        {phones.length ? (
          <ul className="wt-list">
            {phones.map((p) => (
              <li key={p.id} className="wt-list-item">
                <div className="wt-list-main">
                  <span>{p.name || t("wt.phone.noName")}</span>
                  <span className="wt-list-sub">
                    <span
                      className={p.online ? "wt-dot wt-dot--on" : "wt-dot"}
                      aria-hidden
                    />
                    {p.online
                      ? t("wt.phone.online")
                      : seenLabel(p.last_seen_day)}
                  </span>
                </div>
                <Button
                  aria-label={t("wt.phone.removeNamed", {
                    name: p.name || t("wt.phone.noName"),
                  })}
                  onClick={() => void remove(p.id, p.name)}
                >
                  {t("wt.common.remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="wt-empty">{t("wt.phone.none")}</p>
        )}
      </Group>
      {failed ? (
        <Status tone="warn">
          {t("wt.phone.removeFailedNamed", { name: failed })}
        </Status>
      ) : null}

      <Group>
        <div className="wt-row">
          <div className="wt-row-text">
            <span className="wt-row-title">{t("wt.phone.pairTitle")}</span>
            <p className="wt-row-desc">{t("wt.phone.pairDesc")}</p>
            {!allowed || pairingLocked ? <LockNote /> : null}
          </div>
          <div className="wt-row-control">
            <Button variant="primary" disabled={!allowed} onClick={openPairing}>
              {t("wt.pairing.title")}
            </Button>
          </div>
        </div>
        {/* The relay connects only while a phone is paired or a code is open. */}
        {relay && (phones.length > 0 || relay.pairing_active) ? (
          <div className="wt-row">
            <Status tone={relay.connected ? "muted" : "warn"}>
              {relay.connected
                ? t("wt.phone.connected")
                : t("wt.phone.disconnected")}
            </Status>
          </div>
        ) : null}
      </Group>
    </Page>
  );
}
