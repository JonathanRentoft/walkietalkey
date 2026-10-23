import { useRef, type CSSProperties, type ElementType } from "react";
import { useReducedMotion, useSpotlight } from "../lib/hooks";
import { cx, type Style } from "../lib/util";

export interface PrismTextProps {
  /** 'fill' (default) solid letters; 'stroke' outlined letters that fill in under the spotlight. */
  mode?: "fill" | "stroke";
  /** A soft halo around the shine. */
  glow?: boolean;
  /** Spotlight radius in px. Default 220. */
  size?: number;
  /** Element to render. Default 'span'. */
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  style?: CSSProperties;
  /** The text. Keep it to a few words. */
  children?: string;
}

export function PrismText(props: PrismTextProps) {
  const ref = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  useSpotlight(ref, reduced);
  const text = props.children;
  const El = (props.as || "span") as ElementType;
  const style = Object.assign(
    { "--wt-r": (props.size || 220) + "px" } as Style,
    props.style,
  );
  return (
    <El
      ref={ref}
      className={cx(
        "wt-prism",
        "wt-prism--" + (props.mode || "fill"),
        props.glow && "wt-prism--glow",
        reduced && "wt-prism--still",
        props.className,
      )}
      style={style}
    >
      <span className="wt-prism-base">{text}</span>
      <span className="wt-prism-reveal" aria-hidden>
        {text}
      </span>
    </El>
  );
}
