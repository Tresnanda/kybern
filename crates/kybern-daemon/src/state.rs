use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use chrono::{DateTime, Utc};
use kybern_drivers::registry::DriverRegistry;
use kybern_protocol::{ProviderStatus, ThreadEvent};
use kybern_store::Store;
use tokio::sync::{Mutex, broadcast};
use tokio_util::sync::CancellationToken;

use crate::access::Pairing;
use crate::config::Paths;
use crate::orchestrator::Orchestrator;
use crate::settings::SettingsStore;
use crate::terminal::TerminalManager;

#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<Inner>,
}

pub struct Inner {
    pub paths: Paths,
    pub store: Store,
    pub drivers: DriverRegistry,
    pub events: broadcast::Sender<ThreadEvent>,
    pub orchestrator: Orchestrator,
    pub terminals: TerminalManager,
    pub settings: SettingsStore,
    pub provider_catalogs: ProviderCatalogCache,
    pub harness_updates: crate::harness_updates::HarnessUpdates,
    pub daemon_updates: crate::self_update::DaemonUpdates,
    /// Started by the desktop app, whose bundle owns this binary.
    pub desktop_managed: std::sync::atomic::AtomicBool,
    /// A newer binary is in place; hand over to it after the graceful shutdown.
    pub restart_pending: std::sync::atomic::AtomicBool,
    pub pairing: Pairing,
    pub tickets: crate::access::Tickets,
    pub revoked_tokens: broadcast::Sender<uuid::Uuid>,
    pub listen_addr: std::sync::RwLock<Option<std::net::SocketAddr>>,
    pub exposure: crate::exposure::Exposure,
    pub advertised_urls: std::sync::RwLock<Vec<String>>,
    pub port: std::sync::atomic::AtomicU16,
    pub bootstrap_token: String,
    pub environment_id: String,
    pub started_at: DateTime<Utc>,
    pub shutdown: CancellationToken,
    /// Open WebSocket connections. Maintained by `ws::run`.
    pub connections: std::sync::atomic::AtomicUsize,
    /// When the daemon last had no clients, sessions, terminals, or queued
    /// work; `None` while anything is active. Maintained by the maintenance sweep.
    pub idle_since: std::sync::RwLock<Option<DateTime<Utc>>>,
    /// Latest host power probe; `None` until the first sweep or on hosts
    /// that cannot report it. Maintained by the maintenance sweep.
    pub on_battery: std::sync::RwLock<Option<bool>>,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.inner
    }
}

impl AppState {
    /// Whether `background.save_power_on_battery` applies right now.
    pub fn saving_power(&self) -> bool {
        self.settings.get().background.save_power_on_battery
            && *self.on_battery.read().unwrap_or_else(|poisoned| poisoned.into_inner()) == Some(true)
    }

    /// Construct daemon state before restart recovery. The desktop cold-start
    /// handshake binds its socket after this step, then recovery completes
    /// before axum begins accepting requests.
    pub fn initialize(paths: &Paths) -> Result<Self> {
        let store = Store::open(&paths.db)?;
        let bootstrap_token = crate::auth::ensure_bootstrap(&store, &paths.token_file)?;
        let environment_id = match store.meta_get("environment_id")? {
            Some(id) => id,
            None => {
                let id = uuid::Uuid::now_v7().to_string();
                store.meta_set("environment_id", &id)?;
                id
            }
        };
        let (events, _) = broadcast::channel(8192);
        let drivers = DriverRegistry::with_defaults();
        let settings = SettingsStore::load(&paths.settings)?;
        let harness_updates = crate::harness_updates::HarnessUpdates::new(&store)?;
        let daemon_updates = crate::self_update::DaemonUpdates::new(&store)?;
        let orchestrator = Orchestrator::new(store.clone(), drivers.clone(), events.clone(), paths.clone(), settings.clone());
        Ok(Self {
            inner: Arc::new(Inner {
                paths: paths.clone(),
                store,
                drivers,
                events,
                orchestrator,
                terminals: TerminalManager::default(),
                settings,
                provider_catalogs: ProviderCatalogCache::default(),
                harness_updates,
                daemon_updates,
                desktop_managed: std::sync::atomic::AtomicBool::new(false),
                restart_pending: std::sync::atomic::AtomicBool::new(false),
                pairing: Pairing::default(),
                tickets: crate::access::Tickets::default(),
                revoked_tokens: broadcast::channel(128).0,
                listen_addr: std::sync::RwLock::new(None),
                exposure: Default::default(),
                advertised_urls: std::sync::RwLock::new(vec![]),
                port: std::sync::atomic::AtomicU16::new(0),
                bootstrap_token,
                environment_id,
                started_at: Utc::now(),
                shutdown: CancellationToken::new(),
                connections: std::sync::atomic::AtomicUsize::new(0),
                idle_since: std::sync::RwLock::new(None),
                on_battery: std::sync::RwLock::new(None),
            }),
        })
    }
}

const PROVIDER_CATALOG_TTL: Duration = Duration::from_secs(60);

struct CachedProviderCatalog {
    providers: Vec<ProviderStatus>,
    refreshed_at: Instant,
}

/// Keeps expensive, harness-owned model discovery off repeated app boots.
///
/// The cache key includes project context and provider settings. A single
/// refresh lock also coalesces concurrent desktop/CLI requests without adding
/// any provider-specific policy to the daemon.
#[derive(Default)]
pub struct ProviderCatalogCache {
    entries: Mutex<HashMap<String, CachedProviderCatalog>>,
    refresh: Mutex<()>,
}

impl ProviderCatalogCache {
    pub async fn invalidate(&self) {
        self.entries.lock().await.clear();
    }
    pub async fn get_or_refresh<F, Fut>(&self, key: String, force_refresh: bool, refresh: F) -> Vec<ProviderStatus>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Vec<ProviderStatus>>,
    {
        if !force_refresh && let Some(providers) = self.fresh(&key).await {
            return providers;
        }

        let _refresh = self.refresh.lock().await;
        if !force_refresh && let Some(providers) = self.fresh(&key).await {
            return providers;
        }

        let providers = refresh().await;
        let mut entries = self.entries.lock().await;
        entries.retain(|_, entry| entry.refreshed_at.elapsed() < PROVIDER_CATALOG_TTL);
        entries.insert(key, CachedProviderCatalog { providers: providers.clone(), refreshed_at: Instant::now() });
        providers
    }

    async fn fresh(&self, key: &str) -> Option<Vec<ProviderStatus>> {
        self.entries
            .lock()
            .await
            .get(key)
            .filter(|entry| entry.refreshed_at.elapsed() < PROVIDER_CATALOG_TTL)
            .map(|entry| entry.providers.clone())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[tokio::test]
    async fn provider_catalog_refreshes_are_coalesced() {
        let cache = ProviderCatalogCache::default();
        let calls = AtomicUsize::new(0);
        let load = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Vec::new()
        };

        let (first, second) =
            tokio::join!(cache.get_or_refresh("global".into(), false, load), cache.get_or_refresh("global".into(), false, load));

        assert!(first.is_empty());
        assert!(second.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn forced_provider_catalog_refresh_bypasses_cache() {
        let cache = ProviderCatalogCache::default();
        let calls = AtomicUsize::new(0);
        let mut load = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        };

        cache.get_or_refresh("global".into(), false, &mut load).await;
        cache.get_or_refresh("global".into(), true, &mut load).await;

        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
