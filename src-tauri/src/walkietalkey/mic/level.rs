//! Does the input deliver sound at all (DESK-59)? A pure detector over the
//! raw 16 kHz mono input, before VAD: VAD answers "is this speech", this
//! answers "is anything coming in", so a dead input is told apart from a
//! working microphone that heard no speech.
//!
//! The thresholds, from what the app measures (run 3 clips in
//! `_kit/work/run3-accuracy/`, 32 ms windows):
//!
//! - The built-in Mac microphone in a quiet room: the quietest window of every
//!   take peaks at -47 to -62 dBFS (room tone; the overlay's visualiser is
//!   calibrated against room tone at about -48 dBFS and dictation at about
//!   -32 dBFS), and no take stays under -60 dBFS for more than 0.03 s.
//! - Speech on the quietest working input measured, the iPhone with its audio
//!   processing off (17 dB quieter than the Mac), peaks at -16 to -31 dBFS:
//!   30 dB above the floor.
//! - The same iPhone input dips under -60 dBFS for up to 2.4 s in pauses, so
//!   a quiet pause on a working microphone is not silence. The rule is
//!   therefore "nothing above the floor since the take began", never "the
//!   last 1.5 s were quiet": once an input has delivered sound, a pause
//!   cannot make it silent.
//! - An audio interface with nothing plugged in sits around -90 dBFS or
//!   lower, and a muted, denied or virtual input delivers exact zeros. Both
//!   are far below the floor.
//!
//! So: a window counts as sound when its peak (after removing its DC offset,
//! which some interfaces deliver with no signal) reaches -60 dBFS. An input
//! is alive after 3 such windows (96 ms in all, so one click or the pop of a
//! stream opening does not count). If 1.5 s pass without that, the pill says
//! so while it keeps recording; a take of at least 0.5 s that never comes
//! alive is a silent take.
//!
//! Run over the same clips, this rule calls every Mac take alive after the
//! minimum 96 ms (room tone alone clears the floor), and even the iPhone
//! takes, 17 dB quieter and trimmed by VAD to just before the speech, are
//! alive within 0.22 to 1.06 s.

/// The detector's input rate: the recorder delivers 16 kHz mono.
pub const SAMPLE_RATE: usize = 16_000;
/// 32 ms, one Silero frame and the visualiser's window.
pub const WINDOW: usize = 512;
/// -60 dBFS: no working microphone stays under this while someone talks.
pub const FLOOR: f32 = 0.001;
/// Windows with sound before the input counts as alive (96 ms).
pub const ALIVE_WINDOWS: usize = 3;
/// Windows without sound before the pill says so (1.5 s, rounded up).
pub const SILENT_NOTICE_WINDOWS: usize = (1_500 * SAMPLE_RATE).div_ceil(1_000 * WINDOW);
/// The shortest take that can be called silent (0.5 s, rounded up).
pub const MIN_SILENT_TAKE_WINDOWS: usize = (500 * SAMPLE_RATE).div_ceil(1_000 * WINDOW);
/// Below this every sample is zero but for float rounding (-140 dBFS).
const DIGITAL_ZERO: f32 = 1e-7;

/// What changed while a take was recording, for the pill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    /// 1.5 s and still no sound: "Mikrofonen giver ingen lyd".
    Silent,
    /// Sound arrived after [`Change::Silent`]: the notice goes away.
    Alive,
}

/// How a silent take was silent; for the log, the user hears one sentence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Silence {
    /// Every sample zero: muted, permission denied, or a virtual device.
    DigitalZero,
    /// Some signal, never above the floor: nothing plugged in, gain at zero.
    BelowFloor,
}

/// A whole take's verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The input delivered sound.
    Alive,
    /// Too short to say (under 0.5 s without sound).
    TooShort,
    /// No sound for the whole take.
    Silent(Silence),
}

/// Watches one take (or one probe) of raw input, window by window.
#[derive(Debug, Clone)]
pub struct SilenceDetector {
    pending: Vec<f32>,
    windows: usize,
    loud_windows: usize,
    /// Highest window peak, DC removed.
    peak: f32,
    /// Highest raw sample magnitude.
    raw_peak: f32,
    noticed: bool,
}

impl Default for SilenceDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl SilenceDetector {
    pub fn new() -> Self {
        Self {
            pending: Vec::with_capacity(WINDOW),
            windows: 0,
            loud_windows: 0,
            peak: 0.0,
            raw_peak: 0.0,
            noticed: false,
        }
    }

