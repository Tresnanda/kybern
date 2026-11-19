//! Scheduled, daemon-owned harness maintenance, isolated from active conversations.
//!
//! Two jobs share one worker:
//! * **Version check** (`check_harness_versions`, on by default): once a day per harness, ask the feed its
//!   installation names (`kybern_drivers::latest`) for the newest version, and mark the record
//!   `update_available` when it is newer than the installed one. Feeds sit behind [`LatestFeed`], so tests
//!   use fakes and never reach the network; answers are cached for an hour.
//! * **Updater** (`auto_update_harnesses`, or a request): run the harness's own updater once that harness is
//!   idle on this machine.
//!
//! Every change to a record goes to clients as `harness_updates.changed`.
use crate::state::AppState;
use chrono::{DateTime, Utc};
use futures::future::BoxFuture;
use kybern_drivers::latest::{self, Source};
use kybern_protocol::{HarnessInstall, HarnessUpdate, HarnessUpdateStatus as Status, PeerHarnessUpdatesRunResult, ProviderKind};
use kybern_store::Store;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

/// How long a feed's answer is reused.
const CACHE_FOR: Duration = Duration::from_secs(60 * 60);
/// How often each harness's feed is asked.
const CHECK_EVERY_HOURS: i64 = 24;
/// How long one feed request may take.
const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
/// The largest feed body read; Cursor's install script is the biggest, a few kilobytes.
const MAX_BODY: usize = 1 << 20;

/// Where the newest version of an installation comes from.
pub trait LatestFeed: Send + Sync {
    /// The newest published version for this source, `None` when the feed has no readable answer.
    fn latest<'a>(&'a self, kind: ProviderKind, source: &'a Source) -> BoxFuture<'a, anyhow::Result<Option<String>>>;
}

/// The real feeds: one plain GET per URL, first readable answer wins.
pub struct HttpFeed {
    client: reqwest::Client,
}

impl HttpFeed {
    fn new() -> anyhow::Result<Self> {
        // Only the daemon's own name and version; nothing about the user or this machine.
        let client = reqwest::Client::builder()
            .user_agent(format!("kybernd/{}", env!("CARGO_PKG_VERSION")))
            .timeout(FETCH_TIMEOUT)
            .connect_timeout(Duration::from_secs(10))
            .build()?;
        Ok(Self { client })
    }
}

impl LatestFeed for HttpFeed {
    fn latest<'a>(&'a self, _kind: ProviderKind, source: &'a Source) -> BoxFuture<'a, anyhow::Result<Option<String>>> {
        Box::pin(async move {
            let mut last = None;
            for url in source.urls() {
                let attempt = async {
                    let response = self.client.get(&url).send().await?.error_for_status()?;
                    let bytes = response.bytes().await?;
                    anyhow::ensure!(bytes.len() <= MAX_BODY, "the answer is larger than a version feed");
                    Ok::<_, anyhow::Error>(source.parse(&String::from_utf8_lossy(&bytes)))
                };
                match attempt.await {
                    Ok(Some(version)) => return Ok(Some(version)),
                    Ok(None) => last = Some(anyhow::anyhow!("{url} named no version")),
                    Err(error) => last = Some(error.context(url)),
                }
            }
            match last {
                Some(error) => Err(error),
                None => Ok(None),
            }
        })
    }
}

/// A feed that answers from a fixed table by harness: tests, and a scratch daemon started with
/// `KYBERN_HARNESS_FEED_FAKE=<fixture.json>` (`{"claude-code": "2.1.400"}`).
#[derive(Default)]
pub struct FakeFeed {
    versions: HashMap<ProviderKind, String>,
    pub asked: Mutex<Vec<ProviderKind>>,
}

