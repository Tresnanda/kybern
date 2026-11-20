//! Antigravity's account limits: the 5-hour and weekly quota windows.
//!
//! Two reads, tried in this order:
//!
//! 1. **The token `agy` already refreshed.** Kybern reads it (see `login.rs`) and asks
//!    Google's quota endpoints directly. This is the fast path: no process starts.
//! 2. **`agy -p "/usage"`.** Used whenever the fast path has no usable token: it is
//!    expired or about to be, Google refused it (401), or none can be found (on Linux and
//!    Windows `agy` keeps it in the OS keyring, which Kybern doesn't read). `/usage`
//!    starts no agent turn and spends no quota, and `agy` renews its own token as a side
//!    effect, so the next read is fast again. It has no plan name, so the daemon keeps the
//!    last known plan.
//!
//! Kybern never redeems the refresh token, never carries Google client credentials, and
//! never writes to `agy`'s storage. The endpoints are undocumented and may change or be
//! refused without notice, so every failure is quiet.
//!
//! A signed-out `agy` answers `/usage` by opening Google's sign-in page in the browser,
//! so that state is read once and then remembered ([`LimitsStale::SignedOut`], paused for
//! `MAX_BACKOFF`) instead of retried every minute. Where the login can be read and none
//! exists (macOS), `agy` is not started at all.
//!
//! Google answers the quota summary per client: the plain `antigravity/<version>`
//! User-Agent gets only the "Claude and GPT models" group, the CLI's own
//! `antigravity/cli/<version>` gets the Gemini groups too. When a summary still has
//! no Gemini group, `/usage` fills it in.
//!
//! Pauses and the `/usage` cache are kept per account (its home folder and `agy` binary).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
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

/// One Antigravity account: the home folder `agy` keeps its login under, and the binary.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct AccountKey {
    home: PathBuf,
    binary: PathBuf,
}

impl AccountKey {
    pub(crate) fn new(home: &Path, binary: Option<&PathBuf>) -> Self {
        let binary = crate::binary::resolve(kybern_protocol::ProviderKind::Antigravity, binary)
            .ok()
            .or_else(|| binary.cloned())
            .unwrap_or_else(|| PathBuf::from("agy"));
        Self { home: home.to_path_buf(), binary }
    }
}

/// No requests for an account before `until`, after a failed or throttled read.
#[derive(Clone, Copy)]
struct Pause {
    until: Instant,
    /// `agy` is signed out: the pause is lifted as soon as a login can be read.
    signed_out: bool,
}

static PAUSED: LazyLock<Mutex<HashMap<AccountKey, Pause>>> = LazyLock::new(Default::default);
/// The last `agy /usage` answer per account, and when it was read.
static AGY_USAGE: LazyLock<Mutex<HashMap<AccountKey, UsageRead>>> = LazyLock::new(Default::default);
type UsageRead = (Instant, Vec<QuotaBucket>);

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

fn pause_of(key: &AccountKey) -> Option<Pause> {
    let mut paused = PAUSED.lock().ok()?;
    match paused.get(key).copied() {
        Some(pause) if Instant::now() < pause.until => Some(pause),
        Some(_) => {
            paused.remove(key);
            None
        }
        None => None,
    }
}

fn pause(key: &AccountKey, wait: Duration, signed_out: bool) -> Instant {
    let until = Instant::now() + wait.min(MAX_BACKOFF);
    if let Ok(mut paused) = PAUSED.lock() {
        paused.insert(key.clone(), Pause { until, signed_out });
    }
    until
}

