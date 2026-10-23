import { describe, expect, it } from "vitest";
import { PHONE_LABELS } from "@walkietalkey/ui";
import { initialMachine, type MachineState, type Phase } from "../src/core/machine";
import { COUNTDOWN_FROM_MS, MAX_RECORDING_MS } from "../src/core/controller";
import { countdownSeconds, viewState } from "../src/ui/viewState";
import { T } from "../src/lib/strings";

const m = (phase: Phase): MachineState => ({ ...initialMachine({ mode: "hold", peerOnline: true, connected: true }), phase });

describe("main screen states (spec 7.3)", () => {
  it.each([
    ["idle", "idle"],
    ["rec", "rec"],
    ["cancel", "cancel"],
    ["send", "send"],
    ["offline", "offline"],
    ["ready", "ready"],
    ["failed", "failed"],
    ["error", "error"],
    ["paused", "paused"],
  ] as const)("%s shows PhoneApp %s", (phase, state) => {
    expect(viewState(m(phase), false).state).toBe(state);
  });

  it("no speech says Hørte ikke noget, ready to record again", () => {
    const v = viewState(m("no_speech"), false);
    expect(v.state).toBe("idle");
    expect(v.labels.idle).toBe("Hørte ikke noget");
  });

  it("a refused microphone says so", () => {
    expect(viewState(m("mic_denied"), false).labels.paused).toBe("WalkieTalkey skal bruge mikrofonen. Slå den til i indstillingerne.");
  });

  it("a lost connection says Ingen forbindelse. Prøver igen.", () => {
    for (const phase of ["idle", "send", "offline"] as const) {
      const v = viewState(m(phase), true);
      expect(v.state).toBe("offline");
      expect(v.labels.offline).toBe("Ingen forbindelse. Prøver igen.");
    }
    expect(viewState(m("rec"), true).state).toBe("rec");
  });

  it("sends with the ekko loader", () => {
    expect(viewState(m("send"), false).sending).toBe(true);
    expect(viewState(m("offline"), false).sending).toBe(false);
  });

  it("uses the Appendix A strings", () => {
    expect(PHONE_LABELS.idle).toBe("Hold for at tale");
    expect(PHONE_LABELS.rec).toBe("Slip for at sende");
    expect(PHONE_LABELS.cancel).toBe("Slip for at annullere");
    expect(PHONE_LABELS.send).toBe("Sender til {computer}");
    expect(PHONE_LABELS.ready).toBe("Klar på {computer}");
    expect(PHONE_LABELS.offline).toBe("{computer} er ikke online. Optagelsen venter i 10 minutter.");
    expect(PHONE_LABELS.failed).toBe("Nåede ikke frem til {computer}.");
    expect(PHONE_LABELS.paused).toBe("{computer} er sat på pause.");
    expect(PHONE_LABELS.error).toBe("Noget gik galt. Prøv igen.");
    expect(PHONE_LABELS.lock).toBe(T.lock);
  });

  it("has no em dashes, exclamation marks or emoji in any string", () => {
    const all = JSON.stringify(T);
    expect(all).not.toMatch(/[—!]/);
    expect(all).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("5 minute limit (PHONE-29)", () => {
  it("counts down from 4:45", () => {
    expect(countdownSeconds(284_000, MAX_RECORDING_MS, COUNTDOWN_FROM_MS)).toBeNull();
    expect(countdownSeconds(285_000, MAX_RECORDING_MS, COUNTDOWN_FROM_MS)).toBe(15);
    expect(countdownSeconds(299_100, MAX_RECORDING_MS, COUNTDOWN_FROM_MS)).toBe(1);
    expect(countdownSeconds(301_000, MAX_RECORDING_MS, COUNTDOWN_FROM_MS)).toBe(0);
  });
});
