/* The running session: the pick, the link in plain Danish, the microphone, Pause / Fortsæt / Stop,
   the progress, and the current sentence in large text. A Mac session records with a big button
   and the space bar (press to start, press again to stop; Escape cancels). Run 12: the recorder
   keeps the Mac's input open a moment before the press and half a second after the stop; from
   the stop on the button says the take is being saved, and the keys wait for it. */
import { useEffect, useRef, useState } from "react";
import type { ApiError } from "../../api/client";
import type { RecordingState } from "../../api/types";
import {
  IconPause,
  IconPlay,
  IconSkip,
  IconStop,
  IconWarn,
} from "../../components/icons";
import { StatusBadge } from "../../components/take";
import { Button, Card } from "../../components/ui";
import { clock, int, minutes } from "../../lib/format";
import { errorText, S } from "../../strings";

const R = S.recording;

export type Act = (path: string, body?: unknown) => Promise<ApiError | null>;

/** The link status as one plain Danish sentence, and whether it is good news. */
export function linkText(state: RecordingState): {
  text: string;
  tone: "ok" | "wait" | "bad";
} {
  const L = R.link;
  if (!state.pick) return { text: L.stopped, tone: "wait" };
  if (state.paused)
    return {
      text: state.pick.device === "phone" ? L.paused : L.pausedMac,
      tone: "wait",
    };
  const phone = state.phone?.name || L.thePhone;
  switch (state.link.status) {
    case "connected":
      if (state.pick.device === "mac")
        return { text: L.connectedMac, tone: "ok" };
      if (state.phone && !state.phone.online)
        return { text: L.connectedPhoneOffline(phone), tone: "wait" };
      return { text: L.connectedPhone(phone), tone: "ok" };
    case "connecting":
      return { text: L.connecting, tone: "wait" };
    case "waiting":
      return { text: L.waiting, tone: "wait" };
    case "not_running":
      return { text: L.not_running, tone: "bad" };
    case "no_phone":
      return { text: L.no_phone, tone: "bad" };
    case "gone":
      return { text: L.gone, tone: "bad" };
    default:
      return { text: L.error, tone: "bad" };
  }
}

function micText(state: RecordingState): string {
  const m = state.microphone;
  if (m?.name) return R.mic(m.name);
  return (m?.source ?? state.pick?.device) === "mac"
    ? R.micMacDefault
    : R.micPhoneUnknown;
}

function useElapsed(since: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return 0;
  const t = Date.parse(since);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 1000) : 0;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

export function SessionHeader({
  state,
  act,
  busy,
}: {
  state: RecordingState;
  act: Act;
  busy: string | null;
}) {
  const [error, setError] = useState<ApiError | null>(null);
  const link = linkText(state);
  const pick = state.pick!;
  const c = state.counts;
  const run = async (path: string) => setError(await act(path));
  const kindLabel =
    pick.kind === "pilot"
      ? R.kind.pilot
      : pick.exam
        ? R.kind.exam
        : R.kind.condition;
  const done = c.total > 0 ? c.approved / c.total : 0;
  return (
    <Card className="session">
      <div className="session-top">
        <div className="session-title">
          <span className="tag tag--quiet">{kindLabel}</span>
          <h2>{pick.label}</h2>
        </div>
        <div className="session-controls">
          {state.paused ? (
            <Button
              variant="primary"
              onClick={() => run("/api/recording/resume")}
              disabled={busy !== null}
            >
              <IconPlay size={15} />
              {R.resume}
            </Button>
          ) : (
            <Button
              onClick={() => run("/api/recording/pause")}
              disabled={busy !== null || !state.active}
            >
              <IconPause size={15} />
              {R.pause}
            </Button>
          )}
          <Button
            onClick={() => run("/api/recording/stop")}
            disabled={busy !== null}
          >
            <IconStop size={15} />
            {R.stop}
          </Button>
        </div>
      </div>
      <p className={`link link--${link.tone}`} aria-live="polite" role="status">
        <span className="dot" aria-hidden="true" />
        {link.text}
      </p>
      <div className="session-meta">
        <span>{micText(state)}</span>
        <span className="session-progress-text">
          <strong>{R.progress(int(c.approved), int(c.total))}</strong>
        </span>
        <span>{R.recorded(minutes(state.minutes))}</span>
        {c.redo > 0 && <span>{R.redoCount(int(c.redo))}</span>}
        {c.received > 0 && <span>{R.receivedCount(int(c.received))}</span>}
      </div>
      <div
        className="progress"
        role="progressbar"
        aria-label={R.progress(int(c.approved), int(c.total))}
        aria-valuemin={0}
        aria-valuemax={c.total}
        aria-valuenow={c.approved}
      >
        <span style={{ width: `${done * 100}%` }} />
      </div>
      {state.error && (
        <p className="inline-error" role="alert">
          {R.serverError} <span className="error-detail">{state.error}</span>
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {errorText(error.code, "recording")}
        </p>
      )}
    </Card>
  );
}

