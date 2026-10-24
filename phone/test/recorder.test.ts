/* A press must never wait on a microphone that is not ready (PHONE-26, PHONE-30). Opening the
   microphone can stall: a permission prompt nobody has answered, or an engine that only starts
   its audio on a gesture. A start still waiting when the press ends (stop) or is cancelled
   (abort) gives up at once, so the dictation ends instead of hanging at "Sender til". */
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
  if (realMediaDevices)
    Object.defineProperty(navigator, "mediaDevices", realMediaDevices);
  else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
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
