/** The main screen (spec 7.3): exactly the design system's PhoneApp, driven by the controller. */
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
  type PhoneController,
  type Snapshot,
} from "../core/controller";
import { T, fill } from "../lib/strings";
import { countdownSeconds, viewState } from "./viewState";

interface Props {
  controller: PhoneController;
  snap: Snapshot;
  onPicker: () => void;
  onDetails: () => void;
}

/** Inside the button, with some slack: a finger that drifts a little does not cancel (PHONE-26). */
function inside(e: ReactPointerEvent<HTMLButtonElement>): boolean {
  const r = e.currentTarget.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  return Math.hypot(dx, dy) <= (r.width / 2) * 1.3;
}

export function MainScreen({ controller, snap, onPicker, onDetails }: Props) {
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

  const end = (
    e: ReactPointerEvent<HTMLButtonElement>,
    checkInside: boolean,
  ) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    if (checkInside) controller.slide(inside(e));
    controller.up();
  };

  return (
    <main
      className={
        "wt-stage" +
        (target && !target.online ? " wt-stage--away" : "") +
        (view.sending ? " wt-stage--sending" : "")
      }
      data-phase={m.phase}
    >
      <div className="wt-stage-inner">
        <PhoneApp
          state={view.state}
          labels={view.labels}
          device={target?.name}
          os={target?.os}
          seconds={seconds}
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
            onPointerUp: (e) => end(e, true),
            onPointerCancel: (e) => end(e, false),
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
        {view.latched ? (
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
        {left !== null ? (
          <div className="wt-stage-countdown" role="timer">
            <span>{fill(T.countdown, { seconds: String(left) })}</span>
          </div>
        ) : null}
      </div>
    </main>
  );
}
