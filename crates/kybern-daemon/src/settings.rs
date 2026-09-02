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
