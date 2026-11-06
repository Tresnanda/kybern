//! What a failed turn means for the person using it.
//!
//! Every harness reports its failures as text in its own words ("Invalid API key · Please run /login",
//! "You've hit your usage limit", `ECONNREFUSED`). `classify` reads that text for the harness that wrote it
//! and returns the `Problem` clients show, or `None` when it is nothing Kybern can name; the raw text stays
//! in `TurnFailed::error` and in the problem's `detail`. Clients write the words from `kind` and `subject`;
//! `title` and `hint` are only a fallback.
//!
//! Subjects: a harness's short tool name (`claude`, `codex`, `cursor`, ...) for a signed-out, missing or
//! outdated agent, `rate_limit` for a usage limit and `network` for a connection that failed.

use kybern_protocol::ProviderKind;
use kybern_protocol::rpc::{Problem, ProblemAction, ProblemKind};
use serde_json::json;

use crate::DriverError;

/// The short name clients and `problem.rs` use for a harness (a problem's `subject` and `provider` param).
pub fn tool_name(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::ClaudeCode => "claude",
        ProviderKind::Codex => "codex",
        ProviderKind::Opencode => "opencode",
        ProviderKind::Pi => "pi",
        ProviderKind::Omp => "omp",
        ProviderKind::Cursor => "cursor",
        ProviderKind::Antigravity => "antigravity",
        ProviderKind::GrokBuild => "grok",
    }
}

/// How people name a harness.
pub fn label(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::ClaudeCode => "Claude Code",
        ProviderKind::Codex => "Codex",
        ProviderKind::Opencode => "OpenCode",
        ProviderKind::Pi => "Pi",
        ProviderKind::Omp => "Oh My Pi",
        ProviderKind::Cursor => "Cursor",
        ProviderKind::Antigravity => "Antigravity",
        ProviderKind::GrokBuild => "Grok Build",
    }
}

/// The problem a failed turn of `kind` with this `text` is, or `None` when Kybern can't tell.
pub fn classify(kind: ProviderKind, text: &str) -> Option<Problem> {
    let lower = text.to_ascii_lowercase();
    if signed_out(kind, text, &lower) {
        return Some(signed_out_problem(kind, text));
    }
    if rate_limited(&lower) {
        return Some(rate_limited_problem(kind, text));
    }
    if unreachable(&lower) {
        return Some(network_problem(kind, text));
    }
    None
}

/// The problem a `DriverError` that stopped a session means, when it has one.
pub fn classify_error(kind: ProviderKind, error: &DriverError) -> Option<Problem> {
    let detail = error.to_string();
    match error {
        DriverError::VersionTooOld { .. } => Some(
            Problem::new(ProblemKind::UpdateNeeded, detail)
                .with_subject(tool_name(kind))
                .with_copy(
                    format!("Update {}", label(kind)),
                    format!("The installed {} is older than Kybern needs. Update it, then try again.", label(kind)),
                )
                .with_action(
                    ProblemAction::new("update_agent", format!("Update {}", label(kind)))
                        .with_params(json!({ "provider": tool_name(kind) })),
                )
                .with_secondary(ProblemAction::retry("Check again")),
        ),
        DriverError::BinaryNotFound(name) if !name.contains(' ') => Some(
            Problem::new(ProblemKind::ToolMissing, detail)
                .with_subject(tool_name(kind))
                .with_copy(
                    format!("Install {}", label(kind)),
                    format!("{} isn't installed on this computer, or Kybern can't find it. Install it, then try again.", label(kind)),
                )
                .with_action(
                    ProblemAction::new("install_tool", format!("Install {}", label(kind))).with_params(json!({ "tool": tool_name(kind) })),
                )
                .with_secondary(ProblemAction::retry("Check again")),
        ),
        DriverError::ProcessExited(text) | DriverError::Protocol(text) => classify(kind, text),
        DriverError::Other(error) => classify(kind, &format!("{error:#}")),
        _ => None,
    }
}

