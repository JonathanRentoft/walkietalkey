// Indstillinger › Om (spec 6.14, DESK-01): version, licences and credits,
// and links to the code, the privacy page and the trademark page.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { openLink } from "../lib/system";
import { Group, Page, SettingRow } from "../ui/controls";

export const LINKS = {
  code: "https://github.com/JonathanRentoft/walkietalkey",
  privacy: "https://walkietalkey-site.pages.dev/privatliv",
  trademark: "https://walkietalkey-site.pages.dev/varemaerke",
} as const;

/** Names are not translated; what they are and their licence are. */
const CREDITS = [
  { name: "WalkieTalkey", key: "walkietalkey" },
  { name: "Handy", key: "handy" },
  { name: "transcribe.cpp", key: "transcribe" },
  { name: "Edda", key: "edda" },
  { name: "Ekko PnC", key: "ekkoPnc" },
  { name: "Ekko v1 Tiny", key: "ekkoTiny" },
  { name: "ONNX Runtime", key: "onnx" },
  { name: "Silero VAD", key: "silero" },
  { name: "Albert Sans", key: "albert" },
] as const;

export function AboutSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState("");
  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
  }, []);

  return (
    <Page title={t("wt.nav.about")} description={t("wt.about.claims")}>
      <Group>
        <SettingRow title={t("wt.about.version")}>
          <span className="wt-mono">{version}</span>
        </SettingRow>
      </Group>
      <Group title={t("wt.about.credits")}>
        <ul className="wt-credits">
          {CREDITS.map((c) => (
            <li key={c.key}>
              <b>{c.name}</b>
              <p className="wt-note">{t(`wt.about.credit.${c.key}`)}</p>
            </li>
          ))}
        </ul>
      </Group>
      <Group title={t("wt.about.links")}>
        <SettingRow
          title={t("wt.about.code")}
          description={t("wt.about.codeDesc")}
        >
          <button
            type="button"
            className="wt-link"
            aria-label={t("wt.about.openNamed", { name: t("wt.about.code") })}
            onClick={() => void openLink(LINKS.code)}
          >
            {t("wt.about.open")}
          </button>
        </SettingRow>
        <SettingRow
          title={t("wt.about.privacy")}
          description={t("wt.about.privacyDesc")}
        >
          <button
            type="button"
            className="wt-link"
            aria-label={t("wt.about.openNamed", {
              name: t("wt.about.privacy"),
            })}
            onClick={() => void openLink(LINKS.privacy)}
          >
            {t("wt.about.open")}
          </button>
        </SettingRow>
        <SettingRow
          title={t("wt.about.trademark")}
          description={t("wt.about.trademarkDesc")}
        >
          <button
            type="button"
            className="wt-link"
            aria-label={t("wt.about.openNamed", {
              name: t("wt.about.trademark"),
            })}
            onClick={() => void openLink(LINKS.trademark)}
          >
            {t("wt.about.open")}
          </button>
        </SettingRow>
      </Group>
    </Page>
  );
}
