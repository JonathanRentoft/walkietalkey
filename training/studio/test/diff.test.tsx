import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DiffOp, Take } from "../src/api/types";
import { DiffLegend, WordDiff } from "../src/components/take";
import { diffCounts, diffTokens } from "../src/lib/diff";

const OPS: DiffOp[] = [
  { op: "eq", ref: "vi", hyp: "vi" },
  { op: "sub", ref: "pr'en", hyp: "pr" },
  { op: "del", ref: "når", hyp: null },
  { op: "ins", ref: null, hyp: "lige" },
  { op: "eq", ref: "grønt", hyp: "grønt" },
];

function take(diff: DiffOp[] | null, wer: number | null): Take {
  return {
    n: 1,
    url: "/api/takes/phone-whisper/s0042.wav",
    seconds: 3.1,
    recorded_at: "2026-10-27T10:00:51+01:00",
    microphone: "iPhone-mikrofon",
    level_dbfs: -38.2,
    peak_dbfs: -14,
    noise_dbfs: -61,
    snr_db: 22.8,
    envelope: [],
    problems: [],
    transcribing: false,
    heard: null,
    wer,
    diff,
    edda_error: null,
    review: { status: "approved", by: "check" },
  };
}

describe("diffTokens", () => {
  it("keeps the alignment's four kinds", () => {
    expect(diffTokens(OPS).map((t) => t.kind)).toEqual([
      "eq",
      "sub",
      "del",
      "ins",
      "eq",
    ]);
    expect(diffCounts(diffTokens(OPS))).toEqual({
      eq: 2,
      sub: 1,
      del: 1,
      ins: 1,
      errors: 3,
    });
  });

  it("tidies what does not add up", () => {
    const odd: DiffOp[] = [
      { op: "sub", ref: "a", hyp: "a" }, // the same word: equal
      { op: "sub", ref: null, hyp: "b" }, // nothing in the reference: inserted
      { op: "sub", ref: "c", hyp: null }, // nothing heard: deleted
      { op: "del", ref: null, hyp: null }, // empty: dropped
      { op: "zap" as DiffOp["op"], ref: "d", hyp: "d" }, // unknown: a plain word
    ];
    expect(diffTokens(odd).map((t) => t.kind)).toEqual([
      "eq",
      "ins",
      "del",
      "eq",
    ]);
    expect(diffTokens(null)).toEqual([]);
  });
});

describe("WordDiff", () => {
  it("strikes the sentence's word and shows Edda's word for a substitution", () => {
    const { container } = render(<WordDiff take={take(OPS, 0.75)} />);
    const sub = container.querySelector(".w-sub")!;
    expect(sub.querySelector("del")).toHaveTextContent("pr'en");
    expect(sub.querySelector("ins")).toHaveTextContent("pr");
    expect(sub).toHaveTextContent("pr'en, hørt som pr");
  });

  it("strikes a word Edda did not hear, and underlines one it added", () => {
    const { container } = render(<WordDiff take={take(OPS, 0.75)} />);
    expect(container.querySelector(".w-del del")).toHaveTextContent("når");
    expect(container.querySelector(".w-del ins")).toBeNull();
    expect(container.querySelector(".w-ins ins")).toHaveTextContent("lige");
    expect(container.querySelector(".w-ins del")).toBeNull();
    expect(container.querySelector(".w-ins")).toHaveTextContent(
      "ekstra ord lige",
    );
  });

  it("shows equal words plainly and the share of errors", () => {
    const { container } = render(<WordDiff take={take(OPS, 0.75)} />);
    expect(
      container.querySelectorAll(".w:not(.w-sub):not(.w-del):not(.w-ins)"),
    ).toHaveLength(2);
    expect(screen.getByText(/75\s%\sordfejl/)).toBeInTheDocument();
  });

  it("says so when every word was right", () => {
    render(<WordDiff take={take([{ op: "eq", ref: "vi", hyp: "vi" }], 0)} />);
    expect(screen.getByText("Alle ord rigtige")).toBeInTheDocument();
  });

  it("has a legend with a cue that is not colour alone", () => {
    const { container } = render(<DiffLegend />);
    expect(container.querySelector(".w-sub del")).not.toBeNull();
    expect(container.querySelector(".w-sub ins")).not.toBeNull();
    expect(container.querySelector(".w-del del")).toHaveTextContent(
      "Ikke hørt",
    );
    expect(container.querySelector(".w-ins ins")).toHaveTextContent(
      "Ekstra ord",
    );
  });
});
