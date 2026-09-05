//! Scheduled, daemon-owned harness maintenance, isolated from active conversations.
use crate::state::AppState;
use chrono::Utc;
use kybern_protocol::{HarnessUpdate, HarnessUpdateStatus as Status, ProviderKind};
use kybern_store::Store;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};

pub struct HarnessUpdates {
    records: Mutex<HashMap<ProviderKind, HarnessUpdate>>,
    requested: Mutex<HashSet<ProviderKind>>,
    worker: tokio::sync::Mutex<()>,
}

impl HarnessUpdates {
    pub fn new(store: &Store) -> anyhow::Result<Self> {
        let mut records = HashMap::new();
        for kind in ProviderKind::ALL {
            let mut record =
                store.meta_get(&key(kind))?.and_then(|value| serde_json::from_str::<HarnessUpdate>(&value).ok()).unwrap_or_else(|| {
                    HarnessUpdate { kind, status: Status::NotChecked, message: "Not checked yet".into(), version: None, checked_at: None }
                });
            if matches!(record.status, Status::Updating | Status::Waiting) {
                record.status = Status::Failed;
                record.message = "The daemon restarted during an update request. Check the installation and retry.".into();
                record.checked_at = Some(Utc::now());
            }
            records.insert(kind, record);
        }
        Ok(Self { records: Mutex::new(records), requested: Mutex::new(HashSet::new()), worker: tokio::sync::Mutex::new(()) })
    }
    pub fn list(&self) -> Vec<HarnessUpdate> {
        let records = self.records.lock().unwrap();
        ProviderKind::ALL.iter().map(|kind| records[kind].clone()).collect()
    }
    fn record(&self, kind: ProviderKind) -> HarnessUpdate {
        self.records.lock().unwrap()[&kind].clone()
    }
    fn save(&self, store: &Store, record: HarnessUpdate) {
        if let Err(error) = store.meta_set(&key(record.kind), &serde_json::to_string(&record).expect("serializable record")) {
            tracing::error!(%error, "could not persist harness update status");
        }
        self.records.lock().unwrap().insert(record.kind, record);
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
}
fn key(kind: ProviderKind) -> String {
    format!("harness_update:{kind}")
}

fn due(record: &HarnessUpdate) -> bool {
    record.checked_at.is_none_or(|at| Utc::now().signed_duration_since(at).num_hours() >= 24)
}

pub async fn tick(state: AppState) {
    let Ok(_worker) = state.harness_updates.worker.try_lock() else { return };
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
        let result = tokio::select! {
            result = kybern_drivers::update::run(&plan, &config.env, &state.paths.root) => result,
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
        state.harness_updates.save(&state.store, record);
        state.harness_updates.requested.lock().unwrap().remove(&kind);
        drop(guard);
    }
}

pub async fn run(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(30));
    loop {
        tokio::select! {
            _ = state.shutdown.cancelled() => break,
            _ = interval.tick() => tick(state.clone()).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn daily_schedule_does_not_retry_recent_failures_or_restart_into_a_loop() {
        let mut record = HarnessUpdate {
            kind: ProviderKind::Codex,
            status: Status::Failed,
            message: String::new(),
            version: None,
            checked_at: Some(Utc::now()),
        };
        assert!(!due(&record));
        record.checked_at = Some(Utc::now() - chrono::Duration::hours(25));
        assert!(due(&record));
    }
}
