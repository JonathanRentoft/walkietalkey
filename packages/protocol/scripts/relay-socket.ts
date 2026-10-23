/**
 * A small queue-based client over the platform WebSocket (Node 22+, bun, browsers), used by the
 * scripted phone and the relay smoke test.
 */
import {
  PING_INTERVAL_MS,
  PING_MESSAGE,
  parseControlMessage,
  serializeControlMessage,
  type ControlMessage,
  type ControlOf,
  type ControlType,
} from "../src/index.ts";

export type Incoming = { kind: "text"; text: string; msg?: ControlMessage } | { kind: "binary"; bytes: Uint8Array };

export class RelaySocket {
  readonly queue: Incoming[] = [];
  closeInfo: { code: number; reason: string } | null = null;
  /** Called for every incoming message before it is queued; return true to consume it. */
  onMessage: ((m: Incoming) => boolean) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  private waiters: Array<() => void> = [];
  private ping: ReturnType<typeof setInterval> | null = null;
  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (e: MessageEvent) => {
      let m: Incoming;
      if (typeof e.data === "string") {
        let msg: ControlMessage | undefined;
        try {
          msg = parseControlMessage(e.data);
        } catch {
          msg = undefined;
        }
        m = { kind: "text", text: e.data, msg };
      } else {
        m = { kind: "binary", bytes: new Uint8Array(e.data as ArrayBuffer) };
      }
      if (!this.onMessage?.(m)) this.queue.push(m);
      this.wake();
    });
    ws.addEventListener("close", (e: CloseEvent) => {
      this.closeInfo = { code: e.code, reason: e.reason };
      this.stopPing();
      this.wake();
      this.onClose?.(e.code, e.reason);
    });
  }

  static open(url: string, timeoutMs = 15_000): Promise<RelaySocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const s = new RelaySocket(ws);
      const t = setTimeout(() => {
        reject(new Error(`timed out connecting to ${new URL(url).origin}`));
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve(s);
      });
      ws.addEventListener("error", () => {
        clearTimeout(t);
        // A close event follows; resolve so the caller can read the close code.
        resolve(s);
      });
    });
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  async take(match: (m: Incoming) => boolean, what: string, timeoutMs = 10_000): Promise<Incoming> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.queue.findIndex(match);
      if (i >= 0) return this.queue.splice(i, 1)[0]!;
      if (this.closeInfo) throw new SocketClosedError(this.closeInfo.code, this.closeInfo.reason, what);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }

  async control<T extends ControlType>(t: T, timeoutMs = 10_000): Promise<ControlOf<T>> {
    const m = await this.take((x) => x.kind === "text" && x.msg?.t === t, t, timeoutMs);
    return (m as { msg: ControlMessage }).msg as ControlOf<T>;
  }

  async binary(timeoutMs = 10_000): Promise<Uint8Array> {
    const m = await this.take((x) => x.kind === "binary", "a binary frame", timeoutMs);
    return (m as { bytes: Uint8Array }).bytes;
  }

  async closed(timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closeInfo) {
      if (Date.now() > deadline) throw new Error("socket did not close");
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    return this.closeInfo;
  }

  get open(): boolean {
    return this.closeInfo === null && this.ws.readyState === WebSocket.OPEN;
  }

  sendControl(msg: ControlMessage): void {
    this.ws.send(serializeControlMessage(msg));
  }

  sendBinary(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  /** RELAY-10: the exact ping string every 30 s. */
  startPing(intervalMs = PING_INTERVAL_MS): void {
    this.stopPing();
    this.ping = setInterval(() => {
      if (this.open) this.ws.send(PING_MESSAGE);
    }, intervalMs);
  }

  stopPing(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }

  close(code = 1000, reason = "bye"): void {
    this.stopPing();
    try {
      this.ws.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}

export class SocketClosedError extends Error {
  readonly code: number;
  readonly reason: string;

  constructor(code: number, reason: string, what: string) {
    super(`socket closed with ${code} (${reason}) while waiting for ${what}`);
    this.name = "SocketClosedError";
    this.code = code;
    this.reason = reason;
  }
}
