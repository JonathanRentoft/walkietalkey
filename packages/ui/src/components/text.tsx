/* Text effects: Transcript and FlipWords. */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";
import { useReducedMotion } from "../lib/hooks";
import { cx } from "../lib/util";

export interface TranscriptProps {
  /** The sentence. */
  children?: string;
  text?: string;
  /** Words to mark, e.g. English words in Danish. */
  highlight?: string[];
  /** ms per word. Default 170. */
  speed?: number;
  /** ms pause before it starts over; omit to play once. */
  loop?: number;
  delay?: number;
  cursor?: boolean;
  as?: keyof JSX.IntrinsicElements;
  className?: string;
  style?: CSSProperties;
}

/** Words appear one at a time out of a soft blur, like speech turning into text.
    `highlight` lists words to mark (e.g. English words in a Danish sentence). Loops when `loop` is set (ms pause).
    Screen readers get the whole sentence at once. */
export function Transcript(props: TranscriptProps) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLElement>(null);
  const words = String(props.children || props.text || "")
    .split(/\s+/)
    .filter(Boolean);
  const hl = (props.highlight || []).map((w) => w.toLowerCase());
  const [n, setN] = useState(reduced ? words.length : 0);
  const per = props.speed || 170;
  useEffect(() => {
    if (reduced) {
      setN(words.length);
      return undefined;
    }
    const el = ref.current;
    let k = 0,
      t: ReturnType<typeof setTimeout>,
      visible = true;
    function tick() {
      if (!visible || document.hidden) {
        t = setTimeout(tick, 300);
        return;
      }
      if (k < words.length) {
        k += 1;
        setN(k);
        t = setTimeout(
          tick,
          per + (/[.,?!]$/.test(words[k - 1]) ? per * 1.6 : 0),
        );
      } else if (props.loop) {
        t = setTimeout(() => {
          k = 0;
          setN(0);
          t = setTimeout(tick, 500);
        }, props.loop);
      }
    }
    t = setTimeout(tick, props.delay || 300);
    const io =
      el && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((es) => {
            visible = es[0].isIntersecting;
          })
        : null;
    if (io) io.observe(el!);
    return () => {
      clearTimeout(t);
      if (io) io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced, words.join(" "), per, props.loop]);
  const El = (props.as || "p") as ElementType;
  const kids = words
    .map((w, i) => {
      const bare = w.replace(/[.,?!:;]/g, "").toLowerCase();
      return (
        <span
          key={i}
          aria-hidden
          className={cx(
            "wt-tw",
            i < n && "wt-tw--in",
            hl.indexOf(bare) >= 0 && "wt-tw--hl",
          )}
        >
          {w}
        </span>
      );
    })
    .reduce<ReactNode[]>((acc, el, i) => {
      if (i) acc.push(" ");
      acc.push(el);
      return acc;
    }, []);
  /* The design system names the element with aria-label. ARIA does not allow a name on a paragraph, so the
     sentence is given as visually hidden text instead: screen readers hear the same, and audits stay clean. */
  return (
    <El
      ref={ref}
      className={cx("wt-transcript", props.className)}
      style={props.style}
    >
      <span className="wt-sr">{words.join(" ")}</span>
      {kids}
      {props.cursor === false ? null : <i className="wt-caret" aria-hidden />}
    </El>
  );
}

export interface FlipWordsProps {
  words?: string[];
  /** ms between words. Default 2600. */
  interval?: number;
  className?: string;
  style?: CSSProperties;
}

/** One word in a sentence changes every few seconds. */
export function FlipWords(props: FlipWordsProps) {
  const reduced = useReducedMotion();
  const words = props.words || ["mails", "noter", "beskeder", "kode"];
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reduced || words.length < 2) return undefined;
    const id = setInterval(() => {
      setI((v) => (v + 1) % words.length);
    }, props.interval || 2600);
    return () => {
      clearInterval(id);
    };
  }, [reduced, words.length, props.interval]);
  const longest = words.reduce((a, w) => (w.length > a.length ? w : a), "");
  return (
    <span className={cx("wt-flip", props.className)} style={props.style}>
      <span className="wt-flip-sizer" aria-hidden>
        {longest}
      </span>
      <span className="wt-flip-word" key={i}>
        {words[i]}
      </span>
    </span>
  );
}
