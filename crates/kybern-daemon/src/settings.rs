//! settings.json: loaded at startup, replaced atomically on update.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use kybern_protocol::Settings;

#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
    current: Arc<RwLock<Settings>>,
    changed: tokio::sync::broadcast::Sender<Settings>,
}

impl SettingsStore {
    pub fn load(path: &Path) -> Result<Self> {
        let settings = match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let s = Settings::default();
                write_atomic(path, &s)?;
                s
            }
            Err(e) => return Err(e.into()),
        };
        crate::provider_assets::prepare_existing(&settings);
        Ok(Self { path: path.to_path_buf(), current: Arc::new(RwLock::new(settings)), changed: tokio::sync::broadcast::channel(32).0 })
    }

    /// The data directory `settings.json` lives in.
    pub fn dir(&self) -> &Path {
        self.path.parent().unwrap_or(Path::new("."))
    }

    pub fn get(&self) -> Settings {
        self.current.read().unwrap().clone()
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Settings> {
        self.changed.subscribe()
    }

    pub fn set(&self, settings: Settings) -> Result<Settings> {
        validate_orchestration(&settings.orchestration)?;
        if let Some(omp) = settings.providers.get(&kybern_protocol::ProviderKind::Omp) {
            for profile in omp.env.get("OMP_PROFILE").into_iter().chain(omp.project_profiles.values()) {
                kybern_drivers::omp_profile::normalize(profile)?;
            }
        }
        crate::provider_accounts::validate(&settings)?;
        write_atomic(&self.path, &settings)?;
        *self.current.write().unwrap() = settings.clone();
        let _ = self.changed.send(settings.clone());
        Ok(settings)
    }
}

/// Delegation limits must stay in the ranges the settings screen offers.
fn validate_orchestration(orchestration: &kybern_protocol::OrchestrationSettings) -> Result<()> {
    anyhow::ensure!(
        (1..=16).contains(&orchestration.max_active_children),
        "Active agents per thread must be between 1 and 16. Change the value and save again."
    );
    anyhow::ensure!(
        (1..=4).contains(&orchestration.max_depth),
        "Delegation depth must be between 1 and 4. Change the value and save again."
    );
    Ok(())
}

fn write_atomic(path: &Path, settings: &Settings) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(settings)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Profile overrides use the registered project, never a temporary worktree cwd.
/// Supply the effective OMP environment to discovery, imports and process spawn.
pub fn provider_settings(
    settings: &Settings,
    kind: kybern_protocol::ProviderKind,
    project_path: Option<&str>,
) -> kybern_protocol::ProviderSettings {
    let mut provider = settings.providers.get(&kind).cloned().unwrap_or_default();
    if kind == kybern_protocol::ProviderKind::Omp
        && let Some(profile) = project_path.and_then(|path| provider.project_profiles.get(path))
    {
        provider.env.insert("OMP_PROFILE".into(), profile.trim().into());
    }
    let instance = crate::provider_accounts::resolve(&provider, project_path, None);
    // Settings are validated before persistence. Legacy defaults stay unchanged.
    if let Ok(env) = crate::provider_accounts::environment(&provider, kind, &instance) {
        provider.env = env;
    }
    provider
}

#[cfg(test)]
mod orchestration_tests {
    use super::*;

    #[test]
    fn orchestration_limits_are_range_checked_on_update() {
        let dir = std::env::temp_dir().join(format!("kybern-settings-test-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::load(&dir.join("settings.json")).unwrap();
        let mut settings = store.get();
        for (children, depth) in [(0, 2), (17, 2), (4, 0), (4, 5)] {
            settings.orchestration.max_active_children = children;
            settings.orchestration.max_depth = depth;
            let error = store.set(settings.clone()).unwrap_err().to_string();
            assert!(error.contains("between"), "{error}");
        }
        assert_eq!(store.get().orchestration, kybern_protocol::OrchestrationSettings::default(), "rejected updates change nothing");
        settings.orchestration.max_active_children = 16;
        settings.orchestration.max_depth = 4;
        assert_eq!(store.set(settings).unwrap().orchestration.max_active_children, 16);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[cfg(test)]
mod profile_tests {
    use super::*;
    use kybern_protocol::ProviderKind;

    #[test]
    fn project_profile_overrides_global_env_including_explicit_default() {
        let mut settings = Settings::default();
        let omp = settings.providers.entry(ProviderKind::Omp).or_default();
        omp.env.insert("OMP_PROFILE".into(), "global".into());
        omp.env.insert("PI_PROFILE".into(), "legacy".into());
        omp.project_profiles.insert("/projects/work".into(), "work".into());
        omp.project_profiles.insert("/projects/default".into(), "".into());
        assert_eq!(provider_settings(&settings, ProviderKind::Omp, Some("/projects/work")).env["OMP_PROFILE"], "work");
        assert_eq!(provider_settings(&settings, ProviderKind::Omp, Some("/projects/default")).env["OMP_PROFILE"], "");
        assert_eq!(provider_settings(&settings, ProviderKind::Omp, Some("/projects/else")).env["OMP_PROFILE"], "global");
        assert_eq!(provider_settings(&settings, ProviderKind::Omp, None).env["OMP_PROFILE"], "global");
        assert!(provider_settings(&settings, ProviderKind::Pi, Some("/projects/work")).env.is_empty());
    }
}
