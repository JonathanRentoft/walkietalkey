/* Optagelse, the main screen: pick a session and record it, sentence by sentence. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError } from "../api/client";
import { usePoll, useResource } from "../api/hooks";
import type {
  Pilot,
  Progress,
  RecordingOptions,
  StartBody,
} from "../api/types";
import { stopPlayback } from "../components/take";
import { Button, ErrorBox, Loading, PageHeader } from "../components/ui";
import { S } from "../strings";
import { MixPanel } from "./recording/MixPanel";
import { PilotPanel, ProgressPanel } from "./recording/Panels";
import { Picker } from "./recording/Picker";
import { RowList } from "./recording/Rows";
import { CurrentSentence, SessionHeader } from "./recording/Session";
import { useRecording } from "./recording/useRecording";

const R = S.recording;

export function RecordingScreen() {
  const rec = useRecording();
  const options = useResource<RecordingOptions>("/api/recording/options");
  const progress = usePoll<Progress>("/api/progress", 10_000);
  const pilot = useResource<Pilot>("/api/pilot");
  const [picking, setPicking] = useState(false);
  const state = rec.state;
  const hasSession = !!state?.pick;

  useEffect(() => () => stopPlayback(), []);

  const reloadOptions = options.reload;
  const reloadProgress = progress.reload;
  const reloadPilot = pilot.reload;
  // A new pick moves the numbers in the picker and the progress (not on the first state:
  // they were just fetched).
  const pickKey = state
    ? `${state.pick?.kind}:${state.pick?.id}:${state.pick?.exam}`
    : null;
  const lastPick = useRef<string | null>(null);
  useEffect(() => {
    if (pickKey === null) return;
    const first = lastPick.current === null;
    lastPick.current = pickKey;
    if (first) return;
    reloadOptions();
    reloadProgress();
    reloadPilot();
  }, [pickKey, reloadOptions, reloadProgress, reloadPilot]);

  const start = useCallback(
    async (body: StartBody): Promise<ApiError | null> => {
      const e = await rec.act("/api/recording/start", body);
      if (!e) setPicking(false);
      return e;
    },
    [rec],
  );

  return (
    <>
      <PageHeader title={R.title} intro={R.intro}>
        {hasSession && !picking && (
          <Button
            onClick={() => {
              reloadOptions();
              setPicking(true);
            }}
          >
            {R.pickAgain}
          </Button>
        )}
      </PageHeader>

      <ErrorBox error={rec.error} onRetry={rec.retry} />

      {!state ? (
        !rec.error && <Loading />
      ) : (
        <>
          {(!hasSession || picking) &&
            (options.data ? (
              <Picker
                options={options.data}
                progress={progress.data}
                current={state.pick}
                onStart={start}
                onClose={hasSession ? () => setPicking(false) : undefined}
              />
            ) : (
              <ErrorBox error={options.error} onRetry={options.reload} />
            ))}
          {hasSession && (
            <div className="session-stack">
              <SessionHeader state={state} act={rec.act} busy={rec.busy} />
              <CurrentSentence state={state} act={rec.act} busy={rec.busy} />
              <RowList state={state} act={rec.act} />
            </div>
          )}
        </>
      )}

      <ProgressPanel
        progress={progress.data}
        error={progress.data ? null : progress.error}
        onRetry={progress.reload}
      />
      <MixPanel
        reloadKey={state ? `${pickKey}:${state.active}:${!!state.pick}` : null}
        onDealt={() => {
          reloadOptions();
          reloadProgress();
        }}
      />
      <PilotPanel
        pilot={pilot.data}
        error={pilot.error}
        onRetry={pilot.reload}
        onChanged={pilot.reload}
      />
    </>
  );
}
