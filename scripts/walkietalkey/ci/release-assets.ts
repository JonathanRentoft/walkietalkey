// Release assets for a WalkieTalkey app release (OSS-21, DESK-110, DESK-112, SITE-08).
//
// The build jobs hand over what the Tauri CLI wrote (the universal .dmg, the .app.tar.gz updater
// archive and the NSIS -setup.exe, each archive with its .sig). This names them the way the
// release publishes them, checks every updater signature against the app's public key, adds the
// stable-name copies the website links to (releases/latest/download/WalkieTalkey-mac.dmg and
// WalkieTalkey-windows.exe, stable releases only) and writes latest.json, which also becomes the
// website's updates/beta.json. The real release (a v* tag) uploads the folder as it is; the dry run
// on a pull request stops here, so both run exactly this.
//
// latest.json points at tag URLs (github.com/<repo>/releases/download/v<version>/<asset>), which
// work for the updater, the browser and the portable installer link once the release is published.
// tauri-action v1 would write api.github.com asset URLs instead, so it only builds now.
//
//   bun scripts/walkietalkey/ci/release-assets.ts --repo <owner/name> --mac <dir> --windows <dir>
//     --out <dir> [--tag vX.Y.Z] [--prerelease] [--throwaway-keys] [--published]
//     [--tauri-conf <path>]
//   bun scripts/walkietalkey/ci/release-assets.ts --notes-out <path> [--changelog <path>]
//
// Signatures must match the key the app ships (plugins.updater.pubkey in tauri.conf.json). A dry
// run signs with a throwaway key per build instead (--throwaway-keys): each platform folder then
// holds that key's public half as updater.pub, and the app's own key must not be it.
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

const PRODUCT = "WalkieTalkey";

export interface AssembleOptions {
  /** src-tauri/tauri.conf.json: the version and the app's updater public key. */
  tauriConf: string;
  /** owner/name, for the download URLs. */
  repo: string;
  macDir: string;
  windowsDir: string;
  outDir: string;
  prerelease: boolean;
  /** Defaults to v<version>; when given it must be exactly that (OSS-20). */
  tag?: string;
  /**
   * Dry run: each platform folder has updater.pub, the public half of the throwaway key its build
   * signed with, and the signatures must match that instead of the app's key.
   */
  throwawayKeys?: boolean;
  /** latest.json pub_date; defaults to now. */
  pubDate?: string;
}

