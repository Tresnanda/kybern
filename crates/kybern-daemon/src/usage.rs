//! Account plan limits (5-hour, weekly, monthly) per provider.
//!
//! Limits belong to the account, not to a thread, so one cache serves every
//! client. Three sources feed it, newest wins per window:
//!
//! - live reads: each provider's turn-free probe (Claude's OAuth usage
//!   endpoint, Codex `account/rateLimits/read`, Cursor's dashboard usage). A read runs when a
//!   client asks and the cached value is older than the provider's freshness
//!   window, and shortly after a turn on that provider ends, since that is when
//!   usage moves;
//! - session reports: limits a running turn reports, folded in as they arrive.
//!   Claude reports utilization only near a limit, so these are a supplement;
//! - the event log: the last stored report, shown only until the first read so
//!   a freshly started daemon has something to show.
//!
//! `usage.limits` can answer from the cache at once; every change, and every
//! finished read, goes to clients as `usage.limits.changed`. Reads happen only
//! while a client has asked recently, so an unattended daemon spawns nothing.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use kybern_protocol::methods::{LimitsSource, ProviderLimits, UsageLimitsParams, UsageLimitsResult};
use kybern_protocol::{ProviderKind, UsageLimit};
use kybern_store::Store;
use tokio::sync::broadcast;

use crate::settings::SettingsStore;

/// Providers with a turn-free way to read the account's limits.
const LIVE: [ProviderKind; 3] = [ProviderKind::ClaudeCode, ProviderKind::Codex, ProviderKind::Cursor];
/// Forced reads closer together than this share one result.
const MIN_SPACING: Duration = Duration::from_secs(10);
/// A turn ending refreshes its provider only if a client asked this recently.
const INTEREST: Duration = Duration::from_secs(10 * 60);
/// Upper bound for callers that wait for reads (older clients, the CLI).
const WAIT: Duration = Duration::from_secs(16);

/// How long a live read stays fresh. Claude and Cursor are HTTPS requests
/// (Claude falls back to starting Claude Code for `/usage`); Codex starts its
/// app-server for about a second.
fn fresh_for(_kind: ProviderKind) -> Duration {
    Duration::from_secs(60)
}

/// Wait after a turn ends before reading. Cursor's billing lands a few seconds
/// after the run; the harnesses update their own counters immediately.
fn settle_after_turn(kind: ProviderKind) -> Duration {
    match kind {
        ProviderKind::Cursor => Duration::from_secs(8),
        _ => Duration::from_secs(2),
    }
}

#[derive(Clone)]
pub struct UsageMonitor {
    inner: Arc<Inner>,
}

struct Inner {
    store: Store,
    settings: SettingsStore,
    state: std::sync::Mutex<State>,
    /// One read per provider at a time; a caller that arrives mid-read waits
    /// for it and then finds the value fresh.
    gates: HashMap<ProviderKind, tokio::sync::Mutex<()>>,
    changed: broadcast::Sender<UsageLimitsResult>,
}

#[derive(Default)]
struct State {
    seeded: bool,
    providers: BTreeMap<ProviderKind, Entry>,
    last_interest: Option<Instant>,
    refreshing: HashSet<ProviderKind>,
    after_turn: HashSet<ProviderKind>,
}

#[derive(Default)]
struct Entry {
    limits: Vec<UsageLimit>,
    plan: Option<String>,
    updated_at: Option<DateTime<Utc>>,
    source: Option<LimitsSource>,
    /// Last live read, successful or not. Paces retries for a provider that
    /// is not installed or signed in.
    attempted: Option<Instant>,
}

fn window_key(limit: &UsageLimit) -> String {
    limit.window_minutes.map(|minutes| format!("window:{minutes}")).unwrap_or_else(|| format!("name:{}", limit.name))
}

fn provider_order(kind: ProviderKind) -> usize {
    LIVE.iter().position(|live| *live == kind).unwrap_or(LIVE.len())
}

