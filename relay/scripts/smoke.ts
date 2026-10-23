#!/usr/bin/env bun
/**
 * Live smoke test against a running relay: create a room, add an admission, pair a scripted
 * phone, send frames both ways, revoke the phone, delete the room.
 *
 *   bun scripts/smoke.ts [--relay wss://walkietalkey-relay.jonathan0912.workers.dev] [--rate-limit]
 *
 * --rate-limit additionally opens create-intent sockets from this IP until one is refused
 * with 4429 (at most 40; this uses up this IP's create quota for a minute).
 */
import {
  CloseCode,
  MemoryCounterStore,
  PairChannel,
  b64uDecode,
  b64uEncode,
  computeRoomId,
  derivePairKeys,
  encodePairingUrl,
  generateDeviceKeys,
  randomBytes,
  roomSocketUrl,
  sha256,
  signChallenge,
  verifyJoinMac,
} from "@walkietalkey/protocol";
import { RelaySocket } from "@walkietalkey/protocol/relay-socket";
import {
  RemovedError,
  ScriptedPhone,
} from "@walkietalkey/protocol/scripted-phone";

const args = process.argv.slice(2);
const relay = (() => {
  const i = args.indexOf("--relay");
  return i >= 0
    ? args[i + 1]!
    : "wss://walkietalkey-relay.jonathan0912.workers.dev";
})();
const insecure = relay.startsWith("ws://");
const steps: { step: string; ok: boolean; detail?: string }[] = [];

function pass(step: string, detail?: string) {
  steps.push({ step, ok: true, detail });
  console.log(`ok   ${step}${detail ? ` (${detail})` : ""}`);
}

