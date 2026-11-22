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
    // A signal stopped the process: that is the cause, whatever its last stderr lines say.
    if let Some(signal) = stopped_by_signal(kind, text) {
        return Some(signal_problem(kind, signal, text));
    }
    let lower = text.to_ascii_lowercase();
    if signed_out(kind, text, &lower) {
        return Some(signed_out_problem(kind, text));
    }
    if rate_limited(&lower) {
        return Some(rate_limited_problem(kind, text));
    }
    if unreachable(kind, &lower) {
        return Some(network_problem(kind, text));
    }
    None
}

/// What Codex's `codexErrorInfo` says about a failure, before its message text:
/// `Some(problem)` when it names one, `Some(None)` when it names a failure that
/// is none of these (a too-long context, a refused request), so its wording
/// must not be read as one, and `None` when it says nothing (`other`, absent).
fn codex_info_problem(info: &serde_json::Value, text: &str) -> Option<Option<Problem>> {
    let code = match info {
        serde_json::Value::String(code) => code.as_str(),
        serde_json::Value::Object(map) => map.keys().next()?.as_str(),
        _ => return None,
    };
    let status = info.get(code).and_then(|detail| detail.get("httpStatusCode")).and_then(serde_json::Value::as_u64);
    let kind = ProviderKind::Codex;
    Some(match (code, status) {
        ("other", _) => return None,
        ("unauthorized", _) | (_, Some(401)) => Some(signed_out_problem(kind, text)),
        ("usageLimitExceeded" | "rateLimitExceeded", _) | (_, Some(429)) => Some(rate_limited_problem(kind, text)),
        (
            "httpConnectionFailed"
            | "responseStreamConnectionFailed"
            | "responseStreamDisconnected"
            | "responseTooManyFailedAttempts"
            | "serverOverloaded"
            | "internalServerError",
            _,
        ) => Some(network_problem(kind, text)),
        _ => None,
    })
}

/// The problem a failed Codex turn is: its `codexErrorInfo` first, then its text.
pub fn classify_codex(info: Option<&serde_json::Value>, text: &str) -> Option<Problem> {
    match info.and_then(|info| codex_info_problem(info, text)) {
        Some(named) => named,
        None => classify(ProviderKind::Codex, text),
    }
}

/// A Codex turn that said it would retry and then never resumed. A retry is
/// for a connection or service failure, so without a better reading it is one.
pub fn codex_stalled_retry(info: Option<&serde_json::Value>, text: &str) -> Problem {
    classify_codex(info, text).unwrap_or_else(|| network_problem(ProviderKind::Codex, text))
}

/// The problem a harness that stopped by itself is. `cause` is what it said
/// as it went (its stderr, an exit code): read for a known problem, else the
/// harness stopped. Either way `cause` is only the problem's details.
/// `lost_turn`: it stopped in the middle of the person's turn, which then
/// failed; otherwise nothing was lost and the next message starts it again.
pub fn exited_problem(kind: ProviderKind, cause: Option<&str>, lost_turn: bool) -> Problem {
    let cause = cause.map(str::trim).filter(|cause| !cause.is_empty());
    cause.and_then(|cause| classify(kind, cause)).unwrap_or_else(|| {
        let name = label(kind);
        let (title, help) = match (kind, lost_turn) {
            // Antigravity runs one process per message, so it always "stops":
            // what matters is whether the answer was finished.
            (ProviderKind::Antigravity, true) => (
                "Antigravity stopped before it answered".to_string(),
                "Send your message again. If it keeps happening, copy the details and report them.",
            ),
            (ProviderKind::Antigravity, false) => (
                "Antigravity reported an error as it finished".to_string(),
                "Its answer is complete. If it keeps happening, copy the details and report them.",
            ),
            (_, true) => (
                format!("{name} stopped unexpectedly"),
                "Send your message again. If it keeps happening, copy the details and report them.",
            ),
            (_, false) => (
                format!("{name} stopped unexpectedly"),
                "Nothing was lost: your next message starts it again. If it keeps happening, copy the details and report them.",
            ),
        };
        let mut problem =
            Problem::new(ProblemKind::Internal, cause.unwrap_or_default()).with_subject(tool_name(kind)).with_copy(title, help);
        if cause.is_none() {
            problem.detail = None;
        }
        problem
    })
}

/// The problem a `DriverError` that stopped a session means, when it has one.
pub fn classify_error(kind: ProviderKind, error: &DriverError) -> Option<Problem> {
    let detail = error.to_string();
    match error {
        DriverError::VersionTooOld { .. } => Some(update_needed_problem(kind, &detail)),
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
        DriverError::Problem { problem, .. } => Some((**problem).clone()),
        _ => None,
    }
}

