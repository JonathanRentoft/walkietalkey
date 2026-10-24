import { rmSync } from "node:fs";

/** Removes the temporary sentence list and recordings of this run. */
export default function teardown() {
  const work = process.env.WT_RECORDER_E2E;
  if (work && work.includes("wt-recorder-e2e-"))
    rmSync(work, { recursive: true, force: true });
}