export interface Asset {
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface Assembled {
  version: string;
  tag: string;
  assets: Asset[];
}

/** The section of CHANGELOG.md for `version` ("## [x.y.z] ..." up to the next "## ["). */
export function releaseNotes(changelog: string, version: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=^## \\[|(?![\\s\\S]))`,
    "m",
  ).exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md has no section for ${version}`);
  return match[1].trim() + "\n";
}

interface MinisignKey {
  keyId: Buffer;
  publicKey: Buffer;
}

function keyIdText(id: Buffer): string {
  return Buffer.from(id).reverse().toString("hex").toUpperCase();
}

/** A Tauri updater public key: base64 of "untrusted comment: ...\n<base64 'Ed' + id + key>\n". */
function parsePubkey(pubkeyB64: string): MinisignKey {
  const lines = Buffer.from(pubkeyB64.trim(), "base64")
    .toString("utf8")
    .split("\n");
  const raw = Buffer.from(lines[1] ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") {
    throw new Error("the updater public key is not a minisign Ed25519 key");
  }
  return { keyId: raw.subarray(2, 10), publicKey: raw.subarray(10) };
}

function ed25519(publicKey: Buffer) {
  // SPKI wrapping of a raw Ed25519 key (RFC 8410).
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({
    key: Buffer.concat([prefix, publicKey]),
    format: "der",
    type: "spki",
  });
}

/**
 * Checks a Tauri updater signature (the base64 .sig file: minisign, Ed25519 over the BLAKE2b-512
 * of the file, plus the signed trusted comment) the way the app's updater does before installing.
 */
export function verifyTauriSignature(
  data: Buffer,
  sigB64: string,
  pubkeyB64: string,
): void {
  const key = parsePubkey(pubkeyB64);
  const lines = Buffer.from(sigB64.trim(), "base64")
    .toString("utf8")
    .split("\n");
  const sig = Buffer.from(lines[1] ?? "", "base64");
  const trustedLine = lines[2] ?? "";
  const global = Buffer.from(lines[3] ?? "", "base64");
  if (sig.length !== 74 || !trustedLine.startsWith("trusted comment: ")) {
    throw new Error("not a minisign signature");
  }
  const algorithm = sig.subarray(0, 2).toString();
  const keyId = sig.subarray(2, 10);
  const signature = sig.subarray(10);
  if (!keyId.equals(key.keyId)) {
    throw new Error(
      `signed with key ${keyIdText(keyId)}, but the app expects key ${keyIdText(key.keyId)}`,
    );
  }
  const message =
    algorithm === "ED"
      ? createHash("blake2b512").update(data).digest()
      : algorithm === "Ed"
        ? data
        : null;
  if (!message) throw new Error(`unknown signature algorithm ${algorithm}`);
  const publicKey = ed25519(key.publicKey);
  if (!verify(null, message, publicKey, signature)) {
    throw new Error("the signature does not match the file");
  }
  const trusted = Buffer.from(trustedLine.slice("trusted comment: ".length));
  if (!verify(null, Buffer.concat([signature, trusted]), publicKey, global)) {
    throw new Error("the signature's trusted comment does not match");
  }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

/** Exactly one file under `dir` whose name matches `pattern`. */
function one(dir: string, pattern: RegExp, what: string): string {
  const found = filesUnder(dir).filter((p) => pattern.test(basename(p)));
  if (found.length !== 1) {
    throw new Error(
      `${found.length} files match ${what} (${pattern}) under ${dir}` +
        (found.length ? `: ${found.join(", ")}` : ""),
    );
  }
  return found[0];
}

function describe(path: string, name: string): Asset {
  const data = readFileSync(path);
  return {
    name,
    path,
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

export function assemble(opts: AssembleOptions): Assembled {
  const conf = JSON.parse(readFileSync(opts.tauriConf, "utf8"));
  const version: string = conf.version;
  const tag = `v${version}`;
  if (opts.tag !== undefined && opts.tag !== tag) {
    throw new Error(
      `Tag ${opts.tag} does not match the tauri.conf.json version ${version}`,
    );
  }
  const appKey: string | undefined = conf.plugins?.updater?.pubkey;
  if (!appKey)
    throw new Error("no updater public key to check signatures with");

  const v = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const dmg = one(
    opts.macDir,
    new RegExp(`^${PRODUCT}_${v}_universal\\.dmg$`),
    "the Mac disk image",
  );
  const appArchive = one(
    opts.macDir,
    new RegExp(`^${PRODUCT}\\.app\\.tar\\.gz$`),
    "the Mac updater archive",
  );
  const setup = one(
    opts.windowsDir,
    new RegExp(`^${PRODUCT}_${v}_x64-setup\\.exe$`),
    "the Windows installer",
  );

  // The .app.tar.gz gets the version and architecture in its name, like every other bundle.
  const names = {
    dmg: `${PRODUCT}_${version}_universal.dmg`,
    app: `${PRODUCT}_${version}_universal.app.tar.gz`,
    setup: `${PRODUCT}_${version}_x64-setup.exe`,
  };
  const keyFor = (dir: string) => {
    if (!opts.throwawayKeys) return appKey;
    let key: string;
    try {
      key = readFileSync(join(dir, "updater.pub"), "utf8").trim();
    } catch {
      throw new Error(`the throwaway key's updater.pub is missing in ${dir}`);
    }
    if (parsePubkey(key).keyId.equals(parsePubkey(appKey).keyId)) {
      throw new Error(
        `the dry run in ${dir} was signed with the app's own key`,
      );
    }
    return key;
  };
  const updaters = [
    { file: appArchive, name: names.app, pubkey: keyFor(opts.macDir) },
    { file: setup, name: names.setup, pubkey: keyFor(opts.windowsDir) },
  ];
  const signatures = new Map<string, string>();
  for (const { file, name, pubkey } of updaters) {
    let sig: string;
    try {
      sig = readFileSync(`${file}.sig`, "utf8");
    } catch {
      throw new Error(
        `the updater signature ${name}.sig (${file}.sig) is missing`,
      );
    }
    try {
      verifyTauriSignature(readFileSync(file), sig, pubkey);
    } catch (error) {
      throw new Error(`${name}: ${(error as Error).message}`);
    }
    signatures.set(name, sig);
  }

  mkdirSync(opts.outDir, { recursive: true });
  const assets: Asset[] = [];
  const put = (from: string, name: string) => {
    const to = join(opts.outDir, name);
    copyFileSync(from, to);
    assets.push(describe(to, name));
  };
  put(dmg, names.dmg);
  for (const { file, name } of updaters) {
    put(file, name);
    put(`${file}.sig`, `${name}.sig`);
  }
  if (!opts.prerelease) {
    put(dmg, `${PRODUCT}-mac.dmg`);
    put(setup, `${PRODUCT}-windows.exe`);
  }

  const url = (name: string) =>
    `https://github.com/${opts.repo}/releases/download/${tag}/${name}`;
  const mac = { signature: signatures.get(names.app)!, url: url(names.app) };
  const win = {
    signature: signatures.get(names.setup)!,
    url: url(names.setup),
  };
  // The updater tries {os}-{arch}-{installer} first, then {os}-{arch}; the universal app serves
  // both Mac architectures (the same keys tauri-action writes).
  const latest = {
    version,
    notes: "",
    pub_date: opts.pubDate ?? new Date().toISOString(),
    platforms: {
      "darwin-aarch64": mac,
      "darwin-x86_64": mac,
      "darwin-aarch64-app": mac,
      "darwin-x86_64-app": mac,
      "windows-x86_64": win,
      "windows-x86_64-nsis": win,
    },
  };
  const latestPath = join(opts.outDir, "latest.json");
  writeFileSync(latestPath, JSON.stringify(latest, null, 2) + "\n");
  assets.push(describe(latestPath, "latest.json"));
  return { version, tag, assets };
}

