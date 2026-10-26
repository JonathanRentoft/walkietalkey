import { rmSync } from "node:fs";

/** Removes the temporary folders of this Værkstedet run (studio.config.ts). */
export default function teardown() {
  const work = process.env.WT_STUDIO_E2E;
  if (work && work.includes("wt-studio-e2e-"))
    rmSync(work, { recursive: true, force: true });
}
