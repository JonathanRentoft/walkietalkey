import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigate } from "../src/router";
import {
  JournalScreen,
  journalUrl,
  PageView,
  withoutNotes,
} from "../src/screens/Journal";
import { fakeFetch } from "./fake-fetch";

let fake: ReturnType<typeof fakeFetch>;
beforeEach(() => {
  fake = fakeFetch();
});
afterEach(() => {
  fake.restore();
  vi.restoreAllMocks();
});

const NAME = "2026-10-26-first-frozen-encoder-20261026-2112";

describe("the journal's Markdown", () => {
  it("leaves out the two note sections, which are edited in the text fields", () => {
    const md =
      "# T\n\nIntro\n\n## Hypothesis\n\nmy guess\n\n## Numbers\n\n| a |\n|---|\n\n## What I learned\n\nlesson\n";
    const out = withoutNotes(md);
    expect(out).toContain("# T");
    expect(out).toContain("## Numbers");
    expect(out).not.toContain("my guess");
    expect(out).not.toContain("lesson");
    expect(out).not.toContain("## Hypothesis");
  });

  it("resolves relative images as wt-train card writes them (beside the page's file)", () => {
    expect(journalUrl("p/plot-loss.svg", "/files/journal/p/")).toBe(
      "/files/journal/p/plot-loss.svg",
    );
    expect(journalUrl("./p/plot.svg", "/files/journal/p/")).toBe(
      "/files/journal/p/plot.svg",
    );
    expect(journalUrl("/files/x.png", "/files/journal/p/")).toBe(
      "/files/x.png",
    );
    expect(
      journalUrl("javascript:alert(1)", "/files/journal/p/"),
    ).not.toContain("javascript:");
  });

  it("renders headings, tables, lists and images, never raw HTML", async () => {
    fake.studio.handle(
      "POST",
      `/api/journal/${NAME}`,
      { "x-wt-studio": "1" },
      { hypothesis: "<b>fed</b>", learned: "" },
    );
    const { container } = render(<PageView name={NAME} />);
    await screen.findByRole("heading", {
      name: "Første træning med frossen encoder",
    });
    expect(container.querySelector(".markdown table")).not.toBeNull();
    expect(container.querySelector(".markdown ul li")).not.toBeNull();
    expect(container.querySelector(".markdown img")).toHaveAttribute(
      "src",
      `/files/journal/${NAME}/plot-loss.svg`,
    );
    expect(container.querySelector(".markdown b")).toBeNull();
  });
});

describe("a journal page's notes", () => {
  it("saves both fields into the Markdown file and says Gemt", async () => {
    render(<PageView name={NAME} />);
    const hyp = await screen.findByRole("textbox", { name: /Hypotese/ });
    const learned = screen.getByRole("textbox", { name: /Hvad jeg lærte/ });
    expect(hyp).toHaveValue(
      "Hvis kun decoderen trænes, lærer Edda de engelske fagord uden at blive dårligere til almindelig dansk.",
    );
    const save = screen.getByRole("button", { name: "Gem" });
    expect(save).toBeDisabled(); // nothing changed yet
    fireEvent.change(learned, {
      target: { value: "Fagordene kom, FLEURS holdt." },
    });
    expect(screen.getByText("Ikke gemt")).toBeInTheDocument();
    fireEvent.click(save);
    await screen.findByText("Gemt");
    const post = fake.posts(`/api/journal/${NAME}`)[0];
    expect(post.headers["x-wt-studio"]).toBe("1");
    expect(post.body).toEqual({
      hypothesis:
        "Hvis kun decoderen trænes, lærer Edda de engelske fagord uden at blive dårligere til almindelig dansk.",
      learned: "Fagordene kom, FLEURS holdt.",
    });
    expect(screen.getByRole("button", { name: "Gem" })).toBeDisabled();
  });

  it("asks before leaving with unsaved text", async () => {
    render(<PageView name={NAME} />);
    const learned = await screen.findByRole("textbox", {
      name: /Hvad jeg lærte/,
    });
    fireEvent.change(learned, { target: { value: "noget" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    let moved = true;
    act(() => {
      moved = navigate("/data");
    });
    expect(confirm).toHaveBeenCalledWith(
      "Du har tekst, der ikke er gemt. Vil du forlade siden alligevel?",
    );
    expect(moved).toBe(false);
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("writes a page for a run without one", async () => {
    render(<JournalScreen name={null} />);
    const write = await screen.findAllByRole("button", { name: "Skriv side" });
    fireEvent.click(write[0]);
    await waitFor(() => expect(fake.posts("/api/journal")).toHaveLength(1));
    expect(fake.posts("/api/journal")[0].body).toEqual({
      run: "lora-test-split-2026-10-27",
    });
    await waitFor(() =>
      expect(window.location.pathname).toMatch(/^\/journal\/.+lora-test-split/),
    );
  });
});
