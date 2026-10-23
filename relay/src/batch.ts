/** A buffered row is a sequence of frames, each prefixed with its length as uint32 BE. */

export function encodeBatch(frames: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const f of frames) total += 4 + f.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  for (const f of frames) {
    view.setUint32(o, f.length, false);
    out.set(f, o + 4);
    o += 4 + f.length;
  }
  return out;
}

export function decodeBatch(blob: ArrayBuffer | Uint8Array): Uint8Array[] {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  let o = 0;
  while (o + 4 <= bytes.length) {
    const len = view.getUint32(o, false);
    if (o + 4 + len > bytes.length) break;
    out.push(bytes.slice(o + 4, o + 4 + len));
    o += 4 + len;
  }
  return out;
}

/** Whether one of the frames ends a dictation (audio_end 0x22 or audio_cancel 0x23). */
export function frameListEndsDictation(frames: readonly Uint8Array[]): boolean {
  return frames.some((f) => f[1] === 0x22 || f[1] === 0x23);
}
