//! Antigravity's account limits: the 5-hour and weekly quota windows.
//!
//! Kybern asks Google's quota endpoints itself, with the token `agy` keeps (see `login.rs`):
//!
//! 1. **The stored token is good.** One HTTPS read, no process.
//! 2. **It has expired, or Google refused it.** `agy models` renews it: any `agy` start loads
//!    the saved login, renews an expired one in a fraction of a second and saves it, and a
//!    signed-out `agy models` only prints "Please sign in". It never opens a browser. Kybern
//!    then reads the saved token again and asks Google as in 1.
//! 3. **No token Kybern can read** (a locked keyring, a keychain that refuses), or `agy models`
//!    left the old one in place: `agy -p "/usage"`, Google's own answer through `agy`. It has
//!    no plan name, so the daemon keeps the last known plan.
//!
//! Only 3 can go wrong in a way people see: a `/usage` that can't use its login opens
//! Google's sign-in page in the browser. So it is the last resort, it runs with do-nothing
//! browser openers first on its `PATH` (`crate::no_browser`), and once it asked for a browser
//! sign-in it isn't started again for that account until its stored login changes, or after a
//! wait that doubles from 5 minutes to an hour. While `agy models` still works this reads as
//! "couldn't read", not as signed out.
//!
//! Kybern never redeems the refresh token, never carries Google client credentials, and
//! never writes to `agy`'s storage. The endpoints are undocumented and may change or be
//! refused without notice, so every failure is quiet.
//!
//! A signed-out account ([`LimitsStale::SignedOut`], only when `agy models` says so) is asked
//! again after `FAILURE_BACKOFF`, or as soon as the stored login changes. No login where
//! Kybern looks doesn't mean signed out: `agy` may keep it in its own file storage, and a
//! keyring may refuse Kybern. `agy models` decides.
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

use super::login::{StoredLogin, read_login_state};
use crate::claude::UsageUnread;

pub const ANTIGRAVITY_USER_AGENT_PREFIX: &str = "antigravity";
const HOSTS: [&str; 2] = ["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"];

/// A stand-in for both hosts, for tests of the whole read.
#[cfg(test)]
pub(crate) static TEST_HOST: Mutex<Option<String>> = Mutex::new(None);
/// Separate stand-ins for `(daily, production)` hosts, for tests of host preference.
#[cfg(test)]
pub(crate) static TEST_HOSTS: Mutex<Option<(String, String)>> = Mutex::new(None);

/// The daily and the production host.
fn hosts() -> [String; 2] {
    #[cfg(test)]
    if let Some((daily, production)) = TEST_HOSTS.lock().ok().and_then(|hosts| hosts.clone()) {
        return [daily, production];
    }
    #[cfg(test)]
    if let Some(host) = TEST_HOST.lock().ok().and_then(|host| host.clone()) {
        return [host.clone(), host];
    }
    HOSTS.map(str::to_string)
}
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

/// Which stored login a decision was taken for: its fingerprint, `None` when Kybern can't see one.
type LoginMark = Option<u64>;

