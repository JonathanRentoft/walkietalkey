// The recorder page: one sentence at a time, the chosen Mac input recorded raw (no echo
// cancellation, noise suppression or automatic gain, like the app's microphone path). A take is
// sent to the local server (wt_train/recorder/server.py) as float32 mono at the input's rate;
// the server trims, resamples to 16 kHz and saves it. Nothing goes anywhere else.

// Below -60 dBFS for this long while recording counts as "no sound from the input".
const FLOOR = 0.001;
const SILENCE_MS = 1500;
const MIN_TAKE_S = 0.3;
const DEVICE_KEY = "wt-recorder-device";
const ADVANCE_KEY = "wt-recorder-advance";

const $ = (id) => document.getElementById(id);
const ui = {
  progress: $("progress"),
  device: $("device"),
  level: $("level"),
  peak: $("peak"),
  db: $("db"),
  warning: $("warning"),
  sid: $("sid"),
  badge: $("badge"),
  sentence: $("sentence"),
  record: $("record"),
  redo: $("redo"),
  play: $("play"),
  prev: $("prev"),
  next: $("next"),
  message: $("message"),
  advance: $("advance"),
};

const state = {
  sentences: [],
  index: 0,
  recorded: 0,
  total: 0,
  lastSaved: null,
  stream: null,
  deviceId: "",
  ctx: null,
  node: null,
  source: null,
  recording: false,
  saving: false,
  chunks: [],
  recordStart: 0,
  lastBlockAt: 0,
  lastNonZeroAt: 0,
  lastSoundAt: 0,
  rms: 0,
  peak: 0,
  player: null,
};

// Per-browser conveniences; the page works without them.
function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window or blocked storage */
  }
}
function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

const number = (n) => n.toLocaleString("da-DK");
const seconds = (s) =>
  s.toLocaleString("da-DK", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  });
const current = () => state.sentences[state.index];
const hasTake = (s) => s && s.status !== "missing";

// Rendering ----------------------------------------------------------------

const BADGES = {
  recorded: "Indtalt",
  missing: "Mangler",
  stale: "Teksten er ændret, optag igen",
};

function render() {
  const s = current();
  ui.progress.textContent = `${number(state.recorded)} af ${number(state.total)} indtalt`;
  if (!s) {
    ui.sentence.textContent = "Der er ingen sætninger i listen.";
    return;
  }
  ui.sid.textContent = `${s.id} · ${number(state.index + 1)} af ${number(state.total)}`;
  ui.badge.textContent = BADGES[s.status];
  ui.badge.className = s.status;
  ui.sentence.textContent = s.text;
  const busy = state.recording || state.saving;
  ui.record.textContent = state.recording ? "Stop" : "Optag";
  ui.record.disabled = state.saving || !state.node;
  ui.redo.disabled = busy || !state.node;
  ui.play.disabled = busy || !(hasTake(s) || state.lastSaved);
  ui.prev.disabled = busy || state.index === 0;
  ui.next.disabled = busy || state.index >= state.total - 1;
  document.body.classList.toggle("recording", state.recording);
}

function say(text, kind = "") {
  ui.message.textContent = text;
  ui.message.className = kind;
}

function warn(text) {
  if (text) {
    ui.warning.textContent = text;
    ui.warning.hidden = false;
  } else {
    ui.warning.hidden = true;
  }
}

function go(index, { keepMessage = false } = {}) {
  if (state.recording || state.saving) return;
  state.index = Math.max(0, Math.min(state.total - 1, index));
  if (!keepMessage) say("");
  render();
}

// Microphone -----------------------------------------------------------------

function deviceLabel(id) {
  const option = [...ui.device.options].find((o) => o.value === id);
  return option ? option.textContent : "Mikrofonen";
}

function otherDevice() {
  const option = [...ui.device.options].find(
    (o) =>
      o.value !== state.deviceId &&
      o.value !== "default" &&
      o.value !== "communications",
  );
  return option
    ? ` Prøv en anden i listen, for eksempel ${option.textContent}.`
    : " Prøv en anden i listen.";
}

async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs = all.filter((d) => d.kind === "audioinput");
  ui.device.replaceChildren(
    ...inputs.map((d, i) => {
      const option = document.createElement("option");
      option.value = d.deviceId;
      option.textContent = d.label || `Mikrofon ${i + 1}`;
      return option;
    }),
  );
  if (inputs.some((d) => d.deviceId === state.deviceId))
    ui.device.value = state.deviceId;
}

function closeInput() {
  if (state.source) state.source.disconnect();
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.source = null;
  state.stream = null;
}

