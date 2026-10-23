// Indstillinger › Opdateringer (spec 6.16, DESK-110..112).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type UpdateChannel } from "@/bindings";
import { useTauriEvent } from "../lib/hooks";
import { restartApp } from "../lib/system";
import type { UpdateStatus } from "../lib/types";
import { useWtSettings, useWtStore } from "../lib/wtStore";
import { Button, ChoiceGroup, Group, Page, SettingRow, Status, Switch } from "../ui/controls";

export function UpdatesSection() {
  const { t } = useTranslation();
  const wt = useWtSettings();
  const update = useWtStore((s) => s.update);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [handyLocked, setHandyLocked] = useState(false);

  useEffect(() => {
    void commands
      .isUpdateChecksLocked()
      .then(setHandyLocked)
      .catch(() => setHandyLocked(false));
  }, []);
  useTauriEvent<UpdateStatus>("wt-update-status", setStatus);

  const check = async () => {
    setStatus({ state: "checking" });
    try {
      await commands.wtCheckUpdates();
    } catch {
      setStatus({ state: "failed", message: "" });
    }
  };

  let line: { text: string; tone?: "ok" | "warn" | "muted" } | null = null;
  switch (status?.state) {
    case "checking":
      line = { text: t("wt.updates.checking"), tone: "muted" };
      break;
    case "up_to_date":
      line = { text: t("wt.updates.upToDate"), tone: "ok" };
      break;
    case "downloading":
      line = { text: t("wt.updates.downloading", { version: status.version }), tone: "muted" };
      break;
    case "ready":
      line = { text: t("wt.notify.updateReady") };
      break;
    case "failed":
      line = { text: t("wt.updates.failed"), tone: "warn" };
      break;
  }

  return (
    <Page title={t("wt.nav.updates")}>
      <Group>
        <SettingRow
          title={t("wt.updates.auto")}
          description={t("wt.updates.autoDesc")}
          lockField="auto_update"
          locked={handyLocked}
        >
          {({ labelId, descId, locked }) => (
            <Switch
              labelledBy={labelId}
              describedBy={descId}
              disabled={locked}
              checked={wt?.auto_update ?? true}
              onChange={(v) => void update({ auto_update: v })}
            />
          )}
        </SettingRow>
        <SettingRow
          title={t("wt.updates.channel")}
          description={t("wt.updates.channelDesc")}
          lockField="update_channel"
          stacked
        >
          {({ labelId, locked }) => (
            <ChoiceGroup<UpdateChannel>
              labelledBy={labelId}
              disabled={locked}
              value={wt?.update_channel ?? "stable"}
              onChange={(v) => void update({ update_channel: v })}
              options={[
                { value: "stable", label: t("wt.updates.stable") },
                { value: "beta", label: t("wt.updates.beta") },
              ]}
            />
          )}
        </SettingRow>
        <div className="wt-row wt-row--stacked">
          <div className="wt-inline">
            <Button onClick={() => void check()} disabled={status?.state === "checking"}>
              {t("wt.updates.check")}
            </Button>
            {status?.state === "ready" ? (
              <Button variant="primary" onClick={() => void restartApp()}>
                {t("wt.notify.restartNow")}
              </Button>
            ) : null}
          </div>
          {line ? <Status tone={line.tone}>{line.text}</Status> : null}
        </div>
      </Group>
    </Page>
  );
}
