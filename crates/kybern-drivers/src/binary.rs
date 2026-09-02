//! Locate provider executables. Never installs anything.

use std::path::{Path, PathBuf};

use kybern_protocol::ProviderKind;

use crate::{DriverError, Result};

pub fn resolve(kind: ProviderKind, override_path: Option<&PathBuf>) -> Result<PathBuf> {
    if let Some(p) = override_path {
        if p.is_file() {
            return Ok(p.clone());
        }
        return Err(DriverError::BinaryNotFound(p.display().to_string()));
    }
    which::which(kind.default_binary()).map_err(|_| DriverError::BinaryNotFound(kind.default_binary().to_string()))
}

/// Run `<bin> --version` and return the first line, trimmed.
pub async fn version_of(bin: &Path, args: &[&str]) -> Option<String> {
    let out =
        tokio::time::timeout(std::time::Duration::from_secs(10), tokio::process::Command::new(bin).args(args).output()).await.ok()?.ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().next()?.trim();
    if line.is_empty() { None } else { Some(line.to_string()) }
}

/// Parse a leading `x.y.z` from a version line. Returns `(major, minor, patch)`.
pub fn parse_semver(line: &str) -> Option<(u64, u64, u64)> {
    let token = line.split(|c: char| !(c.is_ascii_digit() || c == '.')).find(|t| t.contains('.'))?;
    let mut it = token.split('.').map(|p| p.parse::<u64>().ok());
    Some((it.next()??, it.next()??, it.next().flatten().unwrap_or(0)))
}

pub fn at_least(found: &str, required: (u64, u64, u64)) -> bool {
    parse_semver(found).map(|v| v >= required).unwrap_or(false)
}
