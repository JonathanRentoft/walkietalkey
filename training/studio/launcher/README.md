# WalkieTalkey Værksted (the launcher app)

A small macOS app that puts Værkstedet (`wt-train studio`, see `../API.md`) in the Dock, so the
owner opens it with one click and never needs the terminal.

## What it does

- On launch it reads `Contents/Resources/launch.json` (`{"uv": ..., "repo": ..., "bun": ...}`,
  absolute paths; `bun` may be null) and starts
  `<uv> run --project <repo>/training wt-train studio --parent-pid <its pid> --no-browser` in its
  own process group, in `<repo>`, with `PATH` set to the folders of uv and bun plus
  `/usr/bin:/bin:/usr/sbin:/sbin` and `WT_BUN` set when bun is known.
- When the server prints `Værkstedet: http://127.0.0.1:<port>/`, it opens that URL in the
  default browser. Clicking the Dock icon again, or "Åbn Værkstedet" (⌘O), opens it again.
- "Afslut WalkieTalkey Værksted" (⌘Q), and SIGTERM or SIGINT to the launcher, send SIGTERM to the
  server's process group, wait up to 8 s, then SIGKILL. The server also stops by itself when the
  launcher's pid is gone (`--parent-pid`), so a crashed launcher leaves nothing running.
- If the server stops by itself, an alert ("Værkstedet stoppede") shows the last lines of the log,
  with "Vis log" (shows it in Finder) and "Luk"; then the launcher quits. A clean exit after the
  ready line is not an error: another Værkstedet was already running (the server prints its
  address and leaves, and the launcher opens it), or the server was stopped from elsewhere; the
  launcher just quits.

The app runs the code of this checkout, so it keeps working when the code changes. Build it
again when uv or the checkout moves.

## Building it

```sh
uv run --project training wt-train studio --install-app [--dest <folder>]
```

`training/wt_train/studio/launcher.py` finds uv and bun, compiles `Launcher.swift` with
`xcrun swiftc -O` (no Xcode project; when the default SDK does not match the compiler, it tries
again with `/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk`), assembles
`WalkieTalkey Værksted.app` with `Info.plist`, the W icon (`src-tauri/icons/icon.icns`) and
`launch.json`, signs it ad hoc and swaps it into `--dest` (default `~/Applications`) in one step,
replacing an older copy. It writes nothing outside `--dest` and its temporary folder there.

Tests: `uv run --project training pytest tests/test_studio_launcher.py` (from `training/`). One of
them builds the real app and runs its binary with a fake uv; it needs `xcrun swiftc`.

## The log

`~/Library/Logs/WalkieTalkey Værksted/studio.log`: the server's output and the launcher's own
lines (`[launcher] ...`). The previous run's log is kept as `studio.previous.log`.

For tests, `WT_STUDIO_NO_BROWSER=1` opens no browser and `WT_STUDIO_LOG_DIR` puts the log
elsewhere.
