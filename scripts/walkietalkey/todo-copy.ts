// Writes the owner's approval list (run 6): every user-facing Danish string an
// implementer drafted (TODO(copy)) and every claim nobody has measured yet
// (TODO(claim)), for the assistant who goes through it with the owner. It reads
// the working tree, the v0.2.0 release on GitHub and Handy's Danish translation
// (both through `gh`, read-only) and changes no source file.
//   bun scripts/walkietalkey/todo-copy.ts [--out <file>]
//   bun scripts/walkietalkey/todo-copy.ts --approve <prefix>...
// Default out: _kit/work/run6/todo-copy.md (git-ignored). The output depends only
// on its inputs, so two runs on the same tree give the same file.
// Run 8: copy the owner approved is left out while its text is unchanged. The
// desktop's translation strings are kept by key in src/walkietalkey/copy-approved.json
// (copy-list.ts reads it too), copy written in the code by file in
// scripts/walkietalkey/copy-approved-texts.json. `--approve` records every row
// marked TODO(copy) whose file starts with a prefix (or, for translation.json,
// whose key does: `--approve wt.move.`); then remove the markers in the code.
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import ts from "typescript";
import { format } from "prettier";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const abs = (p: string) => path.join(root, p);
const exists = (p: string) => fs.existsSync(abs(p));
const read = (p: string) => fs.readFileSync(abs(p), "utf8");

const outArg = process.argv.indexOf("--out");
const outPath =
  outArg > 0 && process.argv[outArg + 1]
    ? path.resolve(process.argv[outArg + 1])
    : abs("_kit/work/run6/todo-copy.md");

/* ------------------------------------------------------------------ model */

type Status = "todo" | "source" | "none" | "approved";

/** One Danish string found in the sources. */
interface Row {
  file: string;
  line?: number;
  /** property path, i18n key or attribute name */
  key?: string;
  text: string;
  /** todo: marked TODO(copy); source: a comment names a source (verbatim, spec); none: not marked;
      approved: the owner approved this text (copy-approved.json, copy-approved-texts.json) */
  status: Status;
  /** the marker's or the comment's own words */
  note?: string;
  /** part of a TODO(claim) */
  claim?: boolean;
  /** extra words for the "unproven" column */
  extra?: string;
}

interface ClaimRow {
  text: string;
  what: string;
  where: string;
  /** "feature:<key>", "faq" or "inline" */
  kind: string;
}

interface ClaimUsage {
  where: string;
  expr: string;
}

const warnings: string[] = [];
const appendixSkipped: string[] = [];
const appendixMarked: string[] = [];
const claims: ClaimRow[] = [];
const claimUsages: ClaimUsage[] = [];
/** Top-level string constants (OPERATOR, CONTACT_EMAIL), to say what a {NAME} in the copy stands for. */
const constants = new Map<string, string>();
/** Files and lines whose marker covers the whole file or the rest of it. */
const wholeNotesAll: string[] = [];

/** Danish strings outside the rows (Handy's own translation, English release notes), for the label check only. */
const labelCorpus: { where: string; text: string }[] = [];

/* ------------------------------------------------------------------ text */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  shy: "\u00ad",
  mdash: "\u2014",
  ndash: "\u2013",
  rsquo: "\u2019",
  lsquo: "\u2018",
  ldquo: "\u201c",
  rdquo: "\u201d",
  hellip: "\u2026",
  laquo: "\u00ab",
  raquo: "\u00bb",
  rsaquo: "\u203a",
  lsaquo: "\u2039",
  middot: "\u00b7",
  copy: "\u00a9",
  rarr: "\u2192",
};
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(
          e[1].toLowerCase() === "x"
            ? parseInt(e.slice(2), 16)
            : parseInt(e.slice(1), 10),
        )
      : (ENTITIES[e.toLowerCase()] ?? m),
  );
/** HTML collapses runs of ASCII whitespace; a no-break space stays. */
const squash = (s: string) => s.replace(/[ \t\n\r\f]+/g, " ").trim();

/** Words that are Danish and not also everyday English. */
const DA_ONLY = new Set(
  (
    "og er til på ikke kan som af der så har fra når hvor hvad hvis hvem hvorfor hvordan jeg vi mig os jer skal vil " +
    "bliver blev kun også alle ingen intet nej ja igen mere endnu tilbage luk gem slet fjern næste afslut vis din dit " +
    "dine du det en et med eller nu ud hent gratis tryk tal indsæt tekst teksten telefon telefonen computeren koden " +
    "appen siden kontakt forside privatliv sikkerhed virksomheder indstillinger talemodel talemodellen mikrofon " +
    "mikrofonen tast tasten prøv færdig klar gemt hvisk lytter diktering dikteringer ordliste ordlisten relæ relæet " +
    "parring parret ny nye nyt eget egen egne sådan virker bruger åbn hjælp læs skriv lyd lyden stemme fordi aldrig " +
    "altid sendes sender uden efter før imens mens dem sig sit sine del tilføj menu"
  ).split(" "),
);
const EN_ONLY = new Set(
  (
    "the and of by under license licensed version you your is are to with this that from all rights reserved " +
    "definitions grant patent redistribution submission trademarks disclaimer warranty limitation liability " +
    "accepting additional terms conditions copyright january"
  ).split(" "),
);
const BRAND = new Set(
  (
    "walkietalkey github apache mit mac macos windows iphone ipad android ios fn ctrl esc edda ekko whisper safari " +
    "chrome edge linux macbook navigent nvidia cloudflare touch id ⌘v ctrl+v tiny v1 v0"
  ).split(" "),
);

const words = (s: string) => s.toLowerCase().match(/[a-zæøåéü]+/g) ?? [];

function looksDanish(s: string): boolean {
  if (/[æøåÆØÅ]/.test(s)) return true;
  const w = words(s);
  const hits = w.filter((x) => DA_ONLY.has(x)).length;
  if (w.length === 1) return hits === 1;
  return hits >= 2 || (hits === 1 && w.length <= 3);
}

/** English text (a licence, a notice), as opposed to a word both languages share ("Version"). */
function englishOnly(s: string): boolean {
  const w = words(bare(s));
  const hits = w.filter((x) => EN_ONLY.has(x)).length;
  return (
    !/[æøåÆØÅ]/.test(s) &&
    !w.some((x) => DA_ONLY.has(x)) &&
    (hits >= 2 || (hits >= 1 && w.length >= 3))
  );
}

function brandOnly(s: string): boolean {
  const toks = s
    .toLowerCase()
    .split(/[\s·,.:;!?()/›→–\-"“”]+/)
    .filter((t) => /\p{L}/u.test(t));
  return toks.length > 0 && toks.every((t) => BRAND.has(t));
}

/** Placeholders ({x}, ${x}, {…}) are filled in by code, so they hold no copy. */
const bare = (s: string) =>
  s.replace(/\$\{[^}]*\}|\{\{[^}]*\}\}|\{[^{}]*\}|\{…\}/g, " ");