export function CurrentSentence({
  state,
  act,
  busy,
}: {
  state: RecordingState;
  act: Act;
  busy: string | null;
}) {
  const [error, setError] = useState<ApiError | null>(null);
  const row = state.rows.find((r) => r.id === state.current) ?? null;
  const mac = state.pick?.device === "mac";
  const live = state.active && !state.paused;
  const recordingHere =
    state.recording && state.recording.prompt === state.current;
  const elapsed = useElapsed(state.recording?.since ?? null);
  const run = async (path: string) => setError(await act(path));

  // The space bar and Escape, for a Mac session.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!mac || !live) return;
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const s = stateRef.current;
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        // The take is being saved (the post-roll): a press waits for it.
        if (e.repeat || s.recording?.stopping) return;
        if (s.recording) void run("/api/recording/mac/stop");
        else if (s.current) void run("/api/recording/mac/start");
      } else if (e.key === "Escape" && s.recording && !s.recording.stopping) {
        e.preventDefault();
        void run("/api/recording/mac/cancel");
      }
    };
    // A focused button would also take the space bar on key up; the space bar is the record key here.
    const up = (e: KeyboardEvent) => {
      if ((e.code === "Space" || e.key === " ") && !isTyping(e.target))
        e.preventDefault();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [mac, live]);

  const exam = row?.kind === "exam";
  // A take the recorder refused (silent, gaps) shows only in `last`: its row does not change.
  const last = state.last;
  const refused =
    last && !last.saved && last.prompt === state.current && !state.recording
      ? (R.refused[last.check] ?? R.refusedOther)
      : null;
  return (
    <Card className={`current ${recordingHere ? "current--rec" : ""}`}>
      <div className="current-head" aria-live="polite">
        <span className="eyebrow">{exam ? R.nowExam : R.now}</span>
        {row && <span className="current-id">{row.id}</span>}
        {row && <StatusBadge status={row.status} />}
      </div>
      {row ? (
        <p
          className={`current-text ${exam ? "current-text--exam" : ""}`}
          lang="da"
        >
          {row.text}
        </p>
      ) : (
        <p className="current-text current-text--none">
          {state.counts.total > 0 ? R.allDone : R.noCurrent}
        </p>
      )}
      {refused && (
        <p className="refused" role="status">
          <IconWarn size={16} />
          {refused}
        </p>
      )}
      <div className="current-foot">
        {!live ? (
          <p className="hint">{R.pausedHint}</p>
        ) : mac ? (
          <div className="mac-rec">
            {state.recording?.stopping ? (
              <Button
                variant="danger"
                size="lg"
                className="rec-button on"
                disabled
              >
                <span className="loading-dot" aria-hidden="true" />
                {R.savingTake}
              </Button>
            ) : state.recording ? (
              <>
                <Button
                  variant="danger"
                  size="lg"
                  className="rec-button on"
                  onClick={() => run("/api/recording/mac/stop")}
                >
                  <span className="rec-dot" aria-hidden="true" />
                  {R.stopRecording}
                </Button>
                <span className="rec-time" aria-live="off">
                  {R.recordingNow} {clock(elapsed)}
                </span>
                <Button
                  variant="quiet"
                  onClick={() => run("/api/recording/mac/cancel")}
                >
                  {R.cancelRecording}
                </Button>
              </>
            ) : (
              <Button
                variant="primary"
                size="lg"
                className="rec-button"
                onClick={() => run("/api/recording/mac/start")}
                disabled={!row || busy === "/api/recording/mac/start"}
              >
                <span className="rec-dot" aria-hidden="true" />
                {R.record}
              </Button>
            )}
            <p className="hint">
              <kbd>{R.keySpace}</kbd> {R.macHintSpace} <kbd>{R.keyEsc}</kbd>{" "}
              {R.macHintEsc}
            </p>
          </div>
        ) : (
          <p className="hint">
            {state.recording ? (
              <span className="rec-inline">
                <span className="rec-dot" aria-hidden="true" />
                {R.recordingOnPhone} {clock(elapsed)}
              </span>
            ) : (
              R.phoneHint
            )}
          </p>
        )}
        <Button
          variant="quiet"
          onClick={() => run("/api/recording/skip")}
          disabled={!live || !row || !!state.recording || busy !== null}
        >
          <IconSkip size={15} />
          {R.skip}
        </Button>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {errorText(error.code, "recording")}
        </p>
      )}
    </Card>
  );
}
