#!/usr/bin/env bun
/**
 * Probes the per-IP limit on create intents: opens create-intent sockets to random room ids
 * (no `create` is sent, so nothing is stored) and reports at which attempt 4429 appears.
 *
 *   bun scripts/probe-rate-limit.ts [--relay wss://...] [--attempts 40] [--delay-ms 100]
 */
import { CloseCode, randomBytes, roomSocketUrl } from "@walkietalkey/protocol";
import { RelaySocket } from "@walkietalkey/protocol/relay-socket";

const args = process.argv.slice(2);
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1]! : dflt;
};
const relay = opt(
  "--relay",
  "wss://relay.walkietalkey.com",
);
const attempts = Number(opt("--attempts", "40"));
const delay = Number(opt("--delay-ms", "100"));

const outcomes: string[] = [];
let firstRefusal = 0;
for (let i = 1; i <= attempts; i++) {
  const s = await RelaySocket.open(
    roomSocketUrl(relay, randomBytes(16), "create"),
  );
  try {
    await s.control("challenge", 5000);
    outcomes.push("c");
  } catch {
    const code = s.closeInfo?.code ?? 0;
    outcomes.push(code === CloseCode.RateLimited ? "R" : String(code));
    if (code === CloseCode.RateLimited && !firstRefusal) firstRefusal = i;
  }
  s.close();
  await new Promise((r) => setTimeout(r, delay));
}
console.log(
  JSON.stringify({
    relay,
    attempts,
    firstRefusal,
    refused: outcomes.filter((o) => o === "R").length,
    outcomes: outcomes.join(""),
  }),
);
