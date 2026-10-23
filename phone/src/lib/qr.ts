/**
 * QR decoding in JavaScript only, never on a server (PHONE-10): the platform's BarcodeDetector
 * where it reads QR codes, otherwise jsQR (Apache-2.0), loaded only when the scanner opens.
 */
type JsQr = (data: Uint8ClampedArray, width: number, height: number, opts?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null;

export interface Frame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Decodes one RGBA frame with jsQR; null when there is no readable code. */
export function decodeFrame(jsQR: JsQr, frame: Frame): string | null {
  const r = jsQR(frame.data, frame.width, frame.height, { inversionAttempts: "attemptBoth" });
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

/** A decoder for video frames: BarcodeDetector when it supports QR, else jsQR on a canvas. */
export async function createVideoDecoder(): Promise<VideoDecoder> {
  const BD = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (BD) {
    try {
      const formats = (await BD.getSupportedFormats?.()) ?? ["qr_code"];
      if (formats.includes("qr_code")) {
        const detector = new BD({ formats: ["qr_code"] });
        return async (video) => {
          const found = await detector.detect(video);
          return found[0]?.rawValue ?? null;
        };
      }
    } catch {
      /* fall back to jsQR */
    }
  }
  const jsQR = (await import("jsqr")).default as unknown as JsQr;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return async (video) => {
    if (!ctx || !video.videoWidth) return null;
    const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return decodeFrame(jsQR, img);
  };
}
