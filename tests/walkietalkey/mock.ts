// A mocked Tauri backend for the Vite dev server, so the WalkieTalkey screens
// run in plain Chromium. `installMock` injects it before any app code runs;
// tests drive it through `window.__WT_MOCK__` (emit events, read calls).
import type { Page } from "@playwright/test";

export const EDDA = "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf";
export const EKKO_TINY =
  "walkietalkey/ekko-v1-tiny-gguf/ekko-v1-tiny-Q8_0.gguf";

export interface MockOptions {
  platform?: "macos" | "windows";
  /** Overrides for the desktop core's AppSettings. */
  app?: Record<string, unknown>;
  /** Overrides for WtSettings. */
  wt?: Record<string, unknown>;
  locked?: string[];
  managedApiKey?: boolean;
  /** Ids of models already on disk. */
  downloaded?: string[];
  /** Custom model files in the models folder (a workbench fine-tune): id and name. */
  customModels?: { id: string; name: string }[];
  /** Run 6: the app runs from its disk image (wt_runs_from_disk_image). */
  fromDiskImage?: boolean;
  /** DESK-114: wt_move_to_applications fails with this. Without it the move
   *  succeeds and, as the real app quits then, never answers. */
  moveError?: { kind: "not_writable" } | { kind: "failed"; message: string };
  /** Run 6: the workbench's sidecars for versions of Edda, by model id. */
  versions?: Record<
    string,
    {
      version?: number;
      created?: string;
      validation_wer?: number;
      run?: string;
    }
  >;
  /** download_model fails with this message. */
  downloadError?: string | null;
  /** The backend started the Edda download at launch (Phase 3). Default
   *  true while Edda is not on disk; false makes the screens fall back to
   *  starting it themselves. */
  backendDownloading?: boolean;
  speed?: { seconds: number; offer_fast_model: boolean; reason: string | null };
  /** macOS permissions: accessibility, microphone, input_monitoring. */
  permissions?: Record<string, boolean>;
  /** Requests leave the permission as it was. */
  denyRequests?: boolean;
  /** The microphone was answered before (run 5): macOS asks no more, only
   *  System Settings can change it. */
  micAnswered?: "denied" | "restricted";
  notification?: string;
  relay?: {
    enabled: boolean;
    connected: boolean;
    phones: {
      id: string;
      name: string;
      platform: string | null;
      online: boolean;
      last_seen_day?: number | null;
    }[];
    pairing_active: boolean;
    /** Phones paired before v0.2.0 must pair again (run 5). */
    pair_again?: boolean;
  };
  pairingExpiresInMs?: number;
  /** wt_mic_check_status (DESK-59): the silent-microphone notice. */
  micCheck?: {
    silent_input: string | null;
    suggestion: string | null;
    probing: boolean;
  };
  history?: unknown[];
  keys?: string[];
  appleIntelligence?: boolean;
  /** Dictation is paused when the window opens. */
  paused?: boolean;
  /** Ekko PnC's state (wt_punctuation_status). */
  punctuation?: { state: string; message?: string };
  /** The webview label (main or recording_overlay). */
  window?: string;
  /** The pairing QR (an SVG document). */
  qrSvg?: string;
  /** wt_globe_key_status (macOS Globe key, Phase 1). */
  globeKey?: { fn_is_key: boolean; usage: number | null; needs_fix: boolean };
  /** wt_key_listener_status (DESK-13, DESK-17). Default: it runs once
   *  Accessibility is granted (always on Windows), like the backend. */
  keyListener?: { running: boolean };
}

export async function installMock(page: Page, options: MockOptions = {}) {
  await page.addInitScript(mockBackend, options);
}

/** Emits a backend event once the app listens to it. */
export async function emit(page: Page, event: string, payload?: unknown) {
  await page.waitForFunction(
    (e) => (window as any).__WT_MOCK__.listenerCount(e) > 0,
    event,
  );
  await page.evaluate(([e, p]) => (window as any).__WT_MOCK__.emit(e, p), [
    event,
    payload,
  ] as const);
}

export interface Call {
  cmd: string;
  args: any;
}

export async function calls(page: Page, cmd?: string): Promise<Call[]> {
  const all: Call[] = await page.evaluate(
    () => (window as any).__WT_MOCK__.calls,
  );
  return cmd ? all.filter((c) => c.cmd === cmd) : all;
}

