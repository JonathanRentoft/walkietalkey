// Indstillinger › Ryd op med AI (spec 6.10, DESK-80..87). Off by default.
// Before text may go to a cloud provider the user agrees to exactly
// "Teksten (ikke lyden) sendes til <udbyder>, hver gang du dikterer."
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, type CleanupMode, type WtSettings } from "@/bindings";
import {
  CLEANUP_PROVIDERS,
  cleanupConsentNeeded,
  consentProviderName,
  isCloudProvider,
  type WtPlatform,
} from "../lib/helpers";
import { useUi } from "../lib/uiStore";
import { useWtSettings, useWtStore } from "../lib/wtStore";
import {
  Button,
  ChoiceGroup,
  Dialog,
  Group,
  LockNote,
  Page,
  Select,
  SettingRow,
  Status,
  TextInput,
} from "../ui/controls";

type Patch = Partial<WtSettings>;

export function CleanupSection(props: { platform: WtPlatform }) {
  const { t } = useTranslation();
  const wt = useWtSettings();
  const update = useWtStore((s) => s.update);
  const managedKey = useWtStore((s) => !!s.view?.managed_api_key);
  const keyLocked = useWtStore((s) => !!s.view?.locked.includes("cleanup_api_key"));
  const openHistory = useUi((s) => s.openHistory);
  const [pending, setPending] = useState<Patch | null>(null);
  const [apple, setApple] = useState<boolean | null>(null);
  const providerId = useId();
  const modelId = useId();
  const endpointId = useId();
  const keyId = useId();

  useEffect(() => {
    if (props.platform !== "macos") return;
    void commands
      .checkAppleIntelligenceAvailable()
      .then(setApple)
      .catch(() => setApple(false));
  }, [props.platform]);

  if (!wt) return null;

  /** Applies a change, asking for consent first when it turns on a cloud
   *  provider the user has not agreed to (DESK-82). */
  const propose = (patch: Patch) => {
    const next = { ...wt, ...patch };
    if (cleanupConsentNeeded(next)) setPending(patch);
    else void update(patch);
  };

  const accept = () => {
    if (!pending) return;
    const next = { ...wt, ...pending };
    const provider = next.cleanup_provider;
    const consented =
      provider && !next.cleanup_consented.includes(provider)
        ? [...next.cleanup_consented, provider]
        : next.cleanup_consented;
    void update({ ...pending, cleanup_consented: consented });
    setPending(null);
  };

  const provider = wt.cleanup_provider;
  const providerInfo = CLEANUP_PROVIDERS.find((p) => p.id === provider);
  const cloud = isCloudProvider(provider, wt.cleanup_base_url);
  const pendingNext = pending ? { ...wt, ...pending } : null;
  const providerLabel = (id: string) =>
    CLEANUP_PROVIDERS.find((p) => p.id === id)?.name ?? t("wt.cleanup.custom");
  const where = provider ? consentProviderName(provider, wt.cleanup_base_url) : "";

  let sentLine: string | null = null;
  if (provider && wt.cleanup_mode !== "off") {
    if (!cloud) sentLine = provider === "apple" ? t("wt.cleanup.staysApple") : t("wt.cleanup.staysLocal");
    else if (wt.cleanup_consented.includes(provider))
      sentLine =
        wt.cleanup_mode === "when-needed"
          ? t("wt.cleanup.sentWhenNeeded", { provider: where })
          : t("wt.cleanup.consent", { provider: where });
  }

  return (
    <Page title={t("wt.nav.cleanup")} description={t("wt.cleanup.intro")}>
      <Group>
        <SettingRow title={t("wt.cleanup.mode")} lockField="cleanup_mode" stacked>
          {({ labelId, locked }) => (
            <ChoiceGroup<CleanupMode>
              labelledBy={labelId}
              disabled={locked}
              vertical
              value={wt.cleanup_mode}
              onChange={(v) => propose({ cleanup_mode: v })}
              options={[
                { value: "off", label: t("wt.cleanup.off") },
                {
                  value: "when-needed",
                  label: t("wt.cleanup.whenNeeded"),
                  description: t("wt.cleanup.whenNeededDesc"),
                },
                { value: "always", label: t("wt.cleanup.always") },
                {
                  value: "shift",
                  label: t("wt.cleanup.shift"),
                  description: t("wt.cleanup.shiftDesc"),
                },
              ]}
            />
          )}
        </SettingRow>
        <SettingRow title={t("wt.cleanup.provider")} lockField="cleanup_provider" htmlFor={providerId}>
          {({ locked }) => (
            <Select
              id={providerId}
              disabled={locked}
              value={provider ?? ""}
              onChange={(e) =>
                propose({
                  cleanup_provider: e.target.value || null,
                  cleanup_model: null,
                })
              }
            >
              <option value="">{t("wt.cleanup.chooseProvider")}</option>
              {CLEANUP_PROVIDERS.filter((p) => !p.macOnly || props.platform === "macos").map((p) => {
                const isCloud = isCloudProvider(p.id, p.id === "custom" ? wt.cleanup_base_url : null);
                const disabled =
                  (p.id === "apple" && apple === false) || (isCloud && !wt.allow_cloud_cleanup);
                return (
                  <option key={p.id} value={p.id} disabled={disabled}>
                    {providerLabel(p.id)}
                  </option>
                );
              })}
            </Select>
          )}
        </SettingRow>
        {!wt.allow_cloud_cleanup ? (
          <div className="wt-row">
            <div className="wt-row-text">
              <span className="wt-row-desc">{t("wt.cleanup.onlyLocal")}</span>
              <LockNote />
            </div>
          </div>
        ) : null}
        {provider === "apple" && apple === false ? (
          <div className="wt-row">
            <Status tone="warn">{t("wt.cleanup.appleUnavailable")}</Status>
          </div>
        ) : null}
        {provider && provider !== "apple" ? (
          <SettingRow title={t("wt.cleanup.model")} description={t("wt.cleanup.modelDesc")} lockField="cleanup_model" htmlFor={modelId}>
            {({ locked }) => (
              <CommitInput
                id={modelId}
                disabled={locked}
                value={wt.cleanup_model ?? ""}
                placeholder={t("wt.cleanup.modelPlaceholder")}
                onCommit={(v) => void update({ cleanup_model: v || null })}
              />
            )}
          </SettingRow>
        ) : null}
        {provider === "custom" ? (
          <SettingRow
            title={t("wt.cleanup.endpoint")}
            description={t("wt.cleanup.endpointDesc")}
            lockField="cleanup_base_url"
            htmlFor={endpointId}
          >
            {({ locked }) => (
              <CommitInput
                id={endpointId}
                disabled={locked}
                value={wt.cleanup_base_url ?? ""}
                placeholder="http://localhost:11434/v1"
                onCommit={(v) => propose({ cleanup_base_url: v || null })}
              />
            )}
          </SettingRow>
        ) : null}
        {providerInfo?.needsKey ? (
          <KeyRow id={keyId} provider={providerInfo.id} managed={managedKey} locked={keyLocked} />
        ) : null}
        {sentLine ? (
          <div className="wt-row">
            <Status>{sentLine}</Status>
          </div>
        ) : null}
      </Group>

      <p className="wt-note">{t("wt.cleanup.smallModels")}</p>

      <Group>
        <SettingRow title={t("wt.cleanup.showSent")} description={t("wt.cleanup.showSentDesc")}>
          <Button onClick={() => openHistory(null, true)}>{t("wt.cleanup.openHistory")}</Button>
        </SettingRow>
      </Group>

      <Dialog
        open={!!pending}
        alert
        title={t("wt.nav.cleanup")}
        onCancel={() => setPending(null)}
        actions={
          <>
            <Button onClick={() => setPending(null)}>{t("wt.cleanup.cancel")}</Button>
            <Button variant="primary" data-autofocus onClick={accept}>
              {t("wt.cleanup.turnOn")}
            </Button>
          </>
        }
      >
        {pendingNext?.cleanup_provider ? (
          <p>
            {t("wt.cleanup.consent", {
              provider: consentProviderName(pendingNext.cleanup_provider, pendingNext.cleanup_base_url),
            })}
          </p>
        ) : null}
      </Dialog>
    </Page>
  );
}

