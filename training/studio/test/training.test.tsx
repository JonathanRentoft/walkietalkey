/* Træning (run 11): the four settings a beginner touches first, each saying what turning it up or
   down does; every other setting folded under "Alle indstillinger". */
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TRAINING_CONFIGS } from "../src/api/fixtures";
import { split, TrainingScreen } from "../src/screens/Training";
import { fakeFetch } from "./fake-fetch";

let fake: ReturnType<typeof fakeFetch> | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

describe("the training settings", () => {
  it("are split into the four first, in their order, and the rest", () => {
    const config = TRAINING_CONFIGS[0];
    const { first, rest } = split(config);
    expect(first.map((s) => s.key)).toEqual([
      "training.learning_rate",
      "training.epochs",
      "lora.rank",
      "rehearsal.share",
    ]);
    expect(rest).toHaveLength(config.settings.length - 4);
    expect(rest.some((s) => first.includes(s))).toBe(false);
    // A server without essentials (an older one): everything is "the rest".
    expect(split({ ...config, essentials: undefined }).first).toEqual([]);
  });

  it("show the four first with what turning them does, the rest folded", async () => {
    fake = fakeFetch();
    const { container } = render(<TrainingScreen />);
    await screen.findByText("Start med disse fire");
    const items = [...container.querySelectorAll(".essential")];
    expect(
      items.map((li) => li.querySelector(".setting-key")?.textContent),
    ).toEqual([
      "training.learning_rate",
      "training.epochs",
      "lora.rank",
      "rehearsal.share",
    ]);
    const rate = items[0] as HTMLElement;
    expect(rate).toHaveTextContent(
      "Hvor store skridt modellen tager, når den lærer",
    );
    expect(rate).toHaveTextContent("0,0002");
    expect(rate).toHaveTextContent(
      "Højere: modellen lærer hurtigere, men kan blive ustabil og glemme almindeligt dansk.",
    );
    expect(
      screen.getByText(/Du ændrer dem i configs\/first-frozen-encoder\.yaml/),
    ).toBeInTheDocument();
    const all = container.querySelector(
      "details.all-settings",
    ) as HTMLDetailsElement;
    expect(all.open).toBe(false);
    expect(
      within(all).getByText(/^Alle indstillinger \(\d+\)$/),
    ).toBeInTheDocument();
    expect(within(all).getByText("data.seed")).toBeInTheDocument();
    expect(within(all).queryByText("training.learning_rate")).toBeNull();
  });

  it("say what will come in the earlier runs before the first training", async () => {
    fake = fakeFetch({ empty: true });
    render(<TrainingScreen />);
    expect(
      await screen.findByText(
        "Her kommer dine træninger med deres bedste epoke og ordfejl.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Den første kommer, når en træning, du har startet ovenfor, er færdig.",
      ),
    ).toBeInTheDocument();
  });
});
