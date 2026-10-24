//! wt-speed: wall time of one transcription with a warm model, through the
//! transcribe-cpp crate the app links, with the app's run options.
//!
//!   wt-speed --model edda-v0.2-Q8_0.gguf --backend metal [--timestamps none]
//!            [--language da] [--warmup 1] [--iters 5] clip.wav ...
//!
//! The model is loaded once. Each clip gets `warmup` untimed runs, then
//! `iters` timed runs of `Session::run` (wall clock around the call: mel,
//! encoder, decoder and everything else the call does). One JSON line per clip
//! goes to stdout.

use std::path::{Path, PathBuf};
use std::time::Instant;

use transcribe_cpp::{Backend, Model, ModelOptions, RunOptions, TimestampKind};

struct Args {
    model: PathBuf,
    backend: Backend,
    backend_name: String,
    language: Option<String>,
    timestamps: TimestampKind,
    timestamps_name: String,
    warmup: usize,
    iters: usize,
    clips: Vec<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        model: PathBuf::new(),
        backend: Backend::Auto,
        backend_name: "auto".into(),
        language: Some("da".into()),
        timestamps: TimestampKind::None,
        timestamps_name: "none".into(),
        warmup: 1,
        iters: 5,
        clips: Vec::new(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut val = || it.next().ok_or(format!("{arg} needs a value"));
        match arg.as_str() {
            "--model" => a.model = val()?.into(),
            "--backend" => {
                a.backend_name = val()?;
                a.backend = match a.backend_name.as_str() {
                    "auto" => Backend::Auto,
                    "cpu" => Backend::Cpu,
                    "cpu_accel" => Backend::CpuAccel,
                    "metal" => Backend::Metal,
                    "vulkan" => Backend::Vulkan,
                    other => return Err(format!("unknown backend {other}")),
                }
            }
            "--language" => {
                let v = val()?;
                a.language = (v != "auto").then_some(v);
            }
            "--timestamps" => {
                a.timestamps_name = val()?;
                a.timestamps = match a.timestamps_name.as_str() {
                    "none" => TimestampKind::None,
                    "auto" => TimestampKind::Auto,
                    other => return Err(format!("unknown timestamps {other}")),
                }
            }
            "--warmup" => a.warmup = val()?.parse().map_err(|e| format!("--warmup: {e}"))?,
            "--iters" => a.iters = val()?.parse().map_err(|e| format!("--iters: {e}"))?,
            "-h" | "--help" => return Err(String::new()),
            _ => a.clips.push(arg.into()),
        }
    }
    if a.model.as_os_str().is_empty() || a.clips.is_empty() || a.iters == 0 {
        return Err("need --model and at least one clip".into());
    }
    Ok(a)
}

/// 16 kHz mono WAV (PCM16 or float32) to f32 samples.
fn read_wav(path: &Path) -> Result<Vec<f32>, String> {
    let b = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err(format!("{}: not a WAV file", path.display()));
    }
    let (mut pos, mut fmt) = (12usize, None);
    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let size = u32::from_le_bytes(b[pos + 4..pos + 8].try_into().unwrap()) as usize;
        let body = &b[pos + 8..(pos + 8 + size).min(b.len())];
        if id == b"fmt " {
            let tag = u16::from_le_bytes([body[0], body[1]]);
            let channels = u16::from_le_bytes([body[2], body[3]]);
            let rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            let bits = u16::from_le_bytes([body[14], body[15]]);
            fmt = Some((tag, channels, rate, bits));
        } else if id == b"data" {
            let (tag, channels, rate, bits) = fmt.ok_or("data before fmt")?;
            if channels != 1 || rate != 16000 {
                return Err(format!("{}: need 16 kHz mono, got {rate} Hz x{channels}", path.display()));
            }
            return match (tag, bits) {
                (1, 16) => Ok(body
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                    .collect()),
                (3, 32) => Ok(body.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect()),
                _ => Err(format!("{}: unsupported WAV format {tag}/{bits}", path.display())),
            };
        }
        pos += 8 + size + (size & 1);
    }
    Err(format!("{}: no data chunk", path.display()))
}

fn main() {
    let a = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            if !e.is_empty() {
                eprintln!("error: {e}");
            }
            eprintln!("usage: wt-speed --model M.gguf [--backend auto|cpu|cpu_accel|metal] [--language da|auto] [--timestamps none|auto] [--warmup N] [--iters N] clip.wav ...");
            std::process::exit(2);
        }
    };
    let t_load = Instant::now();
    let model = Model::load_with(&a.model, &ModelOptions { backend: a.backend, device: None })
        .unwrap_or_else(|e| panic!("load {}: {e}", a.model.display()));
    let load_ms = t_load.elapsed().as_secs_f64() * 1e3;
    let mut session = model.session().expect("session");
    let options = RunOptions { language: a.language.clone(), timestamps: a.timestamps, ..Default::default() };
    eprintln!("model {} on {} loaded in {load_ms:.0} ms", a.model.display(), model.backend());
    for clip in &a.clips {
        let pcm = read_wav(clip).unwrap_or_else(|e| panic!("{e}"));
        let seconds = pcm.len() as f64 / 16000.0;
        for _ in 0..a.warmup {
            session.run(&pcm, &options).expect("warmup run");
        }
        let mut times = Vec::with_capacity(a.iters);
        let mut text = String::new();
        for _ in 0..a.iters {
            let t0 = Instant::now();
            let t = session.run(&pcm, &options).expect("run");
            times.push(t0.elapsed().as_secs_f64() * 1e3);
            text = t.text;
        }
        let mean = times.iter().sum::<f64>() / times.len() as f64;
        let min = times.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = times.iter().cloned().fold(0.0, f64::max);
        let line = serde_json::json!({
            "model": a.model.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
            "backend_requested": a.backend_name, "backend": model.backend(),
            "timestamps": a.timestamps_name, "language": a.language,
            "clip": clip.file_name().map(|s| s.to_string_lossy()).unwrap_or_default(),
            "seconds": (seconds * 1000.0).round() / 1000.0,
            "warmup": a.warmup, "iters": a.iters, "load_ms": load_ms.round(),
            "mean_ms": (mean * 10.0).round() / 10.0, "min_ms": (min * 10.0).round() / 10.0,
            "max_ms": (max * 10.0).round() / 10.0, "realtime_x": ((seconds / (mean / 1e3)) * 10.0).round() / 10.0,
            "text": text,
        });
        println!("{line}");
    }
}
