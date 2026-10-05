//! Claude plan limits from Anthropic's OAuth usage endpoint.
//!
//! `GET https://api.anthropic.com/api/oauth/usage` with Claude Code's own
//! access token returns the session (5-hour) window, the weekly window, and
//! per-model weekly windows. One HTTPS request (about 0.6 s) replaces starting
//! a Claude Code process for `/usage`, which stays as the fallback.
//!
//! The token is read, never refreshed: Anthropic rotates the single-use refresh
//! token on every redemption, so only Claude Code may redeem it. While the
//! login is due for a refresh the caller keeps its last values; the next
//! session refreshes the login. A 429 pauses reads for its `Retry-After`.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use kybern_protocol::UsageLimit;
use serde_json::Value;

use crate::ProbeContext;

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_BACKOFF: Duration = Duration::from_secs(5 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);

/// No requests before this instant after Anthropic throttled one.
static PAUSED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

pub(crate) enum OauthUsage {
    Read {
        limits: Vec<UsageLimit>,
        plan: Option<String>,
    },
    /// Throttled or the login is due for a refresh: keep the last values and
    /// do not try another way, which would hit the same limit or rotate tokens.
    Wait,
    /// No usable login or an unexpected answer: another reader may work.
    Unavailable,
}

struct Login {
    access_token: String,
    plan: Option<String>,
    has_profile_scope: bool,
}

/// The Keychain item may hold the JSON itself or its hex encoding.
fn decode_login(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        return Some(value);
    }
    let decoded = (0..text.len())
        .step_by(2)
        .map(|index| text.get(index..index + 2).and_then(|pair| u8::from_str_radix(pair, 16).ok()))
        .collect::<Option<Vec<u8>>>()?;
    serde_json::from_slice(&decoded).ok()
}

/// "max" + "default_claude_max_20x" reads as "Max (20x)".
fn plan_name(subscription: Option<&str>, tier: Option<&str>) -> Option<String> {
    let subscription = subscription.filter(|value| !value.is_empty())?;
    let mut name = subscription[..1].to_uppercase() + &subscription[1..];
    if let Some(multiple) = tier
        .and_then(|tier| tier.rsplit('_').next())
        .filter(|part| part.ends_with('x') && part[..part.len() - 1].chars().all(|c| c.is_ascii_digit()) && part.len() > 1)
    {
        name.push_str(&format!(" ({multiple})"));
    }
    Some(name)
}

fn login(value: &Value) -> Option<Login> {
    let oauth = value.get("claudeAiOauth")?;
    let access_token = oauth.get("accessToken")?.as_str().filter(|token| !token.is_empty())?.to_string();
    let scopes: Vec<&str> = match oauth.get("scopes") {
        Some(Value::Array(scopes)) => scopes.iter().filter_map(Value::as_str).collect(),
        _ => oauth.get("scope").and_then(Value::as_str).map(|scope| scope.split_whitespace().collect()).unwrap_or_default(),
    };
    Some(Login {
        access_token,
        plan: plan_name(oauth.get("subscriptionType").and_then(Value::as_str), oauth.get("rateLimitTier").and_then(Value::as_str)),
        has_profile_scope: scopes.is_empty() || scopes.contains(&"user:profile"),
    })
}

fn paused() -> bool {
    PAUSED_UNTIL.lock().ok().and_then(|until| *until).is_some_and(|until| Instant::now() < until)
}

fn pause(retry_after: Option<&str>) {
    let wait =
        retry_after.and_then(|value| value.trim().parse::<u64>().ok()).map(Duration::from_secs).unwrap_or(DEFAULT_BACKOFF).min(MAX_BACKOFF);
    tracing::debug!(seconds = wait.as_secs(), "Anthropic throttled the Claude usage read; pausing");
    if let Ok(mut until) = PAUSED_UNTIL.lock() {
        *until = Some(Instant::now() + wait);
    }
}