/** A text field that saves on Enter or when it loses focus. */
function CommitInput(props: {
  id: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => {
    if (draft.trim() !== props.value) props.onCommit(draft.trim());
  };
  return (
    <TextInput
      id={props.id}
      value={draft}
      placeholder={props.placeholder}
      disabled={props.disabled}
      spellCheck={false}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/** The user's own API key (DESK-81): stored in the keychain through
 *  wtSetCleanupKey and never read back into the window. */
function KeyRow(props: { id: string; provider: string; managed: boolean; locked: boolean }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [stored, setStored] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setDraft("");
    void commands
      .wtHasCleanupKey(props.provider)
      .then(setStored)
      .catch(() => setStored(false));
  }, [props.provider]);

  const save = async (key: string) => {
    setFailed(false);
    try {
      const r = await commands.wtSetCleanupKey(props.provider, key);
      if (r.status === "error") {
        setFailed(true);
        return;
      }
      setDraft("");
      setStored(await commands.wtHasCleanupKey(props.provider));
    } catch {
      setFailed(true);
    }
  };

  if (props.managed || props.locked) {
    return (
      <SettingRow title={t("wt.cleanup.key")} description={t("wt.cleanup.keyManaged")} locked>
        {null}
      </SettingRow>
    );
  }

  return (
    <SettingRow title={t("wt.cleanup.key")} description={t("wt.cleanup.keyDesc")} htmlFor={props.id} stacked>
      <form
        className="wt-inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (draft) void save(draft);
        }}
      >
        <TextInput
          id={props.id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          placeholder={stored ? t("wt.cleanup.keyStoredPlaceholder") : ""}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit" disabled={!draft}>
          {t("wt.cleanup.saveKey")}
        </Button>
        {stored ? (
          <Button variant="quiet" onClick={() => void save("")}>
            {t("wt.cleanup.removeKey")}
          </Button>
        ) : null}
      </form>
      {stored ? <Status tone="ok">{t("wt.cleanup.keyStored")}</Status> : null}
      {failed ? <Status tone="warn">{t("wt.cleanup.keyFailed")}</Status> : null}
    </SettingRow>
  );
}
