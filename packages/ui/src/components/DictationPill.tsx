import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useIsoLayoutEffect } from "../lib/hooks";
import type { Palette } from "../lib/palettes";
import { cx, fmt } from "../lib/util";
import { Logo } from "./Logo";
import { GradientBars } from "./surfaces";

/** The four states of the design system, plus the product's outcome states (spec DESK-55 and Appendix A). */
export type DictationPillState =
  | "idle"
  | "listening"
  | "processing"
  | "ready"
  | "pasted"
  | "nospeech"
  | "raw"
  | "notready"
  | "error";

export interface DictationPillLabels {
  idleBefore?: string;
  idleAfter?: string;
  listening?: string;
  processing?: string;
  ready?: string;
  /** Extension: "Indsat" after an automatic paste (DESK-50). */
  pasted?: string;
  /** Extension: "Hørte ikke noget" (no speech in the clip). */
  noSpeech?: string;
  /** Extension: "Brugte teksten uden oprydning" (cleanup guardrail, DESK-84). */
  raw?: string;
  /** Extension: "Talemodellen er ikke klar endnu". */
  notReady?: string;
  /** Extension: "Kunne ikke hente talemodellen. Prøv igen." */
  error?: string;
}

export interface DictationPillProps {
  /** Ignored when autoplay is on. */
  state?: DictationPillState;
  /** Seconds recorded, shown while listening. */
  seconds?: number;
  /** Key shown in idle. Default 'fn'. */
  hotkey?: string;
  /** Key shown in ready. Default '⌘V'. */
  pasteKey?: string;
  palette?: Palette;
  labels?: DictationPillLabels;
  /** Loop through the four states on its own, for demos. */
  autoplay?: boolean;
  className?: string;
  style?: CSSProperties;
}

/* spec Appendix A, Pill */
export const PILL_LABELS: Required<DictationPillLabels> = {
  idleBefore: "Hold",
  idleAfter: "for at tale",
  listening: "Lytter",
  processing: "Renskriver",
  ready: "Tekst klar til at indsætte",
  pasted: "Indsat",
  noSpeech: "Hørte ikke noget",
  raw: "Brugte teksten uden oprydning",
  notReady: "Talemodellen er ikke klar endnu",
  error: "Kunne ikke hente talemodellen. Prøv igen.",
};

function Kbd(p: { children?: ReactNode }) {
  return <kbd className="wt-kbd">{p.children}</kbd>;
}
function Check() {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 12 12"
      aria-hidden
      focusable="false"
    >
      <path
        d="M2.5 6.2 4.9 8.6 9.5 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
const SEQ: [DictationPillState, number][] = [
  ["idle", 2400],
  ["listening", 3800],
  ["processing", 1700],
  ["ready", 2800],
];
const NOTES: Partial<Record<DictationPillState, keyof DictationPillLabels>> = {
  nospeech: "noSpeech",
  raw: "raw",
  notready: "notReady",
  error: "error",
};

export function DictationPill(props: DictationPillProps) {
  const auto = !!props.autoplay;
  const [autoState, setAutoState] = useState<DictationPillState>(
    props.state || "idle",
  );
  const state = auto ? autoState : props.state || "idle";
  const [autoSec, setAutoSec] = useState(0);
  const seconds = auto ? autoSec : props.seconds || 0;
  const L = Object.assign({}, PILL_LABELS, props.labels || {});

  useEffect(() => {
    if (!auto) return undefined;
    let i = 0,
      t: ReturnType<typeof setTimeout>;
    function next() {
      setAutoState(SEQ[i][0]);
      t = setTimeout(() => {
        i = (i + 1) % SEQ.length;
        next();
      }, SEQ[i][1]);
    }
    next();
    return () => {
      clearTimeout(t);
    };
  }, [auto]);
  useEffect(() => {
    if (!auto || state !== "listening") return undefined;
    const start = Date.now();
    setAutoSec(0);
    const iv = setInterval(() => {
      setAutoSec((Date.now() - start) / 1000);
    }, 250);
    return () => {
      clearInterval(iv);
    };
  }, [auto, state]);

  const inner = useRef<HTMLDivElement>(null);
  const [w, setW] = useState<number | null>(null);
  const timeKey = Math.floor(seconds) >= 600 ? "w" : "n";
  useIsoLayoutEffect(() => {
    if (inner.current)
      setW(
        Math.ceil(inner.current.offsetWidth),
      ); /* layout width: right inside scaled stages too */
  }, [
    state,
    timeKey,
    L.ready,
    L.processing,
    L.idleBefore,
    L.idleAfter,
    L.pasted,
    L.noSpeech,
    L.raw,
    L.notReady,
    L.error,
  ]);

  let content: ReactNode[];
  const note = NOTES[state];
  if (state === "listening") {
    content = [
      <span key="rec" className="wt-rec" aria-hidden />,
      <span key="sr" className="wt-sr">
        {L.listening}
      </span>,
      <GradientBars
        key="bars"
        variant="meter"
        bars={11}
        palette={props.palette}
        height={18}
      />,
      <span key="t" className="wt-pill-time">
        {fmt(seconds)}
      </span>,
    ];
  } else if (state === "processing") {
    content = [
      <span key="d" className="wt-wait" aria-hidden>
        <i />
        <i />
        <i />
      </span>,
      <span key="l" className="wt-shimmer">
        {L.processing}
      </span>,
    ];
  } else if (state === "ready") {
    content = [
      <span key="ok" className="wt-ok" aria-hidden>
        <Check />
      </span>,
      <span key="l">{L.ready}</span>,
      <Kbd key="k">{props.pasteKey || "⌘V"}</Kbd>,
    ];
  } else if (state === "pasted") {
    content = [
      <span key="ok" className="wt-ok" aria-hidden>
        <Check />
      </span>,
      <span key="l">{L.pasted}</span>,
    ];
  } else if (note) {
    content = [
      <span key="n" className="wt-pill-note" aria-hidden />,
      <span key="l">{L[note]}</span>,
    ];
  } else {
    content = [
      <Logo key="m" variant="mark" tone="paper" size={14} decorative />,
      <span key="a">{L.idleBefore}</span>,
      <Kbd key="k">{props.hotkey || "fn"}</Kbd>,
      <span key="b">{L.idleAfter}</span>,
    ];
  }
  return (
    <div
      className={cx("wt-pill", "wt-pill--" + state, props.className)}
      style={Object.assign({ width: w == null ? undefined : w }, props.style)}
      role="status"
      aria-live="polite"
    >
      <span className="wt-pill-halo" aria-hidden />
      <div className="wt-pill-clip">
        <div ref={inner} className="wt-pill-inner" key={state}>
          {content}
        </div>
      </div>
    </div>
  );
}
