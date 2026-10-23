// Small controls built from the design system's tokens (styles.css). Every
// control has a visible label or an accessible name, a focus ring, and works
// with the keyboard (spec 6.17).
import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { useTranslation } from "react-i18next";
import { useLocked } from "../lib/wtStore";

const cx = (...c: (string | false | null | undefined)[]) =>
  c.filter(Boolean).join(" ");

export function LockIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
    >
      <path
        d="M4.6 7.2V5.3a3.4 3.4 0 0 1 6.8 0v1.9M3.6 7.2h8.8v6.3H3.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "Styret af din organisation" (DESK-101). */
export function LockNote() {
  const { t } = useTranslation();
  return (
    <span className="wt-lock">
      <LockIcon />
      {t("wt.managed")}
    </span>
  );
}

export function Page(props: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="wt-page" aria-labelledby="wt-page-title">
      <header className="wt-page-head">
        <h1 id="wt-page-title" className="wt-page-title">
          {props.title}
        </h1>
        {props.description ? (
          <p className="wt-page-desc">{props.description}</p>
        ) : null}
      </header>
      {props.children}
    </section>
  );
}

export function Group(props: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section
      className={cx("wt-group", props.className)}
      aria-labelledby={props.title ? id : undefined}
    >
      {props.title ? (
        <h2 id={id} className="wt-group-title">
          {props.title}
        </h2>
      ) : null}
      {props.description ? (
        <p className="wt-group-desc">{props.description}</p>
      ) : null}
      <div className="wt-card">{props.children}</div>
    </section>
  );
}

type RowChildren =
  | ReactNode
  | ((ctx: { locked: boolean; labelId: string; descId: string }) => ReactNode);

/** One setting: label, optional description, the control, and the lock
 *  when a company manages the field. */
export function SettingRow(props: {
  title: string;
  description?: ReactNode;
  /** WtSettings (or Handy) field whose lock applies. */
  lockField?: string;
  /** Extra lock reasons (for example a Handy-side lock). */
  locked?: boolean;
  /** Puts the control under the label instead of beside it. */
  stacked?: boolean;
  /** Associates the label with this control id. */
  htmlFor?: string;
  children: RowChildren;
}) {
  const fieldLocked = useLocked(props.lockField);
  const locked = fieldLocked || !!props.locked;
  const labelId = useId();
  const descId = useId();
  const content =
    typeof props.children === "function"
      ? props.children({ locked, labelId, descId })
      : props.children;
  return (
    <div
      className={cx("wt-row", props.stacked && "wt-row--stacked")}
      data-locked={locked || undefined}
    >
      <div className="wt-row-text">
        {props.htmlFor ? (
          <label id={labelId} htmlFor={props.htmlFor} className="wt-row-title">
            {props.title}
          </label>
        ) : (
          <span id={labelId} className="wt-row-title">
            {props.title}
          </span>
        )}
        {props.description ? (
          <p id={descId} className="wt-row-desc">
            {props.description}
          </p>
        ) : null}
        {locked ? <LockNote /> : null}
      </div>
      <div className="wt-row-control">{content}</div>
    </div>
  );
}

export function Switch(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  labelledBy?: string;
  describedBy?: string;
  label?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={props.id}
      className="wt-switch"
      aria-checked={props.checked}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span className="wt-switch-thumb" aria-hidden />
    </button>
  );
}

export interface Choice<T extends string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

/** A radio group drawn as segments; arrow keys move between options. */
export function ChoiceGroup<T extends string>(props: {
  value: T | null;
  options: readonly Choice<T>[];
  onChange: (value: T) => void;
  labelledBy?: string;
  label?: string;
  disabled?: boolean;
  vertical?: boolean;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-labelledby={props.labelledBy}
      aria-label={props.label}
      className={cx("wt-choices", props.vertical && "wt-choices--vertical")}
    >
      {props.options.map((o) => {
        const id = `${name}-${o.value}`;
        return (
          <label
            key={o.value}
            htmlFor={id}
            className={cx(
              "wt-choice",
              props.value === o.value && "wt-choice--on",
              (props.disabled || o.disabled) && "wt-choice--disabled",
            )}
          >
            <input
              type="radio"
              id={id}
              name={name}
              value={o.value}
              checked={props.value === o.value}
              disabled={props.disabled || o.disabled}
              onChange={() => props.onChange(o.value)}
            />
            <span className="wt-choice-label">{o.label}</span>
            {o.description ? (
              <span className="wt-choice-desc">{o.description}</span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "quiet" | "danger";
  },
) {
  const { variant = "secondary", className, ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      className={cx("wt-btn", `wt-btn--${variant}`, className)}
    />
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props;
  return <input type="text" {...rest} className={cx("wt-input", className)} />;
}

export function Select(
  props: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode },
) {
  const { className, ...rest } = props;
  return <select {...rest} className={cx("wt-select", className)} />;
}

/** Announces changes to screen readers (aria-live). */
export function Status(props: {
  children: ReactNode;
  tone?: "ok" | "warn" | "muted";
  className?: string;
}) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cx(
        "wt-status",
        props.tone && `wt-status--${props.tone}`,
        props.className,
      )}
    >
      {props.children}
    </p>
  );
}

/** A modal dialog: focus moves in and is kept inside, Esc cancels, focus
 *  returns to where it was. */
export function Dialog(props: {
  open: boolean;
  title: string;
  /** Hide the title visually (it still names the dialog). */
  hideTitle?: boolean;
  onCancel: () => void;
  children: ReactNode;
  actions?: ReactNode;
  wide?: boolean;
  /** Role "alertdialog" for confirmations. */
  alert?: boolean;
}) {
  const titleId = useId();
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef(props.onCancel);
  cancel.current = props.onCancel;

  useEffect(() => {
    if (!props.open) return;
    const before = document.activeElement as HTMLElement | null;
    const el = box.current;
    const focusables = () =>
      Array.from(
        el?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    // Focus the first action, or the dialog itself.
    const first =
      el?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0];
    (first ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstItem) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && document.activeElement === lastItem) {
        e.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [props.open]);

  if (!props.open) return null;
  return (
    <div className="wt-dialog-backdrop">
      <div
        ref={box}
        role={props.alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx("wt-dialog", props.wide && "wt-dialog--wide")}
      >
        <h2
          id={titleId}
          className={cx(
            "wt-dialog-title",
            props.hideTitle && "wt-visually-hidden",
          )}
        >
          {props.title}
        </h2>
        <div className="wt-dialog-body">{props.children}</div>
        {props.actions ? (
          <div className="wt-dialog-actions">{props.actions}</div>
        ) : null}
      </div>
    </div>
  );
}
