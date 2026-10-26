// Writes src/walkietalkey/COPY.md: every Danish string of the WalkieTalkey
// desktop screens (translation.json, `wt`), marked "Appendix A" when it is
// the spec's copy verbatim, "Approved" while it is the text the owner approved
// (src/walkietalkey/copy-approved.json, run 8), and TODO(copy) when it is new
// or changed and waits for the owner's approval. JSON cannot hold comments, so
// the markers live here.
//   bun scripts/walkietalkey/copy-list.ts          regenerate
//   bun scripts/walkietalkey/copy-list.ts --check  fail if out of date
// Approve a string: bun scripts/walkietalkey/todo-copy.ts --approve <key>, then
// regenerate.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { format } from "prettier";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const daPath = path.join(
  root,
  "src",
  "i18n",
  "locales",
  "da",
  "translation.json",
);
const specPath = path.join(root, "docs", "SPEC.md");
const outPath = path.join(root, "src", "walkietalkey", "COPY.md");
const approvedPath = path.join(
  root,
  "src",
  "walkietalkey",
  "copy-approved.json",
);

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix: string, out: [string, string][]) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([key, v]);
    else flatten(v, key, out);
  }
  return out;
}

/** Placeholders and paste keys compare as one token. */
const normalise = (s: string) =>
  s
    .replace(/\{\{[^}]+\}\}/g, "{}")
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/⌘V|Ctrl\+V/g, "{}")
    .trim();

function appendixA(spec: string): Set<string> {
  const start = spec.indexOf("## Appendix A");
  const end = spec.indexOf("## Appendix B");
  const section = spec.slice(start, end);
  const out = new Set<string>();
  for (const line of section.split("\n")) {
    const m = line.match(/^\*\*[^*]+\*\*:\s*(.*)$/);
    if (!m) continue;
    for (const item of m[1].split(" · ")) out.add(normalise(item));
  }
  return out;
}

const da = JSON.parse(fs.readFileSync(daPath, "utf8")) as Tree;
const strings = flatten(da.wt as Tree, "wt", []);
const verbatim = appendixA(fs.readFileSync(specPath, "utf8"));
/** Key to the exact text the owner approved. */
const approved = (
  JSON.parse(fs.readFileSync(approvedPath, "utf8")) as {
    strings: Record<string, string>;
  }
).strings;
const cell = (s: string) => s.replace(/\|/g, "\\|");

const rows = strings.map(([key, value]) => {
  const status = verbatim.has(normalise(value))
    ? "Appendix A"
    : approved[key] === value
      ? "Approved"
      : "TODO(copy)";
  return `| \`${key}\` | ${cell(value)} | ${status} |`;
});
const todo = rows.filter((r) => r.endsWith("TODO(copy) |")).length;
const ok = rows.filter((r) => r.endsWith("Approved |")).length;

const raw = `# WalkieTalkey desktop copy

Every Danish string the desktop screens show (onboarding, settings, history,
pill, dialogs). The strings live in \`src/i18n/locales/da/translation.json\`
under \`wt\` (English in \`en\`). JSON cannot hold comments, so the status is
kept here:

- **Appendix A**: the spec's copy, used verbatim (docs/SPEC.md, Appendix A).
- **Approved**: approved by the owner (run 8) with exactly this text, kept in
  \`src/walkietalkey/copy-approved.json\`.
- **TODO(copy)**: new or changed since; drafted by the implementer and needs
  the owner's approval before release (spec Appendix A, "Missing strings").
  Once approved: \`bun scripts/walkietalkey/todo-copy.ts --approve <key>\`.

${strings.length} strings, ${ok} approved, ${todo} marked TODO(copy). Generated
by \`bun scripts/walkietalkey/copy-list.ts\`; \`--check\` fails when this file
is out of date.

Notes:

- macOS names quoted on the screens ("Systemindstillinger", "Tilgængelighed",
  "menulinjen", "Globustasten") must match the Danish macOS UI; todo-copy.ts
  lists them under "UI labels not verified on a device set to Danish". Run 2
  quotes no settings paths: every permission step has one button that opens
  the exact pane.
- "Tryk igen for at stoppe" (the pill while recording hands-free) and "Ret det
  for mig" come from the run 2 brief, not from Appendix A; "Giv adgang igen"
  from the lead, and the neutral "WalkieTalkey har ikke længere adgang til
  Tilgængelighed." from the run 2 review (the user may have switched access
  off on purpose), replacing spec 6.2's "macOS har glemt WalkieTalkeys adgang
  efter opdateringen.".
- Strings written by the backend and shown as they come: the DESK-31 speed
  reason (src-tauri/src/walkietalkey/speed.rs), "en telefon uden navn", and
  the notification titles (notify.rs).
- The desktop core's components under Avanceret (microphone, log level,
  keyboard diagnostic, paste delays) keep their Danish strings in
  \`settings.*\`; approved ones are in copy-approved.json too.
- \`common.reset\` ("Nulstil"), the screen reader name added to the icon-only
  reset button.
- The Secure Input answer on walkietalkey.com/spoergsmaal, which the app's
  warning links to ("Sådan løser du det", run 3).

| Key | Danish | Status |
|---|---|---|
${rows.join("\n")}
`;
// Formatted like the rest of the repo, so prettier --check passes.
const doc = await format(raw, { parser: "markdown", endOfLine: "lf" });

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outPath)
    ? fs.readFileSync(outPath, "utf8")
    : "";
  if (current !== doc) {
    console.error(
      "src/walkietalkey/COPY.md is out of date: run bun scripts/walkietalkey/copy-list.ts",
    );
    process.exit(1);
  }
  console.log(
    `COPY.md is up to date (${strings.length} strings, ${ok} approved, ${todo} TODO(copy)).`,
  );
} else {
  fs.writeFileSync(outPath, doc);
  console.log(
    `Wrote ${path.relative(root, outPath)} (${strings.length} strings, ${ok} approved, ${todo} TODO(copy)).`,
  );
}
