/* Dine egne ord (run 12): the English words of his own dictations by how often he said them,
   ticked into his own list, with sentences of his own; never a word in a URL, never a sentence
   from the history on the page. */
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OWN_WORDS } from "../src/api/fixtures";
import { OwnWordsScreen, said } from "../src/screens/OwnWords";
import { fakeFetch } from "./fake-fetch";

let fake: ReturnType<typeof fakeFetch> | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

const newList = () =>
  screen.findByRole("list", { name: "Nye ord at sætte flueben ved" });
const mine = () => screen.getByRole("list", { name: "Ord med flueben" });

describe("Dine egne ord", () => {
  it("lists the new words, most often said first, with how often and where", async () => {
    fake = fakeFetch();
    render(<OwnWordsScreen />);
    const list = await newList();
    const items = within(list).getAllByRole("listitem");
    expect(
      items.map(
        (li) => li.querySelector(".word-name")?.childNodes[0]?.textContent,
      ),
    ).toEqual(OWN_WORDS.map((w) => w.word));
    expect(items[0]).toHaveTextContent(
      "14 gange · i 9 dikteringer · 1,1 % af dikteringerne",
    );
    expect(items[9]).toHaveTextContent("1 gang · i 1 diktering");
    expect(within(items[3]).getByText("Udtryk")).toBeInTheDocument();
    expect(
      screen.getByText(/Ingen af dine sætninger bliver vist eller gemt/),
    ).toBeInTheDocument();
    expect(screen.getByText("Fundet i 812 dikteringer.")).toBeInTheDocument();
    expect(
      screen.getByText(/training\/data\/local\/own-words.yaml/),
    ).toBeInTheDocument();
  });

  it("ticks a word in a POST body, never in the URL, and it moves to Dine ord", async () => {
    fake = fakeFetch();
    render(<OwnWordsScreen />);
    const list = await newList();
    fireEvent.click(within(list).getByRole("checkbox", { name: /Terraform/ }));
    await waitFor(() =>
      expect(
        within(mine()).getByRole("heading", { name: "Terraform" }),
      ).toBeInTheDocument(),
    );
    const post = fake!.posts("/api/ownwords/tick")[0];
    expect(post.body).toEqual({ word: "Terraform", ticked: true });
    expect(post.headers["x-wt-studio"]).toBe("1");
    expect(
      within(await newList()).queryByRole("checkbox", { name: /Terraform/ }),
    ).toBeNull();
    // No word is ever in a URL.
    for (const c of fake!.calls)
      for (const w of [...OWN_WORDS.map((x) => x.word), "Sentry"])
        expect(decodeURIComponent(c.url)).not.toContain(w);

    fireEvent.click(
      screen.getByRole("button", { name: "Fjern fluebenet ved Terraform" }),
    );
    await waitFor(() =>
      expect(
        within(mine()).queryByRole("heading", { name: "Terraform" }),
      ).toBeNull(),
    );
    expect(fake!.posts("/api/ownwords/tick")[1].body).toEqual({
      word: "Terraform",
      ticked: false,
    });
  });

  it("adds a sentence of his own under a ticked word, and says why one is refused", async () => {
    fake = fakeFetch();
    render(<OwnWordsScreen />);
    await newList();
    const sentry = within(mine()).getAllByRole("listitem")[0];
    expect(sentry).toHaveTextContent(
      "Sentry sender en mail, hver gang buildet fejler.",
    );
    expect(sentry).toHaveTextContent("7 gange · i 6 dikteringer");
    const input = within(sentry).getByRole("textbox", {
      name: "En sætning med Sentry",
    });

    fireEvent.change(input, { target: { value: "Sentry er nede." } });
    fireEvent.click(
      within(sentry).getByRole("button", { name: "Tilføj sætningen" }),
    );
    expect(await within(sentry).findByRole("alert")).toHaveTextContent(
      "En sætning skal have 4 til 20 ord.",
    );

    fireEvent.change(input, {
      target: { value: "Vi kigger i Sentry efter frokost." },
    });
    fireEvent.click(
      within(sentry).getByRole("button", { name: "Tilføj sætningen" }),
    );
    expect(
      await within(sentry).findByText("Sætningen er tilføjet."),
    ).toBeInTheDocument();
    expect(fake!.posts("/api/ownwords/sentence")[1].body).toEqual({
      word: "Sentry",
      text: "Vi kigger i Sentry efter frokost.",
    });
    const updated = within(mine()).getAllByRole("listitem")[0];
    expect(updated).toHaveTextContent("own-0002");
    expect(updated).toHaveTextContent("Vi kigger i Sentry efter frokost.");
    expect(input).toHaveValue("");
  });

  it("says where it looked when there is no history", async () => {
    fake = fakeFetch({ empty: true });
    render(<OwnWordsScreen />);
    expect(
      await screen.findByText(
        "Her kommer de engelske ord, du siger, når du dikterer.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "/Users/jonathan/Library/Application Support/WalkieTalkey/history.db",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("says so when the history has no new words", async () => {
    fake = fakeFetch({ ownWords: "no-words" });
    render(<OwnWordsScreen />);
    expect(
      await screen.findByText(
        "Ingen nye engelske ord. Stavelisten kender allerede dem, du siger.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Her kommer de ord, du sætter flueben ved, med dine egne sætninger.",
      ),
    ).toBeInTheDocument();
  });

  it("says so when every word is ticked", async () => {
    fake = fakeFetch({ ownWords: "all-ticked" });
    render(<OwnWordsScreen />);
    expect(
      await screen.findByText(
        "Du har sat flueben ved alle ordene. De står under Dine ord nedenfor.",
      ),
    ).toBeInTheDocument();
    expect(within(mine()).getAllByRole("heading")).toHaveLength(
      OWN_WORDS.length,
    );
  });

  it("asks to try again when the history cannot be read", async () => {
    fake = fakeFetch({ ownWords: "unreadable" });
    render(<OwnWordsScreen />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Historikken kunne ikke læses lige nu.",
    );
    expect(
      screen.getByRole("button", { name: "Prøv igen" }),
    ).toBeInTheDocument();
  });

  it("counts once and in one dictation in the singular", () => {
    expect(said({ count: 1, dictations: 1, share: null })).toBe(
      "1 gang · i 1 diktering",
    );
    expect(said({ count: null, dictations: null, share: null })).toBe(
      "Ikke i historikken lige nu",
    );
  });
});
