/* The eight product scenes and ShowcaseCard, the box that puts one of them on a living surface. */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";
import {
  useFit,
  useReducedMotion,
  useSeconds,
  useTimeline,
  type Steps,
} from "../lib/hooks";
import type { Palette } from "../lib/palettes";
import { cx, type Style } from "../lib/util";
import {
  AppIcon,
  ICON,
  Ico,
  Keycap,
  Notice,
  PhoneApp,
  PhoneFrame,
  type PhoneAppState,
} from "./devices";
import { DictationPill, type DictationPillState } from "./DictationPill";
import {
  BarField,
  DottedGlow,
  GlassStrips,
  GradientBackground,
  GradientBars,
  GradientMotion,
  GradientRows,
  LiquidBackground,
} from "./surfaces";
import { Transcript } from "./text";
import { FluidMesh, LightWaves } from "./webgl";

export interface SceneProps {
  palette?: Palette;
  text?: string;
  device?: string;
  pasteKey?: string;
  /** Run 8: the text lands whole when the key is let go, as the app pastes it, instead of word by word (SceneMixed). */
  release?: boolean;
}

function SceneFit(p: {
  w: number;
  h: number;
  className?: string;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null),
    s = useFit(ref, p.w);
  return (
    <div
      ref={ref}
      className={cx("wt-scene", p.className)}
      style={{ aspectRatio: p.w + " / " + p.h }}
    >
      <div
        className="wt-scene-stage"
        style={{
          width: p.w,
          height: p.h,
          transform: "scale(" + s + ")",
          visibility: s ? "visible" : "hidden",
        }}
      >
        {p.children}
      </div>
    </div>
  );
}

function MiniWindow(p: {
  title?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <div className={cx("wt-mwin", p.className)} style={p.style}>
      <div className="wt-mwin-bar">
        <span className="wt-win-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="wt-mwin-title">{p.title}</span>
      </div>
      <div className="wt-mwin-body">{p.children}</div>
    </div>
  );
}

function GhostLines(p: { widths?: number[] }) {
  return (
    <div className="wt-ghost" aria-hidden>
      {(p.widths || [92, 78, 64]).map((w, i) => (
        <i key={i} style={{ width: w + "%" }} />
      ))}
    </div>
  );
}

/* Hold fn, talk, let go: the pill listens and cleans up, ⌘V puts the text in the note. */
const FN_STEPS: Steps = [
  ["idle", 1300],
  ["down", 250],
  ["rec", 2600],
  ["proc", 1300],
  ["ready", 1000],
  ["keys", 450],
  ["paste", 2900],
  ["reset", 500],
];
export function SceneFn(props: SceneProps) {
  const reduced = useReducedMotion(),
    ref = useRef<HTMLDivElement>(null);
  const i = useTimeline(ref, FN_STEPS, reduced, true, 6),
    st = FN_STEPS[i][0];
  const secs = useSeconds(st === "rec", reduced, 2);
  const pill: DictationPillState =
    st === "rec"
      ? "listening"
      : st === "proc"
        ? "processing"
        : st === "ready" || st === "keys" || st === "paste"
          ? "ready"
          : "idle";
  const cmd = st === "keys";
  const text =
    props.text || "Husk at sende tilbuddet til Skovgaard inden fredag.";
  return (
    <div ref={ref} className="wt-sc wt-sc-fn">
      <SceneFit w={520} h={360}>
        <MiniWindow title="Noter" className="wt-sc-fn-win">
          <p className="wt-sc-h">Tirsdag</p>
          <GhostLines widths={[88, 70]} />
          <p className="wt-sc-text">
            {st === "paste" ? (
              <span className="wt-win-pasted">{text}</span>
            ) : null}
            <i className="wt-caret" />
          </p>
        </MiniWindow>
        <div className="wt-sc-fn-pill">
          <DictationPill state={pill} seconds={secs} palette={props.palette} />
        </div>
        <div className="wt-sc-keys" aria-hidden>
          <div className="wt-sc-krow wt-sc-krow--top">
            {["Z", "X", "C", "V", "B"].map((k) => (
              <Keycap key={k} size={30} pressed={k === "V" && cmd}>
                {k}
              </Keycap>
            ))}
          </div>
          <div className="wt-sc-krow">
            <Keycap
              size={30}
              pressed={st === "down" || st === "rec"}
              className="wt-sc-fnkey"
            >
              fn
            </Keycap>
            <Keycap size={30}>⌃</Keycap>
            <Keycap size={30}>⌥</Keycap>
            <Keycap size={30} wide pressed={cmd}>
              ⌘
            </Keycap>
            <Keycap size={30} className="wt-sc-space">
              {""}
            </Keycap>
          </div>
        </div>
      </SceneFit>
    </div>
  );
}

