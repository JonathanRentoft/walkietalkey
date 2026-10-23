// WalkieTalkey's own settings (WtSettings) with the managed locks
// (DESK-101), next to Handy's settings store.
import { create } from "zustand";
import { commands, type WtSettings, type WtSettingsView } from "@/bindings";

interface WtStore {
  view: WtSettingsView | null;
  error: string | null;
  load: () => Promise<WtSettingsView | null>;
  /** Merges `patch` into the current settings and stores them. Locked
   *  fields are skipped here as well as in the backend. */
  update: (patch: Partial<WtSettings>) => Promise<boolean>;
  isLocked: (field: string) => boolean;
}

export const useWtStore = create<WtStore>()((set, get) => ({
  view: null,
  error: null,

  load: async () => {
    try {
      const view = await commands.wtGetSettings();
      set({ view, error: null });
      return view;
    } catch (e) {
      set({ error: String(e) });
      return null;
    }
  },

  update: async (patch) => {
    const current = get().view ?? (await get().load());
    if (!current) return false;
    const locked = new Set(current.locked);
    const allowed = Object.fromEntries(
      Object.entries(patch).filter(([field]) => !locked.has(field)),
    ) as Partial<WtSettings>;
    const next: WtSettings = { ...current.settings, ...allowed };
    // Optimistic: the control moves at once; the backend's answer wins.
    set({ view: { ...current, settings: next } });
    try {
      const result = await commands.wtUpdateSettings(next);
      if (result.status === "ok") {
        set({ view: result.data, error: null });
        return true;
      }
      set({ view: current, error: result.error });
      return false;
    } catch (e) {
      set({ view: current, error: String(e) });
      return false;
    }
  },

  isLocked: (field) => !!get().view?.locked.includes(field),
}));

export function useWtSettings(): WtSettings | null {
  return useWtStore((s) => s.view?.settings ?? null);
}

export function useLocked(field: string | undefined): boolean {
  return useWtStore((s) => !!field && !!s.view?.locked.includes(field));
}