fn signed_out(kind: ProviderKind, text: &str, lower: &str) -> bool {
    const COMMON: &[&str] = &[
        "please run /login",
        "run /login",
        "not logged in",
        "not signed in",
        "invalid api key",
        "authentication_failed",
        "authentication_error",
        "failed to authenticate",
        "oauth token revoked",
        "oauth token has expired",
        "invalid bearer token",
        "unauthorized (401)",
        "401 unauthorized",
        "api error: 401",
        "status code 401",
        "status 401",
        "http 401",
    ];
    if COMMON.iter().any(|needle| lower.contains(needle)) || crate::login_lend::is_login_failure(kind, text) {
        return true;
    }
    let extra: &[&str] = match kind {
        ProviderKind::Codex => &[
            "access token could not be refreshed",
            "sign in again",
            "log out and sign in",
            "missing bearer or basic authentication",
            "codex login",
        ],
        ProviderKind::Cursor => {
            &["authentication required", "not authenticated", "unauthenticated", "auth_required", "agent login", "please log in"]
        }
        ProviderKind::GrokBuild => &["authentication required", "grok login", "login required", "unauthenticated", "not authenticated"],
        ProviderKind::Opencode => &["providerautherror", "provider.auth", "unauthorized", "no api key", "authentication required"],
        ProviderKind::Pi | ProviderKind::Omp => &["no api key", "authentication required", "/login"],
        ProviderKind::Antigravity => {
            &["authenticat", "oauth", "unauthorized", "sign in", "sign-in", "login", "log in", "credential", "401"]
        }
        ProviderKind::ClaudeCode => &["authentication required"],
    };
    extra.iter().any(|needle| lower.contains(needle))
}

fn rate_limited(lower: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "rate limit",
        "rate_limit",
        "ratelimit",
        "usage limit",
        "hit your limit",
        "limit reached",
        "too many requests",
        "quota",
        "credit balance is too low",
        "resource_exhausted",
        "api error: 429",
        "status 429",
        "http 429",
        "error 429",
        "(429)",
    ];
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

fn unreachable(lower: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "econnrefused",
        "econnreset",
        "enotfound",
        "etimedout",
        "eai_again",
        "getaddrinfo",
        "dns error",
        "could not resolve host",
        "connection refused",
        "connection reset",
        "connection closed before",
        "network error",
        "network is unreachable",
        "fetch failed",
        "error sending request",
        "stream disconnected",
        "unable to connect",
        "failed to connect",
        "timed out",
        "overloaded",
        "service unavailable",
        "bad gateway",
        "api error: 5",
    ];
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

fn signed_out_problem(kind: ProviderKind, detail: &str) -> Problem {
    let (tool, label) = (tool_name(kind), label(kind));
    let params = json!({ "provider": tool });
    Problem::new(ProblemKind::SignedOut, detail)
        .with_subject(tool)
        .with_copy(format!("{label} is signed out"), "Sign in, then send your message again.")
        .with_action(ProblemAction::new("sign_in", "Sign in").with_params(params.clone()))
        .with_secondary(ProblemAction::new("use_another_account", "Use another account").with_params(params))
}

/// A usage limit is the account being refused for now, not a fault: `permission`, subject `rate_limit`.
fn rate_limited_problem(kind: ProviderKind, detail: &str) -> Problem {
    Problem::new(ProblemKind::Permission, detail).with_subject("rate_limit").with_copy(
        format!("{} reached its usage limit", label(kind)),
        "Wait for the limit to reset, or switch to another account or model, then send your message again.",
    )
}

