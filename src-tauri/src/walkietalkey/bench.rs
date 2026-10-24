//! The live bench (DESK-43, DESK-46): a WAV fed through the same live
//! recording path as the key, in 200 ms pieces at real-time speed, each piece
//! arriving when its 200 ms of audio has been "spoken", as the microphone and
//! the phone deliver them. The recording then finishes like a key release, and
//! the wait from the end of the audio to the final text is what the user waits.
//!
//! Also the batch runner behind `--transcribe-list` (run 4): the training
//! workbench scores a model through the app's own pipeline on hundreds of
//! clips, so the model is loaded once and each clip gets one JSON line.

use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::managers::transcription::TranscriptionManager;

/// 200 ms of 16 kHz audio, the microphone's and the phone's piece size.
pub const PIECE_SAMPLES: usize = 3_200;

/// When each piece is due: the end of its 200 ms of audio, from `start`.
pub fn piece_due(start: Instant, index: usize) -> Instant {
    start + Duration::from_millis(200 * (index as u64 + 1))
}

/// Feeds `samples` live at real-time speed and finishes the recording.
/// Returns the final text and the wait after the end of the audio.
pub fn transcribe_live(tm: &TranscriptionManager, samples: &[f32]) -> Result<(String, Duration)> {
    let router = tm.stream_router();
    tm.start_stream();
    let start = Instant::now();
    for (index, piece) in samples.chunks(PIECE_SAMPLES).enumerate() {
        thread::sleep(piece_due(start, index).saturating_duration_since(Instant::now()));
        router.feed(piece);
    }
    let released = Instant::now();
    let text = tm.transcribe_recording(samples.to_vec())?;
    Ok((text, released.elapsed()))
}

/// Reads a WAV for the headless paths. The app only ever saves 16 kHz mono
/// 16-bit PCM, so anything else is rejected rather than transcribed as
/// garbage, mis-timed or mis-decoded.
pub fn read_dictation_wav(path: &Path) -> std::result::Result<Vec<f32>, String> {
    let spec = hound::WavReader::open(path)
        .map_err(|e| format!("cannot open {}: {}", path.display(), e))?
        .spec();
    if spec.sample_rate != 16_000
        || spec.channels != 1
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        return Err(format!(
            "expected 16 kHz mono 16-bit PCM WAV, got {} Hz / {} ch / {}-bit {:?}",
            spec.sample_rate, spec.channels, spec.bits_per_sample, spec.sample_format
        ));
    }
    crate::audio_toolkit::read_wav_samples(path)
        .map_err(|e| format!("failed to read {}: {}", path.display(), e))
}

/// The WAVs named in a `--transcribe-list` file: one path per line, blank
/// lines and `#` comments skipped, relative paths read from `base` (the
/// list's own folder).
pub fn parse_wav_list(text: &str, base: &Path) -> Vec<PathBuf> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let path = Path::new(line);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                base.join(path)
            }
        })
        .collect()
}

/// One `--transcribe-list --json` line: the text and timing, or the error.
pub fn list_line(file: &Path, outcome: &std::result::Result<(String, f64, u64), String>) -> String {
    let value = match outcome {
        Ok((text, audio_secs, transcribe_ms)) => serde_json::json!({
            "file": file.display().to_string(),
            "text": text,
            "audio_secs": audio_secs,
            "transcribe_ms": transcribe_ms,
        }),
        Err(error) => serde_json::json!({
            "file": file.display().to_string(),
            "error": error,
        }),
    };
    value.to_string()
}

