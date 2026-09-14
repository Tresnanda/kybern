//! settings.json: loaded at startup, replaced atomically on update.

use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use anyhow::{Context, Result};
use kybern_protocol::Settings;

#[derive(Clone)]
pub struct SettingsStore {
    path: PathBuf,
    current: Arc<RwLock<Settings>>,
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
        Ok(Self { path: path.to_path_buf(), current: Arc::new(RwLock::new(settings)) })
    }

    pub fn get(&self) -> Settings {
        self.current.read().unwrap().clone()
    }

    pub fn set(&self, settings: Settings) -> Result<Settings> {
        if let Some(omp) = settings.providers.get(&kybern_protocol::ProviderKind::Omp) {
            for profile in omp.env.get("OMP_PROFILE").into_iter().chain(omp.project_profiles.values()) {
                kybern_drivers::omp_profile::normalize(profile)?;
            }
        }
        write_atomic(&self.path, &settings)?;
        *self.current.write().unwrap() = settings.clone();
        Ok(settings)
    }
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
    provider
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
