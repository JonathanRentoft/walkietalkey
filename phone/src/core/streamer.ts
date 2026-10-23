/**
 * Audio sessions on the wire (PHONE-31, PHONE-32). Every 200 ms block is sent while the user is
 * still talking and also kept in memory (never on disk, PHONE-33) until the computer's result
 * arrives. After a reconnect the whole open session goes again, packed and paced; the computer
 * drops duplicates by block index.
 */
import {
  SAMPLE_RATE,
  b64uEncode,
  randomBytes,
  type DevicePayload,
  type ResultReason,
} from "@walkietalkey/protocol";
import { Pacer, packBlocks } from "./resend";

/** What the streamer needs from a room's relay connection. */
export interface StreamLink {
  /** Increases with every successful authentication. */
  readonly connId: number;
  readonly connected: boolean;
  /** Seals and sends in call order; false (nothing sent) when offline. */
  send(payload: DevicePayload): Promise<boolean>;
}

export type SessionResult = { ok: true } | { ok: false; reason: ResultReason };

export interface AudioSession {
  id: Uint8Array;
  sid: string;
  roomId: string;
  /** 200 ms PCM16 blocks, in memory only. */
  blocks: Uint8Array[];
  /** 16 kHz samples so far. */
  samples: number;
  startedAt: number;
  endedAt: number | null;
  ended: boolean;
  cancelled: boolean;
  /** No result within 10 minutes (PHONE-24); resent only by "Prøv igen". */
  failed: boolean;
  result: SessionResult | null;
  /** Connection on which this session is live (audio_start sent and every block so far). -1: none. */
  conn: number;
  resending: boolean;
  endSent: boolean;
}

export function newSession(roomId: string, now: number): AudioSession {
  const id = randomBytes(16);
  return {
    id,
    sid: b64uEncode(id),
    roomId,
    blocks: [],
    samples: 0,
    startedAt: now,
    endedAt: null,
    ended: false,
    cancelled: false,
    failed: false,
    result: null,
    conn: -1,
    resending: false,
    endSent: false,
  };
}

/** Open sessions are the ones whose audio must still reach the computer. */
export function isOpen(s: AudioSession): boolean {
  return !s.cancelled && s.result === null;
}

export function durationMs(s: AudioSession): number {
  return Math.round((s.samples / SAMPLE_RATE) * 1000);
}

export class SessionStreamer {
  private readonly link: StreamLink;
  private readonly pacer: Pacer;

  constructor(link: StreamLink, pacer = new Pacer()) {
    this.link = link;
    this.pacer = pacer;
  }

  private live(s: AudioSession): boolean {
    return this.link.connected && s.conn === this.link.connId && !s.resending;
  }

  private startPayload(s: AudioSession): DevicePayload {
    return {
      type: "audio_start",
      sessionId: s.id,
      sampleRate: SAMPLE_RATE,
      codec: "pcm16",
    };
  }

  private endPayload(s: AudioSession): DevicePayload {
    return {
      type: "audio_end",
      sessionId: s.id,
      chunks: s.blocks.length,
      durationMs: durationMs(s),
    };
  }

  /** audio_start when connected; otherwise the session waits for the next connection. */
  async start(s: AudioSession): Promise<void> {
    if (!this.link.connected) return;
    const conn = this.link.connId;
    // Live at once: the link sends in call order, so blocks queued now follow audio_start.
    s.conn = conn;
    if (!(await this.link.send(this.startPayload(s))) && s.conn === conn)
      s.conn = -1;
  }

  /** Keeps the block and sends it at once if the session is live on this connection. */
  async addBlock(s: AudioSession, block: Uint8Array): Promise<void> {
    if (s.cancelled || s.ended) return;
    const index = s.blocks.length;
    s.blocks.push(block);
    s.samples += block.length / 2;
    if (!this.live(s)) return;
    if (
      !(await this.link.send({
        type: "audio_chunk",
        sessionId: s.id,
        firstIndex: index,
        pcm: block,
      }))
    )
      s.conn = -1;
  }

  /** The button was released: audio_end now if live, else with the next resend. */
  async end(s: AudioSession, now = Date.now()): Promise<void> {
    if (s.ended || s.cancelled) return;
    s.ended = true;
    s.endedAt = now;
    if (!this.live(s)) return;
    if (await this.link.send(this.endPayload(s))) s.endSent = true;
    else s.conn = -1;
  }

  /** Slid off and released (PHONE-26): tell the computer, forget the audio. */
  async cancel(s: AudioSession): Promise<void> {
    if (s.cancelled) return;
    s.cancelled = true;
    s.blocks = [];
    // Sent whenever possible: the computer may hold part of the audio from an earlier socket or
    // from the relay's buffer, and it ignores a cancel for a session it never saw.
    if (this.link.connected)
      await this.link.send({ type: "audio_cancel", sessionId: s.id });
  }

  /** After (re)authentication: every open session again, one after another, paced. */
  async resendOpen(sessions: readonly AudioSession[]): Promise<void> {
    for (const s of sessions) {
      if (!isOpen(s) || s.failed) continue;
      if (s.conn === this.link.connId && this.link.connected) continue;
      await this.resend(s);
    }
  }

  /** "Prøv igen" (PHONE-24): the whole session again from memory. */
  async retry(s: AudioSession): Promise<void> {
    if (!isOpen(s)) return;
    s.failed = false;
    s.conn = -1;
    if (this.link.connected) await this.resend(s);
  }

  /** The whole session on the current connection: audio_start, chunks of 10 blocks, audio_end. */
  async resend(s: AudioSession): Promise<void> {
    if (s.resending || !this.link.connected) return;
    const conn = this.link.connId;
    const stillHere = () =>
      this.link.connected && this.link.connId === conn && isOpen(s);
    s.resending = true;
    s.conn = -1;
    s.endSent = false;
    try {
      await this.pacer.next();
      if (!stillHere() || !(await this.link.send(this.startPayload(s)))) return;
      let i = 0;
      // Blocks recorded during the resend are picked up too; then the session is live again.
      while (i < s.blocks.length) {
        const [frame] = packBlocks(
          s.blocks.slice(0, Math.min(s.blocks.length, i + 10)),
          i,
        );
        await this.pacer.next();
        if (!stillHere() || !frame) return;
        if (
          !(await this.link.send({
            type: "audio_chunk",
            sessionId: s.id,
            firstIndex: frame.firstIndex,
            pcm: frame.pcm,
          }))
        )
          return;
        i += Math.ceil(frame.pcm.length / 6400);
      }
      s.conn = conn;
      if (s.ended) {
        await this.pacer.next();
        if (!stillHere()) {
          s.conn = -1;
          return;
        }
        if (await this.link.send(this.endPayload(s))) s.endSent = true;
        else s.conn = -1;
      }
    } finally {
      s.resending = false;
    }
  }
}