    /// Feeds raw samples (any chunk size). Returns the net change for the
    /// pill: a call that both raises and clears the notice reports nothing.
    pub fn feed(&mut self, samples: &[f32]) -> Option<Change> {
        let was_noticed = self.noticed;
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (WINDOW - self.pending.len()).min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.pending.len() == WINDOW {
                self.close_window();
                self.pending.clear();
            }
        }
        match (was_noticed, self.noticed) {
            (false, true) => Some(Change::Silent),
            (true, false) => Some(Change::Alive),
            _ => None,
        }
    }

    fn close_window(&mut self) {
        let mean = self.pending.iter().sum::<f32>() / WINDOW as f32;
        let (mut peak, mut raw) = (0.0f32, 0.0f32);
        for &x in &self.pending {
            peak = peak.max((x - mean).abs());
            raw = raw.max(x.abs());
        }
        self.windows += 1;
        self.peak = self.peak.max(peak);
        self.raw_peak = self.raw_peak.max(raw);
        if peak >= FLOOR {
            self.loud_windows += 1;
        }
        if self.is_alive() {
            self.noticed = false;
        } else if self.windows == SILENT_NOTICE_WINDOWS {
            self.noticed = true;
        }
    }

    /// The input has delivered sound in this take.
    pub fn is_alive(&self) -> bool {
        self.loud_windows >= ALIVE_WINDOWS
    }

    /// The pill's notice is up.
    pub fn is_noticed(&self) -> bool {
        self.noticed
    }

    /// Seconds of input seen, in whole windows.
    pub fn seconds(&self) -> f32 {
        (self.windows * WINDOW) as f32 / SAMPLE_RATE as f32
    }

    /// The loudest window's peak, DC removed, in dBFS (for the log).
    pub fn peak_dbfs(&self) -> f32 {
        dbfs(self.peak)
    }

    pub fn verdict(&self) -> Verdict {
        if self.is_alive() {
            Verdict::Alive
        } else if self.windows < MIN_SILENT_TAKE_WINDOWS {
            Verdict::TooShort
        } else if self.raw_peak < DIGITAL_ZERO {
            Verdict::Silent(Silence::DigitalZero)
        } else {
            Verdict::Silent(Silence::BelowFloor)
        }
    }
}

