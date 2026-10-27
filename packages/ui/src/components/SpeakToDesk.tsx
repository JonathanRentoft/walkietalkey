/* Run 10: SpeakToDesk, the devices scene of the front page, without a card around it. A MacBook, a ThinkPad and the
   phone sit on the page. You hold the phone's button and talk; the sound goes to the computer you sit at (the
   unlocked one with the most recent input, PHONE-40 and DESK-63), the MacBook: its menu bar icon pulses and the pill
   listens while the sound streams in (DESK-58), then "Tekst klar til at indsætte" (DESK-56), and the text lands when
   you paste (DESK-52). The ThinkPad, not in use, gets nothing, not even in its history (spec 12.1).

   The stage is drawn at a fixed size and scaled to the width of its box in CSS (container query units), so the
   server's picture is already the right size before the island hydrates. Narrow boxes (under 560 px) get a second
   arrangement with the MacBook on top. The server, the paused page before its first run, and reduced motion all show
   one still frame that tells the whole story: the button held, the sound on its way, the words on the MacBook, the
   ThinkPad dimmed and empty. */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useIsoLayoutEffect, useReducedMotion } from "../lib/hooks";
import type { Palette } from "../lib/palettes";
import { cx, fill } from "../lib/util";
import { DictationPill, type DictationPillState } from "./DictationPill";
import {
  ComposeWindow,
  Keycap,
  LaptopFrame,
  MenuBar,
  Notice,
  PhoneApp,
  PhoneFrame,
  Taskbar,
  type PhoneAppState,
} from "./devices";

/** The words the scene shows besides the product's own (spec Appendix A). */
export interface SpeakToDeskLabels {
  /** Under the computer you sit at. Default "I brug" (the design system's devices scene says "· i brug"). */
  inUse?: string;
  /** Under the other computer. Default "Ikke i brug". */
  notInUse?: string;
  /** The accessible description; {inUse} and {other} are the computers' names. */
  description?: string;
}

export const SPEAK_TO_DESK_LABELS: Required<SpeakToDeskLabels> = {
  inUse: "I brug",
  /* TODO(copy) */
  notInUse: "Ikke i brug",
  /* TODO(copy) */
  description:
    "Du holder knappen nede i WalkieTalkey på telefonen og taler. Teksten lander kun på den computer, du sidder ved: {inUse}, som er i brug, viser Tekst klar til at indsætte, og teksten sættes ind. {other}, som ikke er i brug, forbliver tom.",
};

export interface SpeakToDeskProps {
  /** Holds the scene where it is: no timers, no animation frames, its CSS motion held. The page sets it while the
      scene is off screen or another background is the one that moves. Off screen and in a hidden tab it also waits
      on its own. Until its first run it shows the still frame. */
  paused?: boolean;
  /** What is said. */
  text?: string;
  /** The accessible description. Default: SPEAK_TO_DESK_LABELS.description with the names filled in. */
  label?: string;
  /** The scene's own words ("I brug", "Ikke i brug"). */
  labels?: SpeakToDeskLabels;
  phoneScreen?: "dark" | "light";
  palette?: Palette;
  className?: string;
  style?: CSSProperties;
}

const IN_USE = "MacBook",
  OTHER = "ThinkPad";
const DEFAULT_TEXT =
  "Hej Mette. Jeg er ti minutter forsinket, så bare start uden mig.";

/* One loop of about eight seconds. "still" (index -1) is the frame for the server, for a paused page before the first
   run, and for reduced motion. A run starts at "paste", the step closest to the still frame, so nothing jumps when the
   island wakes up. rec0 to rec2 are the seconds on the phone's timer. */
const STEPS = [
  ["idle", 650],
  ["press", 250],
  ["rec0", 1000],
  ["rec1", 1000],
  ["rec2", 450],
  ["send", 850],
  ["ready", 950],
  ["keys", 450],
  ["paste", 2400],
  ["reset", 500],
] as const;
type Step = (typeof STEPS)[number][0] | "still";
const START = 8; /* paste */

/** The step index, or -1 for the still frame. Runs only while `run`, the element is on screen and the tab is visible;
    holding keeps the step and the time left in it. One timer at a time, no animation frames. */
