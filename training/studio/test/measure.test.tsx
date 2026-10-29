/* Evaluering, run 12: measure on the validation by default, the test set only after a confirm,
   a test result marked as test, every use of the test set shown, and the comparison offering the
   validation results first. */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EvaluationScreen } from "../src/screens/Evaluation";
import { fakeFetch } from "./fake-fetch";

let fake: ReturnType<typeof fakeFetch> | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

const region = (name: string) => screen.findByRole("region", { name });

describe("measuring", () => {
  it("measures a training run on the validation as a job, and the result joins the list", async () => {
    fake = fakeFetch();
    render(<EvaluationScreen />);
    const m = await region("Mål en model");
    const model = await within(m).findByRole("combobox", { name: "Model" });
    expect(model).toHaveDisplayValue(
      "Edda finjusteret (first-frozen-encoder) · 26. okt. 2026",
    );
    fireEvent.click(
      within(m).getByRole("button", { name: "Mål på valideringen" }),
    );
    await within(m).findByText(
      "Måling på valideringen: Edda finjusteret (first-frozen-encoder)",
    );
    expect(fake!.posts("/api/eval/measure")[0].body).toEqual({
      backend: "lora",
      run: "first-frozen-encoder-20261026-2112",
      dataset: "validation",
      fleurs: true,
    });
    expect(
      await within(m).findByText(
        "Målingen er færdig. Den står i listen nedenfor.",
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        fake!.calls.filter((c) => c.url === "/api/eval/runs").length,
      ).toBeGreaterThan(1),
    );
  });

  it("measures Edda on a built dataset, without FLEURS when asked", async () => {
    fake = fakeFetch();
    render(<EvaluationScreen />);
    const m = await region("Mål en model");
    fireEvent.change(
      await within(m).findByRole("combobox", { name: "Model" }),
      {
        target: { value: "edda" },
      },
    );
    const build = within(m).getByRole("combobox", { name: "Datasæt" });
    expect(
      [...build.querySelectorAll("option")].map((o) => o.textContent),
    ).toContain("smoke (ikke bygget)");
    fireEvent.change(build, { target: { value: "smoke" } });
    expect(
      within(m).getByText("wt-train build configs/smoke.yaml"),
    ).toBeInTheDocument();
    expect(
      within(m).getByRole("button", { name: "Mål på valideringen" }),
    ).toBeDisabled();
    fireEvent.change(build, { target: { value: "first-frozen-encoder" } });
    fireEvent.click(
      within(m).getByRole("checkbox", { name: /Spring FLEURS over/ }),
    );
    fireEvent.click(
      within(m).getByRole("button", { name: "Mål på valideringen" }),
    );
    await waitFor(() =>
      expect(fake!.posts("/api/eval/measure")).toHaveLength(1),
    );
    expect(fake!.posts("/api/eval/measure")[0].body).toEqual({
      backend: "hf",
      build: "first-frozen-encoder",
      dataset: "validation",
      fleurs: false,
    });
  });

  it("uses the test set only after a confirm that says why", async () => {
    fake = fakeFetch();
    render(<EvaluationScreen />);
    const m = await region("Mål en model");
    await within(m).findByRole("combobox", { name: "Model" });
    fireEvent.click(
      within(m).getByRole("button", { name: "Mål på testsættet" }),
    );
    const confirm = within(m).getByRole("group", { name: "Brug testsættet" });
    expect(confirm).toHaveTextContent(
      "Testsættet er til den endelige måling. Hver gang du bruger det, bliver det skrevet ned.",
    );
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Nej, ikke nu" }),
    );
    expect(fake!.posts("/api/eval/measure")).toHaveLength(0);
    fireEvent.click(
      within(m).getByRole("button", { name: "Mål på testsættet" }),
    );
    fireEvent.click(
      within(m).getByRole("button", { name: "Ja, mål på testsættet" }),
    );
    await waitFor(() =>
      expect(fake!.posts("/api/eval/measure")).toHaveLength(1),
    );
    expect(fake!.posts("/api/eval/measure")[0].body).toEqual({
      backend: "lora",
      run: "first-frozen-encoder-20261026-2112",
      dataset: "test",
      fleurs: true,
      confirm: true,
    });
    await within(m).findByText(
      "Måling på testsættet: Edda finjusteret (first-frozen-encoder)",
    );
    // Once it is done, the new use is listed with the others.
    const t = await region("Testsættet");
    await waitFor(
      () =>
        expect(within(t).getByRole("heading", { level: 3 })).toHaveTextContent(
          "Brugt 3 gange",
        ),
      { timeout: 4000 },
    );
    expect(within(t).getAllByText("fra Værkstedet")).toHaveLength(1);
  });

  it("shows whether the test set is frozen and every use of it", async () => {
    fake = fakeFetch();
    render(<EvaluationScreen />);
    const t = await region("Testsættet");
    expect(
      await within(t).findByText(
        "Låst den 28. okt. 2026: 104 sætninger og 312 klip.",
      ),
    ).toBeInTheDocument();
    expect(
      within(t).getByText("Fra datasættet first-frozen-encoder."),
    ).toBeInTheDocument();
    expect(within(t).getByRole("heading", { level: 3 })).toHaveTextContent(
      "Brugt 2 gange",
    );
    const uses = within(t).getByRole("list", {
      name: "Hver brug af testsættet",
    });
    const items = within(uses).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("27. okt. 2026 kl. 12.42");
    expect(items[0]).toHaveTextContent("first-frozen-encoder-20261026-2112");
    expect(items[0]).toHaveTextContent("fra terminalen");
  });

  it("marks a test result as test, and a validation result as validation", async () => {
    fake = fakeFetch();
    render(<EvaluationScreen />);
    const now = await region("Normalisering 2");
    const row = (name: string) =>
      within(now).getByText(name).closest("tr") as HTMLElement;
    expect(
      within(row("Appen · Dine optagelser")).getByTitle("Målt på testsættet"),
    ).toHaveTextContent("Test");
    expect(
      within(row("Edda, original · Dine optagelser, validering")).getByText(
        "Validering",
      ),
    ).toBeInTheDocument();
    expect(
      within(row("Appen · FLEURS · 26. okt.")).queryByText("Test"),
    ).toBeNull();
  });

  it("compares validation results by default", async () => {
    fake = fakeFetch();
    render(<EvaluationScreen />);
    const c = await region("Sammenlign to kørsler");
    expect(
      within(c).getByRole("radio", { name: "Validering" }),
    ).toHaveAttribute("aria-checked", "true");
    const [a] = within(c).getAllByRole("combobox");
    const names = () =>
      [...a.querySelectorAll("option")].map((o) => o.textContent).slice(1);
    expect(names()).toEqual([
      "Edda finjusteret (first-frozen-encoder) · Dine optagelser, validering (12,0\u00a0%)",
      "Edda, original · Dine optagelser, validering (20,3\u00a0%)",
    ]);
    fireEvent.click(within(c).getByRole("radio", { name: "Alle" }));
    expect(names()).toHaveLength(9);
    expect(names()).toContain("Appen · Dine optagelser · Test (20,3\u00a0%)");
  });

  it("on a first start: nothing to measure yet, and a test set neither frozen nor used", async () => {
    fake = fakeFetch({ empty: true });
    render(<EvaluationScreen />);
    expect(
      await screen.findByText(
        "Her kan du måle Edda og dine træninger på valideringen.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("wt-train build configs/first-frozen-encoder.yaml"),
    ).toBeInTheDocument();
    const t = await region("Testsættet");
    expect(
      within(t).getByText("Testsættet er ikke låst endnu."),
    ).toBeInTheDocument();
    expect(within(t).getByText("Ikke brugt endnu.")).toBeInTheDocument();
  });
});
