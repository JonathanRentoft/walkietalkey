/* The JSON shapes of training/studio/API.md, the contract with the Python server
   (training/wt_train/studio/). Times are ISO 8601 with offset, durations in seconds, levels in
   dBFS, WER and CER as fractions. Fields the contract leaves open are typed loosely and read
   defensively by the screens. */

export type Device = "phone" | "mac";
export type Style = "whisper" | "normal";

export type JobStatus = "running" | "done" | "failed" | "stopped";
export type JobKind = "train" | "export" | "pilot" | "report";

export interface Job {
  id: string;
  kind: JobKind | string;
  title: string;
  status: JobStatus;
  started: string | null;
  ended: string | null;
  exit: number | null;
  log: string[];
  result: unknown;
}

export interface Overview {
  app: {
    found: boolean;
    path?: string | null;
    version: string | null;
    batch?: boolean;
    connected?: boolean;
  };
  work: string;
  recording: { active: boolean; paused: boolean; label: string | null };
  training: { running: boolean; config: string | null };
  jobs: Job[];
}

/* ------------------------------------------------------------------ Recording */

export interface ConditionOption {
  id: string;
  label: string;
  device: Device;
  style: Style;
  share: number;
  planned: number;
  done: number;
  redo: number;
  minutes: number;
}

export interface PilotSetup {
  name: string;
  label: string;
  device: Device;
  style: Style;
  done: number;
  total: number;
  suggested?: boolean;
}

export interface RecordingOptions {
  conditions: ConditionOption[];
  exam: { paragraphs: number };
  pilot: { sentences: number; setups: PilotSetup[] };
}

export type StartBody =
  | { kind: "condition"; id: string; exam: boolean }
  | { kind: "pilot"; id: string };

export type RowStatus =
  "waiting" | "recording" | "received" | "approved" | "redo";

export type ProblemKind =
  | "quiet"
  | "clipped"
  | "cut"
  | "silent"
  | "short"
  | "gaps"
  | "loud"
  | "noisy"
  | "mismatch"
  | "error";

export interface Problem {
  kind: ProblemKind | string;
  detail?: string | null;
}

export type DiffOpKind = "eq" | "sub" | "del" | "ins";

export interface DiffOp {
  op: DiffOpKind;
  ref: string | null;
  hyp: string | null;
}

export interface Review {
  status: "approved" | "redo" | string;
  by: "check" | "owner" | string;
}

/** A take as a row shows it. The audio numbers and the envelope are null until measured. */
export interface Take {
  n: number | null;
  url: string;
  seconds: number;
  recorded_at: string | null;
  microphone: string | null;
  level_dbfs: number | null;
  peak_dbfs: number | null;
  noise_dbfs: number | null;
  snr_db: number | null;
  envelope: number[] | null;
  problems: Problem[];
  transcribing: boolean;
  heard: string | null;
  wer: number | null;
  diff: DiffOp[] | null;
  edda_error: string | null;
  review: Review | null;
}

export interface Row {
  id: string;
  text: string;
  kind: "plain" | "terms" | "exam" | string;
  status: RowStatus;
  skipped: boolean;
  take: Take | null;
}

export type LinkStatus =
  | "waiting"
  | "connecting"
  | "connected"
  | "not_running"
  | "no_phone"
  | "gone"
  | "error";

export interface Pick {
  kind: "condition" | "pilot";
  id: string;
  label: string;
  device: Device;
  style: Style;
  exam?: boolean;
}

export interface Limits {
  quiet_dbfs: number;
  silent_dbfs: number;
  loud_dbfs: number;
  good_dbfs: [number, number];
}

export interface Counts {
  total: number;
  waiting: number;
  recording: number;
  received: number;
  approved: number;
  redo: number;
}

/** What the session made of the latest take the app sent; a refused one shows only here. */
export interface LastTake {
  prompt: string;
  text: string;
  /** `ok` or the first problem (`silent`, `gaps`, `quiet`, ...). */
  check: string;
  saved: boolean;
  problems: string[];
  seconds: number;
  replaced: boolean;
}

export interface RecordingState {
  version: number;
  active: boolean;
  paused: boolean;
  pick: Pick | null;
  link: { status: LinkStatus | string; detail: string | null };
  app: { connected: boolean; version: string | null; input: string | null };
  phone: {
    name: string | null;
    platform: string | null;
    online: boolean;
  } | null;
  microphone: { name: string | null; source: Device } | null;
  current: string | null;
  recording: { prompt: string; source: Device; since: string } | null;
  counts: Counts;
  minutes: number;
  /** null with nothing picked. */
  limits: Limits | null;
  rows: Row[];
  last: LastTake | null;
  error: string | null;
}

/* ---------------------------------------------------------- Progress, pilot */

export interface ConditionProgress {
  id: string;
  label: string;
  share: number;
  planned: number;
  done: number;
  redo: number;
  minutes: number;
  exam_done: number;
  exam_total: number;
}

export interface Progress {
  mix: Record<string, number>;
  sentences: number;
  minutes: number;
  conditions: ConditionProgress[];
}

export interface PilotComparisonSetup {
  name: string;
  /** The Danish name ("iPhone, hvisket"). */
  label?: string;
  clips: number;
  wer: number | null;
  cer: number | null;
  terms: number | null;
  level_dbfs: number | null;
  peak_dbfs: number | null;
  noise_dbfs: number | null;
  snr_db: number | null;
  clipped: number | null;
  seconds: number | null;
  notes: string[];
}

export interface PilotComparison {
  generated_at: string;
  report: string | null;
  model: string | null;
  setups: PilotComparisonSetup[];
}

