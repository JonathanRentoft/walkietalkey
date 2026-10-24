/**
 * Microphone capture (PHONE-30, PHONE-35): getUserMedia, an AudioWorklet, then CaptureSink and
 * PcmPipeline to 16 kHz PCM16 in 200 ms blocks. Audio stays in memory (PHONE-33).
 *
 * The microphone is raw: no echo cancellation, noise suppression or automatic gain. On iOS those
 * three switch on the phone-call chain, which gates pauses to digital silence and pumps the
 * level; speech recognition wants the plain microphone (run 2, Phase 0).
 *
 * warm() opens the microphone before the button is pressed and keeps the newest 300 ms in memory
 * (src/audio/capture.ts), so a dictation starts with the audio from just before the press; the
 * controller decides when (src/core/controller.ts, micPolicy). cool() closes it again. The
 * AudioContext is created and resumed on the first touch, because browsers only start audio
 * after a user gesture (iOS also lets a page that is capturing start it).
 */
import workletUrl from "./capture-worklet.js?url";
import { CaptureSink } from "./capture";
import type { BlockSink } from "./pcm";

/** Ask for the raw microphone (run 2, Phase 0: the iOS voice chain cost the first words). */
export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: 1,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

export class MicDeniedError extends Error {
  constructor() {
    super("microphone permission denied");
    this.name = "MicDeniedError";
  }
}

export class MicError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`microphone failed: ${detail}`);
    this.name = "MicError";
    this.detail = detail;
  }
}

/** The microphone was closed (cool) while it was being opened. */
class Closed extends Error {}

/** What the controller needs; the tests use a fake. */
export interface RecorderLike {
  /** Call synchronously in a pointerdown: creates and resumes the AudioContext. */
  prime(): void;
  /**
   * Opens the microphone ahead of a press and keeps the last 300 ms in memory. Rejects with
   * MicDeniedError or MicError; the caller may ignore that (start() reports it again).
   */
  warm(): Promise<void>;
  /** Closes the microphone and forgets the pre-roll (page hidden, idle, not paired). */
  cool(): void;
  /**
   * Starts a dictation with the pre-roll; `onBlock` gets every 200 ms block with its RMS (for the
   * level meter). Opens the microphone first if it is not warm. Throws MicDeniedError or MicError.
   */
  start(onBlock: BlockSink): Promise<void>;
  /** Ends the dictation and delivers the last (shorter) block before resolving. The microphone stays open. */
  stop(): Promise<void>;
  /** Ends the dictation without delivering anything more. The microphone stays open. */
  abort(): void;
}

type AudioContextCtor = typeof AudioContext;

interface Capture {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  sink: CaptureSink;
  flushed: (() => void) | null;
}

export class Recorder implements RecorderLike {
  private ctx: AudioContext | null = null;
  private module: Promise<void> | null = null;
  private capture: Capture | null = null;
  private opening: Promise<Capture> | null = null;
  /** Changes on cool(); an opening that started before it is thrown away. */
  private openGen = 0;
  /** Changes on abort() and on every start(); a start that was overtaken does nothing. */
  private startGen = 0;
  /**
   * Ends the wait of a start() whose microphone is still opening. Opening can stall (a permission
   * prompt nobody has answered, an engine that starts audio only on a gesture); stop() and
   * abort() call this, so a press never waits on it and the dictation ends instead of hanging.
   */
  private giveUp: (() => void) | null = null;

  prime(): void {
    const ctx = this.context();
    if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
  }

