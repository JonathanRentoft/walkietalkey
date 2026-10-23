/** Minimal WAV (RIFF, PCM16) helpers for the scripted phone and tests. */
import { BLOCK_BYTES, SAMPLE_RATE } from "../src/index.ts";

export interface Wav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcm: Uint8Array;
}

function ascii(bytes: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + len));
}

/** Parses a RIFF/WAVE file and requires 16 kHz, mono, 16-bit PCM. */
export function parseWav(bytes: Uint8Array): Wav {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let pcm: Uint8Array | null = null;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) throw new Error(`truncated ${id} chunk`);
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      pcm = bytes.slice(body, body + size);
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !pcm) throw new Error("WAV needs fmt and data chunks");
  if (fmt.format !== 1 || fmt.channels !== 1 || fmt.sampleRate !== SAMPLE_RATE || fmt.bits !== 16) {
    throw new Error(`need 16 kHz mono PCM16, got format ${fmt.format}, ${fmt.channels} ch, ${fmt.sampleRate} Hz, ${fmt.bits} bit`);
  }
  if (pcm.length % 2 !== 0) throw new Error("odd PCM length");
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, pcm };
}

/** 44-byte header + PCM16 mono 16 kHz. */
export function encodeWav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (out[o + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + pcm.length, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/** 200 ms blocks of 6,400 bytes; only the last may be shorter. */
export function splitBlocks(pcm: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let o = 0; o < pcm.length; o += BLOCK_BYTES) out.push(pcm.slice(o, Math.min(o + BLOCK_BYTES, pcm.length)));
  return out;
}
