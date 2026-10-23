/**
 * RELAY-13: logs carry only hashed room ids, close codes and counts. Never payloads, device
 * ids, keys, IP addresses or raw room ids.
 */
export type LogFields = Record<string, string | number | boolean>;

export async function roomTag(roomIdB64: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`wt-log-v1:${roomIdB64}`));
  return [...new Uint8Array(digest).subarray(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function logLine(fields: LogFields): void {
  console.log(JSON.stringify(fields));
}
