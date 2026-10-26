/* A report page (evaluation, --vs, pilot) inside Værkstedet: a sandboxed iframe that fills the
   content area, with a link back to where it was opened. Only /reports/... pages are framed. */
import { IconArrowLeft } from "../components/icons";
import { Notice } from "../components/ui";
import { isReportUrl, Link, parseRoute, type Route } from "../router";
import { S } from "../strings";

const BACK: Record<string, string> = {
  optag: S.nav.optag,
  data: S.nav.data,
  traening: S.nav.traening,
  evaluering: S.nav.evaluering,
  versioner: S.nav.versioner,
  journal: S.nav.journal,
};

export function ReportScreen({ route }: { route: Route }) {
  const url = route.query.get("url");
  const from = route.query.get("fra") ?? "/evaluering";
  const fromRoute = parseRoute(from.split("?")[0]);
  const back = fromRoute.screen in BACK ? from : "/evaluering";
  const backName = BACK[fromRoute.screen] ?? S.nav.evaluering;
  return (
    <div className="report">
      <div className="report-bar">
        <Link className="back" href={back}>
          <IconArrowLeft />
          {S.report.backTo(backName)}
        </Link>
        {isReportUrl(url) && (
          <span className="report-file mono-ish">
            {url.replace("/reports/", "")}
          </span>
        )}
      </div>
      {isReportUrl(url) ? (
        <iframe
          className="report-frame"
          src={url}
          title={S.report.frame}
          sandbox="allow-scripts"
        />
      ) : (
        <Notice kind="warn">{S.report.bad}</Notice>
      )}
    </div>
  );
}
