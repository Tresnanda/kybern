//! Antigravity's account limits: the 5-hour and weekly quota windows.
//!
//! Read with the access token `agy` has already refreshed. Kybern never redeems
//! the refresh token, never carries Google client credentials, and never writes
//! to `agy`'s storage: an expired token reads as stale (`LoginRefresh`) until
//! the next Antigravity turn renews it. The endpoints are undocumented and may
//! change or be refused without notice, so every failure is quiet.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::DateTime;
use kybern_protocol::UsageLimit;
use kybern_protocol::methods::LimitsStale;
use serde_json::{Value, json};

use super::login::read_login;
use crate::claude::UsageUnread;

pub const ANTIGRAVITY_USER_AGENT_PREFIX: &str = "antigravity";
const HOSTS: [&str; 2] = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
const REFRESH_MARGIN_SECONDS: i64 = 60;
const FAILURE_BACKOFF: Duration = Duration::from_secs(2 * 60);
const MAX_BACKOFF: Duration = Duration::from_secs(15 * 60);

/// No requests before this instant after a failed or throttled read.
static PAUSED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq)]
pub struct QuotaBucket {
    pub id: String,
    /// The group's display name: "Gemini", "Claude", "GPT".
    pub family: String,
    pub window: QuotaWindow,
    /// 0.0 to 1.0.
    pub used: f64,
    pub resets_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaWindow {
    /// `5h`
    Session,
    /// `weekly`
    Week,
}

impl QuotaWindow {
    fn minutes(self) -> u64 {
        match self {
            QuotaWindow::Session => 300,
            QuotaWindow::Week => 10080,
        }
    }

    fn label(self) -> &'static str {
        match self {
            QuotaWindow::Session => "5-hour",
            QuotaWindow::Week => "Weekly",
        }
    }
}

/// What one successful read returns.
#[derive(Debug, Clone, Default)]
pub struct QuotaReading {
    pub buckets: Vec<QuotaBucket>,
    pub plan: Option<String>,
}

fn reset_seconds(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_str).and_then(|text| DateTime::parse_from_rfc3339(text).ok()).map(|at| at.timestamp())
}

/// `loadCodeAssist`: the project and the plan.
pub fn parse_load_code_assist(body: &Value) -> (Option<String>, Option<String>) {
    let project = body
        .get("cloudaicompanionProject")
        .and_then(|project| project.as_str().or_else(|| project.get("id").and_then(Value::as_str)))
        .map(str::trim)
        .filter(|project| !project.is_empty())
        .map(str::to_string);
    let tier = ["/paidTier/id", "/currentTier/id"]
        .iter()
        .find_map(|pointer| body.pointer(pointer).and_then(Value::as_str))
        .filter(|id| !id.is_empty());
    (project, tier.map(plan_name))
}

/// `g1-plus-tier` reads as "Google AI Plus"; an unknown id is prettified.
pub fn plan_name(tier_id: &str) -> String {
    let core = tier_id.trim().trim_end_matches("-tier");
    let core = core.strip_prefix("g1-").unwrap_or(core);
    let words = |text: &str| -> String {
        text.split(['-', '_', ' '])
            .filter(|word| !word.is_empty())
            .map(|word| {
                let mut chars = word.chars();
                chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" ")
    };
    match core {
        "free" | "standard" | "legacy" => format!("Google AI {}", words(core)).replace("Standard", "Free"),
        "plus" | "pro" | "ultra" => format!("Google AI {}", words(core)),
        other => words(other),
    }
}

/// `retrieveUserQuotaSummary`: `{groups:[{displayName, buckets:[{bucketId, window, resetTime, remainingFraction}]}]}`.
pub fn parse_quota_summary(body: &Value) -> Vec<QuotaBucket> {
    let mut buckets = Vec::new();
    for group in body.get("groups").and_then(Value::as_array).into_iter().flatten() {
        let family =
            group.get("displayName").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()).unwrap_or("Antigravity");
        for bucket in group.get("buckets").and_then(Value::as_array).into_iter().flatten() {
            if bucket.get("disabled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let window = match bucket.get("window").and_then(Value::as_str) {
                Some("5h") => QuotaWindow::Session,
                Some("weekly") => QuotaWindow::Week,
                _ => continue,
            };
            let Some(remaining) = bucket.get("remainingFraction").and_then(Value::as_f64).filter(|value| value.is_finite()) else {
                continue;
            };
            let id = bucket
                .get("bucketId")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| format!("{family}:{}", window.label()));
            buckets.push(QuotaBucket {
                id,
                family: family.to_string(),
                window,
                used: (1.0 - remaining).clamp(0.0, 1.0),
                resets_at: reset_seconds(bucket.get("resetTime")),
            });
        }
    }
    buckets
}

