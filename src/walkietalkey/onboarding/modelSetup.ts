// Onboarding step 2 (DESK-11, DESK-31): download Edda in the background,
// select it, measure its speed on the bundled clip, and offer the fast model
// when the computer is slow. Lives outside React so the download carries on
// while the user moves through the other steps.
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
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
  importError: boolean;
  start: () => Promise<void>;
  retry: () => Promise<void>;
  importFile: () => Promise<void>;
  useFastModel: () => Promise<void>;
  keepEdda: () => void;
}

let listening = false;
const done = new Set<string>();
/** Models to select as soon as they are on disk, whatever is selected now. */
const selectWhenReady = new Set<string>();

async function models() {
  const store = useModelStore.getState();
  if (!store.models.length) await store.loadModels();
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
    if (id === EDDA_MODEL_ID && !get().verdict) {
      try {
        const r = await commands.wtMeasureSpeed();
        if (r.status === "ok") set({ verdict: r.data });
      } catch (e) {
        console.warn("Speed check failed:", e);
      }
    }
    set({ phase: "ready" });
  }

  async function download(id: string) {
    set({ phase: "downloading", modelId: id, progress: 0, importError: false });
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
      if (p.model_id === get().modelId && get().phase === "downloading") {
        const ratio = p.total > 0 ? p.downloaded / p.total : p.percentage / 100;
        set({ progress: Math.max(0, Math.min(1, ratio)) });
      }
    });
    void listen<string>("model-download-complete", (e) => {
      if (e.payload === get().modelId) void onDownloaded(e.payload);
    });
    void listen<{ model_id: string }>("model-download-failed", (e) => {
      if (e.payload.model_id === get().modelId && !done.has(e.payload.model_id)) {
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
    importError: false,

    start: async () => {
      if (get().phase !== "idle") return;
      set({ phase: "preparing", modelId: EDDA_MODEL_ID });
      listenOnce();
      const edda = (await models()).find((m) => m.id === EDDA_MODEL_ID);
      if (edda?.is_downloaded) await onDownloaded(EDDA_MODEL_ID);
      else if (edda) await download(EDDA_MODEL_ID);
      else set({ phase: "failed" });
    },

    retry: async () => {
      const id = get().modelId ?? EDDA_MODEL_ID;
      done.delete(id);
      await download(id);
    },

    importFile: async () => {
      set({ importError: false });
      let path: string | string[] | null = null;
      try {
        path = await open({
          multiple: false,
          directory: false,
          filters: [{ name: "GGUF", extensions: ["gguf"] }],
        });
      } catch {
        path = null;
      }
      if (!path || Array.isArray(path)) return;
      listenOnce();
      try {
        const r = await commands.wtImportModelFile(path);
        if (r.status === "ok") {
          set({ modelId: r.data });
          await onDownloaded(r.data);
        } else {
          set({ importError: true });
        }
      } catch {
        set({ importError: true });
      }
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
