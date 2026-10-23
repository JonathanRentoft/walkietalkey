//! Danish punctuation and capitalisation with RyeAI's Ekko PnC v2 (DESK-41).
//!
//! A port of the reference runtime, `ekko.pnc.Punctuator` from the `ekko-stt`
//! Python package (0.1.2): the same int8 ONNX model and WordPiece tokenizer,
//! the same 128-token windows with 12 words of overlap, the same merge of
//! overlapping windows and the same capitalisation rules. Golden tests
//! (`tests/golden.rs`) check the output against the reference byte for byte.
//!
//! ```no_run
//! let pnc = ekko_pnc::Punctuator::from_dir("/path/to/ekko-pnc")?;
//! assert_eq!(pnc.punctuate("hej mit navn er emil hvordan går det i dag")?,
//!            "Hej, mit navn er Emil. Hvordan går det i dag?");
//! # Ok::<(), ekko_pnc::Error>(())
//! ```
//!
//! The model folder holds `pnc.int8.onnx`, `tokenizer.json` and `config.json`
//! from huggingface.co/RyeAI/ekko-pnc (see `models/ekko-pnc/download.sh`).

mod pyunicode;
pub mod text;
pub mod window;

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ort::session::Session;
use ort::value::Tensor;
use tokenizers::{EncodeInput, InputSequence, Tokenizer};

/// File names inside the model folder.
pub const MODEL_FILE: &str = "pnc.int8.onnx";
pub const TOKENIZER_FILE: &str = "tokenizer.json";
pub const CONFIG_FILE: &str = "config.json";

/// The CPython and Unicode versions whose `str` semantics the generated
/// tables in `pyunicode.rs` reproduce.
pub const PYTHON_TABLES: (&str, &str) = (pyunicode::PYTHON_VERSION, pyunicode::UNICODE_VERSION);

/// Reference defaults (`ekko.pnc.Punctuator.__init__`).
pub const DEFAULT_MAX_LENGTH: usize = 128;
pub const DEFAULT_OVERLAP_WORDS: usize = 12;

#[derive(Debug)]
pub enum Error {
    /// A model file is missing or unreadable.
    Load {
        path: PathBuf,
        message: String,
    },
    /// `config.json` has no usable `id2label`.
    Config(String),
    /// Invalid options.
    Options(String),
    Tokenizer(String),
    Inference(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Load { path, message } => {
                write!(f, "could not load {}: {message}", path.display())
            }
            Error::Config(m) => write!(f, "invalid PnC config: {m}"),
            Error::Options(m) => write!(f, "invalid PnC options: {m}"),
            Error::Tokenizer(m) => write!(f, "PnC tokenizer failed: {m}"),
            Error::Inference(m) => write!(f, "PnC inference failed: {m}"),
        }
    }
}

impl std::error::Error for Error {}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A label from `config.json` `id2label`: an optional mark to append and
/// whether the word's first letter is upper-cased (`"O"`, `",|U"`, `"."` ...).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Label {
    pub mark: Option<String>,
    pub upper: bool,
}

impl Label {
    /// The reference: `upper = label.endswith("|U")`, `mark = label[:-2] if upper
    /// else label`, and the mark `"O"` means none.
    pub fn parse(label: &str) -> Label {
        let (mark, upper) = match label.strip_suffix("|U") {
            Some(mark) => (mark, true),
            None => (label, false),
        };
        Label {
            mark: (mark != "O").then(|| mark.to_string()),
            upper,
        }
    }
}

/// `numpy.argmax` over one row: the first index of the maximum, where a NaN
/// counts as the maximum (NumPy returns the first NaN).
pub fn argmax(row: &[f32]) -> usize {
    if let Some(i) = row.iter().position(|v| v.is_nan()) {
        return i;
    }
    let mut best = 0;
    for (i, &v) in row.iter().enumerate().skip(1) {
        if v > row[best] {
            best = i;
        }
    }
    best
}

fn load_err(path: &Path, e: impl fmt::Display) -> Error {
    Error::Load {
        path: path.to_path_buf(),
        message: e.to_string(),
    }
}

