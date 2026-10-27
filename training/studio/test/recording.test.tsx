import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Row } from "../src/api/types";
import type { RecordingState } from "../src/api/types";
import { RecordingScreen } from "../src/screens/Recording";
import { CurrentSentence } from "../src/screens/recording/Session";
import { reconcileRows } from "../src/screens/recording/useRecording";
import { fakeFetch, type Call } from "./fake-fetch";

let fake: ReturnType<typeof fakeFetch>;
beforeEach(() => {
  fake = fakeFetch();
});
afterEach(() => fake.restore());

const row = (id: string) =>
  document.querySelector<HTMLElement>(`[data-row="${id}"]`)!;

async function ready() {
  render(<RecordingScreen />);
  await waitFor(() => expect(row("s0001")).not.toBeNull());
}

function expectPost(call: Call | undefined, path: string, body: unknown) {
  expect(call).toBeDefined();
  expect(call!.url).toBe(path);
  expect(call!.method).toBe("POST");
  expect(call!.headers["x-wt-studio"]).toBe("1");
  expect(call!.headers["content-type"]).toBe("application/json");
  expect(call!.body).toEqual(body);
}

describe("the recording screen's rows", () => {
  it("shows every status as a badge, with the current row marked", async () => {
    await ready();
    expect(within(row("s0001")).getByText("Godkendt")).toBeInTheDocument();
    expect(
      within(row("s0016")).getByText("Tag om", { selector: ".badge" }),
    ).toBeInTheDocument();
    expect(within(row("s0018")).getByText("Modtaget")).toBeInTheDocument();
    expect(within(row("s0019")).getByText("Optager")).toBeInTheDocument();
    expect(within(row("s0020")).getByText("Venter")).toBeInTheDocument();
    expect(row("s0019")).toHaveAttribute("aria-current", "step");
    expect(row("s0020")).not.toHaveAttribute("aria-current");
    expect(within(row("s0021")).getByText("Sprunget over")).toBeInTheDocument();
  });

  it("shows a received take's meter, checks and what Edda heard", async () => {
    await ready();
    // s0016: sent back for being quiet and for Edda hearing something else.
    const r16 = row("s0016");
    expect(
      within(r16).getByRole("img", { name: /Lydniveau .*for svag/ }),
    ).toBeInTheDocument();
    expect(within(r16).getByText("For svag").closest(".chip")).toHaveClass(
      "chip--back",
    );
    expect(within(r16).getByText("Edda hørte noget andet")).toBeInTheDocument();
    expect(r16.querySelector(".w-sub")).not.toBeNull();
    expect(r16.querySelector(".w-del")).not.toBeNull();
    // s0003: a warning only.
    expect(
      within(row("s0003")).getByText("Kraftig").closest(".chip"),
    ).toHaveClass("chip--warn");
    // s0018: Edda is listening; s0012: Edda could not listen.
    expect(within(row("s0018")).getByText("Edda lytter")).toBeInTheDocument();
    expect(
      within(row("s0012")).getByText(/Edda lyttede ikke med/),
    ).toBeInTheDocument();
    // A waiting row has no take.
    expect(
      within(row("s0020")).queryByRole("button", { name: /Afspil/ }),
    ).toBeNull();
    expect(
      within(row("s0001")).getByRole("button", {
        name: "Afspil optagelsen af s0001",
      }),
    ).toBeInTheDocument();
  });

  it("offers 'Godkend alligevel' only for a take the check sent back", async () => {
    await ready();
    expect(
      within(row("s0016")).getByRole("button", { name: /Godkend alligevel/ }),
    ).toBeInTheDocument();
    expect(
      within(row("s0017")).queryByRole("button", { name: /Godkend alligevel/ }),
    ).toBeNull();
    expect(
      within(row("s0001")).queryByRole("button", { name: /Godkend alligevel/ }),
    ).toBeNull();
    expect(
      within(row("s0017")).getByText("Du bad om en ny optagelse"),
    ).toBeInTheDocument();
  });

  it("'Tag om' posts the sentence and the row turns to Tag om", async () => {
    await ready();
    // Not while a take records (the phone is recording s0019).
    expect(
      within(row("s0001")).getByRole("button", { name: "Tag om" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(
        within(row("s0001")).getByRole("button", { name: "Tag om" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      within(row("s0001")).getByRole("button", { name: "Tag om" }),
    );
    await waitFor(() =>
      expect(fake.posts("/api/recording/redo")).toHaveLength(1),
    );
    expectPost(fake.posts("/api/recording/redo")[0], "/api/recording/redo", {
      id: "s0001",
    });
    await waitFor(() =>
      expect(
        within(row("s0001")).getByText("Tag om", { selector: ".badge" }),
      ).toBeInTheDocument(),
    );
    expect(row("s0001")).toHaveAttribute("aria-current", "step");
  });

  it("'Godkend alligevel' posts the sentence and the row is approved", async () => {
    await ready();
    fireEvent.click(
      within(row("s0016")).getByRole("button", { name: /Godkend alligevel/ }),
    );
    await waitFor(() =>
      expect(fake.posts("/api/recording/approve")).toHaveLength(1),
    );
    expectPost(
      fake.posts("/api/recording/approve")[0],
      "/api/recording/approve",
      { id: "s0016" },
    );
    await waitFor(() =>
      expect(within(row("s0016")).getByText("Godkendt")).toBeInTheDocument(),
    );
    expect(
      within(row("s0016")).getByText("Godkendt af dig"),
    ).toBeInTheDocument();
  });

  it("names the link in plain Danish, pauses and resumes", async () => {
    await ready();
    expect(
      screen.getByText("Forbundet. Sætningerne vises på Jonathans iPhone"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Spring over/ })).toBeDisabled(); // a take is recording
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Fortsæt" }),
      ).toBeInTheDocument(),
    );
    expectPost(
      fake.posts("/api/recording/pause")[0],
      "/api/recording/pause",
      {},
    );
    expect(
      screen.getByText(/På pause\. Telefonen er tilbage/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fortsæt" }));
    await waitFor(() =>
      expect(fake.posts("/api/recording/resume")).toHaveLength(1),
    );
  });

  it("makes a waiting sentence the current one, and skips", async () => {
    await ready();
    // While a take records nothing else can become current.
    expect(
      within(row("s0030")).queryByRole("button", { name: /Gør s0030/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Fortsæt" }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Fortsæt" }));
    await waitFor(() =>
      expect(
        within(row("s0030")).getByRole("button", {
          name: "Gør s0030 til den næste sætning",
        }),
      ).toBeInTheDocument(),
    );
    fireEvent.click(
      within(row("s0030")).getByRole("button", {
        name: "Gør s0030 til den næste sætning",
      }),
    );
    await waitFor(() =>
      expect(row("s0030")).toHaveAttribute("aria-current", "step"),
    );
    expectPost(fake.posts("/api/recording/go")[0], "/api/recording/go", {
      id: "s0030",
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Spring over/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Spring over/ }));
    await waitFor(() =>
      expect(fake.posts("/api/recording/skip")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(
        within(row("s0030")).getByText("Sprunget over"),
      ).toBeInTheDocument(),
    );
  });

  it("filters the list", async () => {
    await ready();
    fireEvent.click(screen.getByRole("radio", { name: "Tag om (2)" }));
    expect(document.querySelectorAll(".row")).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: "Alle (120)" }));
    expect(document.querySelectorAll(".row")).toHaveLength(120);
  });
});

describe("a Mac session", () => {
  async function startMac() {
    await ready();
    fireEvent.click(
      screen.getByRole("button", { name: "Vælg en anden optagelse" }),
    );
    fireEvent.click(
      await screen.findByRole("radio", { name: /Mac'en, almindelig stemme/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start optagelsen" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Optag$/ }),
      ).toBeInTheDocument(),
    );
    expectPost(fake.posts("/api/recording/start")[0], "/api/recording/start", {
      kind: "condition",
      id: "mac-normal",
      exam: false,
    });
  }

  it("records with the space bar: press to start, press again to stop", async () => {
    await startMac();
    act(() => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
    await waitFor(() =>
      expect(fake.posts("/api/recording/mac/start")).toHaveLength(1),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Stop optagelsen/ }),
      ).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.keyDown(window, { key: " ", code: "Space" });
    });
    await waitFor(() =>
      expect(fake.posts("/api/recording/mac/stop")).toHaveLength(1),
    );
    expectPost(
      fake.posts("/api/recording/mac/stop")[0],
      "/api/recording/mac/stop",
      {},
    );
  });

  it("cancels with Escape, and ignores the space bar while typing", async () => {
    await startMac();
    fireEvent.click(screen.getByRole("button", { name: /^Optag$/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Stop optagelsen/ }),
      ).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    });
    await waitFor(() =>
      expect(fake.posts("/api/recording/mac/cancel")).toHaveLength(1),
    );
    const input = document.createElement("textarea");
    document.body.appendChild(input);
    const before = fake.posts().length;
    fireEvent.keyDown(input, { key: " ", code: "Space" });
    expect(fake.posts().length).toBe(before);
    input.remove();
  });
});

