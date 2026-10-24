// The silent-microphone notice (DESK-59), shared by the pill and the window:
// the backend's word when a screen opens (`wt_mic_check_status`), kept
// current by `wt-mic-check`.
import { useEffect } from "react";
import { create } from "zustand";
import { commands } from "@/bindings";
import { useTauriEvent } from "./hooks";
import type { MicCheck } from "./types";

export const useMicCheckStore = create<{
  check: MicCheck | null;
  setCheck: (check: MicCheck | null) => void;
}>()((set) => ({
  check: null,
  setCheck: (check) => set({ check }),
}));

/** The notice as it stands: asked for once, then followed. */
export function useMicCheck(): MicCheck | null {
  const check = useMicCheckStore((s) => s.check);
  const setCheck = useMicCheckStore((s) => s.setCheck);
  useEffect(() => {
    let stop = false;
    commands
      .wtMicCheckStatus()
      .then((c) => {
        if (!stop) setCheck(c);
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [setCheck]);
  useTauriEvent<MicCheck>("wt-mic-check", (c) => setCheck(c));
  return check;
}
