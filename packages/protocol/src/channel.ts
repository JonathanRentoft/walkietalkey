import { bytesEqual } from "./bytes.ts";
import { ProtocolError } from "./errors.ts";
import { counterKey, ReplayGuard, SendCounter, type CounterStore } from "./counter.ts";
import type { PairKeys } from "./derive.ts";
import { openFrame, parseFrame, sealFrame } from "./frame.ts";
import { decodePayload, encodePayload, PAYLOAD_DIRECTION, payloadTypeOf, type DevicePayload } from "./payload.ts";

export interface PairChannelOptions {
  /** Which side of the pair this device is. */
  role: "phone" | "computer";
  selfId: Uint8Array;
  peerId: Uint8Array;
  keys: PairKeys;
  store: CounterStore;
}

/**
 * One end of an encrypted phone ↔ computer pair: picks the key per direction, numbers frames
 * with persisted counters, checks recipient, sender and replay, and (de)serializes payloads.
 */
export class PairChannel {
  private readonly opts: PairChannelOptions;
  private readonly counter: SendCounter;
  private readonly guard: ReplayGuard;

  private constructor(opts: PairChannelOptions, counter: SendCounter, guard: ReplayGuard) {
    this.opts = opts;
    this.counter = counter;
    this.guard = guard;
  }

  static async open(opts: PairChannelOptions): Promise<PairChannel> {
    const counter = await SendCounter.open(opts.store, counterKey(opts.selfId, opts.peerId));
    const guard = await ReplayGuard.open(opts.store, counterKey(opts.peerId, opts.selfId));
    return new PairChannel(opts, counter, guard);
  }

  get selfId(): Uint8Array {
    return this.opts.selfId;
  }

  get peerId(): Uint8Array {
    return this.opts.peerId;
  }

  private get outDirection(): "p2c" | "c2p" {
    return this.opts.role === "phone" ? "p2c" : "c2p";
  }

  /** Encrypts a payload into a frame addressed to the peer, with a fresh counter and nonce. */
  async seal(payload: DevicePayload): Promise<Uint8Array> {
    if (PAYLOAD_DIRECTION[payload.type] !== this.outDirection) {
      throw new ProtocolError("bad_payload", `${payload.type} is not sent by the ${this.opts.role}`);
    }
    const { frameType, bytes } = encodePayload(payload);
    const key = this.opts.role === "phone" ? this.opts.keys.p2c : this.opts.keys.c2p;
    const counter = await this.counter.next();
    return sealFrame(key, { type: frameType, sender: this.opts.selfId, recipient: this.opts.peerId, counter }, bytes);
  }

  /**
   * Opens a frame from the peer: recipient check, sender check, replay check, decrypt,
   * counter persisted, payload decoded. Throws ProtocolError on any failure.
   */
  async open(frame: Uint8Array): Promise<DevicePayload> {
    const { header } = parseFrame(frame);
    if (!bytesEqual(header.recipient, this.opts.selfId)) throw new ProtocolError("wrong_recipient");
    if (!bytesEqual(header.sender, this.opts.peerId)) throw new ProtocolError("wrong_sender");
    if (!this.guard.wouldAccept(header.counter)) throw new ProtocolError("replay");
    const key = this.opts.role === "phone" ? this.opts.keys.c2p : this.opts.keys.p2c;
    const { plaintext } = await openFrame(key, frame, { recipient: this.opts.selfId, sender: this.opts.peerId });
    await this.guard.accept(header.counter);
    const type = payloadTypeOf(header.type);
    const inDirection = this.outDirection === "p2c" ? "c2p" : "p2c";
    if (!type || PAYLOAD_DIRECTION[type] !== inDirection) {
      throw new ProtocolError("bad_payload", `frame type 0x${header.type.toString(16)} not allowed in this direction`);
    }
    return decodePayload(header.type, plaintext);
  }
}
