use std::sync::Arc;

use anyhow::Result;
use chrono::{DateTime, Utc};
use kybern_drivers::registry::DriverRegistry;
use kybern_protocol::ThreadEvent;
use kybern_store::Store;
use tokio::sync::broadcast;

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
    pub pairing: Pairing,
    pub port: std::sync::atomic::AtomicU16,
    pub bootstrap_token: String,
    pub environment_id: String,
    pub started_at: DateTime<Utc>,
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.inner
    }
}

impl AppState {
    pub async fn init(paths: &Paths) -> Result<Self> {
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
        let orchestrator = Orchestrator::new(store.clone(), drivers.clone(), events.clone(), paths.clone(), settings.clone());
        orchestrator.recover_after_restart().await?;
        Ok(Self {
            inner: Arc::new(Inner {
                paths: paths.clone(),
                store,
                drivers,
                events,
                orchestrator,
                terminals: TerminalManager::default(),
                settings,
                pairing: Pairing::default(),
                port: std::sync::atomic::AtomicU16::new(0),
                bootstrap_token,
                environment_id,
                started_at: Utc::now(),
            }),
        })
    }
}