/// Transcribes every WAV in `files` with the app's batch path (chunking at
/// pauses, punctuation, Danish finishing), loading the model once. Prints one
/// line per file as it finishes: JSON with `json`, else `file<TAB>text`.
/// Returns the exit code: 0 when every file was transcribed, 1 otherwise.
pub fn transcribe_list(
    tm: &TranscriptionManager,
    model_id: &str,
    device_index: Option<usize>,
    files: &[PathBuf],
    json: bool,
) -> i32 {
    if let Err(e) = tm.load_model_with_device(model_id, device_index) {
        eprintln!("error: load_model('{}') failed: {}", model_id, e);
        return 1;
    }
    let mut failed = 0;
    for file in files {
        let outcome = read_dictation_wav(file).and_then(|samples| {
            // An "Immediately" unload timeout unloads after every run.
            if !tm.is_model_loaded() {
                tm.load_model_with_device(model_id, device_index)
                    .map_err(|e| format!("reload failed: {e}"))?;
            }
            let audio_secs = samples.len() as f64 / 16_000.0;
            let started = Instant::now();
            let text = tm.transcribe(samples).map_err(|e| e.to_string())?;
            Ok((text, audio_secs, started.elapsed().as_millis() as u64))
        });
        failed += usize::from(outcome.is_err());
        if json {
            println!("{}", list_line(file, &outcome));
        } else {
            match &outcome {
                Ok((text, ..)) => println!("{}\t{}", file.display(), text),
                Err(error) => println!("{}\terror: {}", file.display(), error),
            }
        }
    }
    i32::from(failed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wav_list_skips_blanks_and_comments_and_reads_relative_paths_from_its_folder() {
        let files = parse_wav_list(
            "# FLEURS da_dk test\n\nclips/a.wav\n  /abs/b.wav  \n#clips/c.wav\n",
            Path::new("/work/lists"),
        );
        assert_eq!(
            files,
            vec![
                PathBuf::from("/work/lists/clips/a.wav"),
                PathBuf::from("/abs/b.wav")
            ]
        );
    }

    #[test]
    fn list_lines_carry_the_text_or_the_error() {
        let ok: serde_json::Value = serde_json::from_str(&list_line(
            Path::new("/c/a.wav"),
            &Ok(("Hej med dig.".into(), 1.5, 320)),
        ))
        .unwrap();
        assert_eq!(ok["file"], "/c/a.wav");
        assert_eq!(ok["text"], "Hej med dig.");
        assert_eq!(ok["audio_secs"], 1.5);
        assert_eq!(ok["transcribe_ms"], 320);
        assert!(ok.get("error").is_none());

        let failed: serde_json::Value =
            serde_json::from_str(&list_line(Path::new("b.wav"), &Err("cannot open".into())))
                .unwrap();
        assert_eq!(failed["error"], "cannot open");
        assert!(failed.get("text").is_none());
    }

    #[test]
    fn only_16_khz_mono_16_bit_wavs_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let write = |name: &str, rate: u32, channels: u16| {
            let path = dir.path().join(name);
            let spec = hound::WavSpec {
                channels,
                sample_rate: rate,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut w = hound::WavWriter::create(&path, spec).unwrap();
            for _ in 0..1_600 * u32::from(channels) {
                w.write_sample(1_000i16).unwrap();
            }
            w.finalize().unwrap();
            path
        };
        assert_eq!(
            read_dictation_wav(&write("ok.wav", 16_000, 1))
                .unwrap()
                .len(),
            1_600
        );
        assert!(read_dictation_wav(&write("44k.wav", 44_100, 1))
            .unwrap_err()
            .contains("44100 Hz"));
        assert!(read_dictation_wav(&write("stereo.wav", 16_000, 2))
            .unwrap_err()
            .contains("2 ch"));
        assert!(read_dictation_wav(&dir.path().join("missing.wav"))
            .unwrap_err()
            .contains("cannot open"));
    }

    #[test]
    fn pieces_arrive_when_their_audio_has_been_spoken() {
        let start = Instant::now();
        assert_eq!(piece_due(start, 0) - start, Duration::from_millis(200));
        assert_eq!(piece_due(start, 74) - start, Duration::from_secs(15));
        assert_eq!(PIECE_SAMPLES, 16_000 / 5);
    }
}