/** Could a person read this as text (not a key, class, path, URL or CSS)? */
function proseLike(raw: string): boolean {
  const t = raw.trim();
  const b = bare(t);
  if ((b.match(/\p{L}/gu) ?? []).length < 2) return false;
  if (/^(https?:|mailto:|wss?:|data:|\/|\.{1,2}\/|#|@|\$\{|TODO\()/.test(t))
    return false;
  if (/^\S+@\S+\.\w+$/.test(t)) return false; // an e-mail address
  if (/\d/.test(t) && /^[MLHVCSQTAZmlhvcsqtaz\d\s.,-]+$/.test(t)) return false; // SVG path
  if (
    /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b|^\s*[{[]\s*"/.test(t)
  )
    return false; // SQL, JSON
  // setting names and other identifiers: RelayUrl, "CleanupBaseUrl, CleanupModel"
  if (
    !looksDanish(t) &&
    t
      .split(/,\s*/)
      .every((x) => /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(x))
  )
    return false;
  if (
    /var\(--|\d(px|rem|em|ms|deg|vh|vw|cqw|cqh)\b|translate\(|rgba?\(|calc\(|cubic-bezier|=>|\bfunction\b|\(\)/.test(
      t,
    )
  )
    return false;
  if (
    /^\S+\.(svg|png|jpe?g|webp|avif|woff2?|css|js|mjs|ts|tsx|json|md|dmg|exe|gguf|html|wav|txt)$/i.test(
      t,
    )
  )
    return false;
  if (!/\s/.test(t)) {
    if (/[[\]:=#/_<>{}|\\]/.test(t.replace(/:$/, ""))) return false; // selectors, keys, paths
    if (
      /^[a-z0-9_$.:/#?=&%+-]+$/.test(t) ||
      /_/.test(t) ||
      /^[A-Z0-9_]{4,}$/.test(t) ||
      /^[a-z]+[A-Z]\w*$/.test(t) ||
      /^[a-z]{2}-[A-Z]{2}$/.test(t)
    )
      return looksDanish(t);
  } else if (
    // a class list or a selector: every word starts with a letter, all lower case
    t.split(/\s+/).every((w) => /^[a-z][a-z0-9_:.#[\]=,()*>+~-]*$/.test(w)) &&
    !looksDanish(t)
  ) {
    return false;
  }
  if (brandOnly(b)) return false;
  return true;
}

const hasLetters = (s: string) => /\p{L}/u.test(bare(s));

/* ------------------------------------------------------------- Appendix A */

/** Placeholders and paste keys compare as one token (as in copy-list.ts). */
const normalise = (s: string) =>
  s
    .replace(/\{\{[^}]+\}\}/g, "{}")
    .replace(/\$\{[^}]+\}/g, "{}")
    .replace(/\{[^}]+\}/g, "{}")
    .replace(/⌘V|Ctrl\+V/g, "{}")
    .trim()
    .replace(/\.$/, "");

const spec = read("docs/SPEC.md");
const appendixA = new Set<string>();
{
  const section = spec.slice(
    spec.indexOf("## Appendix A"),
    spec.indexOf("## Appendix B"),
  );
  for (const line of section.split("\n")) {
    const m = line.match(/^\*\*[^*]+\*\*:\s*(.*)$/);
    if (!m) continue;
    for (const item of m[1].split(" · "))
      appendixA.add(normalise(item.replace(/\s*\([^)]*\)\s*$/, "")));
  }
}
const isAppendixA = (s: string) => appendixA.has(normalise(squash(s)));

/* ------------------------------------------------------------- comments */

const TODO = /TODO\(copy\)/;
const REST = /\bbelow\b|\bthe rest of (the|this) (page|file)\b/i;
const WHOLE =
  /\b(every|all) (\w+ )?strings? (here|(in|on) this (file|page))|\ball of (them|it)\b|\bthe whole (page|file)\b/i;
const SOURCE =
  /\bverbatim\b|\bAppendix A\b|^\s*spec section|from ForsideKomplet/i;
const ATTRS_ONLY = /^(aria-label|alt|title)( and (aria-label|alt|title))?$/i;

/** A comment's words, without the comment syntax. */
function commentText(raw: string): string {
  return squash(
    raw
      .replace(/^\{\/\*|\*\/\}$/g, "")
      .replace(/^\/\*+|\*+\/$/g, "")
      .replace(/^\s*(\/\/[/!]?|#|\*)/gm, "")
      .replace(/<!--|-->/g, ""),
  );
}

/** The marker's own words: the comment without "TODO(copy)" and its punctuation.
    With `sentence`, only the sentence that holds the marker (for a long file header). */
function markerNote(text: string, sentence = false): string {
  let t = text;
  if (sentence && t.length > 120) {
    const parts = t.split(/(?<=[.!?])\s+(?=[A-Z"“])/);
    t = parts.find((s) => TODO.test(s)) ?? t;
  }
  // a marker at the start goes; one inside a sentence stays, so the sentence still reads
  const n = squash(
    (sentence
      ? t.replace(/^\s*TODO\(copy\)\s*[:,.]?/, "")
      : t.replace(/TODO\(copy\)\s*[:,.]?/g, "")
    ).replace(/^[\s:,.]+|[\s:,]+$/g, ""),
  );
  return n.length > 400 ? n.slice(0, 397) + "..." : n;
}

/** The note of a comment block: the comment in it that holds the marker (or matches `rx`). */
function blockNote(parts: string[], rx: RegExp, sentence = false): string {
  const hit = parts.find((p) => rx.test(commentText(p))) ?? parts.join("\n");
  return rx === TODO
    ? markerNote(commentText(hit), sentence)
    : commentText(hit);
}

type Mark =
  /** cont: carried on from a marker before an earlier sibling */
  | { kind: "todo"; note: string; cont?: boolean }
  | { kind: "source"; note: string }
  | { kind: "none" };
const NONE: Mark = { kind: "none" };

/* ------------------------------------------------------- TypeScript/Astro */

const INLINE = new Set(
  (
    "a span strong em b i kbd code small abbr sup sub mark time u s q br wbr cite dfn var samp data bdi bdo label " +
    "Claim Keycap Fragment"
  ).split(" "),
);
const SKIP_TAGS = new Set([
  "svg",
  "path",
  "script",
  "style",
  "slot",
  "circle",
  "rect",
  "g",
]);
const ATTR_COPY = new Set(
  (
    "aria-label aria-description aria-roledescription aria-valuetext aria-placeholder title alt content placeholder " +
    "label eyebrow lead caption description summary heading subtitle kicker note hint tooltip " +
    "data-label"
  ) // shown by the CSS on narrow screens (site.css: content: attr(data-label))
    .split(" "),
);
const ATTR_DENY = new Set(
  (
    "class classname class:list href src srcset id style type rel as name property lang palette variant tone size " +
    "role crossorigin sizes d viewbox fill stroke width height slot key for target loading decoding set:html " +
    "is:inline current state page concept screen device aria-labelledby aria-describedby aria-controls aria-hidden " +
    "aria-current aria-live aria-expanded tabindex media charset xmlns method action autocomplete inputmode pattern " +
    "mode os icon what as"
  ).split(" "),
);
const PROP_DENY = new Set(
  (
    "key id path href url slug icon palette variant tone kind type class className accent color anchor prefix letter " +
    "file src image d state feature platform lang ref target rel side shot camera wide tall wide1 tall1 ease"
  ).split(" "),
);
const COPY_PROPS = new Set(
  (
    "title nav description label short body text q a lead eyebrow caption alt heading note hint footnote price " +
    "items say said kicker subject to"
  ).split(" "),
);
/** Properties whose value is copy even when it is not plainly Danish ("Open source"). */
const NONE_COPY_PROPS = new Set(
  "nav label alt description q a short body lead eyebrow caption hint note footnote".split(
    " ",
  ),
);
const CALL_DENY = new Set(
  (
    "querySelector querySelectorAll getElementById closest matches matchMedia setAttribute getAttribute " +
    "removeAttribute hasAttribute toggleAttribute addEventListener removeEventListener dispatchEvent CustomEvent " +
    "createElement createElementNS add remove toggle contains replace replaceAll split join startsWith endsWith " +
    "includes indexOf padStart padEnd toFixed RegExp Error TypeError log warn error info debug import require URL " +
    "fetch getPropertyValue setProperty removeProperty animate Symbol emit listen invoke getItem setItem removeItem " +
    "toLocaleString toLocaleDateString Intl NumberFormat DateTimeFormat t i18n"
  ).split(" "),
);

interface TsCtx {
  file: string;
  sf: ts.SourceFile;
  text: string;
  rows: Row[];
  floor: { pos: number; note: string; whole: boolean }[];
  lineMarks: Map<number, string>;
  nextLineMarks: Map<number, string>;
  markedProps: Set<string>;
  includeNone: boolean;
  claimDepth: number;
  wholeNotes: string[];
}

const lineOf = (ctx: TsCtx, pos: number) =>
  ctx.sf.getLineAndCharacterOfPosition(pos).line + 1;

/** Astro → TSX with the same line numbers: frontmatter stays code, the template becomes one fragment. */
function astroToTsx(src: string): string {
  const lines = src.split("\n");
  let tplStart = 0;
  const head: string[] = [];
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) {
      head.push("", ...lines.slice(1, close), "const __astro = <>");
      tplStart = close + 1;
    }
  }
  let tpl = lines.slice(tplStart).join("\n");
  const keepLines = (s: string) => s.replace(/[^\n]/g, "");
  tpl = tpl
    .replace(/<!doctype[^>]*>/gi, "")
    .replace(
      /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/gi,
      (_m, open: string, _t, body: string, close: string) =>
        open + keepLines(body) + close,
    )
    .replace(
      /<!--([\s\S]*?)-->/g,
      (_m, body: string) => `{/*${body.replace(/\*\//g, "* /")}*/}`,
    );
  if (!head.length) return `const __astro = <>${tpl}\n</>;`;
  return `${head.join("\n")}\n${tpl}\n</>;`;
}

function collectComments(sf: ts.SourceFile): ts.CommentRange[] {
  const seen = new Map<number, ts.CommentRange>();
  const text = sf.text;
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) return;
    if (ts.isJsxExpression(node) && !node.expression) {
      // {/* ... */}: TypeScript reports no comment range for it, so take it whole
      const start = node.getStart(sf);
      const open = text.indexOf("/*", start);
      const close = text.lastIndexOf("*/", node.end);
      if (open >= 0 && close > open)
        seen.set(open, {
          pos: open,
          end: close + 2,
          kind: ts.SyntaxKind.MultiLineCommentTrivia,
        });
      return;
    }
    for (const c of ts.getLeadingCommentRanges(text, node.pos) ?? [])
      seen.set(c.pos, c);
    for (const c of ts.getTrailingCommentRanges(text, node.end) ?? [])
      seen.set(c.pos, c);
    for (const ch of node.getChildren(sf)) visit(ch);
  };
  visit(sf);
  return [...seen.values()].sort((a, b) => a.pos - b.pos);
}

/** Consecutive comment lines (no blank line between) read as one comment. */
interface CommentBlock {
  pos: number;
  end: number;
  raw: string;
  parts: string[];
}

function commentBlocks(text: string, ranges: readonly ts.CommentRange[]) {
  const blocks: CommentBlock[] = [];
  for (const r of ranges) {
    const last = blocks[blocks.length - 1];
    const raw = text.slice(r.pos, r.end);
    if (last && /^[ \t]*\r?\n?[ \t]*$/.test(text.slice(last.end, r.pos))) {
      last.raw += "\n" + raw;
      last.parts.push(raw);
      last.end = r.end;
    } else blocks.push({ pos: r.pos, end: r.end, raw, parts: [raw] });
  }
  return blocks;
}

/** How a comment block changes the marking of what follows it. */
function blockMark(ctx: TsCtx, b: CommentBlock): Mark | null {
  const t = commentText(b.raw);
  if (TODO.test(t)) {
    const header = ctx.text.slice(0, b.pos).trim() === "";
    if (REST.test(t) || WHOLE.test(t))
      return { kind: "todo", note: blockNote(b.parts, TODO, true) };
    if (header) return null;
    const lineStart = ctx.text.lastIndexOf("\n", b.pos - 1) + 1;
    if (ctx.text.slice(lineStart, b.pos).trim()) return null; // trailing: handled by line
    return { kind: "todo", note: blockNote(b.parts, TODO) };
  }
  if (SOURCE.test(t))
    return { kind: "source", note: blockNote(b.parts, SOURCE) };
  return NONE;
}

function prepareMarks(ctx: TsCtx) {
  const ranges = collectComments(ctx.sf);
  for (const b of commentBlocks(ctx.text, ranges)) {
    const t = commentText(b.raw);
    if (!TODO.test(t)) continue;
    const lineStart = ctx.text.lastIndexOf("\n", b.pos - 1) + 1;
    const trailing = ctx.text.slice(lineStart, b.pos).trim() !== "";
    const note = blockNote(b.parts, TODO, true);
    if (WHOLE.test(t)) {
      ctx.floor.push({ pos: 0, note, whole: true });
      ctx.wholeNotes.push(`${ctx.file}:${lineOf(ctx, b.pos)}: ${note}`);
    } else if (REST.test(t)) {
      ctx.floor.push({ pos: b.pos, note, whole: false });
      ctx.wholeNotes.push(
        `${ctx.file}:${lineOf(ctx, b.pos)} (from here on): ${note}`,
      );
    } else if (trailing) {
      ctx.lineMarks.set(lineOf(ctx, b.pos), blockNote(b.parts, TODO));
    } else if (ctx.text.slice(0, b.pos).trim() !== "") {
      // a marker on its own line also speaks for the next line of code, wherever it stands
      // (layouts/Base.astro: inside a conditional expression, where no list carries it)
      const after = ctx.text.slice(b.end);
      const skip = after.match(/^\s*/)?.[0].length ?? 0;
      ctx.nextLineMarks.set(
        lineOf(ctx, b.end + skip),
        blockNote(b.parts, TODO),
      );
    }
  }
  ctx.floor.sort((a, b) => a.pos - b.pos);
  // a TODO(copy) on a field of a type marks that property everywhere in the file
  const visit = (n: ts.Node) => {
    if (
      (ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) &&
      n.name &&
      ts.isIdentifier(n.name)
    ) {
      const cs = ts.getLeadingCommentRanges(ctx.text, n.pos) ?? [];
      if (cs.some((c) => TODO.test(ctx.text.slice(c.pos, c.end))))
        ctx.markedProps.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(ctx.sf);
}

function floorAt(ctx: TsCtx, pos: number) {
  let hit: { note: string } | null = null;
  for (const f of ctx.floor) if (f.pos <= pos) hit = f;
  return hit;
}

/** The property path of a node: PAGES.hent.title, T.detail.mic, rows[2][1]. */
function propPath(node: ts.Node): { path: string; leaf?: string } {
  const parts: string[] = [];
  let leaf: string | undefined;
  let cur: ts.Node = node;
  while (cur.parent) {
    const p: ts.Node = cur.parent;
    if (ts.isPropertyAssignment(p) && p.initializer === cur) {
      const name =
        ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)
          ? p.name.text
          : p.name.getText();
      parts.unshift(name);
      leaf ??= name;
    } else if (ts.isArrayLiteralExpression(p)) {
      parts.unshift(`[${p.elements.indexOf(cur as ts.Expression)}]`);
    } else if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) {
      parts.unshift(p.name.text);
      leaf ??= p.name.text;
      break;
    } else if (ts.isJsxAttribute(p)) {
      leaf ??= p.name.getText();
      parts.unshift(p.name.getText());
    } else if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) {
      parts.unshift(p.name.text);
      leaf ??= p.name.text;
      break;
    }
    cur = p;
  }
  return {
    path: parts
      .filter((p) => p !== "__astro")
      .join(".")
      .replace(/\.\[/g, "["),
    leaf: leaf === "__astro" ? undefined : leaf,
  };
}

function calleeName(node: ts.Node): string | undefined {
  let cur: ts.Node = node;
  while (cur.parent && !ts.isStatement(cur.parent)) {
    const p: ts.Node = cur.parent;
    if (
      (ts.isCallExpression(p) || ts.isNewExpression(p)) &&
      p.arguments?.includes(cur as ts.Expression)
    ) {
      const e = p.expression;
      if (ts.isIdentifier(e)) return e.text;
      if (ts.isPropertyAccessExpression(e)) return e.name.text;
      return undefined;
    }
    if (
      ts.isPropertyAssignment(p) ||
      ts.isJsxAttribute(p) ||
      ts.isArrayLiteralExpression(p)
    )
      return undefined;
    cur = p;
  }
  return undefined;
}

function statusOf(
  ctx: TsCtx,
  pos: number,
  st: Mark,
  leaf: string | undefined,
): { status: Status; note?: string; explicit?: boolean } {
  const line = lineOf(ctx, pos);
  if (ctx.lineMarks.has(line))
    return { status: "todo", note: ctx.lineMarks.get(line), explicit: true };
  if (st.kind === "todo")
    return {
      status: "todo",
      note: st.note,
      explicit: !st.cont && !WHOLE.test(st.note) && !REST.test(st.note),
    };
  if (st.kind === "source") return { status: "source", note: st.note };
  if (ctx.nextLineMarks.has(line))
    return {
      status: "todo",
      note: ctx.nextLineMarks.get(line),
      explicit: true,
    };
  const f = floorAt(ctx, pos);
  if (f) return { status: "todo", note: f.note };
  if (leaf && ctx.markedProps.has(leaf))
    return {
      status: "todo",
      note: `the field "${leaf}" is marked TODO(copy) in its type`,
    };
  return { status: "none" };
}

function addRow(
  ctx: TsCtx,
  kind: "text" | "attr" | "literal",
  text: string,
  pos: number,
  st: Mark,
  opts: { key?: string; leaf?: string; claim?: boolean } = {},
) {
  const value = kind === "text" ? squash(text) : text;
  const { status, note, explicit } = statusOf(ctx, pos, st, opts.leaf);
  if (!proseLike(value)) return;
  if (status === "none") {
    if (!ctx.includeNone) return;
    if (kind !== "text") {
      if (/^[a-zæøå-]+$/.test(value.trim())) return; // a key such as "hent"
      const copyish = opts.leaf !== undefined && NONE_COPY_PROPS.has(opts.leaf);
      if (!copyish && !looksDanish(value)) return;
    }
  } else if (kind === "literal") {
    if (englishOnly(value)) return;
    // names of projects and people ("Albert Sans", "Silero VAD")
    if (
      !looksDanish(value) &&
      /^(?:[A-Z][\w-]*)(?: [A-Z][\w-]*)+$/.test(value.trim())
    )
      return;
  }
  const where = `${ctx.file}:${lineOf(ctx, pos)}`;
  if (isAppendixA(value)) {
    appendixSkipped.push(`${where} ${value}`);
    if (status === "todo" && explicit)
      appendixMarked.push(`${where}: "${value}"`);
    return;
  }
  ctx.rows.push({
    file: ctx.file,
    line: lineOf(ctx, pos),
    key: opts.key,
    text: value,
    status,
    note,
    claim: opts.claim || ctx.claimDepth > 0 || undefined,
  });
}

function literalValue(node: ts.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1);
  return undefined;
}

function skipLiteral(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isExternalModuleReference(p) || ts.isImportTypeNode(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true;
  if (
    (ts.isPropertyAssignment(p) || ts.isPropertySignature(p)) &&
    p.name === node
  )
    return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === node)
    return true;
  if (ts.isCaseClause(p)) return true;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.InKeyword
    )
      return true;
  }
  if (ts.isJsxAttribute(p)) return true; // handled with the attribute
  const callee = calleeName(node);
  if (callee && CALL_DENY.has(callee)) return true;
  return false;
}

function exprPlaceholder(e: ts.Expression): string {
  const src = e.getText();
  return /^[\w.$]{1,40}$/.test(src) ? `{${src}}` : "{…}";
}

/** Does a block hold text of its own, or only separate labels (elements, expressions)? */
function hasDirectText(children: ts.NodeArray<ts.JsxChild>): boolean {
  return children.some(
    (ch) =>
      (ts.isJsxText(ch) && /\p{L}/u.test(decode(ch.text))) ||
      (ts.isJsxExpression(ch) &&
        !!ch.expression &&
        ts.isStringLiteral(ch.expression) &&
        /\p{L}/u.test(ch.expression.text)),
  );
}

const tagOf = (el: ts.JsxElement | ts.JsxSelfClosingElement) =>
  (ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName).getText();

/** The text a block shows, with inline children folded in and nested blocks left out. */
function renderInline(
  children: ts.NodeArray<ts.JsxChild>,
  flags: { claim: boolean },
): string {
  let out = "";
  for (const ch of children) {
    if (ts.isJsxText(ch)) out += decode(ch.text);
    else if (ts.isJsxExpression(ch)) {
      if (!ch.expression) continue;
      const v = ts.isStringLiteral(ch.expression)
        ? ch.expression.text
        : undefined;
      out += v ?? exprPlaceholder(ch.expression);
    } else if (ts.isJsxFragment(ch)) out += renderInline(ch.children, flags);
    else if (ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch)) {
      const tag = tagOf(ch);
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === "br") out += " ";
      else if (tag === "Claim") {
        flags.claim = true;
        if (ts.isJsxElement(ch)) out += renderInline(ch.children, flags);
      } else if (INLINE.has(tag)) {
        if (ts.isJsxElement(ch)) out += renderInline(ch.children, flags);
      } else out += " ";
    }
  }
  return out;
}

/** All the text inside an element, blocks included (for a claim). */
function fullText(children: ts.NodeArray<ts.JsxChild>): string {
  let out = "";
  for (const ch of children) {
    if (ts.isJsxText(ch)) out += decode(ch.text);
    else if (ts.isJsxExpression(ch) && ch.expression)
      out += ts.isStringLiteral(ch.expression)
        ? ch.expression.text
        : exprPlaceholder(ch.expression);
    else if (ts.isJsxFragment(ch)) out += fullText(ch.children);
    else if (ts.isJsxElement(ch)) {
      if (!SKIP_TAGS.has(tagOf(ch))) out += " " + fullText(ch.children) + " ";
    }
  }
  return squash(out);
}

function firstTextPos(ctx: TsCtx, el: ts.JsxElement): number {
  for (const ch of el.children) {
    if (ts.isJsxText(ch) && ch.text.trim()) {
      const off = ch.text.search(/\S/);
      return ch.pos + Math.max(0, off);
    }
  }
  return el.getStart(ctx.sf);
}

/** The expression of an attribute written as name={...}. */
const initExpr = (init: ts.JsxAttributeValue | undefined) =>
  init && ts.isJsxExpression(init) ? init.expression : undefined;

function attrValue(a: ts.JsxAttribute): string | undefined {
  const init = a.initializer;
  if (!init) return undefined;
  if (ts.isStringLiteral(init)) return init.text;
  const e = initExpr(init);
  return e ? literalValue(e) : undefined;
}

function walkJsxElement(
  ctx: TsCtx,
  el: ts.JsxElement | ts.JsxSelfClosingElement,
  st: Mark,
  attrsMark: { attrs: string[]; note: string } | null,
  inBlock: boolean,
) {
  const tag = tagOf(el);
  if (SKIP_TAGS.has(tag)) return;
  const attrs = ts.isJsxElement(el)
    ? el.openingElement.attributes
    : el.attributes;
  for (const a of attrs.properties) {
    if (ts.isJsxSpreadAttribute(a)) {
      walk(ctx, a.expression, st);
      continue;
    }
    const name = a.name.getText();
    const lname = name.toLowerCase();
    const ast: Mark =
      attrsMark && attrsMark.attrs.includes(lname)
        ? { kind: "todo", note: attrsMark.note }
        : st;
    if (!a.initializer) continue;
    if (
      ATTR_DENY.has(lname) ||
      (lname.startsWith("data-") && !ATTR_COPY.has(lname)) ||
      /^on[A-Z]/.test(name)
    )
      continue;
    const expr = initExpr(a.initializer);
    const v = ts.isStringLiteral(a.initializer)
      ? a.initializer.text
      : expr
        ? literalValue(expr)
        : undefined;
    if (v !== undefined) {
      const copy = ATTR_COPY.has(lname);
      if (!copy && !looksDanish(v)) continue;
      addRow(ctx, "attr", v, a.getStart(ctx.sf), ast, {
        key: name,
        leaf: copy ? "title" : name,
      });
    } else if (expr) {
      walk(ctx, expr, ast);
    }
  }
  if (tag === "Claim") recordClaim(ctx, el);
  if (!ts.isJsxElement(el)) return;
  const isClaim = tag === "Claim";
  if (isClaim) ctx.claimDepth++;
  const block = !INLINE.has(tag);
  let childrenInBlock = inBlock;
  if (block || !inBlock) {
    if (hasDirectText(el.children)) {
      // a sentence: inline children are part of it
      const flags = { claim: false };
      const text = renderInline(el.children, flags);
      if (hasLetters(text))
        addRow(ctx, "text", text, firstTextPos(ctx, el), st, {
          claim: flags.claim,
        });
      childrenInBlock = true;
    } else childrenInBlock = false; // separate labels: each child speaks for itself
  }
  walkJsxChildren(ctx, el.children, st, childrenInBlock);
  if (isClaim) ctx.claimDepth--;
}

function walkJsxChildren(
  ctx: TsCtx,
  children: ts.NodeArray<ts.JsxChild>,
  inherited: Mark,
  inBlock: boolean,
) {
  // In markup a marker speaks for the elements after it, up to the next comment; its note is
  // shown on the first of them only. A "verbatim" note speaks for the next element only.
  let next: Mark | null = null;
  let rest: Mark | null = null;
  const consume = () => {
    if (next?.kind === "todo") rest = { kind: "todo", note: "", cont: true };
    next = null;
  };
  let attrsMark: { attrs: string[]; note: string } | null = null;
  for (const ch of children) {
    if (ts.isJsxText(ch)) {
      if (!inBlock && ch.text.trim() && hasLetters(decode(ch.text))) {
        addRow(ctx, "text", decode(ch.text), ch.pos, next ?? rest ?? inherited);
        consume();
      }
      continue;
    }
    if (ts.isJsxExpression(ch) && !ch.expression) {
      const raw = ctx.text.slice(ch.getStart(ctx.sf), ch.end);
      const m = blockMark(ctx, {
        pos: ch.getStart(ctx.sf),
        end: ch.end,
        raw,
        parts: [raw],
      });
      const note = markerNote(commentText(raw));
      if (m?.kind === "todo" && ATTRS_ONLY.test(note)) {
        attrsMark = {
          attrs: note.toLowerCase().split(/ and /),
          note,
        };
      } else if (m) {
        next = m.kind === "none" ? null : m;
        rest = null;
      }
      continue;
    }
    const st = next ?? rest ?? inherited;
    if (ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch)) {
      const block = !INLINE.has(tagOf(ch));
      walkJsxElement(ctx, ch, st, attrsMark, block ? false : inBlock);
      attrsMark = null;
      consume();
    } else if (ts.isJsxFragment(ch)) {
      walkJsxChildren(ctx, ch.children, st, inBlock);
      consume();
    } else if (ts.isJsxExpression(ch) && ch.expression) {
      if (inBlock && ts.isStringLiteral(ch.expression)) continue;
      walk(ctx, ch.expression, st);
      consume();
    }
  }
}

/** Object properties and statements: a marker speaks for the siblings after it, up to the next comment
    (phone/src/lib/strings.ts groups its keys that way). Array elements: the next element only. */
function walkList(ctx: TsCtx, nodes: ts.NodeArray<ts.Node>, inherited: Mark) {
  const isArray =
    !!nodes[0]?.parent && ts.isArrayLiteralExpression(nodes[0].parent);
  let group: Mark | null = null;
  for (const child of nodes) {
    const ranges = ts.getLeadingCommentRanges(ctx.text, child.pos) ?? [];
    let own: Mark | null = null;
    for (const b of commentBlocks(ctx.text, ranges)) {
      const m = blockMark(ctx, b);
      if (m) own = m;
    }
    if (isArray) {
      walk(ctx, child, own && own.kind !== "none" ? own : inherited);
      continue;
    }
    if (own) group = own.kind === "none" ? null : own;
    walk(ctx, child, group ?? inherited);
  }
}

function walk(ctx: TsCtx, node: ts.Node, st: Mark): void {
  if (
    ts.isImportDeclaration(node) ||
    ts.isExportDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isTypeNode(node)
  )
    return;
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
    walkJsxElement(ctx, node, st, null, false);
    return;
  }
  if (ts.isJsxFragment(node)) {
    walkJsxChildren(ctx, node.children, st, false);
    return;
  }
  const v = literalValue(node);
  if (v !== undefined) {
    if (!skipLiteral(node)) {
      const { path: key, leaf } = propPath(node);
      if (leaf && PROP_DENY.has(leaf)) return;
      if (leaf === "what" && /\.claim\b/.test(key)) return; // in the claims list
      addRow(ctx, "literal", v, node.getStart(ctx.sf), st, {
        key: key || undefined,
        leaf,
        claim: /(^|\.)claim(\.text)?$/.test(key) || undefined,
      });
    }
    return;
  }
  if (ts.isPropertyAssignment(node) && node.name.getText() === "claim")
    recordTsClaim(ctx, node);
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    /^[A-Z][A-Z0-9_]+$/.test(node.name.text) &&
    node.initializer &&
    ts.isStringLiteral(node.initializer)
  )
    constants.set(node.name.text, node.initializer.text);
  ts.forEachChild(
    node,
    (c) => {
      walk(ctx, c, st);
    },
    (arr) => {
      walkList(ctx, arr, st);
    },
  );
}

function recordClaim(ctx: TsCtx, el: ts.JsxElement | ts.JsxSelfClosingElement) {
  const attrs = ts.isJsxElement(el)
    ? el.openingElement.attributes
    : el.attributes;
  const whatAttr = attrs.properties.find(
    (a): a is ts.JsxAttribute =>
      ts.isJsxAttribute(a) && a.name.getText() === "what",
  );
  const where = `${ctx.file}:${lineOf(ctx, el.getStart(ctx.sf))}`;
  const whatLit = whatAttr ? attrValue(whatAttr) : undefined;
  const text = ts.isJsxElement(el) ? fullText(el.children) : "";
  if (whatLit !== undefined && hasLetters(text)) {
    claims.push({ text, what: whatLit, where, kind: "inline" });
  } else {
    const init = whatAttr?.initializer;
    const expr =
      init && ts.isJsxExpression(init) && init.expression
        ? init.expression.getText()
        : (whatLit ?? "");
    claimUsages.push({ where, expr });
  }
}

function recordTsClaim(ctx: TsCtx, node: ts.PropertyAssignment) {
  const where = `${ctx.file}:${lineOf(ctx, node.getStart(ctx.sf))}`;
  const obj = node.parent;
  const get = (o: ts.ObjectLiteralExpression, name: string) => {
    const p = o.properties.find(
      (x): x is ts.PropertyAssignment =>
        ts.isPropertyAssignment(x) && x.name.getText() === name,
    );
    return p ? literalValue(p.initializer) : undefined;
  };
  const init = node.initializer;
  if (ts.isObjectLiteralExpression(init)) {
    const text = get(init, "text");
    const what = get(init, "what");
    const featureKey = ts.isObjectLiteralExpression(obj)
      ? get(obj, "key")
      : undefined;
    if (text && what)
      claims.push({
        text,
        what,
        where,
        kind: `feature:${featureKey ?? "?"}`,
      });
  } else {
    const what = literalValue(init);
    if (what && ts.isObjectLiteralExpression(obj)) {
      const q = get(obj, "q");
      const a = get(obj, "a");
      claims.push({
        text: [q, a].filter(Boolean).join(" "),
        what,
        where,
        kind: "faq",
      });
    }
  }
}

function scanTs(file: string, includeNone: boolean): Row[] {
  const src = read(file);
  const isAstro = file.endsWith(".astro");
  const text = isAstro ? astroToTsx(src) : src;
  const kind =
    isAstro || file.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : file.endsWith(".js")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(
    file + (isAstro ? ".tsx" : ""),
    text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
  const diags =
    (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  for (const d of diags.slice(0, 3)) {
    const line = sf.getLineAndCharacterOfPosition(d.start ?? 0).line + 1;
    warnings.push(
      `${file}:${line}: the parser stumbled (${ts.flattenDiagnosticMessageText(d.messageText, " ")}); strings near it may be missing.`,
    );
  }
  const ctx: TsCtx = {
    file,
    sf,
    text,
    rows: [],
    floor: [],
    lineMarks: new Map(),
    nextLineMarks: new Map(),
    markedProps: new Set(),
    includeNone,
    claimDepth: 0,
    wholeNotes: [],
  };
  prepareMarks(ctx);
  walk(ctx, sf, NONE);
  wholeNotesAll.push(...ctx.wholeNotes);
  // A string can be met twice (a block and its own expression); keep it once.
  const seen = new Set<string>();
  return ctx.rows.filter((r) => {
    const k = `${r.line}\u0000${r.key ?? ""}\u0000${r.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* -------------------------------------------- Rust, Swift, Python, YAML */

interface Tok {
  kind: "str" | "comment";
  pos: number;
  end: number;
  line: number;
  endLine: number;
  value: string;
}

function scanTokens(text: string, lang: "rust" | "swift" | "python"): Tok[] {
  const toks: Tok[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++)
    if (text[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (p: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= p) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const push = (kind: Tok["kind"], pos: number, end: number, value: string) =>
    toks.push({
      kind,
      pos,
      end,
      line: lineAt(pos),
      endLine: lineAt(Math.max(pos, end - 1)),
      value,
    });
  const unescape = (s: string) => s.replace(/\\(["'\\])/g, "$1");
  const readQuoted = (start: number, q: string): number => {
    let j = start + q.length;
    while (j < text.length) {
      if (text[j] === "\\") {
        if (lang === "swift" && text[j + 1] === "(") {
          let depth = 0;
          j += 1;
          for (; j < text.length; j++) {
            if (text[j] === "(") depth++;
            else if (text[j] === ")" && --depth === 0) break;
          }
          j++;
          continue;
        }
        j += 2;
        continue;
      }
      if (text.startsWith(q, j)) return j + q.length;
      if (q.length === 1 && text[j] === "\n" && lang !== "rust") return j;
      j++;
    }
    return j;
  };
  let i = 0;
  const lineComment = lang === "python" ? "#" : "//";
  while (i < text.length) {
    const c = text[i];
    if (text.startsWith(lineComment, i)) {
      const j = text.indexOf("\n", i);
      const end = j < 0 ? text.length : j;
      push("comment", i, end, text.slice(i, end));
      i = end;
      continue;
    }
    if (lang !== "python" && text.startsWith("/*", i)) {
      const j = text.indexOf("*/", i + 2);
      const end = j < 0 ? text.length : j + 2;
      push("comment", i, end, text.slice(i, end));
      i = end;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < text.length && /\w/.test(text[j])) j++;
      const id = text.slice(i, j);
      if (lang === "rust" && /^(r|br|b)$/.test(id) && /["#]/.test(text[j])) {
        const m = text.slice(j).match(/^(#*)"/);
        if (m) {
          const close = `"${m[1]}`;
          const startQ = j + m[0].length;
          const k = text.indexOf(close, startQ);
          const end = k < 0 ? text.length : k + close.length;
          push("str", i, end, text.slice(startQ, k < 0 ? text.length : k));
          i = end;
          continue;
        }
      }
      if (
        lang === "python" &&
        /^[rbfu]{1,2}$/i.test(id) &&
        /["']/.test(text[j])
      ) {
        i = j;
        continue; // the quote is read next, with the prefix's position lost (fine for line numbers)
      }
      i = j;
      continue;
    }
    if (c === '"' || (c === "'" && lang === "python")) {
      const q =
        lang !== "rust" && text.startsWith(c.repeat(3), i) ? c.repeat(3) : c;
      const end = readQuoted(i, q);
      push("str", i, end, unescape(text.slice(i + q.length, end - q.length)));
      i = end;
      continue;
    }
    if (c === "'" && lang === "rust") {
      const m = text.slice(i).match(/^'(?:\\.|\\u\{[0-9a-fA-F]+\}|[^\\'])'/);
      i += m ? m[0].length : 1;
      continue;
    }
    i++;
  }
  return toks;
}

const LOG_MACRO =
  /\b(?:log::)?(?:info|warn|error|debug|trace|println|eprintln|print|eprint|panic|assert\w*|unreachable|todo|write|writeln)!\s*\($/;

function scanLineBased(
  file: string,
  lang: "rust" | "swift" | "python",
  includeNone: boolean,
): Row[] {
  const text = read(file);
  const toks = scanTokens(text, lang);
  let testFrom = Infinity;
  if (lang === "rust") {
    const m = text.match(/^\s*#\[cfg\(test\)\]/m);
    if (m && m.index !== undefined) testFrom = m.index;
  }
  if (lang === "python") {
    const m = text.match(/^if __name__ == /m);
    if (m && m.index !== undefined) testFrom = m.index;
  }
  const rows: Row[] = [];
  const marked = new Map<Tok, string>();
  const lineMarks = new Map<number, string>();
  let floor: { pos: number; note: string } | null = null;
  // consecutive comment lines read as one comment
  const comments: Tok[] = [];
  for (const c of toks.filter((t) => t.kind === "comment")) {
    const last = comments[comments.length - 1];
    const lineStart = text.lastIndexOf("\n", c.pos - 1) + 1;
    const own = text.slice(lineStart, c.pos).trim() === "";
    if (last && own && last.endLine + 1 === c.line) {
      last.value += "\n" + c.value;
      last.end = c.end;
      last.endLine = c.endLine;
    } else comments.push({ ...c });
  }
  for (const c of comments) {
    const t = commentText(c.value);
    if (!TODO.test(t)) continue;
    const lineStart = text.lastIndexOf("\n", c.pos - 1) + 1;
    const trailing = text.slice(lineStart, c.pos).trim() !== "";
    const note = markerNote(t, WHOLE.test(t) || REST.test(t));
    if (trailing) {
      lineMarks.set(c.line, note);
      continue;
    }
    // a doc comment that points at a JSON file next to the code
    const json = t.match(/\b([\w-]+\.json)\b/);
    if (json && /^\s*\/\/[!/]/.test(c.value)) {
      const jf = path.posix.join(path.posix.dirname(file), json[1]);
      if (exists(jf)) rows.push(...jsonDescriptions(jf, file, c.line, note));
      continue;
    }
    if (WHOLE.test(t) || REST.test(t)) {
      if (!floor) floor = { pos: WHOLE.test(t) ? 0 : c.pos, note };
      wholeNotesAll.push(`${file}:${c.line}: ${note}`);
      continue;
    }
    // the next statement's strings
    let collected = 0;
    let lastLine = -1;
    let prevEnd = c.end;
    for (const t2 of toks) {
      if (t2.pos <= c.pos) continue;
      if (t2.kind === "comment") {
        if (collected) break;
        continue;
      }
      if (collected) {
        const between = text.slice(prevEnd, t2.pos);
        if (
          (lang !== "python" && between.includes(";")) ||
          /\n[ \t]*\n/.test(between) ||
          t2.line > lastLine + 1
        )
          break;
      } else if (t2.line > c.endLine + 12) break;
      if (proseLike(t2.value)) {
        marked.set(t2, note);
        collected++;
        lastLine = t2.endLine;
      }
      prevEnd = t2.end;
    }
    if (!collected)
      warnings.push(
        `${file}:${c.line}: a TODO(copy) with no string after it the generator could read.`,
      );
  }
  for (const t of toks) {
    if (t.kind !== "str" || t.pos >= testFrom) continue;
    const before = text.slice(Math.max(0, t.pos - 200), t.pos);
    const stmt = before.slice(before.lastIndexOf(";") + 1);
    if (LOG_MACRO.test(stmt.replace(/\s+/g, " ").trimEnd())) continue;
    if (
      /\b(?:log::)?(?:info|warn|error|debug|trace|eprintln|println|panic)!\s*\(/.test(
        stmt,
      )
    )
      continue;
    let status: Status = "none";
    let note: string | undefined;
    if (t.value.includes("TODO(copy)")) {
      status = "todo";
      note = "the marker TODO(copy) is inside the string itself";
    } else if (lineMarks.has(t.line) || lineMarks.has(t.endLine)) {
      status = "todo";
      note = lineMarks.get(t.line) ?? lineMarks.get(t.endLine);
    } else if (marked.has(t)) {
      status = "todo";
      note = marked.get(t);
    } else if (floor && t.pos >= floor.pos) {
      status = "todo";
      note = floor.note;
    }
    const value = t.value;
    if (!proseLike(value)) continue;
    if (status === "none") {
      if (!includeNone || !looksDanish(value)) continue;
      // a list of words the code matches against ("nej", "jeg mener"), not text it shows
      const lineText = text.split("\n")[t.line - 1] ?? "";
      if (/^\s*("(?:[^"\\]|\\.)*",?\s*)+$/.test(lineText)) continue;
    }
    if (status === "todo" && englishOnly(value) && !looksDanish(value))
      continue;
    const where = `${file}:${t.line}`;
    if (isAppendixA(value)) {
      appendixSkipped.push(`${where} ${value}`);
      if (status === "todo") appendixMarked.push(`${where}: "${value}"`);
      continue;
    }
    rows.push({ file, line: t.line, text: value, status, note });
  }
  return rows;
}

function jsonDescriptions(
  jf: string,
  from: string,
  fromLine: number,
  note: string,
): Row[] {
  const rows: Row[] = [];
  const lines = read(jf).split("\n");
  lines.forEach((l, i) => {
    const m = l.match(/^\s*"(description\w*|name)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m && m[1].startsWith("description") && looksDanish(m[2]))
      rows.push({
        file: jf,
        line: i + 1,
        key: m[1],
        text: m[2].replace(/\\"/g, '"'),
        status: "todo",
        note: `${note} (flagged at ${from}:${fromLine})`,
      });
  });
  return rows;
}

function scanYaml(file: string): Row[] {
  const lines = read(file).split("\n");
  const rows: Row[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^(\s*)#\s?(.*TODO\(copy\).*)$/);
    const trailing = l.match(/^(\s*)([\w-]+):\s*(.+?)\s+#.*TODO\(copy\)/);
    if (trailing) {
      rows.push(yamlRow(file, i + 1, trailing[2], trailing[3], ""));
      return;
    }
    if (!m) return;
    const indent = m[1].length;
    const note = markerNote(m[2]);
    for (let j = i + 1; j < lines.length; j++) {
      const k = lines[j].match(/^(\s*)([\w-]+):\s*(.+)$/);
      if (!k || k[1].length !== indent) break;
      if (proseLike(k[3].replace(/^["']|["']$/g, "")))
        rows.push(yamlRow(file, j + 1, k[2], k[3], note));
    }
  });
  return rows.filter((r) => proseLike(r.text));
}
const yamlRow = (
  file: string,
  line: number,
  key: string,
  raw: string,
  note: string,
): Row => ({
  file,
  line,
  key,
  text: raw
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^'(.*)'$/, "$1"),
  status: "todo",
  note: note || undefined,
});

function scanJsonMarked(file: string): Row[] {
  const rows: Row[] = [];
  read(file)
    .split("\n")
    .forEach((l, i) => {
      for (const m of l.matchAll(
        /"((?:[^"\\]|\\.)*TODO\(copy\)(?:[^"\\]|\\.)*)"/g,
      ))
        rows.push({
          file,
          line: i + 1,
          key: l.match(/^\s*"([^"]+)"\s*:/)?.[1],
          text: m[1],
          status: "todo",
          note: "the marker TODO(copy) is inside the string itself",
        });
    });
  return rows;
}

/* ------------------------------------------------------------ files */

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  const skip =
    /(^|\/)(node_modules|dist|dist-e2e|target|e2e|test|tests|__tests__|\.variants)(\/|$)|\.(test|spec)\.|\.d\.ts$|(^|\/)tests?\.rs$/;
  const go = (d: string) => {
    if (!exists(d)) return;
    for (const name of fs.readdirSync(abs(d)).sort()) {
      const p = `${d}/${name}`;
      if (skip.test(p)) continue;
      if (fs.statSync(abs(p)).isDirectory()) go(p);
      else if (exts.some((e) => name.endsWith(e))) out.push(p);
    }
  };
  go(dir);
  return out;
}

/* ------------------------------------------------------------ desktop */

type Tree = { [key: string]: string | Tree };
function flatten(tree: Tree, prefix: string, out: [string, string][] = []) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push([key, v]);
    else if (v && typeof v === "object") flatten(v, key, out);
  }
  return out;
}

const DA_JSON = "src/i18n/locales/da/translation.json";
const daStrings = flatten(JSON.parse(read(DA_JSON)) as Tree, "");
const wtRows: Row[] = [];
for (const [key, value] of daStrings) {
  if (!key.startsWith("wt.")) continue;
  if (isAppendixA(value)) {
    appendixSkipped.push(`${key} ${value}`);
    continue;
  }
  wtRows.push({ file: DA_JSON, key, text: value, status: "todo" });
}

function gh(args: string[]): string | null {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout;
}

/** Desktop core strings (outside `wt`) that are not Handy's own Danish. */
const coreRows: Row[] = [];
/** 0: not in Handy's file, 1: reworded, 2: only the name or an em dash changed */
const coreKind = new Map<string, number>();
let handyNote = "";
{
  const raw = gh([
    "api",
    "repos/cjpais/Handy/contents/src/i18n/locales/da/translation.json",
  ]);
  let upstream: Map<string, string> | null = null;
  if (raw) {
    try {
      const j = JSON.parse(raw) as { content: string; sha: string };
      upstream = new Map(
        flatten(
          JSON.parse(Buffer.from(j.content, "base64").toString("utf8")) as Tree,
          "",
        ),
      );
      handyNote = `Handy's Danish file on GitHub (cjpais/Handy, main, blob ${j.sha.slice(0, 7)})`;
    } catch {
      upstream = null;
    }
  }
  if (!upstream) {
    warnings.push(
      "Could not read Handy's Danish translation through gh: the desktop core strings outside `wt` were not compared.",
    );
  } else {
    const mech = (s: string) =>
      s
        .replace(/Handys/g, "WalkieTalkeys")
        .replace(/Handy/g, "WalkieTalkey")
        .replace(/HANDY_/g, "WALKIETALKEY_")
        .replace(/[—.,:;!…]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
    for (const [key, value] of daStrings) {
      if (key.startsWith("wt.")) continue;
      const up = upstream.get(key);
      if (up === value) {
        labelCorpus.push({ where: `${key} (Handy's Danish)`, text: value });
        continue;
      }
      if (isAppendixA(value)) {
        appendixSkipped.push(`${key} ${value}`);
        continue;
      }
      const kind = up === undefined ? 0 : mech(up) === mech(value) ? 2 : 1;
      const extra = [
        "not in Handy's Danish file today (added by WalkieTalkey, or dropped by Handy since)",
        `reworded from Handy's "${up}"`,
        `only the name or an em dash changed from Handy's "${up}"`,
      ][kind];
      coreRows.push({
        file: DA_JSON,
        key,
        text: value,
        status: "todo",
        extra,
        line: undefined,
      });
      coreKind.set(key, kind);
    }
    // new and reworded first; mechanical changes of Handy's own text last
    coreRows.sort((a, b) => coreKind.get(a.key!)! - coreKind.get(b.key!)!);
  }
}

const rustRows = listFiles("src-tauri/src/walkietalkey", [".rs"]).flatMap((f) =>
  scanLineBased(f, "rust", true),
);
const desktopTsRows = listFiles("src/walkietalkey", [".ts", ".tsx"]).flatMap(
  (f) => scanTs(f, true),
);

/* ------------------------------------------------------------ phone */

const phoneRows = [
  ...listFiles("phone/src", [".ts", ".tsx"]).flatMap((f) => scanTs(f, true)),
  ...(exists("phone/pwa.ts") ? scanTs("phone/pwa.ts", false) : []),
];
const iosRows = [
  ...listFiles("ios", [".swift"]).flatMap((f) =>
    scanLineBased(f, "swift", true),
  ),
  ...listFiles("ios", [".yml", ".yaml"]).flatMap((f) => scanYaml(f)),
];

/* ------------------------------------------------------------ site */

const siteFiles = listFiles("site/src", [".astro", ".ts", ".tsx"]);
const siteRows = siteFiles.flatMap((f) => scanTs(f, true));
const uiRows = listFiles("packages/ui/src", [".ts", ".tsx"]).flatMap((f) =>
  scanTs(f, false),
);

/* ------------------------------------------------- developer tools, models */

const toolRows = [
  ...listFiles("training/wt_train", [".py"]).flatMap((f) =>
    scanLineBased(f, "python", false),
  ),
  ...listFiles("training/wt_train", [".js"]).flatMap((f) => scanTs(f, false)),
  ...listFiles("training/configs", [".yaml", ".yml"]).flatMap((f) =>
    scanYaml(f),
  ),
  ...listFiles("models", [".json"]).flatMap((f) => scanJsonMarked(f)),
  ...listFiles("models", [".py"]).flatMap((f) =>
    scanLineBased(f, "python", false),
  ),
];

/* ------------------------------------------------------------ releases */

interface RelLine {
  text: string;
  line: number;
}
function danishSection(body: string): {
  marks: RelLine[];
  danish: RelLine[];
  english: RelLine[];
} {
  const lines = body.split(/\r?\n/);
  const marks: RelLine[] = [];
  const danish: RelLine[] = [];
  const english: RelLine[] = [];
  let mode: "" | "da" | "en" = "";
  lines.forEach((l, i) => {
    if (/TODO\((copy|claim)\)/.test(l))
      marks.push({ text: l.trim(), line: i + 1 });
    if (/^\*\*På dansk\*\*/.test(l.trim())) mode = "da";
    else if (/^\*\*In English\*\*/.test(l.trim())) mode = "en";
    else if (/^\*\*.+\*\*\s*$/.test(l.trim()) || /^#/.test(l)) mode = "";
    else if (l.trim() && !/^<!--/.test(l.trim())) {
      const t = l.trim().replace(/^[-*]\s+/, "");
      if (mode === "da") danish.push({ text: t, line: i + 1 });
      if (mode === "en") english.push({ text: t, line: i + 1 });
    }
  });
  return { marks, danish, english };
}

const releaseRows: Row[] = [];
const releaseInfo: string[] = [];
{
  const changelog = read("CHANGELOG.md");
  const clLines = changelog.split("\n");
  const sections: { version: string; start: number; body: string }[] = [];
  clLines.forEach((l, i) => {
    const m = l.match(/^## \[([^\]]+)\]/);
    if (m) sections.push({ version: m[1], start: i, body: "" });
  });
  sections.forEach((s, k) => {
    const end =
      k + 1 < sections.length ? sections[k + 1].start : clLines.length;
    s.body = clLines.slice(s.start, end).join("\n");
  });
  const cl020 = sections.find((s) => s.version === "0.2.0");
  const clDanish020 = cl020 ? danishSection(cl020.body).danish : [];

  const raw = gh([
    "release",
    "view",
    "v0.2.0",
    "--repo",
    "JonathanRentoft/walkietalkey",
    "--json",
    "body,name,tagName,url",
  ]);
  if (!raw) {
    warnings.push(
      "Could not read the v0.2.0 release through gh: the release notes come from CHANGELOG.md only.",
    );
  } else {
    const rel = JSON.parse(raw) as { body: string; name: string; url: string };
    const { marks, danish, english } = danishSection(rel.body);
    releaseInfo.push(
      `GitHub release v0.2.0 (${rel.url}): marks ${marks.map((m) => `\`${m.text}\``).join(", ") || "none"}; ${danish.length} Danish bullets.`,
    );
    danish.forEach((d, i) => {
      const cl = clDanish020.find((c) => c.text === d.text);
      releaseRows.push({
        file: "GitHub release v0.2.0",
        line: undefined,
        key: `Danish bullet ${i + 1}${cl && cl020 ? `; same as CHANGELOG.md:${cl020.start + cl.line}` : "; differs from CHANGELOG.md"}`,
        text: d.text,
        status: "todo",
        note: marks.length ? markerNote(commentText(marks[0].text)) : undefined,
      });
    });
    english.forEach((e) =>
      labelCorpus.push({
        where: "GitHub release v0.2.0 (English part)",
        text: e.text,
      }),
    );
  }
  for (const s of sections) {
    if (s.version === "0.2.0" && raw) continue; // shown from the release itself
    const { marks, danish, english } = danishSection(s.body);
    if (!danish.length && !marks.length) continue;
    releaseInfo.push(
      `CHANGELOG.md [${s.version}] (line ${s.start + 1}): ${marks.length ? marks.map((m) => `\`${m.text}\``).join(", ") : "no marker"}; ${danish.length} Danish lines.`,
    );
    danish.forEach((d) =>
      releaseRows.push({
        file: "CHANGELOG.md",
        line: s.start + d.line,
        key: `[${s.version}]`,
        text: d.text,
        status: "todo",
        note: marks.length ? markerNote(commentText(marks[0].text)) : undefined,
      }),
    );
    english.forEach((e) =>
      labelCorpus.push({
        where: `CHANGELOG.md:${s.start + e.line} (English)`,
        text: e.text,
      }),
    );
  }
}

/* ------------------------------------------------------------ approved */

const APPROVED_KEYS = "src/walkietalkey/copy-approved.json";
const APPROVED_TEXTS = "scripts/walkietalkey/copy-approved-texts.json";
interface ApprovedKeys {
  about: string;
  strings: Record<string, string>;
}
interface ApprovedTexts {
  about: string;
  files: Record<string, string[]>;
}
const approvedKeys: ApprovedKeys = exists(APPROVED_KEYS)
  ? JSON.parse(read(APPROVED_KEYS))
  : { about: "", strings: {} };
const approvedTexts: ApprovedTexts = exists(APPROVED_TEXTS)
  ? JSON.parse(read(APPROVED_TEXTS))
  : { about: "", files: {} };
const rowGroups = [
  wtRows,
  coreRows,
  rustRows,
  desktopTsRows,
  phoneRows,
  iosRows,
  siteRows,
  uiRows,
  releaseRows,
  toolRows,
];
{
  const at = process.argv.indexOf("--approve");
  const prefixes =
    at > 0 ? process.argv.slice(at + 1).filter((a) => !a.startsWith("--")) : [];
  if (prefixes.length) {
    const hit = (r: Row) =>
      prefixes.some(
        (p) =>
          r.file.startsWith(p) || (r.file === DA_JSON && r.key?.startsWith(p)),
      );
    const keys = { ...approvedKeys.strings };
    const files: Record<string, string[]> = {};
    for (const [f, list] of Object.entries(approvedTexts.files))
      files[f] = [...list];
    let added = 0;
    for (const r of rowGroups.flat()) {
      // TODO(claim) stays until measured.
      if (r.status !== "todo" || r.claim || !hit(r)) continue;
      if (r.file === DA_JSON) {
        if (keys[r.key!] !== r.text) added++;
        keys[r.key!] = r.text;
      } else {
        const list = (files[r.file] ??= []);
        if (!list.includes(r.text)) {
          list.push(r.text);
          added++;
        }
      }
    }
    // Translation keys in the file's order; files sorted.
    const order = new Map(daStrings.map(([k], i) => [k, i]));
    const sortedKeys = Object.fromEntries(
      Object.entries(keys).sort(
        ([a], [b]) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9),
      ),
    );
    const sortedFiles = Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
    );
    const ABOUT_KEYS =
      "The Danish strings of translation.json (src/i18n/locales/da) the owner approved, by key. A string is approved while its text is exactly this; a new or changed string is TODO(copy) again. Read by scripts/walkietalkey/copy-list.ts (COPY.md) and todo-copy.ts; add to it with `bun scripts/walkietalkey/todo-copy.ts --approve <key prefix>`.";
    const ABOUT_TEXTS =
      "Danish copy written in the code (desktop backend and TSX, phone app, iOS shell, website pages, release notes) the owner approved, by file, after its TODO(copy) marker was removed. A text is approved while it is exactly this. Read by scripts/walkietalkey/todo-copy.ts; add to it with `bun scripts/walkietalkey/todo-copy.ts --approve <file prefix>`. The desktop's translation strings are in src/walkietalkey/copy-approved.json.";
    approvedKeys.about = approvedKeys.about || ABOUT_KEYS;
    approvedKeys.strings = sortedKeys;
    approvedTexts.about = approvedTexts.about || ABOUT_TEXTS;
    approvedTexts.files = sortedFiles;
    // Formatted like the rest of the repo, so prettier --check passes.
    for (const [file, value] of [
      [APPROVED_KEYS, approvedKeys],
      [APPROVED_TEXTS, approvedTexts],
    ] as const)
      fs.writeFileSync(
        abs(file),
        await format(JSON.stringify(value, null, 2), { parser: "json" }),
      );
    console.log(
      `Approved ${added} strings (${APPROVED_KEYS}, ${APPROVED_TEXTS}).`,
    );
  }
  for (const r of rowGroups.flat()) {
    if (r.claim || r.status === "approved") continue;
    const ok =
      r.file === DA_JSON
        ? approvedKeys.strings[r.key!] === r.text
        : (approvedTexts.files[r.file] ?? []).includes(r.text);
    if (ok) r.status = "approved";
  }
}

{
  // COPY.md is generated by copy-list.ts from the same JSON; say where the two disagree.
  const copyMd = read("src/walkietalkey/COPY.md");
  const marked = new Set<string>();
  for (const l of copyMd.split("\n")) {
    const m = l.match(/^\|\s*`(wt\.[^`]+)`\s*\|.*\|\s*TODO\(copy\)\s*\|\s*$/);
    if (m) marked.add(m[1]);
  }
  const ours = new Set(
    wtRows.filter((r) => r.status !== "approved").map((r) => r.key!),
  );
  for (const k of marked)
    if (!ours.has(k))
      warnings.push(
        `src/walkietalkey/COPY.md marks \`${k}\` TODO(copy), but its text is in spec Appendix A (here compared without Appendix A's notes in brackets and a final full stop), so it is left out.`,
      );
  for (const k of ours)
    if (!marked.has(k))
      warnings.push(
        `\`${k}\` is not marked TODO(copy) in src/walkietalkey/COPY.md (out of date? run bun run copy:list); listed here anyway.`,
      );
}

/* -------------------------------------------------- unproven: what a row states */

const FACT_RULES: [string, RegExp][] = [
  [
    "number",
    /\d[\d.,]*\s?(?:%|MB|GB|TB|dB|kr\.?|ms|sekund\w*|minut\w*|timer?s?|dage?|døgn|år|milliard\w*|parametre|enheder)(?![\p{L}])/giu,
  ],
  [
    "platform",
    /\b(?:macOS|iOS|iPadOS|Android|Windows)\s?\d+(?:\.\d+)?(?:\s?\(22H2\))?|\bApple Silicon\b|\bIntel\b|\b64-bit\b|\b(?:Ventura|Sonoma|Sequoia|Tahoe)\b|\bmed Chrome\b/g,
  ],
];
const KIND_RULES: [string, RegExp][] = [
  [
    "privacy or security promise",
    /krypter|gemmes ikke|gemmer aldrig|bliver ikke gemt|gemmes aldrig|ingen sporing|ingen konto|ingen analyse|telemetri|cookie|kan ikke læse|ser aldrig|slettes|lokalt|din egen computer|dataansvarlig|databehandler|ingen server|forlader aldrig|sendes aldrig|ingen sky/i,
  ],
  [
    "legal or licence statement",
    /apache|\bMIT\b|licens|varemærke|\bCVR\b|datatilsynet|vilkår|SIL Open Font|NVIDIA|©|ophavsret|rettigheder|omfattet af/i,
  ],
  [
    "how macOS, iOS, Windows or a browser behaves",
    /signeret|advarer|blokerer|Secure Input|macOS (?:siger|spørger|kører|beder)|Windows advarer|hjemmeskærm|Safari|\bEdge\b|SmartScreen|udklipsholder|Apple Intelligence|diskbilled|nøglering|Notifikationer/i,
  ],
  [
    "speed or timing",
    /sekund|minut|med det samme|hurtig|langsom|ventetid|på et minut|realtid|lige så snart|så snart/i,
  ],
  [
    "accuracy or quality",
    /fejlrate|nøjagtig|forstår|præcis\w* (?:dansk|tale)|mest præcise|\bWER\b|FLEURS|kraftigere|retter/i,
  ],
];

interface Label {
  da: string;
  en: string;
  platform: string;
  check: string;
  test: (t: string) => boolean;
  /** only where the copy is about that product (tested on "where") */
  scope?: RegExp;
}
/** Copy that talks about Safari or Edge, or draws macOS apps: the phone app, the site, the release notes. */
const OUTSIDE_APP = /phone\/|site\/|CHANGELOG|release|packages\/ui/;
const re = (r: RegExp) => (t: string) => r.test(t);
const exact =
  (...xs: string[]) =>
  (t: string) =>
    xs.includes(t.trim());
const MAC = "a Mac with the system language set to Dansk (macOS 26)";
const IPHONE26 = "an iPhone with iOS 26 set to Dansk, in Safari";
const WIN = "a Windows 11 PC set to Dansk";
/** Names of other companies' buttons, menus and panes that our copy quotes in Danish. */
const LABELS: Label[] = [
  {
    da: "Systemindstillinger",
    en: "System Settings",
    platform: "macOS",
    check: `${MAC}: the app's name in the Apple menu`,
    test: re(/Systemindstillinger/),
  },
  {
    da: "Anonymitet og sikkerhed",
    en: "Privacy & Security",
    platform: "macOS",
    check: `${MAC}: the pane in Systemindstillinger's sidebar`,
    test: re(/Anonymitet og sikkerhed/i),
  },
  {
    da: "Beskyttelse af personlige oplysninger og sikkerhed",
    en: "Privacy & security",
    platform: 'Windows (run 8: was Handy\'s "Privatliv og sikkerhed")',
    check: `${WIN}: the page in Indstillinger's sidebar that holds Mikrofon`,
    test: re(/Beskyttelse af personlige oplysninger og sikkerhed/),
  },
  {
    da: "Åbn alligevel",
    en: "Open Anyway",
    platform: "macOS (Gatekeeper)",
    check: `${MAC}: open an unsigned WalkieTalkey once, then the button under Anonymitet og sikkerhed › Sikkerhed`,
    test: re(/Åbn alligevel/i),
  },
  {
    da: "Sikkerhed",
    en: "Security (the section)",
    platform: "macOS",
    check: `${MAC}: the section heading in Anonymitet og sikkerhed where "Åbn alligevel" appears`,
    test: re(
      /står under Sikkerhed et stykke tid|Anonymitet og sikkerhed › Sikkerhed/,
    ),
  },
  {
    da: "Tilgængelighed",
    en: "Accessibility",
    platform: "macOS",
    check: `${MAC}: Systemindstillinger › Anonymitet og sikkerhed › Tilgængelighed`,
    test: re(/\bTilgængelighed\b/),
  },
  {
    da: "Mikrofon",
    en: "Microphone",
    platform: "macOS",
    check: `${MAC}: Systemindstillinger › Anonymitet og sikkerhed › Mikrofon (also our own onboarding step's name)`,
    test: re(/\bMikrofon\b/),
  },
  {
    da: "Notifikationer",
    en: "Notifications",
    platform: "macOS",
    check: `${MAC}: the pane in Systemindstillinger's sidebar`,
    test: re(/\bNotifikationer\b/),
  },
  {
    da: "Programmer",
    en: "Applications",
    platform: "macOS (Finder)",
    check: `${MAC}: the folder in Finder's sidebar and in the disk image window`,
    test: re(/\bProgrammer\b/),
  },
  {
    da: "menulinjen",
    en: "the menu bar",
    platform: "macOS",
    check: `${MAC}: Apple's Danish name for the menu bar (Danish macOS help, Systemindstillinger › Kontrolcenter)`,
    test: re(/menulinje/i),
  },
  {
    da: "Globustasten",
    en: "the Globe key",
    platform: "macOS keyboards",
    check: `${MAC}: Systemindstillinger › Tastatur, the name of the 🌐/fn key`,
    test: re(/globustast/i),
  },
  {
    da: "Nøgleringsadgang",
    en: "Keychain Access",
    platform: "macOS",
    check: `${MAC}: the app's name in Programmer › Hjælpeprogrammer`,
    test: re(/Nøgleringsadgang/),
  },
  {
    da: "nøgleringen",
    en: "the keychain",
    platform: "macOS",
    check: `${MAC}: the word in the keychain password dialog`,
    test: re(/nøglering(?!sadgang)/i),
  },
  {
    da: "Sikker tastaturindtastning",
    en: "Secure Keyboard Entry",
    platform: "macOS Terminal",
    check: `${MAC}: Terminal's app menu`,
    test: re(/Sikker tastaturindtastning/i),
  },
  {
    da: "Post",
    en: "Mail (the app's menu)",
    platform: "macOS Mail (picture on the front page)",
    check: `${MAC}: the Mail app's own name in the menu bar`,
    test: exact("Post"),
    scope: OUTSIDE_APP,
  },
  {
    da: "Arkiv / Rediger / Vis",
    en: "File / Edit / View",
    platform: "macOS Mail (picture)",
    check: `${MAC}: Mail's menu bar`,
    test: exact("Arkiv", "Rediger", "Vis"),
    scope: OUTSIDE_APP,
  },
  {
    da: "Ny besked",
    en: "New Message",
    platform: "macOS Mail (picture)",
    check: `${MAC}: the title of Mail's new message window`,
    test: exact("Ny besked"),
    scope: OUTSIDE_APP,
  },
  {
    da: "Til: / Emne:",
    en: "To: / Subject:",
    platform: "macOS Mail (picture)",
    check: `${MAC}: the field labels in a new Mail message`,
    test: exact("Til:", "Til", "Emne:", "Emne"),
    scope: OUTSIDE_APP,
  },
  {
    da: "Ny note",
    en: "New Note",
    platform: "macOS Notes (picture)",
    check: `${MAC}: a new note's title in Notes`,
    test: exact("Ny note"),
    scope: OUTSIDE_APP,
  },
  {
    da: "Del",
    en: "Share",
    platform: "iOS Safari",
    check: `${IPHONE26}, and an iPhone with iOS 18: the share button's name`,
    test: re(/\bDel\b/),
    scope: OUTSIDE_APP,
  },
  {
    da: "Vis mere",
    en: "View More",
    platform: "iOS 26 Safari",
    check: `${IPHONE26}: ••• › Del, the row that shows more actions`,
    test: (t) => /\bVis mere\b/.test(t) && !/Behold/.test(t),
    scope: OUTSIDE_APP,
  },
  {
    da: "Føj til hjemmeskærm",
    en: "Add to Home Screen",
    platform: "iOS Safari",
    check: `${IPHONE26}: the action in the share sheet`,
    test: re(/Føj til hjemmeskærm/i),
    scope: OUTSIDE_APP,
  },
  {
    da: "Tilføj",
    en: "Add",
    platform: "iOS Safari",
    check: `${IPHONE26}: the button at the top right after Føj til hjemmeskærm`,
    test: re(/\bTilføj\b/),
    scope: OUTSIDE_APP,
  },
  {
    da: "Behold",
    en: "Keep",
    platform: "Microsoft Edge on Windows",
    check: `${WIN}, Edge in Danish: download WalkieTalkey-windows.exe, the downloads panel's ••• menu`,
    test: re(/\bBehold\b(?! alligevel)/),
    scope: OUTSIDE_APP,
  },
  {
    da: "Vis mere (Edge)",
    en: "Show more",
    platform: "Microsoft Edge on Windows",
    check: `${WIN}: the dialog after Behold`,
    test: (t) => /\bVis mere\b/.test(t) && /Behold/.test(t),
    scope: OUTSIDE_APP,
  },
  {
    da: "Behold alligevel",
    en: "Keep anyway",
    platform: "Microsoft Edge on Windows",
    check: `${WIN}: the last button in that dialog`,
    test: re(/Behold alligevel/i),
    scope: OUTSIDE_APP,
  },
  {
    da: "Flere oplysninger",
    en: "More info",
    platform: "Windows SmartScreen",
    check: `${WIN}: run the unsigned installer, the link in the blue SmartScreen window`,
    test: re(/Flere oplysninger/i),
  },
  {
    da: "Kør alligevel",
    en: "Run anyway",
    platform: "Windows SmartScreen",
    check: `${WIN}: the button after Flere oplysninger`,
    test: re(/Kør alligevel/i),
  },
  {
    da: "proceslinjen",
    en: "the taskbar",
    platform: "Windows",
    check: `${WIN}: Windows' own Danish word for the taskbar`,
    test: re(/proceslinje/i),
  },
  {
    da: "meddelelsesområdet",
    en: "the notification area (tray)",
    platform: "Windows (Handy's Danish)",
    check: `${WIN}: Windows' own Danish word for the tray`,
    test: re(/meddelelsesområde/i),
  },
  {
    da: "Kontrolcenter",
    en: "Control Center",
    platform: "iOS",
    check: "an iPhone set to Dansk",
    test: re(/Kontrolcenter/),
  },
];

const appStrings = new Set<string>(
  [...daStrings.map(([, v]) => v), ...phoneRows.map((r) => r.text)].map((s) =>
    s.trim().replace(/[.:]$/, "").toLowerCase(),
  ),
);

const labelHits = (l: Label, text: string, at: string) =>
  l.test(text) && (!l.scope || l.scope.test(at));
function labelsIn(r: Row): string[] {
  return LABELS.filter((l) => labelHits(l, r.text, r.file)).map((l) => l.da);
}

function unproven(r: Row, refs?: Map<string, number>): string {
  const parts: string[] = [];
  for (const [name, rx] of FACT_RULES) {
    const hits = [...new Set(r.text.match(rx) ?? [])];
    if (hits.length) parts.push(`${name} (${hits.join(", ")})`);
  }
  for (const [name, rx] of KIND_RULES) if (rx.test(r.text)) parts.push(name);
  const labels = labelsIn(r);
  if (labels.length) parts.push(`OS label: ${labels.join(", ")}`);
  let s = parts.length
    ? `Wording, and the fact: ${parts.join("; ")}`
    : "Wording not approved";
  if (r.claim) s += "; **TODO(claim)**: see Claims";
  if (r.extra) s += `; ${r.extra}`;
  for (const m of r.text.matchAll(/\{([A-Z][A-Z0-9_]+)\}/g))
    if (constants.has(m[1])) s += `; {${m[1]}} is "${constants.get(m[1])}"`;
  const ref = r.note && refs?.get(r.note);
  const note = ref ? `[m${ref}]` : `"${r.note}"`;
  if (r.status === "source") s += `; not marked, a comment says: ${note}`;
  else if (r.status === "none")
    s += "; not marked TODO(copy), not in Appendix A";
  else if (r.note && !WHOLE.test(r.note) && !REST.test(r.note))
    s += `; marker: ${note}`;
  return s;
}

/* ------------------------------------------------------------ grouping */

const where = (r: Row) =>
  r.line !== undefined
    ? `\`${r.file}:${r.line}\`${r.key && r.file !== DA_JSON ? ` ${r.key}` : ""}`
    : `${r.file}${r.key ? ` (${r.key})` : ""}`;
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function table(
  rows: Row[],
  keyCol = false,
  refs?: Map<string, number>,
): string {
  if (!rows.length) return "None.\n";
  const head = keyCol
    ? "| Key | Danish | What is unproven |\n|---|---|---|"
    : "| Where | Danish | What is unproven |\n|---|---|---|";
  return (
    head +
    "\n" +
    rows
      .map(
        (r) =>
          `| ${keyCol ? `\`${r.key}\`` : cell(where(r))} | ${cell(r.text)} | ${cell(unproven(r, refs))} |`,
      )
      .join("\n") +
    "\n"
  );
}

const todoOf = (rows: readonly Row[]) =>
  rows.filter((r) => r.status === "todo");
const otherOf = (rows: readonly Row[]) =>
  rows.filter((r) => r.status !== "todo" && r.status !== "approved");
const approvedOf = (rows: readonly Row[]) =>
  rows.filter((r) => r.status === "approved");

function block(
  title: string,
  rows: Row[],
  level = "###",
  keyCol = false,
): string {
  const todo = todoOf(rows);
  const other = otherOf(rows);
  let s = `${level} ${title}\n\n${todo.length} marked TODO(copy)${other.length ? `, ${other.length} more not marked` : ""}.\n\n`;
  // long implementer notes are printed once, above the table
  const refs = new Map<string, number>();
  for (const r of rows)
    if (
      r.note &&
      r.note.length > 70 &&
      !WHOLE.test(r.note) &&
      !REST.test(r.note) &&
      !refs.has(r.note)
    )
      refs.set(r.note, refs.size + 1);
  if (refs.size)
    s +=
      "Notes next to the markers, quoted from the code:\n\n" +
      [...refs.entries()]
        .map(([note, i]) => `- [m${i}] ${cell(note)}`)
        .join("\n") +
      "\n\n";
  s += table(todo, keyCol, refs);
  if (other.length)
    s += `\nNot marked TODO(copy) and not in Appendix A (approve or confirm the source):\n\n${table(other, keyCol, refs)}`;
  return s + "\n";
}

// Website pages, by the key each page passes to <Base page="...">.
const PAGE_ORDER = [
  "hent",
  "how",
  "privacy",
  "security",
  "oss",
  "business",
  "trademark",
  "faq",
  "notFound",
];
const pageOfFile = new Map<string, string>();
for (const f of siteFiles.filter((f) => f.startsWith("site/src/pages/"))) {
  const m = read(f).match(/<Base\s+page="([^"]+)"/);
  if (m) pageOfFile.set(f, m[1]);
}
const pagePath = new Map<string, string>();
for (const r of siteRows) {
  const m = r.key?.match(/^PAGES\.(\w+)\.path$/);
  if (m) pagePath.set(m[1], r.text);
}
{
  const site = read("site/src/lib/site.ts");
  for (const m of site.matchAll(/^\s{2}(\w+): \{\n\s+path: "([^"]+)"/gm))
    pagePath.set(m[1], m[2]);
}

function siteGroup(r: Row): string {
  const f = r.file;
  if (f === "site/src/lib/site.ts") {
    const m = r.key?.match(/^PAGES\.(\w+)\.(title|description)$/);
    if (m) return m[1] === "home" ? "concept:shared" : `page:${m[1]}`;
    return "shared";
  }
  if (f.startsWith("site/src/pages/"))
    return `page:${pageOfFile.get(f) ?? path.basename(f, ".astro")}`;
  if (f === "site/src/lib/features.ts") return "concept:features";
  if (
    f.startsWith("site/src/components/home/") ||
    f === "site/src/lib/hero.ts" ||
    f === "site/src/lib/stage.ts" ||
    f.startsWith("site/src/concepts/current/")
  )
    return "concept:current";
  const c = f.match(/^site\/src\/concepts\/([^/]+)\//);
  if (c) return `concept:${c[1]}`;
  return "shared";
}

/* ------------------------------------------------------------ claims */

const PROOF: Record<string, string> = {
  "hvor godt talemodellen forstår hvisken i telefonen":
    "Record whispered dictations on the phone (wt-train record has a whisper condition) and compare the error rate with normal voice on the same sentences; say it only if whispering is close.",
  "hvor godt talemodellen forstår hvisken":
    "Error rate of whispered dictations against normal voice on the same sentences, on the phone and on the Mac (wt-train record has a whisper condition); say it only if whispering is close.",
  "hvor godt Edda skriver engelske ord i danske sætninger":
    "Error rate on Danish sentences with English developer words (the workbench's developer-term sentences), with Udviklerord on, counting the English words separately.",
  "ventetiden, efter du slipper (DESK-43)":
    "Time from letting go to text, `walkietalkey --transcribe-file <wav> --live` (DESK-43, DESK-46), on a typical Mac and on the minimum computer (8 GB RAM).",
};

function claimShownIn(c: ClaimRow): string[] {
  if (c.kind === "inline") return [c.where];
  const out: string[] = [];
  for (const u of claimUsages) {
    if (c.kind.startsWith("feature:")) {
      const key = c.kind.slice("feature:".length);
      if (
        new RegExp(`FEATURES\\.${key}\\.claim`).test(u.expr) ||
        /^\w+\.claim\.what$/.test(u.expr)
      )
        out.push(u.where);
    } else if (c.kind === "faq" && /^q\.claim$|FAQ/.test(u.expr))
      out.push(u.where);
  }
  return out;
}

/* ------------------------------------------------------------ labels */

const allRows = [
  ...wtRows,
  ...coreRows,
  ...rustRows,
  ...desktopTsRows,
  ...phoneRows,
  ...iosRows,
  ...siteRows,
  ...uiRows,
  ...releaseRows,
  ...toolRows,
];
const corpus = [
  ...allRows.map((r) => ({
    where: r.file === DA_JSON ? `\`${r.key}\`` : where(r),
    text: r.text,
  })),
  ...labelCorpus.map((c) => ({ where: c.where, text: c.text })),
];

function labelTable(): string {
  const lines = [
    "| Label in our copy | English original | Platform | Check on | Quoted at |",
    "|---|---|---|---|---|",
  ];
  for (const l of LABELS) {
    const hits = corpus
      .filter((c) => labelHits(l, c.text, c.where))
      .map((c) => c.where);
    if (!hits.length) continue;
    const uniq = [...new Set(hits)];
    const shown = uniq.slice(0, 6).join(", ");
    lines.push(
      `| ${cell(l.da)} | ${cell(l.en)} | ${cell(l.platform)} | ${cell(l.check)} | ${cell(shown)}${uniq.length > 6 ? ` and ${uniq.length - 6} more` : ""} |`,
    );
  }
  return lines.join("\n") + "\n";
}

/** Names in "A › B › C" paths that are neither in LABELS nor among the app's own strings. */
function otherPathSegments(): string {
  const known = (s: string) => {
    const k = s.trim().replace(/[.:]$/, "").toLowerCase();
    return (
      appStrings.has(k) ||
      LABELS.some((l) => l.da.toLowerCase() === k || l.test(s))
    );
  };
  const found = new Map<string, Set<string>>();
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  for (const c of corpus) {
    if (!/[›→]/.test(c.text)) continue;
    const segs = c.text.replace(/\([^)]*\)/g, " ").split(/\s*[›→]\s*/);
    segs.forEach((seg, i) => {
      const w = words(seg.replace(/["“”]/g, ""));
      // the name is the end of the first segment and the start of the last one
      const options: string[] = [];
      for (let k = Math.min(4, w.length); k >= 1; k--)
        options.push(
          (i === 0 ? w.slice(-k) : w.slice(0, k))
            .join(" ")
            .replace(/[.,;:]+$/, ""),
        );
      if (i > 0 && i < segs.length - 1) options.unshift(w.join(" "));
      if (options.some((o) => known(o))) return;
      const name = options[options.length - 1] ?? "";
      if (!name || !/\p{L}{2}/u.test(name) || !looksDanish(name)) return;
      if (/^(tryk|på|og|i|til|under|gå|vælg)$/i.test(name)) return;
      if (!found.has(name)) found.set(name, new Set());
      found.get(name)!.add(c.where);
    });
  }
  if (!found.size) return "None.\n";
  const lines = ["| Name | Quoted at |", "|---|---|"];
  for (const [s, w] of [...found.entries()].sort(([a], [b]) =>
    a.localeCompare(b, "da"),
  ))
    lines.push(`| ${cell(s)} | ${cell([...w].slice(0, 5).join(", "))} |`);
  return lines.join("\n") + "\n";
}

/* ------------------------------------------------------------ cross-checks */

function filesWithMarker(dirs: string[], exts: string[]): string[] {
  return dirs
    .flatMap((d) => listFiles(d, exts))
    .filter((f) => read(f).includes("TODO(copy)"));
}
const markerFiles = filesWithMarker(
  [
    "src/walkietalkey",
    "src-tauri/src",
    "phone/src",
    "site/src",
    "packages/ui/src",
    "ios",
    "training/wt_train",
    "training/configs",
    "models",
  ],
  [
    ".ts",
    ".tsx",
    ".astro",
    ".rs",
    ".swift",
    ".yml",
    ".yaml",
    ".py",
    ".js",
    ".json",
  ],
).concat(
  exists("phone/pwa.ts") && read("phone/pwa.ts").includes("TODO(copy)")
    ? ["phone/pwa.ts"]
    : [],
);
const filesWithRows = new Set(
  allRows.filter((r) => r.status === "todo").map((r) => r.file),
);
const silentFiles = markerFiles.filter(
  (f) =>
    !filesWithRows.has(f) &&
    !appendixMarked.some((a) => a.startsWith(`${f}:`)) &&
    !(
      f === "src-tauri/src/walkietalkey/catalog.rs" &&
      filesWithRows.has("src-tauri/src/walkietalkey/catalog.json")
    ),
);

const claimMentions: string[] = [];
for (const d of ["src", "src-tauri/src", "phone/src", "site/src"]) {
  for (const f of listFiles(d, [
    ".ts",
    ".tsx",
    ".astro",
    ".rs",
    ".css",
    ".md",
  ])) {
    read(f)
      .split("\n")
      .forEach((l, i) => {
        if (l.includes("TODO(claim)")) claimMentions.push(`${f}:${i + 1}`);
      });
  }
}

/* ------------------------------------------------------------ document */

const n = (rows: readonly Row[]) => todoOf(rows).length;
const m = (rows: readonly Row[]) => otherOf(rows).length;
const a = (rows: readonly Row[]) => approvedOf(rows).length;
const siteByGroup = new Map<string, Row[]>();
for (const r of siteRows) {
  const g = siteGroup(r);
  if (!siteByGroup.has(g)) siteByGroup.set(g, []);
  siteByGroup.get(g)!.push(r);
}
const conceptRows = siteRows.filter((r) => siteGroup(r).startsWith("concept:"));
const pageRows = siteRows.filter((r) => !siteGroup(r).startsWith("concept:"));
const desktopAll = [...wtRows, ...coreRows, ...rustRows, ...desktopTsRows];
const phoneAll = [...phoneRows, ...iosRows];

const counts = [
  ["Desktop app: screens (`wt.*`)", wtRows],
  ["Desktop app: Handy's core screens, changed or added", coreRows],
  ["Desktop app: backend (Rust) and TSX", [...rustRows, ...desktopTsRows]],
  ["Phone app (web app, PWA manifest, iOS shell)", phoneAll],
  ["Website pages (shared parts and each page)", pageRows],
  ["Front page (shared copy and the four front pages)", conceptRows],
  ["Release notes (Danish part)", releaseRows],
  ["Design system components (packages/ui)", uiRows],
  ["Developer tools and model files (owner-facing)", toolRows],
] as const;

const claimLines = claims.map((c, i) => {
  const shown = claimShownIn(c);
  return `| ${i + 1} | ${cell(c.text)} | ${cell(`\`${c.where}\``)}${shown.length && c.kind !== "inline" ? `; drawn by ${shown.map((s) => `\`${s}\``).join(", ")}` : ""} (draft previews only; production leaves it out) | ${cell(c.what)} | ${cell(PROOF[c.what] ?? "(no suggestion yet: measure what the left column says)")} |`;
});

const conceptTitles: [string, string][] = [
  ["concept:shared", "The front page's title and description (every concept)"],
  [
    "concept:features",
    "Shared copy for the concepts (`site/src/lib/features.ts`)",
  ],
  [
    "concept:current",
    "Current front page, in production (`concepts/current`, `components/home`, `lib/hero.ts`, `lib/stage.ts`)",
  ],
  ["concept:editorial", "Concept A: Editorial (`concepts/editorial`)"],
  ["concept:stage", "Concept B: Product stage (`concepts/stage`)"],
  ["concept:hands-on", "Concept C: Hands-on (`concepts/hands-on`)"],
];
const pageNav = new Map<string, string>();
for (const r of siteRows) {
  const m = r.key?.match(/^PAGES\.(\w+)\.nav$/);
  if (m) pageNav.set(m[1], r.text);
}
const pageTitle = (k: string) =>
  k === "notFound"
    ? "404 (/404)"
    : `${pageNav.get(k) ?? k} (${pagePath.get(k) ?? "?"})`;

const doc = `# TODO(copy) and TODO(claim): what the owner approves

Generated by \`bun scripts/walkietalkey/todo-copy.ts\` from the working tree${handyNote ? `, ${handyNote}` : ""} and the v0.2.0 release on GitHub. Regenerate it after any copy change instead of editing it.

- Every row is Danish text a visitor or user sees, quoted verbatim from the source. "Where" is the file and line (or the i18n key); fix wording there.
- "What is unproven": always the wording; when the text states a number, a platform, a privacy or legal promise, a speed or another product's button, that is named too.
- Strings verbatim from spec Appendix A are left out (${appendixSkipped.length} of them), and so is copy the owner approved while its text is unchanged (${a(allRows)} strings; \`${APPROVED_KEYS}\` by key, \`${APPROVED_TEXTS}\` by file). Rows "not marked" carry no TODO(copy) and are not in Appendix A either: approve them too, or confirm where they came from.
- A suggested order: the two "Decide first" lists; then what users see today (desktop screens, phone app, website pages, the current front page, release notes); then the shared front-page copy and only the concept the owner picks; the developer tools last (only the owner sees them).

## Counts

| Surface | Marked TODO(copy) | Not marked | Approved (left out) |
|---|---|---|---|
${counts.map(([name, rows]) => `| ${name} | ${n(rows)} | ${m(rows)} | ${a(rows)} |`).join("\n")}
| **All** | **${n(allRows)}** | **${m(allRows)}** | **${a(allRows)}** |

Claims not yet measured (TODO(claim)): **${claims.length}**.

## Decide first: claims not yet measured (TODO(claim))

Shown only in draft previews (\`SITE_DRAFT=1\`), with a visible TODO(claim) tag; production leaves them out until measured (\`site/src/components/home/Claim.astro\`).

| # | Claim (Danish, verbatim) | Where it is shown | What must be measured (from the code) | What would prove it |
|---|---|---|---|---|
${claimLines.join("\n")}

Release notes and pages also state measured numbers without a TODO(claim) (e.g. error rates, dB, MB): the tables below name them under "the fact: number".

## Decide first: UI labels not verified on a device set to Danish

Names of macOS, iOS, Windows and browser buttons, menus and panes that our Danish copy quotes. Nobody has checked them on a device set to Danish. Each one: open the place named under "Check on" and compare letter by letter.

${labelTable()}
Other names in "A › B" paths that are neither above nor among the app's own strings (check whether they are a real menu name, ours or the system's):

${otherPathSegments()}
## Desktop app

${block("Screens: `wt.*` in `src/i18n/locales/da/translation.json`", wtRows, "###", true)}${block(
  `Handy's screens: strings outside \`wt\` that are not Handy's own Danish (compared with ${handyNote || "nothing: Handy's file could not be read"}; ${daStrings.filter(([k]) => !k.startsWith("wt.")).length - coreRows.length} unchanged strings left out; some of these screens may not be reachable in WalkieTalkey)`,
  coreRows,
  "###",
  true,
)}${block("Backend (Rust, `src-tauri/src/walkietalkey`), shown as it comes", rustRows)}${block("Screens' code (`src/walkietalkey/**/*.tsx`)", desktopTsRows)}
## Phone app

${block("Web app (`phone/src`, `phone/pwa.ts`)", phoneRows)}${block("iOS shell (`ios/`)", iosRows)}
## Website

${block("Shared: layout, navigation, footer, page names (`layouts/`, `components/`, `lib/site.ts`)", siteByGroup.get("shared") ?? [])}${[
  ...PAGE_ORDER,
  ...[...siteByGroup.keys()]
    .filter((g) => g.startsWith("page:"))
    .map((g) => g.slice(5))
    .filter((k) => !PAGE_ORDER.includes(k))
    .sort(),
]
  .filter((k) => siteByGroup.has(`page:${k}`))
  .map((k) => block(`Page ${pageTitle(k)}`, siteByGroup.get(`page:${k}`)!))
  .join("")}
## Front-page concepts

The production front page and the three concepts the owner compares (run 6). Text that comes from \`lib/features.ts\` is listed once, under the shared copy; each concept lists only its own strings, so only the picked concept's table needs approving.

${conceptTitles
  .filter(([g]) => siteByGroup.has(g))
  .map(([g, t]) => block(t, siteByGroup.get(g)!))
  .join("")}
## Release notes

${releaseInfo.map((l) => `- ${l}`).join("\n")}

${table(releaseRows)}
## Design system components (\`packages/ui\`)

Only strings marked TODO(copy); the rest of the design system's Danish comes from the owner's design system.

${table(todoOf(uiRows))}
## Developer tools and model files

The fine-tuning workbench (\`training/\`, used by the owner) and the model files (\`models/\`).

${table(toolRows)}
## Extraction notes

- Marked as a whole (every string in the file, or from that line on):
${[...new Set(wholeNotesAll)].map((w) => `  - \`${w.split(": ")[0]}\`: ${w.split(": ").slice(1).join(": ")}`).join("\n")}
- Marked TODO(copy) although verbatim in Appendix A: ${appendixMarked.length ? appendixMarked.map((a) => `\`${a}\``).join("; ") : "none"}.
- Files with a TODO(copy) marker that gave no marked row: ${silentFiles.length ? silentFiles.map((f) => `\`${f}\``).join(", ") : "none"}.
- TODO(claim) mentions in src/, src-tauri/, phone/, site/src (the claim machinery and its styles; the claims themselves are listed above): ${claimMentions.map((c) => `\`${c}\``).join(", ") || "none"}.
- Warnings: ${warnings.length ? "\n" + warnings.map((w) => `  - ${w}`).join("\n") : "none."}
- Not read: strings in \`packages/ui\` without a marker (design system), Handy's unchanged Danish, the training recorder's HTML.
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, doc);
console.log(
  `Wrote ${path.relative(root, outPath)}: ${n(allRows)} marked TODO(copy), ${m(allRows)} not marked, ${a(allRows)} approved, ${claims.length} claims, ${appendixSkipped.length} Appendix A strings left out.`,
);
for (const [name, rows] of counts)
  console.log(`  ${name}: ${n(rows)} + ${m(rows)} (${a(rows)} approved)`);
if (warnings.length)
  console.log(`  ${warnings.length} warnings (see the end of the file).`);