export interface Pilot {
  sentences: number;
  setups: PilotSetup[];
  comparison: PilotComparison | null;
  job: Job | null;
}

/* ----------------------------------------------------------------------- Data */

export interface SplitPart {
  takes: number;
  minutes: number;
}

export interface DataCondition {
  id: string;
  label: string;
  takes: number;
  minutes: number;
  split: { train: SplitPart; validation: SplitPart; test: SplitPart };
}

export interface LeakageCheck {
  id: "splits" | "fleurs-test" | "exam" | "pilot" | string;
  label: string;
  ok: boolean | null;
  overlap: number | null;
  detail?: string | null;
}

export interface DataView {
  config: string;
  configs: string[];
  fractions: { validation: number; test: number };
  sentences: { total: number; plain: number; terms: number; recorded: number };
  conditions: DataCondition[];
  skipped: { id: string; reason: string }[];
  rehearsal: { share: number; validation_share: number } | null;
  leakage: {
    ran: boolean;
    ok: boolean | null;
    checks: LeakageCheck[];
    message: string | null;
  };
}

/* ------------------------------------------------------------------- Training */

export interface ConfigSetting {
  key: string;
  /** null for `name`. */
  section: string | null;
  value: unknown;
  label: string;
  /** The Danish heading of its section; null for `name`. */
  section_label?: string | null;
  /** Run 11: for the four settings a beginner touches first, what turning it up or down does. */
  help?: string | null;
}

export interface TrainingConfig {
  name: string;
  file: string;
  settings: ConfigSetting[];
  /** Run 11: the keys of the four settings shown first, in order. */
  essentials?: string[];
  /** English: why the config does not load (then there are no settings). */
  error?: string;
}

export type Phase =
  "build" | "cache" | "train" | "validate" | "done" | "failed" | "stopped";

export type Point = [number, number];

export interface TrainingProgress {
  config: string;
  run: string | null;
  phase: Phase | string;
  epoch: number | null;
  epochs: number | null;
  step: number | null;
  total_steps: number | null;
  train_loss: Point[];
  validation_loss: Point[];
  validation_wer: Point[];
  awake: boolean;
  dir?: string | null;
  steps_per_epoch?: number | null;
  best_epoch?: number | null;
  best_validation_wer?: number | null;
  /** English, when failed. */
  message?: string | null;
}

export interface TrainingRun {
  name: string;
  date: string | null;
  best_epoch: number | null;
  best_validation_wer: number | null;
  baseline_validation_wer: number | null;
  /** It has run.json. */
  finished?: boolean;
  /** It kept an adapter (so it can be exported). */
  adapter?: boolean;
}

export interface TrainingState {
  job: Job | null;
  progress: TrainingProgress | null;
  runs: TrainingRun[];
}

/* ----------------------------------------------------------------- Evaluation */

export interface EvalRun {
  id: string;
  /** The MLflow run's name: the slug the command line takes. */
  name: string;
  /** Run 11: its readable Danish name, "Appen · FLEURS" (a day where two would share one). */
  title: string;
  /** Run 11: the WER normaliser's version that counted it; null for one without a number. */
  normaliser: number | null;
  kind: string;
  date: string | null;
  dataset: string | null;
  model: string | null;
  backend: string | null;
  clips: number | null;
  wer: number | null;
  wer_ci: [number, number] | null;
  cer: number | null;
  change: string | null;
  report: string | null;
}

/* ------------------------------------------------------------------- Versions */

export interface ModelVersion {
  version: number;
  id: string;
  name: string;
  run: string | null;
  date: string | null;
  validation_wer: number | null;
  installed: boolean;
  in_app: boolean;
}

export interface Versions {
  app: { found: boolean; version: string | null; use: boolean };
  in_app: string | null;
  base: { id: string; name: string; installed: boolean };
  versions: ModelVersion[];
  exportable: {
    run: string;
    date: string | null;
    best_validation_wer: number | null;
  }[];
}

/** POST /api/eval/report and /api/eval/compare: the page, and the report job that wrote it. */
export interface ReportAnswer {
  url: string;
  job?: string;
}

export interface Ping {
  studio: boolean;
  pid: number;
}

export interface UseAnswer {
  ok: boolean;
  in_app: string | null;
  message?: string | null;
}

/* -------------------------------------------------------------------- Journal */

export interface JournalPageSummary {
  name: string;
  title: string;
  date: string | null;
  run: string | null;
  notes: { hypothesis: boolean; learned: boolean };
}

export interface JournalRun {
  run: string;
  id: string | null;
  kind: string;
  date: string | null;
  page: string | null;
}

export interface Journal {
  pages: JournalPageSummary[];
  runs: JournalRun[];
}

export interface JournalPage {
  name: string;
  title: string;
  markdown: string;
  hypothesis: string;
  learned: string;
  files: string;
}

/* ------------------------------------------------------------------- Lær det */

export interface LearnNotebook {
  name: string;
  number: number | null;
  title: string;
  summary: string | null;
  minutes: number | null;
  /** The working copy in <work>/notebooks/ exists. */
  copy: boolean;
  /** A code cell of the copy has outputs. */
  ran: boolean;
  /** The copy's last change. */
  saved: string | null;
}

export interface LearnListing {
  notebooks: LearnNotebook[];
  /** Where the working copies are. */
  copies: string;
}

export interface LearnOpenAnswer {
  notebook: LearnNotebook;
  created: boolean;
  with: "open" | "code";
}

export interface LearnResetAnswer {
  notebook: LearnNotebook;
  kept: string | null;
}

export interface ApiErrorBody {
  error: string;
  message?: string;
}
