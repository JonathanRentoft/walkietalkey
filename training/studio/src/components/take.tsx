/* The parts of a received take: its status badge, the quality check as chips, the level meter,
   what Edda heard as a word diff, and the play button. */
import { memo, useSyncExternalStore } from "react";
import type { Limits, Problem, RowStatus, Take } from "../api/types";
import { diffCounts, diffTokens } from "../lib/diff";
import { db, dbfs, pct } from "../lib/format";
import {
  bandIsBad,
  envelopeHeights,
  levelBand,
  meterBands,
  meterPosition,
} from "../lib/level";
import { S } from "../strings";
import {
  IconCheck,
  IconCircle,
  IconClock,
  IconPlay,
  IconRedo,
  IconStop,
  IconWarn,
} from "./icons";

/* ------------------------------------------------------------- status */

export function StatusBadge({ status }: { status: RowStatus | string }) {
  const icon =
    status === "approved" ? (
      <IconCheck />
    ) : status === "redo" ? (
      <IconRedo />
    ) : status === "received" ? (
      <IconClock />
    ) : status === "recording" ? (
      <span className="rec-dot" aria-hidden="true" />
    ) : (
      <IconCircle />
    );
  return (
    <span className={`badge badge--${status}`}>
      {icon}
      {S.recording.status[status] ?? status}
    </span>
  );
}

/* ------------------------------------------------------------- checks */

/** Problems that send a take back (API.md); the rest are warnings. */
export const SENDS_BACK = new Set([
  "quiet",
  "clipped",
  "cut",
  "short",
  "mismatch",
  "silent",
  "gaps",
  "error",
]);

export function ProblemChips({ problems }: { problems: readonly Problem[] }) {
  if (!problems.length) return null;
  const sorted = [...problems].sort(
    (a, b) => Number(SENDS_BACK.has(b.kind)) - Number(SENDS_BACK.has(a.kind)),
  );
  return (
    <ul className="chips" aria-label={S.recording.checksLabel}>
      {sorted.map((p, i) => {
        const back = SENDS_BACK.has(p.kind);
        const name =
          S.recording.problems[p.kind] ?? S.recording.problemOther(p.kind);
        return (
          <li
            key={`${p.kind}-${i}`}
            className={`chip ${back ? "chip--back" : "chip--warn"}`}
            title={p.detail ?? undefined}
          >
            {back ? <IconRedo size={13} /> : <IconWarn size={13} />}
            <span className="sr">
              {back ? S.recording.sendsBack : S.recording.warning}:{" "}
            </span>
            {name}
          </li>
        );
      })}
    </ul>
  );
}

/* -------------------------------------------------------------- meter */

const ENV_W = 96;
const ENV_H = 22;