/// No requests for an account before `until`.
#[derive(Clone, Copy)]
struct Pause {
    until: Instant,
    cause: PauseCause,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PauseCause {
    /// A read failed or was throttled.
    Failed,
    /// `agy` has no working login. Lifted early when the stored login changes: a sign-in.
    SignedOut(LoginMark),
    /// `/usage` asked for a browser sign-in although `agy models` works. Lifted early the same way.
    AskedToSignIn(LoginMark),
}

static PAUSED: LazyLock<Mutex<HashMap<AccountKey, Pause>>> = LazyLock::new(Default::default);

/// `/usage` asked for a browser sign-in for this account and login. It isn't started again
/// before `until` unless the login changes; each ask for the same login doubles the wait.
#[derive(Clone, Copy)]
struct SignInAsk {
    login: LoginMark,
    asks: u32,
    until: Instant,
}

static SIGN_IN_ASKS: LazyLock<Mutex<HashMap<AccountKey, SignInAsk>>> = LazyLock::new(Default::default);
/// The first wait after `/usage` asked for a browser sign-in; it doubles up to `ASK_BACKOFF_MAX`.
const ASK_BACKOFF: Duration = Duration::from_secs(5 * 60);
const ASK_BACKOFF_MAX: Duration = Duration::from_secs(60 * 60);
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

/// Different calls return different groups, so readings merge by bucket id;
/// the first reading for a bucket id (the host the account is metered on) wins.
pub fn merge_buckets(readings: impl IntoIterator<Item = Vec<QuotaBucket>>) -> Vec<QuotaBucket> {
    let mut merged: HashMap<String, QuotaBucket> = HashMap::new();
    for bucket in readings.into_iter().flatten() {
        merged.entry(bucket.id.clone()).or_insert(bucket);
    }
    merged.into_values().collect()
}

/// Whether this account is billed/metered on the production host (`cloudcode-pa`)
/// rather than the consumer daily host (`daily-cloudcode-pa`).
pub(crate) fn is_business_account(auth_method: Option<&str>, loaded: &Value) -> bool {
    if let Some(method) = auth_method.map(|value| value.trim().to_ascii_lowercase()) {
        match method.as_str() {
            "oauth-business" | "business" | "enterprise" | "workspace" => return true,
            "oauth-personal" | "consumer" => return false,
            _ => {}
        }
    }
    let user_defined = ["/paidTier/userDefinedCloudaicompanionProject", "/currentTier/userDefinedCloudaicompanionProject"]
        .iter()
        .any(|pointer| loaded.pointer(pointer).and_then(Value::as_bool) == Some(true));
    if user_defined {
        return true;
    }
    if let Some(paid) = loaded.pointer("/paidTier/id").and_then(Value::as_str).map(|id| id.trim().to_ascii_lowercase())
        && !paid.is_empty()
    {
        return !paid.starts_with("g1-") && paid != "free-tier" && paid != "legacy-tier";
    }
    if let Some(current) = loaded.pointer("/currentTier/id").and_then(Value::as_str).map(|id| id.trim().to_ascii_lowercase()) {
        return current.contains("enterprise") || current.contains("business") || current.contains("workspace");
    }
    false
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

fn pause(key: &AccountKey, wait: Duration, cause: PauseCause) -> Instant {
    pause_until(key, Instant::now() + wait.min(MAX_BACKOFF), cause)
}

fn pause_until(key: &AccountKey, until: Instant, cause: PauseCause) -> Instant {
    if let Ok(mut paused) = PAUSED.lock() {
        paused.insert(key.clone(), Pause { until, cause });
    }
    until
}

/// Note that `/usage` asked for a browser sign-in; returns when it may run again.
fn note_sign_in_ask(key: &AccountKey, login: LoginMark) -> Instant {
    let Ok(mut asks) = SIGN_IN_ASKS.lock() else { return Instant::now() + ASK_BACKOFF };
    let count = match asks.get(key) {
        Some(ask) if ask.login == login => ask.asks.saturating_add(1),
        _ => 1,
    };
    let wait = ASK_BACKOFF.saturating_mul(1 << (count - 1).min(4)).min(ASK_BACKOFF_MAX);
    let until = Instant::now() + wait;
    asks.insert(key.clone(), SignInAsk { login, asks: count, until });
    until
}

/// Whether `/usage` must not run for the account now, and until when.
fn sign_in_ask_until(key: &AccountKey) -> Option<Instant> {
    let asks = SIGN_IN_ASKS.lock().ok()?;
    asks.get(key).map(|ask| ask.until).filter(|until| Instant::now() < *until)
}

/// A new login (a renewal or a sign-in) gets `/usage` back at once. A login Kybern can't see
/// (`None`: the keychain refused this time) says nothing about a change.
fn forget_sign_in_ask_unless(key: &AccountKey, login: LoginMark) {
    if login.is_some()
        && let Ok(mut asks) = SIGN_IN_ASKS.lock()
        && asks.get(key).is_some_and(|ask| ask.login != login)
    {
        asks.remove(key);
    }
}

/// Someone just signed in to `agy` through Kybern: drop every wait, so the next read runs at once
/// even where Kybern can't see the new login (the Linux and Windows keyrings).
pub fn forget_sign_in_waits() {
    if let Ok(mut asks) = SIGN_IN_ASKS.lock() {
        asks.clear();
    }
    if let Ok(mut paused) = PAUSED.lock() {
        paused.retain(|_, pause| pause.cause == PauseCause::Failed);
    }
}

fn forget_sign_in_ask(key: &AccountKey) {
    if let Ok(mut asks) = SIGN_IN_ASKS.lock() {
        asks.remove(key);
    }
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
    text.contains("authentication required")
        || text.contains("waiting for authentication")
        || text.contains("authentication failed or timed out")
}

/// After `/usage` answered for an account, it is trusted to still be signed in this long
/// without asking `agy models` first.
const SIGNED_IN_FRESH: Duration = Duration::from_secs(10 * 60);
/// How long `agy models` may take to say whether it is signed in.
const MODELS_CHECK_TIMEOUT: Duration = Duration::from_secs(8);

fn recently_read(key: &AccountKey) -> bool {
    AGY_USAGE.lock().ok().and_then(|cached| cached.get(key).map(|(at, _)| at.elapsed() < SIGNED_IN_FRESH)).unwrap_or(false)
}

/// Whether what `agy models` wrote says it has no login ("Please sign in to view available models").
pub(crate) fn models_signed_out(stdout: &[u8], stderr: &[u8]) -> bool {
    let text = format!("{}\n{}", String::from_utf8_lossy(stderr), String::from_utf8_lossy(stdout)).to_lowercase();
    text.contains("please sign in")
}

/// `agy models` answers a signed-out account with a line and exits, without opening a browser.
/// Only that answer counts as signed out; a failure or timeout leaves the decision to `/usage`.
async fn models_say_signed_out(binary: &Path, env: &BTreeMap<String, String>, home: &Path) -> bool {
    let mut command = crate::binary::command(binary).no_window();
    command.arg("models").current_dir(home).envs(env);
    crate::no_browser::quiet(&mut command, env);
    match crate::process_tree::output_within(&mut command, MODELS_CHECK_TIMEOUT, models_signed_out).await {
        Ok(output) => models_signed_out(&output.stdout, &output.stderr),
        Err(_) => false,
    }
}

/// `agy -p "/usage" --output-format json`: Google's own answer for the account,
/// with no agent turn and no quota spent. Reused for `AGY_USAGE_FRESH`. `login` is the stored
/// login the caller saw: after `/usage` asked for a browser sign-in it isn't started again for
/// that login until its wait is over ([`AgyUsage::SignedOut`] meanwhile).
pub(crate) async fn run_agy_usage(binary: Option<&PathBuf>, env: &BTreeMap<String, String>, home: &Path, login: LoginMark) -> AgyUsage {
    let key = AccountKey::new(home, binary);
    if let Some((at, buckets)) = AGY_USAGE.lock().ok().and_then(|cached| cached.get(&key).cloned())
        && at.elapsed() < AGY_USAGE_FRESH
    {
        return AgyUsage::Read(buckets);
    }
    forget_sign_in_ask_unless(&key, login);
    if sign_in_ask_until(&key).is_some() {
        return AgyUsage::SignedOut;
    }
    let Ok(binary) = crate::binary::resolve(kybern_protocol::ProviderKind::Antigravity, binary) else { return AgyUsage::Failed };
    let mut command = crate::binary::command(&binary).no_window();
    command.args(["-p", "/usage", "--output-format", "json"]).current_dir(home).envs(env);
    crate::no_browser::quiet(&mut command, env);
    let Ok(output) = crate::process_tree::output_within(&mut command, AGY_USAGE_TIMEOUT, agy_signed_out).await else {
        return AgyUsage::Failed;
    };
    let buckets = if output.status.is_some_and(|status| status.success()) {
        serde_json::from_slice::<Value>(&output.stdout).map(|body| parse_agy_usage(&body)).unwrap_or_default()
    } else {
        Vec::new()
    };
    if !buckets.is_empty() {
        forget_sign_in_ask(&key);
        if let Ok(mut cached) = AGY_USAGE.lock() {
            cached.insert(key, (Instant::now(), buckets.clone()));
        }
        return AgyUsage::Read(buckets);
    }
    if agy_signed_out(&output.stdout, &output.stderr) {
        note_sign_in_ask(&key, login);
        AgyUsage::SignedOut
    } else {
        AgyUsage::Failed
    }
}

/// The buckets of `agy /usage`, empty when it gave none.
pub(crate) async fn read_agy_usage(
    binary: Option<&PathBuf>,
    env: &BTreeMap<String, String>,
    home: &Path,
    login: LoginMark,
) -> Vec<QuotaBucket> {
    match run_agy_usage(binary, env, home, login).await {
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
    if let Some(pause) = pause_of(&key)
        && pause.cause == PauseCause::Failed
    {
        return Err(throttled(pause.until, "Antigravity limit reads are paused after the last one failed".into()));
    }
    let login = read_login_state(Some(&home)).await.into_login();
    let mark = login.as_ref().map(StoredLogin::fingerprint);
    forget_sign_in_ask_unless(&key, mark);
    if let Some(pause) = pause_of(&key) {
        match pause.cause {
            PauseCause::SignedOut(seen) if seen == mark => return Err(unread(LimitsStale::SignedOut, "Antigravity is signed out")),
            PauseCause::AskedToSignIn(seen) if seen == mark => {
                return Err(throttled(pause.until, "`agy /usage` asked for a browser sign-in; waiting for its login to change".into()));
            }
            // The stored login changed: a renewal or a new sign-in. Read again now.
            _ => clear_pause(&key),
        }
    }
    let margin = chrono::Duration::seconds(REFRESH_MARGIN_SECONDS);
    let mut why = "no login Kybern can read";
    if let Some(login) = &login {
        if login.expires_within(margin) {
            why = "the stored login is due for a refresh";
        } else {
            match read_with_login(&key, login, binary, env, &home).await {
                TokenRead::Done(result) => return result,
                TokenRead::Refused => why = "Google refused the stored login",
            }
        }
    }
    // The stored login can't be used as it is. `agy models` renews it and saves the new one, and a
    // signed-out `agy models` only says so: unlike `/usage` it never opens a browser. It is skipped
    // only when there is no login to renew and `/usage` answered for this account a short while ago.
    let resolved = crate::binary::resolve(kybern_protocol::ProviderKind::Antigravity, binary).ok();
    let models_asked = resolved.is_some() && (login.is_some() || !recently_read(&key));
    if models_asked
        && let Some(resolved) = &resolved
        && models_say_signed_out(resolved, env, &home).await
    {
        // Asked again soon: the caption clears within a couple of minutes of signing in, or at once
        // when a login appears.
        pause(&key, FAILURE_BACKOFF, PauseCause::SignedOut(mark));
        return Err(unread(LimitsStale::SignedOut, "Antigravity is signed out"));
    }
    let mut mark = mark;
    if models_asked && let Some(renewed) = read_login_state(Some(&home)).await.into_login() {
        let renewed_mark = Some(renewed.fingerprint());
        if renewed_mark != mark && !renewed.expires_within(margin) {
            match read_with_login(&key, &renewed, binary, env, &home).await {
                TokenRead::Done(result) => return result,
                TokenRead::Refused => why = "Google refused the renewed login",
            }
        }
        mark = renewed_mark;
    }
    read_with_agy(&key, binary, env, &home, mark, why, models_asked).await
}

/// What asking Google with a stored token came to.
enum TokenRead {
    Done(Result<(Vec<UsageLimit>, Option<String>), UsageUnread>),
    /// Google refused the token (401): it needs renewing.
    Refused,
}

/// The quota windows and the plan, asked of Google with the token `agy` stored.
async fn read_with_login(
    key: &AccountKey,
    login: &StoredLogin,
    binary: Option<&PathBuf>,
    env: &BTreeMap<String, String>,
    home: &Path,
) -> TokenRead {
    let mark = Some(login.fingerprint());
    let agent = user_agent(&agy_version(binary).await);
    let result = tokio::time::timeout(TOTAL_TIMEOUT, read_with_token(login.access_token(), login.auth_method.as_deref(), &agent)).await;
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(_) => Err(Failure::Network("the read timed out".into())),
    };
    TokenRead::Done(match outcome {
        Ok(mut reading) => {
            clear_pause(key);
            // The summary came without the Gemini group: ask `agy` itself. A token Google accepted
            // means `agy` is signed in, so `agy models` isn't asked first.
            if !has_gemini(&reading.buckets) {
                let from_agy = read_agy_usage(binary, env, home, mark).await;
                reading.buckets = merge_buckets([std::mem::take(&mut reading.buckets), from_agy]);
            }
            let limits = to_limits(&reading.buckets);
            if limits.is_empty() {
                pause(key, FAILURE_BACKOFF, PauseCause::Failed);
                Err(unread(LimitsStale::Unavailable, "Antigravity reported no quota windows"))
            } else {
                Ok((limits, reading.plan))
            }
        }
        Err(Failure::Status(status, retry_after)) if status == reqwest::StatusCode::TOO_MANY_REQUESTS => {
            let wait = retry_after
                .as_deref()
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(FAILURE_BACKOFF);
            Err(throttled(pause(key, wait, PauseCause::Failed), "Google throttled the Antigravity limits read".into()))
        }
        Err(Failure::Status(status, _)) if status == reqwest::StatusCode::UNAUTHORIZED => return TokenRead::Refused,
        Err(Failure::Status(status, _)) => {
            pause(key, FAILURE_BACKOFF, PauseCause::Failed);
            Err(unread(LimitsStale::Unavailable, format!("the Antigravity limits endpoint answered {status}")))
        }
        Err(Failure::Network(detail)) => {
            pause(key, FAILURE_BACKOFF, PauseCause::Failed);
            Err(unread(LimitsStale::Unavailable, format!("the Antigravity limits endpoint failed: {detail}")))
        }
    })
}

/// The whole read from `agy -p "/usage"`, the last resort: no token Kybern can use, even after
/// `agy models` (`models_asked`: it ran for this read and didn't say signed out).
async fn read_with_agy(
    key: &AccountKey,
    binary: Option<&PathBuf>,
    env: &BTreeMap<String, String>,
    home: &Path,
    login: LoginMark,
    why: &str,
    models_asked: bool,
) -> Result<(Vec<UsageLimit>, Option<String>), UsageUnread> {
    let resolved = crate::binary::resolve(kybern_protocol::ProviderKind::Antigravity, binary).ok();
    match run_agy_usage(binary, env, home, login).await {
        AgyUsage::Read(buckets) => {
            clear_pause(key);
            let limits = to_limits(&buckets);
            if limits.is_empty() {
                pause(key, FAILURE_BACKOFF, PauseCause::Failed);
                return Err(unread(LimitsStale::Unavailable, "Antigravity reported no quota windows"));
            }
            Ok((limits, None))
        }
        AgyUsage::SignedOut => {
            // `/usage` wanted a browser sign-in (or did a short while ago). It isn't run again for this
            // login until its wait is over. Signed out only if `agy models` says so: a login `agy models`
            // accepts is not one to ask the person for again.
            let until = sign_in_ask_until(key).unwrap_or_else(|| Instant::now() + ASK_BACKOFF);
            let signed_out = match (&resolved, models_asked) {
                (Some(resolved), false) => models_say_signed_out(resolved, env, home).await,
                _ => false,
            };
            if signed_out {
                pause_until(key, until, PauseCause::SignedOut(login));
                return Err(unread(LimitsStale::SignedOut, "Antigravity is signed out"));
            }
            pause_until(key, until, PauseCause::AskedToSignIn(login));
            Err(throttled(until, format!("`agy /usage` asked for a browser sign-in ({why}) while `agy models` is signed in")))
        }
        AgyUsage::Failed => {
            pause(key, FAILURE_BACKOFF, PauseCause::Failed);
            Err(unread(LimitsStale::Unavailable, format!("`agy /usage` gave no limits ({why})")))
        }
    }
}

async fn read_with_token(token: &str, auth_method: Option<&str>, agent: &str) -> Result<QuotaReading, Failure> {
    let client = reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build().map_err(|error| Failure::Network(error.to_string()))?;
    let [daily_host, production_host] = hosts();
    // A generic User-Agent gets an answer with no project.
    let loaded = post(
        &client,
        format!("{production_host}/v1internal:loadCodeAssist"),
        token,
        agent,
        &json!({"metadata": {"ideType": "ANTIGRAVITY"}}),
    )
    .await?;
    let (project, plan) = parse_load_code_assist(&loaded);
    let Some(project) = project else { return Err(Failure::Network("no Antigravity project for this account".into())) };
    let body = json!({"project": project});
    let ordered = if is_business_account(auth_method, &loaded) { [production_host, daily_host] } else { [daily_host, production_host] };
    let (primary, fallback) = tokio::join!(
        post(&client, format!("{}/v1internal:retrieveUserQuotaSummary", ordered[0]), token, agent, &body),
        post(&client, format!("{}/v1internal:retrieveUserQuotaSummary", ordered[1]), token, agent, &body),
    );
    let mut failure = None;
    let mut readings = Vec::new();
    // Keep the metered host's reading first so its bucket values win in `merge_buckets`,
    // while the fallback host only fills in quota groups that the primary omitted.
    for result in [primary, fallback] {
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
