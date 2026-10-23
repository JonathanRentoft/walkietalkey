/** PHONE-40: which paired computer the next dictation goes to. */

export interface Candidate {
  roomId: string;
  online: boolean;
  /** When a dictation last went to it (or when it was paired). */
  lastUsedAt: number;
}

export interface PresenceAnswer {
  secondsSinceInput: number;
  locked: boolean;
}

/** presence_query is only sent when more than one paired computer is online. */
export function needsPresence(candidates: readonly Candidate[]): boolean {
  return candidates.filter((c) => c.online).length > 1;
}

/** The unlocked computer with the most recent input; if none answers, the computer used last. */
export function chooseTarget(candidates: readonly Candidate[], answers: ReadonlyMap<string, PresenceAnswer | null>): string | null {
  if (candidates.length === 0) return null;
  let best: { roomId: string; seconds: number } | null = null;
  for (const c of candidates) {
    const a = answers.get(c.roomId);
    if (!a || a.locked) continue;
    if (!best || a.secondsSinceInput < best.seconds) best = { roomId: c.roomId, seconds: a.secondsSinceInput };
  }
  if (best) return best.roomId;
  let last = candidates[0]!;
  for (const c of candidates) if (c.lastUsedAt > last.lastUsedAt) last = c;
  return last.roomId;
}