/// `fetchAvailableModels`: `models.<id>.quotaInfo` and `weeklyQuotaInfo`.
fn parse_available_models(body: &Value) -> Vec<QuotaBucket> {
    let mut buckets = Vec::new();
    for (id, model) in body.get("models").and_then(Value::as_object).into_iter().flatten() {
        let family = model.get("displayName").and_then(Value::as_str).unwrap_or(id).to_string();
        for (key, window) in [("quotaInfo", QuotaWindow::Session), ("weeklyQuotaInfo", QuotaWindow::Week)] {
            let Some(info) = model.get(key) else { continue };
            let Some(remaining) = info.get("remainingFraction").and_then(Value::as_f64).filter(|value| value.is_finite()) else { continue };
            buckets.push(QuotaBucket {
                id: format!("{id}:{key}"),
                family: family.clone(),
                window,
                used: (1.0 - remaining).clamp(0.0, 1.0),
                resets_at: reset_seconds(info.get("resetTime")),
            });
        }
    }
    buckets
}

/// Different calls return different groups, so readings merge by bucket id and
/// keep the most-used one.
pub fn merge_buckets(readings: impl IntoIterator<Item = Vec<QuotaBucket>>) -> Vec<QuotaBucket> {
    let mut merged: HashMap<String, QuotaBucket> = HashMap::new();
    for bucket in readings.into_iter().flatten() {
        match merged.get(&bucket.id) {
            Some(existing) if existing.used >= bucket.used => {}
            _ => {
                merged.insert(bucket.id.clone(), bucket);
            }
        }
    }
    merged.into_values().collect()
}

/// Rows for the usage cache: `<family> · 5-hour|Weekly`, the 5-hour windows
/// first, the most used first within a window.
pub fn to_limits(buckets: &[QuotaBucket]) -> Vec<UsageLimit> {
    let mut sorted: Vec<&QuotaBucket> = buckets.iter().collect();
    sorted
        .sort_by(|a, b| a.window.minutes().cmp(&b.window.minutes()).then(b.used.total_cmp(&a.used)).then_with(|| a.family.cmp(&b.family)));
    sorted
        .into_iter()
        .map(|bucket| UsageLimit {
            name: format!("{} · {}", bucket.family, bucket.window.label()),
            used_percent: (bucket.used * 1000.0).round() / 10.0,
            window_minutes: Some(bucket.window.minutes()),
            resets_at: bucket.resets_at,
        })
        .collect()
}

fn paused_until() -> Option<Instant> {
    PAUSED_UNTIL.lock().ok().and_then(|until| *until).filter(|until| Instant::now() < *until)
}

fn pause(wait: Duration) -> Instant {
    let until = Instant::now() + wait.min(MAX_BACKOFF);
    if let Ok(mut paused) = PAUSED_UNTIL.lock() {
        *paused = Some(until);
    }
    until
}

fn clear_pause() {
    if let Ok(mut paused) = PAUSED_UNTIL.lock() {
        *paused = None;
    }
}

fn unread(reason: LimitsStale, detail: impl Into<String>) -> UsageUnread {
    UsageUnread { reason, retry_at: None, detail: detail.into() }
}

fn throttled(until: Instant, detail: String) -> UsageUnread {
    let retry_at = chrono::Duration::from_std(until.saturating_duration_since(Instant::now())).ok().map(|wait| chrono::Utc::now() + wait);
    UsageUnread { reason: LimitsStale::Throttled, retry_at, detail }
}

/// Go's `GOOS/GOARCH` names, which is how `agy` names itself.
fn user_agent(version: &str) -> String {
    let os = if std::env::consts::OS == "macos" { "darwin" } else { std::env::consts::OS };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    };
    format!("{ANTIGRAVITY_USER_AGENT_PREFIX}/{version} {os}/{arch}")
}

async fn agy_version(binary: Option<&PathBuf>) -> String {
    let Ok(binary) = crate::binary::resolve(kybern_protocol::ProviderKind::Antigravity, binary) else { return "1.4.12".into() };
    crate::binary::version_of(&binary, &["--version"])
        .await
        .and_then(|line| crate::binary::parse_semver(&line).map(|(a, b, c)| format!("{a}.{b}.{c}")))
        .unwrap_or_else(|| "1.4.12".into())
}

enum Failure {
    Status(reqwest::StatusCode, Option<String>),
    Network(String),
}

