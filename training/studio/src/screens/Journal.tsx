/* Journal: the pages (one per run), the runs without one ("Skriv side"), and a page with its
   Markdown rendered (never raw HTML) and two text fields, "Hypotese" and "Hvad jeg lærte", that
   save into the Markdown file. Leaving with unsaved text asks first. */
import { useEffect, useMemo, useRef, useState } from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ApiError, api, paths } from "../api/client";
import { useResource } from "../api/hooks";
import type { Journal, JournalPage } from "../api/types";
import { IconArrowLeft, IconCheck } from "../components/icons";
import {
  Button,
  Card,
  ErrorBox,
  Loading,
  PageHeader,
  Section,
} from "../components/ui";
import { date } from "../lib/format";
import { addLeaveGuard, href, Link, navigate } from "../router";
import { errorText, S } from "../strings";

const J = S.journal;

/** The headings wt-train card writes for the owner's notes (journal.py). */
const NOTE_HEADINGS = ["Hypothesis", "What I learned"];

/** The Markdown without the two note sections, which the page shows as text fields instead. */
export function withoutNotes(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2 && !line.startsWith("###")) skipping = NOTE_HEADINGS.includes(h2[1]);
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/** Relative links and images point at the page's own folder (/files/journal/<name>/). */
export function journalUrl(url: string, files: string): string {
  // Anything with a scheme (react-markdown drops the unsafe ones), an absolute path or an anchor stays.
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) return defaultUrlTransform(url);
  // A relative link is relative to the Markdown file, which lies in the journal folder:
  // wt-train card writes its plots as "<page>/<plot>.png" (journal.py). `files` is
  // /files/journal/<page>/, so the folder is its parent.
  const folder = files.replace(/[^/]+\/?$/, "");
  const base = folder.endsWith("/") ? folder : `${folder}/`;
  return defaultUrlTransform(base + url.replace(/^\.\//, ""));
}

export function JournalScreen({ name }: { name: string | null }) {
  return name ? <PageView name={name} /> : <JournalList />;
}

function JournalList() {
  const res = useResource<Journal>("/api/journal");
  const [writing, setWriting] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const j = res.data;
  const without = (j?.runs ?? []).filter((r) => !r.page);

  async function write(run: string) {
    setWriting(run);
    setError(null);
    try {
      const page = await api.post<JournalPage>("/api/journal", { run });
      navigate(href("journal", page.name));
    } catch (e) {
      setError(e as ApiError);
      res.reload();
    } finally {
      setWriting(null);
    }
  }

  return (
    <>
      <PageHeader title={J.title} intro={J.intro} />
      <ErrorBox error={res.error} onRetry={res.reload} area="journal" />
      {error && (
        <p className="inline-error" role="alert">
          {errorText(error.code, "journal")}
        </p>
      )}
      {!j ? (
        !res.error && <Loading />
      ) : (
        <>
          <Section id="pages" title={J.pages}>
            {j.pages.length === 0 ? (
              <p className="empty">{J.pagesEmpty}</p>
            ) : (
              <ul className="page-list">
                {j.pages.map((p) => (
                  <li key={p.name}>
                    <Link className="page-link" href={href("journal", p.name)}>
                      <span className="page-title">{p.title}</span>
                      <span className="page-meta">
                        {date(p.date)}
                        {p.run && <span className="mono-ish"> · {p.run}</span>}
                      </span>
                      <span className="page-flags">
                        <span
                          className={`flag ${p.notes.hypothesis ? "flag--on" : ""}`}
                        >
                          {p.notes.hypothesis && <IconCheck size={13} />}
                          {p.notes.hypothesis
                            ? J.hasHypothesis
                            : J.noHypothesis}
                        </span>
                        <span
                          className={`flag ${p.notes.learned ? "flag--on" : ""}`}
                        >
                          {p.notes.learned && <IconCheck size={13} />}
                          {p.notes.learned ? J.hasLearned : J.noLearned}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section id="runs" title={J.runs}>
            {without.length === 0 ? (
              <p className="empty">{J.runsEmpty}</p>
            ) : (
              <Card className="table-card">
                <ul className="run-list">
                  {without.map((r) => (
                    <li key={r.run}>
                      <span>
                        <span className="run-name">{r.run}</span>
                        <span className="run-meta">
                          {r.kind === "train" ? J.kindTrain : J.kindEval}
                          {r.date && <> · {date(r.date)}</>}
                        </span>
                      </span>
                      <Button
                        size="sm"
                        onClick={() => write(r.run)}
                        disabled={writing !== null}
                        busy={writing === r.run}
                      >
                        {writing === r.run ? J.writing : J.write}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </Section>
        </>
      )}
    </>
  );
}

export function PageView({ name }: { name: string }) {
  const res = useResource<JournalPage>(paths.journalPage(name));
  const page = res.data;
  const [hypothesis, setHypothesis] = useState("");
  const [learned, setLearned] = useState("");
  const [saved, setSaved] = useState<{
    hypothesis: string;
    learned: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (page && loadedFor.current !== page.name) {
      loadedFor.current = page.name;
      setHypothesis(page.hypothesis);
      setLearned(page.learned);
      setSaved({ hypothesis: page.hypothesis, learned: page.learned });
    }
  }, [page]);

  const dirty =
    !!saved && (hypothesis !== saved.hypothesis || learned !== saved.learned);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const remove = addLeaveGuard(() => (dirtyRef.current ? J.leave : null));
    const unload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => {
      remove();
      window.removeEventListener("beforeunload", unload);
    };
  }, []);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 4000);
    return () => clearTimeout(t);
  }, [justSaved]);
  useEffect(() => {
    if (dirty) setJustSaved(false);
  }, [dirty]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = await api.post<JournalPage>(paths.journalPage(name), {
        hypothesis,
        learned,
      });
      res.set(next);
      setSaved({
        hypothesis: next.hypothesis ?? hypothesis,
        learned: next.learned ?? learned,
      });
      setHypothesis(next.hypothesis ?? hypothesis);
      setLearned(next.learned ?? learned);
      setJustSaved(true);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setSaving(false);
    }
  }

  const md = useMemo(() => (page ? withoutNotes(page.markdown) : ""), [page]);

  return (
    <>
      <div className="report-bar">
        <Link className="back" href="/journal">
          <IconArrowLeft />
          {J.allPages}
        </Link>
      </div>
      <ErrorBox error={res.error} onRetry={res.reload} area="journal" />
      {!page ? (
        !res.error && <Loading />
      ) : (
        <div className="journal-page">
          <Card className="markdown">
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              urlTransform={(url) => journalUrl(url, page.files)}
              components={{
                table: ({ node: _node, ...props }) => (
                  <div className="md-table">
                    <table {...props} />
                  </div>
                ),
                img: ({ node: _node, alt, ...props }) => (
                  <img {...props} alt={alt ?? ""} loading="lazy" />
                ),
              }}
            >
              {md}
            </Markdown>
          </Card>

          <Card className="notes-card">
            <h2>{J.notesTitle}</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="field">
                <span className="field-label">{J.hypothesis}</span>
                <span className="help">{J.hypothesisHelp}</span>
                <textarea
                  value={hypothesis}
                  onChange={(e) => setHypothesis(e.target.value)}
                  rows={4}
                />
              </label>
              <label className="field">
                <span className="field-label">{J.learned}</span>
                <span className="help">{J.learnedHelp}</span>
                <textarea
                  value={learned}
                  onChange={(e) => setLearned(e.target.value)}
                  rows={5}
                />
              </label>
              <div className="row-inline">
                <Button
                  variant="primary"
                  type="submit"
                  disabled={saving || !dirty}
                  busy={saving}
                >
                  {saving ? J.saving : J.save}
                </Button>
                <span className="save-state" role="status" aria-live="polite">
                  {justSaved && !dirty ? (
                    <span className="feedback ok">
                      <IconCheck size={15} />
                      {J.saved}
                    </span>
                  ) : dirty ? (
                    <span className="muted">{J.unsaved}</span>
                  ) : null}
                </span>
              </div>
              {error && (
                <p className="inline-error" role="alert">
                  {errorText(error.code, "journal")}
                </p>
              )}
            </form>
          </Card>
        </div>
      )}
    </>
  );
}
