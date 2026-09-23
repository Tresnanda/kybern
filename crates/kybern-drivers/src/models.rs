//! Shared, provider-agnostic model-id → display-name formatting.
//!
//! The contract for every driver: a model's display name comes from the agent's
//! own metadata (a CLI `displayName`, an `id - Label` line, an API field)
//! whenever the agent gives one. Only when the agent gives nothing — Claude Code
//! exposes bare family aliases with no name — do we synthesize a label, and we
//! do it mechanically here rather than with a hand-maintained per-model table
//! that dates the moment a new model ships.
//!
//! Never add a `match id { "some-model" => "Marketing Name" }` arm to a driver.
//! If a real model formats wrong, teach [`prettify_model_id`] the general rule.

/// Format a concrete model id into a human label without any per-model lookup.
///
/// `claude-opus-5-5` → `Claude Opus 5.5`, `claude-3-5-sonnet-20241022`
/// → `Claude 3.5 Sonnet`, `gpt-6-sol` → `GPT 6 Sol`, `opus` → `Opus`. Trailing
/// `YYYYMMDD` date stamps are dropped and adjacent numeric segments join into a
/// dotted version, so a model kybern has never heard of still formats correctly.
pub fn prettify_model_id(id: &str) -> String {
    // Drop any `[context]` suffix; callers that care re-attach it themselves.
    let base = id.split('[').next().unwrap_or(id);
    let mut words: Vec<String> = Vec::new();
    for token in base.split(['-', '_', '/', '.']).filter(|t| !t.is_empty()) {
        let numeric = token.bytes().all(|b| b.is_ascii_digit());
        // A bare 8-digit run is a release date stamp, not a version.
        if numeric && token.len() >= 8 {
            continue;
        }
        if numeric {
            if let Some(last) = words.last_mut()
                && last.bytes().next().is_some_and(|b| b.is_ascii_digit())
                && last.bytes().all(|b| b.is_ascii_digit() || b == b'.')
            {
                last.push('.');
                last.push_str(token);
                continue;
            }
            words.push(token.to_string());
        } else {
            words.push(prettify_word(token));
        }
    }
    words.join(" ")
}

/// Title-case a single word, upper-casing known initialisms.
fn prettify_word(word: &str) -> String {
    match word.to_ascii_lowercase().as_str() {
        "gpt" => return "GPT".into(),
        "ai" => return "AI".into(),
        "api" => return "API".into(),
        "omp" => return "OMP".into(),
        "pi" => return "Pi".into(),
        _ => {}
    }
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::prettify_model_id;

    #[test]
    fn joins_version_segments_and_drops_date_stamps() {
        // A new model formats itself with no code change — the whole point.
        assert_eq!(prettify_model_id("claude-opus-5-5"), "Claude Opus 5.5");
        assert_eq!(prettify_model_id("claude-opus-4-1-20250805"), "Claude Opus 4.1");
        assert_eq!(prettify_model_id("claude-3-5-sonnet-20241022"), "Claude 3.5 Sonnet");
        assert_eq!(prettify_model_id("claude-opus-5"), "Claude Opus 5");
    }

    #[test]
    fn capitalizes_words_and_initialisms() {
        assert_eq!(prettify_model_id("gpt-6-sol"), "GPT 6 Sol");
        assert_eq!(prettify_model_id("gpt-5.6-luna"), "GPT 5.6 Luna");
        assert_eq!(prettify_model_id("o3"), "O3");
    }

    #[test]
    fn bare_aliases_stay_version_free() {
        // The alias always means "latest"; inventing a version would go stale.
        assert_eq!(prettify_model_id("opus"), "Opus");
        assert_eq!(prettify_model_id("sonnet"), "Sonnet");
        assert_eq!(prettify_model_id("fable"), "Fable");
    }

    #[test]
    fn ignores_context_suffix() {
        assert_eq!(prettify_model_id("opus[1m]"), "Opus");
        assert_eq!(prettify_model_id("claude-opus-5-5[1m]"), "Claude Opus 5.5");
    }
}
