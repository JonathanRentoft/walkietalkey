import { describe, expect, it } from "vitest";
import {
  MemoryCounterStore,
  PairChannel,
  ProtocolError,
  computeRoomId,
  derivePairKeys,
  generateDeviceKeys,
  parseFrame,
  randomBytes,
  sealFrame,
} from "../src/index.ts";

async function setup() {
  const computer = await generateDeviceKeys();
  const phone = await generateDeviceKeys();
  const s = randomBytes(32);
  const roomId = await computeRoomId(computer.signingSpki, randomBytes(16));
  const common = {
    secret: s,
    roomId,
    computerId: computer.deviceId,
    phoneId: phone.deviceId,
  };
  const phoneKeys = await derivePairKeys({
    ...common,
    agreementPrivateKey: phone.agreement.privateKey,
    peerAgreementSpki: computer.agreementSpki,
  });
  const computerKeys = await derivePairKeys({
    ...common,
    agreementPrivateKey: computer.agreement.privateKey,
    peerAgreementSpki: phone.agreementSpki,
  });
  const phoneStore = new MemoryCounterStore();
  const computerStore = new MemoryCounterStore();
  const phoneChannel = await PairChannel.open({
    role: "phone",
    selfId: phone.deviceId,
    peerId: computer.deviceId,
    keys: phoneKeys,
    store: phoneStore,
  });
  const computerChannel = await PairChannel.open({
    role: "computer",
    selfId: computer.deviceId,
    peerId: phone.deviceId,
    keys: computerKeys,
    store: computerStore,
  });
  return {
    computer,
    phone,
    phoneChannel,
    computerChannel,
    phoneStore,
    computerStore,
    phoneKeys,
    computerKeys,
  };
}

describe("pair channel", () => {
  it("carries payloads both ways with increasing counters", async () => {
    const { phoneChannel, computerChannel } = await setup();
    const sessionId = randomBytes(16);
    const f1 = await phoneChannel.seal({
      type: "audio_start",
      sessionId,
      sampleRate: 16000,
      codec: "pcm16",
    });
    const f2 = await phoneChannel.seal({
      type: "audio_chunk",
      sessionId,
      firstIndex: 0,
      pcm: randomBytes(6400),
    });
    expect(parseFrame(f1).header.counter).toBe(1n);
    expect(parseFrame(f2).header.counter).toBe(2n);
    expect((await computerChannel.open(f1)).type).toBe("audio_start");
    expect((await computerChannel.open(f2)).type).toBe("audio_chunk");
    const back = await computerChannel.seal({
      type: "result",
      sessionId,
      ok: true,
    });
    expect(await phoneChannel.open(back)).toEqual({
      type: "result",
      sessionId,
      ok: true,
    });
  });

  it("drops replays, including after a restart", async () => {
    const {
      phoneChannel,
      computerChannel,
      computer,
      phone,
      computerKeys,
      computerStore,
    } = await setup();
    const f1 = await phoneChannel.seal({ type: "presence_query" });
    await computerChannel.open(f1);
    await expect(computerChannel.open(f1)).rejects.toMatchObject({
      code: "replay",
    });
    const restarted = await PairChannel.open({
      role: "computer",
      selfId: computer.deviceId,
      peerId: phone.deviceId,
      keys: computerKeys,
      store: computerStore,
    });
    await expect(restarted.open(f1)).rejects.toMatchObject({ code: "replay" });
    const f2 = await phoneChannel.seal({ type: "presence_query" });
    expect((await restarted.open(f2)).type).toBe("presence_query");
  });

  it("refuses payload types in the wrong direction", async () => {
    const { phoneChannel, computerChannel, phone, computer, phoneKeys } =
      await setup();
    await expect(
      phoneChannel.seal({
        type: "result",
        sessionId: randomBytes(16),
        ok: true,
      }),
    ).rejects.toBeInstanceOf(ProtocolError);
    await expect(
      computerChannel.seal({ type: "presence_query" }),
    ).rejects.toBeInstanceOf(ProtocolError);
    // A phone frame that decrypts but carries a computer-only type is rejected by the computer.
    const sneaky = await sealFrame(
      phoneKeys.p2c,
      {
        type: 0x11,
        sender: phone.deviceId,
        recipient: computer.deviceId,
        counter: 100n,
      },
      new TextEncoder().encode('{"secondsSinceInput":1,"locked":false}'),
    );
    await expect(computerChannel.open(sneaky)).rejects.toMatchObject({
      code: "bad_payload",
    });
  });

  it("does not open frames meant for someone else or keyed for the other direction", async () => {
    const { phoneChannel } = await setup();
    const own = await phoneChannel.seal({ type: "presence_query" });
    // The phone's own outgoing frame is addressed to the computer, not the phone.
    await expect(phoneChannel.open(own)).rejects.toMatchObject({
      code: "wrong_recipient",
    });
  });
});
