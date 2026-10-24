// The release assets and latest.json (OSS-21, DESK-110, DESK-112). Run with
// `bun test scripts/walkietalkey/ci`.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assemble,
  releaseNotes,
  verifyTauriSignature,
  type AssembleOptions,
} from "./release-assets.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("verifyTauriSignature", () => {
  // signed.txt.sig was made by `tauri signer sign` (tauri-cli 2.11.4) with a throwaway key whose
  // public half is updater.pub; the private key was never kept.
  const data = readFileSync(join(FIXTURES, "signed.txt"));
  const sig = readFileSync(join(FIXTURES, "signed.txt.sig"), "utf8");
  const pub = readFileSync(join(FIXTURES, "updater.pub"), "utf8");

  test("accepts a signature made by the Tauri CLI", () => {
    verifyTauriSignature(data, sig, pub);
  });

  test("rejects changed data", () => {
    assert.throws(
      () => verifyTauriSignature(Buffer.from("hello updater!\n"), sig, pub),
      /does not match/,
    );
  });

  test("rejects a signature from another key", () => {
    const other = testKey();
    assert.throws(
      () => verifyTauriSignature(data, sig, other.pubkey),
      /key 5AE5383E90141A89.*expects key/,
    );
  });

  test("rejects a changed trusted comment", () => {
    const text = Buffer.from(sig, "base64")
      .toString("utf8")
      .replace("file:payload.bin", "file:other.bin");
    assert.throws(
      () =>
        verifyTauriSignature(data, Buffer.from(text).toString("base64"), pub),
      /trusted comment/,
    );
  });
});

describe("releaseNotes", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "- next",
    "",
    "## [0.2.0] - 2026-11-01",
    "",
    "- two",
    "",
    "## [0.1.0] - 2026-10-24",
    "",
    "- one",
    "",
  ].join("\n");

  test("takes the version's own section", () => {
    assert.equal(releaseNotes(changelog, "0.2.0"), "- two\n");
    assert.equal(releaseNotes(changelog, "0.1.0"), "- one\n");
  });

  test("fails without a section for the version", () => {
    assert.throws(
      () => releaseNotes(changelog, "0.3.0"),
      /no section for 0\.3\.0/,
    );
  });
});

