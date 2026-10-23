import { describe, expect, it } from "vitest";
import jsQR from "jsqr";
import QRCode from "qrcode";
import { encodePairingUrl, generateDeviceKeys, randomBytes } from "@walkietalkey/protocol";
import { decodeFrame } from "../src/lib/qr";
import { parseScanned } from "../src/lib/pairingLink";

/** Renders a QR code as an RGBA frame, `scale` pixels per module, with a quiet zone. */
function render(text: string, scale = 4, invert = false) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 4;
  const size = (n + quiet * 2) * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(my, mx) === 1;
      const v = dark !== invert ? 0 : 255;
      const o = (y * size + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

describe("QR decoding in JavaScript (PHONE-10)", () => {
  it("reads a pairing code shown by the computer", async () => {
    const computer = await generateDeviceKeys();
    const url = encodePairingUrl("https://app.walkietalkey.com", {
      v: 1,
      r: randomBytes(16),
      a: randomBytes(32),
      s: randomBytes(32),
      e: computer.agreementSpki,
      u: "wss://walkietalkey-relay.jonathan0912.workers.dev",
      n: "Jonathans MacBook Pro",
      o: "win",
    });
    const text = decodeFrame(jsQR as never, render(url));
    expect(text).toBe(url);
    expect(parseScanned(text!).o).toBe("win");
  });

  it("reads a light-on-dark code (dark mode screens)", () => {
    expect(decodeFrame(jsQR as never, render("https://app.walkietalkey.com/p#abc", 4, true))).toBe("https://app.walkietalkey.com/p#abc");
  });

  it("returns null when there is no code", () => {
    const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
    expect(decodeFrame(jsQR as never, blank)).toBeNull();
  });
});
