/**
 * Microphone capture (PHONE-30, PHONE-35): getUserMedia, an AudioWorklet, then PcmPipeline to
 * 16 kHz PCM16 in 200 ms blocks. Audio stays in memory (PHONE-33). The AudioContext is created
 * and resumed on the first touch, because browsers only start audio after a user gesture.
 */
import workletUrl from "./capture-worklet.js?url";
import { PcmPipeline, type BlockSink } from "./pcm";

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

/** What the controller needs; the tests use a fake. */
export interface RecorderLike {
  /** Call synchronously in the first pointerdown: creates and resumes the AudioContext. */
  prime(): void;
  /**
   * Starts the microphone; `onBlock` gets every 200 ms block with its RMS (for the level meter).
   * Throws MicDeniedError or MicError.
   */
  start(onBlock: BlockSink): Promise<void>;
  /** Stops and delivers the last (shorter) block before resolving. */
  stop(): Promise<void>;
  /** Stops without delivering anything more. */
  abort(): void;
}

type AudioContextCtor = typeof AudioContext;

export class Recorder implements RecorderLike {
  private ctx: AudioContext | null = null;
  private module: Promise<void> | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private pipeline: PcmPipeline | null = null;
  private flushed: (() => void) | null = null;
  /** Set by abort() during a start that is still waiting for the microphone. */
  private generation = 0;

  prime(): void {
    if (!this.ctx) {
      const AC: AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: AudioContextCtor })
          .webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
    }
    if (this.ctx.state !== "running")
      void this.ctx.resume().catch(() => undefined);
    this.module ??= this.ctx.audioWorklet
      .addModule(workletUrl)
      .catch((e: unknown) => {
        this.module = null;
        throw e;
      });
  }

  async start(onBlock: BlockSink): Promise<void> {
    this.teardown();
    const gen = ++this.generation;
    this.prime();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
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
    if (gen !== this.generation) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    const ctx = this.ctx!;
    try {
      await this.module;
      if (ctx.state !== "running") await ctx.resume();
    } catch (e) {
      for (const t of stream.getTracks()) t.stop();
      throw new MicError(e instanceof Error ? e.name : "AudioWorklet");
    }
    if (gen !== this.generation) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    this.pipeline = new PcmPipeline(ctx.sampleRate, onBlock);
    this.source = ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(ctx, "wt-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.node.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) this.pipeline?.push(e.data);
      else if (e.data === "flushed") this.flushed?.();
    };
    this.source.connect(this.node);
    // The processor writes nothing to its output; connecting it keeps every engine pulling it.
    this.node.connect(ctx.destination);
  }

  async stop(): Promise<void> {
    const node = this.node;
    const pipeline = this.pipeline;
    if (!node || !pipeline) {
      this.abort();
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 600);
      this.flushed = () => {
        clearTimeout(t);
        resolve();
      };
      node.port.postMessage("flush");
    });
    this.flushed = null;
    pipeline.finish();
    this.teardown();
  }

  abort(): void {
    this.generation++;
    this.teardown();
  }

  private teardown(): void {
    try {
      this.source?.disconnect();
      this.node?.disconnect();
    } catch {
      /* already disconnected */
    }
    if (this.node) {
      this.node.port.postMessage("stop");
      this.node.port.onmessage = null;
    }
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.source = null;
    this.node = null;
    this.pipeline = null;
  }
}
