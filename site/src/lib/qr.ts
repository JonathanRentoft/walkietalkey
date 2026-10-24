/* A real QR code as inline SVG, drawn at build time with `qrcode` (MIT), so the page runs no QR code and loads nothing
   (SITE-04). The modules are drawn in currentColor without a background: the element around it gives the light
   background and the quiet zone. */
import QRCode from "qrcode";

export async function qrSvg(text: string, label: string): Promise<string> {
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 0,
    color: { dark: "#000000ff", light: "#00000000" },
  });
  const escaped = label.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return svg
    .trim()
    .replace('stroke="#000000"', 'stroke="currentColor"')
    .replace(
      "<svg ",
      `<svg role="img" aria-label="${escaped}" focusable="false" `,
    );
}
