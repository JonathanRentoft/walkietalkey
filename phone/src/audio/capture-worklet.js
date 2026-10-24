/* AudioWorklet processor (PHONE-30): mixes the microphone to mono and hands batches of float
   samples at the context's rate to the main thread, which keeps the newest 300 ms between
   dictations and downsamples a dictation to 16 kHz PCM16 in 200 ms blocks (src/audio/capture.ts,
   src/audio/pcm.ts). Nothing is stored. "flush" sends what is left and answers "flushed", so the
   end of the last word is never lost. Batches of 1,024 samples (21 ms at 48 kHz) keep the
   pre-roll close to the moment of the press. */
const BATCH = 1024;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BATCH);
    this.n = 0;
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data === "flush") {
        this.send();
        this.port.postMessage("flushed");
      } else if (e.data === "stop") {
        this.active = false;
      }
    };
  }

  send() {
    if (this.n === 0) return;
    const out = this.buf.slice(0, this.n);
    this.port.postMessage(out, [out.buffer]);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const channels = input.length;
      const frames = input[0].length;
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += input[c][i];
        this.buf[this.n++] = s / channels;
        if (this.n === BATCH) this.send();
      }
    }
    return this.active;
  }
}

registerProcessor("wt-capture", CaptureProcessor);