fn clear_pause(key: &AccountKey) {
    if let Ok(mut paused) = PAUSED.lock() {
        paused.remove(key);
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

/// What `agy -p "/usage"` came to.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum AgyUsage {
    Read(Vec<QuotaBucket>),
    /// `agy` has no login and asked to sign in.
    SignedOut,
    /// It failed, timed out or answered something else.
    Failed,
}

/// Whether what `agy` wrote says it has no login: it prints "Authentication required"
/// with a sign-in URL and then waits a minute for the browser, so the output is judged
/// as soon as that line arrives rather than at exit.
pub(crate) fn agy_signed_out(stdout: &[u8], stderr: &[u8]) -> bool {
    let text = format!("{}\n{}", String::from_utf8_lossy(stderr), String::from_utf8_lossy(stdout)).to_lowercase();
    text.contains("authentication required") || text.contains("authentication failed or timed out")
}

/// `agy -p "/usage" --output-format json`: Google's own answer for the account,
/// with no agent turn and no quota spent. Reused for `AGY_USAGE_FRESH`.
pub(crate) async fn run_agy_usage(binary: Option<&PathBuf>, env: &BTreeMap<String, String>, home: &Path) -> AgyUsage {
    let key = AccountKey::new(home, binary);
    if let Some((at, buckets)) = AGY_USAGE.lock().ok().and_then(|cached| cached.get(&key).cloned())
        && at.elapsed() < AGY_USAGE_FRESH
    {
        return AgyUsage::Read(buckets);
    }
    let Ok(binary) = crate::binary::resolve(kybern_protocol::ProviderKind::Antigravity, binary) else { return AgyUsage::Failed };
    let mut command = crate::binary::command(&binary).no_window();
    command.args(["-p", "/usage", "--output-format", "json"]).current_dir(home).envs(env);
    let Ok(output) = crate::process_tree::output_within(&mut command, AGY_USAGE_TIMEOUT, agy_signed_out).await else {
        return AgyUsage::Failed;
    };
    let buckets = if output.status.is_some_and(|status| status.success()) {
        serde_json::from_slice::<Value>(&output.stdout).map(|body| parse_agy_usage(&body)).unwrap_or_default()
    } else {
        Vec::new()
    };
    if !buckets.is_empty() {
        if let Ok(mut cached) = AGY_USAGE.lock() {
            cached.insert(key, (Instant::now(), buckets.clone()));
        }
        return AgyUsage::Read(buckets);
    }
    if agy_signed_out(&output.stdout, &output.stderr) { AgyUsage::SignedOut } else { AgyUsage::Failed }
}

/// The buckets of `agy /usage`, empty when it gave none.
pub(crate) async fn read_agy_usage(binary: Option<&PathBuf>, env: &BTreeMap<String, String>, home: &Path) -> Vec<QuotaBucket> {
    match run_agy_usage(binary, env, home).await {
        AgyUsage::Read(buckets) => buckets,
        AgyUsage::SignedOut | AgyUsage::Failed => Vec::new(),
    }
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

/// Whether a missing login means signed out. Where `agy` keeps its token in a store
/// Kybern can't read (the Linux and Windows keyrings), it only means "ask `agy`".
const LOGIN_READABLE: bool = cfg!(target_os = "macos");

/// Read the account's quota windows. `Err` keeps the last values and says why. The
/// plan comes back only from the fast path; the caller keeps the last known one.
pub async fn read_account_usage(
    home: &Path,
    binary: Option<&PathBuf>,
    env: &BTreeMap<String, String>,
) -> Result<(Vec<UsageLimit>, Option<String>), UsageUnread> {
    // A key from the environment has no plan limits to read.
    let home = env.get("HOME").or_else(|| env.get("USERPROFILE")).map(PathBuf::from).unwrap_or_else(|| home.to_path_buf());
    let key = AccountKey::new(&home, binary);
    let mut login = None;
    let mut login_read = false;
    if let Some(pause) = pause_of(&key) {
        if !pause.signed_out {
            return Err(throttled(pause.until, "Antigravity limit reads are paused after the last one failed".into()));
        }
        // Signed out: wait for a login to show up before starting `agy` again.
        login = read_login(Some(&home)).await;
        login_read = true;
        if login.is_none() {
            return Err(unread(LimitsStale::SignedOut, "Antigravity is signed out"));
        }
        clear_pause(&key);
    }
    if !login_read {
        login = read_login(Some(&home)).await;
    }
    let Some(login) = login else {
        if LOGIN_READABLE {
            return Err(unread(LimitsStale::SignedOut, "no Antigravity login found"));
        }
        return read_with_agy(&key, binary, env, &home, "no login Kybern can read").await;
    };
    if login.expires_within(chrono::Duration::seconds(REFRESH_MARGIN_SECONDS)) {
        return read_with_agy(&key, binary, env, &home, "the stored login is due for a refresh").await;
    }
    let agent = user_agent(&agy_version(binary).await);
    let result = tokio::time::timeout(TOTAL_TIMEOUT, read_with_token(login.access_token(), &agent)).await;
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(_) => Err(Failure::Network("the read timed out".into())),
    };
    match outcome {
        Ok(mut reading) => {
            clear_pause(&key);
            // The summary came without the Gemini group: ask `agy` itself.
            if !has_gemini(&reading.buckets) {
                let from_agy = read_agy_usage(binary, env, &home).await;
                reading.buckets = merge_buckets([std::mem::take(&mut reading.buckets), from_agy]);
            }
            let limits = to_limits(&reading.buckets);
            if limits.is_empty() {
                pause(&key, FAILURE_BACKOFF, false);
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
            Err(throttled(pause(&key, wait, false), "Google throttled the Antigravity limits read".into()))
        }
        // Google refused the stored token: `agy` renews it, or says it is signed out.
        Err(Failure::Status(status, _)) if status == reqwest::StatusCode::UNAUTHORIZED => {
            read_with_agy(&key, binary, env, &home, "Google refused the stored login").await
        }
        Err(Failure::Status(status, _)) => {
            pause(&key, FAILURE_BACKOFF, false);
            Err(unread(LimitsStale::Unavailable, format!("the Antigravity limits endpoint answered {status}")))
        }
        Err(Failure::Network(detail)) => {
            pause(&key, FAILURE_BACKOFF, false);
            Err(unread(LimitsStale::Unavailable, format!("the Antigravity limits endpoint failed: {detail}")))
        }
    }
}

/// The whole read from `agy -p "/usage"`, for when the fast path has no usable token.
async fn read_with_agy(
    key: &AccountKey,
    binary: Option<&PathBuf>,
    env: &BTreeMap<String, String>,
    home: &Path,
    why: &str,
) -> Result<(Vec<UsageLimit>, Option<String>), UsageUnread> {
    match run_agy_usage(binary, env, home).await {
        AgyUsage::Read(buckets) => {
            clear_pause(key);
            let limits = to_limits(&buckets);
            if limits.is_empty() {
                pause(key, FAILURE_BACKOFF, false);
                return Err(unread(LimitsStale::Unavailable, "Antigravity reported no quota windows"));
            }
            Ok((limits, None))
        }
        AgyUsage::SignedOut => {
            pause(key, MAX_BACKOFF, true);
            Err(unread(LimitsStale::SignedOut, "Antigravity is signed out"))
        }
        AgyUsage::Failed => {
            pause(key, FAILURE_BACKOFF, false);
            Err(unread(LimitsStale::Unavailable, format!("`agy /usage` gave no limits ({why})")))
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