impl UsageMonitor {
    pub fn new(store: Store, settings: SettingsStore) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                settings,
                state: std::sync::Mutex::new(State::default()),
                gates: LIVE.into_iter().map(|kind| (kind, tokio::sync::Mutex::new(()))).collect(),
                changed: broadcast::channel(64).0,
            }),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<UsageLimitsResult> {
        self.inner.changed.subscribe()
    }

    /// Answer `usage.limits`.
    pub async fn limits(&self, params: UsageLimitsParams) -> UsageLimitsResult {
        self.seed();
        let due = {
            let mut state = self.lock();
            state.last_interest = Some(Instant::now());
            let due = LIVE
                .into_iter()
                .filter(|kind| {
                    let attempted = state.providers.get(kind).and_then(|entry| entry.attempted);
                    let spacing = if params.refresh { MIN_SPACING } else { fresh_for(*kind) };
                    attempted.is_none_or(|at| at.elapsed() >= spacing)
                })
                // A background read already in flight answers a cached call.
                .filter(|kind| !(params.cached && state.refreshing.contains(kind)))
                .collect::<Vec<_>>();
            if params.cached {
                // Mark before spawning so the snapshot below reports them.
                state.refreshing.extend(due.iter().copied());
            }
            due
        };
        if params.cached {
            for kind in due {
                let monitor = self.clone();
                tokio::spawn(async move { monitor.refresh(kind, MIN_SPACING).await });
            }
        } else {
            let reads = due.into_iter().map(|kind| self.refresh(kind, MIN_SPACING));
            let _ = tokio::time::timeout(WAIT, futures::future::join_all(reads)).await;
        }
        self.snapshot()
    }

    /// Fold limits a running turn reported. Values from a live read and from
    /// a turn describe the same windows; the newer one wins per window.
    pub fn observe(&self, kind: ProviderKind, limits: &[UsageLimit]) {
        if limits.is_empty() {
            return;
        }
        self.seed();
        {
            let mut state = self.lock();
            let entry = state.providers.entry(kind).or_default();
            for limit in limits {
                let key = window_key(limit);
                match entry.limits.iter_mut().find(|old| window_key(old) == key) {
                    Some(old) => {
                        old.used_percent = limit.used_percent;
                        old.resets_at = limit.resets_at.or(old.resets_at);
                    }
                    None => entry.limits.push(limit.clone()),
                }
            }
            entry.limits.sort_by_key(|limit| limit.window_minutes.unwrap_or(u64::MAX));
            entry.updated_at = Some(Utc::now());
            if entry.source != Some(LimitsSource::Live) {
                entry.source = Some(LimitsSource::Session);
            }
        }
        self.publish();
    }

    /// A turn ended on `kind`. Re-read its limits once the provider settles,
    /// if a client is watching. Several turns ending together share one read.
    pub fn turn_finished(&self, kind: ProviderKind) {
        if !LIVE.contains(&kind) {
            return;
        }
        {
            let mut state = self.lock();
            if state.last_interest.is_none_or(|at| at.elapsed() > INTEREST) || !state.after_turn.insert(kind) {
                return;
            }
        }
        let monitor = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(settle_after_turn(kind)).await;
            monitor.lock().after_turn.remove(&kind);
            monitor.lock().refreshing.insert(kind);
            monitor.refresh(kind, MIN_SPACING).await;
        });
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Load the last stored report once, so the first answer after a restart
    /// is not empty while live reads run.
    fn seed(&self) {
        if self.lock().seeded {
            return;
        }
        let stored = self.inner.store.latest_provider_limits().unwrap_or_else(|error| {
            tracing::warn!(%error, "could not read stored usage limits");
            Vec::new()
        });
        let mut state = self.lock();
        if state.seeded {
            return;
        }
        state.seeded = true;
        for report in stored {
            let entry = state.providers.entry(report.provider).or_default();
            if entry.updated_at.is_none() {
                entry.limits = report.limits;
                entry.updated_at = report.updated_at;
                entry.source = Some(LimitsSource::Stored);
            }
        }
    }

    /// Read one provider's limits now unless another read finished within
    /// `spacing`. Always publishes, so clients clear their refreshing state.
    async fn refresh(&self, kind: ProviderKind, spacing: Duration) {
        let Some(gate) = self.inner.gates.get(&kind) else { return };
        let _gate = gate.lock().await;
        let recent = self.lock().providers.get(&kind).and_then(|entry| entry.attempted).is_some_and(|at| at.elapsed() < spacing);
        if !recent {
            self.lock().refreshing.insert(kind);
            let read = self.read(kind).await;
            let mut state = self.lock();
            let entry = state.providers.entry(kind).or_default();
            entry.attempted = Some(Instant::now());
            if let Some((limits, plan)) = read {
                entry.limits = limits;
                entry.plan = plan.or(entry.plan.take());
                entry.updated_at = Some(Utc::now());
                entry.source = Some(LimitsSource::Live);
            }
        }
        self.lock().refreshing.remove(&kind);
        self.publish();
    }

    async fn read(&self, kind: ProviderKind) -> Option<(Vec<UsageLimit>, Option<String>)> {
        let settings = self.inner.settings.get();
        let provider = crate::settings::provider_settings(&settings, kind, None);
        let binary: Option<PathBuf> = provider.binary.clone().map(Into::into);
        // cwd only needs to be a real directory; account auth lives under $HOME.
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
        let started = Instant::now();
        let read = match kind {
            ProviderKind::ClaudeCode => tokio::time::timeout(
                Duration::from_secs(20),
                kybern_drivers::claude::read_account_usage(&home, binary.as_ref(), &provider.env),
            )
            .await
            .ok()
            .flatten(),
            ProviderKind::Codex => tokio::time::timeout(
                Duration::from_secs(8),
                kybern_drivers::codex::read_account_limits(&home, binary.as_ref(), &provider.env),
            )
            .await
            .ok()
            .flatten()
            .map(|limits| (limits, None)),
            ProviderKind::Cursor => {
                tokio::time::timeout(Duration::from_secs(10), kybern_drivers::cursor::usage::read_account_usage(&provider.env))
                    .await
                    .ok()
                    .flatten()
                    .map(|usage| (usage.limits, usage.plan))
            }
            _ => None,
        };
        tracing::debug!(provider = %kind, ok = read.is_some(), elapsed_ms = started.elapsed().as_millis() as u64, "read account limits");
        read.filter(|(limits, _)| !limits.is_empty())
    }

    fn publish(&self) {
        // No receivers just means no client is connected.
        let _ = self.inner.changed.send(self.snapshot());
    }

    /// The cache as clients see it. A window whose reset time has passed
    /// reads as unused until the next report says otherwise.
    fn snapshot(&self) -> UsageLimitsResult {
        let state = self.lock();
        let now = Utc::now().timestamp();
        let mut providers = state
            .providers
            .iter()
            .filter(|(_, entry)| !entry.limits.is_empty())
            .map(|(kind, entry)| ProviderLimits {
                provider: *kind,
                limits: entry
                    .limits
                    .iter()
                    .map(|limit| match limit.resets_at {
                        Some(reset) if reset <= now => UsageLimit { used_percent: 0.0, resets_at: None, ..limit.clone() },
                        _ => limit.clone(),
                    })
                    .collect(),
                updated_at: entry.updated_at,
                source: entry.source,
                plan: entry.plan.clone(),
            })
            .collect::<Vec<_>>();
        providers.sort_by_key(|entry| provider_order(entry.provider));
        let mut refreshing = state.refreshing.iter().copied().collect::<Vec<_>>();
        refreshing.sort_by_key(|kind| provider_order(*kind));
        UsageLimitsResult { providers, refreshing }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor() -> UsageMonitor {
        let root = std::env::temp_dir().join(format!("kybern-usage-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let settings = SettingsStore::load(&root.join("settings.json")).unwrap();
        UsageMonitor::new(Store::open_in_memory().unwrap(), settings)
    }

    fn limit(name: &str, used_percent: f64, window_minutes: Option<u64>, resets_at: Option<i64>) -> UsageLimit {
        UsageLimit { name: name.into(), used_percent, window_minutes, resets_at }
    }

    #[tokio::test]
    async fn session_reports_merge_by_window_and_publish() {
        let monitor = monitor();
        let mut changes = monitor.subscribe();
        let future = Utc::now().timestamp() + 3600;
        monitor.observe(ProviderKind::ClaudeCode, &[limit("Current session", 40.0, Some(300), Some(future))]);
        monitor.observe(ProviderKind::ClaudeCode, &[limit("5-hour", 55.0, Some(300), None)]);
        let mut latest = changes.recv().await.unwrap();
        while let Ok(next) = changes.try_recv() {
            latest = next;
        }
        let claude = &latest.providers[0];
        assert_eq!(claude.provider, ProviderKind::ClaudeCode);
        assert_eq!(claude.limits.len(), 1, "one row per window");
        assert_eq!(claude.limits[0].used_percent, 55.0);
        assert_eq!(claude.limits[0].resets_at, Some(future), "a report without a reset keeps the known one");
        assert_eq!(claude.source, Some(LimitsSource::Session));
        assert!(claude.updated_at.is_some());
    }

    #[tokio::test]
    async fn passed_resets_read_as_unused() {
        let monitor = monitor();
        let past = Utc::now().timestamp() - 60;
        monitor.observe(ProviderKind::Codex, &[limit("Primary", 97.0, Some(300), Some(past))]);
        let snapshot = monitor.snapshot();
        assert_eq!(snapshot.providers[0].limits[0].used_percent, 0.0);
        assert_eq!(snapshot.providers[0].limits[0].resets_at, None);
    }

    #[tokio::test]
    async fn turns_refresh_only_while_a_client_is_watching() {
        let monitor = monitor();
        monitor.turn_finished(ProviderKind::Codex);
        assert!(monitor.lock().after_turn.is_empty(), "no client asked yet");
        monitor.lock().last_interest = Some(Instant::now());
        monitor.turn_finished(ProviderKind::Codex);
        monitor.turn_finished(ProviderKind::Codex);
        assert_eq!(monitor.lock().after_turn.len(), 1, "turns ending together share a read");
        monitor.turn_finished(ProviderKind::Opencode);
        assert!(!monitor.lock().after_turn.contains(&ProviderKind::Opencode), "no account limits to read");
    }
}
