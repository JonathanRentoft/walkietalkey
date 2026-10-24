/**
 * Run 5: a pairing whose computer will never come back shows "Par igen", never a hang (spec 5.4).
 * A computer that is reset, reinstalled, or updated to v0.2.0 (new identity) leaves its old room
 * on the relay with the owner offline; the phone cannot tell that from a computer that sleeps, so
 * it offers "Par igen" after days away while still waiting for an asleep one (PHONE-24), and a
 * new pairing with the same computer replaces the old one.
 */
import { describe, expect, it } from "vitest";
import {
  STALE_AFTER_DAYS,
  dayNumber,
  daysAway,
  isStale,
  supersededRooms,
} from "../src/core/stale";

const DAY = 86_400_000;

describe("days as the relay counts them", () => {
  it("are whole UTC days since 1970", () => {
    expect(dayNumber(0)).toBe(0);
    expect(dayNumber(DAY - 1)).toBe(0);
    expect(dayNumber(DAY)).toBe(1);
    expect(dayNumber(Date.UTC(2026, 9, 25, 23, 59))).toBe(
      dayNumber(Date.UTC(2026, 9, 25, 0, 0)),
    );
  });
});

describe("a computer away for days (run 5)", () => {
  const today = 20_000;
  const view = (o: Partial<Parameters<typeof isStale>[0]>) => ({
    connected: true,
    online: false,
    lastSeenDay: today,
    ...o,
  });

  it("is not stale while it is online, seen today or yesterday (asleep, PHONE-24)", () => {
    expect(isStale(view({ online: true }), today)).toBe(false);
    expect(isStale(view({ lastSeenDay: today }), today)).toBe(false);
    expect(isStale(view({ lastSeenDay: today - 1 }), today)).toBe(false);
  });

  it("is stale after two whole days away", () => {
    expect(STALE_AFTER_DAYS).toBe(2);
    expect(isStale(view({ lastSeenDay: today - 2 }), today)).toBe(true);
    expect(daysAway(today - 9, today)).toBe(9);
  });

  it("needs the relay's word: unknown while this phone's own connection is down", () => {
    expect(
      isStale(view({ connected: false, lastSeenDay: today - 30 }), today),
    ).toBe(false);
    expect(isStale(view({ lastSeenDay: null }), today)).toBe(false);
    expect(daysAway(null, today)).toBe(null);
  });
});

describe("pairing again replaces the old pairing with the same computer (run 5)", () => {
  const old = {
    roomId: "old",
    computerName: "Jonathans MacBook Pro",
    os: "mac" as const,
    online: false,
  };

  it("drops the same computer's old room when it is not online", () => {
    const paired = {
      roomId: "new",
      computerName: old.computerName,
      os: "mac" as const,
    };
    expect(supersededRooms([old, { ...paired, online: true }], paired)).toEqual(
      ["old"],
    );
  });

  it("keeps another computer, and one with the same name that is online (two computers)", () => {
    const paired = {
      roomId: "new",
      computerName: old.computerName,
      os: "mac" as const,
    };
    expect(
      supersededRooms(
        [
          { ...old, roomId: "work", computerName: "ThinkPad", os: "win" },
          { ...old, roomId: "twin", online: true },
          { ...old, roomId: "win-twin", os: "win" },
        ],
        paired,
      ),
    ).toEqual([]);
  });

  it("never drops the room it just paired with", () => {
    const paired = {
      roomId: "old",
      computerName: old.computerName,
      os: "mac" as const,
    };
    expect(supersededRooms([old], paired)).toEqual([]);
  });
});
