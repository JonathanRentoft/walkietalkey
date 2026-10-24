/** The fake microphone's test signal and the checks on what the computer received. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SIGNAL_RATE = 16000;
/** A 2 s loop of 20 tones (100 ms each) at pseudo-random speech-band frequencies. */
export const SIGNAL_SAMPLES = 2 * SIGNAL_RATE;

export function testSignal(): Int16Array {
  const out = new Int16Array(SIGNAL_SAMPLES);
  const seg = SIGNAL_RATE / 10;
  const ramp = 80;
  let x = 12345;
  for (let k = 0; k < 20; k++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const f = 300 + (x % 2700);
    for (let i = 0; i < seg; i++) {
      const env = Math.min(1, i / ramp, (seg - 1 - i) / ramp);
      out[k * seg + i] = Math.round(
        0.45 * 32767 * env * Math.sin((2 * Math.PI * f * i) / SIGNAL_RATE),
      );
    }
  }
  return out;
}

export function wavBytes(pcm: Int16Array, rate = SIGNAL_RATE): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) =>
    [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + pcm.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i]!, true);
  return out;
}

export const TMP = join(dirname(fileURLToPath(import.meta.url)), ".tmp");

/** Writes the signal as a 16 kHz WAV for Chromium's --use-file-for-fake-audio-capture. */
export function ensureTestWav(): string {
  mkdirSync(TMP, { recursive: true });
  const path = join(TMP, "signal-16k.wav");
  // Loop the 2 s signal a few times; Chrome loops the file too.
  const sig = testSignal();
  const long = new Int16Array(sig.length * 5);
  for (let i = 0; i < 5; i++) long.set(sig, i * sig.length);
  writeFileSync(path, wavBytes(long));
  return path;
}

export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 2, true);
  return out;
}

export function rms(x: Int16Array): number {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / Math.max(1, x.length)) / 32768;
}

/**
 * Best normalised cross-correlation between a window of the received audio and the looping
 * source signal, over every circular lag. 1.0 means the same waveform (up to gain).
 */
export function bestCorrelation(
  received: Int16Array,
  source = testSignal(),
  from = 6400,
  length = 4000,
): number {
  const w = received.subarray(from, from + length);
  if (w.length < length) return 0;
  let wn = 0;
  for (const v of w) wn += v * v;
  const n = source.length;
  let best = 0;
  for (let lag = 0; lag < n; lag++) {
    let dot = 0;
    let sn = 0;
    for (let i = 0; i < length; i++) {
      const s = source[(lag + i) % n]!;
      dot += w[i]! * s;
      sn += s * s;
    }
    const c = dot / Math.sqrt(wn * sn || 1);
    if (c > best) best = c;
  }
  return best;
}
