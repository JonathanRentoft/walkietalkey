# Værkstedet: the page's API

Værkstedet (`wt-train studio`) is the training workbench as a small local app for the owner: a
Python server (`training/wt_train/studio/`, stdlib `ThreadingHTTPServer`, like the recorder) and a
React page (`training/studio/`, Vite, the design system's light theme). Everything stays on this
Mac: the server listens on 127.0.0.1 only and makes no outbound connections; the page loads
nothing from elsewhere.

This file is the contract between the two. JSON everywhere; times are ISO 8601 with offset;
durations in seconds; levels in dBFS; WER and CER as fractions (0.0632), never percent.

## Guards (as the recorder, `recorder/server.py`)

- Every request must name the server as its `Host` (`127.0.0.1:<port>` or `localhost:<port>`),
  else 403.
- Every page `POST` needs the header `X-WT-Studio: 1` and, when an `Origin` is sent, this
  server's origin, else 403. Bodies are JSON, at most 64 KiB.
- `/app/v1/*` is the WalkieTalkey app's API, exactly the recorder's (hello, next, takes,
  events), with the token of the current recording session (`Authorization: Bearer`); it
  refuses any request with an `Origin`. The page never sees the token.
- Errors: `{"error": "<code>", "message": "<English, for the log>"}` with a 4xx/5xx status. The
  page shows its own Danish text per code and falls back to a generic one. Codes every route can
  give: `forbidden` (403), `json` (400, not a JSON object), `too-long` (413), `not-found` (404),
  `internal` (500: something unexpected; `message` names the exception, the traceback is in the
  server's log, and the server goes on).
- CSP for the page: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src
'self'; media-src 'self'; img-src 'self' data:; font-src 'self'; frame-src 'self';
base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. Report pages
  (`/reports/...`) get their own CSP that lets their inline styles, inline script and `data:`
  audio run, `frame-ancestors 'self'`, and are shown in a sandboxed iframe.

## Files

| Path                                                                      | What                                                                                                                                |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /` and any path that is not `/api/`, `/app/`, `/reports/`, `/files/` | `index.html` of the built page (`training/studio/dist/`), so the page's own routes (`/optag`, `/data`, `/ord`, ..., `/laer`) reload |
| `GET /assets/<file>`                                                      | the built page's assets                                                                                                             |
| `GET /api/takes/<folder>/<id>.wav`                                        | the current take of a sentence; `<folder>` is a condition id, `exam-<condition>` (its exam paragraphs) or `pilot-<setup>`           |
| `GET /reports/<file>.html`                                                | an HTML report from `paths.reports_dir()` (evaluation, `--vs`, pilot)                                                               |
| `GET /files/journal/<path>`                                               | a file next to a journal page (its plots)                                                                                           |
| `GET /api/ping`                                                           | `{"studio": true, "pid": 4242}`: the single-instance check (and the launcher) asks the running server                               |

## Polling

The page polls `GET /api/recording/state` every 700 ms while the recording screen shows, and
`GET /api/jobs/<id>` every second while a job runs. Every state carries `version`, a number that
changes whenever anything in it changes; `?since=<version>` waits up to 20 s for a newer one
(long poll) and answers at once when it is already newer.

## Overview

`GET /api/overview`

```json
{
  "app": {
    "found": true,
    "path": "/Applications/WalkieTalkey.app/...",
    "version": "0.2.2",
    "batch": true,
    "connected": false
  },
  "work": "/Users/.../training/work",
  "recording": { "active": false, "paused": false, "label": null },
  "training": { "running": false, "config": null },
  "jobs": [/* running jobs, see Jobs */]
}
```

`app` is the binary `wt-train use` would switch (`--app-bin`, else the installed app first),
found once (it runs `--help`); `version` is its bundle's, else the connected app's, else `null`.

## Recording

### `GET /api/recording/options`

What the owner can pick to record. The real conditions come from `conditions.py` and the mix;
the pilot setups are the run 7 names (`iphone-whisper`, `iphone-normal`, `mac-normal`,
`mac-whisper`, `airpods-normal`, `studio`) plus any setup that already has takes.

```json
{
  "conditions": [
    {
      "id": "phone-whisper",
      "label": "Telefonen, hvisket",
      "device": "phone",
      "style": "whisper",
      "share": 40,
      "planned": 416,
      "done": 17,
      "redo": 2,
      "minutes": 3.4
    }
  ],
  "exam": { "paragraphs": 8 },
  "pilot": {
    "sentences": 12,
    "setups": [
      {
        "name": "iphone-whisper",
        "label": "iPhone, hvisket",
        "device": "phone",
        "style": "whisper",
        "done": 12,
        "total": 12,
        "suggested": true
      }
    ]
  }
}
```

A condition whose `share` is 0 is listed (so the owner sees it) but cannot be started; the page
says it needs a share in the mix.

### `POST /api/recording/start`

```json
{"kind": "condition", "id": "phone-whisper", "exam": false}
{"kind": "pilot", "id": "airpods-normal"}
```

Starts a session (replacing a running one) and hands it to the running app
(`app.handoff_training`), which switches the phone into recording mode for a phone session.
Answers the recording state. Errors: `unknown` (404, or 400 for a `kind` that is neither),
`no-share` (409), `bad-setup` (400). `{"kind": "exam", "id": "<condition>"}` is the same as
`"kind": "condition"` with `"exam": true`. The session replaced gets no `end`: its token is
refused at once, which ends it in the app (and the new handoff replaces it there anyway). The
new pick's takes are read before the running session ends: a pick that cannot open (an error)
leaves that session running.

### `POST /api/recording/pause`, `POST /api/recording/resume`, `POST /api/recording/stop`

Pause ends the app's session (the phone returns to normal at once, `training_end`); the rows,
takes and checks stay, and nothing can be recorded. Resume starts a new session for the same
pick and hands it to the app again; the queue resumes where it was. Stop is pause plus
forgetting the pick. All three answer the state. Resume without a pick: 409 `no-pick`. A paused
session takes no take (the app's upload is answered `saved: false`).

### `POST /api/recording/skip`

"Spring over": the current sentence is passed over in this round (it comes back when the queue
wraps round). The phone's own "Spring over" arrives through the app (below) and does the same.
Exactly: a skipped sentence is passed over while any other sentence is open; when only skipped
ones are left, the skips are forgotten and a new round starts. 409 `busy` while a take is
recording, 409 `no-pick` with nothing picked (the same for every action below).

### `POST /api/recording/go` `{"id": "s0042"}`

That sentence becomes the current one (the phone shows it), unless a take is recording (409
`busy`). 404 `unknown` for an id that is not in the pick.

### `POST /api/recording/redo` `{"id": "s0042"}`

"Tag om": the take is marked for a new take (`review.status = "redo"`, `by: "owner"`) and the
sentence becomes the current one at once. 404 `unknown` for an id without a take.

### `POST /api/recording/approve` `{"id": "s0042"}`

"Godkend alligevel": a take the check sent back is kept after all (`review.status =
"approved"`, `by: "owner"`), and leaves the queue.

### `POST /api/recording/mac/start`, `/mac/stop`, `/mac/cancel`

A take on the Mac's own input, for a Mac session (the recorder's `mac_start` / `mac_stop` /
`mac_cancel`). The page binds them to its record button and to the space bar (press to start,
press again to stop; Escape cancels). 409 `paused` while paused; `mac/start` answers 409
`mac-not-ready` when no take can start (not a Mac pick, the app has not said hello, or a take is
recording).

### `GET /api/recording/state[?since=<version>]`

```json
{
  "version": 42,
  "active": true,
  "paused": false,
  "pick": {
    "kind": "condition",
    "id": "phone-whisper",
    "label": "Telefonen, hvisket",
    "device": "phone",
    "style": "whisper",
    "exam": false
  },
  "link": { "status": "connected", "detail": "0.2.2" },
  "app": {
    "connected": true,
    "version": "0.2.2",
    "input": "MacBook Pro-mikrofon"
  },
  "phone": { "name": "Jonathans iPhone", "platform": "ios", "online": true },
  "microphone": { "name": "iPhone-mikrofon", "source": "phone" },
  "current": "s0043",
  "recording": {
    "prompt": "s0043",
    "source": "phone",
    "since": "2026-10-27T10:01:02+01:00"
  },
  "counts": {
    "total": 120,
    "waiting": 101,
    "recording": 1,
    "received": 1,
    "approved": 15,
    "redo": 2
  },
  "minutes": 3.4,
  "limits": {
    "quiet_dbfs": -50.0,
    "silent_dbfs": -62.0,
    "loud_dbfs": -25.0,
    "good_dbfs": [-45.0, -31.0]
  },
  "rows": [
    {
      "id": "s0042",
      "text": "Vi merger PR'en, når buildet er grønt.",
      "kind": "terms",
      "status": "approved",
      "skipped": false,
      "take": {
        "n": 1,
        "url": "/api/takes/phone-whisper/s0042.wav",
        "seconds": 3.1,
        "recorded_at": "2026-10-27T10:00:51+01:00",
        "microphone": "iPhone-mikrofon",
        "level_dbfs": -38.2,
        "peak_dbfs": -14.0,
        "noise_dbfs": -61.0,
        "snr_db": 22.8,
        "envelope": [-70.1, -52.3, -40.0],
        "problems": [{ "kind": "quiet", "detail": "-52 dBFS" }],
        "transcribing": false,
        "heard": "vi merger pr'en når buildet er grønt",
        "wer": 0.0,
        "diff": [
          { "op": "eq", "ref": "vi", "hyp": "vi" },
          { "op": "sub", "ref": "pr'en", "hyp": "pr" }
        ],
        "edda_error": null,
        "review": { "status": "approved", "by": "check" }
      }
    }
  ],
  "last": {
    "prompt": "s0042",
    "text": "...",
    "check": "ok",
    "saved": true,
    "problems": [],
    "seconds": 3.1,
    "replaced": false
  },
  "error": null
}
```

- `active`: a session runs; `paused`: a pick is there but its session ended. With nothing picked:
  `pick: null`, `rows: []`, `limits: null`, `current: null`, every count 0.
- `last`: what the session made of the latest take the app sent (`null` before one): its sentence,
  the recorder's check (`ok` or the first problem), whether it was kept. Its `problems` are the
  recorder's plain names (`["silent", "quiet"]`), not the rows' objects. A refused take (`silent`,
  `gaps`) shows only here, since its row does not change.
- `status`: `waiting` (no take yet, or skipped this round), `recording`, `received` (the take is
  in; its checks, including what Edda heard, are still running), `approved` (it passed every
  check, or the owner approved it) or `redo` (a check or the owner sent it back; it is in the
  queue again and comes up by itself).
- `problems[].kind`: `quiet`, `clipped`, `cut`, `silent`, `short`, `gaps`, `loud`, `noisy`,
  `mismatch` (Edda heard something else), `error`. The page names each in Danish. `detail` is a
  short English note with units, as `wt-train check` prints them: `"-52 dBFS"`, `"start and end"`,
  `"SNR 9 dB"`, `"0.3 s"`, `"WER 80 %"`, `"nothing heard"`, or `""`. `error`: the check itself
  failed (the file could not be read, when it came in or when a pick opened); then no review is
  written (an earlier one stays), so it is checked again after a restart.
- `envelope`: 48 numbers, the level (dBFS) of each 48th of the take, for a small level meter.
- `heard` is Edda's text as the app wrote it (case and punctuation as in a dictation); `wer` is
  over the normalised words, the reference re-spelled like the training data.
- `heard`, `wer` and `diff` are `null` until Edda has heard the take (base Edda through the
  app's headless batch, as `wt-train check` does, in a background worker that takes every
  waiting take in one batch); `diff` is the word alignment of the normalised reference and
  transcript (`align.py`). `edda_error` (English, for the log; `null` normally) says why Edda
  could not listen (no app with the batch interface, the model is missing, the batch failed):
  then the audio checks alone decide, and the page says Edda did not listen. The app is looked
  for again a minute later. `transcribing` is true while the take waits for its checks.
- Which problems send a take back (`redo`, by `check`): `quiet`, `clipped`, `cut`, `short`,
  `mismatch`. `silent` and `gaps` are refused by the recorder (not saved; the sentence stays the
  current one, as today). `loud` and `noisy` are shown as warnings only. A take with none of the
  sending-back problems is `approved` (by `check`) once Edda has heard it (or could not). (A
  `silent` take saved before these checks existed goes back too.) The verdict is written into the
  take's metadata as `review`: `{"status", "by", "problems", "heard", "wer", "edda_error", "audio":
{"level_dbfs", "peak_dbfs", "noise_dbfs", "snr_db"}, "envelope", "checked_at"}` (`decided_at` for
  the owner's), so a restart shows the same rows without measuring again; the check never
  overwrites the owner's verdict, it only adds its numbers.
- `limits` are the recorder's for the pick's style (`recorder/checks.py`) and `check.LOUD_DBFS`;
  `good_dbfs` is from 5 dB above `quiet_dbfs` to 6 dB below `loud_dbfs`: normal voice -30 to -12,
  whisper -45 to -31.
- `microphone`: what this session records with: the phone's microphone from its latest take
  (`null` name before the first), or for a Mac session the app's chosen input (`null` name: the
  Mac's default input).
- `link.status`: `waiting`, `connecting`, `connected`, `not_running` (WalkieTalkey is not open),
  `no_phone` (no paired phone), `gone` (the app said bye or went quiet), `error`. `detail` is
  English (the handoff's message, the app's version once connected, `manual` when the link was
  written to `--app-url-file`). What the app said (`connected`, `no_phone`, `gone`) is never
  overwritten by the handoff's own result, which only replaces `connecting`.
- The rows of an exam session are paragraphs (`kind: "exam"`).

### The phone's "Spring over" (PROTOCOL.md 8.4, PHONE-52)

The installed app forwards a phone take's start and cancel to the recorder as
`{"type": "recording", "prompt": P, "source": "phone"}` and `{"type": "cancelled", "prompt": P,
"source": "phone"}`. The phone skips by starting a training take whose prompt is `skip:` and the
current prompt (`skip:s0042`) and cancelling it at once, with no audio. The recorder (and so
Værkstedet) treats a cancelled phone take with that prefix as "Spring over" for that sentence
when it is the current one, and never as a take or as recording. No app change is needed.

## Progress and the pilot

### `GET /api/progress`

```json
{
  "mix": {
    "phone-whisper": 40,
    "phone-normal": 40,
    "mac-normal": 20,
    "mac-whisper": 0
  },
  "sentences": 1041,
  "minutes": 12.5,
  "conditions": [
    {
      "id": "phone-whisper",
      "label": "Telefonen, hvisket",
      "share": 40,
      "planned": 416,
      "done": 17,
      "redo": 2,
      "minutes": 3.4,
      "exam_done": 0,
      "exam_total": 8
    }
  ]
}
```

### `GET /api/pilot`

```json
{
  "sentences": 12,
  "setups": [
    {
      "name": "iphone-whisper",
      "label": "iPhone, hvisket",
      "device": "phone",
      "style": "whisper",
      "done": 12,
      "total": 12
    }
  ],
  "comparison": {
    "generated_at": "2026-10-27T11:00:00+01:00",
    "report": "/reports/pilot-20261027-110000.html",
    "model": "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
    "setups": [
      {
        "name": "iphone-whisper",
        "clips": 12,
        "wer": 0.081,
        "cer": 0.031,
        "terms": 0.66,
        "level_dbfs": -38.0,
        "peak_dbfs": -12.0,
        "noise_dbfs": -62.0,
        "snr_db": 24.0,
        "clipped": 0,
        "seconds": 3.2,
        "notes": ["..."]
      }
    ]
  },
  "job": null
}
```

`comparison` is `null` until it has run once. `POST /api/pilot/compare` starts
`wt-train pilot report --json-out <work>/studio/pilot-comparison.json` as a job (see Jobs; 409
`busy` while one runs) and answers the job; when it is done, `GET /api/pilot` has the new
comparison, and the job's `result` is the comparison too. `notes` are Danish (run 11; they are
on the pilot's HTML page too), from `pilot.setup_notes`. `job` is the latest pilot job since
the server started. The setups (here, in the options and in the comparison) also carry `label`,
the Danish name ("iPhone, hvisket"). In the comparison `terms` is the strict term accuracy,
`clipped` the clips with clipping, `seconds` the mean length of a clip, and `report` is `null`
when the page is outside `<work>/reports/` (or from before run 11, see Evaluation). A take
marked for a new take (`review.status` `redo`) is not scored, as the dataset builder leaves it
out; `left_out` lists them: `[{"id": "pilot-03.iphone-whisper", "reason": "marked for a new
take"}]`.

## The mix (run 12)

On the recording screen, under the progress: the share of each condition, what a new mix would
deal, and how long each condition takes to record.

### `GET /api/mix`

```json
{
  "mix": {
    "phone-whisper": 40,
    "phone-normal": 40,
    "mac-normal": 20,
    "mac-whisper": 0
  },
  "sentences": 1041,
  "conditions": [
    {
      "id": "phone-whisper",
      "label": "Telefonen, hvisket",
      "share": 40,
      "planned": 416,
      "done": 17,
      "left": 399,
      "pace": { "seconds": 7.6, "source": "takes", "gaps": 34 },
      "minutes": 50.5
    }
  ],
  "minutes": 128.3,
  "recording": false
}
```

- `done`: planned sentences with a current take that was not sent back; `left` = `planned` -
  `done`; `minutes` = `left` x `pace.seconds` / 60 (and their sum at the top).
- `pace`: the owner's own seconds per sentence in that condition, the median gap between two
  takes in a row of one session (`recorded_at` and `session` in the takes' `.json`, in the
  recordings and in the pilot's setups; the exam is left out), leaving out gaps over 60 s (a
  break); `source` `takes`. With fewer than 5 gaps the pilot's measured medians stand in, `source`
  `pilot`: phone-whisper 8 s, phone-normal 11 s, mac-normal 8 s, mac-whisper 5 s. `gaps` is how
  many gaps were found.
- `recording`: a pick is open (recording or paused); dealing again waits until it is stopped.

### `POST /api/mix/preview` `{"mix": {"phone-whisper": 30, "phone-normal": 40, "mac-normal": 20, "mac-whisper": 10}}`

What dealing that mix would do, written nowhere: `plan.ensure` runs on a copy of the plan and
its `mix.yaml` in a temporary folder. Answers the same shape as `GET /api/mix` for that mix, plus
`"changed"` (it differs from `mix.yaml`) and `"moved": {"total": 104, "pairs": [{"from":
"phone-whisper", "to": "mac-whisper", "n": 103}]}` (the sentences that change condition, most
first). A mix is every condition's whole percent from 0 to 100 (one left out is 0), adding up to
100; anything else is 400 `mix`.

### `POST /api/mix/deal` `{"mix": {...}}`

Deals again exactly as `wt-train plan --mix` does: `plan.ensure(sentences, plan, mix=...,
recorded=plan.takes_of(recordings, sentences))` writes `plan.csv` and `mix.yaml` (the server's
`--plan`; a sentence with a take keeps its condition, every other one is dealt again to fit the
mix within each split). Answers the new view with `moved` (what moved) and `changed: false`.
409 `recording` while a pick is open; 400 `mix`.

## Data

`GET /api/data?config=<config name>` (default: the first config in `training/configs/` by name)

```json
{
  "config": "first-frozen-encoder",
  "configs": ["first-frozen-encoder", "smoke", "top4-encoder"],
  "fractions": { "validation": 0.1, "test": 0.1 },
  "sentences": { "total": 1041, "plain": 600, "terms": 441, "recorded": 120 },
  "conditions": [
    {
      "id": "phone-whisper",
      "label": "Telefonen, hvisket",
      "takes": 60,
      "minutes": 3.4,
      "split": {
        "train": { "takes": 48, "minutes": 2.7 },
        "validation": { "takes": 6, "minutes": 0.3 },
        "test": { "takes": 6, "minutes": 0.4 }
      }
    }
  ],
  "skipped": [
    { "id": "s0007.phone-whisper", "reason": "marked for a new take" }
  ],
  "rehearsal": { "share": 0.3, "validation_share": 0.3 },
  "leakage": {
    "ran": true,
    "ok": true,
    "checks": [
      {
        "id": "splits",
        "label": "Træning, validering og test deler ingen sætninger",
        "ok": true,
        "overlap": 0
      },
      {
        "id": "fleurs-test",
        "label": "FLEURS-testen er ikke med i træningen",
        "ok": true,
        "overlap": 0
      },
      {
        "id": "exam",
        "label": "Eksamensafsnittene er ikke med",
        "ok": true,
        "overlap": 0
      },
      {
        "id": "pilot",
        "label": "Pilotens sætninger er ikke med",
        "ok": true,
        "overlap": 0
      }
    ],
    "message": null
  }
}
```

The splits follow `dataset.split_by_sentence` with the config's fractions and seed, on the
takes `dataset.load_recordings` would use (so a take marked for redo is left out). The leakage
check is `dataset.check_leakage` against the held-out sets; when one cannot be loaded (FLEURS not
downloaded) its check has `"ok": null` and a `detail`.

- The checks are `dataset.leakage_problems`, grouped by check; `overlap` is the number of
  problems found. `ok` overall: `false` when any check failed, else `null` when any is unknown,
  else `true`. `message`: the first problems (English), `null` when there are none.
- `ran` is `false` with no takes yet: every check is then `ok: null` with `detail`.
- When the server was started with other folders (`--recordings`, `--sentences`, `--spelling`:
  tests, the end-to-end run) they replace the config's `data` paths.
- Errors: `unknown` (404, no such config), `config` (400, it does not load), `no-configs` (404).
  The answer is cached until a config, the sentence list or a folder of takes changes; the first
  look hashes every take's audio and can take a few seconds.

## Dine egne ord (run 12)

The English words and phrases of the owner's own dictations that `spelling.yaml` does not cover
yet (`wt_train/ownwords.py`), from the WalkieTalkey app's history on this Mac.

- The history is `history.db` beside the app's models folder (on macOS `~/Library/Application
Support/WalkieTalkey/history.db`), `WT_APP_HISTORY_DB` or `--history-db`. It is opened
  read-only (SQLite `mode=ro`, else `immutable=1`), never written and never copied. Each
  dictation counts once, as its `post_processed_text` when there is one, else its
  `transcription_text`.
- No sentence from the history is shown, stored or logged: the answers carry the words and their
  counts only; a word travels in a POST body only, never in a URL or a query string; nothing is
  written but the owner's own two files in the git-ignored `training/data/local/` (`WT_LOCAL_DIR`):
  the ticked words, `own-words.yaml` (a comment, then `words: [Grafana, Terraform]`), and his
  sentences, `sentences.csv` (`id,text,kind`, ids `own-0001`, `own-0002`, ..., kind `terms`). The
  analysis is kept in memory until the history, the spelling, the sentence list or FLEURS change.

### `GET /api/ownwords`

```json
{
  "history": {
    "found": true,
    "readable": true,
    "path": "/Users/.../WalkieTalkey/history.db",
    "dictations": 812
  },
  "found": 11,
  "words": [
    {
      "word": "Grafana",
      "count": 14,
      "dictations": 9,
      "share": 0.0111,
      "phrase": false
    }
  ],
  "more": 0,
  "ticked": [
    {
      "word": "Sentry",
      "count": 7,
      "dictations": 6,
      "share": 0.0074,
      "phrase": false,
      "sentences": [{ "id": "own-0001", "text": "Sentry sender en mail, ..." }]
    }
  ],
  "files": {
    "words": "/Users/.../training/data/local/own-words.yaml",
    "sentences": "/Users/.../training/data/local/sentences.csv"
  }
}
```

- `words`: the words and phrases not ticked, most often said first (`count`: times said;
  `dictations`: in how many; `share`: that of all dictations); at most 300, `more` says how many
  more. A phrase (`phrase: true`) is two or three English-looking words next to each other, said
  at least twice. `found` counts every word and phrase found, the ticked ones too: `found: 0`
  means the history has no new words; `words: []` with `found > 0` means every word is ticked.
- `ticked`: the words of `own-words.yaml` in their order, with their counts (`null` when the
  history has them no more) and the owner's sentences that have the word in them.
- `history.found: false`: there is no history at `path` (the app has not been used on this Mac);
  `readable: false`: it is there but cannot be read (locked, broken).
- How a word is judged (the module's docstring has it whole): Danish when it, or its stem without
  a Danish ending, is in the vocabulary (the plain sentences of the sentence list, FLEURS da_dk's
  transcripts in the work folder, a built-in list), or has æ, ø or å; English-looking with a cue
  (c, q, w, x, z, th, sh, ee, oo ..., -ing, -tion, CamelCase, ALLCAPS of two to five letters, a
  dot inside, a digit, + or #, a capital where no sentence starts, a common developer word);
  Danish endings on an English stem fold into it (PR'en, Grafanaen with Grafana).

### `POST /api/ownwords/tick` `{"word": "Grafana", "ticked": true}`

Adds the word to `own-words.yaml` (`ticked: false` takes it out; case does not count). Answers
the view. 400 `word` (not a string of 1 to 64 characters, or `ticked` not a boolean); 409
`own-words` when the file is there but cannot be read (it is never overwritten then).

### `POST /api/ownwords/sentence` `{"word": "Grafana", "text": "Vi tjekker Grafana, før vi går hjem."}`

Appends a sentence of the owner's own to `sentences.csv` (spaces squeezed, the next `own-NNNN`
id, kind `terms`), checked like the public list: 400 `length` (not 4 to 20 words, or over 300
characters), 400 `dash` (an em or en dash), 400 `no-word` (the word is not in it), 409
`duplicate` (the same sentence, case and punctuation aside, is in `sentences.csv` or his own
list), 400 `text`; 409 `own-sentences` when his file has another header. Answers the view with
`"sentence": {"id": "own-0001", "text": "...", "kind": "terms"}`. Error messages never name the
word or the sentence.

## Training

### `GET /api/training/configs`

```json
[
  {
    "name": "first-frozen-encoder",
    "file": "configs/first-frozen-encoder.yaml",
    "essentials": [
      "training.learning_rate",
      "training.epochs",
      "lora.rank",
      "rehearsal.share"
    ],
    "settings": [
      {
        "key": "training.learning_rate",
        "section": "training",
        "value": 0.0002,
        "label": "Hvor store skridt modellen tager, når den lærer",
        "section_label": "Træning",
        "help": "Højere: modellen lærer hurtigere, men kan blive ustabil og glemme almindeligt dansk. Lavere: roligere, men den skal bruge flere epoker."
      }
    ]
  }
]
```

Every setting of the resolved config (`config.to_dict`), in the config's order, each with its
one-line Danish label (`studio/labels.py`, which has a label for every field in `config.py`) and
`section_label`, the Danish heading of its section (`"Træning"`; `null` for `name`, whose
`section` is `null`). A config that does not load is listed with `"error"` and no settings.

Run 11: `essentials` names, in order, the four settings a beginner touches first
(`labels.ESSENTIALS`); the page shows them first and every other setting under "Alle
indstillinger". Each of the four has `help`, one or two Danish sentences on what turning it up
or down does; every other setting has `"help": null`.

### `POST /api/training/start` `{"config": "first-frozen-encoder"}`

Starts `wt-train train configs/<name>.yaml --progress <file>` as a job of kind `train`, and
`caffeinate -i -w <pid>` beside it, so the Mac stays awake while it runs. One training at a
time (409 `busy`); 404 `unknown` for no such config. Answers the job. When the server was started
with another `--recordings`, the job gets `--recordings` too.

### `POST /api/training/stop`

Stops the running training (SIGINT, then SIGTERM after 15 s); the job ends `stopped`, and its
MLflow run `KILLED`. 409 `not-running` when none runs.

### `GET /api/training/state`

```json
{
  "job": {/* the training job, see Jobs, or null */},
  "progress": {
    "config": "first-frozen-encoder",
    "run": "first-frozen-encoder-20261027-120000",
    "phase": "train",
    "epoch": 2,
    "epochs": 5,
    "step": 31,
    "total_steps": 80,
    "train_loss": [
      [1, 1.92],
      [2, 1.85]
    ],
    "validation_loss": [
      [0, 1.7],
      [16, 1.41]
    ],
    "validation_wer": [
      [0, 0.21],
      [16, 0.17]
    ],
    "awake": true
  },
  "runs": [
    {
      "name": "first-frozen-encoder-20261026-...",
      "date": "...",
      "best_epoch": 3,
      "best_validation_wer": 0.12,
      "baseline_validation_wer": 0.2
    }
  ]
}
```

`progress` is `null` when nothing has run since the server started; then `runs` lists the
earlier training runs (`paths.runs_dir()`). Points are `[step, value]`; validation points sit at
the step their epoch ended (epoch 0, the base model, at step 0).

`phase`: `build` (the dataset), `cache` (the encoder cache), `train`, `validate`, `done`,
`failed`, `stopped`. `progress` also has `dir` (the run's folder), `steps_per_epoch`,
`best_epoch` and `best_validation_wer` (once done) and `message` (English, when failed). Each
of `runs` also says `finished` (it has `run.json`) and `adapter` (it kept one).

`wt-train train --progress <file>` appends JSON lines as it goes: `{"event": "phase", "phase":
"build"}`, `{"event": "run", "name": ..., "dir": ...}`, `{"event": "plan", "epochs": 5,
"steps_per_epoch": 16, "total_steps": 80}`, `{"event": "step", "step": 3, "epoch": 1, "loss":
1.9, "lr": 0.0001}`, `{"event": "epoch", "epoch": 1, "step": 16, "train_loss": 1.8,
"validation_loss": 1.4, "validation_wer": 0.17}`, `{"event": "done", "run": ..., "best_epoch":
3, "best_validation_wer": 0.12}`, or at the end `{"event": "failed", "message": "<English>"}` or
`{"event": "stopped"}` (SIGINT or SIGTERM; exit status 130).

## Evaluation

### `GET /api/eval/runs`

```json
[
  {
    "id": "<mlflow run id>",
    "name": "20261026-170753-gguf-walkietalkey-edda-v0-2-gguf-edda-v0-2-q8-0-gguf",
    "title": "Appen · FLEURS · 26. okt.",
    "normaliser": 2,
    "kind": "eval",
    "date": "2026-10-26T17:07:53+01:00",
    "dataset": "fleurs-da_dk-test",
    "model": "edda-v0.2 (app)",
    "backend": "gguf",
    "clips": 930,
    "wer": 0.0672,
    "wer_ci": [0.0626, 0.0718],
    "cer": 0.024,
    "change": "pipeline",
    "report": "/reports/....html"
  }
]
```

Newest first (by `date`). `report` is `null` when no page exists yet. `model` is a short name:
`edda-v0.2 (app)`, `<file> (app)`, `edda-v0.2@698f8d04b597 (Transformers)`, `<training run>
(LoRA)`. `kind` is `eval` or `baseline` (an imported `results.csv` row). Empty when tracking is
off.

Run 11:

- `name` is the MLflow run's name (the slug the command line takes); `title` is its readable
  Danish name, `<model> · <data>` (`labels.eval_title`): the model is "Edda, original" (backend
  `hf`, the base Edda), "Appen" (`gguf`, the shipped Edda Q8_0 through the app), "Edda
  finjusteret v<n>" (`gguf`, an exported version `edda-ft-<slug>-v<n>`), "Edda finjusteret
  (<config>)" (`lora`, a training run's adapter); the data is "FLEURS", "Dine optagelser" (a
  run's test split; "..., validering", "..., træning", "..., eksamen", and a condition in
  brackets). Two runs that would share a title get the day they were measured ("· 24. okt."),
  and the time too when they share the day ("· 25. okt. kl. 02.16").
- `normaliser` is the version of the WER normaliser that counted the run
  (`wt_train/normaliser.py`): the run's tag `wt.normaliser`, which every run tracked since run 11
  carries (with the normaliser files' hash as `wt.normaliser_sha`), else the day it was measured
  (before 26 October 2026: 1; from then: 2). `null` for a normaliser without a number (an edit
  not yet given one). The page groups the runs by it: run 8's fix on 26 October changed every
  number without changing the model, so only runs in one group compare.
- `date` is when the run was measured: an imported `results.csv` row's own `timestamp`, not when
  it was imported; else the run's start.

Run 12: `split` says what the run measured on: `test`, `validation` or `train` (a split of the
owner's takes), `fleurs`, `exam`, or `null`. The run's `summary.json` gives it when it has a
`split`; else the dataset's name does (`<run or build>:test`, `fleurs-da_dk-test`, `exam@<c>`).
The page marks a test result as test, and its comparison offers the validation results first.

### `GET /api/eval/measure`

```json
{
  "runs": [
    {
      "name": "first-frozen-encoder-20261026-2112",
      "title": "Edda finjusteret (first-frozen-encoder)",
      "date": "2026-10-26T21:12:00+01:00",
      "best_validation_wer": 0.12,
      "validation": true,
      "test": true
    }
  ],
  "configs": [
    { "name": "first-frozen-encoder", "validation": true, "test": true },
    { "name": "smoke", "validation": false, "test": false }
  ],
  "base": "Edda, original",
  "job": null
}
```

What can be measured: the training runs with an adapter (`validation`, `test`: the run kept that
split in `<run>/dataset/`), and for Edda the configs, each with whether its build
(`<work>/builds/<config>/`, `wt-train build`) has the split. `job` is the latest measurement
since the server started.

### `POST /api/eval/measure`

```json
{"backend": "lora", "run": "first-frozen-encoder-20261026-2112", "dataset": "validation", "fleurs": true}
{"backend": "hf", "build": "first-frozen-encoder", "dataset": "validation", "fleurs": false}
{"backend": "lora", "run": "...", "dataset": "test", "fleurs": true, "confirm": true}
```

Starts `wt-train eval --backend lora --run <run>` (a training run) or `--backend hf --build
<config>` (Edda), with `--dataset validation|test --spelling <spelling.yaml>` and `--no-fleurs`
when `fleurs` is `false`, as a job of kind `eval` (one at a time: 409 `busy`). Its title is
"Måling på valideringen: <model>" or "Måling på testsættet: <model>". Every such job gets
`WT_TEST_USE_SOURCE=studio`, so a use of the test set is logged as Værkstedet's. Its result
joins `GET /api/eval/runs` through MLflow, as every `wt-train eval` does. `dataset` is
`validation` by default; `test` needs `"confirm": true` (409 `confirm` otherwise: the page asks
first, saying the test set is for the final measurement and that every use is written down).
Errors: 400 `dataset`, 400 `backend`, 404 `unknown` (no such run with an adapter, a bad name),
409 `no-split` (the run kept no such split), 409 `no-build` (the config's build has no such
split; `wt-train build configs/<config>.yaml` makes it). `WT_STUDIO_EVAL` names a program run
instead of `wt-train eval` (the end-to-end run's stand-in).

### `GET /api/eval/testset`

```json
{
  "lock": {
    "created": "2026-10-28T21:04:00+01:00",
    "build": "first-frozen-encoder",
    "sentences": 104,
    "clips": 312,
    "sha256": "4f1c..."
  },
  "uses": [
    {
      "at": "2026-10-27T12:42:10+01:00",
      "runs": ["first-frozen-encoder-20261026-2112"],
      "backend": "lora",
      "build": null,
      "eval_run": "20261027-124210-lora-first-frozen-encoder-20261026-2112",
      "source": "cli"
    }
  ],
  "count": 1
}
```

`lock` is the frozen test set, `training/data/test-lock.json` (`--test-lock`), read as it is:
`sentences` and `clips` are counted when they are lists; `null` without a lock. `uses` is every
use of the test set, newest first, from `<work>/test-uses.jsonl` (one JSON object per line, which
`wt-train eval` appends: `at`, `runs`, `backend`, `build`, `eval_run`, `source` `cli` or
`studio`); a missing file is no use, and a line that is not a use is skipped.

### `POST /api/eval/report` `{"run": "<id>"}` and `POST /api/eval/compare` `{"a": "<id>", "b": "<id>"}`

Write the run's page (`wt-train report`, or `--vs`) without opening a browser, and answer `{"url":
"/reports/<file>.html"}`. Pages that exist are reused. The page opens it inside Værkstedet. Since
run 11 the pages (and the pilot's) are in Danish, with Danish numbers ("6,32 %"), titled by the
runs' readable names; a page from before (in English, without the `<meta name="generator"
content="wt-train page 2">` of today's pages) counts as missing: `report` is `null`, and asking
for it writes it again.
A page is written as a job of kind `report` that the request waits for; the answer then also
has `"job": "<id>"`. Errors: `tracking-off` (409), `unknown` (404), `no-folder` (404: an imported
baseline whose clips are not in an eval folder), `not-comparable` (409: B has no results for
A's dataset), `report-failed` (500).

## Lær det (run 11)

The learning notebooks (`training/notebooks/*.ipynb`, `--notebooks`), each opened in VS Code as
the owner's working copy in `<work>/notebooks/` (git-ignored), so the committed notebooks never
get his outputs or edits.

### `GET /api/learn`

```json
{
  "notebooks": [
    {
      "name": "01-lyden",
      "number": 1,
      "title": "Lyden",
      "summary": "Hør og se en optagelse, som Edda får den.",
      "minutes": 4,
      "copy": true,
      "ran": false,
      "saved": "2026-10-28T10:02:11+01:00"
    }
  ],
  "copies": "/Users/.../training/work/notebooks"
}
```

In number order. Read by the notebooks' contract (`training/tests/test_notebooks.py`): `title` is
the first markdown cell's heading after the "·" (`# 01 · Lyden`), else the whole heading, else
the file's name; `summary` and `minutes` are `metadata.wt` (`null` when missing); `number` is
`metadata.wt.number`, else the heading's, else the name's. A file that does not parse as a
notebook (not JSON, no `cells`) is left out, and so is a name that is not letters, digits, `-`
and `_`. `copy`: the working copy exists; `ran`: one of its code cells has outputs; `saved`: the
copy's last change (`null` without a copy). Empty (`"notebooks": []`) while the folder has none.

### `POST /api/learn/open` `{"name": "01-lyden"}`

Copies the notebook to `<work>/notebooks/<name>.ipynb` when that copy is missing (an existing copy
is never overwritten), then opens VS Code with the training folder as the workspace and the copy
as the file: `open -b com.microsoft.VSCode <training> <copy>` (by bundle id, wherever VS Code
lives), else `code <training> <copy>` with a `code` command on the `PATH`. `WT_OPEN` and `WT_CODE`
name other programs for them (`WT_CODE=""`: none; tests and the end-to-end run use stand-ins and
never open VS Code). `training/.vscode/settings.json` makes the workbench's `.venv` the
interpreter and the notebook's own folder its working folder. Answers `{"notebook": <as in the
list>, "created": true, "with": "open"}` (`with`: `open` or `code`). Errors: `unknown` (404, no
such notebook), `no-vscode` (409: neither way found VS Code; the copy is made all the same).

### `POST /api/learn/reset` `{"name": "01-lyden"}`

"Start forfra": the working copy becomes the original again. The copy it replaces is kept as
`<work>/notebooks/.replaced/<name>-<time>.ipynb`. Answers `{"notebook": ..., "kept": "<that
path>"}` (`kept` is `null` when there was no copy; then one is made). 404 `unknown`.

## Versions

### `GET /api/versions`

```json
{
  "app": { "found": true, "version": "0.2.2", "use": true },
  "in_app": "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
  "base": {
    "id": "walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf",
    "name": "Edda",
    "installed": true
  },
  "versions": [
    {
      "version": 2,
      "id": "edda-ft-first-v2",
      "name": "Edda finjusteret (forsøg 1)",
      "run": "first-frozen-encoder-...",
      "date": "...",
      "validation_wer": 0.12,
      "installed": true,
      "in_app": false
    }
  ],
  "exportable": [
    {
      "run": "first-frozen-encoder-...",
      "date": "...",
      "best_validation_wer": 0.12
    }
  ]
}
```

### `POST /api/versions/use` `{"version": 2}` or `{"version": "edda"}`

`wt-train use`: switches the running app (or saves the choice for its next start). Answers
`{"ok": true, "in_app": "<id>", "message": "..."}` (`message` English). Errors: `version` (400),
`use-failed` (409; the message says why: no such version, no app, the app too old, not
installed).

`in_app` is `selected_model` in the app's settings (`settings_store.json` beside its models
folder), else the registry alias `app`; `app.version` is the app bundle's `Info.plist`.

### `POST /api/versions/export` `{"run": "<training run name>"}`

Starts `wt-train export <run>` as a job of kind `export`. 404 `unknown` for a run without an
adapter; 409 `busy` while an export runs.

## Journal

### `GET /api/journal`

```json
{
  "pages": [
    {
      "name": "2026-10-27-first-frozen-encoder-...",
      "title": "...",
      "date": "2026-10-27",
      "run": "first-frozen-encoder-...",
      "notes": { "hypothesis": true, "learned": false }
    }
  ],
  "runs": [
    {
      "run": "first-frozen-encoder-...",
      "id": "<mlflow id>",
      "kind": "train",
      "date": "...",
      "page": null
    }
  ]
}
```

`runs` are the tracked runs a page can be written for (training runs first), with the page that
exists for each.

### `POST /api/journal` `{"run": "<run name or id>"}`

`wt-train card <run>`: writes the page with the numbers filled in; answers the page as below.
409 `exists` when it is there already; 404 `unknown` for no such run; 409 `tracking-off`.

### `GET /api/journal/<name>`

```json
{
  "name": "...",
  "title": "...",
  "markdown": "# ...",
  "hypothesis": "",
  "learned": "",
  "files": "/files/journal/<name>/"
}
```

`hypothesis` and `learned` are the text under `## Hypothesis` and `## What I learned`. `files` is the
page's own folder of plots; the Markdown's image links are relative to the journal folder (as
`wt-train card` writes them, `<name>/<plot>.png`), so the page resolves them against
`/files/journal/`.

### `POST /api/journal/<name>` `{"hypothesis": "...", "learned": "..."}`

Saves both into the Markdown file, replacing only what is under those two headings (each up to
the next `## ` heading); everything else in the file stays byte for byte. Answers the page.
Either may be left out. A missing heading is added at the end; text is saved as UTF-8 with `\n`
line ends. A line that starts with `## ` would start a section of its own, so it is saved as
`### ` (the text kept). 400 `text` for a value that is not a string, 404 `unknown` for no such
page.

A page is any `<name>.md` in the journal folder whose name has no `/` or `\`, does not start
with a dot and is at most 200 characters (the owner may name one himself, with spaces or æøå;
the page sends it percent-encoded); the path must resolve inside the journal folder.

## Jobs

Long work runs as a job: a child process of the server, its output kept (the last 400 lines).

`GET /api/jobs/<id>`

```json
{
  "id": "j3",
  "kind": "train",
  "title": "Træning: first-frozen-encoder",
  "status": "running",
  "started": "...",
  "ended": null,
  "exit": null,
  "log": ["..."],
  "result": null
}
```

`status`: `running`, `done`, `failed`, `stopped`. `POST /api/jobs/<id>/stop` stops one (SIGINT,
SIGTERM after 15 s, SIGKILL after 10 s more). A job runs in its own session, and the signals go
to its whole process group, so what it started (the app's batch, an export's tools) ends too;
a job is `done`/`failed`/`stopped` once its output is closed and it has exited. Kinds: `train`, `export`, `pilot`, `report`, `eval` (run 12). Jobs
end when the server stops (the launcher's quit stops the server, which stops its jobs). Ids are
`j1`, `j2`, ... from the server's start; `title` is Danish; `result` is the pilot comparison for
a `pilot` job, else `null`.

## Starting and stopping

`wt-train studio [--port N] [--no-browser]` builds the page when its sources changed
(`bun run --cwd training/studio build`), serves it on 127.0.0.1 (8780, or the next free port),
prints `Værkstedet: http://127.0.0.1:<port>/` and opens it in the browser. A second start while
one runs opens the running one and exits. `--parent-pid <pid>` (the launcher) stops the server
when that process is gone. SIGTERM and SIGINT stop it cleanly: the recording session ends (the
phone returns to normal), jobs are stopped, then it exits.

- SIGHUP stops it the same way. The way out takes at most about 10 s: every job gets SIGINT at
  once, SIGTERM 5 s later, SIGKILL 3 s after that, while the app gets up to 3 s to fetch the
  session's end; the launcher waits 20 s after its SIGTERM before it sends SIGKILL.
- One server per work folder: `<work>/studio/server.json` (`pid`, `url`); a second start whose
  server answers `/api/ping` with that pid prints the same `Værkstedet: <url>` line (a note goes
  to stderr), opens it unless `--no-browser`, and exits 0.
- A given `--port` must be free (exit 1 otherwise); without it, 8780 to 8799, the first free.
- `--no-build` serves `--dist` as it is. With no bun (`WT_BUN` or `PATH`) or a failed build, an
  earlier build is served with a warning; with none it exits 1.
- Every path is a flag, so tests and the end-to-end run use temporary folders: `--recordings`,
  `--pilot-dir`, `--sentences`, `--plan`, `--exam-file`, `--pilot-sentences`, `--spelling`,
  `--configs`, `--journal`, `--notebooks`, `--dist`, `--app-bin`, `--app-url-file` (the app's
  link with its token goes to that file instead of a handoff), and since run 12 `--history-db`
  (the app's history, also `WT_APP_HISTORY_DB`) and `--test-lock`. The work folder is
  `WT_WORK_DIR`; the owner's own words and sentences are in `WT_LOCAL_DIR` (default
  `training/data/local/`). `WT_OPEN` and `WT_CODE` replace the programs that open VS Code (see Lær
  det), `WT_STUDIO_EVAL` the one that measures (see Evaluation).

`wt-train studio --install-app` builds "WalkieTalkey Værksted.app" in `~/Applications` (see
`training/studio/launcher/`).