async function openInput(deviceId) {
  closeInput();
  const audio = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };
  const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
  if (supported.voiceIsolation) audio.voiceIsolation = false;
  if (deviceId) audio.deviceId = { exact: deviceId };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (e) {
    if (
      deviceId &&
      (e.name === "OverconstrainedError" || e.name === "NotFoundError")
    ) {
      say(
        "Den gemte mikrofon findes ikke længere, så standardmikrofonen bruges.",
        "warn",
      );
      return openInput(null);
    }
    if (e.name === "NotAllowedError") {
      warn(
        "Siden har ikke adgang til mikrofonen. Giv adgang i browseren, og genindlæs siden.",
      );
    } else {
      warn(`Mikrofonen kunne ikke åbnes (${e.name}).${otherDevice()}`);
    }
    render();
    return;
  }
  state.stream = stream;
  const track = stream.getAudioTracks()[0];
  state.deviceId = track.getSettings().deviceId || deviceId || "";
  track.addEventListener("ended", () =>
    warn(`Forbindelsen til mikrofonen blev afbrudt.${otherDevice()}`),
  );

  if (!state.ctx) {
    state.ctx = new AudioContext();
    await state.ctx.audioWorklet.addModule("/capture-worklet.js");
    state.node = new AudioWorkletNode(state.ctx, "capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
    });
    state.node.port.onmessage = (e) => onBlock(e.data);
    state.node.connect(state.ctx.destination);
  }
  state.source = state.ctx.createMediaStreamSource(stream);
  state.source.connect(state.node);
  // A fresh input gets the full grace period before it counts as silent.
  const now = performance.now();
  state.lastBlockAt = state.lastNonZeroAt = state.lastSoundAt = now;
  await refreshDevices();
  warn("");
  if (state.ctx.state !== "running")
    say("Klik på siden, eller tryk på en tast, for at starte lyden.");
  render();
}