/** A Markdown table of the assets, for the run summary. */
export function summary(result: Assembled, published: boolean): string {
  const rows = result.assets.map(
    (a) =>
      `| \`${a.name}\` | ${a.size.toLocaleString("en")} | \`${a.sha256}\` |`,
  );
  return [
    `### WalkieTalkey ${result.version} (${result.tag})`,
    "",
    published
      ? "These assets go to the GitHub release."
      : "Dry run: these assets were built, named and checked, and nothing was published.",
    "",
    "| Asset | Bytes | SHA-256 |",
    "|---|---:|---|",
    ...rows,
    "",
  ].join("\n");
}

function main(argv: string[]) {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--prerelease", "--published", "--throwaway-keys"].includes(a)) {
      flags.add(a);
    } else if (a.startsWith("--") && i + 1 < argv.length)
      args.set(a, argv[++i]);
    else throw new Error(`unexpected argument ${a}`);
  }
  const need = (name: string) => {
    const value = args.get(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  if (args.has("--notes-out")) {
    const conf = JSON.parse(
      readFileSync(
        args.get("--tauri-conf") ?? "src-tauri/tauri.conf.json",
        "utf8",
      ),
    );
    const notes = releaseNotes(
      readFileSync(args.get("--changelog") ?? "CHANGELOG.md", "utf8"),
      conf.version,
    );
    writeFileSync(need("--notes-out"), notes);
    return;
  }
  const result = assemble({
    tauriConf: args.get("--tauri-conf") ?? "src-tauri/tauri.conf.json",
    repo: need("--repo"),
    macDir: need("--mac"),
    windowsDir: need("--windows"),
    outDir: need("--out"),
    prerelease: flags.has("--prerelease"),
    tag: args.get("--tag"),
    throwawayKeys: flags.has("--throwaway-keys"),
  });
  const text = summary(result, flags.has("--published"));
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, text, { flag: "a" });
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${(error as Error).message}`);
    process.exit(1);
  }
}
