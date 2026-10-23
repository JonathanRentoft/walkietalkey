/**
 * WalkieTalkey relay Worker (spec section 8).
 *
 *   GET /v1/health                 liveness for monitoring
 *   GET /v1/rooms/{roomId}/ws      WebSocket for one device in one room (?intent=auth|create|join)
 *
 * The Worker applies the per-IP limits for `create` and `join` intents (RELAY-11) before any
 * Durable Object is touched, then hands the upgrade to the room's Durable Object.
 */
import { CloseCode, b64uDecode } from "@walkietalkey/protocol";
import { logLine } from "./log.ts";

export { Room } from "./room.ts";

const ROOM_PATH = /^\/v1\/rooms\/([^/]+)\/ws$/;
const INTENTS = new Set(["auth", "create", "join"]);

/** Accepts the upgrade and closes at once, so browsers see a close code instead of a failed handshake. */
function closeWith(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  pair[1].accept();
  pair[1].close(code, reason);
  return new Response(null, { status: 101, webSocket: pair[0] });
}

async function ipKey(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`wt-ip-v1:${ip}`));
  return [...new Uint8Array(digest).subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/health") {
      return Response.json({ ok: true, service: "walkietalkey-relay", protocol: 1 }, { headers: { "Cache-Control": "no-store" } });
    }
    const match = ROOM_PATH.exec(url.pathname);
    if (!match || request.method !== "GET") return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const intent = url.searchParams.get("intent") ?? "auth";
    if (!INTENTS.has(intent)) return new Response("unknown intent", { status: 400 });

    const roomB64 = match[1]!;
    try {
      b64uDecode(roomB64, 16);
    } catch {
      return closeWith(CloseCode.RoomNotFound, "room not found");
    }

    if (intent === "create" || intent === "join") {
      const limiter = intent === "create" ? env.CREATE_LIMITER : env.JOIN_LIMITER;
      const { success } = await limiter.limit({ key: await ipKey(request) });
      if (!success) {
        logLine({ evt: "rate_limited", intent, code: CloseCode.RateLimited });
        return closeWith(CloseCode.RateLimited, "rate limited");
      }
    }

    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomB64));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
