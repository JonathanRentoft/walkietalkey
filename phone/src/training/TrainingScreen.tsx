/**
 * The training screen (the fine-tuning workbench, PRIV-05): the sentence the computer asks for in
 * large text, the progress and the voice to use, the last take's check, one row with "Tag om" and
 * "Spring over" (PHONE-50, PHONE-52), and the design system's PhoneApp below, scaled to the space
 * that is left, with the same button as a dictation (tap or hold, PHONE-26). It shows only while a
 * computer's training session runs.
 */
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { PhoneApp } from "@walkietalkey/ui";
import {
  COUNTDOWN_FROM_MS,
  MAX_RECORDING_MS,
  type PhoneController,
  type Snapshot,
} from "../core/controller";
import { T, fill } from "../lib/strings";
import { countdownSeconds, viewState } from "../ui/viewState";
import {
  canSkip,
  checkMessage,
  trainingItem,
  type TrainingView,
} from "./state";

interface Props {
  controller: PhoneController;
  snap: Snapshot;
  training: TrainingView;
  onDetails: () => void;
}

/** Inside the button, with some slack: a finger that drifts a little does not cancel (PHONE-26). */
function inside(e: ReactPointerEvent<HTMLButtonElement>): boolean {
  const r = e.currentTarget.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2);
  const dy = e.clientY - (r.top + r.height / 2);
  return Math.hypot(dx, dy) <= (r.width / 2) * 1.3;
}

/** A long text (an exam paragraph) gets a smaller size and scrolls. */
const LONG_TEXT = 220;

export function TrainingScreen({
  controller,
  snap,
  training,
  onDetails,
}: Props) {
  const m = snap.machine;
  const view = viewState(m, snap.noConnection);
  const pointer = useRef<number | null>(null);
  const [, tick] = useState(0);
  const item = trainingItem(training);
  const room = snap.rooms.find((r) => r.roomId === training.roomId);
  const busy = view.recording || m.phase === "send" || m.phase === "offline";
  const waiting = training.stale;
  const canRecord = !!item && !waiting;

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
    interrupted: boolean,
  ) => {
    if (pointer.current !== e.pointerId) return;
    pointer.current = null;
    if (interrupted) {
      controller.interrupted();
      return;
    }
    controller.slide(inside(e));
    controller.up();
  };

  // A take is saved, not pasted: no paste hint.
  const labels = {
    ...view.labels,
    ready: T.trainingSaved,
    pasteHint: "",
    ...(waiting && !view.recording
      ? { idle: fill(T.trainingWaiting, { computer: training.computer }) }
      : {}),
  };
  const last = training.last;
  const voice =
    training.style === "whisper" ? T.trainingWhisper : T.trainingNormal;

  return (
    <main
      className={
        "wt-training" +
        (view.sending ? " wt-stage--sending" : "") +
        (view.handsFree && view.labels.rec ? " wt-stage--handsfree" : "")
      }
      data-phase={m.phase}
    >
      <header className="wt-training-top">
        <span className="wt-training-title">
          {fill(T.trainingTitle, { computer: training.computer })}
        </span>
        <button
          type="button"
          className="wt-training-leave"
          onClick={() => controller.leaveTraining()}
          disabled={view.recording}
        >
          {T.trainingLeave}
        </button>
      </header>

      <section className="wt-training-card" aria-live="polite">
        <p className="wt-training-progress">
          <span className="wt-training-voice">{voice}</span>
          {" · "}
          {fill(T.trainingProgress, {
            done: training.done.toLocaleString("da-DK"),
            total: training.total.toLocaleString("da-DK"),
          })}
        </p>
        {training.redo ? (
          <p className="wt-training-note">{T.trainingRedoing}</p>
        ) : null}
        <p
          className={
            "wt-training-text" +
            (item && item.text.length > LONG_TEXT
              ? " wt-training-text--long"
              : "")
          }
          lang="da"
        >
          {item ? item.text : T.trainingComplete}
        </p>
        {last && !training.redo ? (
          <p
            className={
              "wt-training-check" +
              (last.check === "ok" ? "" : " wt-training-check--redo")
            }
          >
            {checkMessage(last.check)}
          </p>
        ) : null}
      </section>

      {/* Calm and thumb-sized, below the sentence; the hold button stays the main thing. */}
      <div className="wt-training-actions">
        <button
          type="button"
          className="wt-training-action wt-training-redo"
          disabled={!last || busy || waiting}
          onClick={() => controller.trainingRedo(!training.redo)}
        >
          {training.redo ? T.trainingBack : T.trainingRedo}
        </button>
        <button
          type="button"
          className="wt-training-action wt-training-skip"
          disabled={busy || !canSkip(training)}
          onClick={() => controller.trainingSkip()}
        >
          {T.trainingSkip}
        </button>
      </div>

      {/* The main screen's stage styles, scaled to the space below the sentence. */}
      <div className="wt-stage wt-training-stage">
        <div className="wt-stage-inner">
          <PhoneApp
            state={view.state}
            labels={labels}
            device={room?.name ?? training.computer}
            os={room?.os}
            seconds={seconds}
            level={view.recording ? snap.level : undefined}
            onRetry={() => controller.retry()}
            onDetails={onDetails}
            buttonProps={{
              className: "wt-hold",
              disabled: !canRecord && !view.recording,
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
                if (pointer.current === e.pointerId)
                  controller.slide(inside(e));
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
          {left !== null ? (
            <div className="wt-stage-countdown" role="timer">
              <span>{fill(T.countdown, { seconds: String(left) })}</span>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
