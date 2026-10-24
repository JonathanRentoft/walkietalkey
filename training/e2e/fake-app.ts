import { existsSync, readFileSync } from "node:fs";

/* The WalkieTalkey app's side of a recorder session, played by the spec: what the desktop
   module (src-tauri/src/walkietalkey/relay/training) does against the recorder's API
   (training/wt_train/recorder/server.py). The recorder writes its link to a file
   (--app-url-file) instead of handing it to a running app. */

export interface Command {
  seq: number;
  type: string;
  [key: string]: unknown;
}

export class FakeApp {
  readonly base: string;
  private readonly token: string;
  after = 0;
  readonly seen: Command[] = [];

  constructor(url: string) {
    const [base, token] = url.trim().split("#");
    this.base = base!;
    this.token = token!;
  }

  /** Waits for the recorder to write its link. */
  static async fromFile(path: string, timeoutMs = 20_000): Promise<FakeApp> {
    const t0 = Date.now();
    while (!existsSync(path)) {
      if (Date.now() - t0 > timeoutMs)
        throw new Error(`no app link in ${path}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    return new FakeApp(readFileSync(path, "utf8"));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...extra };
  }

  async hello(phones: unknown[]): Promise<Response> {
    return fetch(`${this.base}/hello`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        app: "walkietalkey",
        version: "0.3.0",
        os: "mac",
        phones,
        input: "MacBook Pro-mikrofon",
      }),
    });
  }

  /** The next command of `type` (and matching `ok`), long-polling as the app does. */
  async next(
    type: string,
    ok: (c: Command) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<Command> {
    const t0 = Date.now();
    for (;;) {
      const found = this.seen.find((c) => c.type === type && ok(c));
      if (found) {
        this.seen.splice(this.seen.indexOf(found), 1);
        return found;
      }
      if (Date.now() - t0 > timeoutMs)
        throw new Error(
          `no ${type} command; seen: ${JSON.stringify(this.seen)}`,
        );
      const r = await fetch(`${this.base}/next?after=${this.after}&wait=1`, {
        headers: this.headers(),
      });
      const { commands } = (await r.json()) as { commands: Command[] };
      for (const c of commands) {
        this.after = Math.max(this.after, c.seq);
        this.seen.push(c);
      }
    }
  }

  async take(
    meta: Record<string, unknown>,
    pcm: Buffer,
  ): Promise<{
    saved: boolean;
    check: string;
    replaced: boolean;
  }> {
    const r = await fetch(`${this.base}/takes`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/octet-stream",
        "X-WT-Take": Buffer.from(JSON.stringify(meta)).toString("base64url"),
      }),
      body: pcm,
    });
    if (!r.ok) throw new Error(`take refused: ${r.status} ${await r.text()}`);
    return r.json() as Promise<{
      saved: boolean;
      check: string;
      replaced: boolean;
    }>;
  }

  async event(ev: Record<string, unknown>): Promise<void> {
    await fetch(`${this.base}/events`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(ev),
    });
  }
}

/** 16-bit PCM samples of a 16 kHz mono WAV, from `seconds` on, for `length` seconds. */
export function pcmOf(path: string, from = 0, length = 3): Buffer {
  const b = readFileSync(path);
  for (let at = 12; at + 8 <= b.length;) {
    const id = b.toString("ascii", at, at + 4);
    const size = b.readUInt32LE(at + 4);
    if (id === "data") {
      const start = at + 8 + Math.round(from * 16000) * 2;
      return b.subarray(
        start,
        Math.min(at + 8 + size, start + Math.round(length * 16000) * 2),
      );
    }
    at += 8 + size + (size % 2);
  }
  throw new Error(`${path}: no data chunk`);
}
