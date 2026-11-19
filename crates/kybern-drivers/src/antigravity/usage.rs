//! Antigravity's account limits: the 5-hour and weekly quota windows.
//!
//! Read with the access token `agy` has already refreshed. Kybern never redeems
//! the refresh token, never carries Google client credentials, and never writes
//! to `agy`'s storage: an expired token reads as stale (`LoginRefresh`) until
//! the next Antigravity turn renews it. The endpoints are undocumented and may
//! change or be refused without notice, so every failure is quiet.
//!
//! Google answers the quota summary per client: the plain `antigravity/<version>`
//! User-Agent gets only the "Claude and GPT models" group, the CLI's own
//! `antigravity/cli/<version>` gets the Gemini groups too. When a summary still has
//! no Gemini group, `agy -p "/usage"` (no agent turn, no quota spent) fills it in.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::DateTime;
use kybern_protocol::UsageLimit;
use kybern_protocol::methods::LimitsStale;
use kybern_protocol::process::NoWindow;
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
/// `agy -p "/usage"` answers in 2-3 s.
const AGY_USAGE_TIMEOUT: Duration = Duration::from_secs(8);
/// A `/usage` answer is reused this long, so reads never start `agy` more often than this.
const AGY_USAGE_FRESH: Duration = Duration::from_secs(60);

/// No requests before this instant after a failed or throttled read.
static PAUSED_UNTIL: Mutex<Option<Instant>> = Mutex::new(None);
/// The last `agy /usage` answer, for which binary, and when it was read.
static AGY_USAGE: Mutex<Option<(PathBuf, Instant, Vec<QuotaBucket>)>> = Mutex::new(None);

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

/// When a window resets. A window with nothing used has not started: Google then
/// answers the time of the read plus the window (`now + 5h`, `now + 7d`), a new
/// one on every read, so it says nothing and is left out.
fn reset_seconds(value: Option<&Value>, used: f64) -> Option<i64> {
    if used <= 0.0 {
        return None;
    }
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

/// The field names of one shape of group list.
struct GroupKeys {
    name: &'static str,
    id: &'static str,
    remaining: &'static str,
    reset: &'static str,
}

fn parse_groups(groups: Option<&Value>, keys: &GroupKeys) -> Vec<QuotaBucket> {
    let mut buckets = Vec::new();
    for group in groups.and_then(Value::as_array).into_iter().flatten() {
        let family = group.get(keys.name).and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()).unwrap_or("Antigravity");
        for bucket in group.get("buckets").and_then(Value::as_array).into_iter().flatten() {
            if bucket.get("disabled").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let window = match bucket.get("window").and_then(Value::as_str) {
                Some("5h") => QuotaWindow::Session,
                Some("weekly") => QuotaWindow::Week,
                _ => continue,
            };
            let Some(remaining) = bucket.get(keys.remaining).and_then(Value::as_f64).filter(|value| value.is_finite()) else {
                continue;
            };
            let id =
                bucket.get(keys.id).and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("{family}:{}", window.label()));
            let used = (1.0 - remaining).clamp(0.0, 1.0);
            buckets.push(QuotaBucket {
                id,
                family: family.to_string(),
                window,
                used,
                resets_at: reset_seconds(bucket.get(keys.reset), used),
            });
        }
    }
    buckets
}

/// `retrieveUserQuotaSummary`: `{groups:[{displayName, buckets:[{bucketId, window, resetTime, remainingFraction}]}]}`.
pub fn parse_quota_summary(body: &Value) -> Vec<QuotaBucket> {
    parse_groups(body.get("groups"), &GroupKeys { name: "displayName", id: "bucketId", remaining: "remainingFraction", reset: "resetTime" })
}

/// `agy -p "/usage" --output-format json`: `command.data.groups[].buckets[]`
/// with `name`, `id`, `window`, `remaining_fraction` and `reset_time`.
pub fn parse_agy_usage(body: &Value) -> Vec<QuotaBucket> {
    parse_groups(
        body.pointer("/command/data/groups"),
        &GroupKeys { name: "name", id: "id", remaining: "remaining_fraction", reset: "reset_time" },
    )
}

