// The speech model in the background (DESK-11, DESK-31, run 2 Phase 3): the
// backend starts downloading Edda at the very first launch; this follows it
// with the model events, so every onboarding step and the main window can
// show a calm progress line. It starts the download itself only when nothing
// else did (an older backend, or "Prøv igen" after a failure), selects the
// model once it is on disk, measures its speed once and offers the fast model
// on a slow computer. Lives outside React so it carries on across steps.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { commands, type SpeedVerdict } from "@/bindings";
import { useModelStore } from "@/stores/modelStore";
import { EDDA_MODEL_ID, findFastModelId } from "../lib/helpers";
import type { DownloadProgress } from "../lib/types";

export type SetupPhase =
  | "idle"
  | "downloading"
  | "preparing"
  | "ready"
  | "failed";

interface ModelSetup {
  phase: SetupPhase;
  /** The model being set up (Edda, or the fast model once chosen). */
  modelId: string | null;
  /** 0 to 1 while downloading. */
  progress: number;
  verdict: SpeedVerdict | null;
  /** The user answered the fast-model offer. */
  offerAnswered: boolean;
  /** Follows the model from the first launch; safe to call many times.
   *  `onboarding`: run the DESK-31 speed check once the model is in place
   *  (onboarding offers the fast model on a slow computer), and start the
   *  download from here if nothing else did. After onboarding a missing
   *  Edda is the user's choice and is left alone. */
  watch: (opts?: { onboarding?: boolean }) => Promise<void>;
  retry: () => Promise<void>;
  useFastModel: () => Promise<void>;
  keepEdda: () => void;
}

/** How long to wait for the backend's own download before starting one. */
export const BACKEND_GRACE_MS = 4000;

let listening = false;
let watching = false;
let measure = false;
const done = new Set<string>();
/** Models to select as soon as they are on disk, whatever is selected now. */
const selectWhenReady = new Set<string>();

async function models() {
  const store = useModelStore.getState();
  await store.loadModels();
  return useModelStore.getState().models;
}

export const useModelSetup = create<ModelSetup>()((set, get) => {
  async function onDownloaded(id: string) {
    if (done.has(id)) return;
    done.add(id);
    set({ phase: "preparing", modelId: id, progress: 1 });
    const store = useModelStore.getState();
    await store.loadModels();
    let current = "";
    try {
      const r = await commands.getCurrentModel();
      current = r.status === "ok" ? r.data : "";
    } catch {
      current = "";
    }
    if (selectWhenReady.has(id) || !current) {
      selectWhenReady.delete(id);
      await store.selectModel(id);
    }
    // DESK-31: measure Edda once, after it is in place.
    if (id === EDDA_MODEL_ID && measure && !get().verdict) {
      try {
        const r = await commands.wtMeasureSpeed();
        if (r.status === "ok") set({ verdict: r.data });
      } catch (e) {
        console.warn("Speed check failed:", e);
      }
    }
    set({ phase: "ready" });
  }

  /** Starts a download from here (nothing else is downloading it). */
  async function download(id: string) {
    set({ phase: "downloading", modelId: id, progress: 0 });
    const store = useModelStore.getState();
    if (store.downloadingModels[id]) return;
    const ok = await store.downloadModel(id);
    if (ok) await onDownloaded(id);
    else if (get().modelId === id && !done.has(id)) set({ phase: "failed" });
  }

  function listenOnce() {
    if (listening) return;
    listening = true;
    void listen<DownloadProgress>("model-download-progress", (e) => {
      const p = e.payload;
      const id = get().modelId ?? EDDA_MODEL_ID;
      if (p.model_id !== id || done.has(id)) return;
      const ratio = p.total > 0 ? p.downloaded / p.total : p.percentage / 100;
      set({
        phase: "downloading",
        modelId: id,
        progress: Math.max(0, Math.min(1, ratio)),
      });
    });
    void listen<string>("model-download-complete", (e) => {
      if (e.payload === (get().modelId ?? EDDA_MODEL_ID))
        void onDownloaded(e.payload);
    });
    void listen<{ model_id: string }>("model-download-failed", (e) => {
      if (
        e.payload.model_id === (get().modelId ?? EDDA_MODEL_ID) &&
        !done.has(e.payload.model_id)
      ) {
        set({ phase: "failed" });
      }
    });
  }

  return {
    phase: "idle",
    modelId: null,
    progress: 0,
    verdict: null,
    offerAnswered: false,

    watch: async (opts) => {
      const onboarding = !!opts?.onboarding;
      if (onboarding) measure = true;
      if (watching) return;
      watching = true;
      listenOnce();
      set({ modelId: get().modelId ?? EDDA_MODEL_ID });
      const edda = (await models()).find((m) => m.id === EDDA_MODEL_ID);
      if (!edda) {
        set({ phase: "failed" });
        return;
      }
      if (edda.is_downloaded) {
        await onDownloaded(EDDA_MODEL_ID);
        return;
      }
      if (edda.is_downloading) {
        const ratio =
          edda.size_mb > 0
            ? edda.partial_size / (edda.size_mb * 1024 * 1024)
            : 0;
        if (get().phase === "idle")
          set({
            phase: "downloading",
            progress: Math.max(0, Math.min(1, ratio)),
          });
        return;
      }
      // Nothing is downloading it yet: give the backend a moment, then start
      // it from here so a new user is never left without a model.
      if (!onboarding) return;
      if (get().phase === "idle") set({ phase: "preparing" });
      setTimeout(() => {
        void (async () => {
          if (get().phase === "downloading" || done.has(EDDA_MODEL_ID)) return;
          const again = (await models()).find((m) => m.id === EDDA_MODEL_ID);
          if (again?.is_downloaded) await onDownloaded(EDDA_MODEL_ID);
          else if (again?.is_downloading) set({ phase: "downloading" });
          else await download(EDDA_MODEL_ID);
        })();
      }, BACKEND_GRACE_MS);
    },

    retry: async () => {
      const id = get().modelId ?? EDDA_MODEL_ID;
      done.delete(id);
      await download(id);
    },

    useFastModel: async () => {
      set({ offerAnswered: true });
      const list = await models();
      const id = findFastModelId(list);
      if (!id) return;
      selectWhenReady.add(id);
      const info = list.find((m) => m.id === id);
      if (info?.is_downloaded) await onDownloaded(id);
      else await download(id);
    },

    keepEdda: () => set({ offerAnswered: true }),
  };
});
