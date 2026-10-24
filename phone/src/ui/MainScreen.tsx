/**
 * The main screen (spec 7.3): the design system's PhoneApp, driven by the controller, with the
 * connection status as one quiet line at the very top instead of PhoneApp's chip (run 2, Phase 4).
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { LogoLoader, PhoneApp } from "@walkietalkey/ui";
import {
  COUNTDOWN_FROM_MS,
  MAX_RECORDING_MS,
  type ComputerView,
  type PhoneController,
  type Snapshot,
} from "../core/controller";
import { T, fill } from "../lib/strings";
import {
  countdownSeconds,
  offerPairAgain,
  splitName,
  statusLine,
  viewState,
} from "./viewState";

interface Props {
  controller: PhoneController;
  snap: Snapshot;
  onPicker: () => void;
  onDetails: () => void;
  /** Run 5: pair this computer again (a pairing whose computer may be gone). */
  onPairAgain: () => void;
}

/** Inside the button, with some slack: a finger that drifts a little does not cancel (PHONE-26). */
function inside(e: ReactPointerEvent<HTMLButtonElement>): boolean {
  const r = e.currentTarget.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  return Math.hypot(dx, dy) <= (r.width / 2) * 1.3;
}

/**
 * Which computer the text goes to and how it is connected: a small dot and a line of quiet text,
 * no pill, wrapping instead of cutting a long name off. Tapping it picks another computer or opens
 * the settings (PHONE-41).
 */
function StatusLine(props: {
  target: ComputerView;
  noConnection: boolean;
  onClick: () => void;
}) {
  const { kind, text } = statusLine(props.target, props.noConnection);
  const [before, after] = splitName(text);
  return (
    <button
      type="button"
      className={`wt-status wt-status--${kind}`}
      onClick={props.onClick}
      aria-haspopup="dialog"
      aria-description={T.statusPick}
    >
      <span className="wt-status-text">
        <i className="wt-status-dot" aria-hidden />
        {before}
        <span className="wt-status-name">{props.target.name}</span>
        {after}
        <svg
          className="wt-status-more"
          viewBox="0 0 16 16"
          aria-hidden
          focusable="false"
        >
          <path d="M4.5 6.5 8 10l3.5-3.5" />
        </svg>
      </span>
    </button>
  );
}

export function MainScreen({
  controller,
  snap,
  onPicker,
  onDetails,
  onPairAgain,
}: Props) {
  const target =
    snap.rooms.find((r) => r.roomId === snap.target) ?? snap.rooms[0];
  const m = snap.machine;
  const view = viewState(m, snap.noConnection);
  const pointer = useRef<number | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!view.recording) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [view.recording]);

  const elapsed = view.recording ? controller.recordedMs() : 0;
  const left = view.recording
    ? countdownSeconds(elapsed, MAX_RECORDING_MS, COUNTDOWN_FROM_MS)
    : null;
  const seconds = left !== null ? left : Math.floor(elapsed / 1000);

  /** The finger came up (pointerup), or the system took the touch away (pointercancel). */
  const end = (
    e: ReactPointerEvent<HTMLButtonElement>,
    interrupted: boolean,
  ) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    if (interrupted) {
      // Never a tap, so never hands-free by accident: it sends (PHONE-26).
      controller.interrupted();
      return;
    }
    controller.slide(inside(e));
    controller.up();
  };

  return (
    <main
      className={
        "wt-stage" +
        (target && !target.online ? " wt-stage--away" : "") +
        (view.sending ? " wt-stage--sending" : "") +
        (view.handsFree && view.labels.rec ? " wt-stage--handsfree" : "")
      }
      data-phase={m.phase}
    >
      {target ? (
        <StatusLine
          target={target}
          noConnection={snap.noConnection}
          onClick={onPicker}
        />
      ) : null}
      <div className="wt-stage-inner">
        <PhoneApp
          state={view.state}
          labels={view.labels}
          device={target?.name}
          os={target?.os}
          seconds={seconds}
          level={view.recording ? snap.level : undefined}
          onRetry={() => controller.retry()}
          onDetails={onDetails}
          onDeviceClick={onPicker}
          buttonProps={{
            className: "wt-hold",
            "aria-pressed": view.recording,
            onPointerDown: (e) => {
              if (e.pointerType === "mouse" && e.button !== 0) return;
              e.preventDefault();
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* synthetic pointer */
              }
              pointer.current = e.pointerId;
              controller.down();
            },
            onPointerMove: (e) => {
              if (pointer.current === e.pointerId) controller.slide(inside(e));
            },
            onPointerUp: (e) => end(e, false),
            onPointerCancel: (e) => end(e, true),
            onContextMenu: (e) => e.preventDefault(),
            onKeyDown: (e) => {
              if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                e.preventDefault();
                controller.down();
              }
            },
            onKeyUp: (e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                controller.up();
              }
            },
          }}
        />
        {view.sending ? (
          <div className="wt-stage-ekko" aria-hidden>
            <LogoLoader variant="ekko" tone="paper" size={64} />
          </div>
        ) : null}
        {view.handsFree ? (
          <div className="wt-stage-cancel">
            <button
              type="button"
              className="wt-app-action wt-stage-cancel-btn"
              onClick={() => controller.cancel()}
            >
              {T.cancel}
            </button>
          </div>
        ) : null}
        {target && offerPairAgain(m, target) ? (
          // Run 5: a pairing whose computer may never come back (core/stale.ts).
          <div className="wt-stage-repair">
            <p>{fill(T.repairHint, { computer: target.name })}</p>
            <button
              type="button"
              className="wt-app-action wt-stage-repair-btn"
              onClick={onPairAgain}
            >
              {T.pairAgain}
            </button>
          </div>
        ) : null}
        {left !== null ? (
          <div className="wt-stage-countdown" role="timer">
            <span>{fill(T.countdown, { seconds: String(left) })}</span>
          </div>
        ) : null}
      </div>
    </main>
  );
}
