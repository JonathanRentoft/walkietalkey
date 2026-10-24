/**
 * QR decoding in JavaScript only, never on a server (PHONE-10): the platform's BarcodeDetector
 * where it reads QR codes, otherwise jsQR (Apache-2.0), loaded only when needed. A detector that
 * hangs or fails (seen with headless Chrome on macOS) is dropped for jsQR.
 */
type JsQr = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: {
    inversionAttempts?:
      "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst";
  },
) => { data: string } | null;

export interface Frame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decodes one RGBA frame with jsQR; null when there is no readable code. */
export function decodeFrame(jsQR: JsQr, frame: Frame): string | null {
  const r = jsQR(frame.data, frame.width, frame.height, {
    inversionAttempts: "attemptBoth",
  });
  return r?.data ? r.data : null;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}
interface BarcodeDetectorCtor {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

export type VideoDecoder = (video: HTMLVideoElement) => Promise<string | null>;

const TIMEOUT = Symbol("timeout");

function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return Promise.race([
    p,
    new Promise<typeof TIMEOUT>((resolve) =>
      setTimeout(() => resolve(TIMEOUT), ms),
    ),
  ]);
}

async function platformDetector(): Promise<BarcodeDetectorLike | null> {
  const BD = (
    globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
  ).BarcodeDetector;
  if (!BD) return null;
  try {
    const formats = BD.getSupportedFormats
      ? await within(BD.getSupportedFormats(), 1000)
      : ["qr_code"];
    if (formats === TIMEOUT || !formats.includes("qr_code")) return null;
    return new BD({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

/** A decoder for video frames: BarcodeDetector when it works, else jsQR on a canvas. */
export async function createVideoDecoder(): Promise<VideoDecoder> {
  let detector = await platformDetector();
  let failures = 0;
  let jsQR: JsQr | null = null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const withJsQr = async (video: HTMLVideoElement): Promise<string | null> => {
    jsQR ??= (await import("jsqr")).default as unknown as JsQr;
    if (!ctx || !video.videoWidth) return null;
    const scale = Math.min(
      1,
      720 / Math.max(video.videoWidth, video.videoHeight),
    );
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return decodeFrame(
      jsQR,
      ctx.getImageData(0, 0, canvas.width, canvas.height),
    );
  };

  return async (video) => {
    if (detector) {
      try {
        const found = await within(detector.detect(video), 1500);
        if (found !== TIMEOUT) {
          failures = 0;
          return found[0]?.rawValue ?? null;
        }
      } catch {
        /* counted below */
      }
      if (++failures >= 2) detector = null;
    }
    return withJsQr(video);
  };
}