fn read_labels(path: &Path) -> Result<Vec<Label>> {
    let text = std::fs::read_to_string(path).map_err(|e| load_err(path, e))?;
    let config: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| Error::Config(e.to_string()))?;
    let map = config
        .get("id2label")
        .and_then(|v| v.as_object())
        .ok_or_else(|| Error::Config("missing id2label".into()))?;
    let mut labels = vec![None; map.len()];
    for (key, value) in map {
        let id: usize = key
            .parse()
            .map_err(|_| Error::Config(format!("label id {key:?}")))?;
        let name = value
            .as_str()
            .ok_or_else(|| Error::Config(format!("label {key} is not a string")))?;
        let slot = labels
            .get_mut(id)
            .ok_or_else(|| Error::Config(format!("label ids not contiguous at {id}")))?;
        *slot = Some(Label::parse(name));
    }
    labels
        .into_iter()
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| Error::Config("label ids not contiguous".into()))
}

#[derive(Debug, Clone)]
pub struct Options {
    pub model_file: String,
    pub max_length: usize,
    pub overlap_words: usize,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            model_file: MODEL_FILE.to_string(),
            max_length: DEFAULT_MAX_LENGTH,
            overlap_words: DEFAULT_OVERLAP_WORDS,
        }
    }
}

/// Reusable punctuator. `Send + Sync`; model calls are serialised, as in the
/// reference (which holds a lock around them).
pub struct Punctuator {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    labels: Vec<Label>,
    max_length: usize,
    overlap_words: usize,
}

impl Punctuator {
    /// Load `pnc.int8.onnx`, `tokenizer.json` and `config.json` from `dir`.
    pub fn from_dir(dir: impl AsRef<Path>) -> Result<Self> {
        Self::with_options(dir, Options::default())
    }

    pub fn with_options(dir: impl AsRef<Path>, options: Options) -> Result<Self> {
        if options.max_length < 8 {
            return Err(Error::Options("max_length must be at least 8".into()));
        }
        let dir = dir.as_ref();
        let model_path = dir.join(&options.model_file);
        if !model_path.is_file() {
            return Err(load_err(&model_path, "missing PnC model"));
        }
        let tokenizer_path = dir.join(TOKENIZER_FILE);
        let tokenizer =
            Tokenizer::from_file(&tokenizer_path).map_err(|e| load_err(&tokenizer_path, e))?;
        let labels = read_labels(&dir.join(CONFIG_FILE))?;
        let session = Session::builder()
            .and_then(|mut b| b.commit_from_file(&model_path))
            .map_err(|e| load_err(&model_path, e))?;
        Ok(Punctuator {
            session: Mutex::new(session),
            tokenizer,
            labels,
            max_length: options.max_length,
            overlap_words: options.overlap_words,
        })
    }

    /// Punctuate and capitalise `text`. Words are `text.split()` (Python
    /// whitespace) and come back joined by single spaces, each word kept in
    /// order with at most a capitalised first letter and one appended mark.
    pub fn punctuate(&self, text: &str) -> Result<String> {
        Ok(self.punctuate_words(&text::py_split(text))?.join(" "))
    }

    /// The word-level API (`Punctuator.punctuate_words`): one output per input word.
    pub fn punctuate_words(&self, words: &[&str]) -> Result<Vec<String>> {
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let mut session = self.session.lock().unwrap_or_else(|p| p.into_inner());
        let output = self.punctuate_words_locked(&mut session, words)?;
        Ok(text::stabilize_sentence_case(output))
    }

    fn encode(&self, words: &[&str]) -> Result<tokenizers::Encoding> {
        let input = EncodeInput::Single(InputSequence::from(words.to_vec()));
        self.tokenizer
            .encode(input, true)
            .map_err(|e| Error::Tokenizer(e.to_string()))
    }