/// Whether the readings include the Gemini models' own group ("Gemini Models"),
/// which the plain User-Agent never gets. "Gemini 4 Argon" is its own quota.
fn has_gemini(buckets: &[QuotaBucket]) -> bool {
    buckets.iter().any(|bucket| {
        let family = bucket.family.to_lowercase();
        family.contains("gemini") && !family.contains("argon")
    })
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

/// Where a group sits in the list: the Gemini models, then Gemini 4 Argon, then Claude and GPT.
fn family_rank(family: &str) -> u8 {
    let family = family.to_lowercase();
    match (family.contains("gemini"), family.contains("argon")) {
        (true, false) => 0,
        (true, true) => 1,
        _ if family.contains("claude") || family.contains("gpt") => 2,
        _ => 3,
    }
}

/// Rows for the usage cache: `<group> · 5-hour|Weekly`, a group's 5-hour window
/// before its weekly one, the groups in `family_rank` order.
pub fn to_limits(buckets: &[QuotaBucket]) -> Vec<UsageLimit> {
    let mut sorted: Vec<&QuotaBucket> = buckets.iter().collect();
    sorted.sort_by(|a, b| {
        family_rank(&a.family)
            .cmp(&family_rank(&b.family))
            .then_with(|| a.family.cmp(&b.family))
            .then(a.window.minutes().cmp(&b.window.minutes()))
            .then_with(|| a.id.cmp(&b.id))
    });
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

/// How the `agy` CLI names itself: `antigravity/cli/<version> <GOOS>/<GOARCH>`.
/// Google gives the Gemini quota groups only to this client name.
pub(crate) fn user_agent(version: &str) -> String {
    let os = if std::env::consts::OS == "macos" { "darwin" } else { std::env::consts::OS };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => other,
    };
    format!("{ANTIGRAVITY_USER_AGENT_PREFIX}/cli/{version} {os}/{arch}")
}

/// Google refuses the CLI name below 1.4, so the fallback is a version it accepts.
const FALLBACK_VERSION: &str = "1.4.12";

async fn agy_version(binary: Option<&PathBuf>) -> String {
    let Ok(binary) = crate::binary::resolve(kybern_protocol::ProviderKind::Antigravity, binary) else { return FALLBACK_VERSION.into() };
    crate::binary::version_of(&binary, &["--version"])
        .await
        .and_then(|line| crate::binary::parse_semver(&line).map(|(a, b, c)| format!("{a}.{b}.{c}")))
        .unwrap_or_else(|| FALLBACK_VERSION.into())
}

/// `agy -p "/usage" --output-format json`: Google's own answer for the account,
/// with no agent turn and no quota spent. Reused for `AGY_USAGE_FRESH`.
pub(crate) async fn read_agy_usage(binary: Option<&PathBuf>, env: &BTreeMap<String, String>, home: &Path) -> Vec<QuotaBucket> {
    let Ok(binary) = crate::binary::resolve(kybern_protocol::ProviderKind::Antigravity, binary) else { return Vec::new() };
    if let Some((cached_for, at, buckets)) = AGY_USAGE.lock().ok().and_then(|cached| cached.clone())
        && cached_for == binary
        && at.elapsed() < AGY_USAGE_FRESH
    {
        return buckets;
    }
    let mut command = crate::binary::command(&binary).no_window();
    command.args(["-p", "/usage", "--output-format", "json"]).current_dir(home).envs(env);
    let Ok(Ok(output)) = tokio::time::timeout(AGY_USAGE_TIMEOUT, crate::process_tree::output(&mut command)).await else {
        return Vec::new();
    };
    let buckets = if output.status.success() {
        serde_json::from_slice::<Value>(&output.stdout).map(|body| parse_agy_usage(&body)).unwrap_or_default()
    } else {
        Vec::new()
    };
    if !buckets.is_empty()
        && let Ok(mut cached) = AGY_USAGE.lock()
    {
        *cached = Some((binary, Instant::now(), buckets.clone()));
    }
    buckets
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
        Ok(mut reading) => {
            clear_pause();
            // The summary came without the Gemini group: ask `agy` itself.
            if !has_gemini(&reading.buckets) {
                let from_agy = read_agy_usage(binary, env, &home).await;
                reading.buckets = merge_buckets([std::mem::take(&mut reading.buckets), from_agy]);
            }
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
    let buckets = merge_buckets(readings);
    if buckets.is_empty()
        && let Some(failure) = failure
    {
        return Err(failure);
    }
    Ok(QuotaReading { buckets, plan })
}
