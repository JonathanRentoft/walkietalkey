// The dictation key: shown as Keycaps (design system) and chosen by pressing
// it, with Handy's backend key recording (handy-keys-event).
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { Keycap } from "@walkietalkey/ui";
import { commands } from "@/bindings";
import { useSettingsStore } from "@/stores/settingsStore";
import { ShortcutInput } from "@/components/settings/ShortcutInput";
import { isCopilotBinding, keyParts, type WtPlatform } from "../lib/helpers";
import { useTauriEvent } from "../lib/hooks";
import { Button, Status } from "./controls";

export const DICTATION_BINDING = "transcribe";

interface HandyKeysEvent {
  modifiers: string[];
  key: string | null;
  is_key_down: boolean;
  hotkey_string: string;
}

/** Danish names for Handy's key tokens. Symbols stay symbols. */
export function useKeyLabel(platform: WtPlatform) {
  const { t } = useTranslation();
  return useCallback(
    (part: string): string => {
      const p = part.toLowerCase();
      let side: "left" | "right" | null = null;
      let base = p;
      if (p.endsWith("_left")) {
        side = "left";
        base = p.slice(0, -5);
      } else if (p.endsWith("_right")) {
        side = "right";
        base = p.slice(0, -6);
      }
      const names: Record<string, string> = {
        fn: "fn",
        ctrl: "Ctrl",
        control: "Ctrl",
        shift: "Shift",
        alt: platform === "macos" ? "⌥" : "Alt",
        option: platform === "macos" ? "⌥" : "Alt",
        command: "⌘",
        cmd: "⌘",
        meta: platform === "macos" ? "⌘" : "Win",
        super: platform === "macos" ? "⌘" : "Win",
        win: "Win",
        space: t("wt.keys.space"),
        esc: "Esc",
        escape: "Esc",
        enter: "Enter",
        tab: "Tab",
        capslock: "Caps Lock",
      };
      const name =
        names[base] ??
        (base.length === 1 || /^f\d+$/.test(base) ? base.toUpperCase() : base);
      if (side === "left") return t("wt.keys.left", { key: name });
      if (side === "right") return t("wt.keys.right", { key: name });
      return name;
    },
    [platform, t],
  );
}

/** The key's name in a sentence: "fn", "Ctrl", "Copilot-tasten", ... */
export function useKeyName(platform: WtPlatform): string {
  const { t } = useTranslation();
  const binding =
    useSettingsStore(
      (s) => s.settings?.bindings?.[DICTATION_BINDING]?.current_binding,
    ) ?? (platform === "macos" ? "fn" : "ctrl_right");
  const label = useKeyLabel(platform);
  if (isCopilotBinding(binding)) return t("wt.keys.copilot");
  const parts = keyParts(binding);
  if (parts.length === 1 && /^ctrl(_left|_right)?$/.test(parts[0]))
    return "Ctrl";
  return parts.map(label).join(" + ");
}

export function KeyCaps(props: {
  binding: string;
  platform: WtPlatform;
  pressed?: boolean;
  size?: number;
}) {
  const { t } = useTranslation();
  const label = useKeyLabel(props.platform);
  const parts = isCopilotBinding(props.binding)
    ? [t("wt.keys.copilot")]
    : keyParts(props.binding).map(label);
  const spoken = parts.join(" + ");
  return (
    <span className="wt-keycaps" role="img" aria-label={spoken}>
      {parts.map((p, i) => (
        <Keycap
          key={i}
          pressed={props.pressed}
          wide={p.length > 3}
          size={props.size ?? 44}
        >
          {p}
        </Keycap>
      ))}
    </span>
  );
}

/** The current dictation key, and "press the key you want". */
export function KeyPicker(props: {
  platform: WtPlatform;
  /** Shown while the key is held (wt-key-state). */
  showLive?: boolean;
  onChanged?: (binding: string) => void;
}) {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const updateBinding = useSettingsStore((s) => s.updateBinding);
  const resetBinding = useSettingsStore((s) => s.resetBinding);
  const binding = settings?.bindings?.[DICTATION_BINDING];
  const [recording, setRecording] = useState(false);
  const [live, setLive] = useState("");
  const [pressed, setPressed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyed = useRef("");
  const modifierOnly = useRef("");
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  useTauriEvent<boolean>("wt-key-state", (down) => {
    if (props.showLive) setPressed(!!down);
  });

  const stop = useCallback(async () => {
    setRecording(false);
    setLive("");
    keyed.current = "";
    modifierOnly.current = "";
    await commands.stopHandyKeysRecording().catch(() => {});
  }, []);

  useEffect(() => {
    if (!recording) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const commit = async (value: string) => {
      await stop();
      try {
        await updateBinding(DICTATION_BINDING, value);
        onChanged.current?.(value);
      } catch (e) {
        setError(String(e));
      }
    };
    listen<HandyKeysEvent>("handy-keys-event", (event) => {
      if (disposed) return;
      const { hotkey_string, is_key_down, key, modifiers } = event.payload;
      if (is_key_down && hotkey_string) {
        if (key) keyed.current = hotkey_string;
        else modifierOnly.current = hotkey_string;
        setLive(hotkey_string);
      } else if (!is_key_down && key) {
        void commit(keyed.current || hotkey_string);
      } else if (
        !is_key_down &&
        !key &&
        modifiers.length === 0 &&
        !keyed.current &&
        modifierOnly.current
      ) {
        void commit(modifierOnly.current);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [recording, stop, updateBinding]);

  // Never leave the backend recording keys.
  useEffect(
    () => () => void commands.stopHandyKeysRecording().catch(() => {}),
    [],
  );

  if (settings?.keyboard_implementation === "tauri") {
    // Linux builds record keys in the webview; Handy's control does that.
    return (
      <ShortcutInput shortcutId={DICTATION_BINDING} descriptionMode="inline" />
    );
  }

  const start = async () => {
    setError(null);
    try {
      const result = await commands.startHandyKeysRecording(DICTATION_BINDING);
      if (result.status === "error") {
        setError(
          String(result.error).includes("secure-input-active")
            ? t("secureInput.recorderBlocked")
            : t("wt.keys.recordFailed"),
        );
        return;
      }
      setRecording(true);
    } catch {
      setError(t("wt.keys.recordFailed"));
    }
  };

  const current = binding?.current_binding ?? "";
  return (
    <div className="wt-keypicker">
      <div className="wt-keypicker-caps" aria-live="polite">
        {recording ? (
          live ? (
            <KeyCaps
              binding={live}
              platform={props.platform}
              pressed
              size={56}
            />
          ) : (
            <span className="wt-keypicker-prompt">{t("wt.keys.pressNow")}</span>
          )
        ) : (
          <KeyCaps
            binding={current}
            platform={props.platform}
            pressed={pressed}
            size={56}
          />
        )}
      </div>
      <div className="wt-keypicker-actions">
        {recording ? (
          <Button onClick={() => void stop()}>{t("wt.common.cancel")}</Button>
        ) : (
          <>
            <Button onClick={() => void start()}>{t("wt.keys.choose")}</Button>
            {binding && current !== binding.default_binding ? (
              <Button
                variant="quiet"
                onClick={() =>
                  void resetBinding(DICTATION_BINDING).then(() =>
                    onChanged.current?.(binding.default_binding),
                  )
                }
              >
                {t("wt.keys.reset")}
              </Button>
            ) : null}
          </>
        )}
      </div>
      {error ? <Status tone="warn">{error}</Status> : null}
    </div>
  );
}
