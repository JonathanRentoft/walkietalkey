// select-xcode.sh against a fake /Applications with fake xcrun and xcodebuild, so it runs on any
// machine. Run with `bun test scripts/walkietalkey/ci`.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "select-xcode.sh");

let root: string;
let bin: string;

/** A fake Xcode at <root>/Xcode_<version>.app whose `xcodebuild -version` prints `build`. */
function fakeXcode(version: string, build: string, sdk = "MacOSX26.5.sdk") {
  const dev = join(root, `Xcode_${version}.app`, "Contents", "Developer");
  const sdkDir = join(dev, "Platforms/MacOSX.platform/Developer/SDKs", sdk);
  mkdirSync(sdkDir, { recursive: true });
  writeFileSync(join(dev, "fake-build"), build);
  writeFileSync(join(dev, "fake-sdk"), sdkDir);
  return { dev, sdkDir };
}

function run(args: string[], env: Record<string, string> = {}) {
  const githubEnv = join(root, "github-env");
  writeFileSync(githubEnv, "");
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      WT_XCODE_ROOT: root,
      GITHUB_ENV: githubEnv,
      ...env,
    },
  });
  return { ...result, githubEnv: readFileSync(githubEnv, "utf8") };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wt-xcode-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  // The fakes read what the selected Xcode (DEVELOPER_DIR) says about itself.
  writeFileSync(
    join(bin, "xcodebuild"),
    '#!/bin/bash\n[ "$1" = "-version" ] || exit 2\necho "Xcode fake"\necho "Build version $(cat "$DEVELOPER_DIR/fake-build")"\n',
  );
  writeFileSync(
    join(bin, "xcrun"),
    '#!/bin/bash\ncase "$*" in\n  "--sdk macosx --show-sdk-path") cat "$DEVELOPER_DIR/fake-sdk" ;;\n  "--sdk macosx --show-sdk-version") echo 26.5 ;;\n  *) exit 2 ;;\nesac\n',
  );
  chmodSync(join(bin, "xcodebuild"), 0o755);
  chmodSync(join(bin, "xcrun"), 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("select-xcode.sh", () => {
  test("selects the pinned Xcode and its own SDK, and exports both", () => {
    const { dev, sdkDir } = fakeXcode("26.6", "17F113");
    fakeXcode("26.5", "17F42");
    const r = run(["26.6"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.githubEnv, `DEVELOPER_DIR=${dev}\nSDKROOT=${sdkDir}\n`);
    assert.match(r.stdout, /Xcode 26\.6 \(17F113\), macOS SDK 26\.5/);
  });

  test("defaults to WT_XCODE_VERSION", () => {
    const { dev } = fakeXcode("26.5", "17F42");
    const r = run([], { WT_XCODE_VERSION: "26.5" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.githubEnv, new RegExp(`^DEVELOPER_DIR=${dev}\n`));
  });

  test("fails, naming the Xcodes it has, when the pinned one is missing", () => {
    fakeXcode("26.5", "17F42");
    const r = run(["26.6"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /Xcode 26\.6 is not on this runner/);
    assert.match(r.stdout + r.stderr, /Xcode_26\.5\.app/);
    assert.equal(r.githubEnv, "");
  });

  test("refuses a beta Xcode (build number ending in a letter)", () => {
    fakeXcode("27.0", "18A5241e");
    const r = run(["27.0"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /beta/);
    assert.equal(r.githubEnv, "");
  });

  test("refuses an SDK outside the selected Xcode, such as the Command Line Tools'", () => {
    const { dev } = fakeXcode("26.6", "17F113");
    writeFileSync(
      join(dev, "fake-sdk"),
      "/Library/Developer/CommandLineTools/SDKs/MacOSX27.0.sdk",
    );
    const r = run(["26.6"]);
    assert.notEqual(r.status, 0);
    assert.match(r.stdout + r.stderr, /not the SDK of Xcode 26\.6/);
    assert.equal(r.githubEnv, "");
  });
});
