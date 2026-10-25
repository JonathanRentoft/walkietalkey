// Window-level UI state: which screen is shown, the pairing window, and the
// history item a notification click selects.
import { create } from "zustand";

export const SECTIONS = [
  "history",
  "general",
  "key",
  "text",
  "vocabulary",
  "cleanup",
  "phone",
  "model",
  "updates",
  "advanced",
  "about",
] as const;
export type SectionId = (typeof SECTIONS)[number];

interface UiStore {
  section: SectionId;
  setSection: (s: SectionId) => void;
  pairingOpen: boolean;
  openPairing: () => void;
  closePairing: () => void;
  /** Selected by a notification click (DESK-57). */
  historyId: number | null;
  /** "Vis hvad der blev sendt": only items that went to a provider. */
  historySentOnly: boolean;
  openHistory: (id: number | null, sentOnly?: boolean) => void;
  paused: boolean;
  setPaused: (p: boolean) => void;
  /** Run 6: "Vis introduktionen igen" shows the first-run screens again. */
  replayIntro: boolean;
  setReplayIntro: (on: boolean) => void;
}

export const useUi = create<UiStore>()((set) => ({
  section: "general",
  setSection: (section) => set({ section }),
  pairingOpen: false,
  openPairing: () => set({ pairingOpen: true }),
  closePairing: () => set({ pairingOpen: false }),
  historyId: null,
  historySentOnly: false,
  openHistory: (historyId, sentOnly = false) =>
    set({ section: "history", historyId, historySentOnly: sentOnly }),
  paused: false,
  setPaused: (paused) => set({ paused }),
  replayIntro: false,
  setReplayIntro: (replayIntro) => set({ replayIntro }),
}));