impl FakeFeed {
    #[cfg(test)]
    pub fn new(versions: impl IntoIterator<Item = (ProviderKind, &'static str)>) -> Self {
        Self { versions: versions.into_iter().map(|(kind, version)| (kind, version.to_string())).collect(), asked: Mutex::default() }
    }

    fn from_fixture(path: &std::path::Path) -> anyhow::Result<Self> {
        let versions: HashMap<ProviderKind, String> = serde_json::from_str(&std::fs::read_to_string(path)?)?;
        Ok(Self { versions, asked: Mutex::default() })
    }
}

impl LatestFeed for FakeFeed {
    fn latest<'a>(&'a self, kind: ProviderKind, _source: &'a Source) -> BoxFuture<'a, anyhow::Result<Option<String>>> {
        self.asked.lock().unwrap().push(kind);
        Box::pin(async move { Ok(self.versions.get(&kind).cloned()) })
    }
}

fn default_feed() -> Arc<dyn LatestFeed> {
    if cfg!(test) {
        return Arc::new(FakeFeed::default());
    }
    if let Some(path) = std::env::var_os("KYBERN_HARNESS_FEED_FAKE").filter(|path| !path.is_empty()) {
        match FakeFeed::from_fixture(std::path::Path::new(&path)) {
            Ok(feed) => return Arc::new(feed),
            Err(error) => tracing::warn!(%error, "KYBERN_HARNESS_FEED_FAKE is unreadable; harness version checks are off"),
        }
        return Arc::new(FakeFeed::default());
    }
    match HttpFeed::new() {
        Ok(feed) => Arc::new(feed),
        Err(error) => {
            tracing::warn!(%error, "could not set up harness version checks");
            Arc::new(FakeFeed::default())
        }
    }
}

pub struct HarnessUpdates {
    records: Mutex<HashMap<ProviderKind, HarnessUpdate>>,
    requested: Mutex<HashSet<ProviderKind>>,
    worker: tokio::sync::Mutex<()>,
    feed: RwLock<Arc<dyn LatestFeed>>,
    cache: Mutex<HashMap<Source, (Instant, Option<String>)>>,
    changed: tokio::sync::broadcast::Sender<Vec<HarnessUpdate>>,
}

impl HarnessUpdates {
    pub fn new(store: &Store) -> anyhow::Result<Self> {
        let mut records = HashMap::new();
        for kind in ProviderKind::ALL {
            let mut record = store
                .meta_get(&key(kind))?
                .and_then(|value| serde_json::from_str::<HarnessUpdate>(&value).ok())
                .unwrap_or_else(|| HarnessUpdate::unchecked(kind));
            if matches!(record.status, Status::Updating | Status::Waiting) {
                record.status = Status::Failed;
                record.message = "The daemon restarted during an update request. Check the installation and retry.".into();
                record.checked_at = Some(Utc::now());
            }
            records.insert(kind, record);
        }
        Ok(Self {
            records: Mutex::new(records),
            requested: Mutex::new(HashSet::new()),
            worker: tokio::sync::Mutex::new(()),
            feed: RwLock::new(default_feed()),
            cache: Mutex::new(HashMap::new()),
            changed: tokio::sync::broadcast::channel(16).0,
        })
    }
    pub fn list(&self) -> Vec<HarnessUpdate> {
        let records = self.records.lock().unwrap();
        ProviderKind::ALL.iter().map(|kind| records[kind].clone()).collect()
    }
    /// Every change to a record, as the whole list.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Vec<HarnessUpdate>> {
        self.changed.subscribe()
    }
    #[cfg(test)]
    pub fn set_feed(&self, feed: Arc<dyn LatestFeed>) {
        *self.feed.write().unwrap() = feed;
        self.cache.lock().unwrap().clear();
    }
    fn record(&self, kind: ProviderKind) -> HarnessUpdate {
        self.records.lock().unwrap()[&kind].clone()
    }
    pub(crate) fn save(&self, store: &Store, record: HarnessUpdate) {
        {
            let mut records = self.records.lock().unwrap();
            if records.get(&record.kind) == Some(&record) {
                return;
            }
            if let Err(error) = store.meta_set(&key(record.kind), &serde_json::to_string(&record).expect("serializable record")) {
                tracing::error!(%error, "could not persist harness update status");
            }
            records.insert(record.kind, record);
        }
        let _ = self.changed.send(self.list());
    }
    pub fn request(&self, store: &Store, kind: ProviderKind) -> HarnessUpdate {
        let mut record = self.record(kind);
        if record.status == Status::Updating {
            return record;
        }
        self.requested.lock().unwrap().insert(kind);
        record.status = Status::Waiting;
        record.message = "Waiting for this agent to become idle".into();
        self.save(store, record.clone());
        record
    }

