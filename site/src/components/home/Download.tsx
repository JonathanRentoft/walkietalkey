import { LogoLoader, useReducedMotion } from "@walkietalkey/ui";
import { useEffect, useState } from "react";

/** Step 1 of ForsideKomplet: the model download, LogoLoader "fyld" with a progress that keeps filling.
    With reduced motion it stands still on a finished download. */
export default function Download() {
  const reduced = useReducedMotion();
  const [p, setP] = useState(0.12);
  useEffect(() => {
    if (reduced) {
      setP(1);
      return undefined;
    }
    const id = setInterval(() => {
      setP((v) =>
        v >= 1 ? 0.06 : Math.min(1, v + 0.05 + Math.random() * 0.08),
      );
    }, 500);
    return () => {
      clearInterval(id);
    };
  }, [reduced]);
  return (
    <div className="dl">
      <LogoLoader
        variant="fyld"
        size={84}
        progress={p}
        label="Henter dansk talemodel"
      />
      <span className="dl-meta">
        {p >= 1
          ? "Talemodellen er klar"
          : "Henter dansk talemodel · " + Math.round(p * 100) + " %"}
      </span>
    </div>
  );
}