/* The phone app on its own: hold, talk, sent, ready. */
const PHONE_STEPS: Steps = [
  ["idle", 1100],
  ["rec", 2800],
  ["send", 900],
  ["ready", 2300],
];
export function ScenePhone(props: SceneProps) {
  const reduced = useReducedMotion(),
    ref = useRef<HTMLDivElement>(null);
  const i = useTimeline(ref, PHONE_STEPS, reduced, true, 3),
    st = PHONE_STEPS[i][0] as PhoneAppState;
  const secs = useSeconds(st === "rec", reduced, 3);
  return (
    <div ref={ref} className="wt-sc wt-sc-phone">
      <SceneFit w={300} h={420}>
        <PhoneFrame width={300} screen="dark" className="wt-sc-phone-frame">
          <PhoneApp
            state={st}
            seconds={secs}
            device={props.device || "MacBook"}
            palette={props.palette}
          />
          <span
            className={cx(
              "wt-finger",
              st === "rec" && "wt-finger--button wt-finger--down",
            )}
          />
        </PhoneFrame>
      </SceneFit>
    </div>
  );
}

/* Notifications arrive one after another and stack, newest on top. */
const NOTES = [
  "Hej Mette. Jeg er ti minutter forsinket, så bare start uden mig.",
  "Kan du sende tallene fra kvartalet, når du har et øjeblik?",
  "Husk at bestille bord til fredag klokken syv.",
  "Tak for i dag. Jeg sender referatet i morgen tidlig.",
];
export function SceneNotify(props: SceneProps) {
  const reduced = useReducedMotion(),
    ref = useRef<HTMLDivElement>(null);
  const [n, setN] = useState(reduced ? 3 : 0);
  useEffect(() => {
    if (reduced) return undefined;
    const el = ref.current;
    let visible = true;
    const io =
      el && typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((es) => {
            visible = es[0].isIntersecting;
          })
        : null;
    if (io) io.observe(el!);
    const id = setInterval(() => {
      if (visible && !document.hidden) setN((v) => v + 1);
    }, 2300);
    return () => {
      clearInterval(id);
      if (io) io.disconnect();
    };
  }, [reduced]);
  /* the server cannot know about reduced motion; catch up when the browser does */
  useEffect(() => {
    if (reduced) setN((v) => Math.max(v, 3));
  }, [reduced]);
  const items: ReactNode[] = [];
  for (let k = 0; k < 3; k++) {
    const idx = n - k;
    if (idx < 0) continue;
    items.push(
      <div key={idx} className="wt-sc-note" style={{ "--k": k } as Style}>
        <div className="wt-sc-note-in">
          <Notice
            show
            preview={NOTES[idx % NOTES.length]}
            when={k === 0 ? "nu" : k * 2 + 1 + " min."}
            pasteKey={props.pasteKey}
          />
        </div>
      </div>,
    );
  }
  return (
    <div ref={ref} className="wt-sc wt-sc-notify">
      <SceneFit w={420} h={300}>
        <div className="wt-sc-notes">{items}</div>
      </SceneFit>
    </div>
  );
}

