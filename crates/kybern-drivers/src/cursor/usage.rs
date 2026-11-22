//! Cursor plan usage, read from Cursor's dashboard service with the SDK login.
//!
//! The SDK exposes per-agent token usage only. The plan meters Cursor shows in
//! its own settings (Auto + Composer and API, per billing cycle) come from
//! `aiserver.v1.DashboardService/GetCurrentPeriodUsage`, which accepts the
//! short-lived access token the SDK itself obtains by exchanging its API key at
//! `/auth/exchange_user_api_key`. Both calls are plain HTTPS, so a read costs no
//! Node process and no model turn.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use kybern_protocol::UsageLimit;
use serde_json::Value;

const DEFAULT_BACKEND: &str = "https://api2.cursor.sh";

/// What Cursor reports for the current billing cycle.
#[derive(Debug, Clone)]
pub struct CursorAccountUsage {
    pub limits: Vec<UsageLimit>,
    /// Plan name as Cursor shows it, e.g. "Pro+".
    pub plan: Option<String>,
}

struct Credentials {
    api_key: String,
    backend: String,
}

/// Access tokens last about an hour. Reuse one until shortly before it expires
/// so a refresh every minute costs one request instead of two.
struct CachedToken {
    api_key: String,
    token: String,
    expires_at: i64,
}

static TOKEN: Mutex<Option<CachedToken>> = Mutex::new(None);

fn env(env: &BTreeMap<String, String>, name: &str) -> Option<String> {
    env.get(name).cloned().or_else(|| std::env::var(name).ok()).map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

/// `CURSOR_API_KEY` wins over the saved SDK login, matching the session host.
fn credentials(environment: &BTreeMap<String, String>) -> Option<Credentials> {
    let backend_override = env(environment, "CURSOR_BACKEND_URL");
    if let Some(api_key) = env(environment, "CURSOR_API_KEY") {
        return Some(Credentials { api_key, backend: backend_override.unwrap_or_else(|| DEFAULT_BACKEND.into()) });
    }
    let path = env(environment, "KYBERN_CURSOR_AUTH_FILE").map(PathBuf::from).or_else(|| {
        env(environment, "HOME").or_else(|| env(environment, "USERPROFILE")).map(|home| PathBuf::from(home).join(".cursor/sdk/auth.json"))
    })?;
    let saved: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let api_key = saved.get("apiKey").and_then(Value::as_str).filter(|key| !key.is_empty())?.to_string();
    let expires = saved.get("apiKeyExpiresAtMs").and_then(Value::as_i64);
    if expires.is_some_and(|ms| ms <= chrono::Utc::now().timestamp_millis()) {
        return None;
    }
    let backend = backend_override
        .or_else(|| saved.get("backendUrl").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| DEFAULT_BACKEND.into());
    Some(Credentials { api_key, backend: backend.trim_end_matches('/').to_string() })
}

fn token_expiry(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?.get("exp")?.as_i64()
}

async fn access_token(client: &reqwest::Client, credentials: &Credentials) -> Option<String> {
    let now = chrono::Utc::now().timestamp();
    if let Some(cached) = TOKEN.lock().ok()?.as_ref()
        && cached.api_key == credentials.api_key
        && cached.expires_at - 120 > now
    {
        return Some(cached.token.clone());
    }
    let response = client
        .post(format!("{}/auth/exchange_user_api_key", credentials.backend))
        .bearer_auth(&credentials.api_key)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        tracing::debug!(status = %response.status(), "Cursor declined the API key exchange for a usage read");
        return None;
    }
    let token = response.json::<Value>().await.ok()?.get("accessToken")?.as_str()?.to_string();
    let expires_at = token_expiry(&token).unwrap_or(now + 600);
    if let Ok(mut cached) = TOKEN.lock() {
        *cached = Some(CachedToken { api_key: credentials.api_key.clone(), token: token.clone(), expires_at });
    }
    Some(token)
}

async fn dashboard(client: &reqwest::Client, credentials: &Credentials, token: &str, method: &str) -> Result<Value, reqwest::StatusCode> {
    let response = client
        .post(format!("{}/aiserver.v1.DashboardService/{method}", credentials.backend))
        .bearer_auth(token)
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .body("{}")
        .send()
        .await
        .map_err(|_| reqwest::StatusCode::SERVICE_UNAVAILABLE)?;
    let status = response.status();
    if !status.is_success() {
        return Err(status);
    }
    response.json::<Value>().await.map_err(|_| reqwest::StatusCode::UNPROCESSABLE_ENTITY)
}

/// Read the current billing cycle's plan usage. `None` when Cursor is not
/// signed in through the SDK or the service cannot be reached; the caller keeps
/// whatever it showed before.
pub async fn read_account_usage(environment: &BTreeMap<String, String>) -> Option<CursorAccountUsage> {
    let credentials = credentials(environment)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().ok()?;
    let mut token = access_token(&client, &credentials).await?;
    let usage = match dashboard(&client, &credentials, &token, "GetCurrentPeriodUsage").await {
        Ok(usage) => usage,
        Err(reqwest::StatusCode::UNAUTHORIZED) => {
            // The cached token was revoked early. Exchange once more.
            if let Ok(mut cached) = TOKEN.lock() {
                *cached = None;
            }
            token = access_token(&client, &credentials).await?;
            dashboard(&client, &credentials, &token, "GetCurrentPeriodUsage").await.ok()?
        }
        Err(status) => {
            tracing::debug!(%status, "Cursor usage read failed");
            return None;
        }
    };
    let plan = dashboard(&client, &credentials, &token, "GetPlanInfo")
        .await
        .ok()
        .and_then(|info| info.pointer("/planInfo/planName").and_then(Value::as_str).map(str::to_string));
    let limits = parse_period_usage(&usage);
    (!limits.is_empty()).then_some(CursorAccountUsage { limits, plan })
}