/// Amplitude to dBFS; silence is -inf, shown as -200.
pub fn dbfs(amplitude: f32) -> f32 {
    if amplitude > 0.0 {
        20.0 * amplitude.log10()
    } else {
        -200.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: usize = SAMPLE_RATE;

    fn amplitude(db: f32) -> f32 {
        10f32.powf(db / 20.0)
    }

    /// Deterministic white noise in -1..1 (an LCG; no test dependencies).
    struct Noise(u64);
    impl Noise {
        fn next(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            ((self.0 >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
        }
    }

    fn zeros(seconds: f32) -> Vec<f32> {
        vec![0.0; (seconds * RATE as f32) as usize]
    }

    /// White noise whose peak is about `peak_db`.
    fn noise(seconds: f32, peak_db: f32, seed: u64) -> Vec<f32> {
        let mut n = Noise(seed);
        let a = amplitude(peak_db);
        (0..(seconds * RATE as f32) as usize)
            .map(|_| n.next() * a)
            .collect()
    }

    /// A voiced burst: 180 Hz with harmonics, about `peak_db` at its peak.
    fn voice(seconds: f32, peak_db: f32) -> Vec<f32> {
        let a = amplitude(peak_db) / 1.75;
        (0..(seconds * RATE as f32) as usize)
            .map(|i| {
                let t = i as f32 / RATE as f32;
                let w = 2.0 * std::f32::consts::PI * 180.0 * t;
                a * (w.sin() + 0.5 * (2.0 * w).sin() + 0.25 * (3.0 * w).sin())
            })
            .collect()
    }

    /// Feeds `samples` in chunks of `chunk`, collecting the changes with the
    /// time (in seconds) at which each happened.
    fn run(d: &mut SilenceDetector, samples: &[f32], chunk: usize) -> Vec<(f32, Change)> {
        let mut out = Vec::new();
        for c in samples.chunks(chunk) {
            if let Some(change) = d.feed(c) {
                out.push((d.seconds(), change));
            }
        }
        out
    }

    #[test]
    fn thresholds_are_the_documented_ones() {
        assert!((dbfs(FLOOR) + 60.0).abs() < 0.01);
        assert_eq!(SILENT_NOTICE_WINDOWS, 47); // 1.504 s
        assert_eq!(MIN_SILENT_TAKE_WINDOWS, 16); // 0.512 s
        assert_eq!(ALIVE_WINDOWS * WINDOW * 1000 / RATE, 96);
    }

    #[test]
    fn digital_zeros_are_silent_and_noticed_at_one_and_a_half_seconds() {
        let mut d = SilenceDetector::new();
        let changes = run(&mut d, &zeros(3.0), 512);
        assert_eq!(changes.len(), 1);
        let (at, change) = changes[0];
        assert_eq!(change, Change::Silent);
        assert!((1.5..1.55).contains(&at), "noticed at {at} s");
        assert!(d.is_noticed());
        assert_eq!(d.verdict(), Verdict::Silent(Silence::DigitalZero));
    }

    #[test]
    fn hiss_at_minus_ninety_dbfs_is_silent_but_not_digital_zero() {
        // An interface with nothing plugged in.
        let mut d = SilenceDetector::new();
        let changes = run(&mut d, &noise(2.5, -90.0, 7), 480);
        assert_eq!(
            changes.iter().map(|c| c.1).collect::<Vec<_>>(),
            vec![Change::Silent]
        );
        assert_eq!(d.verdict(), Verdict::Silent(Silence::BelowFloor));
        assert!(d.peak_dbfs() < -85.0);
    }

    #[test]
    fn quiet_room_noise_on_a_working_microphone_is_alive_at_once() {
        // Room tone as the built-in Mac microphone measured it: windows
        // peaking around -55 dBFS, with no speech at all.
        let mut d = SilenceDetector::new();
        let changes = run(&mut d, &noise(4.0, -55.0, 11), 512);
        assert!(changes.is_empty(), "no notice: {changes:?}");
        assert_eq!(d.verdict(), Verdict::Alive);
    }

    #[test]
    fn speech_bursts_between_quiet_stretches_are_alive() {
        let mut samples = noise(0.8, -90.0, 3);
        for i in 0..4 {
            samples.extend(voice(0.3, -24.0));
            samples.extend(noise(0.5, -90.0, 20 + i));
        }
        let mut d = SilenceDetector::new();
        let changes = run(&mut d, &samples, 512);
        assert!(changes.is_empty(), "alive before 1.5 s: {changes:?}");
        assert_eq!(d.verdict(), Verdict::Alive);
    }

    #[test]
    fn a_pause_after_speech_never_makes_a_working_input_silent() {
        // The iPhone measured under -60 dBFS for 2.4 s in a pause.
        let mut samples = voice(0.4, -28.0);
        samples.extend(noise(3.0, -75.0, 5));
        let mut d = SilenceDetector::new();
        assert!(run(&mut d, &samples, 512).is_empty());
        assert_eq!(d.verdict(), Verdict::Alive);
    }

    #[test]
    fn a_microphone_that_comes_alive_after_one_second_is_never_noticed() {
        let mut samples = zeros(1.0);
        samples.extend(noise(2.0, -50.0, 9));
        let mut d = SilenceDetector::new();
        assert!(run(&mut d, &samples, 512).is_empty());
        assert_eq!(d.verdict(), Verdict::Alive);
    }

    #[test]
    fn a_microphone_that_comes_alive_after_three_seconds_clears_the_notice() {
        let mut samples = zeros(3.0);
        samples.extend(voice(1.0, -20.0));
        let mut d = SilenceDetector::new();
        let changes = run(&mut d, &samples, 512);
        assert_eq!(changes.len(), 2, "{changes:?}");
        assert_eq!(changes[0].1, Change::Silent);
        assert_eq!(changes[1].1, Change::Alive);
        // Three windows of sound, so about 0.1 s after the voice began.
        assert!((3.0..3.15).contains(&changes[1].0), "{changes:?}");
        assert!(!d.is_noticed());
        assert_eq!(d.verdict(), Verdict::Alive);
    }

    #[test]
    fn one_click_does_not_make_a_dead_input_alive() {
        let mut samples = zeros(2.0);
        samples[8_000] = 0.5;
        let mut d = SilenceDetector::new();
        let changes = run(&mut d, &samples, 512);
        assert_eq!(changes, vec![(changes[0].0, Change::Silent)]);
        assert_eq!(d.verdict(), Verdict::Silent(Silence::BelowFloor));
    }

    #[test]
    fn a_dc_offset_without_signal_is_silent() {
        let mut d = SilenceDetector::new();
        run(&mut d, &vec![0.01; 2 * RATE], 512);
        assert_eq!(d.verdict(), Verdict::Silent(Silence::BelowFloor));
    }

    #[test]
    fn a_short_take_is_too_short_to_judge() {
        let mut d = SilenceDetector::new();
        assert!(run(&mut d, &zeros(0.4), 512).is_empty());
        assert_eq!(d.verdict(), Verdict::TooShort);
        run(&mut d, &zeros(0.2), 512);
        assert_eq!(d.verdict(), Verdict::Silent(Silence::DigitalZero));
    }

    #[test]
    fn one_chunk_that_raises_and_clears_the_notice_reports_nothing() {
        let mut samples = zeros(3.0);
        samples.extend(voice(0.5, -20.0));
        let mut d = SilenceDetector::new();
        assert_eq!(d.feed(&samples), None);
        assert!(!d.is_noticed());
        assert_eq!(d.verdict(), Verdict::Alive);
    }

    #[test]
    fn the_chunk_size_does_not_change_the_result() {
        let mut samples = noise(2.0, -90.0, 13);
        samples.extend(voice(0.5, -30.0));
        let reference = {
            let mut d = SilenceDetector::new();
            run(&mut d, &samples, 512)
                .into_iter()
                .map(|c| c.1)
                .collect::<Vec<_>>()
        };
        assert_eq!(reference, vec![Change::Silent, Change::Alive]);
        for chunk in [1, 256, 333, 480, 4096] {
            let mut d = SilenceDetector::new();
            let changes: Vec<_> = run(&mut d, &samples, chunk)
                .into_iter()
                .map(|c| c.1)
                .collect();
            assert_eq!(changes, reference, "chunk {chunk}");
            assert_eq!(d.verdict(), Verdict::Alive);
        }
    }
}
