// Handy's error toasts (recording, paste, transcription, model load), kept
// from Handy's App with its own translated strings.
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { platform } from "@tauri-apps/plugin-os";
import type { ModelStateEvent, RecordingErrorEvent } from "@/lib/types/events";
import { useTauriEvent } from "./hooks";

export function useHandyToasts() {
  const { t } = useTranslation();

  useTauriEvent<RecordingErrorEvent>(
    "recording-error",
    ({ error_type, detail }) => {
      if (error_type === "microphone_permission_denied") {
        let os = "generic";
        try {
          os = platform();
        } catch {
          // keep generic
        }
        toast.error(t("errors.micPermissionDeniedTitle"), {
          description: t(`errors.micPermissionDenied.${os}`, {
            defaultValue: t("errors.micPermissionDenied.generic"),
          }),
        });
      } else if (error_type === "no_input_device") {
        toast.error(t("errors.noInputDeviceTitle"), {
          description: t("errors.noInputDevice"),
        });
      } else {
        toast.error(t("errors.recordingFailed", { error: detail ?? "" }));
      }
    },
  );

  useTauriEvent("paste-error", () => {
    toast.error(t("errors.pasteFailedTitle"), {
      description: t("errors.pasteFailed"),
    });
  });

  useTauriEvent<string>("transcription-error", (detail) => {
    toast.error(t("errors.transcriptionFailedTitle"), { description: detail });
  });

  useTauriEvent<ModelStateEvent>("model-state-changed", (e) => {
    if (e.event_type === "loading_failed") {
      toast.error(
        t("errors.modelLoadFailed", {
          model: e.model_name || t("errors.modelLoadFailedUnknown"),
        }),
        { description: e.error },
      );
    }
  });
}