fn network_problem(kind: ProviderKind, detail: &str) -> Problem {
    Problem::new(ProblemKind::Offline, detail)
        .with_subject("network")
        .with_copy(format!("Couldn't reach {}", label(kind)), "Check the connection, then send your message again.")
        .with_action(ProblemAction::retry("Try again"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kind_of(provider: ProviderKind, text: &str) -> Option<(ProblemKind, Option<String>)> {
        classify(provider, text).map(|problem| (problem.kind, problem.subject))
    }
    fn signed_out(tool: &str) -> Option<(ProblemKind, Option<String>)> {
        Some((ProblemKind::SignedOut, Some(tool.into())))
    }

    #[test]
    fn claude_signed_out_texts() {
        for text in [
            "Invalid API key · Please run /login",
            "Failed to authenticate: OAuth token revoked. Please log in again",
            "API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"Invalid bearer token\"}}",
            "OAuth token has expired. Please run /login",
        ] {
            assert_eq!(kind_of(ProviderKind::ClaudeCode, text), signed_out("claude"), "{text}");
        }
    }

    #[test]
    fn codex_signed_out_texts() {
        for text in [
            "workspace routing discovery unauthorized (401)",
            "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.",
            "failed to refresh token: 401 Unauthorized",
        ] {
            assert_eq!(kind_of(ProviderKind::Codex, text), signed_out("codex"), "{text}");
        }
    }

    #[test]
    fn cursor_grok_opencode_pi_and_antigravity_signed_out_texts() {
        assert_eq!(kind_of(ProviderKind::Cursor, "Authentication required"), signed_out("cursor"));
        assert_eq!(kind_of(ProviderKind::Cursor, "[unauthenticated] Not logged in"), signed_out("cursor"));
        assert_eq!(kind_of(ProviderKind::GrokBuild, "Authentication required. Run `grok login`."), signed_out("grok"));
        assert_eq!(kind_of(ProviderKind::Opencode, "ProviderAuthError: Invalid API key"), signed_out("opencode"));
        assert_eq!(kind_of(ProviderKind::Opencode, "APIError: Unauthorized"), signed_out("opencode"));
        assert_eq!(kind_of(ProviderKind::Pi, "No API key found for anthropic"), signed_out("pi"));
        assert_eq!(
            kind_of(
                ProviderKind::Antigravity,
                "Antigravity isn't signed in. Sign in from Settings → Agents → Antigravity, then send your message again."
            ),
            signed_out("antigravity")
        );
        assert_eq!(kind_of(ProviderKind::Antigravity, "authentication failed: credentials missing"), signed_out("antigravity"));
    }

    #[test]
    fn signed_out_offers_sign_in_and_another_account() {
        let problem = classify(ProviderKind::ClaudeCode, "Invalid API key · Please run /login").unwrap();
        let primary = problem.action.unwrap();
        assert_eq!((primary.id.as_str(), primary.label.as_str()), ("sign_in", "Sign in"));
        assert_eq!(primary.params, Some(json!({ "provider": "claude" })));
        assert_eq!(problem.secondary.unwrap().label, "Use another account");
        assert!(problem.retryable);
        // The harness's own words stay as the detail.
        assert_eq!(problem.detail.as_deref(), Some("Invalid API key · Please run /login"));
    }

    #[test]
    fn rate_limits_are_permission_with_a_rate_limit_subject() {
        let limit = Some((ProblemKind::Permission, Some("rate_limit".to_string())));
        assert_eq!(kind_of(ProviderKind::ClaudeCode, "Claude AI usage limit reached|1767225600"), limit);
        assert_eq!(kind_of(ProviderKind::ClaudeCode, "API Error: 429 {\"error\":{\"type\":\"rate_limit_error\"}}"), limit);
        assert_eq!(kind_of(ProviderKind::Codex, "You've hit your usage limit. Upgrade to Pro or try again in 4 days."), limit);
        assert_eq!(kind_of(ProviderKind::Cursor, "[resource_exhausted] Rate limit exceeded"), limit);
        assert_eq!(kind_of(ProviderKind::Opencode, "APIError: 429 Too Many Requests"), limit);
        assert_eq!(kind_of(ProviderKind::GrokBuild, "Too many requests"), limit);
    }

    #[test]
    fn network_failures_are_offline() {
        let network = Some((ProblemKind::Offline, Some("network".to_string())));
        assert_eq!(kind_of(ProviderKind::ClaudeCode, "API Error: Unable to connect to API (ECONNREFUSED)"), network);
        assert_eq!(kind_of(ProviderKind::Codex, "stream disconnected before completion: error sending request for url"), network);
        assert_eq!(kind_of(ProviderKind::Cursor, "fetch failed: getaddrinfo ENOTFOUND api2.cursor.sh"), network);
        assert_eq!(kind_of(ProviderKind::Opencode, "Request timed out"), network);
        assert_eq!(kind_of(ProviderKind::Antigravity, "dns error: could not resolve host"), network);
        let problem = classify(ProviderKind::Codex, "connection reset by peer").unwrap();
        assert_eq!(problem.action.unwrap().id, "retry");
    }

    #[test]
    fn what_kybern_cannot_name_is_not_classified() {
        assert!(classify(ProviderKind::ClaudeCode, "claude: error_during_execution").is_none());
        assert!(classify(ProviderKind::Codex, "turn failed").is_none());
        assert!(classify(ProviderKind::Pi, "tool call schema was invalid").is_none());
    }

    #[test]
    fn driver_errors_are_typed() {
        let old = DriverError::VersionTooOld { found: "1.0".into(), required: "2.0".into() };
        let problem = classify_error(ProviderKind::ClaudeCode, &old).unwrap();
        assert_eq!((problem.kind, problem.subject.as_deref()), (ProblemKind::UpdateNeeded, Some("claude")));
        assert_eq!(problem.action.unwrap().id, "update_agent");
        let missing = classify_error(ProviderKind::Codex, &DriverError::BinaryNotFound("codex".into())).unwrap();
        assert_eq!((missing.kind, missing.subject.as_deref()), (ProblemKind::ToolMissing, Some("codex")));
        assert_eq!(missing.action.unwrap().label, "Install Codex");
        let exited = DriverError::ProcessExited("Invalid API key · Please run /login".into());
        assert_eq!(classify_error(ProviderKind::ClaudeCode, &exited).unwrap().kind, ProblemKind::SignedOut);
        assert!(classify_error(ProviderKind::ClaudeCode, &DriverError::Unsupported("x".into())).is_none());
    }
}
