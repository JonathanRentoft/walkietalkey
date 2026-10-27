/* Run 11: on a first start every screen and panel that has nothing to show yet says what will
   appear there, and after which step. */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataScreen } from "../src/screens/Data";
import { JournalScreen } from "../src/screens/Journal";
import { RecordingScreen } from "../src/screens/Recording";
import { VersionsScreen } from "../src/screens/Versions";
import { fakeFetch } from "./fake-fetch";

let fake: ReturnType<typeof fakeFetch> | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

describe("the empty states", () => {
  it("Data: the sentences and their split come after the first recording", async () => {
    fake = fakeFetch({ empty: true });
    render(<DataScreen />);
    expect(
      await screen.findByText(
        "Her kommer dine optagelser: minutterne pr. forhold og deres opdeling i træning, validering og test.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("De kommer efter den første optagelse på Optagelse."),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link", { name: "Til Optagelse" })[0],
    ).toHaveAttribute("href", "/optag");
    expect(
      screen.getByText("Lækagetjekket kører, når der er optagelser at tjekke."),
    ).toBeInTheDocument();
    // No empty split chart under it.
    expect(document.querySelector(".bars--stacked")).toBeNull();
  });

  it("Versioner: the versions come after an export, the exports after a training", async () => {
    fake = fakeFetch({ empty: true });
    render(<VersionsScreen />);
    expect(
      await screen.findByText(
        "Her kommer dine finjusterede versioner af Edda.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Den første kommer, når du har eksporteret en færdig træning nedenfor.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "De kommer, når en træning på Træning er færdig og har gemt en adapter.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Til Træning" })).toHaveAttribute(
      "href",
      "/traening",
    );
  });

  it("Journal: pages and runs come after a training or an evaluation", async () => {
    fake = fakeFetch({ empty: true });
    render(<JournalScreen name={null} />);
    expect(
      await screen.findByText(
        "Her kommer en side pr. kørsel med tallene og dine noter.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Den første kan du skrive, når du har trænet eller evalueret en model.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Her kommer dine kørsler fra MLflow."),
    ).toBeInTheDocument();
    // Not "every run has a page" when there are no runs at all.
    expect(screen.queryByText("Alle kørsler har en side.")).toBeNull();
  });

  it("Optagelse: the pilot's comparison and the progress say what comes", async () => {
    fake = fakeFetch({ empty: true });
    render(<RecordingScreen />);
    expect(
      await screen.findByText(
        "Her kommer sammenligningen af opsætningerne: ordfejl, tale over støj, niveau og forvrængning.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/optaget piloten i mindst én opsætning/),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Bjælkerne fyldes op, efterhånden som dine optagelser bliver godkendt/,
      ),
    ).toBeInTheDocument();
  });
});