/// The installed harness is too old for what Kybern asks of it: update it.
pub fn update_needed_problem(kind: ProviderKind, detail: &str) -> Problem {
    Problem::new(ProblemKind::UpdateNeeded, detail)
        .with_subject(tool_name(kind))
        .with_copy(
            format!("Update {}", label(kind)),
            format!("The installed {} is older than Kybern needs. Update it, then try again.", label(kind)),
        )
        .with_action(
            ProblemAction::new("update_agent", format!("Update {}", label(kind))).with_params(json!({ "provider": tool_name(kind) })),
        )
        .with_secondary(ProblemAction::retry("Check again"))
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

fn unreachable(kind: ProviderKind, lower: &str) -> bool {
    const COMMON: &[&str] = &[
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
    if COMMON.iter().any(|needle| lower.contains(needle)) {
        return true;
    }
    kind == ProviderKind::Cursor && cursor_transport_unreachable(lower)
}

fn cursor_transport_unreachable(lower: &str) -> bool {
    const CURSOR: &[&str] = &[
        "connecterror: [unavailable]",
        "connecterror: [aborted]",
        "connecterror: [deadline_exceeded]",
        "something went wrong communicating with the server",
    ];
    if CURSOR.iter().any(|needle| lower.contains(needle)) {
        return true;
    }
    // Match `cursor/stream.rs`: Cursor's RetriableError is a transport failure except for `[internal]`.
    lower.match_indices("retriableerror:").any(|(idx, matched)| {
        let rest = lower[idx + matched.len()..].trim_start();
        !rest.is_empty() && !rest.starts_with("[internal]")
    })
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
pub(crate) fn rate_limited_problem(kind: ProviderKind, detail: &str) -> Problem {
    Problem::new(ProblemKind::Permission, detail).with_subject("rate_limit").with_copy(
        format!("{} reached its usage limit", label(kind)),
        "Wait for the limit to reset, or switch to another account or model, then send your message again.",
    )
}

/// The harness started but never answered, so Kybern stopped it. Nothing is wrong with the account; sending
/// again starts a new process. Clients word it as the harness stopping before it could answer.
pub fn stalled_start_problem(kind: ProviderKind, detail: &str) -> Problem {
    Problem::new(ProblemKind::Internal, detail)
        .with_subject(tool_name(kind))
        .with_copy(format!("{} didn't start", label(kind)), "It never answered, so Kybern stopped it. Send your message again.")
        .with_action(ProblemAction::retry("Try again"))
}

/// The signal named by a driver's exit text ("Claude Code was stopped by SIGKILL", see `claude::exit_error`).
fn stopped_by_signal(kind: ProviderKind, text: &str) -> Option<&str> {
    let rest = text.trim_start().strip_prefix(label(kind))?.strip_prefix(" was stopped by ")?;
    let signal = rest.split(|c: char| c.is_whitespace()).next().filter(|signal| !signal.is_empty())?;
    (signal.starts_with("SIG") || signal == "signal").then_some(signal)
}

/// Something outside Kybern stopped the harness. A `SIGKILL` nobody asked for is most often the system
/// running out of memory; the conversation is saved either way, so sending again resumes it.
fn signal_problem(kind: ProviderKind, signal: &str, detail: &str) -> Problem {
    let hint = if signal == "SIGKILL" {
        "The system stopped it, often because the computer ran low on memory. Close other apps if you can, then send your message again."
    } else {
        "It stopped unexpectedly. Your conversation is saved; send your message again."
    };
    Problem::new(ProblemKind::Internal, detail)
        .with_subject(tool_name(kind))
        .with_copy(format!("{} stopped unexpectedly", label(kind)), hint)
        .with_action(ProblemAction::retry("Try again"))
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

    /// A signal exit is named for what stopped it, ahead of anything its stderr tail happens to say; the
    /// whole text stays behind Show details.
    #[test]
    fn a_signal_exit_is_an_internal_problem_with_its_stderr_as_detail() {
        let text = "Claude Code was stopped by SIGKILL\nrequest timed out after 401 retries";
        let problem = classify(ProviderKind::ClaudeCode, text).expect("a signal exit has a problem");
        assert_eq!((problem.kind, problem.subject.as_deref()), (ProblemKind::Internal, Some("claude")));
        assert_eq!(problem.detail.as_deref(), Some(text));
        assert_eq!(problem.title.as_deref(), Some("Claude Code stopped unexpectedly"));
        assert!(problem.hint.as_deref().is_some_and(|hint| hint.contains("low on memory")), "{:?}", problem.hint);
        assert_eq!(problem.action.map(|action| action.id).as_deref(), Some("retry"));
        let segv = classify(ProviderKind::ClaudeCode, "Claude Code was stopped by SIGSEGV").unwrap();
        assert!(!segv.hint.as_deref().unwrap_or_default().contains("memory"));
        assert!(classify(ProviderKind::ClaudeCode, "Claude Code was stopped by signal 64").is_some());
        // Only the driver's own exit text, not a sentence that mentions a signal.
        assert_eq!(classify(ProviderKind::ClaudeCode, "the test was stopped by SIGKILL"), None);
        assert_eq!(classify(ProviderKind::Codex, "Claude Code was stopped by SIGKILL"), None);
    }

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
        assert_eq!(kind_of(ProviderKind::Cursor, "Error: ConnectError: [unavailable] transport closed"), network);
        assert_eq!(kind_of(ProviderKind::Cursor, "Error: RetriableError: WritableIterable is closed"), network);
        assert_eq!(kind_of(ProviderKind::Cursor, "Something went wrong communicating with the server. Please try again."), network);
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
        // Cursor transport patterns apply only to Cursor and exclude `[internal]`, matching `cursor/stream.rs`.
        assert!(classify(ProviderKind::Cursor, "Error: RetriableError: [internal] something else").is_none());
        assert!(classify(ProviderKind::Cursor, "Error: ConnectError: [internal] something else").is_none());
        assert!(classify(ProviderKind::ClaudeCode, "Error: RetriableError: WritableIterable is closed").is_none());
        assert!(classify(ProviderKind::Codex, "Error: ConnectError: [unavailable] transport closed").is_none());
        assert!(classify(ProviderKind::Opencode, "Something went wrong communicating with the server. Please try again.").is_none());
    }

    #[test]
    fn codex_error_info_comes_before_the_message_text() {
        let codex = |info: serde_json::Value, text: &str| {
            classify_codex(Some(&info), text).map(|problem| (problem.kind, problem.subject.unwrap_or_default()))
        };
        let limit = Some((ProblemKind::Permission, "rate_limit".to_string()));
        let offline = Some((ProblemKind::Offline, "network".to_string()));
        assert_eq!(codex(json!("unauthorized"), "Request failed"), Some((ProblemKind::SignedOut, "codex".to_string())));
        assert_eq!(codex(json!("usageLimitExceeded"), "Request failed"), limit);
        assert_eq!(codex(json!({ "responseTooManyFailedAttempts": { "httpStatusCode": 429 } }), "exceeded retry limit"), limit);
        assert_eq!(codex(json!({ "responseStreamConnectionFailed": { "httpStatusCode": 401 } }), "x").unwrap().0, ProblemKind::SignedOut);
        assert_eq!(codex(json!({ "httpConnectionFailed": { "httpStatusCode": null } }), "Request failed"), offline);
        // Codex names the failure, so wording that reads as a limit is not one.
        assert_eq!(codex(json!("contextWindowExceeded"), "Token limit reached"), None);
        assert_eq!(codex(json!("badRequest"), "quota field is invalid"), None);
        // `other` or no info: the text decides.
        assert_eq!(codex(json!("other"), "You've hit your usage limit."), limit);
        assert_eq!(classify_codex(None, "connection reset by peer").unwrap().kind, ProblemKind::Offline);
        assert!(classify_codex(None, "turn failed").is_none());
        assert_eq!(codex_stalled_retry(None, "Reconnecting... 5/5").kind, ProblemKind::Offline);
    }

    #[test]
    fn an_exit_is_a_headline_with_the_stderr_as_details() {
        let stderr = "Error loading config.toml: unknown variant `fast` for key model_reasoning_effort";
        let problem = exited_problem(ProviderKind::Codex, Some(stderr), true);
        assert_eq!((problem.kind, problem.subject.as_deref()), (ProblemKind::Internal, Some("codex")));
        assert_eq!(problem.title.as_deref(), Some("Codex stopped unexpectedly"));
        assert!(!problem.title.unwrap().contains("config.toml"));
        assert_eq!(problem.detail.as_deref(), Some(stderr));
        assert!(problem.hint.clone().unwrap().starts_with("Send your message again"));
        // What the stderr says comes first: a signed-out Codex says so.
        assert_eq!(exited_problem(ProviderKind::Codex, Some("Error: not logged in"), true).kind, ProblemKind::SignedOut);
        assert_eq!(exited_problem(ProviderKind::Codex, Some("  "), true).detail, None);
    }

    /// Between turns nothing was lost, so nobody is asked to send again; and
    /// Antigravity, which exits after every message, is told apart by whether
    /// it finished its answer.
    #[test]
    fn an_exit_is_worded_for_what_it_cost() {
        let between = exited_problem(ProviderKind::Codex, Some("Exit code 1"), false);
        assert_eq!(between.title.as_deref(), Some("Codex stopped unexpectedly"));
        assert!(between.hint.unwrap().starts_with("Nothing was lost"));
        let finished = exited_problem(ProviderKind::Antigravity, Some("Exit code 1"), false);
        assert_eq!(finished.title.as_deref(), Some("Antigravity reported an error as it finished"));
        assert!(finished.hint.unwrap().starts_with("Its answer is complete"));
        let lost = exited_problem(ProviderKind::Antigravity, None, true);
        assert_eq!(lost.title.as_deref(), Some("Antigravity stopped before it answered"));
        assert!(!lost.title.unwrap().contains("unexpectedly"));
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
