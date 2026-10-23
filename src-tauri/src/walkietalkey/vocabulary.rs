//! The words the speech model is told about (DESK-66..68): the user's "Ord"
//! (newest first), the company's shared list (`VocabularySource`, a path or an
//! https URL refreshed daily) and the "Udviklerord" pack, within the token
//! budget that leaves room for the previous chunk's context (DESK-46).

use std::sync::RwLock;
use std::time::Duration;

use once_cell::sync::Lazy;
use tauri::AppHandle;

use crate::pipeline::da::vocabulary::{parse_word_lines, vocabulary_terms, DEVELOPER_WORDS, VOCABULARY_TOKEN_BUDGET};

/// The company list as last fetched.
static COMPANY_WORDS: Lazy<RwLock<Vec<String>>> = Lazy::new(|| RwLock::new(Vec::new()));

/// The terms for the model, in priority order and within the budget: the
/// user's own words first (newest first), then the company's, then the pack.
/// `user_words` is Handy's custom_words, stored oldest first.
pub fn compose(user_words: &[String], company_words: &[String], developer_pack: bool) -> Vec<String> {
    // vocabulary_terms takes the end of the list first, so the list is built
    // lowest priority first.
    let mut ordered: Vec<String> = Vec::new();
    if developer_pack {
        ordered.extend(DEVELOPER_WORDS.iter().rev().map(|w| w.to_string()));
    }
    ordered.extend(company_words.iter().rev().cloned());
    ordered.extend(user_words.iter().cloned());
    vocabulary_terms(&ordered, VOCABULARY_TOKEN_BUDGET)
}

/// The vocabulary for a run, given whether the model takes one.
pub fn for_run(supports_vocabulary: bool, user_words: &[String]) -> Vec<String> {
    if !supports_vocabulary {
        return Vec::new();
    }
    let developer_pack = super::app().is_some_and(|app| super::store::get(app).developer_words);
    compose(user_words, &COMPANY_WORDS.read().unwrap(), developer_pack)
}

/// Fetches the company list now and every day (Appendix B: refreshed daily).
pub fn start(app: &AppHandle) {
    let Some(source) = super::store::get(app).vocabulary_source else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        loop {
            match fetch(&source).await {
                Ok(words) => {
                    log::info!("Company word list: {} words", words.len());
                    *COMPANY_WORDS.write().unwrap() = words;
                }
                Err(e) => log::warn!("Company word list unavailable: {e}"),
            }
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });
}

async fn fetch(source: &str) -> Result<Vec<String>, String> {
    let text = if source.starts_with("https://") {
        reqwest::get(source)
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())?
            .text()
            .await
            .map_err(|e| e.to_string())?
    } else {
        std::fs::read_to_string(source).map_err(|e| e.to_string())?
    };
    Ok(parse_word_lines(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(list: &[&str]) -> Vec<String> {
        list.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn the_users_newest_words_come_first_then_the_company_then_the_pack() {
        let terms = compose(&words(&["Ældst", "Nyest"]), &words(&["Firmaord"]), true);
        assert_eq!(&terms[..3], &words(&["Nyest", "Ældst", "Firmaord"])[..]);
        assert!(terms.contains(&"pull request".to_string()));
    }

    #[test]
    fn the_pack_is_left_out_when_off_and_the_budget_holds() {
        let many: Vec<String> = (0..300).map(|i| format!("Ord{i}")).collect();
        let terms = compose(&many, &[], false);
        assert!(!terms.contains(&"pull request".to_string()));
        assert!(terms.len() < 300, "the 150-token budget cuts the oldest");
        assert_eq!(terms[0], "Ord299");
    }
}
