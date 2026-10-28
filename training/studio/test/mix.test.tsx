/* The mix on the recording screen (run 12): four whole percents that add up to 100, a preview of
   what each condition gets and how long it takes, what moves, and "Del ud igen" only when no
   recording is picked. */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { duration } from "../src/lib/format";
import { MixPanel, sharesOf, total } from "../src/screens/recording/MixPanel";
import { fakeFetch } from "./fake-fetch";

let fake: ReturnType<typeof fakeFetch> | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

const share = (label: string) =>
  screen.getByRole("spinbutton", { name: `Andel for ${label} i procent` });
const row = (label: string) =>
  screen.getByRole("rowheader", { name: label }).closest("tr") as HTMLElement;

describe("the mix", () => {
  it("shows the shares, the sentences, what is left and the time at his pace", async () => {
    fake = fakeFetch({ empty: true });
    render(<MixPanel reloadKey={null} onDealt={() => {}} />);
    await screen.findByRole("table");
    expect(share("Telefonen, hvisket")).toHaveValue(40);
    expect(share("Mac'en, hvisket")).toHaveValue(0);
    const pw = row("Telefonen, hvisket");
    // 416 planned, 2 done, 414 left at his own 7,6 s: about 52 min.
    expect(pw).toHaveTextContent("416");
    expect(pw).toHaveTextContent("414");
    expect(pw).toHaveTextContent("7,6 s pr. sætning");
    expect(pw).toHaveTextContent("dit tempo");
    expect(pw).toHaveTextContent("ca. 52 min");
    expect(row("Mac'en, almindelig stemme")).toHaveTextContent(
      "pilotens tempo",
    );
    expect(screen.getByText("I alt 100 %")).toBeInTheDocument();
    expect(screen.getByText("Det er det mix, du har nu.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Del ud igen" })).toBeDisabled();
  });

  it("previews a new mix, then deals it as wt-train plan --mix does", async () => {
    fake = fakeFetch({ empty: true });
    const dealt = vi.fn();
    render(<MixPanel reloadKey={null} onDealt={dealt} />);
    await screen.findByRole("table");
    fireEvent.change(share("Telefonen, hvisket"), { target: { value: "30" } });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Andelene skal give 100 % tilsammen. Nu giver de 90 %.",
    );
    expect(screen.getByRole("button", { name: "Del ud igen" })).toBeDisabled();
    fireEvent.change(share("Mac'en, hvisket"), { target: { value: "" } });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Skriv et helt tal fra 0 til 100 i hvert felt.",
    );
    fireEvent.change(share("Mac'en, hvisket"), { target: { value: "10" } });
    const moved = await screen.findByText("Det flytter 104 sætninger:");
    const pairs = within(moved.closest(".mix-moved") as HTMLElement)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(pairs).toEqual([
      "103 fra Telefonen, hvisket til Mac'en, hvisket",
      "1 fra Mac'en, almindelig stemme til Mac'en, hvisket",
    ]);
    expect(fake!.posts("/api/mix/preview").at(-1)!.body).toEqual({
      mix: {
        "phone-whisper": 30,
        "phone-normal": 40,
        "mac-normal": 20,
        "mac-whisper": 10,
      },
    });
    expect(row("Mac'en, hvisket")).toHaveTextContent("104");
    // Nothing is dealt until he says so.
    expect(fake!.posts("/api/mix/deal")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Del ud igen" }));
    expect(
      await screen.findByText("Sætningerne er delt ud igen. 104 flyttede."),
    ).toBeInTheDocument();
    expect(fake!.posts("/api/mix/deal")[0].body).toEqual(
      fake!.posts("/api/mix/preview").at(-1)!.body,
    );
    expect(dealt).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Del ud igen" }),
      ).toBeDisabled(),
    );
    expect(share("Mac'en, hvisket")).toHaveValue(10);
  });

  it("waits while a recording is picked", async () => {
    fake = fakeFetch();
    render(<MixPanel reloadKey={null} onDealt={() => {}} />);
    expect(
      await screen.findByText(
        "Stop optagelsen først. Så kan sætningerne deles ud igen.",
      ),
    ).toBeInTheDocument();
    fireEvent.change(share("Telefonen, hvisket"), { target: { value: "30" } });
    fireEvent.change(share("Mac'en, hvisket"), { target: { value: "10" } });
    await screen.findByText(/Det flytter/);
    expect(screen.getByRole("button", { name: "Del ud igen" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Fortryd" }));
    expect(share("Telefonen, hvisket")).toHaveValue(40);
    expect(within(row("Mac'en, hvisket")).getByRole("spinbutton")).toHaveValue(
      0,
    );
  });

  it("reads whole percents only", () => {
    expect(sharesOf({ a: "40", b: "60" })).toEqual({ a: 40, b: 60 });
    expect(sharesOf({ a: "40.5", b: "59.5" })).toBeNull();
    expect(sharesOf({ a: "", b: "100" })).toBeNull();
    expect(sharesOf({ a: "101", b: "0" })).toBeNull();
    expect(sharesOf({ a: "-1", b: "101" })).toBeNull();
    expect(total({ a: 40, b: 50 })).toBe(90);
  });

  it("writes a recording time in hours and minutes", () => {
    expect(duration(0)).toBe("0 min");
    expect(duration(0.4)).toBe("under 1 min");
    expect(duration(52.7)).toBe("53 min");
    expect(duration(72.2)).toBe("1 t 12 min");
    expect(duration(120)).toBe("2 t");
    expect(duration(null)).toBe("ingen");
  });
});
