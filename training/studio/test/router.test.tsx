import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addLeaveGuard,
  href,
  isReportUrl,
  Link,
  navigate,
  parseRoute,
  reportHref,
  SCREENS,
  useRoute,
} from "../src/router";

describe("parseRoute", () => {
  it("knows the seven screens, with / as the recording screen", () => {
    expect(parseRoute("/").screen).toBe("optag");
    const seven = [
      "optag",
      "data",
      "traening",
      "evaluering",
      "versioner",
      "journal",
      "laer",
    ];
    for (const s of seven) expect(parseRoute(`/${s}`).screen).toBe(s);
    // Run 11: Lær det comes after the journal in the navigation.
    expect([...SCREENS]).toEqual(seven);
    expect(parseRoute("/data/").screen).toBe("data");
  });

  it("reads a journal page's name, decoded", () => {
    const r = parseRoute("/journal/2026-10-27%20f%C3%B8rste");
    expect(r.screen).toBe("journal");
    expect(r.param).toBe("2026-10-27 første");
    expect(parseRoute("/journal").param).toBeNull();
  });

  it("reads the report's query", () => {
    const r = parseRoute(
      "/rapport",
      "?url=%2Freports%2Fa.html&fra=%2Fevaluering",
    );
    expect(r.screen).toBe("rapport");
    expect(r.query.get("url")).toBe("/reports/a.html");
    expect(r.query.get("fra")).toBe("/evaluering");
  });

  it("calls everything else unknown", () => {
    expect(parseRoute("/nope").screen).toBe("ukendt");
    expect(parseRoute("/data/extra").screen).toBe("ukendt");
    expect(parseRoute("/journal/%E0%A4%A").screen).toBe("ukendt");
  });
});

describe("links", () => {
  it("builds paths that parse back", () => {
    expect(href("traening")).toBe("/traening");
    const j = href("journal", "a b/c");
    expect(parseRoute(j).param).toBe("a b/c");
    const r = reportHref("/reports/x.html", "/optag");
    const [p, q] = r.split("?");
    expect(parseRoute(p, `?${q}`).query.get("url")).toBe("/reports/x.html");
  });

  it("frames only the studio's own reports", () => {
    expect(isReportUrl("/reports/pilot-20261027-110000.html")).toBe(true);
    expect(isReportUrl("https://example.com/reports/a.html")).toBe(false);
    expect(isReportUrl("/reports/../api/x.html")).toBe(false);
    expect(isReportUrl("/api/overview")).toBe(false);
    expect(isReportUrl("//evil/reports/a.html")).toBe(false);
    expect(isReportUrl(null)).toBe(false);
  });
});

function Where() {
  const r = useRoute();
  return (
    <div>
      <span data-testid="screen">{r.screen}</span>
      <Link href="/data">til data</Link>
    </div>
  );
}

describe("navigation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("pushes the History API and re-renders, without reloading", () => {
    render(<Where />);
    expect(screen.getByTestId("screen")).toHaveTextContent("optag");
    fireEvent.click(screen.getByText("til data"));
    expect(window.location.pathname).toBe("/data");
    expect(screen.getByTestId("screen")).toHaveTextContent("data");
    act(() => {
      navigate("/journal");
    });
    expect(screen.getByTestId("screen")).toHaveTextContent("journal");
  });

  it("asks before leaving unsaved text, and stays when told to", () => {
    render(<Where />);
    const remove = addLeaveGuard(() => "Ikke gemt");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    let moved = true;
    act(() => {
      moved = navigate("/versioner");
    });
    expect(moved).toBe(false);
    expect(confirm).toHaveBeenCalledWith("Ikke gemt");
    expect(screen.getByTestId("screen")).toHaveTextContent("optag");
    confirm.mockReturnValue(true);
    act(() => {
      moved = navigate("/versioner");
    });
    expect(moved).toBe(true);
    expect(screen.getByTestId("screen")).toHaveTextContent("versioner");
    remove();
  });

  it("lets a modified click open a new tab", () => {
    // jsdom cannot open a tab: stop the browser's own navigation after the router has looked.
    const stop = (e: Event) => e.preventDefault();
    document.addEventListener("click", stop);
    render(<Where />);
    fireEvent.click(screen.getByText("til data"), { metaKey: true });
    expect(window.location.pathname).toBe("/");
    document.removeEventListener("click", stop);
  });
});
