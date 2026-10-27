/* Evaluering (run 11): runs under their readable names, the slug kept small for the command line,
   grouped by the normaliser that counted them, with the 26 October fix explained. */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { EvalRun } from "../src/api/types";
import { byNormaliser, EvaluationScreen } from "../src/screens/Evaluation";
import { fakeFetch } from "./fake-fetch";

let fake: ReturnType<typeof fakeFetch> | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

const run = (id: string, normaliser: number | null): EvalRun => ({
  id,
  name: id,
  title: id,
  normaliser,
  kind: "eval",
  date: null,
  dataset: null,
  model: null,
  backend: null,
  clips: null,
  wer: null,
  wer_ci: null,
  cer: null,
  change: null,
  report: null,
});

describe("the evaluations", () => {
  it("are grouped by normaliser, the newest first, one without a number last", () => {
    const groups = byNormaliser([
      run("a", 2),
      run("b", 1),
      run("c", null),
      run("d", 2),
      run("e", 1),
    ]);
    expect(groups.map((g) => g.version)).toEqual([2, 1, null]);
    expect(groups[0].runs.map((r) => r.id)).toEqual(["a", "d"]);
    expect(groups[1].runs.map((r) => r.id)).toEqual(["b", "e"]);
  });

  it("show readable names in two groups, with the fix explained", async () => {
    fake = fakeFetch();
    render(<EvaluationScreen />);
    const now = await screen.findByRole("region", { name: "Normalisering 2" });
    const before = screen.getByRole("region", { name: "Normalisering 1" });
    expect(now).toHaveTextContent("Fra 26. oktober 2026");
    expect(before).toHaveTextContent("Før 26. oktober 2026");
    const names = (r: HTMLElement) =>
      [...r.querySelectorAll(".run-name")].map((n) => n.textContent);
    expect(names(now)).toEqual([
      "Edda finjusteret (first-frozen-encoder) · Dine optagelser",
      "Appen · Dine optagelser",
      "Appen · FLEURS · 26. okt.",
      "Edda, original · FLEURS · 26. okt.",
    ]);
    expect(names(before)).toEqual([
      "Appen · FLEURS · 25. okt.",
      "Appen · FLEURS · 24. okt.",
      "Edda, original · FLEURS · 24. okt.",
    ]);
    // The slug stays, small, with what it is for.
    const slug = within(now).getByText(
      "20261026-170753-gguf-walkietalkey-edda-v0-2-gguf-edda-v0-2-q8-0-gguf",
    );
    expect(slug).toHaveAttribute(
      "title",
      "Navn i MLflow og i terminalen: 20261026-170753-gguf-walkietalkey-edda-v0-2-gguf-edda-v0-2-q8-0-gguf",
    );
    expect(
      screen.getByText(
        /Det ændrede alle tallene, uden at modellen blev ændret/,
      ),
    ).toBeInTheDocument();
    expect(within(before).getByText("7,63 %")).toBeInTheDocument();
  });

  it("warns when A and B were counted by different normalisers", async () => {
    fake = fakeFetch();
    render(<EvaluationScreen />);
    await screen.findByRole("region", { name: "Normalisering 2" });
    const [a, b] = screen.getAllByRole("combobox");
    // The picker groups the runs the same way.
    expect(
      [...a.querySelectorAll("optgroup")].map((g) => g.getAttribute("label")),
    ).toEqual(["Normalisering 2", "Normalisering 1"]);
    fireEvent.change(a, { target: { value: "5a17e3" } });
    fireEvent.change(b, { target: { value: "4d22c1" } });
    expect(screen.queryByText(/hver sin normalisering/)).toBeNull();
    fireEvent.change(b, { target: { value: "3c44b0" } });
    expect(
      screen.getByText(
        "A og B er målt med hver sin normalisering. En del af forskellen kommer derfor fra rettelsen og ikke fra modellen.",
      ),
    ).toBeInTheDocument();
  });

  it("say what will come, and after which step, before the first evaluation", async () => {
    fake = fakeFetch({ empty: true });
    render(<EvaluationScreen />);
    expect(
      await screen.findByText(
        "Her kommer målingerne af modellerne: ordfejl, tegnfejl og hvor sikre tallene er.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("wt-train eval --backend hf")).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