    /// The feed's answer for `source`, from the cache when it is under an hour old.
    async fn latest(&self, kind: ProviderKind, source: &Source) -> anyhow::Result<Option<String>> {
        if let Some((at, version)) = self.cache.lock().unwrap().get(source)
            && at.elapsed() < CACHE_FOR
        {
            return Ok(version.clone());
        }
        let feed = self.feed.read().unwrap().clone();
        let version = feed.latest(kind, source).await?;
        self.cache.lock().unwrap().insert(source.clone(), (Instant::now(), version.clone()));
        Ok(version)
    }
}
fn key(kind: ProviderKind) -> String {
    format!("harness_update:{kind}")
}

fn due(record: &HarnessUpdate) -> bool {
    record.checked_at.is_none_or(|at| Utc::now().signed_duration_since(at).num_hours() >= 24)
}

/// Whether the version check asks this harness's feed again.
fn version_check_due(record: &HarnessUpdate, now: DateTime<Utc>) -> bool {
    record.latest_checked_at.is_none_or(|at| now.signed_duration_since(at).num_hours() >= CHECK_EVERY_HOURS)
}

/// Whether the record's newest version is newer than what is installed.
fn compare(record: &HarnessUpdate) -> bool {
    match (&record.latest_version, &record.version) {
        (Some(latest), Some(installed)) => latest::update_available(record.kind, latest, installed),
        _ => false,
    }
}

/// One pass of the version check: each harness whose last check is a day old, or every harness when `force`.
/// With the setting off it asks nothing and clears what earlier checks found.
pub async fn check_versions(state: &AppState, force: bool) {
    let settings = state.settings.get();
    for kind in ProviderKind::ALL {
        if state.shutdown.is_cancelled() {
            break;
        }
        let mut record = state.harness_updates.record(kind);
        if !settings.check_harness_versions {
            if record.latest_version.is_some() || record.update_available || record.latest_checked_at.is_some() {
                record.latest_version = None;
                record.update_available = false;
                record.latest_checked_at = None;
                state.harness_updates.save(&state.store, record);
            }
            continue;
        }
        let now = Utc::now();
        if !force && !version_check_due(&record, now) {
            continue;
        }
        let config = settings.providers.get(&kind).cloned().unwrap_or_default();
        check_one(state, &mut record, config.binary.is_some()).await;
        record.latest_checked_at = Some(now);
        record.update_available = compare(&record);
        state.harness_updates.save(&state.store, record);
    }
}

async fn check_one(state: &AppState, record: &mut HarnessUpdate, custom_binary: bool) {
    let kind = record.kind;
    // A custom binary is the user's own to update; a harness that is not installed has nothing to compare.
    let binary = match kybern_drivers::binary::resolve(kind, None) {
        Ok(binary) if !custom_binary => binary,
        result => {
            record.install = result.is_ok().then_some(HarnessInstall::Other);
            record.latest_version = None;
            return;
        }
    };
    let install = latest::detect(kind, &binary, &latest::Places::current());
    record.install = Some(install.method);
    let Some(source) = install.source else {
        record.latest_version = None;
        return;
    };
    match state.harness_updates.latest(kind, &source).await {
        Ok(Some(version)) => record.latest_version = Some(version),
        // Cursor's install page can change shape; say nothing rather than something wrong.
        Ok(None) => record.latest_version = None,
        // A feed that is down keeps the last answer; the next daily check tries again.
        Err(error) => tracing::debug!(%kind, error = format!("{error:#}"), "harness version feed did not answer"),
    }
    if record.latest_version.is_some()
        && let Some(installed) = kybern_drivers::binary::version_of(&binary, &["--version"]).await
    {
        record.version = Some(installed);
    }
}

/// Run the version check and any due or requested update in the background.
pub fn spawn_tick(state: &AppState) {
    tokio::spawn(tick(state.clone()));
}