pub(crate) async fn read(context: &ProbeContext) -> OauthUsage {
    if paused() {
        return OauthUsage::Wait;
    }
    let Some(login) = crate::claude_config::stored_login(context).await.as_deref().and_then(decode_login).as_ref().and_then(login) else {
        return OauthUsage::Unavailable;
    };
    if !login.has_profile_scope {
        // An inference-only token (`claude setup-token`) cannot read usage.
        return OauthUsage::Unavailable;
    }
    if crate::claude_config::login_needs_refresh(context).await {
        return OauthUsage::Wait;
    }
    let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(8)).build() else { return OauthUsage::Unavailable };
    let response = match client
        .get(USAGE_URL)
        .bearer_auth(&login.access_token)
        .header("Accept", "application/json")
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-code/2.1.69")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            tracing::debug!(%error, "Claude usage endpoint unreachable");
            return OauthUsage::Unavailable;
        }
    };
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        pause(response.headers().get("retry-after").and_then(|value| value.to_str().ok()));
        return OauthUsage::Wait;
    }
    if !status.is_success() {
        tracing::debug!(%status, "Claude usage request failed");
        return OauthUsage::Unavailable;
    }
    let Ok(body) = response.json::<Value>().await else { return OauthUsage::Unavailable };
    let limits = parse_usage(&body);
    if limits.is_empty() {
        return OauthUsage::Unavailable;
    }
    OauthUsage::Read { limits, plan: login.plan }
}

fn reset_seconds(value: &Value) -> Option<i64> {
    value.as_str().and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok()).map(|at| at.timestamp())
}

/// Names match `/usage` (see `claude::classify_usage_limit`) so a live read,
/// an in-turn report and a fallback read describe the same rows. Per-model
/// weeklies carry no window so they never merge with the all-models week.
fn parse_usage(body: &Value) -> Vec<UsageLimit> {
    let mut limits = Vec::new();
    let mut window = |name: String, value: &Value, window_minutes: Option<u64>, percent_key: &str| {
        let Some(used_percent) = value.get(percent_key).and_then(Value::as_f64).filter(|value| value.is_finite()) else { return };
        limits.push(UsageLimit { name, used_percent, window_minutes, resets_at: value.get("resets_at").and_then(reset_seconds) });
    };
    window("Current session".into(), &body["five_hour"], Some(300), "utilization");
    window("This week".into(), &body["seven_day"], Some(10080), "utilization");
    let mut models = Vec::new();
    for entry in body.get("limits").and_then(Value::as_array).into_iter().flatten() {
        if entry.get("kind").and_then(Value::as_str) != Some("weekly_scoped") {
            continue;
        }
        let Some(model) = entry.pointer("/scope/model/display_name").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty())
        else {
            continue;
        };
        if models.iter().any(|seen: &String| seen == model) {
            continue;
        }
        models.push(model.to_string());
        window(format!("{model} this week"), entry, None, "percent");
    }
    for (model, key) in [("Opus", "seven_day_opus"), ("Sonnet", "seven_day_sonnet")] {
        if !models.iter().any(|seen| seen == model) {
            window(format!("{model} this week"), &body[key], None, "utilization");
        }
    }
    limits
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn usage_maps_session_week_and_model_weeks() {
        let limits = parse_usage(&json!({
            "five_hour": { "utilization": 22.0, "resets_at": "2026-10-05T09:49:59.699314+00:00" },
            "seven_day": { "utilization": 33.0, "resets_at": "2026-10-10T12:59:59+00:00" },
            "seven_day_opus": null,
            "seven_day_sonnet": { "utilization": 4.0, "resets_at": null },
            "limits": [
                { "kind": "session", "percent": 22 },
                { "kind": "weekly_scoped", "percent": 2, "resets_at": "2026-10-10T12:59:59+00:00", "scope": { "model": { "display_name": "Fable" } } }
            ]
        }));
        let names: Vec<_> = limits.iter().map(|limit| limit.name.as_str()).collect();
        assert_eq!(names, ["Current session", "This week", "Fable this week", "Sonnet this week"]);
        assert_eq!(limits[0].window_minutes, Some(300));
        assert_eq!(limits[0].resets_at, Some(1_791_193_799));
        assert_eq!(limits[2].window_minutes, None, "model weeks never merge with the all-models week");
        assert_eq!(limits[3].resets_at, None);
    }

    #[test]
    fn plan_names_include_the_tier_multiple() {
        assert_eq!(plan_name(Some("max"), Some("default_claude_max_20x")).as_deref(), Some("Max (20x)"));
        assert_eq!(plan_name(Some("pro"), Some("default_claude_pro")).as_deref(), Some("Pro"));
        assert_eq!(plan_name(None, Some("default_claude_max_5x")), None);
    }

    #[test]
    fn keychain_logins_decode_from_json_or_hex() {
        let json = br#"{"claudeAiOauth":{"accessToken":"t","scopes":["user:inference"]}}"#;
        let hex: String = json.iter().map(|byte| format!("{byte:02x}")).collect();
        for bytes in [json.to_vec(), hex.into_bytes()] {
            let login = login(&decode_login(&bytes).unwrap()).unwrap();
            assert_eq!(login.access_token, "t");
            assert!(!login.has_profile_scope);
        }
    }
}
