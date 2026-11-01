//! Locate provider executables. Never installs anything.

use kybern_protocol::process::NoWindow;
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
    which::which(kind.default_binary())
        .ok()
        .or_else(|| installed_location(kind))
        .ok_or_else(|| DriverError::BinaryNotFound(kind.default_binary().to_string()))
}

/// Where a harness's own installer puts its binary when that folder is not on
/// the daemon's PATH (a desktop app starts with a short PATH).
fn installed_location(kind: ProviderKind) -> Option<PathBuf> {
    if kind != ProviderKind::Antigravity {
        return None;
    }
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    antigravity_candidates(home.as_deref(), local_app_data.as_deref()).into_iter().find(|path| path.is_file())
}

pub(crate) fn antigravity_candidates(home: Option<&Path>, local_app_data: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(home) = home {
        paths.push(home.join(".local").join("bin").join("agy"));
    }
    if let Some(local) = local_app_data {
        paths.push(local.join("agy").join("bin").join("agy.exe"));
    }
    paths
}

/// Run `<bin> --version` and return the first line, trimmed.
pub async fn version_of(bin: &Path, args: &[&str]) -> Option<String> {
    let run = async {
        // Linux refuses to run a file that a freshly forked child of another
        // thread still holds open for writing (ETXTBSY) until that child execs,
        // e.g. a harness just installed or updated. Retry briefly.
        for _ in 0..25 {
            match crate::process_tree::output(tokio::process::Command::new(bin).no_window().args(args)).await {
                Err(error) if error.kind() == std::io::ErrorKind::ExecutableFileBusy => {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await
                }
                result => return result,
            }
        }
        crate::process_tree::output(tokio::process::Command::new(bin).no_window().args(args)).await
    };
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), run).await.ok()?.ok()?;
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
