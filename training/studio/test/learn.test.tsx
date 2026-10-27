/* Lær det (run 11): the notebooks in order, each opened in VS Code as the owner's own copy, and
   "Start forfra" only after a confirm. */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LearnScreen, numberOf } from "../src/screens/Learn";
import { fakeFetch } from "./fake-fetch";

let fake: ReturnType<typeof fakeFetch> | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

const card = (title: RegExp) =>
  screen.getByRole("heading", { name: title }).closest("li") as HTMLElement;

describe("Lær det", () => {
  it("lists the notebooks in order with their number, title, summary and minutes", async () => {
    fake = fakeFetch();
    render(<LearnScreen />);
    const list = await screen.findByRole("list", { name: "Notesbøgerne" });
    const titles = within(list)
      .getAllByRole("heading")
      .map((h) => h.textContent);
    expect(titles).toEqual([
      "01 Lyden",
      "02 Edda indefra",
      "03 Måling",
      "04 LoRA",
      "05 Fejlanalyse",
    ]);
    const first = card(/Lyden/);
    expect(first).toHaveTextContent("Hør og se en optagelse, som Edda får den");
    expect(first).toHaveTextContent("ca. 4 min");
    // A copy that has been run, one that has not, and one never opened.
    expect(first).toHaveTextContent("Kørt");
    expect(first).toHaveTextContent("Din kopi, gemt");
    expect(card(/Edda indefra/)).toHaveTextContent("Ikke kørt endnu");
    expect(card(/Måling/)).toHaveTextContent("Ikke åbnet endnu");
    expect(
      within(card(/Måling/)).queryByRole("button", { name: /forfra/ }),
    ).toBeNull();
    expect(
      screen.getByText(/Hver notesbog åbner som din egen kopi i/),
    ).toBeInTheDocument();
  });

  it("opens a notebook in VS Code through the server, as a page POST", async () => {
    fake = fakeFetch();
    render(<LearnScreen />);
    await screen.findByRole("list", { name: "Notesbøgerne" });
    fireEvent.click(
      within(card(/Måling/)).getByRole("button", {
        name: "Åbn Måling i VS Code",
      }),
    );
    await screen.findByText("Åbnet i VS Code som din egen kopi.");
    const post = fake!.posts("/api/learn/open")[0];
    expect(post.body).toEqual({ name: "03-maaling" });
    expect(post.headers["x-wt-studio"]).toBe("1");
    await waitFor(() =>
      expect(card(/Måling/)).toHaveTextContent("Ikke kørt endnu"),
    );
  });

  it("starts over only after a confirm", async () => {
    fake = fakeFetch();
    render(<LearnScreen />);
    await screen.findByRole("list", { name: "Notesbøgerne" });
    const lyden = card(/Lyden/);
    fireEvent.click(
      within(lyden).getByRole("button", { name: "Start Lyden forfra" }),
    );
    expect(within(lyden).getByRole("group")).toHaveTextContent(
      "Din kopi med dine ændringer og resultater lægges til side",
    );
    fireEvent.click(
      within(lyden).getByRole("button", { name: "Behold min kopi" }),
    );
    expect(fake!.posts("/api/learn/reset")).toHaveLength(0);
    fireEvent.click(
      within(lyden).getByRole("button", { name: "Start Lyden forfra" }),
    );
    fireEvent.click(
      within(lyden).getByRole("button", { name: "Ja, start forfra" }),
    );
    await screen.findByText("Startet forfra med den originale notesbog.");
    expect(fake!.posts("/api/learn/reset")[0].body).toEqual({
      name: "01-lyden",
    });
    await waitFor(() =>
      expect(card(/Lyden/)).toHaveTextContent("Ikke kørt endnu"),
    );
  });

  it("says so in Danish when VS Code cannot be found", async () => {
    fake = fakeFetch({ vscode: false });
    render(<LearnScreen />);
    await screen.findByRole("list", { name: "Notesbøgerne" });
    fireEvent.click(
      within(card(/LoRA/)).getByRole("button", { name: "Åbn LoRA i VS Code" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "VS Code er ikke fundet på Mac'en. Installér VS Code, og prøv igen.",
    );
  });

  it("says what will come, and when, before there are any notebooks", async () => {
    fake = fakeFetch({ empty: true });
    render(<LearnScreen />);
    expect(
      await screen.findByText(
        "Her kommer notesbøgerne, der viser dig, hvordan Edda virker.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("De kommer, når de ligger i training/notebooks."),
    ).toBeInTheDocument();
  });

  it("numbers a notebook as its heading does", () => {
    const n = {
      name: "x",
      title: "x",
      summary: null,
      minutes: null,
      copy: false,
      ran: false,
      saved: null,
    };
    expect(numberOf({ ...n, number: 4 })).toBe("04");
    expect(numberOf({ ...n, number: null })).toBe("");
  });
});
