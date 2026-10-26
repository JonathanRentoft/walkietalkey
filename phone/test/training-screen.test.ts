import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { randomBytes, type TrainingCheck } from "@walkietalkey/protocol";
import type { PhoneController, Snapshot } from "../src/core/controller";
import { initialMachine, type Phase } from "../src/core/machine";
import { TrainingScreen } from "../src/training/TrainingScreen";
import { fromPrompt, type TrainingView } from "../src/training/state";

/* The training screen's two buttons (PHONE-50, PHONE-52): "Tag om" and "Spring over" in one row
   under the sentence, each disabled when pressing it would do nothing. The clicks themselves are
   in e2e/training.spec.ts. */

const controller = { recordedMs: () => 0 } as unknown as PhoneController;

function snap(phase: Phase = "idle"): Snapshot {
  return {
    loaded: true,
    rooms: [],
    target: "room",
    machine: {
      ...initialMachine({ peerOnline: true, connected: true }),
      phase,
    },
    settings: { haptics: true },
    notices: [],
    pairing: { state: "idle" },
    noConnection: false,
    level: 0,
    training: null,
  };
}

function view(
  next: string | null,
  last: [string, TrainingCheck] | null,
  extra: Partial<TrainingView> = {},
): TrainingView {
  return {
    ...fromPrompt("room", "MacBook", {
      type: "training_prompt",
      training: randomBytes(16),
      style: "whisper",
      done: 16,
      total: 120,
      ...(next ? { next: { prompt: next, text: `Sætning ${next}.` } } : {}),
      ...(last
        ? {
            last: {
              prompt: last[0],
              text: `Sætning ${last[0]}.`,
              check: last[1],
            },
          }
        : {}),
    }),
    ...extra,
  };
}

/** The row's buttons as [label, disabled]. */
function buttons(training: TrainingView, phase: Phase = "idle") {
  const html = renderToStaticMarkup(
    createElement(TrainingScreen, {
      controller,
      snap: snap(phase),
      training,
      onDetails: () => undefined,
    }),
  );
  const row = /<div class="wt-training-actions">(.*?)<\/div>/.exec(html);
  expect(row, html).not.toBeNull();
  return {
    html,
    row: [...row![1]!.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(
      (m) => [m[2], /\sdisabled=""/.test(m[1]!)] as [string, boolean],
    ),
  };
}

describe("the training screen's buttons", () => {
  it("shows the sentence, the progress, and Tag om and Spring over in one row", () => {
    const { html, row } = buttons(view("s0017", ["s0016", "ok"]));
    expect(html).toContain("Sætning s0017.");
    expect(html).toContain("16 af 120");
    expect(row).toEqual([
      ["Tag om", false],
      ["Spring over", false],
    ]);
    expect(html).not.toContain("Optag forrige igen");
  });

  it("has nothing to take again before the first take", () => {
    expect(buttons(view("s0001", null)).row).toEqual([
      ["Tag om", true],
      ["Spring over", false],
    ]);
  });

  it("goes back to the next sentence during a redo, and does not skip then", () => {
    expect(
      buttons(view("s0017", ["s0016", "quiet"], { redo: true })).row,
    ).toEqual([
      ["Tilbage til den næste", false],
      ["Spring over", true],
    ]);
  });

  it("waits after a skip until the computer sends another sentence", () => {
    expect(
      buttons(view("s0017", ["s0016", "ok"], { skipped: "s0017" })).row,
    ).toEqual([
      ["Tag om", false],
      ["Spring over", true],
    ]);
    // A skip of an earlier sentence does not hold back this one.
    expect(
      buttons(view("s0018", ["s0016", "ok"], { skipped: "s0017" })).row,
    ).toEqual([
      ["Tag om", false],
      ["Spring over", false],
    ]);
  });

  it("cannot skip when every sentence is done", () => {
    expect(buttons(view(null, ["s0120", "ok"])).row).toEqual([
      ["Tag om", false],
      ["Spring over", true],
    ]);
  });

  it("does nothing while the prompt is stale, a take records or is on its way", () => {
    const both = [
      ["Tag om", true],
      ["Spring over", true],
    ];
    expect(
      buttons(view("s0017", ["s0016", "ok"], { stale: true })).row,
    ).toEqual(both);
    for (const phase of ["rec", "cancel", "send", "offline"] as Phase[])
      expect(buttons(view("s0017", ["s0016", "ok"]), phase).row).toEqual(both);
  });
});
