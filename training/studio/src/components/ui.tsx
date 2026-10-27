/* Small shared pieces: buttons, notices, errors with a retry, sections, stat tiles, a job's log. */
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type { ApiError } from "../api/client";
import type { Job } from "../api/types";
import { dateTime } from "../lib/format";
import { Link } from "../router";
import { errorText, S, type ErrorArea } from "../strings";

type Variant = "primary" | "secondary" | "quiet" | "danger";

export function Button({
  variant = "secondary",
  size,
  busy,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "lg";
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      aria-busy={busy || undefined}
      className={[
        "btn",
        `btn--${variant}`,
        size ? `btn--${size}` : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </button>
  );
}

export function PageHeader({
  title,
  intro,
  children,
}: {
  title: string;
  intro?: string;
  children?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {intro && <p className="lead">{intro}</p>}
      </div>
      {children && <div className="page-header-side">{children}</div>}
    </header>
  );
}

export function Section({
  title,
  help,
  aside,
  children,
  id,
  className,
}: {
  title: string;
  help?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section
      className={["section", className ?? ""].join(" ")}
      aria-labelledby={id ? `${id}-h` : undefined}
    >
      <div className="section-head">
        <div>
          <h2 id={id ? `${id}-h` : undefined}>{title}</h2>
          {help && <p className="help">{help}</p>}
        </div>
        {aside && <div className="section-aside">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={["card", className ?? ""].join(" ")}>{children}</div>;
}

export function Notice({
  kind = "info",
  children,
  role,
}: {
  kind?: "info" | "warn" | "ok";
  children: ReactNode;
  role?: "status" | "alert";
}) {
  return (
    <div className={`notice notice--${kind}`} role={role}>
      {children}
    </div>
  );
}

/** A failed request in plain Danish, with a retry. */
export function ErrorBox({
  error,
  onRetry,
  area,
}: {
  error: ApiError | null;
  onRetry?: () => void;
  area?: ErrorArea;
}) {
  if (!error) return null;
  return (
    <div className="notice notice--warn error-box" role="alert">
      <p>{errorText(error.code, area)}</p>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {S.common.retry}
        </Button>
      )}
    </div>
  );
}

/** An empty list or panel (run 11): what will appear here, after which step, and a way there. */
export function Empty({
  what,
  when,
  code,
  to,
}: {
  what: string;
  when?: string;
  /** A command to run in the terminal, shown whole on its own line. */
  code?: string;
  to?: { href: string; label: string };
}) {
  return (
    <div className="empty empty-state">
      <p className="empty-what">{what}</p>
      {when && <p className="empty-when">{when}</p>}
      {code && <code className="empty-code">{code}</code>}
      {to && (
        <Link className="btn btn--secondary btn--sm empty-go" href={to.href}>
          {to.label}
        </Link>
      )}
    </div>
  );
}

export function Loading({ label = S.common.loading }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="loading-dot" aria-hidden="true" />
      {label}
    </p>
  );
}

export function StatTile({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className="stat-value">{value}</p>
      {sub && <p className="stat-sub">{sub}</p>}
    </div>
  );
}

/** A job's status and its log (the last 400 lines), following the end while it runs. */
export function JobPanel({
  job,
  open: openInitially = true,
}: {
  job: Job;
  open?: boolean;
}) {
  const [open, setOpen] = useState(openInitially);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (el && open) el.scrollTop = el.scrollHeight;
  }, [job.log.length, open]);
  return (
    <div className={`job job--${job.status}`}>
      <div className="job-head">
        <span className={`job-status job-status--${job.status}`}>
          <span className="dot" aria-hidden="true" />
          {S.common.job[job.status] ?? job.status}
        </span>
        <span className="job-title">{job.title}</span>
        {job.started && (
          <span className="job-when">
            {S.common.started(dateTime(job.started))}
          </span>
        )}
        <Button
          variant="quiet"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? S.common.hideLog : S.common.showLog}
        </Button>
      </div>
      {open && (
        <pre
          className="job-log"
          ref={logRef}
          tabIndex={0}
          aria-label={S.common.log}
        >
          {job.log.length ? job.log.join("\n") : S.common.emptyLog}
        </pre>
      )}
    </div>
  );
}

/** A segmented choice (radio buttons that look like a pill group). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const i = options.findIndex((x) => x.value === value);
            const next =
              options[
                (i + (e.key === "ArrowRight" ? 1 : options.length - 1)) %
                  options.length
              ];
            onChange(next.value);
            const group = e.currentTarget.parentElement;
            requestAnimationFrame(() =>
              (
                group?.querySelector(
                  '[aria-checked="true"]',
                ) as HTMLElement | null
              )?.focus(),
            );
          }}
          tabIndex={o.value === value ? 0 : -1}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