function onBlock(block) {
  let peak = 0;
  let sum = 0;
  let nonZero = false;
  for (let i = 0; i < block.length; i++) {
    const v = block[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (v !== 0) nonZero = true;
    sum += v * v;
  }
  const now = performance.now();
  state.lastBlockAt = now;
  if (nonZero) state.lastNonZeroAt = now;
  if (peak >= FLOOR) state.lastSoundAt = now;
  state.rms = Math.max(Math.sqrt(sum / block.length), state.rms * 0.8);
  state.peak = Math.max(peak, state.peak * 0.95);
  if (state.recording) state.chunks.push(block);
}

const dbfs = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

function drawMeter() {
  const width = (x) =>
    `${Math.max(0, Math.min(100, ((dbfs(x) + 60) / 60) * 100))}%`;
  ui.level.style.width = width(state.rms);
  ui.peak.style.left = width(state.peak);
  ui.level.classList.toggle("hot", state.peak >= 0.98);
  const db = dbfs(state.peak);
  ui.db.textContent = Number.isFinite(db) ? `${Math.round(db)} dB` : "-∞ dB";
  state.rms *= 0.9;
  state.peak *= 0.97;
  requestAnimationFrame(drawMeter);
}

function checkSilence() {
  if (!state.stream || !state.ctx || state.ctx.state !== "running") return;
  const now = performance.now();
  const name = deviceLabel(state.deviceId);
  const dead =
    now - state.lastBlockAt > SILENCE_MS ||
    now - state.lastNonZeroAt > SILENCE_MS;
  const quiet =
    state.recording &&
    now - Math.max(state.recordStart, state.lastSoundAt) > SILENCE_MS;
  if (dead) {
    warn(
      `${name} sender kun stilhed. Er der sat en mikrofon til, og er den tændt?${otherDevice()}`,
    );
  } else if (quiet) {
    warn(
      `Ingen lyd fra ${name}. Er der skruet op for indgangen?${otherDevice()}`,
    );
  } else {
    warn("");
  }
}

async function wake() {
  if (state.ctx && state.ctx.state === "suspended") {
    await state.ctx.resume();
    if (ui.message.textContent.startsWith("Klik på siden")) say("");
  }
}

// Takes ------------------------------------------------------------------------

async function startRecording() {
  if (state.recording || state.saving || !state.node || !current()) return;
  await wake();
  if (state.player) state.player.pause();
  state.chunks = [];
  state.recordStart = performance.now();
  state.recording = true;
  say("Optager. Tryk på mellemrum, når du er færdig.");
  render();
}

function cancelRecording() {
  if (!state.recording) return;
  state.recording = false;
  state.chunks = [];
  say("Optagelsen er annulleret.");
  render();
}

async function stopRecording() {
  if (!state.recording) return;
  state.recording = false;
  const chunks = state.chunks;
  state.chunks = [];
  const length = chunks.reduce((n, c) => n + c.length, 0);
  const rate = state.ctx.sampleRate;
  if (length / rate < MIN_TAKE_S) {
    say("Optagelsen var for kort og blev ikke gemt.", "warn");
    render();
    return;
  }
  const samples = new Float32Array(length);
  let at = 0;
  for (const c of chunks) {
    samples.set(c, at);
    at += c.length;
  }
  await upload(current(), samples, rate);
}

const WARNINGS = {
  clipping: "Lyden klipper. Skru ned for indgangsniveauet, og optag igen (R).",
  quiet:
    "Lyden er svag. Skru op for indgangsniveauet, eller tal tættere på mikrofonen.",
};

async function upload(sentence, samples, rate) {
  state.saving = true;
  say("Gemmer ...");
  render();
  let response;
  let result = {};
  try {
    response = await fetch(
      `/api/takes/${encodeURIComponent(sentence.id)}?rate=${rate}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-WT-Recorder": "1",
        },
        body: samples,
      },
    );
    result = await response.json();
  } catch {
    state.saving = false;
    say("Serveren svarer ikke. Kører wt-train record stadig?", "error");
    render();
    return;
  }
  state.saving = false;
  if (response.status === 422) {
    say(
      "Optagelsen er tavs og blev ikke gemt. Tjek mikrofonen, og prøv igen.",
      "error",
    );
    render();
    return;
  }
  if (!response.ok) {
    say(
      `Optagelsen kunne ikke gemmes: ${result.message || response.status}`,
      "error",
    );
    render();
    return;
  }
  sentence.status = result.status;
  state.recorded = result.recorded;
  state.lastSaved = sentence.id;
  const notes = result.warnings.map((w) => WARNINGS[w] || w);
  const saved = `${sentence.id} er gemt (${seconds(result.seconds)} s${result.replaced ? ", den gamle er gemt til side" : ""}).`;
  if (notes.length) {
    say(`${saved} ${notes.join(" ")}`, "warn");
    render();
    return;
  }
  say(saved);
  if (state.recorded === state.total)
    say(`${saved} Alle sætninger er indtalt. Tak!`);
  if (ui.advance.checked && state.index < state.total - 1)
    go(state.index + 1, { keepMessage: true });
  else render();
}

async function toggleRecording() {
  if (state.recording) await stopRecording();
  else await startRecording();
}

// R: record the current sentence again, or, right after a take moved on, the one just saved.
async function redo() {
  if (state.recording || state.saving) return;
  if (!hasTake(current()) && state.lastSaved) {
    go(state.sentences.findIndex((s) => s.id === state.lastSaved));
  }
  await startRecording();
}

function play() {
  if (state.recording || state.saving) return;
  const id = hasTake(current()) ? current().id : state.lastSaved;
  if (!id) {
    say("Der er ingen optagelse at afspille endnu.");
    return;
  }
  if (state.player) state.player.pause();
  state.player = new Audio(
    `/api/takes/${encodeURIComponent(id)}.wav?v=${Date.now()}`,
  );
  state.player
    .play()
    .catch(() => say("Optagelsen kunne ikke afspilles.", "error"));
  say(`Afspiller ${id}.`);
}

// Wiring -------------------------------------------------------------------------

function onButton(button, action) {
  button.addEventListener("click", async () => {
    button.blur(); // so the space bar does not press it again
    await wake();
    await action();
  });
}

onButton(ui.record, toggleRecording);
onButton(ui.redo, redo);
onButton(ui.play, play);
onButton(ui.prev, () => go(state.index - 1));
onButton(ui.next, () => go(state.index + 1));

document.addEventListener("keydown", async (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target === ui.device) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.code === "Space" || key === " ") {
    e.preventDefault();
    if (!e.repeat) await toggleRecording();
  } else if (key === "r" && !e.repeat) {
    await redo();
  } else if (key === "p" && !e.repeat) {
    play();
  } else if (key === "ArrowRight") {
    e.preventDefault();
    go(state.index + 1);
  } else if (key === "ArrowLeft") {
    e.preventDefault();
    go(state.index - 1);
  } else if (key === "Escape") {
    cancelRecording();
  }
  await wake();
});
document.addEventListener("pointerdown", wake);

ui.device.addEventListener("change", async () => {
  remember(DEVICE_KEY, ui.device.value);
  ui.device.blur();
  await openInput(ui.device.value);
});
navigator.mediaDevices.addEventListener?.("devicechange", () =>
  refreshDevices().catch(() => {}),
);

ui.advance.checked = recall(ADVANCE_KEY) !== "0";
ui.advance.addEventListener("change", () =>
  remember(ADVANCE_KEY, ui.advance.checked ? "1" : "0"),
);

window.addEventListener("beforeunload", (e) => {
  if (state.recording || state.saving) e.preventDefault();
});

async function start() {
  try {
    const response = await fetch("/api/state");
    const data = await response.json();
    state.sentences = data.sentences;
    state.total = data.total;
    state.recorded = data.recorded;
    state.index = data.first_open ?? 0;
    if (data.first_open === null && data.total > 0)
      say("Alle sætninger er indtalt. Du kan stadig optage dem igen.");
  } catch {
    say("Sætningerne kunne ikke hentes. Kører wt-train record?", "error");
  }
  render();
  requestAnimationFrame(drawMeter);
  setInterval(checkSilence, 250);
  await openInput(recall(DEVICE_KEY));
}

start();