describe("assemble", () => {
  let dir: string;
  let key: TestKey;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-release-"));
    key = testKey();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Build outputs laid out like the build jobs' artifacts (the Tauri CLI's own names). */
  function artifacts(version = "0.1.0") {
    const mac = join(dir, "release-mac");
    const win = join(dir, "release-windows");
    mkdirSync(join(mac, "dmg"), { recursive: true });
    mkdirSync(join(mac, "macos"), { recursive: true });
    mkdirSync(join(win, "nsis"), { recursive: true });
    const files: Record<string, string> = {
      [join(mac, "dmg", `WalkieTalkey_${version}_universal.dmg`)]: "dmg",
      [join(mac, "macos", "WalkieTalkey.app.tar.gz")]: "app archive",
      [join(win, "nsis", `WalkieTalkey_${version}_x64-setup.exe`)]: "setup",
    };
    for (const [path, body] of Object.entries(files)) writeFileSync(path, body);
    signFile(key, join(mac, "macos", "WalkieTalkey.app.tar.gz"));
    signFile(key, join(win, "nsis", `WalkieTalkey_${version}_x64-setup.exe`));
    const conf = join(dir, "tauri.conf.json");
    writeFileSync(
      conf,
      JSON.stringify({ version, plugins: { updater: { pubkey: key.pubkey } } }),
    );
    return { mac, win, conf };
  }

  function options(over: Partial<AssembleOptions> = {}): AssembleOptions {
    const { mac, win, conf } = artifacts();
    return {
      tauriConf: conf,
      repo: "JonathanRentoft/walkietalkey",
      macDir: mac,
      windowsDir: win,
      outDir: join(dir, "out"),
      prerelease: false,
      pubDate: "2026-10-24T05:24:03.005Z",
      ...over,
    };
  }

  test("names every asset, adds the stable copies and a signed latest.json", () => {
    const opts = options();
    const result = assemble(opts);
    assert.equal(result.tag, "v0.1.0");
    assert.deepEqual(readdirSync(opts.outDir).sort(), [
      "WalkieTalkey-mac.dmg",
      "WalkieTalkey-windows.exe",
      "WalkieTalkey_0.1.0_universal.app.tar.gz",
      "WalkieTalkey_0.1.0_universal.app.tar.gz.sig",
      "WalkieTalkey_0.1.0_universal.dmg",
      "WalkieTalkey_0.1.0_x64-setup.exe",
      "WalkieTalkey_0.1.0_x64-setup.exe.sig",
      "latest.json",
    ]);
    assert.equal(
      readFileSync(join(opts.outDir, "WalkieTalkey-mac.dmg"), "utf8"),
      "dmg",
    );
    assert.equal(
      readFileSync(join(opts.outDir, "WalkieTalkey-windows.exe"), "utf8"),
      "setup",
    );

    const latest = JSON.parse(
      readFileSync(join(opts.outDir, "latest.json"), "utf8"),
    );
    assert.equal(latest.version, "0.1.0");
    assert.equal(latest.notes, "");
    assert.equal(latest.pub_date, "2026-10-24T05:24:03.005Z");
    const base =
      "https://github.com/JonathanRentoft/walkietalkey/releases/download/v0.1.0/";
    const mac = {
      signature: readFileSync(
        join(opts.outDir, "WalkieTalkey_0.1.0_universal.app.tar.gz.sig"),
        "utf8",
      ),
      url: base + "WalkieTalkey_0.1.0_universal.app.tar.gz",
    };
    const win = {
      signature: readFileSync(
        join(opts.outDir, "WalkieTalkey_0.1.0_x64-setup.exe.sig"),
        "utf8",
      ),
      url: base + "WalkieTalkey_0.1.0_x64-setup.exe",
    };
    // The keys the updater looks up: {os}-{arch}-{installer} first, then {os}-{arch}.
    assert.deepEqual(latest.platforms, {
      "darwin-aarch64": mac,
      "darwin-x86_64": mac,
      "darwin-aarch64-app": mac,
      "darwin-x86_64-app": mac,
      "windows-x86_64": win,
      "windows-x86_64-nsis": win,
    });
    // Each listed asset has its size and SHA-256 for the run summary.
    const dmg = result.assets.find(
      (a) => a.name === "WalkieTalkey_0.1.0_universal.dmg",
    );
    assert.equal(dmg?.size, 3);
    assert.equal(dmg?.sha256, createHash("sha256").update("dmg").digest("hex"));
  });

  test("download URLs are tag URLs that work once the release is published", () => {
    const opts = options();
    assemble(opts);
    const text = readFileSync(join(opts.outDir, "latest.json"), "utf8");
    assert.doesNotMatch(text, /api\.github\.com|untagged-/);
  });

  test("a pre-release gets no stable-name copies", () => {
    const { mac, win, conf } = artifacts("0.2.0-beta.1");
    const out = join(dir, "out");
    assemble({
      tauriConf: conf,
      repo: "o/r",
      macDir: mac,
      windowsDir: win,
      outDir: out,
      prerelease: true,
      pubDate: "2026-10-24T00:00:00Z",
    });
    assert.equal(existsSync(join(out, "WalkieTalkey-mac.dmg")), false);
    assert.equal(existsSync(join(out, "WalkieTalkey-windows.exe")), false);
    const latest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
    assert.equal(latest.version, "0.2.0-beta.1");
    assert.match(
      latest.platforms["windows-x86_64"].url,
      /\/download\/v0\.2\.0-beta\.1\/WalkieTalkey_0\.2\.0-beta\.1_x64-setup\.exe$/,
    );
  });

  test("the tag must match tauri.conf.json (OSS-20)", () => {
    assert.throws(() => assemble(options({ tag: "v0.1.1" })), /does not match/);
  });

  test("a signature from a key other than the app's fails the release (DESK-110)", () => {
    const opts = options();
    const other = testKey();
    writeFileSync(
      opts.tauriConf,
      JSON.stringify({
        version: "0.1.0",
        plugins: { updater: { pubkey: other.pubkey } },
      }),
    );
    assert.throws(() => assemble(opts), /expects key/);
  });

  test("a dry run checks each build against its own throwaway key", () => {
    const opts = options();
    // The app ships another key; each build signed with its throwaway key and left updater.pub.
    const app = testKey();
    writeFileSync(
      opts.tauriConf,
      JSON.stringify({
        version: "0.1.0",
        plugins: { updater: { pubkey: app.pubkey } },
      }),
    );
    assert.throws(() => assemble(opts), /expects key/);
    assert.throws(
      () => assemble({ ...opts, throwawayKeys: true }),
      /updater\.pub is missing/,
    );
    writeFileSync(join(opts.macDir, "updater.pub"), key.pubkey);
    writeFileSync(join(opts.windowsDir, "updater.pub"), key.pubkey);
    assemble({ ...opts, throwawayKeys: true });
    // updater.pub is not an asset.
    assert.equal(existsSync(join(opts.outDir, "updater.pub")), false);
  });

  test("a dry run signed with the app's own key fails", () => {
    const opts = options();
    writeFileSync(join(opts.macDir, "updater.pub"), key.pubkey);
    writeFileSync(join(opts.windowsDir, "updater.pub"), key.pubkey);
    assert.throws(
      () => assemble({ ...opts, throwawayKeys: true }),
      /signed with the app's own key/,
    );
  });

  test("a missing updater signature fails", () => {
    const opts = options();
    rmSync(
      join(opts.windowsDir, "nsis", "WalkieTalkey_0.1.0_x64-setup.exe.sig"),
    );
    assert.throws(() => assemble(opts), /x64-setup\.exe\.sig/);
  });

  test("two candidates for one asset fail instead of picking one", () => {
    const opts = options();
    mkdirSync(join(opts.macDir, "stale"));
    writeFileSync(
      join(opts.macDir, "stale", "WalkieTalkey_0.1.0_universal.dmg"),
      "old",
    );
    assert.throws(() => assemble(opts), /2 files match the Mac disk image/);
  });
});

// A minisign-format key and signer like Tauri's (Ed25519 over BLAKE2b-512), for test data only.
interface TestKey {
  keyId: Buffer;
  privateKey: KeyObject;
  pubkey: string;
}

function testKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyId = randomBytes(8);
  const id = Buffer.from(keyId).reverse().toString("hex").toUpperCase();
  const text = `untrusted comment: minisign public key: ${id}\n${Buffer.concat([
    Buffer.from("Ed"),
    keyId,
    raw,
  ]).toString("base64")}\n`;
  return { keyId, privateKey, pubkey: Buffer.from(text).toString("base64") };
}

function signFile(key: TestKey, path: string) {
  const digest = createHash("blake2b512").update(readFileSync(path)).digest();
  const signature = sign(null, digest, key.privateKey);
  const trusted = `timestamp:1792837858\tfile:${path.split("/").pop()}`;
  const global = sign(
    null,
    Buffer.concat([signature, Buffer.from(trusted)]),
    key.privateKey,
  );
  const text =
    "untrusted comment: signature from tauri secret key\n" +
    Buffer.concat([Buffer.from("ED"), key.keyId, signature]).toString(
      "base64",
    ) +
    `\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
  writeFileSync(`${path}.sig`, Buffer.from(text).toString("base64"));
}
