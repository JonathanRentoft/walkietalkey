import { describe, expect, it } from "vitest";
import {
  initialMachine,
  transition,
  type Effect,
  type MachineEvent,
  type MachineState,
  type Phase,
} from "../src/core/machine";

function run(
  state: MachineState,
  ...events: MachineEvent[]
): { state: MachineState; effects: Effect[] } {
  let s = state;
  const effects: Effect[] = [];
  for (const e of events) {
    const r = transition(s, e);
    s = r.state;
    effects.push(...r.effects);
  }
  return { state: s, effects };
}

const online = () =>
  initialMachine({ mode: "hold", peerOnline: true, connected: true });
const down = (sessionId = "s1", at = 1000): MachineEvent => ({
  type: "down",
  sessionId,
  at,
});
const up: MachineEvent = { type: "up" };

describe("hold to talk (PHONE-20, PHONE-21, PHONE-22, PHONE-26)", () => {
  it("starts idle", () => {
    expect(online().phase).toBe("idle");
  });

  it("idle -> rec on press: capture, haptic tick, wake lock", () => {
    const { state, effects } = run(online(), down());
    expect(state.phase).toBe("rec");
    expect(state.sessionId).toBe("s1");
    expect(state.recStartedAt).toBe(1000);
    expect(effects).toEqual([
      { type: "start_capture", sessionId: "s1" },
      { type: "haptic", kind: "start" },
      { type: "wake_lock", on: true },
    ]);
  });

  it("rec -> send on release while the computer is online", () => {
    const { state, effects } = run(online(), down(), up);
    expect(state.phase).toBe("send");
    expect(effects.slice(3)).toEqual([
      { type: "finish_capture", sessionId: "s1" },
      { type: "haptic", kind: "stop" },
      { type: "wake_lock", on: false },
    ]);
  });

  it("a second finger does not restart a recording", () => {
    const { state, effects } = run(online(), down("s1"), down("s2"));
    expect(state.sessionId).toBe("s1");
    expect(effects.filter((e) => e.type === "start_capture").length).toBe(1);
  });

  it("rec -> cancel when the finger slides off, and back to rec when it returns", () => {
    let r = run(online(), down(), { type: "slide", inside: false });
    expect(r.state.phase).toBe("cancel");
    r = run(r.state, { type: "slide", inside: false });
    expect(r.state.phase).toBe("cancel");
    r = run(r.state, { type: "slide", inside: true });
    expect(r.state.phase).toBe("rec");
  });

  it("cancel -> idle on release, sending audio_cancel", () => {
    const { state, effects } = run(
      online(),
      down(),
      { type: "slide", inside: false },
      up,
    );
    expect(state.phase).toBe("idle");
    expect(state.sessionId).toBeNull();
    expect(effects.slice(3)).toEqual([
      { type: "cancel_capture", sessionId: "s1" },
      { type: "haptic", kind: "stop" },
      { type: "wake_lock", on: false },
    ]);
  });

  it("ignores releases and slides when not recording", () => {
    for (const e of [up, { type: "slide", inside: false } as MachineEvent]) {
      const { state, effects } = run(online(), e);
      expect(state.phase).toBe("idle");
      expect(effects).toEqual([]);
    }
  });

  it("stops at the 5 minute limit and sends (PHONE-29)", () => {
    expect(run(online(), down(), { type: "max_duration" }).state.phase).toBe(
      "send",
    );
    expect(
      run(
        online(),
        down(),
        { type: "slide", inside: false },
        { type: "max_duration" },
      ).state.phase,
    ).toBe("send");
  });

  it("goes back to idle when nothing was captured", () => {
    expect(
      run(online(), down(), up, { type: "empty", sessionId: "s1" }).state.phase,
    ).toBe("idle");
  });
});

describe("tap to start and stop (PHONE-26 setting)", () => {
  const toggle = () =>
    initialMachine({ mode: "toggle", peerOnline: true, connected: true });

  it("first tap records, its release and slides do nothing, the second tap sends on release", () => {
    let r = run(toggle(), down("t1"));
    expect(r.state.phase).toBe("rec");
    expect(r.state.latched).toBe(true);
    r = run(r.state, up, { type: "slide", inside: false });
    expect(r.state.phase).toBe("rec");
    r = run(r.state, down("t2"));
    expect(r.state.phase).toBe("rec");
    expect(r.state.armed).toBe(true);
    r = run(r.state, up);
    expect(r.state.phase).toBe("send");
    expect(r.state.sessionId).toBe("t1");
    expect(r.state.latched).toBe(false);
    expect(r.effects).toContainEqual({
      type: "finish_capture",
      sessionId: "t1",
    });
  });

  it("sliding off during the second tap cancels", () => {
    const r = run(toggle(), down("t1"), up, down("t2"), {
      type: "slide",
      inside: false,
    });
    expect(r.state.phase).toBe("cancel");
    const after = run(r.state, up);
    expect(after.state.phase).toBe("idle");
    expect(after.effects).toContainEqual({
      type: "cancel_capture",
      sessionId: "t1",
    });
  });

  it("the cancel control cancels", () => {
    const r = run(toggle(), down("t1"), up, { type: "cancel" });
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toContainEqual({
      type: "cancel_capture",
      sessionId: "t1",
    });
    expect(run(online(), { type: "cancel" }).effects).toEqual([]);
  });

  it("the mode can be switched in settings", () => {
    const r = run(online(), { type: "mode", mode: "toggle" });
    expect(r.state.mode).toBe("toggle");
  });
});

