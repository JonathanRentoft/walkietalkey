// Hands the microphone's samples to the page in blocks of 2048 frames (about 43 ms at 48 kHz),
// mixed down to mono. Nothing is written to the output, so nothing is heard.
const BLOCK = 2048;

class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (channels && channels.length > 0) {
      const frames = channels[0].length;
      const n = channels.length;
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < n; c++) sum += channels[c][i];
        this.block[this.filled++] = sum / n;
        if (this.filled === BLOCK) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(BLOCK);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("capture", Capture);
