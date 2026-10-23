/* Devices and RelayDemo: PhoneFrame, LaptopFrame, Keycap, Notice, PhoneApp and the hero that is built from them. */
import {
  useRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
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
import { cx, fill, fmt, type Style } from "../lib/util";
import { DictationPill } from "./DictationPill";
import { Logo } from "./Logo";
import { GradientBars } from "./surfaces";

/* ------------------------------------------------------------- icons */

export function Ico(p: {
  d: string;
  size?: number | string;
  w?: number;
  fill?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      className={p.className}
      width={p.size || 16}
      height={p.size || 16}
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      style={p.style}
    >
      <path
        d={p.d}
        fill={p.fill ? "currentColor" : "none"}
        stroke={p.fill ? "none" : "currentColor"}
        strokeWidth={p.w || 1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
export const ICON = {
  mic: "M8 1.8a2.3 2.3 0 0 1 2.3 2.3v3.5a2.3 2.3 0 0 1-4.6 0V4.1A2.3 2.3 0 0 1 8 1.8ZM3.6 7.3a4.4 4.4 0 0 0 8.8 0M8 11.8v2.4",
  check: "M3.4 8.4 6.5 11.3 12.6 4.8",
  lock: "M4.6 7.2V5.3a3.4 3.4 0 0 1 6.8 0v1.9M3.6 7.2h8.8v6.3H3.6Z",
  laptop: "M3 4.2h10v6.6H3ZM1.6 12.6h12.8",
  phone: "M5 1.8h6v12.4H5ZM7.2 12.2h1.6",
  spark:
    "M8 2.2v3M8 10.8v3M2.2 8h3M10.8 8h3M4 4l1.9 1.9M10.1 10.1 12 12M12 4l-1.9 1.9M5.9 10.1 4 12",
  chip: "M5 5h6v6H5ZM6.5 2.5v2.5M9.5 2.5v2.5M6.5 11v2.5M9.5 11v2.5M2.5 6.5H5M2.5 9.5H5M11 6.5h2.5M11 9.5h2.5",
  book: "M3 2.6h7.6a1.8 1.8 0 0 1 1.8 1.8v9H4.6A1.6 1.6 0 0 1 3 11.8ZM3 11.8a1.6 1.6 0 0 1 1.6-1.6h7.8",
  globe:
    "M8 1.9a6.1 6.1 0 1 0 0 12.2A6.1 6.1 0 0 0 8 1.9ZM1.9 8h12.2M8 1.9c1.7 1.8 2.5 3.8 2.5 6.1S9.7 12.3 8 14.1C6.3 12.3 5.5 10.3 5.5 8S6.3 3.7 8 1.9Z",
  wand: "M2.6 13.4 10 6M9 3.2v1.6M12.8 7v1.6M11.6 4.4l1.1-1.1M13.6 3.2h-1.6",
} as const;

function StatusBar(p: { time?: string }) {
  return (
    <div className="wt-sbar" aria-hidden>
      <span className="wt-sbar-time">{p.time || "10.24"}</span>
      <span className="wt-sbar-icons">
        <svg viewBox="0 0 18 12" width="1.8em" height="1.2em">
          {[0, 1, 2, 3].map((i) => (
            <rect
              key={i}
              x={i * 4.6}
              y={9 - i * 2.6}
              width={3.2}
              height={3 + i * 2.6}
              rx={0.9}
              fill="currentColor"
            />
          ))}
        </svg>
        <svg viewBox="0 0 16 12" width="1.6em" height="1.2em">
          <path
            d="M8 10.6 9.6 9a2.3 2.3 0 0 0-3.2 0ZM3.7 6.7a6.1 6.1 0 0 1 8.6 0M1.3 4.3a9.5 9.5 0 0 1 13.4 0"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
          />
        </svg>
        <svg viewBox="0 0 26 12" width="2.5em" height="1.2em">
          <rect
            x={0.8}
            y={0.8}
            width={21.4}
            height={10.4}
            rx={3.2}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.2}
            opacity={0.45}
          />
          <rect
            x={2.6}
            y={2.6}
            width={15.4}
            height={6.8}
            rx={1.8}
            fill="currentColor"
          />
          <path
            d="M23.6 4.4v3.2"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            opacity={0.45}
          />
        </svg>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------ PhoneFrame */

export interface PhoneFrameProps {
  /** Width in px; everything inside scales with it. Default 300. */
  width?: number;
  /** 'dark' or 'light' screen. Default: follows the page theme. */
  screen?: "dark" | "light";
  /** Clock in the status bar. Default '10.24'. */
  time?: string;
  statusBar?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/** A modern phone in silver. Sizes are in em: the frame sets 1em to a tenth of 1/30 of its width,
    so everything inside scales with `width`. `screen="dark"` turns the screen dark. */
export function PhoneFrame(props: PhoneFrameProps) {
  const w = props.width || 300;
  return (
    <div
      className={cx("wt-phone", props.className)}
      style={Object.assign({ fontSize: w / 30 + "px" }, props.style)}
    >
      <span className="wt-phone-key wt-phone-key--a" aria-hidden />
      <span className="wt-phone-key wt-phone-key--b" aria-hidden />
      <span className="wt-phone-key wt-phone-key--c" aria-hidden />
      <div className="wt-phone-bezel">
        <div
          className="wt-phone-screen"
          data-theme={
            props.screen === "dark"
              ? "dark"
              : props.screen === "light"
                ? "light"
                : undefined
          }
        >
          <div className="wt-phone-content">{props.children}</div>
          {props.statusBar === false ? null : <StatusBar time={props.time} />}
          <span className="wt-phone-island" aria-hidden />
          <span className="wt-phone-home" aria-hidden />
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- LaptopFrame */

export interface LaptopFrameProps {
  /** Width in px. Default 760. */
  width?: number;
  /** 'light' (default), 'dark', or 'inherit' to follow the page. */
  screen?: "light" | "dark" | "inherit";
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function LaptopFrame(props: LaptopFrameProps) {
  const w = props.width || 760;
  return (
    <div
      className={cx("wt-laptop", props.className)}
      style={Object.assign({ fontSize: w / 76 + "px" }, props.style)}
    >
      <div className="wt-laptop-lid">
        <span className="wt-laptop-cam" aria-hidden />
        <div
          className="wt-laptop-screen"
          data-theme={
            props.screen === "dark"
              ? "dark"
              : props.screen === "inherit"
                ? undefined
                : "light"
          }
        >
          {props.children}
        </div>
      </div>
      <div className="wt-laptop-base" aria-hidden>
        <span className="wt-laptop-notch" />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- small parts */

/** The app icon: the mark in liquid metal on night. Without `size` it takes its size from CSS. */
export function AppIcon(p: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={cx("wt-appicon", p.className)}
      style={Object.assign(
        p.size
          ? { width: p.size, height: p.size, borderRadius: p.size * 0.24 }
          : {},
        p.style,
      )}
      aria-hidden
    >
      <Logo
        variant="mark"
        tone="gradient"
        size={24}
        decorative
        animated={false}
      />
    </span>
  );
}

export interface KeycapProps {
  pressed?: boolean;
  /** For ⌘ and Ctrl. */
  wide?: boolean;
  /** Height in px. Default inherits (4.4em). */
  size?: number;
  sub?: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Keycap(props: KeycapProps) {
  return (
    <kbd
      className={cx(
        "wt-keycap",
        props.pressed && "wt-keycap--down",
        props.wide && "wt-keycap--wide",
        props.className,
      )}
      style={Object.assign(
        props.size ? { fontSize: props.size / 4.4 + "px" } : {},
        props.style,
      )}
    >
      {props.sub ? <span className="wt-keycap-sub">{props.sub}</span> : null}
      <span className="wt-keycap-label">{props.children}</span>
    </kbd>
  );
}

export interface NoticeProps {
  /** Slid in. */
  show?: boolean;
  platform?: "mac" | "windows";
  /** Default 'Tekst klar til at indsætte'. */
  title?: string;
  /** The first words of the text. */
  preview?: string;
  /** Default 'nu'. */
  when?: string;
  pasteKey?: string;
  /** Extension: the app name in the notification. Default 'WalkieTalkey'. */
  app?: string;
  className?: string;
  style?: CSSProperties;
}

/** A system notification. `platform` picks the look: mac (top right, slides in from the right) or windows (bottom right). */
export function Notice(props: NoticeProps) {
  const win = props.platform === "windows";
  return (
    <div
      className={cx(
        "wt-notice",
        win && "wt-notice--win",
        props.show && "wt-notice--in",
        props.className,
      )}
      style={props.style}
      role="status"
    >
      <AppIcon size={36} className="wt-notice-icon" />
      <div className="wt-notice-text">
        <div className="wt-notice-top">
          <b>{props.app || "WalkieTalkey"}</b>
          <span>{props.when || "nu"}</span>
        </div>
        <div className="wt-notice-title">
          {props.title || "Tekst klar til at indsætte"}
        </div>
        {props.preview ? (
          <div className="wt-notice-preview">{props.preview}</div>
        ) : null}
      </div>
      <kbd className="wt-notice-kbd">
        {props.pasteKey || (win ? "Ctrl+V" : "⌘V")}
      </kbd>
    </div>
  );
}

/* ------------------------------------------------------------- PhoneApp */

/** The design system's four states (idle, rec, send, ready) plus the product's (spec 7.3, PHONE-20 to PHONE-26). */
export type PhoneAppState =
  | "idle"
  | "rec"
  | "cancel"
  | "send"
  | "ready"
  | "offline"
  | "failed"
  | "error"
  | "paused";

/** Every string the phone app shows. {computer} is the computer's name, {key} the paste key. */
export interface PhoneAppLabels {
  idle?: string;
  rec?: string;
  cancel?: string;
  send?: string;
  ready?: string;
  pasteHint?: string;
  offline?: string;
  failed?: string;
  retry?: string;
  error?: string;
  details?: string;
  paused?: string;
  lock?: string;
  brand?: string;
}

/* spec Appendix A, Phone */
export const PHONE_LABELS: Required<PhoneAppLabels> = {
  idle: "Hold for at tale",
  rec: "Slip for at sende",
  cancel: "Slip for at annullere",
  send: "Sender til {computer}",
  ready: "Klar på {computer}",
  pasteHint: "Tryk {key} for at indsætte",
  offline: "{computer} er ikke online. Optagelsen venter i 10 minutter.",
  failed: "Nåede ikke frem til {computer}.",
  retry: "Prøv igen",
  error: "Noget gik galt. Prøv igen.",
  details: "Detaljer",
  paused: "{computer} er sat på pause.",
  lock: "Krypteret fra telefon til computer",
  brand: "WalkieTalkey",
};

export interface PhoneAppProps {
  state?: PhoneAppState;
  /** Seconds recorded, shown in 'rec'. */
  seconds?: number;
  /** Name of the paired computer. Default 'MacBook'. */
  device?: string;
  /** Default ⌘V, or Ctrl+V when os is 'win'. */
  pasteKey?: string;
  /** Extension: the computer's platform from the pairing QR (`o`), which picks the paste key. */
  os?: "mac" | "win";
  palette?: Palette;
  /** Extension: every string, with {computer} and {key} placeholders. Defaults are the Appendix A strings. */
  labels?: PhoneAppLabels;
  /** Extension: makes the big button a real <button> (pointer handlers, aria attributes). Without it the button is a picture (role img). */
  buttonProps?: ButtonHTMLAttributes<HTMLButtonElement>;
  /** Extension: 'failed' shows "Prøv igen"; this is called when it is pressed (PHONE-24). */
  onRetry?: () => void;
  /** Extension: 'error' shows "Detaljer"; a link with detailsHref, otherwise a button calling onDetails (PHONE-25). */
  onDetails?: () => void;
  detailsHref?: string;
  /** Extension: makes the computer chip a button, to pick another computer (PHONE-41). */
  onDeviceClick?: () => void;
  /**
   * Extension: the microphone level while recording, 0 (silence) to 1 (loud), for example from
   * the RMS of each 200 ms block (PHONE-21). The meter's bars follow it, so silence shows a flat
   * meter; without it the bars move on their own. With reduced motion the level moves in a few
   * calm steps and the bars do not ease.
   */
  level?: number;
  className?: string;
  style?: CSSProperties;
}

const LONG = new Set<PhoneAppState>(["offline", "failed", "error", "paused"]);

/** The meter level as the CSS variable --wt-level: clamped, and in thirds with reduced motion. */
function meterLevel(level: number, reduced: boolean): string {
  const l = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return (reduced ? Math.round(l * 3) / 3 : l).toFixed(2);
}

/** The WalkieTalkey phone app: one big hold button. */
export function PhoneApp(props: PhoneAppProps) {
  const st = props.state || "idle",
    dev = props.device || "MacBook";
  const L = Object.assign({}, PHONE_LABELS, props.labels || {});
  const pasteKey = props.pasteKey || (props.os === "win" ? "Ctrl+V" : "⌘V");
  const vars = { computer: dev, key: pasteKey };
  const template = (L as unknown as Record<string, string>)[st] ?? L.idle;
  const label = fill(st in PHONE_LABELS ? template : L.idle, vars);
  const recording = st === "rec" || st === "cancel";
  const reduced = useReducedMotion();
  const level =
    props.level === undefined ? null : meterLevel(props.level, reduced);
  const face = (
    <>
      <span className="wt-app-ring" aria-hidden />
      <span className="wt-app-face">
        {st === "ready" ? (
          <Ico d={ICON.check} size="3.2em" w={2} />
        ) : (
          <Ico d={ICON.mic} size="3.6em" w={1.5} />
        )}
      </span>
    </>
  );
  let sub: ReactNode = st === "ready" ? fill(L.pasteHint, vars) : "";
  if (st === "failed")
    sub = (
      <button type="button" className="wt-app-action" onClick={props.onRetry}>
        {L.retry}
      </button>
    );
  else if (st === "error")
    sub = props.detailsHref ? (
      <a className="wt-app-action" href={props.detailsHref}>
        {L.details}
      </a>
    ) : (
      <button type="button" className="wt-app-action" onClick={props.onDetails}>
        {L.details}
      </button>
    );
  const devKids = (
    <>
      <i aria-hidden />
      {dev}
    </>
  );
  return (
    <div
      className={cx(
        "wt-app",
        "wt-app--" + st,
        st === "cancel" && "wt-app--rec",
        props.className,
      )}
      style={props.style}
    >
      <div className="wt-app-glow" aria-hidden />
      <div className="wt-app-head">
        <span className="wt-app-brand">
          <Logo variant="mark" tone="ink" size={15} decorative />
          {L.brand}
        </span>
        {props.onDeviceClick ? (
          <button
            type="button"
            className="wt-app-dev"
            onClick={props.onDeviceClick}
          >
            {devKids}
          </button>
        ) : (
          <span className="wt-app-dev">{devKids}</span>
        )}
      </div>
      <div className="wt-app-rec" aria-hidden={!recording}>
        <span className="wt-rec" />
        <span className="wt-app-time">{fmt(props.seconds || 0)}</span>
      </div>
      <div className="wt-app-btnwrap">
        <span className="wt-app-halo" aria-hidden />
        {props.buttonProps ? (
          <button
            type="button"
            aria-label={label}
            {...props.buttonProps}
            className={cx("wt-app-btn", props.buttonProps.className)}
          >
            {face}
          </button>
        ) : (
          <span className="wt-app-btn" role="img" aria-label={label}>
            {face}
          </span>
        )}
      </div>
      <div
        className={cx("wt-app-meter", level !== null && "wt-app-meter--level")}
        style={level !== null ? ({ "--wt-level": level } as Style) : undefined}
        aria-hidden
      >
        <GradientBars
          variant="meter"
          bars={17}
          height={26}
          active={recording}
          palette={props.palette}
        />
      </div>
      <div
        className={cx("wt-app-label", LONG.has(st) && "wt-app-label--long")}
        aria-live="polite"
      >
        {st === "send" ? (
          <span className="wt-wait" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : null}
        <span>{label}</span>
      </div>
      <div className="wt-app-sub">
        <span>{sub}</span>
      </div>
      <div className="wt-app-foot">
        <Ico d={ICON.lock} size="1.25em" w={1.5} />
        <span>{L.lock}</span>
      </div>
    </div>
  );
}

/* A home screen with invented apps and the WalkieTalkey icon in the second row. */
const HOME_TONES = [
  "platin",
  "sand",
  "perle",
  "rav",
  "mokka",
  "platin-dyb",
  "sand-dyb",
  "perle-dyb",
  "rav-dyb",
  "platin",
  "sand",
  "perle",
];
const HOME_NAMES = [
  "Noter",
  "Kort",
  "Fotos",
  "Vejr",
  "Ur",
  "",
  "Bøger",
  "Musik",
  "Filer",
  "Kalender",
  "Podcast",
  "Mail",
];
function HomeScreen() {
  const tiles: ReactNode[] = [];
  for (let i = 0; i < 12; i++) {
    if (i === 5) {
      tiles.push(
        <span key={i} className="wt-home-app wt-home-app--wt">
          <AppIcon />
          <small>WalkieTalkey</small>
        </span>,
      );
      continue;
    }
    const t = HOME_TONES[i],
      g = i % 4;
    tiles.push(
      <span key={i} className="wt-home-app">
        <span
          className="wt-home-icon"
          style={{
            background:
              "linear-gradient(160deg, var(--" +
              t +
              "), color-mix(in oklab, var(--" +
              t +
              ") 70%, var(--ink)))",
          }}
        >
          <span className={"wt-home-glyph wt-home-glyph--" + g} />
        </span>
        <small>{HOME_NAMES[i]}</small>
      </span>,
    );
  }
  return (
    <div className="wt-home">
      <div className="wt-home-grid">{tiles}</div>
      <div className="wt-home-dock">
        {[0, 1, 2, 3].map((k) => {
          const t = ["perle", "sand", "platin", "rav"][k];
          return (
            <span
              key={k}
              className="wt-home-icon"
              style={{
                background:
                  "linear-gradient(160deg, var(--" +
                  t +
                  "), color-mix(in oklab, var(--" +
                  t +
                  ") 70%, var(--ink)))",
              }}
            >
              <span
                className={"wt-home-glyph wt-home-glyph--" + ((k + 1) % 4)}
              />
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- Desktop scene */

function MenuBar(p: { platform?: string; live?: boolean }) {
  if (p.platform === "windows") return null;
  return (
    <div className="wt-mbar" aria-hidden>
      <span className="wt-mbar-left">
        <i className="wt-mbar-dot" />
        <b>Post</b>
        <span>Arkiv</span>
        <span>Rediger</span>
        <span>Vis</span>
      </span>
      <span className="wt-mbar-right">
        <span className={cx("wt-mbar-wt", p.live && "wt-mbar-wt--live")}>
          <Logo variant="mark" tone="ink" size={11} decorative />
        </span>
        <span>tor. 22. okt. 10.24</span>
      </span>
    </div>
  );
}

function Taskbar(p: { platform?: string; live?: boolean }) {
  if (p.platform !== "windows") return null;
  return (
    <div className="wt-tbar" aria-hidden>
      <span className="wt-tbar-apps">
        {[0, 1, 2, 3, 4].map((k) => (
          <i key={k} className={k === 2 ? "on" : undefined} />
        ))}
      </span>
      <span className="wt-tbar-right">
        <span className={cx("wt-mbar-wt", p.live && "wt-mbar-wt--live")}>
          <Logo variant="mark" tone="ink" size={11} decorative />
        </span>
        <span>10.24</span>
      </span>
    </div>
  );
}

/* A compose window. `text` is shown when `pasted`. */
function ComposeWindow(p: {
  platform?: string;
  className?: string;
  style?: CSSProperties;
  title?: string;
  to?: string;
  subject?: string;
  text?: string;
  pasted?: boolean;
}) {
  const win = p.platform === "windows";
  return (
    <div
      className={cx("wt-win", win && "wt-win--win", p.className)}
      style={p.style}
    >
      <div className="wt-win-bar">
        {win ? null : (
          <span className="wt-win-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="wt-win-title">{p.title || "Ny besked"}</span>
        {win ? (
          <span className="wt-win-ctl" aria-hidden>
            —<span>▢</span>✕
          </span>
        ) : null}
      </div>
      <div className="wt-win-field">
        <span>Til:</span>
        <b className="wt-win-chip">{p.to || "Mette Holm"}</b>
      </div>
      <div className="wt-win-field">
        <span>Emne:</span>
        <b>{p.subject || "Mødet i morgen"}</b>
      </div>
      <div className="wt-win-body">
        {p.pasted ? (
          <span className="wt-win-pasted" key="t">
            {p.text}
          </span>
        ) : null}
        <i className="wt-caret" aria-hidden />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- RelayDemo */

const RELAY_STEPS: Steps = [
  ["home", 1100],
  ["tap", 500],
  ["open", 900],
  ["idle", 700],
  ["press", 350],
  ["rec", 3400],
  ["send", 1000],
  ["ready", 1500],
  ["keys", 950],
  ["paste", 3300],
  ["reset", 700],
];
const RELAY_ARC = "M165 380 C 262 196, 520 84, 852 58";
const RELAY_TEXT =
  "Hej Mette. Jeg er ti minutter forsinket, så bare start uden mig. Jeg tager slides med.";

export interface RelayDemoProps {
  platform?: "mac" | "windows";
  /** Name of the computer. Default 'MacBook' (mac) or 'ThinkPad' (windows). */
  device?: string;
  /** What is said. */
  text?: string;
  /** false shows the finished state without motion. */
  autoplay?: boolean;
  phoneScreen?: "dark" | "light";
  palette?: Palette;
  /** Accessible description of the scene. */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/** The hero: you open the app on your phone, hold the button and talk; the computer gets the text and a
    notification, and ⌘V puts it in your message. Loops; with reduced motion it shows the finished state. */
export function RelayDemo(props: RelayDemoProps) {
  const reduced = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const scale = useFit(wrap, 1040);
  const i = useTimeline(
    wrap,
    RELAY_STEPS,
    reduced || props.autoplay === false,
    true,
    9,
  );
  const step = RELAY_STEPS[i][0];
  const at = (name: string) => {
    for (let k = 0; k < RELAY_STEPS.length; k++)
      if (RELAY_STEPS[k][0] === name) return k;
    return -1;
  };
  const past = (name: string) => i >= at(name) && step !== "reset";
  const win = props.platform === "windows";
  const dev = props.device || (win ? "ThinkPad" : "MacBook");
  const pasteKey = win ? "Ctrl+V" : "⌘V";
  const text = props.text || RELAY_TEXT;
  const secs = useSeconds(step === "rec", reduced, 3);
  const appState: PhoneAppState =
    step === "rec"
      ? "rec"
      : step === "send"
        ? "send"
        : past("ready")
          ? "ready"
          : "idle";
  const appOpen = past("open");
  const pill =
    step === "rec" ? "listening" : step === "send" ? "processing" : null;
  const lastPill = useRef<"listening" | "processing">("listening");
  if (pill) lastPill.current = pill;
  const finger =
    step === "home" || step === "tap"
      ? "icon"
      : step === "press" || step === "rec"
        ? "button"
        : null;
  return (
    <div
      ref={wrap}
      className={cx(
        "wt-relay",
        "wt-relay--" + step,
        reduced && "wt-relay--still",
        props.className,
      )}
      style={Object.assign({}, props.style)}
      role="img"
      aria-label={
        props.label ||
        "Du holder knappen i WalkieTalkey-appen på telefonen og taler. Teksten dukker op på computeren som en notifikation og sættes ind med " +
          pasteKey +
          "."
      }
    >
      <div
        className="wt-relay-stage"
        style={{
          transform: "scale(" + scale + ")",
          visibility: scale ? "visible" : "hidden",
        }}
        aria-hidden
      >
        <LaptopFrame width={760} className="wt-relay-laptop">
          <div className={cx("wt-desk", win && "wt-desk--win")}>
            <MenuBar
              platform={props.platform}
              live={step === "rec" || step === "send"}
            />
            <ComposeWindow
              platform={props.platform}
              text={text}
              pasted={past("paste")}
            />
            <Notice
              platform={props.platform}
              show={
                step === "ready" ||
                step === "keys" ||
                (reduced && step === "paste")
              }
              preview={text}
              pasteKey={pasteKey}
            />
            <div className={cx("wt-desk-pill", pill && "wt-desk-pill--in")}>
              <DictationPill
                state={pill || lastPill.current}
                seconds={secs}
                palette={props.palette}
              />
            </div>
            <div
              className={cx(
                "wt-desk-keys",
                step === "keys" && "wt-desk-keys--in",
              )}
            >
              <Keycap pressed={step === "keys"} wide={win} size={42}>
                {win ? "Ctrl" : "⌘"}
              </Keycap>
              <Keycap pressed={step === "keys"} size={42}>
                V
              </Keycap>
            </div>
            <Taskbar
              platform={props.platform}
              live={step === "rec" || step === "send"}
            />
          </div>
        </LaptopFrame>
        <svg
          className={cx(
            "wt-relay-beam",
            step === "send" && "wt-relay-beam--on",
          )}
          viewBox="0 0 1040 660"
          width={1040}
          height={660}
        >
          <path className="wt-relay-arc" d={RELAY_ARC} fill="none" />
        </svg>
        <span
          className={cx(
            "wt-relay-spark",
            step === "send" && "wt-relay-spark--on",
          )}
          style={{ offsetPath: "path('" + RELAY_ARC + "')" }}
        />
        <PhoneFrame
          width={250}
          className="wt-relay-phone"
          screen={props.phoneScreen || "dark"}
        >
          <HomeScreen />
          <div className={cx("wt-relay-app", appOpen && "wt-relay-app--open")}>
            <PhoneApp
              state={appState}
              seconds={secs}
              device={dev}
              pasteKey={pasteKey}
              palette={props.palette}
            />
          </div>
          <span
            className={cx(
              "wt-finger",
              finger && "wt-finger--" + finger,
              (step === "tap" || step === "press" || step === "rec") &&
                "wt-finger--down",
            )}
          />
        </PhoneFrame>
      </div>
    </div>
  );
}