/// Map a `GetCurrentPeriodUsage` response to the meters Cursor shows:
/// Auto + Composer, API, and Overall (`totalPercentUsed`), all resetting at the
/// end of the billing cycle and clamped to 0..=100. Unified plans report their
/// single allowance as both `totalPercentUsed` and `autoPercentUsed` at the same
/// value, so keep one meter there. Older plans without percentages fall back to
/// included spend.
fn parse_period_usage(value: &Value) -> Vec<UsageLimit> {
    let millis = |key: &str| value.get(key).and_then(|v| v.as_str().and_then(|s| s.parse::<i64>().ok()).or_else(|| v.as_i64()));
    let (start, end) = (millis("billingCycleStart"), millis("billingCycleEnd"));
    let window_minutes = start.zip(end).and_then(|(start, end)| u64::try_from((end - start) / 60_000).ok()).filter(|&minutes| minutes > 0);
    let resets_at = end.map(|ms| ms / 1000);
    let plan = &value["planUsage"];
    let number = |key: &str| plan.get(key).and_then(Value::as_f64).filter(|value| value.is_finite());
    let percent = |key: &str| number(key).map(|value| value.clamp(0.0, 100.0));
    let limit = |name: &str, used_percent: f64| UsageLimit {
        name: name.into(),
        used_percent: used_percent.clamp(0.0, 100.0),
        window_minutes,
        resets_at,
    };
    let auto = percent("autoPercentUsed");
    let api = percent("apiPercentUsed");
    let total = percent("totalPercentUsed");
    let mut limits = Vec::new();
    if let Some(auto) = auto {
        limits.push(limit("Auto + Composer", auto));
    }
    if let Some(api) = api {
        limits.push(limit("API", api));
    }
    if let Some(total) = total
        && !(api.is_none() && auto == Some(total))
    {
        limits.push(limit("Overall", total));
    }
    if limits.is_empty()
        && let (Some(spent), Some(cap)) = (number("totalSpend"), number("limit"))
        && cap > 0.0
    {
        limits.push(limit("Included usage", spent / cap * 100.0));
    }
    limits
}

#[cfg(test)]
mod tests {
    use super::parse_period_usage;
    use serde_json::json;

    #[test]
    fn period_usage_maps_auto_and_api_meters_to_the_billing_cycle() {
        let limits = parse_period_usage(&json!({
            "billingCycleStart": "1790079813000",
            "billingCycleEnd": "1792671813000",
            "planUsage": { "totalSpend": 2454, "limit": 7000, "autoPercentUsed": 1.74, "apiPercentUsed": 13.13 }
        }));
        assert_eq!(limits.len(), 2);
        assert_eq!(limits[0].name, "Auto + Composer");
        assert_eq!(limits[1].name, "API");
        assert!((limits[1].used_percent - 13.13).abs() < 1e-9);
        assert_eq!(limits[0].window_minutes, Some(43_200));
        assert_eq!(limits[0].resets_at, Some(1_792_671_813));
    }

    #[test]
    fn period_usage_falls_back_to_included_spend() {
        let limits = parse_period_usage(&json!({ "planUsage": { "totalSpend": 1750, "limit": 7000 } }));
        assert_eq!(limits.len(), 1);
        assert_eq!(limits[0].name, "Included usage");
        assert!((limits[0].used_percent - 25.0).abs() < 1e-9);
        assert!(parse_period_usage(&json!({})).is_empty());
    }

    #[test]
    fn period_usage_supports_total_percent_dedups_unified_plans_and_clamps_bounds() {
        // Unified plan: totalPercentUsed equals autoPercentUsed with no API pool -> one meter.
        let unified = parse_period_usage(&json!({
            "planUsage": { "totalPercentUsed": 1.77, "autoPercentUsed": 1.77 }
        }));
        assert_eq!(unified.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["Auto + Composer"]);
        assert!((unified[0].used_percent - 1.77).abs() < 1e-9);

        // Total-only plan uses totalPercentUsed rather than falling back to totalSpend/limit.
        let total_only = parse_period_usage(&json!({
            "planUsage": { "totalPercentUsed": 42.5, "totalSpend": 9000, "limit": 7000 }
        }));
        assert_eq!(total_only.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["Overall"]);
        assert!((total_only[0].used_percent - 42.5).abs() < 1e-9);

        // API + total keeps both meters, and out-of-range percentages clamp to 0..=100.
        let clamped = parse_period_usage(&json!({
            "planUsage": { "autoPercentUsed": -5.0, "apiPercentUsed": 140.0, "totalPercentUsed": 125.0 }
        }));
        assert_eq!(clamped.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["Auto + Composer", "API", "Overall"]);
        assert_eq!(clamped[0].used_percent, 0.0);
        assert_eq!(clamped[1].used_percent, 100.0);
        assert_eq!(clamped[2].used_percent, 100.0);

        // Legacy spend fallback also clamps above 100%.
        let overspent = parse_period_usage(&json!({ "planUsage": { "totalSpend": 9000, "limit": 7000 } }));
        assert_eq!(overspent[0].used_percent, 100.0);
    }
}
