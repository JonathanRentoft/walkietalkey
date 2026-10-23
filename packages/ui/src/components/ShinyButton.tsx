import type * as React from "react";
import { cx, omit } from "../lib/util";

function Arrow() {
  return (
    <svg
      className="wt-shiny-icon"
      width={16}
      height={16}
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
    >
      <path
        d="M3 8h9.5M8.75 4.25 12.5 8l-3.75 3.75"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface ShinyButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** 'ink' (default) is the primary action; 'glass' sits on gradients; 'paper' is a light button for dark sections on a light page. */
  variant?: "ink" | "glass" | "paper";
  size?: "md" | "lg";
  /** Trailing icon. Default an arrow; false for none. */
  icon?: React.ReactNode | false;
  /** Extension: with href the same button is rendered as a link (<a>), for navigation. */
  href?: string;
  target?: string;
  rel?: string;
}

export function ShinyButton(props: ShinyButtonProps) {
  const variant = props.variant || "ink",
    size = props.size || "md";
  const className = cx(
    "wt-shiny",
    "wt-shiny--" + variant,
    "wt-shiny--" + size,
    props.className,
  );
  const kids = (
    <>
      <span className="wt-shiny-ring" aria-hidden />
      <span className="wt-shiny-sheen" aria-hidden />
      <span className="wt-shiny-label">{props.children}</span>
      {props.icon === false ? null : props.icon || <Arrow />}
    </>
  );
  if (props.href != null) {
    const rest = omit(props, [
      "variant",
      "size",
      "icon",
      "className",
      "children",
      "type",
      "disabled",
      "form",
      "formAction",
      "formMethod",
      "formTarget",
      "formNoValidate",
      "formEncType",
      "name",
      "value",
    ]);
    return (
      <a
        {...(rest as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
        className={className}
      >
        {kids}
      </a>
    );
  }
  const rest = omit(props, [
    "variant",
    "size",
    "icon",
    "className",
    "children",
    "href",
    "target",
    "rel",
  ]);
  return (
    <button type="button" {...rest} className={className}>
      {kids}
    </button>
  );
}