describe("Start diktering from the iOS shell", () => {
  const shell = (sessionId = "x1"): MachineEvent => ({
    type: "shell_start",
    sessionId,
    at: 5,
  });

  it("starts a recording like a tap, with the start haptic, in hold mode too", () => {
    const { state, effects } = run(online(), shell());
    expect(state.phase).toBe("rec");
    expect(state.latched).toBe(true);
    expect(state.sessionId).toBe("x1");
    expect(effects).toEqual([
      { type: "start_capture", sessionId: "x1" },
      { type: "haptic", kind: "start" },
      { type: "wake_lock", on: true },
    ]);
  });

  it("a tap on the button sends it", () => {
    const r = run(online(), shell(), down("ignored"), up);
    expect(r.state.phase).toBe("send");
    expect(r.effects).toContainEqual({
      type: "finish_capture",
      sessionId: "x1",
    });
    expect(r.effects).toContainEqual({ type: "haptic", kind: "stop" });
  });

  it("sliding off during that tap, or the cancel control, cancels it", () => {
    expect(
      run(
        online(),
        shell(),
        down("ignored"),
        { type: "slide", inside: false },
        up,
      ).state.phase,
    ).toBe("idle");
    const r = run(online(), shell(), { type: "cancel" });
    expect(r.state.phase).toBe("idle");
    expect(r.effects).toContainEqual({
      type: "cancel_capture",
      sessionId: "x1",
    });
  });

  it("does nothing while already recording", () => {
    const r = run(online(), down("s1"), shell("x2"));
    expect(r.state.sessionId).toBe("s1");
    expect(r.state.latched).toBe(false);
    expect(r.effects.filter((e) => e.type === "start_capture").length).toBe(1);
  });

  it("starts from a finished or waiting state too", () => {
    const ready = run(online(), down(), up, {
      type: "result",
      sessionId: "s1",
      ok: true,
    }).state;
    expect(run(ready, shell()).state.phase).toBe("rec");
    const waitingState = run(online(), down(), up).state;
    expect(run(waitingState, shell()).state.sessionId).toBe("x1");
  });

  it("stops at the 5 minute limit", () => {
    expect(run(online(), shell(), { type: "max_duration" }).state.phase).toBe(
      "send",
    );
  });
});

describe("results (PHONE-23, PHONE-25)", () => {
  const sent = () => run(online(), down(), up).state;

  it("send -> ready on ok", () => {
    expect(
      run(sent(), { type: "result", sessionId: "s1", ok: true }).state.phase,
    ).toBe("ready");
  });

  it.each([
    ["no_speech", "no_speech"],
    ["paused", "paused"],
    ["model_not_ready", "error"],
    ["too_long", "error"],
    ["error", "error"],
  ] as const)("reason %s -> %s", (reason, phase) => {
    const { state } = run(sent(), {
      type: "result",
      sessionId: "s1",
      ok: false,
      reason,
    });
    expect(state.phase).toBe(phase as Phase);
    if (phase === "error") expect(state.detail).toBe(reason);
  });

  it("ignores a result for another session", () => {
    expect(
      run(sent(), { type: "result", sessionId: "other", ok: true }).state.phase,
    ).toBe("send");
  });

  it("an old session's result does not interrupt a new recording", () => {
    const r = run(sent(), down("s2"), {
      type: "result",
      sessionId: "s1",
      ok: true,
    });
    expect(r.state.phase).toBe("rec");
    expect(r.state.sessionId).toBe("s2");
  });

  it("a buffer_full relay error is an error with details", () => {
    const { state } = run(sent(), { type: "relay_error", code: "buffer_full" });
    expect(state.phase).toBe("error");
    expect(state.detail).toBe("buffer_full");
  });

  it("can record again from every finished state", () => {
    for (const reason of [undefined, "no_speech", "paused", "error"] as const) {
      const after = run(
        sent(),
        reason
          ? { type: "result", sessionId: "s1", ok: false, reason }
          : { type: "result", sessionId: "s1", ok: true },
      ).state;
      expect(run(after, down("s2")).state.phase).toBe("rec");
    }
  });

  it("finished states fall back to idle when the app comes back to the foreground", () => {
    const ready = run(sent(), {
      type: "result",
      sessionId: "s1",
      ok: true,
    }).state;
    expect(run(ready, { type: "foreground" }).state.phase).toBe("idle");
    expect(run(sent(), { type: "foreground" }).state.phase).toBe("send");
  });
});

