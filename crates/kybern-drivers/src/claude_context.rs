//! Environment Kybern gives Claude Code sessions to keep what each request
//! sends small: the prompt-cache length of delegated children.
//!
//! The rule only fills a gap. Anything the user set, in the account's
//! environment, the daemon's own, or Claude Code's settings (whose `env`
//! block Claude applies over a launcher's), stays as they set it.

use std::collections::BTreeMap;
use std::path::Path;

use crate::ProbeContext;
use crate::claude_config::{cache_ttl, subagent_prompt_cache_ttl};

pub const CACHE_TTL_ENV: &str = "CLAUDE_CODE_PROMPT_CACHE_TTL";

/// The daemon's own environment variable `key`, which a session inherits unless its account overrides it.
fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn is_set(env: &BTreeMap<String, String>, key: &str, process: &dyn Fn(&str) -> Option<String>) -> bool {
    env.get(key).cloned().or_else(|| process(key)).is_some_and(|value| !value.trim().is_empty())
}

/// Which cache length a delegated child gets: an explicit
/// `CLAUDE_CODE_PROMPT_CACHE_TTL` always wins, then the user's
/// `subagentPromptCacheTtl`, otherwise none (Claude Code's own default).
fn pick_child_cache_ttl(explicit: bool, setting: Option<&str>) -> Option<&'static str> {
    if explicit { None } else { setting.and_then(cache_ttl) }
}

/// `CLAUDE_CODE_PROMPT_CACHE_TTL` for a Claude session Kybern started for a
/// delegated child (`kybern_agent_delegate`, or a Coordinator's child).
///
/// A child is its own Claude session, so Claude Code treats it as a main
/// conversation and gives it the main conversation's cache length: one hour on
/// a subscription, which costs 2x base input to write against 1.25x for five
/// minutes. A native subagent of the same Claude Code gets the user's
/// `subagentPromptCacheTtl`; this gives Kybern's children the same.
pub fn delegated_child_cache_ttl(env: &BTreeMap<String, String>, cwd: &Path) -> Option<&'static str> {
    let context = ProbeContext { binary: None, cwd: Some(cwd.to_path_buf()), env: env.clone() };
    pick_child_cache_ttl(is_set(env, CACHE_TTL_ENV, &process_env), subagent_prompt_cache_ttl(&context).as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    #[test]
    fn an_explicit_value_counts_from_the_account_or_the_daemons_own_environment() {
        let daemon_has = |key: &str| (key == CACHE_TTL_ENV).then(|| "1h".to_string());
        let nothing = |_: &str| None;
        assert!(is_set(&env(&[]), CACHE_TTL_ENV, &daemon_has));
        assert!(is_set(&env(&[(CACHE_TTL_ENV, "5m")]), CACHE_TTL_ENV, &nothing));
        assert!(!is_set(&env(&[]), CACHE_TTL_ENV, &nothing));
        assert!(!is_set(&env(&[(CACHE_TTL_ENV, "  ")]), CACHE_TTL_ENV, &nothing), "a blank value is not a choice");
    }

    #[test]
    fn a_delegated_child_cache_length_follows_the_explicit_value_then_the_setting() {
        assert_eq!(pick_child_cache_ttl(false, Some("5m")), Some("5m"));
        assert_eq!(pick_child_cache_ttl(false, Some("1H")), Some("1h"));
        assert_eq!(pick_child_cache_ttl(true, Some("5m")), None, "an explicit CLAUDE_CODE_PROMPT_CACHE_TTL wins");
        assert_eq!(pick_child_cache_ttl(false, None), None);
        assert_eq!(pick_child_cache_ttl(false, Some("90s")), None, "a value Claude Code does not accept is not forwarded");
    }

    #[test]
    fn the_child_cache_length_is_read_from_claude_settings_unless_the_account_sets_one() {
        let home = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("settings.json"), r#"{ "subagentPromptCacheTtl": "5m", "model": "sonnet" }"#).unwrap();
        let account = env(&[("CLAUDE_CONFIG_DIR", home.path().to_str().unwrap())]);
        assert_eq!(delegated_child_cache_ttl(&account, project.path()), Some("5m"));

        let explicit = env(&[("CLAUDE_CONFIG_DIR", home.path().to_str().unwrap()), (CACHE_TTL_ENV, "1h")]);
        assert_eq!(delegated_child_cache_ttl(&explicit, project.path()), None);

        // A project's own settings override the user's.
        std::fs::create_dir_all(project.path().join(".claude")).unwrap();
        std::fs::write(project.path().join(".claude/settings.json"), r#"{ "subagentPromptCacheTtl": "1h" }"#).unwrap();
        assert_eq!(delegated_child_cache_ttl(&account, project.path()), Some("1h"));

        let nothing = tempfile::tempdir().unwrap();
        let bare = env(&[("CLAUDE_CONFIG_DIR", nothing.path().to_str().unwrap())]);
        assert_eq!(delegated_child_cache_ttl(&bare, nothing.path()), None, "no setting, no variable");
    }
}
