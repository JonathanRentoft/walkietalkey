/**
 * Init script for pages under test. WebKit has no fake-media flags, so the microphone is replaced
 * by a MediaStream from an AudioContext that loops the test signal; the camera (both engines) by
 * a canvas stream that shows a QR code. `standalone` makes an iPhone user agent look like the
 * home-screen app (PHONE-04).
 */
export interface FakeMediaConfig {
  /** base64 of 16 kHz PCM16 little-endian, looped. */
  audio?: string;
  denyMic?: boolean;
  /** QR modules, row-major '0'/'1'. */
  qr?: { size: number; bits: string };
  standalone?: boolean;
}

/** Runs in the page (serialised by Playwright): no imports, no closures. */
export function installFakeMedia(cfg: FakeMediaConfig): void {
  const w = window as unknown as Record<string, unknown>;
  if (cfg.standalone) {
    try {
      Object.defineProperty(Navigator.prototype, "standalone", {
        get: () => true,
        configurable: true,
      });
    } catch {
      /* ignore */
    }
  }
  const md = navigator.mediaDevices;
  if (!md) return;
  const orig = md.getUserMedia ? md.getUserMedia.bind(md) : null;
  let ctx: AudioContext | null = null;

  async function audioStream(): Promise<MediaStream> {
    const bin = atob(cfg.audio!);
    const n = bin.length >> 1;
    ctx = ctx ?? new AudioContext();
    const buf = ctx.createBuffer(1, n, 16000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 32768) v -= 65536;
      ch[i] = v / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    src.start();
    if (ctx.state !== "running") await ctx.resume().catch(() => undefined);
    w.__wtFakeMic = ((w.__wtFakeMic as number) || 0) + 1;
    return dest.stream;
  }

  function qrStream(): MediaStream {
    const q = cfg.qr!;
    const scale = 6;
    const quiet = 4;
    const side = (q.size + quiet * 2) * scale;
    const canvas = document.createElement("canvas");
    canvas.width = side + 160;
    canvas.height = side + 80;
    const g = canvas.getContext("2d")!;
    let t = 0;
    const draw = () => {
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = "#000000";
      for (let y = 0; y < q.size; y++)
        for (let x = 0; x < q.size; x++)
          if (q.bits[y * q.size + x] === "1")
            g.fillRect(
              80 + (quiet + x) * scale,
              40 + (quiet + y) * scale,
              scale,
              scale,
            );
      // A pixel that changes, so the stream keeps producing frames.
      g.fillStyle = t++ % 2 ? "#fefefe" : "#ffffff";
      g.fillRect(0, 0, 1, 1);
    };
    draw();
    setInterval(draw, 100);
    return (
      canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }
    ).captureStream(10);
  }

  md.getUserMedia = async (c?: MediaStreamConstraints) => {
    if (c?.video && cfg.qr) return qrStream();
    if (c?.audio) {
      if (cfg.denyMic)
        throw new DOMException("Permission denied", "NotAllowedError");
      if (cfg.audio) return audioStream();
    }
    if (orig) return orig(c);
    throw new DOMException("No device", "NotFoundError");
  };
}
