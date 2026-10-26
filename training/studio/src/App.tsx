/* The layout: a quiet navigation on the left (the W, "Værkstedet", the six screens, and a small
   status at the bottom), the screen on the right. */
import { Logo } from "@walkietalkey/ui";
import { useEffect, useRef, type ReactNode } from "react";
import { usePoll } from "./api/hooks";
import type { Overview } from "./api/types";
import {
  IconData,
  IconEval,
  IconJournal,
  IconMic,
  IconTrain,
  IconVersions,
} from "./components/icons";
import { href, Link, SCREENS, useRoute, type NavScreen } from "./router";
import { DataScreen } from "./screens/Data";
import { EvaluationScreen } from "./screens/Evaluation";
import { JournalScreen } from "./screens/Journal";
import { RecordingScreen } from "./screens/Recording";
import { ReportScreen } from "./screens/Report";
import { TrainingScreen } from "./screens/Training";
import { VersionsScreen } from "./screens/Versions";
import { S } from "./strings";

const ICONS: Record<NavScreen, () => ReactNode> = {
  optag: IconMic,
  data: IconData,
  traening: IconTrain,
  evaluering: IconEval,
  versioner: IconVersions,
  journal: IconJournal,
};

function NavStatus() {
  const o = usePoll<Overview>("/api/overview", 4000);
  const v = o.data;
  if (!v)
    return (
      <div className="nav-status">
        {o.error && (
          <p className="nav-status-line bad">
            <span className="dot" aria-hidden="true" />
            {S.status.offline}
          </p>
        )}
      </div>
    );
  const jobs = v.jobs.filter((j) => j.status === "running");
  return (
    <div className="nav-status" aria-label={S.status.label} role="region">
      <p className={`nav-status-line ${v.app.found ? "ok" : "bad"}`}>
        <span className="dot" aria-hidden="true" />
        {v.app.found
          ? v.app.version
            ? S.status.appFound(v.app.version)
            : S.status.appFoundNoVersion
          : S.status.appMissing}
      </p>
      {v.app.found && v.app.batch === false && (
        <p className="nav-status-line muted">{S.status.noBatch}</p>
      )}
      {v.recording.label && (
        <p className={`nav-status-line ${v.recording.active ? "rec" : ""}`}>
          <span className="dot" aria-hidden="true" />
          <Link href="/optag">
            {v.recording.active
              ? S.status.recording(v.recording.label)
              : S.status.paused(v.recording.label)}
          </Link>
        </p>
      )}
      {jobs.map((j) => (
        <p key={j.id} className="nav-status-line running">
          <span className="dot" aria-hidden="true" />
          <Link
            href={
              j.kind === "train"
                ? "/traening"
                : j.kind === "export"
                  ? "/versioner"
                  : j.kind === "pilot"
                    ? "/optag"
                    : "/evaluering"
            }
          >
            {j.title}
          </Link>
        </p>
      ))}
      {!v.recording.label && jobs.length === 0 && (
        <p className="nav-status-line muted">{S.status.nothingRuns}</p>
      )}
    </div>
  );
}

function Nav({ active }: { active: string }) {
  return (
    <nav className="nav" aria-label={S.nav.label}>
      <Link className="brand" href="/optag">
        <Logo variant="mark" size={26} decorative />
        <span className="brand-text">
          <span className="brand-name">{S.app.name}</span>
          <span className="brand-sub">{S.app.sub}</span>
        </span>
      </Link>
      <ul className="nav-list">
        {SCREENS.map((s) => {
          const Icon = ICONS[s];
          const on = active === s;
          return (
            <li key={s}>
              <Link
                className={`nav-item ${on ? "on" : ""}`}
                href={href(s)}
                aria-current={on ? "page" : undefined}
              >
                <Icon />
                {S.nav[s]}
              </Link>
            </li>
          );
        })}
      </ul>
      <NavStatus />
    </nav>
  );
}

function NotFound() {
  return (
    <div className="not-found">
      <h1>{S.notFound.title}</h1>
      <p className="lead">{S.notFound.body}</p>
      <Link className="btn btn--secondary" href="/optag">
        {S.notFound.home}
      </Link>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const mainRef = useRef<HTMLElement>(null);
  const navActive =
    route.screen === "rapport"
      ? (route.query.get("fra") ?? "/evaluering")
          .replace(/^\//, "")
          .split(/[/?]/)[0]
      : route.screen;

  // A new screen starts at the top, with focus on it for keyboard and screen reader users.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [route.screen, route.param]);

  useEffect(() => {
    const titles: Record<string, string> = {
      ...S.nav,
      rapport: S.report.title,
      ukendt: S.notFound.title,
    };
    document.title = `${titles[route.screen] ?? ""} · ${S.app.name}`;
  }, [route.screen]);

  let screen: ReactNode;
  switch (route.screen) {
    case "optag":
      screen = <RecordingScreen />;
      break;
    case "data":
      screen = <DataScreen />;
      break;
    case "traening":
      screen = <TrainingScreen />;
      break;
    case "evaluering":
      screen = <EvaluationScreen />;
      break;
    case "versioner":
      screen = <VersionsScreen />;
      break;
    case "journal":
      screen = <JournalScreen key={route.param ?? ""} name={route.param} />;
      break;
    case "rapport":
      screen = <ReportScreen route={route} />;
      break;
    default:
      screen = <NotFound />;
  }

  return (
    <div className="layout">
      <a className="skip" href="#main">
        {S.app.skip}
      </a>
      <Nav active={navActive} />
      <main
        id="main"
        className={`main main--${route.screen}`}
        ref={mainRef}
        tabIndex={-1}
      >
        <div className="content">{screen}</div>
      </main>
    </div>
  );
}