export function Envelope({ envelope }: { envelope: readonly number[] }) {
  const h = envelopeHeights(envelope);
  const n = Math.max(1, h.length);
  const bw = ENV_W / n;
  return (
    <svg
      className="envelope"
      width={ENV_W}
      height={ENV_H}
      viewBox={`0 0 ${ENV_W} ${ENV_H}`}
      role="img"
      aria-label={S.recording.meter.envelope}
    >
      {h.map((v, i) => {
        const bh = Math.max(1, v * ENV_H);
        return (
          <rect
            key={i}
            x={i * bw + 0.25}
            y={ENV_H - bh}
            width={Math.max(0.5, bw - 0.5)}
            height={bh}
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}

const METER_W = 168;

/** Where the level sits against the too-quiet, good and too-loud bands, with the peak and the noise. */
export function LevelMeter({
  take,
  limits,
}: {
  take: Take;
  limits: Limits | null;
}) {
  const level = take.level_dbfs;
  // The audio numbers come with the check; until then the take has none.
  if (level === null || !limits)
    return <span className="meter-pending">{S.recording.meter.pending}</span>;
  const band = levelBand(level, limits);
  const bandName = S.recording.meter.bands[band];
  const x = (v: number | null) => meterPosition(v ?? -100) * METER_W;
  return (
    <div className={`meter ${bandIsBad(band) ? "meter--bad" : ""}`}>
      {take.envelope && take.envelope.length > 0 && (
        <Envelope envelope={take.envelope} />
      )}
      <div className="meter-scale">
        <svg
          width={METER_W}
          height={16}
          viewBox={`0 0 ${METER_W} 16`}
          role="img"
          aria-label={S.recording.meter.aria(
            dbfs(take.level_dbfs),
            dbfs(take.peak_dbfs),
            dbfs(take.noise_dbfs),
            bandName,
          )}
        >
          {meterBands(limits).map((s) => (
            <rect
              key={s.band}
              className={`band band--${s.band}`}
              x={s.from * METER_W}
              y={5}
              width={Math.max(0, (s.to - s.from) * METER_W - 1)}
              height={6}
              rx={1}
            />
          ))}
          {take.noise_dbfs !== null && (
            <line
              className="meter-noise"
              x1={x(take.noise_dbfs)}
              x2={x(take.noise_dbfs)}
              y1={4}
              y2={12}
            />
          )}
          {take.peak_dbfs !== null && (
            <line
              className="meter-peak"
              x1={x(take.peak_dbfs)}
              x2={x(take.peak_dbfs)}
              y1={2}
              y2={14}
            />
          )}
          <path
            className="meter-level"
            d={`M${x(level) - 4},0 L${x(level) + 4},0 L${x(level)},6 Z`}
          />
          <line
            className="meter-level-line"
            x1={x(level)}
            x2={x(level)}
            y1={4}
            y2={16}
          />
        </svg>
        <span className="meter-verdict">
          {S.recording.meter.verdict(dbfs(level), bandName)}
          {take.snr_db !== null && (
            <span className="meter-snr">
              {" "}
              · {S.recording.meter.snr(db(take.snr_db))}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- diff */

export function WordDiff({ take }: { take: Take }) {
  const tokens = diffTokens(take.diff);
  const counts = diffCounts(tokens);
  return (
    <p className="heard">
      <span className="heard-label">{S.recording.heard}</span>{" "}
      <span className="words" lang="da">
        {tokens.map((t, i) => {
          if (t.kind === "eq")
            return (
              <span key={i} className="w">
                {t.ref}{" "}
              </span>
            );
          if (t.kind === "sub")
            return (
              <span key={i} className="w w-sub">
                <span className="sr">{S.recording.srSub(t.ref, t.hyp)}</span>
                <del aria-hidden="true">{t.ref}</del>
                <ins aria-hidden="true">{t.hyp}</ins>{" "}
              </span>
            );
          if (t.kind === "del")
            return (
              <span key={i} className="w w-del">
                <span className="sr">{S.recording.srDel(t.ref)}</span>
                <del aria-hidden="true">{t.ref}</del>{" "}
              </span>
            );
          return (
            <span key={i} className="w w-ins">
              <span className="sr">{S.recording.srIns(t.hyp)}</span>
              <ins aria-hidden="true">{t.hyp}</ins>{" "}
            </span>
          );
        })}
      </span>
      <span className="heard-wer">
        {counts.errors === 0
          ? S.recording.allRight
          : S.recording.wer(pct(take.wer ?? 0, 0))}
      </span>
    </p>
  );
}

export function DiffLegend() {
  return (
    <p className="diff-legend" aria-label={S.recording.diffLegend}>
      <span className="w">{S.recording.diff.eq}</span>
      <span className="w w-sub">
        <del>ord</del>
        <ins>{S.recording.diff.sub}</ins>
      </span>
      <span className="w w-del">
        <del>{S.recording.diff.del}</del>
      </span>
      <span className="w w-ins">
        <ins>{S.recording.diff.ins}</ins>
      </span>
    </p>
  );
}

/* ------------------------------------------------------------- player */

/** One <audio> for the whole page, so only one take plays at a time. */
const player = {
  audio: null as HTMLAudioElement | null,
  playing: null as string | null,
  listeners: new Set<() => void>(),
  emit() {
    player.listeners.forEach((l) => l());
  },
  el(): HTMLAudioElement {
    if (!player.audio) {
      const a = new Audio();
      a.preload = "none";
      a.addEventListener("ended", () => {
        player.playing = null;
        player.emit();
      });
      a.addEventListener("error", () => {
        player.playing = null;
        player.emit();
      });
      player.audio = a;
    }
    return player.audio;
  },
  toggle(src: string) {
    const a = player.el();
    if (player.playing === src) {
      a.pause();
      player.playing = null;
    } else {
      a.pause();
      a.src = src;
      player.playing = src;
      void a.play()?.catch(() => {
        player.playing = null;
        player.emit();
      });
    }
    player.emit();
  },
  stop() {
    player.audio?.pause();
    player.playing = null;
    player.emit();
  },
};

export const stopPlayback = () => player.stop();

function usePlaying(): string | null {
  return useSyncExternalStore(
    (cb) => {
      player.listeners.add(cb);
      return () => player.listeners.delete(cb);
    },
    () => player.playing,
    () => null,
  );
}

/** The take's URL, with its number so a new take is never the cached old one. */
export const takeSrc = (take: Take) =>
  `${take.url}${take.url.includes("?") ? "&" : "?"}n=${take.n ?? take.recorded_at ?? 0}`;

export const PlayButton = memo(function PlayButton({
  take,
  rowId,
}: {
  take: Take;
  rowId: string;
}) {
  const playing = usePlaying();
  const src = takeSrc(take);
  const on = playing === src;
  return (
    <button
      type="button"
      className={`btn btn--quiet btn--sm play ${on ? "on" : ""}`}
      aria-label={on ? S.recording.stopPlaying : S.recording.playLabel(rowId)}
      aria-pressed={on}
      onClick={() => player.toggle(src)}
    >
      {on ? <IconStop size={14} /> : <IconPlay size={14} />}
      {on ? S.recording.stopPlaying : S.recording.play}
    </button>
  );
});
