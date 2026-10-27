/* A living background of the front page, as one React island: the hero's BarField or the night panel's FluidMesh.
   The page keeps only one of them running at a time (front.ts: the most visible one): it sets data-paused on the background's host ([data-fp-bg]), and this island
   hands that to the design system's surface as its `paused` prop. Until the island has looked, it starts paused, so
   nothing moves before the page has decided.
   The WebGL surface starts one idle moment after the island has hydrated: until then the island holds the same empty
   canvas the server rendered, so hydrating and compiling the shader are two short tasks instead of one long one. */
import {
  BarField,
  FluidMesh,
  type BarFieldProps,
  type FluidMeshProps,
} from "@walkietalkey/ui";
import { useEffect, useRef, useState } from "react";

export type LiveProps =
  | ({ kind: "mesh" } & Omit<FluidMeshProps, "paused" | "children">)
  | ({ kind: "bars" } & Omit<BarFieldProps, "paused" | "children">);

export default function Live(props: LiveProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(true);
  const [ready, setReady] = useState(props.kind === "bars");
  useEffect(() => {
    if (ready) return undefined;
    const go = () => setReady(true);
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(go, { timeout: 1200 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(go, 200);
    return () => clearTimeout(id);
  }, [ready]);
  useEffect(() => {
    const host = ref.current?.closest<HTMLElement>("[data-fp-bg]");
    if (!host) {
      setPaused(false);
      return undefined;
    }
    const read = () => setPaused(host.hasAttribute("data-paused"));
    read();
    const mo = new MutationObserver(read);
    mo.observe(host, { attributes: true, attributeFilter: ["data-paused"] });
    return () => mo.disconnect();
  }, []);
  let surface;
  if (!ready) {
    surface = (
      <div className="wt-gl">
        <canvas className="wt-gl-canvas" aria-hidden />
      </div>
    );
  } else if (props.kind === "mesh") {
    const { kind: _, ...p } = props;
    surface = <FluidMesh {...p} paused={paused} />;
  } else {
    const { kind: _, ...p } = props;
    surface = <BarField {...p} paused={paused} />;
  }
  return (
    <div ref={ref} className="fp-live">
      {surface}
    </div>
  );
}