    fn punctuate_words_locked(&self, session: &mut Session, words: &[&str]) -> Result<Vec<String>> {
        let encoding = self.encode(words)?;
        let mut token_counts = vec![0usize; words.len()];
        let mut special_tokens = 0usize;
        for word_id in encoding.get_word_ids() {
            match word_id {
                Some(id) => token_counts[*id as usize] += 1,
                None => special_tokens += 1,
            }
        }
        let mut output = Vec::with_capacity(words.len());
        for w in window::plan(
            &token_counts,
            special_tokens,
            self.max_length,
            self.overlap_words,
        ) {
            let rendered = self.predict_window(session, &words[w.context_start..w.end])?;
            output.extend_from_slice(
                &rendered[w.emit_start - w.context_start..w.emit_end - w.context_start],
            );
        }
        if output.len() != words.len() {
            return Err(Error::Inference(format!(
                "PnC changed word cardinality: {} -> {}",
                words.len(),
                output.len()
            )));
        }
        Ok(output)
    }

    /// `Punctuator._predict_window`: one model call over `words`, then each
    /// word's label is read from its first sub-token.
    fn predict_window(&self, session: &mut Session, words: &[&str]) -> Result<Vec<String>> {
        let encoding = self.encode(words)?;
        let len = encoding.get_ids().len().min(self.max_length);
        let ids: Vec<i64> = encoding.get_ids()[..len]
            .iter()
            .map(|&i| i as i64)
            .collect();
        let word_ids = &encoding.get_word_ids()[..len];
        let infer = |e: ort::Error| Error::Inference(e.to_string());
        let input_ids = Tensor::from_array(([1usize, len], ids)).map_err(infer)?;
        let attention_mask = Tensor::from_array(([1usize, len], vec![1i64; len])).map_err(infer)?;
        let outputs = session
            .run(ort::inputs!["input_ids" => input_ids, "attention_mask" => attention_mask])
            .map_err(infer)?;
        let (shape, logits) = outputs[0].try_extract_tensor::<f32>().map_err(infer)?;
        let n_labels = self.labels.len();
        if shape.len() != 3 || shape[1] as usize != len || shape[2] as usize != n_labels {
            return Err(Error::Inference(format!(
                "unexpected logits shape {shape:?}"
            )));
        }

        let mut rendered: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        let mut seen = vec![false; words.len()];
        for (index, word_id) in word_ids.iter().enumerate() {
            let Some(word_id) = word_id.map(|w| w as usize) else {
                continue;
            };
            if seen[word_id] {
                continue;
            }
            seen[word_id] = true;
            let label = &self.labels[argmax(&logits[index * n_labels..(index + 1) * n_labels])];
            let word = words[word_id];
            let mut out = if label.upper {
                text::capitalize_initial_preserving_case(word)
            } else {
                word.to_string()
            };
            if let Some(mark) = &label.mark {
                out.push_str(mark);
            }
            rendered[word_id] = out;
        }
        Ok(rendered)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(
            Label::parse("O"),
            Label {
                mark: None,
                upper: false
            }
        );
        assert_eq!(
            Label::parse("O|U"),
            Label {
                mark: None,
                upper: true
            }
        );
        assert_eq!(
            Label::parse(","),
            Label {
                mark: Some(",".into()),
                upper: false
            }
        );
        assert_eq!(
            Label::parse(".|U"),
            Label {
                mark: Some(".".into()),
                upper: true
            }
        );
        assert_eq!(
            Label::parse("?"),
            Label {
                mark: Some("?".into()),
                upper: false
            }
        );
    }

    #[test]
    fn argmax_like_numpy() {
        assert_eq!(argmax(&[0.1, 0.9, 0.3]), 1);
        assert_eq!(argmax(&[0.5, 0.9, 0.9]), 1, "first maximum wins ties");
        assert_eq!(argmax(&[0.5, f32::NAN, 0.9, f32::NAN]), 1, "first NaN wins");
        assert_eq!(argmax(&[-1.0]), 0);
    }

    #[test]
    fn missing_model_dir_is_a_load_error() {
        let err = Punctuator::from_dir("/nonexistent/ekko-pnc")
            .err()
            .expect("must fail");
        assert!(matches!(err, Error::Load { .. }), "{err}");
    }

    #[test]
    fn options_are_validated() {
        let err = Punctuator::with_options(
            "/nonexistent",
            Options {
                max_length: 4,
                ..Options::default()
            },
        )
        .err()
        .expect("must fail");
        assert!(matches!(err, Error::Options(_)), "{err}");
    }

    #[test]
    fn punctuator_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Punctuator>();
    }
}