  private context(): AudioContext {
    if (!this.ctx) {
      const AC: AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: AudioContextCtor })
          .webkitAudioContext;
      const ctx = new AC({ latencyHint: "interactive" });
      // An interruption suspends the context without ending the track (PHONE-33): what the
      // pre-roll holds from before it must never start a later dictation (capture.ts).
      ctx.addEventListener("statechange", () => {
        const sink = this.capture?.sink;
        if (ctx.state !== "running" && sink && !sink.recording) sink.clear();
      });
      this.ctx = ctx;
    }
    this.module ??= this.ctx.audioWorklet
      .addModule(workletUrl)
      .catch((e: unknown) => {
        this.module = null;
        throw e;
      });
    return this.ctx;
  }

  async warm(): Promise<void> {
    try {
      await this.open();
    } catch (e) {
      if (e instanceof Closed) return;
      throw e;
    }
  }

  cool(): void {
    this.openGen++;
    this.opening = null;
    const cap = this.capture;
    this.capture = null;
    if (cap) teardown(cap);
    // Nothing to process until the next warm(); iOS also stops its audio thread.
    if (this.ctx?.state === "running")
      void this.ctx.suspend().catch(() => undefined);
  }

  async start(onBlock: BlockSink): Promise<void> {
    const gen = ++this.startGen;
    this.giveUp?.();
    let cap: Capture | null;
    try {
      cap = await Promise.race([
        this.open(),
        new Promise<null>((resolve) => {
          this.giveUp = () => resolve(null);
        }),
      ]);
    } catch (e) {
      if (e instanceof Closed) return;
      throw e;
    } finally {
      if (gen === this.startGen) this.giveUp = null;
    }
    if (!cap || gen !== this.startGen || cap !== this.capture) return;
    cap.sink.begin(onBlock);
  }

  async stop(): Promise<void> {
    this.startGen++;
    this.giveUp?.();
    this.giveUp = null;
    const cap = this.capture;
    if (!cap || !cap.sink.recording) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 600);
      cap.flushed = () => {
        clearTimeout(t);
        resolve();
      };
      cap.node.port.postMessage("flush");
    });
    cap.flushed = null;
    cap.sink.end();
  }

  abort(): void {
    this.startGen++;
    this.giveUp?.();
    this.giveUp = null;
    this.capture?.sink.drop();
  }

  /** The open microphone, opening it once if needed. */
  private open(): Promise<Capture> {
    if (this.capture) return Promise.resolve(this.capture);
    this.opening ??= this.openOnce(this.openGen).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openOnce(gen: number): Promise<Capture> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: MIC_CONSTRAINTS,
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "Error";
      if (
        name === "NotAllowedError" ||
        name === "SecurityError" ||
        name === "PermissionDeniedError"
      )
        throw new MicDeniedError();
      throw new MicError(name);
    }
    const stopTracks = () => {
      for (const t of stream.getTracks()) t.stop();
    };
    if (gen !== this.openGen) {
      stopTracks();
      throw new Closed();
    }
    let ctx: AudioContext;
    try {
      ctx = this.context();
      await this.module;
    } catch (e) {
      stopTracks();
      throw new MicError(e instanceof Error ? e.name : "AudioWorklet");
    }
    if (gen !== this.openGen) {
      stopTracks();
      throw new Closed();
    }
    // Allowed without a gesture while capturing (WebKit); otherwise the next touch (prime) does it.
    if (ctx.state !== "running") void ctx.resume().catch(() => undefined);
    const sink = new CaptureSink(ctx.sampleRate);
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "wt-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const cap: Capture = { stream, source, node, sink, flushed: null };
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) sink.push(e.data);
      else if (e.data === "flushed") cap.flushed?.();
    };
    source.connect(node);
    // The processor writes nothing to its output; connecting it keeps every engine pulling it.
    node.connect(ctx.destination);
    // The system took the microphone (a phone call, another app): open it again next time.
    for (const t of stream.getAudioTracks())
      t.addEventListener("ended", () => {
        if (this.capture !== cap) return;
        this.capture = null;
        cap.flushed?.();
        if (sink.recording) sink.end();
        teardown(cap);
      });
    this.capture = cap;
    return cap;
  }
}

function teardown(cap: Capture): void {
  try {
    cap.source.disconnect();
    cap.node.disconnect();
  } catch {
    /* already disconnected */
  }
  cap.node.port.postMessage("stop");
  cap.node.port.onmessage = null;
  cap.sink.drop();
  for (const t of cap.stream.getTracks()) t.stop();
}