async function main() {
  const t0 = Date.now();
  const health = await fetch(relay.replace(/^ws/, "http") + "/v1/health");
  if (!health.ok) throw new Error(`health ${health.status}`);
  pass("health", JSON.stringify(await health.json()));

  // Owner (the computer): create the room.
  const owner = await generateDeviceKeys();
  const salt = randomBytes(16);
  const roomId = await computeRoomId(owner.signingSpki, salt);
  const os = await RelaySocket.open(roomSocketUrl(relay, roomId, "create"));
  const ch = b64uDecode((await os.control("challenge")).n, 32);
  const csig = await signChallenge(
    owner.signing.privateKey,
    "wt-create-v1",
    roomId,
    ch,
  );
  os.sendControl({
    t: "create",
    pub: b64uEncode(owner.signingSpki),
    salt: b64uEncode(salt),
    sig: b64uEncode(csig),
  });
  const ok = await os.control("ok");
  if (ok.role !== "owner") throw new Error("not owner");
  os.startPing();
  pass("create", `room ${b64uEncode(roomId).slice(0, 6)}…`);

  // Admission and pairing URL.
  const a = randomBytes(32);
  const s = randomBytes(32);
  const h = b64uEncode(await sha256(a));
  os.sendControl({ t: "add_admission", h, exp: Date.now() + 10 * 60 * 1000 });
  await os.control("ack");
  const url = encodePairingUrl("https://walkietalkey-app.pages.dev", {
    v: 1,
    r: roomId,
    a,
    s,
    e: owner.agreementSpki,
    u: relay,
    n: "Smoke test computer",
    o: "mac",
  });
  pass("add_admission");

  // Phone joins.
  const phone = await ScriptedPhone.create({
    name: "Smoke phone",
    allowInsecureLocalhost: insecure,
  });
  await phone.pair(url);
  const joined = await os.control("member_joined");
  const phoneSpki = b64uDecode(joined.pub);
  const phoneAgree = b64uDecode(joined.agree);
  if (
    !(await verifyJoinMac(
      s,
      roomId,
      phoneSpki,
      phoneAgree,
      b64uDecode(joined.mac),
    ))
  )
    throw new Error("join MAC");
  os.sendControl({ t: "event_ack", eid: joined.eid });
  const phoneId = b64uDecode(joined.id, 16);
  const keys = await derivePairKeys({
    agreementPrivateKey: owner.agreement.privateKey,
    peerAgreementSpki: phoneAgree,
    secret: s,
    roomId,
    computerId: owner.deviceId,
    phoneId,
  });
  const channel = await PairChannel.open({
    role: "computer",
    selfId: owner.deviceId,
    peerId: phoneId,
    keys,
    store: new MemoryCounterStore(),
  });
  pass("join + MAC verified", `phone ${joined.id.slice(0, 6)}…`);

  // Phone → computer: device_info, then a 1 s dictation.
  const info = await channel.open(await os.binary());
  if (info.type !== "device_info" || info.name !== "Smoke phone")
    throw new Error(`device_info: ${info.type}`);
  pass("device_info", info.name);
  const pcm = randomBytes(32000);
  const streaming = phone.streamPcm(pcm, { framesPerSecond: 25 });
  const got: Uint8Array[] = [];
  let sessionId: Uint8Array | null = null;
  for (;;) {
    const p = await channel.open(await os.binary());
    if (p.type === "audio_start") sessionId = p.sessionId;
    if (p.type === "audio_chunk") got[p.firstIndex] = p.pcm;
    if (p.type === "audio_end") break;
  }
  const sid = await streaming;
  const joinedPcm = Buffer.concat(got.map((g) => Buffer.from(g)));
  if (!joinedPcm.equals(Buffer.from(pcm))) throw new Error("PCM differs");
  pass(
    "audio frames phone → computer",
    `${got.length} blocks, ${pcm.length} bytes identical`,
  );

  // Computer → phone: result and a presence answer.
  os.sendBinary(
    await channel.seal({ type: "result", sessionId: sessionId!, ok: true }),
  );
  const r = await phone.waitResult(sid, 10_000);
  if (!r.ok) throw new Error("result not ok");
  pass("result computer → phone");
  const presence = phone.presenceQuery(5000);
  const q = await channel.open(await os.binary());
  if (q.type !== "presence_query") throw new Error("presence_query");
  os.sendBinary(
    await channel.seal({
      type: "presence",
      secondsSinceInput: 7,
      locked: false,
    }),
  );
  const pres = await presence;
  if (!pres || pres.secondsSinceInput !== 7) throw new Error("presence");
  pass("presence_query / presence");

  // Revoke.
  os.sendControl({ t: "revoke", id: joined.id });
  const closed = await phone.waitClosed();
  await os.control("ack");
  if (closed.code !== CloseCode.NotAuthorised)
    throw new Error(`revoke closed with ${closed.code}`);
  let again = 0;
  try {
    await phone.connect();
  } catch (e) {
    again = e instanceof RemovedError ? e.code : -1;
  }
  if (again !== CloseCode.NotAuthorised)
    throw new Error(`reconnect after revoke: ${again}`);
  pass("revoke", "phone closed 4401, reconnect 4401");

  // Clean up.
  os.sendControl({ t: "delete_room" });
  const oc = await os.closed();
  if (oc.code !== 1000) throw new Error(`delete_room closed with ${oc.code}`);
  const probe = await RelaySocket.open(roomSocketUrl(relay, roomId, "auth"));
  const pc = await probe.closed();
  if (pc.code !== CloseCode.RoomNotFound)
    throw new Error(`deleted room answered ${pc.code}`);
  pass("delete_room", "room gone (4404)");

  if (args.includes("--rate-limit")) {
    const sockets: RelaySocket[] = [];
    let refusedAt = 0;
    // The binding is approximate and eventually consistent: a burst overshoots the limit of 10
    // before refusals start (measured: first 4429 around attempt 25).
    for (let i = 1; i <= 40 && !refusedAt; i++) {
      const sock = await RelaySocket.open(
        roomSocketUrl(relay, randomBytes(16), "create"),
      );
      sockets.push(sock);
      try {
        await sock.control("challenge", 5000);
      } catch {
        if (sock.closeInfo?.code === CloseCode.RateLimited) refusedAt = i;
      }
    }
    for (const sock of sockets) sock.close();
    if (!refusedAt) throw new Error("no 4429 after 40 create intents");
    pass("per-IP create limit", `refused with 4429 at attempt ${refusedAt}`);
  }

  console.log(
    JSON.stringify({
      relay,
      ok: true,
      ms: Date.now() - t0,
      steps: steps.length,
    }),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(`FAIL ${e instanceof Error ? e.message : String(e)}`);
  console.log(JSON.stringify({ relay, ok: false, steps }));
  process.exit(1);
});
