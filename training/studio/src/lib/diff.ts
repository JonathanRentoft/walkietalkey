/* What Edda heard against the sentence: the word alignment from align.py (`diff` in a take) as
   tokens for the page. `eq` the same word, `sub` a word heard as another, `del` a word Edda did
   not hear, `ins` a word Edda heard that is not in the sentence. */
import type { DiffOp, DiffOpKind } from "../api/types";

export interface DiffToken {
  kind: DiffOpKind;
  ref: string;
  hyp: string;
}

const KINDS = new Set<DiffOpKind>(["eq", "sub", "del", "ins"]);

/** Normalise the server's ops: unknown ops are shown as plain words, empty ones are dropped. */
export function diffTokens(
  diff: readonly DiffOp[] | null | undefined,
): DiffToken[] {
  if (!diff) return [];
  const out: DiffToken[] = [];
  for (const d of diff) {
    const ref = d.ref ?? "";
    const hyp = d.hyp ?? "";
    let kind: DiffOpKind = KINDS.has(d.op) ? d.op : "eq";
    if (kind === "sub" && ref === hyp) kind = "eq";
    if (kind === "sub" && !ref) kind = "ins";
    if (kind === "sub" && !hyp) kind = "del";
    if (kind === "eq" && !ref && !hyp) continue;
    if (kind === "del" && !ref) continue;
    if (kind === "ins" && !hyp) continue;
    out.push({
      kind,
      ref: kind === "ins" ? "" : ref || hyp,
      hyp: kind === "del" ? "" : hyp || ref,
    });
  }
  return out;
}

export interface DiffCounts {
  eq: number;
  sub: number;
  del: number;
  ins: number;
  errors: number;
}

export function diffCounts(tokens: readonly DiffToken[]): DiffCounts {
  const c: DiffCounts = { eq: 0, sub: 0, del: 0, ins: 0, errors: 0 };
  for (const t of tokens) c[t.kind]++;
  c.errors = c.sub + c.del + c.ins;
  return c;
}