describe("a refused take", () => {
  it("shows in the current sentence, since its row does not change", async () => {
    const got = await fake.studio.handle(
      "GET",
      "/api/recording/state",
      {},
      null,
    );
    const state = got.json as RecordingState;
    const refused: RecordingState = {
      ...state,
      recording: null,
      current: "s0020",
      last: {
        prompt: "s0020",
        text: "x",
        check: "silent",
        saved: false,
        problems: ["silent"],
        seconds: 2,
        replaced: false,
      },
    };
    const act = async () => null;
    const { rerender } = render(
      <CurrentSentence state={refused} act={act} busy={null} />,
    );
    expect(
      screen.getByText("Hørte ikke noget. Optag den igen."),
    ).toBeInTheDocument();
    // Once the queue has moved on, it is not shown.
    rerender(
      <CurrentSentence
        state={{ ...refused, current: "s0022" }}
        act={act}
        busy={null}
      />,
    );
    expect(screen.queryByText("Hørte ikke noget. Optag den igen.")).toBeNull();
  });
});

describe("reconcileRows", () => {
  const a: Row = {
    id: "s1",
    text: "a",
    kind: "plain",
    status: "waiting",
    skipped: false,
    take: null,
  };
  const b: Row = {
    id: "s2",
    text: "b",
    kind: "plain",
    status: "waiting",
    skipped: false,
    take: null,
  };

  it("keeps unchanged rows (and the list) so memoised rows do not re-render", () => {
    const prev = [a, b];
    const same = reconcileRows(prev, [{ ...a }, { ...b }]);
    expect(same).toBe(prev);
    const changed = reconcileRows(prev, [
      { ...a },
      { ...b, status: "recording" },
    ]);
    expect(changed).not.toBe(prev);
    expect(changed[0]).toBe(a);
    expect(changed[1]).not.toBe(b);
    expect(changed[1].status).toBe("recording");
  });
});
