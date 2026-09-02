use std::path::PathBuf;

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Paths {
    pub root: PathBuf,
    pub db: PathBuf,
    pub token_file: PathBuf,
    pub port_file: PathBuf,
    pub worktrees: PathBuf,
    pub assets: PathBuf,
}

impl Paths {
    pub fn resolve(override_root: Option<PathBuf>) -> Result<Self> {
        let root = match override_root {
            Some(r) => r,
            None => directories::BaseDirs::new().context("no home directory")?.home_dir().join(".kybern"),
        };
        std::fs::create_dir_all(&root)?;
        Ok(Self {
            db: root.join("state.sqlite"),
            token_file: root.join("daemon.token"),
            port_file: root.join("daemon.port"),
            worktrees: root.join("worktrees"),
            assets: root.join("assets"),
            root,
        })
    }
}