describe("offline computer (PHONE-24)", () => {
  const offline = () =>
    initialMachine({ mode: "hold", peerOnline: false, connected: true });

  it("release while the computer is offline -> offline", () => {
    expect(run(offline(), down(), up).state.phase).toBe("offline");
  });

  it("the computer going offline during the recording or while sending -> offline", () => {
    expect(
      run(online(), down(), { type: "peer", online: false }, up).state.phase,
    ).toBe("offline");
    expect(
      run(online(), down(), up, { type: "peer", online: false }).state.phase,
    ).toBe("offline");
  });

  it("offline -> send when the computer comes online, then ready", () => {
    const r = run(offline(), down(), up, { type: "peer", online: true });
    expect(r.state.phase).toBe("send");
    expect(
      run(r.state, { type: "result", sessionId: "s1", ok: true }).state.phase,
    ).toBe("ready");
  });

  it("a result can arrive straight in offline (buffered audio was handled)", () => {
    expect(
      run(offline(), down(), up, { type: "result", sessionId: "s1", ok: true })
        .state.phase,
    ).toBe("ready");
  });

  it("no result in 10 minutes -> failed, and Prøv igen resends", () => {
    let r = run(offline(), down(), up, { type: "timeout", sessionId: "s1" });
    expect(r.state.phase).toBe("failed");
    r = run(r.state, { type: "retry" });
    expect(r.state.phase).toBe("offline");
    expect(r.effects).toEqual([{ type: "retry", sessionId: "s1" }]);
    expect(
      run(
        online(),
        down(),
        up,
        { type: "timeout", sessionId: "s1" },
        { type: "retry" },
      ).state.phase,
    ).toBe("send");
  });

  it("a late result still turns failed into ready", () => {
    const r = run(
      offline(),
      down(),
      up,
      { type: "timeout", sessionId: "s1" },
      { type: "result", sessionId: "s1", ok: true },
    );
    expect(r.state.phase).toBe("ready");
  });

  it("ignores a timeout for another session", () => {
    expect(
      run(offline(), down(), up, { type: "timeout", sessionId: "x" }).state
        .phase,
    ).toBe("offline");
  });
});

describe("connection to the relay", () => {
  it("tracks the connection; a lost connection while sending stays send (the view says Ingen forbindelse)", () => {
    const r = run(online(), down(), up, { type: "connection", up: false });
    expect(r.state.connected).toBe(false);
    expect(r.state.phase).toBe("send");
    const back = run(
      r.state,
      { type: "connection", up: true },
      { type: "peer", online: false },
    );
    expect(back.state.phase).toBe("offline");
  });
});

describe("microphone (PHONE-30)", () => {
  it("denied -> mic_denied, stopping the wake lock", () => {
    const { state, effects } = run(online(), down(), { type: "mic_denied" });
    expect(state.phase).toBe("mic_denied");
    expect(effects).toContainEqual({ type: "wake_lock", on: false });
    expect(effects).toContainEqual({ type: "cancel_capture", sessionId: "s1" });
  });

  it("another microphone failure -> error with details", () => {
    const { state } = run(online(), down(), {
      type: "mic_error",
      detail: "NotReadableError",
    });
    expect(state.phase).toBe("error");
    expect(state.detail).toBe("mic:NotReadableError");
  });
});

describe("choosing another computer (PHONE-41)", () => {
  it("resets to idle with the new computer's status", () => {
    const ready = run(online(), down(), up, {
      type: "result",
      sessionId: "s1",
      ok: true,
    }).state;
    const r = run(ready, {
      type: "retarget",
      peerOnline: false,
      connected: true,
    });
    expect(r.state.phase).toBe("idle");
    expect(r.state.peerOnline).toBe(false);
    expect(r.state.sessionId).toBeNull();
  });

  it("never changes target in the middle of a recording", () => {
    const r = run(online(), down(), {
      type: "retarget",
      peerOnline: false,
      connected: false,
    });
    expect(r.state.phase).toBe("rec");
    expect(r.state.peerOnline).toBe(true);
  });
});
