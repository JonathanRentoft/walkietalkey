import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useIsoLayoutEffect } from "../lib/hooks";
import { pal, type Palette } from "../lib/palettes";
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
  | "error"
  | "micsilent";

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
  /** Extension: "Tryk igen for at stoppe" while recording hands-free. */
  handsFree?: string;
  /** Extension: "Mikrofonen giver ingen lyd" (DESK-59), while listening and
   *  as the end state. */
  micSilent?: string;
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
  /** Extension: the live microphone level, one bar each (0 to 1). While
   *  listening it replaces the animated meter with a real waveform. */
  levels?: readonly number[];
  /** Extension: listening hands-free (tapped, not held): a lock and
   *  "Tryk igen for at stoppe". */
  handsFree?: boolean;
  /** Extension: 'lg' is the desktop overlay's pill, 56 px high with larger
   *  text and a glass surface. Default 'md', the design system's 44 px. */
  size?: "md" | "lg";
  /** Extension: the mark leads the listening and processing states. */
  mark?: boolean;
  /** Extension: while listening, the input has delivered no sound for a
   *  while (DESK-59): the notice replaces the waveform. */
  silentMic?: boolean;
  /** Extension: a second, quieter part after an outcome note, such as
   *  "Prøv MacBook Pro-mikrofon" after "Mikrofonen giver ingen lyd". */
  hint?: string;
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
  handsFree: "Tryk igen for at stoppe",
  /* not in Appendix A (DESK-59); approved by the owner in run 8 */
  micSilent: "Mikrofonen giver ingen lyd",
};

function Lock() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
    >
      <path
        d="M4.9 7.2V5.4a3.1 3.1 0 0 1 6.2 0v1.8M3.9 7.2h8.2a.8.8 0 0 1 .8.8v5a.8.8 0 0 1-.8.8H3.9a.8.8 0 0 1-.8-.8V8a.8.8 0 0 1 .8-.8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The live waveform: one bar per level, coloured along the palette. */
function Wave(p: { levels: readonly number[]; palette?: Palette }) {
  const stops = pal(p.palette).stops;
  const n = p.levels.length;
  return (
    <span className="wt-wave" aria-hidden>
      {p.levels.map((v, i) => {
        const col =
          stops[Math.round((i / Math.max(1, n - 1)) * (stops.length - 1))];
        return (
          <i
            key={i}
            style={
              {
                "--v": String(
                  Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000,
                ),
                "--c": "var(--" + col + ")",
              } as CSSProperties
            }
          />
        );
      })}
    </span>
  );
}

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
  micsilent: "micSilent",
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
  const handsFree = state === "listening" && !!props.handsFree;
  const silentMic = state === "listening" && !!props.silentMic;
  const levelCount = props.levels ? props.levels.length : -1;
  useIsoLayoutEffect(() => {
    if (inner.current)
      setW(
        Math.ceil(inner.current.offsetWidth),
      ); /* layout width: right inside scaled stages too */
  }, [
    state,
    timeKey,
    handsFree,
    levelCount,
    props.size,
    props.mark,
    L.ready,
    L.processing,
    L.idleBefore,
    L.idleAfter,
    L.pasted,
    L.noSpeech,
    L.raw,
    L.notReady,
    L.error,
    L.handsFree,
    L.micSilent,
    silentMic,
    props.hint,
  ]);

  const markEl = props.mark ? (
    <span key="m" className="wt-pill-mark" aria-hidden>
      <Logo
        variant="mark"
        tone="paper"
        size={props.size === "lg" ? 18 : 14}
        decorative
      />
    </span>
  ) : null;
  let content: ReactNode[];
  const note = NOTES[state];
  if (state === "listening") {
    const meter = silentMic ? (
      <span key="mic" className="wt-pill-hint wt-pill-mic">
        {L.micSilent}
      </span>
    ) : props.levels ? (
      <Wave key="wave" levels={props.levels} palette={props.palette} />
    ) : (
      <GradientBars
        key="bars"
        variant="meter"
        bars={11}
        palette={props.palette}
        height={18}
      />
    );
    content = handsFree
      ? [
          <span key="lock" className="wt-pill-lock" aria-hidden>
            <Lock />
          </span>,
          <span key="sr" className="wt-sr">
            {L.listening}
          </span>,
          meter,
          silentMic ? null : (
            <span key="hf" className="wt-pill-hint">
              {L.handsFree}
            </span>
          ),
          <span key="t" className="wt-pill-time">
            {fmt(seconds)}
          </span>,
        ]
      : [
          markEl,
          <span key="rec" className="wt-rec" aria-hidden />,
          <span key="sr" className="wt-sr">
            {L.listening}
          </span>,
          meter,
          <span key="t" className="wt-pill-time">
            {fmt(seconds)}
          </span>,
        ];
  } else if (state === "processing") {
    content = [
      markEl,
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
      props.hint ? (
        // Two lines, so the pill stays narrow: the note, then the hint.
        <span key="l" className="wt-pill-note-text">
          <span>{L[note]}</span>{" "}
          <span className="wt-pill-note-hint">{props.hint}</span>
        </span>
      ) : (
        <span key="l">{L[note]}</span>
      ),
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
      className={cx(
        "wt-pill",
        "wt-pill--" + state,
        handsFree && "wt-pill--handsfree",
        props.size === "lg" && "wt-pill--lg",
        props.className,
      )}
      style={Object.assign({ width: w == null ? undefined : w }, props.style)}
      role="status"
      aria-live="polite"
    >
      <span className="wt-pill-halo" aria-hidden />
      <div className="wt-pill-clip">
        <div
          ref={inner}
          className="wt-pill-inner"
          key={handsFree ? "handsfree" : state}
        >
          {content}
        </div>
      </div>
    </div>
  );
}
