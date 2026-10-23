import { Logo } from "@walkietalkey/ui";

/** A QR-like pattern for the pairing step: decorative, not a real code (as in ForsideKomplet). Rendered on the server only. */
export default function Qr() {
  const cells = [], n = 21;
  const finder = (x: number, y: number) => (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let on: boolean;
    if (finder(x, y)) {
      const fx = x < 7 ? x : x - (n - 7), fy = y < 7 ? y : y - (n - 7);
      on = fx === 0 || fx === 6 || fy === 0 || fy === 6 || (fx >= 2 && fx <= 4 && fy >= 2 && fy <= 4);
    } else {
      const r = Math.sin((x + 1) * 12.9898 + (y + 1) * 78.233) * 43758.5453;
      on = (r - Math.floor(r)) > 0.52;
    }
    if (x >= 8 && x <= 12 && y >= 8 && y <= 12) on = false;
    cells.push(<i key={x + "-" + y} className={on ? "on" : undefined} />);
  }
  return (
    <div className="qr" role="img" aria-label="Kode til at parre telefonen">
      {cells}
      <span className="qr-mark wt-appicon"><Logo variant="mark" tone="gradient" size={20} decorative animated={false} /></span>
    </div>
  );
}
