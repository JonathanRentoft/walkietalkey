import { describe, expect, it } from "vitest";
import {
  CloseCode,
  PING_MESSAGE,
  PONG_MESSAGE,
  ProtocolError,
  b64uEncode,
  generateDeviceKeys,
  parseControlMessage,
  randomBytes,
  serializeControlMessage,
  type ControlMessage,
} from "../src/index.ts";

const b = (n: number) => b64uEncode(randomBytes(n));

describe("control messages", async () => {
  const keys = await generateDeviceKeys();
  const spki = b64uEncode(keys.signingSpki);
  const agree = b64uEncode(keys.agreementSpki);

  const valid: ControlMessage[] = [
    { t: "challenge", n: b(32) },
    { t: "auth", id: b(16), sig: b(64) },
    { t: "create", pub: spki, salt: b(16), sig: b(64) },
    { t: "join", a: b(32), pub: spki, agree, mac: b(32), sig: b(64) },
    {
      t: "ok",
      role: "owner",
      members: [
        { id: b(16), role: "owner", online: true, lastSeenDay: 20384 },
        { id: b(16), role: "phone", online: false, lastSeenDay: 20380 },
      ],
    },
    { t: "add_admission", h: b(32), exp: 1_790_000_000_000 },
    { t: "cancel_admission", h: b(32) },
    { t: "member_joined", id: b(16), pub: spki, agree, mac: b(32), eid: 3 },
    { t: "member_left", id: b(16), eid: 4 },
    { t: "event_ack", eid: 4 },
    { t: "ack", op: "add_admission", h: b(32) },
    { t: "ack", op: "revoke", id: b(16) },
    { t: "leave" },
    { t: "revoke", id: b(16) },
    { t: "delete_room" },
    { t: "peer", id: b(16), online: true },
    { t: "error", code: "buffer_full", msg: "buffer full" },
    { t: "ping" },
    { t: "pong" },
  ];

  it("round-trips every message type of Appendix C.1", () => {
    for (const msg of valid) {
      const text = serializeControlMessage(msg);
      expect(parseControlMessage(text)).toEqual(msg);
    }
  });

  it("serializes ping and pong to the exact auto-response strings", () => {
    expect(serializeControlMessage({ t: "ping" })).toBe('{"t":"ping"}');
    expect(PING_MESSAGE).toBe('{"t":"ping"}');
    expect(PONG_MESSAGE).toBe('{"t":"pong"}');
  });

  it("ignores unknown fields", () => {
    expect(parseControlMessage('{"t":"leave","x":1}')).toEqual({ t: "leave" });
  });

  it("rejects malformed messages", () => {
    const bad = [
      "",
      "null",
      "[]",
      '"ping"',
      "{}",
      '{"t":"nope"}',
      '{"t":5}',
      `{"t":"challenge","n":"${b(31)}"}`,
      `{"t":"auth","id":"${b(16)}"}`,
      `{"t":"auth","id":"${b(16)}","sig":"${b(63)}"}`,
      `{"t":"create","pub":"${b(91)}","salt":"${b(16)}","sig":"${b(64)}"}`,
      `{"t":"join","a":"${b(31)}","pub":"${spki}","agree":"${agree}","mac":"${b(32)}","sig":"${b(64)}"}`,
      `{"t":"ok","role":"admin","members":[]}`,
      `{"t":"ok","role":"phone","members":[{"id":"${b(16)}","role":"phone","online":1,"lastSeenDay":1}]}`,
      `{"t":"add_admission","h":"${b(32)}","exp":-1}`,
      `{"t":"add_admission","h":"${b(32)}","exp":"soon"}`,
      `{"t":"peer","id":"${b(16)}"}`,
      `{"t":"error","code":5,"msg":"x"}`,
      `{"t":"ack","op":"something_else"}`,
      `{"t":"event_ack","eid":1.5}`,
    ];
    for (const text of bad) {
      expect(() => parseControlMessage(text), text).toThrow(ProtocolError);
    }
  });

  it("defines the close codes of Appendix C.3", () => {
    expect(CloseCode).toEqual({
      NotAuthorised: 4401,
      NotAllowed: 4403,
      RoomNotFound: 4404,
      RoomExists: 4409,
      FrameTooLarge: 4413,
      RateLimited: 4429,
    });
  });
});
