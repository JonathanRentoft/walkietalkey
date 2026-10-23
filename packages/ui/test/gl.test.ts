import { afterEach, describe, expect, it, vi } from "vitest";
import { mountGL } from "../src/lib/gl";

/* a WebGL stand-in that records what happens to the context */
function fakeCanvas() {
  const state = { lost: false, loseCalls: 0, programs: 0, deleted: 0 };
  const ext = {
    loseContext: () => {
      state.lost = true;
      state.loseCalls += 1;
    },
  };
  const gl = new Proxy({} as Record<string, unknown>, {
    get(_, k: string) {
      if (k === "isContextLost") return () => state.lost;
      if (k === "getExtension")
        return (n: string) => (n === "WEBGL_lose_context" ? ext : null);
      if (k === "getShaderParameter" || k === "getProgramParameter")
        return () => !state.lost;
      if (k === "createProgram")
        return () => {
          state.programs += 1;
          return {};
        };
      if (k === "deleteProgram")
        return () => {
          state.deleted += 1;
        };
      if (k === "getUniformLocation") return () => ({});
      if (k === "getAttribLocation") return () => 0;
      if (/^[A-Z_]+$/.test(k)) return 1;
      return () => ({});
    },
  });
  const canvas = document.createElement("canvas");
  canvas.getContext = (() => gl) as unknown as typeof canvas.getContext;
  const wrap = document.createElement("div");
  wrap.appendChild(canvas);
  return { canvas, wrap, state };
}

describe("mountGL", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the context when an effect re-runs on the same canvas (hydration, reduced motion switching)", () => {
    vi.useFakeTimers();
    const { canvas, wrap, state } = fakeCanvas();
    const first = mountGL(wrap, canvas, "void main(){}", { still: true })!;
    expect(first).not.toBeNull();
    first.cleanup();
    const second = mountGL(wrap, canvas, "void main(){}", { still: true });
    expect(second).not.toBeNull();
    vi.runAllTimers();
    expect(state.loseCalls).toBe(0);
    expect(state.deleted).toBe(1);
    second!.cleanup();
    vi.runAllTimers();
    expect(state.loseCalls).toBe(1);
    expect(state.deleted).toBe(2);
  });

  it("falls back (returns null) when the context is already lost", () => {
    const { canvas, wrap, state } = fakeCanvas();
    state.lost = true;
    expect(mountGL(wrap, canvas, "void main(){}", { still: true })).toBeNull();
  });
});