function useStory(ref: RefObject<Element>, run: boolean): number {
  const [i, setI] = useState(-1);
  const at = useRef({ i: -1, left: 0 });
  useEffect(() => {
    if (!run) return undefined;
    const s = at.current;
    if (s.i < 0) {
      s.i = START;
      s.left = STEPS[START][1];
      setI(START);
    }
    const el = ref.current;
    let timer: ReturnType<typeof setTimeout> | 0 = 0,
      started = 0,
      visible = true;
    function schedule() {
      if (timer || !visible || document.hidden) return;
      started = Date.now();
      timer = setTimeout(next, s.left);
    }
    function next() {
      timer = 0;
      s.i = (s.i + 1) % STEPS.length;
      s.left = STEPS[s.i][1];
      setI(s.i);
      schedule();
    }
    function hold() {
      if (!timer) return;
      clearTimeout(timer);
      timer = 0;
      s.left = Math.max(0, s.left - (Date.now() - started));
    }
    const io =
      el && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((es) => {
            visible = es[0].isIntersecting;
            if (visible) schedule();
            else hold();
          })
        : null;
    if (io) io.observe(el!);
    function onVis() {
      if (document.hidden) hold();
      else schedule();
    }
    document.addEventListener("visibilitychange", onVis);
    schedule();
    return () => {
      hold();
      if (io) io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [run]);
  return i;
}

/* the stage sizes in px; extensions.css draws both arrangements at these sizes */
const WIDE = 960,
  NARROW = 600,
  NARROW_BELOW = 560;

/** Browsers without tan(atan2()) in CSS (before 2023) get the scale from a ResizeObserver instead. */
function useScaleFallback(
  box: RefObject<HTMLElement>,
  stage: RefObject<HTMLElement>,
) {
  useIsoLayoutEffect(() => {
    const b = box.current,
      s = stage.current;
    if (
      !b ||
      !s ||
      typeof CSS === "undefined" ||
      !CSS.supports ||
      CSS.supports("transform", "scale(tan(atan2(1px, 2px)))") ||
      typeof ResizeObserver === "undefined"
    )
      return undefined;
    const ro = new ResizeObserver((es) => {
      const w = es[0].contentRect.width;
      if (w > 0)
        s.style.transform =
          "scale(" + w / (w < NARROW_BELOW ? NARROW : WIDE) + ")";
    });
    ro.observe(b);
    return () => {
      ro.disconnect();
    };
  }, []);
}

/* The frames set their size (font-size) from `width`; extensions.css sets it for each arrangement instead. */
const FRAME_SIZE_FROM_CSS: CSSProperties = { fontSize: undefined };

function Label(p: { name: string; state: string; on: boolean }) {
  return (
    <div className="wt-spk-label">
      <span className="wt-spk-name">{p.name}</span>
      <span
        className={cx(
          "wt-spk-state",
          p.on ? "wt-spk-state--on" : "wt-spk-state--off",
        )}
      >
        <i />
        {p.state}
      </span>
    </div>
  );
}

/** The devices scene without a card: you hold the phone's button and talk, and the words land only on the computer
    you sit at (the MacBook); the ThinkPad stays empty. Loops while on screen; `paused` holds it; with reduced motion,
    and on the server, it is one still frame with the whole story. Scales to the width of its box. */
export function SpeakToDesk(props: SpeakToDeskProps) {
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  useScaleFallback(box, stage);
  const i = useStory(ref, !reduced && !props.paused);
  const s: Step = reduced || i < 0 ? "still" : STEPS[i][0];
  const still = s === "still";

  const L = Object.assign({}, SPEAK_TO_DESK_LABELS, props.labels || {});
  const text = props.text || DEFAULT_TEXT;
  const recording = s.startsWith("rec");
  /* the phone says "Sender til MacBook" while the last of the sound goes */
  const flowing = recording || s === "send";
  const seconds =
    s === "rec1" ? 1 : s === "rec2" || s === "send" ? 2 : still ? 3 : 0;
  const app: PhoneAppState =
    still || recording
      ? "rec"
      : s === "send"
        ? "send"
        : s === "ready" || s === "keys" || s === "paste"
          ? "ready"
          : "idle";
  const held = still || s === "press" || recording;
  const pill: DictationPillState | null = recording
    ? "listening"
    : s === "send"
      ? "processing"
      : null;
  const lastPill = useRef<DictationPillState>("listening");
  if (pill) lastPill.current = pill;
  const live = still || flowing;
  const noticeIn = still || s === "ready" || s === "keys";
  const pasted = still || s === "paste" || s === "reset";

  return (
    <div
      ref={ref}
      className={cx(
        "wt-spk",
        props.paused && "wt-spk--paused",
        reduced && "wt-spk--reduced",
        props.className,
      )}
      style={props.style}
      data-step={s}
      role="img"
      aria-label={
        props.label || fill(L.description, { inUse: IN_USE, other: OTHER })
      }
    >
      <div ref={box} className="wt-spk-box">
        <div ref={stage} className="wt-spk-stage" aria-hidden>
          <span className="wt-spk-glow" />

          {/* the computer you sit at */}
          <div
            className={cx(
              "wt-spk-dev wt-spk-dev--on wt-spk-dev--mac",
              s === "reset" && "wt-spk-dev--clear",
              (still || s === "paste") && "wt-spk-dev--landed",
            )}
          >
            <span className="wt-spk-floor" />
            <LaptopFrame
              width={380}
              screen="light"
              className="wt-spk-laptop"
              style={FRAME_SIZE_FROM_CSS}
            >
              <div className="wt-desk">
                <MenuBar platform="mac" live={live} />
                <ComposeWindow platform="mac" text={text} pasted={pasted} />
                <Notice platform="mac" show={noticeIn} preview={text} />
                <div className={cx("wt-desk-pill", pill && "wt-desk-pill--in")}>
                  <DictationPill
                    state={pill || lastPill.current}
                    seconds={seconds}
                    palette={props.palette}
                  />
                </div>
                <div
                  className={cx(
                    "wt-desk-keys",
                    s === "keys" && "wt-desk-keys--in",
                  )}
                >
                  <Keycap pressed={s === "keys"} size={26}>
                    ⌘
                  </Keycap>
                  <Keycap pressed={s === "keys"} size={26}>
                    V
                  </Keycap>
                </div>
              </div>
            </LaptopFrame>
            <Label name={IN_USE} state={L.inUse} on />
          </div>

          {/* the other computer: dimmed, as an idle display dims, and nothing ever arrives */}
          <div className="wt-spk-dev wt-spk-dev--off wt-spk-dev--thinkpad">
            <span className="wt-spk-floor" />
            <LaptopFrame
              width={380}
              screen="light"
              className="wt-spk-laptop wt-spk-tp"
              style={FRAME_SIZE_FROM_CSS}
            >
              <div className="wt-desk wt-desk--win">
                <div className="wt-spk-quiet">
                  <div className="wt-spk-quiet-bar" />
                  <div className="wt-spk-quiet-body">
                    {[86, 72, 90, 58, 78].map((w, k) => (
                      <i key={k} style={{ width: w + "%" }} />
                    ))}
                  </div>
                </div>
                <Taskbar platform="windows" />
                <span className="wt-spk-dim" />
              </div>
            </LaptopFrame>
            <Label name={OTHER} state={L.notInUse} on={false} />
          </div>

          {/* the sound on its way: a dotted route and small capsules of voice, to the MacBook's menu bar icon */}
          <svg
            className={cx("wt-spk-arcs", live && "wt-spk-arcs--on")}
            width={1}
            height={1}
            focusable="false"
          >
            <path className="wt-spk-arc wt-spk-arc--wide" d={ARC_WIDE} />
            <path className="wt-spk-arc wt-spk-arc--narrow" d={ARC_NARROW} />
          </svg>
          <div
            className={cx(
              "wt-spk-flow",
              flowing && "wt-spk-flow--on",
              still && "wt-spk-flow--still",
            )}
          >
            {[0, 1, 2].map((k) => (
              <span key={k} className="wt-spk-pkt">
                {[0.5, 0.85, 1, 0.7, 0.45].map((h, b) => (
                  <i key={b} style={{ transform: "scaleY(" + h + ")" }} />
                ))}
              </span>
            ))}
          </div>

          <div className="wt-spk-phone">
            <span className="wt-spk-floor" />
            <PhoneFrame
              width={176}
              screen={props.phoneScreen || "dark"}
              style={FRAME_SIZE_FROM_CSS}
            >
              <PhoneApp
                state={app}
                seconds={seconds}
                device={IN_USE}
                palette={props.palette}
                level={still ? 0.7 : undefined}
              />
              {/* the voice reaching the microphone: rings closing in on the held button */}
              <span
                className={cx(
                  "wt-spk-voice",
                  recording && "wt-spk-voice--on",
                  still && "wt-spk-voice--still",
                )}
              >
                <i />
                <i />
                <i />
              </span>
              <span
                className={cx(
                  "wt-finger",
                  held && "wt-finger--button wt-finger--down",
                )}
              />
            </PhoneFrame>
          </div>
        </div>
      </div>
    </div>
  );
}

/* The dotted route from the phone to the MacBook's menu bar icon, in stage px: start, control point, end. The capsules
   in extensions.css fly the same quadratic curves (--cx/--cy and --ex/--ey are the control and the end, relative to
   the start). Keep the two in step. */
const ARC_WIDE = "M480 186 Q 440 -10, 396 82";
const ARC_NARROW = "M459 372 Q 600 150, 484 59";
