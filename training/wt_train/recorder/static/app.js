// The recorder page (wt-train record): the sentence to read, the progress per condition, the link
// to the WalkieTalkey app and the last take's check. For the pilot (wt-train pilot record) the
// same page reads the pilot sentences in one recording setup, says so and names the setup, and its
// table shows the setups instead of the conditions. The audio never passes this page: the app
// records it (on the phone through the pairing, or on the Mac's own input) and hands it to the
// local server (wt_train/recorder/server.py). The page only polls that server and asks it to move
// on, go back or start and stop a Mac take.
//
// Every Danish string below was approved by the owner in run 8.

const POLL_MS = 400;

const $ = (id) => document.getElementById(id);
const ui = {
  condition: $("condition"),
  progress: $("progress"),
  pilot: $("pilot"),
  linkText: $("link-text"),
  connect: $("connect"),
  conditions: document.querySelector("#conditions tbody"),
  sid: $("sid"),
  badge: $("badge"),
  sentence: $("sentence"),
  hint: $("hint"),
  last: $("last"),
  lastText: $("last-text"),
  record: $("record"),
  redo: $("redo"),
  play: $("play"),
  prev: $("prev"),
  next: $("next"),
  message: $("message"),
  keys: $("keys"),
};

let state = null;
let player = null;
let busy = false;

const number = (n) => n.toLocaleString("da-DK");
const seconds = (s) =>
  s.toLocaleString("da-DK", {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  });

const BADGES = {
  recorded: "Indtalt",
  missing: "Mangler",
  stale: "Teksten er ændret, optag igen",
};

// The check of the last take (wt_train/recorder/checks.py); the phone shows the same words.
const CHECKS = {
  ok: "Gemt.",
  quiet:
    "Optagelsen er svag. Tal lidt tættere på mikrofonen, og optag den igen.",
  clipped:
    "Lyden er for kraftig og forvrænget. Hold lidt mere afstand, og optag den igen.",
  short: "Optagelsen ser ud til at være skåret af. Optag den igen.",
  silent: "Hørte ikke noget. Optag den igen.",
  gaps: "Noget af lyden nåede ikke frem. Optag den igen.",
  error: "Optagelsen kunne ikke gemmes.",
};

// Run 7, the pilot.
function pilotNote(setup, mac) {
  const intro = `Det er en pilot: tolv sætninger med opsætningen ${setup}, så du kan høre, om lyden er god, før du indtaler i timevis. Optagelserne bruges kun til at sammenligne opsætningerne og aldrig til træning.`;
  return mac
    ? `${intro} Vælg mikrofonen i WalkieTalkey, før du optager.`
    : intro;
}

const LINK = {
  connecting: "Forbinder til WalkieTalkey på denne Mac",
  waiting: "Venter på WalkieTalkey på denne Mac",
  not_running:
    "WalkieTalkey kører ikke på denne Mac. Start appen, og tryk Forbind.",
  unsupported: "WalkieTalkey skal opdateres, før den kan optage til træning.",
  missing: "WalkieTalkey er ikke installeret på denne Mac.",
  no_phone:
    "Der er ingen telefon parret med WalkieTalkey. Par en telefon i appen, og tryk Forbind.",
  gone: "WalkieTalkey har lukket forbindelsen. Tryk Forbind for at fortsætte.",
  failed: "WalkieTalkey kunne ikke tage imod indtalingen.",
  lost: "Forbindelsen til WalkieTalkey er væk. Tryk Forbind for at fortsætte.",
};

function say(text, kind = "") {
  ui.message.textContent = text;
  ui.message.className = kind;
}

function current() {
  const s = state?.session;
  return s && s.index !== null ? s.items[s.index] : null;
}

function isMac() {
  return state?.session.condition.device === "mac";
}

function connected() {
  return !!state?.session.app.connected;
}

function linkLine() {
  const s = state.session;
  if (connected()) {
    if (isMac()) {
      const input = s.app.input ? `, mikrofon: ${s.app.input}` : "";
      return { text: `Forbundet til WalkieTalkey${input}.`, problem: false };
    }
    const phone = s.phone;
    if (phone && !phone.online)
      return {
        text: `${phone.name} er ikke online. Åbn WalkieTalkey på telefonen.`,
        problem: true,
      };
    return {
      text: `Forbundet. Sætningerne vises på ${phone ? phone.name : "telefonen"}.`,
      problem: false,
    };
  }
  const status = state.link.status;
  const wasConnected = status === "connected";
  return {
    text: (wasConnected ? LINK.lost : LINK[status]) || LINK.waiting,
    problem: !["connecting", "waiting"].includes(status) || wasConnected,
  };
}

function renderConditions() {
  const s = state.session;
  const currentRow = s.pilot ? s.pilot.setup : s.condition.id;
  const rows = state.conditions.map((c) => {
    const p = state.progress[c.id];
    const tr = document.createElement("tr");
    if (c.id === currentRow) tr.className = "current";
    const name = document.createElement("th");
    name.scope = "row";
    name.textContent = c.label;
    const sentences = document.createElement("td");
    sentences.textContent = p
      ? `${number(p.done)} af ${number(p.total)} sætninger`
      : "";
    const exam = document.createElement("td");
    // The pilot has no exam.
    exam.textContent =
      p && typeof p.exam_total === "number"
        ? `${number(p.exam_done)} af ${number(p.exam_total)} afsnit til eksamen`
        : "";
    tr.append(name, sentences, exam);
    return tr;
  });
  ui.conditions.replaceChildren(...rows);
}