/// This machine's part of `harness_updates.run_all` and `peer.harness_updates.run`: queue the named harnesses,
/// or with none named every harness the version check found a newer version for. Each one waits until it is
/// idle here.
pub fn start_local(state: &AppState, kinds: &[ProviderKind]) -> PeerHarnessUpdatesRunResult {
    let settings = state.settings.get();
    let wanted: Vec<ProviderKind> = if kinds.is_empty() {
        state.harness_updates.list().into_iter().filter(|record| record.update_available).map(|record| record.kind).collect()
    } else {
        // Only harnesses installed here: another machine may name one this machine never had.
        let mut seen = HashSet::new();
        kinds
            .iter()
            .copied()
            .filter(|kind| seen.insert(*kind))
            .filter(|kind| {
                let binary = settings.providers.get(kind).and_then(|config| config.binary.clone()).map(std::path::PathBuf::from);
                kybern_drivers::binary::resolve(*kind, binary.as_ref()).is_ok()
            })
            .collect()
    };
    if wanted.is_empty() {
        let reason = if kinds.is_empty() && !settings.check_harness_versions {
            "Version checks are off on this machine"
        } else if kinds.is_empty() {
            "Every harness is up to date"
        } else {
            "Not installed on this machine"
        };
        return PeerHarnessUpdatesRunResult { started: Vec::new(), reason: Some(reason.into()) };
    }
    for kind in &wanted {
        state.harness_updates.request(&state.store, *kind);
    }
    spawn_tick(state);
    PeerHarnessUpdatesRunResult { started: wanted, reason: None }
}

pub async fn tick(state: AppState) {
    let Ok(_worker) = state.harness_updates.worker.try_lock() else { return };
    if !state.saving_power() {
        check_versions(&state, false).await;
    }
    for kind in ProviderKind::ALL {
        if state.shutdown.is_cancelled() {
            break;
        }
        let manual = state.harness_updates.requested.lock().unwrap().contains(&kind);
        let settings = state.settings.get();
        let mut record = state.harness_updates.record(kind);
        if !manual && (!settings.auto_update_harnesses || !due(&record) || state.saving_power()) {
            if record.status == Status::Waiting && !settings.auto_update_harnesses {
                record.status = Status::NotChecked;
                record.message = "Automatic updates are off".into();
                state.harness_updates.save(&state.store, record);
            }
            continue;
        }
        let config = settings.providers.get(&kind).cloned().unwrap_or_default();
        let disabled = |name: &str| {
            config.env.get(name).cloned().or_else(|| std::env::var(name).ok()).is_some_and(|v| matches!(v.as_str(), "1" | "true"))
        };
        let outcome = async {
            if config.binary.is_some() {
                anyhow::bail!("Custom executable. Update it through its owner or remove the binary override.");
            }
            if disabled("DISABLE_UPDATES") || (!manual && disabled("DISABLE_AUTOUPDATER")) {
                anyhow::bail!("Updates are disabled by this harness's environment settings.");
            }
            let binary = kybern_drivers::binary::resolve(kind, None)?;
            let plan = kybern_drivers::update::plan(kind, &binary, &config.env, &state.paths.root).await?;
            Ok::<_, anyhow::Error>((binary, plan))
        }
        .await;
        let (binary, plan) = match outcome {
            Ok(value) => value,
            Err(error) => {
                record.status = Status::Unsupported;
                record.message = error.to_string();
                record.checked_at = Some(Utc::now());
                state.harness_updates.save(&state.store, record);
                state.harness_updates.requested.lock().unwrap().remove(&kind);
                continue;
            }
        };
        let guard = match state.orchestrator.idle_harness_for_update(kind).await {
            Ok(Some(guard)) => guard,
            Ok(None) => {
                record.status = Status::Waiting;
                record.message = "Waiting for active turns and background work to finish".into();
                state.harness_updates.save(&state.store, record);
                continue;
            }
            Err(error) => {
                record.status = Status::Failed;
                record.message = error.to_string();
                record.checked_at = Some(Utc::now());
                state.harness_updates.save(&state.store, record);
                state.harness_updates.requested.lock().unwrap().remove(&kind);
                continue;
            }
        };
        // Recheck the switch after probing; disabling it cancels unscheduled automatic work.
        if !manual && !state.settings.get().auto_update_harnesses {
            drop(guard);
            continue;
        }
        let before = kybern_drivers::binary::version_of(&binary, &["--version"]).await;
        record.status = Status::Updating;
        record.message = "Checking and installing updates…".into();
        record.version = before.clone();
        state.harness_updates.save(&state.store, record.clone());
        // A test build never runs a real harness's updater: the binary on PATH belongs to whoever runs the tests.
        #[cfg(test)]
        let run = async { Err::<(), _>(anyhow::anyhow!("Test builds never run a harness updater.")) };
        #[cfg(not(test))]
        let run = kybern_drivers::update::run(&plan, &config.env, &state.paths.root);
        #[cfg(test)]
        let _ = &plan;
        let result = tokio::select! {
            result = run => result,
            _ = state.shutdown.cancelled() => Err(anyhow::anyhow!("Update interrupted by daemon shutdown. Check the installation and retry.")),
        };
        record.checked_at = Some(Utc::now());
        match result {
            Ok(()) => {
                record.version = kybern_drivers::binary::version_of(&binary, &["--version"]).await;
                if record.version.is_none() {
                    record.status = Status::Failed;
                    record.message = "The updater exited, but the CLI did not report a version. Check the installation and retry.".into();
                } else if record.version == before {
                    record.status = Status::Current;
                    record.message = "Up to date for its configured release channel".into();
                } else {
                    record.status = Status::Updated;
                    record.message = "Updated. New turns use this version.".into();
                }
                state.provider_catalogs.invalidate().await;
            }
            Err(error) => {
                record.status = Status::Failed;
                record.message = error.to_string();
            }
        }
        record.update_available = compare(&record);
        state.harness_updates.save(&state.store, record);
        state.harness_updates.requested.lock().unwrap().remove(&kind);
        drop(guard);
    }
}

pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    let mut settings = state.settings.subscribe();
    loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => break,
            _ = interval.tick() => tick(state.clone()).await,
            // Turning version checks on or off shows at once, not on the next tick.
            changed = settings.recv() => {
                if matches!(changed, Err(tokio::sync::broadcast::error::RecvError::Closed)) { break; }
                tick(state.clone()).await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_state() -> (AppState, crate::network::testutil::TempDir) {
        let dir = crate::network::testutil::TempDir::new("harness-updates");
        let paths = crate::config::Paths::resolve(Some(dir.path().join("data"))).unwrap();
        (AppState::initialize_in_memory(&paths).unwrap(), dir)
    }

    #[test]
    fn daily_schedule_does_not_retry_recent_failures_or_restart_into_a_loop() {
        let mut record =
            HarnessUpdate { status: Status::Failed, checked_at: Some(Utc::now()), ..HarnessUpdate::unchecked(ProviderKind::Codex) };
        assert!(!due(&record));
        record.checked_at = Some(Utc::now() - chrono::Duration::hours(25));
        assert!(due(&record));
    }

    #[test]
    fn the_version_check_runs_once_a_day_and_compares_what_is_installed() {
        let now = Utc::now();
        let mut record = HarnessUpdate::unchecked(ProviderKind::Codex);
        assert!(version_check_due(&record, now), "never checked");
        record.latest_checked_at = Some(now - chrono::Duration::hours(23));
        assert!(!version_check_due(&record, now));
        record.latest_checked_at = Some(now - chrono::Duration::hours(24));
        assert!(version_check_due(&record, now));

        record.version = Some("codex-cli 0.167.0".into());
        record.latest_version = Some("0.170.0".into());
        assert!(compare(&record));
        record.version = Some("codex-cli 0.170.0".into());
        assert!(!compare(&record), "updated to it");
        record.latest_version = None;
        assert!(!compare(&record), "nothing known");
        let cursor = HarnessUpdate {
            version: Some("2026.10.30-0a1b2c3".into()),
            latest_version: Some("2026.11.17-f532c45".into()),
            ..HarnessUpdate::unchecked(ProviderKind::Cursor)
        };
        assert!(compare(&cursor));
    }

    #[tokio::test]
    async fn the_feed_is_cached_for_an_hour() {
        let (state, _dir) = test_state();
        let feed = Arc::new(FakeFeed::new([(ProviderKind::ClaudeCode, "2.1.330")]));
        state.harness_updates.set_feed(feed.clone());
        let source = Source::ClaudeNative { channel: "latest".into() };
        for _ in 0..3 {
            assert_eq!(state.harness_updates.latest(ProviderKind::ClaudeCode, &source).await.unwrap().as_deref(), Some("2.1.330"));
        }
        assert_eq!(feed.asked.lock().unwrap().len(), 1, "one request, then the cache");
        // An answer older than an hour is asked again.
        state.harness_updates.cache.lock().unwrap().get_mut(&source).unwrap().0 = Instant::now() - CACHE_FOR - Duration::from_secs(1);
        state.harness_updates.latest(ProviderKind::ClaudeCode, &source).await.unwrap();
        assert_eq!(feed.asked.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn turning_version_checks_off_asks_nothing_and_clears_what_was_found() {
        let (state, _dir) = test_state();
        let feed = Arc::new(FakeFeed::new([(ProviderKind::ClaudeCode, "99.0.0")]));
        state.harness_updates.set_feed(feed.clone());
        let mut changes = state.harness_updates.subscribe();
        let stale = HarnessUpdate {
            version: Some("2.1.0".into()),
            latest_version: Some("2.1.330".into()),
            update_available: true,
            latest_checked_at: Some(Utc::now()),
            ..HarnessUpdate::unchecked(ProviderKind::ClaudeCode)
        };
        state.harness_updates.save(&state.store, stale);
        assert!(changes.try_recv().unwrap().iter().any(|record| record.update_available), "clients hear about it");

        let mut settings = state.settings.get();
        settings.check_harness_versions = false;
        state.settings.set(settings).unwrap();
        check_versions(&state, true).await;
        let record = state.harness_updates.record(ProviderKind::ClaudeCode);
        assert!(!record.update_available && record.latest_version.is_none() && record.latest_checked_at.is_none(), "{record:?}");
        assert!(feed.asked.lock().unwrap().is_empty(), "nothing is asked while checks are off");
        assert!(changes.try_recv().unwrap().iter().all(|record| !record.update_available));

        // Once checked, a harness is not asked again the same day; a record that did not change is not resent.
        let mut settings = state.settings.get();
        settings.check_harness_versions = true;
        state.settings.set(settings).unwrap();
        check_versions(&state, false).await;
        let asked = feed.asked.lock().unwrap().len();
        while changes.try_recv().is_ok() {}
        check_versions(&state, false).await;
        assert_eq!(feed.asked.lock().unwrap().len(), asked, "checked today already");
        assert!(changes.try_recv().is_err(), "nothing changed, nothing sent");
    }

    #[tokio::test]
    async fn run_on_this_machine_queues_the_harnesses_with_updates() {
        let (state, _dir) = test_state();
        let result = start_local(&state, &[]);
        assert!(result.started.is_empty());
        assert_eq!(result.reason.as_deref(), Some("Every harness is up to date"));
        let flagged = HarnessUpdate { update_available: true, ..HarnessUpdate::unchecked(ProviderKind::GrokBuild) };
        state.harness_updates.save(&state.store, flagged);
        let result = start_local(&state, &[]);
        assert_eq!(result.started, [ProviderKind::GrokBuild]);
        assert!(state.harness_updates.requested.lock().unwrap().contains(&ProviderKind::GrokBuild));
        let mut settings = state.settings.get();
        settings.check_harness_versions = false;
        state.settings.set(settings).unwrap();
        state.harness_updates.save(&state.store, HarnessUpdate::unchecked(ProviderKind::GrokBuild));
        assert_eq!(start_local(&state, &[]).reason.as_deref(), Some("Version checks are off on this machine"));
    }
}
