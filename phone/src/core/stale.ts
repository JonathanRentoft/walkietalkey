/**
 * Pairings whose computer will never come back (run 5, spec 5.4): "Par igen", never a hang.
 *
 * - Room gone (4404) or not a member (4401): the link reports `removed`, the room is dropped and
 *   the phone says "Parringen med {computer} er fjernet. Par igen for at bruge den." (PHONE-14).
 * - The computer was reset, reinstalled or got a new identity (v0.2.0): its old room lives on at
 *   the relay with the owner offline until the relay's 90-day housekeeping. The phone cannot tell
 *   that from a computer that sleeps, so it keeps waiting for a dictation (PHONE-24) but offers
 *   "Par igen" once the relay has not seen the computer for STALE_AFTER_DAYS whole days, and after
 *   a dictation that never arrived. Pairing again with that computer replaces the old pairing.
 * - An old pairing code of a room the phone is already in is refused as expired (link.ts
 *   `memberFallback`), so it can never replace working keys with ones the computer never had.
 */

/** Days since 1970-01-01 UTC, as the relay counts `lastSeenDay` (RELAY-02). */
export function dayNumber(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

/** Two whole days away: longer than a night or a weekend's sleep, short enough to help. */
export const STALE_AFTER_DAYS = 2;

/** Whole days since the relay last saw the computer; null when unknown. */
export function daysAway(
  lastSeenDay: number | null,
  today: number,
): number | null {
  return lastSeenDay === null ? null : Math.max(0, today - lastSeenDay);
}

/** The computer may be gone for good: offer "Par igen" (it still gets what it is sent). */
export function isStale(
  c: { connected: boolean; online: boolean; lastSeenDay: number | null },
  today: number,
): boolean {
  if (!c.connected || c.online) return false;
  const away = daysAway(c.lastSeenDay, today);
  return away !== null && away >= STALE_AFTER_DAYS;
}

/**
 * The rooms a new pairing replaces: the same computer (name and kind) under an old identity,
 * which cannot be online at the same time. One that is online is another computer with the same
 * name, and stays.
 */
export function supersededRooms(
  rooms: {
    roomId: string;
    computerName: string;
    os: string;
    online: boolean;
  }[],
  paired: { roomId: string; computerName: string; os: string },
): string[] {
  return rooms
    .filter(
      (r) =>
        r.roomId !== paired.roomId &&
        r.computerName === paired.computerName &&
        r.os === paired.os &&
        !r.online,
    )
    .map((r) => r.roomId);
}