/* Renskriver: filler words and a self-correction fall away; capitals and punctuation arrive. */
const CLEAN: { w: string; d?: 1; c?: string; p?: string }[] = [
  { w: "øh", d: 1 },
  { w: "så", d: 1 },
  { w: "jeg", c: "Jeg" },
  { w: "tænker", p: "," },
  { w: "vi" },
  { w: "rykker" },
  { w: "mødet" },
  { w: "til" },
  { w: "onsdag", d: 1 },
  { w: "nej", d: 1 },
  { w: "altså", d: 1 },
  { w: "torsdag" },
  { w: "klokken" },
  { w: "ti", p: "." },
];
const CLEAN_STEPS: Steps = [
  ["raw", 1900],
  ["mark", 1100],
  ["clean", 2900],
  ["reset", 450],
];
export function SceneCleanup(_props: SceneProps) {
  const reduced = useReducedMotion(),
    ref = useRef<HTMLDivElement>(null);
  const i = useTimeline(ref, CLEAN_STEPS, reduced, true, 2),
    st = CLEAN_STEPS[i][0];
  const mark = st === "mark" || st === "clean",
    clean = st === "clean";
  return (
    <div ref={ref} className="wt-sc wt-sc-clean">
      <SceneFit w={420} h={280}>
        <div className="wt-sc-card">
          <div className="wt-sc-card-head">
            <span className={cx("wt-sc-tag", clean && "wt-sc-tag--on")}>
              {clean ? (
                <Ico d={ICON.wand} size={13} />
              ) : (
                <Ico d={ICON.mic} size={13} />
              )}
              {clean ? "Renskrevet" : "Det du sagde"}
            </span>
            <span className="wt-sc-card-meta">
              {/* was "Lokal oprydning"; self-corrections come from the optional AI cleanup (review finding 17) */}
              {clean ? "AI-oprydning" : "Rå tale"}
            </span>
          </div>
          <p
            className={cx(
              "wt-sc-clean-text",
              clean && "wt-sc-clean-text--done",
            )}
          >
            {CLEAN.map((t, k) => {
              const drop = t.d && mark;
              return (
                <span
                  key={k}
                  className={cx(
                    "wt-cw",
                    drop && "wt-cw--drop",
                    t.d && clean && "wt-cw--gone",
                  )}
                >
                  {clean && t.c ? t.c : t.w}
                  {t.p ? (
                    <span className={cx("wt-cw-p", clean && "wt-cw-p--in")}>
                      {t.p}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </p>
        </div>
      </SceneFit>
    </div>
  );
}

/* Ordliste: the words you add are spelled your way. */
const VOCAB = ["Skovgaard & Co.", "Q3-rapporten", "Supabase", "Lunar"];
const VOCAB_STEPS: Steps = [
  ["wrong", 1900],
  ["fix", 3000],
  ["reset", 450],
];
export function SceneVocab(_props: SceneProps) {
  const reduced = useReducedMotion(),
    ref = useRef<HTMLDivElement>(null);
  const i = useTimeline(ref, VOCAB_STEPS, reduced, true, 1),
    st = VOCAB_STEPS[i][0],
    fix = st === "fix";
  function W(a: string, b: string) {
    return (
      <span className={cx("wt-vw", fix && "wt-vw--fix")}>
        <span className="wt-vw-a">{a}</span>
        <span className="wt-vw-b">{b}</span>
      </span>
    );
  }
  return (
    <div ref={ref} className="wt-sc wt-sc-vocab">
      <SceneFit w={440} h={320}>
        <div className="wt-sc-card wt-sc-vocab-list">
          <div className="wt-sc-card-head">
            <span className="wt-sc-tag wt-sc-tag--on">
              <Ico d={ICON.book} size={13} />
              Din ordliste
            </span>
            <span className="wt-sc-card-meta">{VOCAB.length + " ord"}</span>
          </div>
          <div className="wt-sc-chips">
            {VOCAB.map((v, k) => (
              <span
                key={v}
                className={cx("wt-sc-chip", fix && k < 2 && "wt-sc-chip--hit")}
              >
                {v}
              </span>
            ))}
          </div>
        </div>
        <div className="wt-sc-card wt-sc-vocab-out">
          <p className="wt-sc-vocab-text">
            Send {W("kuh tre rapporten", "Q3-rapporten")} til{" "}
            {W("skov gård og ko", "Skovgaard & Co.")} i dag.
          </p>
        </div>
      </SceneFit>
    </div>
  );
}

/* Run 8, the release mode: the pill listens while you talk, and the sentence lands whole when you let go. */
const MIXED_STEPS: Steps = [
  ["talk", 2400],
  ["land", 4200],
  ["reset", 450],
];
const MIXED_HL = ["pushe", "fixet", "main", "standup", "deploy"];

function Landed(p: { text: string; on: boolean; highlight: string[] }) {
  const words = p.text.split(/\s+/).filter(Boolean);
  return (
    <p
      className={cx(
        "wt-transcript wt-sc-mixed-text",
        p.on && "wt-sc-mixed-text--in",
      )}
    >
      <span className="wt-sr">{words.join(" ")}</span>
      {words.map((w, i) => {
        const bare = w.replace(/[.,?!:;]/g, "").toLowerCase();
        return (
          <span key={i}>
            {i ? " " : null}
            <span
              aria-hidden
              className={cx(
                "wt-tw",
                p.on && "wt-tw--in",
                p.highlight.indexOf(bare) >= 0 && "wt-tw--hl",
              )}
            >
              {w}
            </span>
          </span>
        );
      })}
    </p>
  );
}

/* Dansk og engelsk i samme sætning. */
export function SceneMixed(props: SceneProps) {
  const reduced = useReducedMotion(),
    ref = useRef<HTMLDivElement>(null);
  const release = !!props.release;
  const i = useTimeline(ref, MIXED_STEPS, reduced || !release, true, 1),
    st = MIXED_STEPS[i][0];
  const secs = useSeconds(release && st === "talk", reduced, 2);
  const text =
    props.text || "Kan du lige pushe fixet til main inden vores standup?";
  return (
    <div
      ref={ref}
      className={cx("wt-sc wt-sc-mixed", release && "wt-sc-mixed--release")}
    >
      <SceneFit w={420} h={260}>
        <div className="wt-sc-card">
          <div className="wt-sc-card-head">
            <span className="wt-sc-tag wt-sc-tag--on">
              <Ico d={ICON.globe} size={13} />
              Dansk og engelsk
            </span>
            <span className="wt-sc-legend">
              <i />
              engelsk
            </span>
          </div>
          {release ? (
            <Landed text={text} on={st === "land"} highlight={MIXED_HL} />
          ) : (
            <Transcript
              className="wt-sc-mixed-text"
              highlight={MIXED_HL}
              loop={2600}
              speed={210}
            >
              {text}
            </Transcript>
          )}
          {release && st === "talk" ? (
            <div className="wt-sc-mixed-pill">
              <DictationPill
                state="listening"
                seconds={secs}
                palette={props.palette}
              />
            </div>
          ) : null}
        </div>
      </SceneFit>
    </div>
  );
}

function DevBox(p: { name: string; active: boolean; st: string }) {
  const on = p.st === "land";
  return (
    <div className={cx("wt-sc-dev", p.active && "wt-sc-dev--active")}>
      <div className="wt-sc-dev-screen">
        <div
          className={cx(
            "wt-sc-dev-note",
            on && p.active && "wt-sc-dev-note--in",
          )}
        >
          <AppIcon size={22} />
          <span>Tekst klar til at indsætte</span>
        </div>
      </div>
      <div className="wt-sc-dev-base" />
      <span className="wt-sc-dev-name">
        {p.name}
        {p.active ? <em> · i brug</em> : null}
      </span>
    </div>
  );
}

/* Til den computer du sidder ved: the active one gets the text, the other gets nothing. (The design system's version
   showed "Gemt i historikken" on the other computer, which is not what the app does: spec 12.1, review finding 6.) */
const DEV_STEPS: Steps = [
  ["idle", 900],
  ["send", 1000],
  ["land", 2600],
];
export function SceneDevices(_props: SceneProps) {
  const reduced = useReducedMotion(),
    ref = useRef<HTMLDivElement>(null);
  const i = useTimeline(ref, DEV_STEPS, reduced, true, 2),
    st = DEV_STEPS[i][0];
  const cyc = useRef(0),
    prev = useRef(st);
  if (prev.current !== st) {
    if (st === "send" && prev.current === "idle") cyc.current += 1;
    prev.current = st;
  }
  const leftActive = cyc.current % 2 === 0;
  return (
    <div
      ref={ref}
      className={cx("wt-sc wt-sc-devices", "wt-sc-devices--" + st)}
    >
      <SceneFit w={520} h={330}>
        <DevBox name="MacBook" active={leftActive} st={st} />
        <DevBox name="ThinkPad" active={!leftActive} st={st} />
        <div className="wt-sc-dev-phone">
          <PhoneFrame width={92} screen="dark" statusBar={false}>
            <div className="wt-sc-dev-phone-ui">
              <span
                className={cx(
                  "wt-sc-dev-dot",
                  st !== "land" && "wt-sc-dev-dot--on",
                )}
              />
            </div>
          </PhoneFrame>
        </div>
        <svg
          className="wt-sc-dev-lines"
          viewBox="0 0 520 330"
          width={520}
          height={330}
          aria-hidden
        >
          <path
            d="M236 236 C 200 200, 170 170, 140 140"
            className={cx(st === "send" && "on")}
          />
          <path
            d="M284 236 C 320 200, 350 170, 380 140"
            className={cx(st === "send" && "on")}
          />
        </svg>
      </SceneFit>
    </div>
  );
}

/* Kører på din computer: a calm settings panel where each line checks in. */
const LOCAL_ROWS = [
  ["Transskribering", "På denne computer"],
  ["Talemodel", "Edda, dansk"],
  ["Konto", "Ingen"],
  ["Lydfiler", "Gemmes ikke"],
];
const LOCAL_STEPS: Steps = [
  ["a", 700],
  ["b", 600],
  ["c", 600],
  ["d", 600],
  ["hold", 2600],
  ["reset", 400],
];
export function SceneLocal(_props: SceneProps) {
  const reduced = useReducedMotion(),
    ref = useRef<HTMLDivElement>(null);
  const i = useTimeline(ref, LOCAL_STEPS, reduced, true, 4);
  const shown = LOCAL_STEPS[i][0] === "reset" ? 0 : Math.min(4, i + 1);
  return (
    <div ref={ref} className="wt-sc wt-sc-local">
      <SceneFit w={440} h={320}>
        <div className="wt-sc-card">
          <div className="wt-sc-card-head">
            <span className="wt-sc-tag wt-sc-tag--on">
              <Ico d={ICON.chip} size={13} />
              Privatliv
            </span>
            <span className="wt-sc-card-meta">Indstillinger</span>
          </div>
          <div className="wt-sc-rows">
            {LOCAL_ROWS.map((r, k) => (
              <div
                key={k}
                className={cx("wt-sc-row", k < shown && "wt-sc-row--in")}
              >
                <span>{r[0]}</span>
                <b>{r[1]}</b>
                <span className="wt-sc-ok" aria-hidden>
                  <Ico d={ICON.check} size={12} w={2} />
                </span>
              </div>
            ))}
          </div>
        </div>
      </SceneFit>
    </div>
  );
}

export type ShowcaseScene =
  | "fn"
  | "telefon"
  | "notifikation"
  | "renskriv"
  | "ordliste"
  | "sprog"
  | "enheder"
  | "lokal";
const SCENES: Record<ShowcaseScene, (p: SceneProps) => JSX.Element> = {
  fn: SceneFn,
  telefon: ScenePhone,
  notifikation: SceneNotify,
  renskriv: SceneCleanup,
  ordliste: SceneVocab,
  sprog: SceneMixed,
  enheder: SceneDevices,
  lokal: SceneLocal,
};

export interface ShowcaseCardProps {
  /** The product animation. Without it, children are placed on the surface. */
  scene?: ShowcaseScene;
  surface?:
    | "liquid"
    | "strips"
    | "rows"
    | "bars"
    | "barfield"
    | "dots"
    | "gradient"
    | "motion"
    | "mesh"
    | "waves";
  palette?: Palette | "nat" | "auto";
  placement?: "center" | "bottom" | "right" | "phone";
  /** CSS aspect-ratio of the surface. Default '4 / 3'. */
  ratio?: string;
  theme?: "light" | "dark";
  title?: string;
  text?: string;
  /** Heading element for the title. Default 'h3'. */
  as?: keyof JSX.IntrinsicElements;
  sceneText?: string;
  /** Run 8: the scene's text lands whole on release, as the app pastes it (the "sprog" scene). Default false. */
  release?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** A box with a living brand surface and the product working on top of it, plus a title and a line of text under it.
    surface: liquid, strips, rows, bars, barfield, dots, gradient, motion, mesh or waves. scene: one of SCENES, or children. */
export function ShowcaseCard(props: ShowcaseCardProps) {
  const surface = props.surface || "liquid",
    place = props.placement || "center";
  const Scene = props.scene ? SCENES[props.scene] : undefined;
  const sceneEl = Scene ? (
    <Scene
      palette={props.palette as Palette}
      text={props.sceneText}
      release={props.release}
    />
  ) : (
    props.children
  );
  const inner = (
    <div className={cx("wt-show-scene", "wt-show-scene--" + place)}>
      {sceneEl}
    </div>
  );
  /* the palette is passed through as given; each surface falls back to its own default for names it does not know */
  const common = {
    className: "wt-show-surface",
    palette: props.palette as never,
  };
  let surf: ReactNode;
  if (surface === "strips")
    surf = <GlassStrips {...common}>{inner}</GlassStrips>;
  else if (surface === "rows")
    surf = (
      <GradientRows fade="none" ambient={0.55} {...common}>
        {inner}
      </GradientRows>
    );
  else if (surface === "bars")
    surf = (
      <GradientBars variant="glow" {...common}>
        {inner}
      </GradientBars>
    );
  else if (surface === "barfield")
    surf = (
      <BarField bars={28} mode="wave" intensity={0.4} {...common}>
        {inner}
      </BarField>
    );
  else if (surface === "dots")
    surf = (
      <DottedGlow mask="none" {...common}>
        {inner}
      </DottedGlow>
    );
  else if (surface === "mesh")
    surf = (
      <FluidMesh {...common} palette={(props.palette || "auto") as never}>
        {inner}
      </FluidMesh>
    );
  else if (surface === "waves")
    surf = <LightWaves {...common}>{inner}</LightWaves>;
  else if (surface === "gradient")
    surf = <GradientBackground {...common}>{inner}</GradientBackground>;
  else if (surface === "motion")
    surf = <GradientMotion {...common}>{inner}</GradientMotion>;
  else surf = <LiquidBackground {...common}>{inner}</LiquidBackground>;
  const Head = (props.as || "h3") as ElementType;
  return (
    <article
      className={cx("wt-show", props.className)}
      style={props.style}
      data-theme={
        props.theme === "dark"
          ? "dark"
          : props.theme === "light"
            ? "light"
            : undefined
      }
    >
      <div
        className="wt-show-stage"
        style={{ aspectRatio: props.ratio || "4 / 3" }}
      >
        {surf}
      </div>
      {props.title || props.text ? (
        <div className="wt-show-body">
          {props.title ? (
            <Head className="wt-show-title">{props.title}</Head>
          ) : null}
          {props.text ? <p className="wt-show-text">{props.text}</p> : null}
        </div>
      ) : null}
    </article>
  );
}