async fn post(client: &reqwest::Client, url: String, token: &str, agent: &str, body: &Value) -> Result<Value, Failure> {
    let response = client
        .post(url)
        .bearer_auth(token)
        .header("User-Agent", agent)
        .header("Accept", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|error| Failure::Network(error.without_url().to_string()))?;
    let status = response.status();
    if !status.is_success() {
        let retry_after = response.headers().get("retry-after").and_then(|value| value.to_str().ok()).map(str::to_string);
        return Err(Failure::Status(status, retry_after));
    }
    response.json::<Value>().await.map_err(|_| Failure::Network("an answer that was not JSON".into()))
}

/// Read the account's quota windows. `Err` keeps the last values and says why.
pub async fn read_account_usage(
    home: &Path,
    binary: Option<&PathBuf>,
    env: &BTreeMap<String, String>,
) -> Result<(Vec<UsageLimit>, Option<String>), UsageUnread> {
    if let Some(until) = paused_until() {
        return Err(throttled(until, "Antigravity limit reads are paused after the last one failed".into()));
    }
    // A key from the environment has no plan limits to read.
    let home = env.get("HOME").or_else(|| env.get("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| home.to_path_buf());
    let Some(login) = read_login(Some(&home)).await else {
        return Err(unread(LimitsStale::Unavailable, "no Antigravity login found"));
    };
    if login.expires_within(chrono::Duration::seconds(REFRESH_MARGIN_SECONDS)) {
        return Err(unread(LimitsStale::LoginRefresh, "the Antigravity login is due for a refresh; the next Antigravity turn renews it"));
    }
    let agent = user_agent(&agy_version(binary).await);
    let result = tokio::time::timeout(TOTAL_TIMEOUT, read_with_token(login.access_token(), &agent)).await;
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(_) => Err(Failure::Network("the read timed out".into())),
    };
    match outcome {
        Ok(reading) => {
            clear_pause();
            let limits = to_limits(&reading.buckets);
            if limits.is_empty() {
                pause(FAILURE_BACKOFF);
                return Err(unread(LimitsStale::Unavailable, "Antigravity reported no quota windows"));
            }
            Ok((limits, reading.plan))
        }
        Err(Failure::Status(status, retry_after)) if status == reqwest::StatusCode::TOO_MANY_REQUESTS => {
            let wait = retry_after
                .as_deref()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(FAILURE_BACKOFF);
            Err(throttled(pause(wait), "Google throttled the Antigravity limits read".into()))
        }
        Err(Failure::Status(status, _)) if status == reqwest::StatusCode::UNAUTHORIZED => {
            pause(FAILURE_BACKOFF);
            Err(unread(LimitsStale::LoginRefresh, "Google refused the stored Antigravity token; the next Antigravity turn renews it"))
        }
        Err(Failure::Status(status, _)) => {
            pause(FAILURE_BACKOFF);
            Err(unread(LimitsStale::Unavailable, format!("the Antigravity limits endpoint answered {status}")))
        }
        Err(Failure::Network(detail)) => {
            pause(FAILURE_BACKOFF);
            Err(unread(LimitsStale::Unavailable, format!("the Antigravity limits endpoint failed: {detail}")))
        }
    }
}

async fn read_with_token(token: &str, agent: &str) -> Result<QuotaReading, Failure> {
    let client = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build().map_err(|error| Failure::Network(error.to_string()))?;
    // A generic User-Agent gets an answer with no project.
    let loaded =
        post(&client, format!("{}/v1internal:loadCodeAssist", HOSTS[1]), token, agent, &json!({"metadata": {"ideType": "ANTIGRAVITY"}}))
            .await?;
    let (project, plan) = parse_load_code_assist(&loaded);
    let Some(project) = project else { return Err(Failure::Network("no Antigravity project for this account".into())) };
    let body = json!({"project": project});
    let (daily, production) = tokio::join!(
        post(&client, format!("{}/v1internal:retrieveUserQuotaSummary", HOSTS[0]), token, agent, &body),
        post(&client, format!("{}/v1internal:retrieveUserQuotaSummary", HOSTS[1]), token, agent, &body),
    );
    let mut failure = None;
    let mut readings = Vec::new();
    for result in [daily, production] {
        match result {
            Ok(body) => readings.push(parse_quota_summary(&body)),
            Err(error) => failure = Some(error),
        }
    }
    let mut buckets = merge_buckets(readings);
    if buckets.is_empty() {
        match post(&client, format!("{}/v1internal:fetchAvailableModels", HOSTS[1]), token, agent, &body).await {
            Ok(body) => buckets = merge_buckets([parse_available_models(&body)]),
            Err(error) => return Err(failure.unwrap_or(error)),
        }
    }
    Ok(QuotaReading { buckets, plan })
}
