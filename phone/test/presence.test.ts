import { describe, expect, it } from "vitest";
import {
  chooseTarget,
  needsPresence,
  type Candidate,
  type PresenceAnswer,
} from "../src/core/presence";

const c = (roomId: string, online: boolean, lastUsedAt: number): Candidate => ({
  roomId,
  online,
  lastUsedAt,
});

describe("picking the computer you are sitting at (PHONE-40)", () => {
  it("asks only when more than one paired computer is online", () => {
    expect(needsPresence([c("a", true, 1)])).toBe(false);
    expect(needsPresence([c("a", true, 1), c("b", false, 2)])).toBe(false);
    expect(needsPresence([c("a", true, 1), c("b", true, 2)])).toBe(true);
  });

  it("takes the unlocked computer with the most recent input", () => {
    const answers = new Map<string, PresenceAnswer | null>([
      ["a", { secondsSinceInput: 120, locked: false }],
      ["b", { secondsSinceInput: 4, locked: false }],
      ["c", { secondsSinceInput: 30, locked: false }],
    ]);
    expect(
      chooseTarget(
        [c("a", true, 9), c("b", true, 1), c("c", true, 5)],
        answers,
      ),
    ).toBe("b");
  });

  it("skips locked computers, however recent their input", () => {
    const answers = new Map<string, PresenceAnswer | null>([
      ["a", { secondsSinceInput: 1, locked: true }],
      ["b", { secondsSinceInput: 50, locked: false }],
    ]);
    expect(chooseTarget([c("a", true, 9), c("b", true, 1)], answers)).toBe("b");
  });

  it("falls back to the computer used last when none answers", () => {
    const answers = new Map<string, PresenceAnswer | null>([
      ["a", null],
      ["b", null],
    ]);
    expect(chooseTarget([c("a", true, 10), c("b", true, 20)], answers)).toBe(
      "b",
    );
  });

  it("takes the one computer that is online, even when another was used last", () => {
    expect(chooseTarget([c("a", true, 10), c("b", false, 20)], new Map())).toBe(
      "a",
    );
    expect(
      chooseTarget(
        [c("a", false, 30), c("b", true, 10), c("c", false, 20)],
        new Map(),
      ),
    ).toBe("b");
  });

  it("without usable answers, prefers the online computer used last over an offline one", () => {
    const answers = new Map<string, PresenceAnswer | null>([
      ["a", null],
      ["b", null],
    ]);
    expect(
      chooseTarget(
        [c("a", true, 10), c("b", true, 20), c("c", false, 30)],
        answers,
      ),
    ).toBe("b");
  });

  it("falls back to the computer used last when none is online", () => {
    expect(
      chooseTarget([c("a", false, 10), c("b", false, 20)], new Map()),
    ).toBe("b");
  });

  it("falls back to the computer used last when every answer is locked", () => {
    const answers = new Map<string, PresenceAnswer | null>([
      ["a", { secondsSinceInput: 1, locked: true }],
      ["b", { secondsSinceInput: 2, locked: true }],
    ]);
    expect(chooseTarget([c("a", true, 30), c("b", true, 20)], answers)).toBe(
      "a",
    );
  });

  it("has no target without paired computers", () => {
    expect(chooseTarget([], new Map())).toBeNull();
  });
});
