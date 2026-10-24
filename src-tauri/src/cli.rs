use clap::Parser;
use std::path::PathBuf;

#[derive(Parser, Debug, Clone, Default)]
#[command(name = "walkietalkey", about = "WalkieTalkey - Danish speech to text")]
pub struct CliArgs {
    /// Start with the main window hidden
    #[arg(long)]
    pub start_hidden: bool,

    /// Disable the system tray icon
    #[arg(long)]
    pub no_tray: bool,

    /// Toggle transcription on/off (sent to running instance)
    #[arg(long)]
    pub toggle_transcription: bool,

    /// Toggle transcription with post-processing on/off (sent to running instance)
    #[arg(long)]
    pub toggle_post_process: bool,

    /// Cancel the current operation (sent to running instance)
    #[arg(long)]
    pub cancel: bool,

    /// Enable debug mode with verbose logging
    #[arg(long)]
    pub debug: bool,

    /// Transcribe this WAV (16 kHz mono) headlessly and exit. Runs the same
    /// batch transcription path as the app — no mic, no silence removal, no
    /// download (the model must already be installed). Long audio is still
    /// chunked at pauses, as in the app.
    #[arg(short = 'f', long, value_name = "WAV")]
    pub transcribe_file: Option<PathBuf>,

    /// WalkieTalkey (training workbench): transcribe every WAV listed in this
    /// file, one path per line (blank lines and `#` comments skipped, relative
    /// paths read from the list's folder), loading the model once. Same batch
    /// path as --transcribe-file; with --json, one JSON line per file.
    #[arg(long, value_name = "LIST", conflicts_with = "transcribe_file")]
    pub transcribe_list: Option<PathBuf>,

    /// Model id to load for --transcribe-file (default: the selected model).
    #[arg(long)]
    pub model: Option<String>,

    /// Hard-select the compute device for --transcribe-file by its registry
    /// index (see --list-devices). Omit to use the persisted accelerator
    /// setting. transcribe-cpp (whisper-family) models only.
    #[arg(long, value_name = "N")]
    pub device_index: Option<usize>,

    /// List the transcribe-cpp compute devices (with indices) and exit.
    #[arg(long)]
    pub list_devices: bool,

    /// List the available models (with ids) and exit. Pass an id to --model.
    /// Honors --json for machine-readable output.
    #[arg(long)]
    pub list_models: bool,

    /// Repeat the transcription N times (best_ms reports the fastest run).
    #[arg(long, value_name = "N")]
    pub repeat: Option<usize>,

    /// Emit --transcribe-file results as JSON.
    #[arg(long)]
    pub json: bool,

    /// WalkieTalkey bench (DESK-43, DESK-46): feed --transcribe-file through
    /// the live recording path in 200 ms pieces at real-time speed, as the
    /// microphone does, and report the wait from the end of the audio to the
    /// final text.
    #[arg(long)]
    pub live: bool,

    /// WalkieTalkey bench (run 5): pass each WAV of --transcribe-file or
    /// --transcribe-list through the recorder's own silence removal first,
    /// as a key recording is, then transcribe what it keeps. A phone
    /// dictation, like a plain file, keeps its silence.
    #[arg(long)]
    pub key_recording: bool,

    /// WalkieTalkey end-to-end test (DESK-61): receive phone dictations
    /// headlessly. Prints the pairing URL as a JSON line, then each
    /// transcript, and exits after --count dictations.
    #[arg(long)]
    pub phone_receive: bool,

    /// Relay for --phone-receive (default: the settings' relay).
    #[arg(long, value_name = "URL")]
    pub relay_url: Option<String>,

    /// Phone app URL for the pairing link (default: the settings').
    #[arg(long, value_name = "URL")]
    pub phone_app_url: Option<String>,

    /// Dictations to receive before exiting (--phone-receive).
    #[arg(long, value_name = "N")]
    pub count: Option<usize>,

    /// Give up after this many seconds (--phone-receive, default 300).
    #[arg(long, value_name = "SECONDS")]
    pub timeout_secs: Option<u64>,

    /// WalkieTalkey (training workbench): hand a `wt-train record` session to the
    /// running app, which connects to the recorder on 127.0.0.1 (sent to the
    /// running instance). Exits 3 when WalkieTalkey is not running.
    #[arg(long, value_name = "URL")]
    pub training_session: Option<String>,
}