function render() {
  if (!state) return;
  const s = state.session;
  const item = current();
  const mac = isMac();
  const whisper = s.condition.style === "whisper";
  ui.condition.textContent = s.pilot
    ? `· Pilot: ${s.pilot.setup} · ${s.condition.label}`
    : `· ${s.condition.label}${s.exam ? " · eksamen" : ""}`;
  ui.pilot.hidden = !s.pilot;
  ui.pilot.textContent = s.pilot ? pilotNote(s.pilot.setup, mac) : "";
  document.title = s.pilot ? `Pilot: ${s.pilot.setup}` : "Indtaling";
  ui.progress.textContent = `${number(s.done)} af ${number(s.total)} indtalt`;
  const link = linkLine();
  ui.linkText.textContent = link.text;
  ui.linkText.className = link.problem ? "problem" : "";
  ui.connect.hidden = connected() || !link.problem;
  renderConditions();

  if (item) {
    ui.sid.textContent = `${item.id} · ${number(s.index + 1)} af ${number(s.total)}`;
    ui.badge.textContent = BADGES[item.status];
    ui.badge.className = item.status;
    ui.sentence.textContent = item.text;
  } else {
    ui.sid.textContent = "";
    ui.badge.textContent = "";
    ui.sentence.textContent = !s.total
      ? "Der er intet at indtale her."
      : s.pilot
        ? `Piloten er indtalt med ${s.pilot.setup}. Tak. Sammenlign opsætningerne med wt-train pilot report.`
        : "Alle er indtalt i denne betingelse. Tak.";
  }
  const voice = whisper ? "Hvisk" : "Tal med almindelig stemme";
  const rec = s.recording;
  if (rec && rec.source === "phone")
    ui.hint.textContent = "Optager på telefonen";
  else if (rec && rec.stopping) ui.hint.textContent = "Gemmer ...";
  else if (rec)
    ui.hint.textContent = `Optager. ${voice}, og tryk mellemrum, når du er færdig.`;
  else if (mac) ui.hint.textContent = `${voice}. Tryk mellemrum for at optage.`;
  else
    ui.hint.textContent = `${voice} i telefonen. Hold knappen på telefonen nede, mens du læser.`;

  const last = s.last;
  ui.last.hidden = !last;
  if (last) {
    ui.lastText.textContent = `${last.prompt}: ${CHECKS[last.check] || CHECKS.error}`;
    ui.last.className = last.check === "ok" ? "ok" : "problem";
  }
  document.body.classList.toggle("recording", !!rec);
  ui.record.hidden = !mac;
  ui.record.textContent = rec ? "Stop" : "Optag";
  ui.record.disabled =
    busy || !connected() || (!rec && !item) || !!rec?.stopping;
  ui.redo.disabled = busy || !!rec || !last;
  ui.play.disabled =
    busy || !!rec || !(last?.saved || item?.status === "recorded");
  ui.prev.disabled = busy || !!rec || s.total === 0;
  ui.next.disabled = busy || !!rec || s.total === 0;
  ui.keys.textContent = mac
    ? "Mellemrum: optag og stop. Esc: annuller. R: optag forrige igen. P: afspil. Pile: forrige og næste."
    : "R: optag forrige igen. P: afspil. Pile: forrige og næste.";
}

async function poll() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    state = await response.json();
    if (ui.message.dataset.lost) say("");
    delete ui.message.dataset.lost;
  } catch {
    say("Serveren svarer ikke. Kører wt-train record stadig?", "error");
    ui.message.dataset.lost = "1";
  }
  render();
}

async function post(path) {
  busy = true;
  render();
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "X-WT-Recorder": "1" },
    });
    if (response.ok) state = await response.json();
  } catch {
    say("Serveren svarer ikke. Kører wt-train record stadig?", "error");
  } finally {
    busy = false;
    render();
  }
}

async function toggleMac() {
  if (!isMac() || busy) return;
  if (state.session.recording) await post("/api/mac/stop");
  else await post("/api/mac/start");
}

function play() {
  const s = state?.session;
  if (!s || s.recording) return;
  const id = s.last?.saved
    ? s.last.prompt
    : current()?.status === "recorded"
      ? current().id
      : null;
  if (!id) {
    say("Der er ingen optagelse at afspille endnu.");
    return;
  }
  if (player) player.pause();
  player = new Audio(
    `/api/takes/${encodeURIComponent(id)}.wav?v=${Date.now()}`,
  );
  player.play().catch(() => say("Optagelsen kunne ikke afspilles.", "error"));
  say(`Afspiller ${id}.`);
}

function onButton(button, action) {
  button.addEventListener("click", async () => {
    button.blur(); // so the space bar does not press it again
    await action();
  });
}

onButton(ui.record, toggleMac);
onButton(ui.redo, () => post("/api/redo"));
onButton(ui.play, play);
onButton(ui.prev, () => post("/api/prev"));
onButton(ui.next, () => post("/api/next"));
onButton(ui.connect, () => post("/api/connect"));

document.addEventListener("keydown", async (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (e.code === "Space" || key === " ") {
    e.preventDefault();
    await toggleMac();
  } else if (key === "r") {
    await post("/api/redo");
  } else if (key === "p") {
    play();
  } else if (key === "ArrowRight") {
    e.preventDefault();
    await post("/api/next");
  } else if (key === "ArrowLeft") {
    e.preventDefault();
    await post("/api/prev");
  } else if (key === "Escape") {
    await post("/api/mac/cancel");
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state?.session.recording) e.preventDefault();
});

poll();
setInterval(poll, POLL_MS);