export async function mockState(page: Page): Promise<any> {
  return page.evaluate(() => (window as any).__WT_MOCK__.state);
}

/* Runs in the browser. Self-contained: no imports, no closures. */
function mockBackend(options: MockOptions) {
  const w = window as any;
  const STORE = "__wt_mock_state__";
  const platform = options.platform ?? "macos";
  const edda = "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf";
  const ekko = "walkietalkey/ekko-v1-tiny-gguf/ekko-v1-tiny-Q8_0.gguf";

  const defaultBinding = platform === "windows" ? "ctrl_right" : "fn";
  const freshState = () => ({
    app: Object.assign(
      {
        bindings: {
          transcribe: {
            id: "transcribe",
            name: "Transcribe",
            description: "",
            default_binding: defaultBinding,
            current_binding: defaultBinding,
          },
        },
        shortcut_activation: "hold_or_toggle",
        hold_threshold_ms: 500,
        audio_feedback: true,
        autostart_enabled: false,
        selected_model: "",
        onboarding_completed: false,
        overlay_position: "bottom",
        overlay_style: "minimal",
        custom_words: [],
        model_unload_timeout: "never",
        app_language: "da",
        keyboard_implementation: "handy_keys",
        paste_delay_ms: 60,
        paste_delay_after_ms: 60,
        debug_mode: false,
        log_level: "info",
        theme: "system",
        post_process_providers: [],
        post_process_models: {},
      },
      options.app ?? {},
    ),
    wt: Object.assign(
      {
        output_mode: "paste",
        punctuation: "automatic",
        share_clipboard_with_devices: false,
        show_text_in_notifications: true,
        pill_hidden: false,
        pill_for_phone: true,
        replacements: [],
        developer_words: false,
        vocabulary_source: null,
        cleanup_mode: "off",
        cleanup_provider: null,
        cleanup_model: null,
        cleanup_base_url: null,
        cleanup_consented: [],
        allow_cloud_cleanup: true,
        relay_url: "wss://relay.example",
        phone_app_url: "https://app.example",
        allow_phone_pairing: true,
        model_base_url: null,
        history_retention: "two_weeks",
        keep_audio_for_debugging: false,
        auto_update: true,
        update_channel: "stable",
        onboarding_resume_step: null,
        phone_offer_pending: false,
      },
      options.wt ?? {},
    ),
    locked: options.locked ?? [],
    downloaded: options.downloaded ?? [],
    permissions: Object.assign(
      { accessibility: false, microphone: false, input_monitoring: false },
      options.permissions ?? {},
    ),
    notification: options.notification ?? "not_determined",
    micCheck: options.micCheck ?? {
      silent_input: null,
      suggestion: null,
      probing: false,
    },
    relay: Object.assign(
      {
        enabled: true,
        connected: true,
        phones: [],
        pairing_active: false,
        pair_again: false,
      },
      options.relay ?? {},
    ),
    micAsked: false,
    history: options.history ?? [],
    keys: options.keys ?? [],
    restarts: 0,
    globeKey: options.globeKey ?? {
      fn_is_key: platform === "macos",
      usage: 0,
      needs_fix: false,
    },
  });

  let state: any;
  try {
    const saved = sessionStorage.getItem(STORE);
    state = saved ? JSON.parse(saved) : freshState();
  } catch {
    state = freshState();
  }

  /** wt_microphone_access (run 5): the three answers macOS knows. */
  const micAccess = () =>
    state.permissions.microphone
      ? "granted"
      : (options.micAnswered ?? (state.micAsked ? "denied" : "not_determined"));

  const calls: { cmd: string; args: any }[] = [];
  const callbacks = new Map<number, (data: any) => void>();
  const listeners = new Map<string, number[]>();
  let nextId = 1;

  const model = (id: string, name: string, size: number, extra: any = {}) => ({
    id,
    name,
    description: "",
    filename: id.split("/").pop(),
    source: "Local",
    size_mb: size,
    is_downloaded: state.downloaded.includes(id),
    is_downloading:
      id === edda &&
      !state.downloaded.includes(id) &&
      (options.backendDownloading ?? true),
    partial_size: 0,
    accuracy_score: 0.9,
    speed_score: 0.5,
    supports_translation: false,
    is_recommended: id === edda,
    supported_languages: ["da"],
    supports_language_selection: false,
    is_custom: false,
    supports_streaming: false,
    supports_language_detection: false,
    ...extra,
  });
  const models = () => [
    model(edda, "Edda v0.2", 886),
    model(ekko, "Ekko v1 Tiny", 134),
    model("whisper-small", "Whisper Small", 487),
    ...(options.customModels ?? []).map((c) =>
      model(c.id, c.name, 886, {
        filename: `${c.id}.gguf`,
        is_downloaded: true,
        is_custom: true,
        is_recommended: false,
        accuracy_score: 0,
        speed_score: 0,
      }),
    ),
  ];

  function emit(event: string, payload?: unknown) {
    for (const id of listeners.get(event) ?? []) {
      const cb = callbacks.get(id);
      if (cb) cb({ event, id, payload });
    }
  }

  const pendingDownloads = new Map<string, () => void>();

  function finishDownload(id: string) {
    if (!state.downloaded.includes(id)) state.downloaded.push(id);
    emit("model-download-progress", {
      model_id: id,
      downloaded: 100,
      total: 100,
      percentage: 100,
    });
    emit("model-download-complete", id);
    const done = pendingDownloads.get(id);
    pendingDownloads.delete(id);
    done?.();
  }

  function view() {
    return {
      settings: state.wt,
      locked: state.locked,
      managed_api_key: !!options.managedApiKey,
    };
  }

  const handlers: Record<string, (args: any) => any> = {
    // Desktop core settings
    get_app_settings: () => state.app,
    get_default_settings: () => state.app,
    change_autostart_setting: (a) => (state.app.autostart_enabled = a.enabled),
    change_audio_feedback_setting: (a) =>
      (state.app.audio_feedback = a.enabled),
    change_overlay_position_setting: (a) =>
      (state.app.overlay_position = a.position),
    change_overlay_style_setting: (a) => (state.app.overlay_style = a.style),
    change_app_language_setting: (a) => (state.app.app_language = a.language),
    change_shortcut_activation_setting: (a) =>
      (state.app.shortcut_activation = a.activation ?? a.value),
    update_custom_words: (a) => (state.app.custom_words = a.words),
    set_model_unload_timeout: (a) =>
      (state.app.model_unload_timeout = a.timeout),
    change_debug_mode_setting: (a) => (state.app.debug_mode = a.enabled),
    change_binding: (a) => {
      state.app.bindings[a.id].current_binding = a.binding;
      return { success: true, binding: state.app.bindings[a.id], error: null };
    },
    reset_binding: (a) => {
      const b = state.app.bindings[a.id];
      b.current_binding = b.default_binding;
      return { success: true, binding: b, error: null };
    },
    is_update_checks_locked: () => false,
    is_portable: () => false,
    get_available_microphones: () => [],
    get_available_output_devices: () => [],
    check_custom_sounds: () => ({ start: false, stop: false }),
    get_secure_input_status: () => ({
      enabled: false,
      sustained: false,
      culprit_pid: null,
      culprit_name: null,
      fallback_active: false,
      covered_bindings: [],
      degraded_bindings: [],
      uncovered_bindings: [],
      recorder_blocked: false,
    }),
    get_windows_microphone_permission_status: () => ({
      supported: true,
      overall_access: state.permissions.microphone ? "allowed" : "unknown",
      device_access: "allowed",
      app_access: "allowed",
      desktop_app_access: "allowed",
    }),
    get_app_dir_path: () =>
      "/Users/test/Library/Application Support/WalkieTalkey",
    get_log_dir_path: () => "/Users/test/Library/Logs/WalkieTalkey",
    // Models
    get_available_models: () => models(),
    get_current_model: () => state.app.selected_model,
    get_model_load_status: () => ({
      is_loaded: true,
      current_model: state.app.selected_model,
    }),
    is_model_loading: () => false,
    get_retired_models: () => [],
    download_model: (a) => {
      if (options.downloadError) {
        setTimeout(
          () =>
            emit("model-download-failed", {
              model_id: a.modelId,
              error: options.downloadError,
            }),
          10,
        );
        throw options.downloadError;
      }
      setTimeout(
        () =>
          emit("model-download-progress", {
            model_id: a.modelId,
            downloaded: 40,
            total: 100,
            percentage: 40,
          }),
        10,
      );
      return new Promise<null>((resolve) =>
        pendingDownloads.set(a.modelId, () => resolve(null)),
      );
    },
    cancel_download: () => null,
    wt_runs_from_disk_image: () => options.fromDiskImage ?? false,
    wt_move_to_applications: () => {
      if (options.moveError) throw options.moveError;
      // The real app quits here and opens again from Programmer.
      return new Promise(() => {});
    },
    // Run 6: the base Edda and the installed versions of it (versions.rs).
    wt_model_versions: () => {
      const all = models();
      const row = (m: any, base: boolean) => {
        const side = options.versions?.[m.id] ?? {};
        return {
          id: m.id,
          name: m.name,
          version: base ? null : (side.version ?? null),
          base,
          selected: state.app.selected_model === m.id,
          created: side.created ?? null,
          run: side.run ?? null,
          validation_wer: side.validation_wer ?? null,
        };
      };
      return [
        row(
          all.find((m: any) => m.id === edda),
          true,
        ),
        ...all
          .filter((m: any) => m.id.startsWith("edda-ft-") && m.is_downloaded)
          .map((m: any) => row(m, false))
          .sort((a: any, b: any) => (a.version ?? 1e9) - (b.version ?? 1e9)),
      ];
    },
    delete_model: (a) => {
      state.downloaded = state.downloaded.filter(
        (id: string) => id !== a.modelId,
      );
      return null;
    },
    set_active_model: (a) => {
      state.app.selected_model = a.modelId;
      state.app.onboarding_completed = true;
      return null;
    },
    // WalkieTalkey
    wt_get_settings: () => view(),
    wt_update_settings: (a) => {
      const next = { ...a.settings };
      for (const field of state.locked) {
        if (field in state.wt) next[field] = state.wt[field];
      }
      state.wt = next;
      return view();
    },
    wt_import_model_file: () => {
      if (!state.downloaded.includes(edda)) state.downloaded.push(edda);
      if (!state.app.selected_model) state.app.selected_model = edda;
      setTimeout(() => emit("model-download-complete", edda), 0);
      return edda;
    },
    wt_measure_speed: () =>
      options.speed ?? { seconds: 0.8, offer_fast_model: false, reason: null },
    wt_notification_permission: () => state.notification,
    wt_request_notification_permission: () => {
      if (!options.denyRequests) state.notification = "granted";
      return state.notification === "granted";
    },
    wt_pairing_start: () => ({
      qr_svg:
        options.qrSvg ??
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
      expires_at_ms: Date.now() + (options.pairingExpiresInMs ?? 600_000),
    }),
    wt_pairing_cancel: () => null,
    wt_relay_status: () => state.relay,
    wt_phone_remove: (a) => {
      state.relay.phones = state.relay.phones.filter((p: any) => p.id !== a.id);
      return null;
    },
    wt_set_cleanup_key: (a) => {
      state.keys = state.keys.filter((k: string) => k !== a.provider);
      if (a.key) state.keys.push(a.provider);
      return null;
    },
    wt_has_cleanup_key: (a) => state.keys.includes(a.provider),
    wt_history_list: (a) => {
      const q = (a.query ?? "").toLowerCase();
      return state.history.filter(
        (h: any) => !q || h.text.toLowerCase().includes(q),
      );
    },
    wt_history_delete: (a) => {
      const before = state.history.length;
      state.history =
        a.id == null ? [] : state.history.filter((h: any) => h.id !== a.id);
      return before - state.history.length;
    },
    wt_history_copy: () => null,
    wt_is_paused: () => options.paused ?? false,
    wt_punctuation_status: () => options.punctuation ?? { state: "ready" },
    wt_punctuation_download: () => {
      setTimeout(
        () => emit("wt-punctuation-status", { state: "downloading" }),
        0,
      );
      return null;
    },
    wt_set_paused: (a) => {
      setTimeout(() => emit("wt-paused", a.paused), 0);
      return null;
    },
    wt_check_updates: () => {
      setTimeout(() => emit("wt-update-status", { state: "checking" }), 0);
      setTimeout(() => emit("wt-update-status", { state: "up_to_date" }), 20);
      return null;
    },
    wt_key_listener_status: () =>
      options.keyListener ?? {
        running: platform !== "macos" || !!state.permissions.accessibility,
      },
    wt_accessibility_lost: () => false,
    // Resets the app's own entry and shows macOS's dialog; trusted only once
    // the user switches it on (the tests do that with the permissions).
    wt_accessibility_repair: () => !!state.permissions.accessibility,
    wt_microphone_access: () => micAccess(),
    wt_globe_key_status: () => state.globeKey,
    wt_globe_key_fix: () => {
      state.globeKey = { ...state.globeKey, usage: 0, needs_fix: false };
      return state.globeKey;
    },
    // DESK-59: the silent microphone. "Brug {navn}" switches and the notice
    // goes; "Tjek igen" starts a probe, whose answer the tests emit.
    wt_mic_check_status: () => state.micCheck,
    wt_mic_use: (a) => {
      state.app.selected_microphone = a.name;
      state.micCheck = { silent_input: null, suggestion: null, probing: false };
      setTimeout(() => emit("wt-mic-check", state.micCheck), 0);
      return null;
    },
    wt_mic_recheck: () => {
      state.micCheck = { ...state.micCheck, suggestion: null, probing: true };
      setTimeout(() => emit("wt-mic-check", state.micCheck), 0);
      return null;
    },
    check_apple_intelligence_available: () => options.appleIntelligence ?? true,
    fetch_post_process_models: () => [],
    // Plugins
    "plugin:app|version": () => "0.1.0",
    "plugin:app|name": () => "WalkieTalkey",
    "plugin:process|restart": () => {
      state.restarts += 1;
      sessionStorage.setItem(STORE, JSON.stringify(state));
      setTimeout(() => location.reload(), 0);
      return new Promise(() => {});
    },
    "plugin:dialog|open": () => "/Users/test/Downloads/edda-v0.2-Q8_0.gguf",
    "plugin:dialog|save": () => "/Users/test/Downloads/ordliste.txt",
    "plugin:opener|open_url": () => null,
    "plugin:opener|open_path": () => null,
    "plugin:fs|write_text_file": () => null,
    "plugin:fs|read_text_file": () => "",
    "plugin:macos-permissions|check_accessibility_permission": () =>
      state.permissions.accessibility,
    "plugin:macos-permissions|check_microphone_permission": () =>
      state.permissions.microphone,
    "plugin:macos-permissions|check_input_monitoring_permission": () =>
      state.permissions.input_monitoring,
    "plugin:macos-permissions|request_accessibility_permission": () => {
      if (!options.denyRequests) state.permissions.accessibility = true;
      return null;
    },
    "plugin:macos-permissions|request_microphone_permission": () => {
      // macOS asks only once (run 5): an answered question shows nothing.
      if (micAccess() !== "not_determined") return null;
      state.micAsked = true;
      if (!options.denyRequests) state.permissions.microphone = true;
      return null;
    },
    "plugin:macos-permissions|request_input_monitoring_permission": () => {
      if (!options.denyRequests) state.permissions.input_monitoring = true;
      return null;
    },
  };

  async function invoke(cmd: string, args: any = {}) {
    if (cmd === "plugin:event|listen") {
      const list = listeners.get(args.event) ?? [];
      list.push(args.handler);
      listeners.set(args.event, list);
      return args.handler;
    }
    if (cmd === "plugin:event|unlisten") {
      const list = listeners.get(args.event) ?? [];
      listeners.set(
        args.event,
        list.filter((id) => id !== args.eventId),
      );
      return null;
    }
    if (cmd === "plugin:event|emit") {
      emit(args.event, args.payload);
      return null;
    }
    calls.push({ cmd, args: JSON.parse(JSON.stringify(args ?? {})) });
    const handler = handlers[cmd];
    if (!handler) return null;
    const result = handler(args ?? {});
    return result === undefined ? null : result;
  }

  w.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(cb: (data: any) => void, once = false) {
      const id = nextId++;
      callbacks.set(id, (data) => {
        if (once) callbacks.delete(id);
        cb(data);
      });
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc: (path: string) => path,
    metadata: {
      currentWindow: { label: options.window ?? "main" },
      currentWebview: {
        windowLabel: options.window ?? "main",
        label: options.window ?? "main",
      },
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(_event: string, id: number) {
      callbacks.delete(id);
    },
  };
  w.__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform,
    os_type: platform,
    family: platform === "windows" ? "windows" : "unix",
    version: "15.0",
    arch: "aarch64",
    eol: "\n",
    exe_extension: platform === "windows" ? "exe" : "",
  };
  w.__WT_MOCK__ = {
    calls,
    get state() {
      return state;
    },
    emit,
    finishDownload,
    listenerCount: (event: string) => (listeners.get(event) ?? []).length,
  };
}
