/* A press must never wait on a microphone that is not ready (PHONE-26, PHONE-30). Opening the
   microphone can stall: a permission prompt nobody has answered, or an engine that only starts
   its audio on a gesture. A start still waiting when the press ends (stop) or is cancelled
   (abort) gives up at once, so the dictation ends instead of hanging at "Sender til". */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Recorder } from "../src/audio/recorder";

const realMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);

/** getUserMedia that never answers. */
function stallMicrophone(): void {
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: () => new Promise<MediaStream>(() => undefined) },
    configurable: true,
  });
}

/** "returned" when `p` settles within `ms`, else "hung". */
function settles(p: Promise<unknown>, ms = 200): Promise<string> {
  return Promise.race([
    p.then(
      () => "returned",
      () => "returned",
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("hung"), ms)),
  ]);
}

/** A microphone that opens at once. */
function fakeMicrophone(): void {
  const track = { stop: () => undefined, addEventListener: () => undefined };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: () => Promise.resolve(stream) },
    configurable: true,
  });
}

/** An AudioContext whose state changes land only when its audio thread catches up (`land()`), as
 * in WebKit: until then `state` still says what it was. */
class SlowAudioContext extends EventTarget {
  static last: SlowAudioContext;
  state: AudioContextState = "suspended";
  readonly sampleRate = 48_000;
  readonly destination = {};
  readonly audioWorklet = { addModule: () => Promise.resolve() };
  private pending: AudioContextState[] = [];
  constructor() {
    super();
    SlowAudioContext.last = this;
  }
  resume(): Promise<void> {
    this.pending.push("running");
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.pending.push("suspended");
    return Promise.resolve();
  }
  land(): void {
    for (const s of this.pending.splice(0))
      if (s !== this.state) {
        this.state = s;
        this.dispatchEvent(new Event("statechange"));
      }
  }
  createMediaStreamSource() {
    return { connect: () => undefined, disconnect: () => undefined };
  }
}

class FakeWorkletNode {
  readonly port = { onmessage: null as unknown, postMessage: () => undefined };
  connect(): void {}
  disconnect(): void {}
}

/** A recorder whose warm microphone runs, on a SlowAudioContext. */
async function warmRecorder(): Promise<[Recorder, SlowAudioContext]> {
  fakeMicrophone();
  vi.stubGlobal("window", { AudioContext: SlowAudioContext });
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  const recorder = new Recorder();
  await recorder.warm();
  const ctx = SlowAudioContext.last;
  ctx.land();
  expect(ctx.state).toBe("running");
  return [recorder, ctx];
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (realMediaDevices)
    Object.defineProperty(navigator, "mediaDevices", realMediaDevices);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
});

/* The page goes to the background (cool suspends the context) and comes straight back, before
   the suspend has landed: the state still says running. Resuming only when it did not left the
   warm microphone suspended once the suspend landed, so the next press had no audio and was
   cancelled (found by the phone e2e test in WebKit, run 4). */
describe("back from the background before the suspend has landed (PHONE-33)", () => {
  it("the warm microphone runs again", async () => {
    const [recorder, ctx] = await warmRecorder();
    recorder.cool();
    await recorder.warm();
    ctx.land();
    expect(ctx.state).toBe("running");
  });

  it("a press in that moment starts the audio again", async () => {
    const [recorder, ctx] = await warmRecorder();
    recorder.cool();
    recorder.prime();
    ctx.land();
    expect(ctx.state).toBe("running");
  });
});

describe("a start waiting for the microphone (PHONE-26, PHONE-30)", () => {
  it("gives up when the press ends", async () => {
    stallMicrophone();
    const recorder = new Recorder();
    const blocks: Uint8Array[] = [];
    const started = recorder.start((b) => blocks.push(b));
    await recorder.stop();
    expect(await settles(started)).toBe("returned");
    expect(blocks).toHaveLength(0);
  });

  it("gives up when the press is cancelled", async () => {
    stallMicrophone();
    const recorder = new Recorder();
    const started = recorder.start(() => undefined);
    recorder.abort();
    expect(await settles(started)).toBe("returned");
  });

  it("a warm open that is still stalled does not stop the next press from giving up", async () => {
    stallMicrophone();
    const recorder = new Recorder();
    void recorder.warm();
    const first = recorder.start(() => undefined);
    await recorder.stop();
    expect(await settles(first)).toBe("returned");
    const second = recorder.start(() => undefined);
    await recorder.stop();
    expect(await settles(second)).toBe("returned");
  });
});
