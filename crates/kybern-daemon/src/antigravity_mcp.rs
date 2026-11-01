//! Kybern's one entry in Antigravity's MCP servers.
//!
//! `agy` has no per-session MCP configuration: only a global list, kept in
//! `$HOME/.gemini/config/mcp_config.json` and changed by `agy mcp add` and
//! `agy mcp remove`. Kybern adds a single stdio entry, `kybern`, that runs
//! `kybern mcp-bridge`. The bridge is inert until a turn's environment gives it
//! the session's endpoint and credential, so every other `agy` session sees an
//! MCP server with no tools.
//!
//! The file is only ever changed through `agy`'s own CLI; Kybern reads it to see
//! whether the entry is there and whose it is.

use std::path::{Path, PathBuf};
use std::time::Duration;

use kybern_protocol::process::NoWindow;
use serde_json::Value;
use tokio::process::Command;

pub const SERVER: &str = "kybern";
const BRIDGE_ARG: &str = "mcp-bridge";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);

pub const FOREIGN: &str = "An Antigravity MCP server named kybern already exists and isn't Kybern's. Remove it with `agy mcp remove kybern`, then turn this on again.";

/// Why the entry could not be put in place.
#[derive(Debug, PartialEq)]
pub enum Failure {
    /// Another program's entry already holds the name.
    Foreign,
    Other(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Foreign => formatter.write_str(FOREIGN),
            Failure::Other(text) => formatter.write_str(text),
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Entry {
    Missing,
    /// Kybern's: a `kybern` executable running `mcp-bridge`.
    Ours {
        command: PathBuf,
    },
    Foreign,
}

pub fn home() -> Option<PathBuf> {
    ["HOME", "USERPROFILE"].iter().find_map(|key| std::env::var_os(key)).filter(|home| !home.is_empty()).map(PathBuf::from)
}

fn config_path(home: &Path) -> PathBuf {
    home.join(".gemini/config/mcp_config.json")
}

/// Whether `config` (the parsed `mcp_config.json`) holds a `kybern` entry, and whose.
pub fn classify(config: &Value) -> Entry {
    let Some(entry) = config.get("mcpServers").and_then(|servers| servers.get(SERVER)) else { return Entry::Missing };
    let args: Vec<&str> =
        entry.get("args").and_then(Value::as_array).map(|args| args.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    let command = entry.get("command").and_then(Value::as_str).map(PathBuf::from);
    // Either separator: the file may have been written on Windows.
    let is_kybern = |command: &Path| {
        let text = command.to_string_lossy();
        let name = text.rsplit(['/', '\\']).next().unwrap_or("");
        name.eq_ignore_ascii_case("kybern") || name.eq_ignore_ascii_case("kybern.exe")
    };
    match command {
        Some(command) if args == [BRIDGE_ARG] && is_kybern(&command) => Entry::Ours { command },
        _ => Entry::Foreign,
    }
}

pub fn read_entry(home: &Path) -> Entry {
    match std::fs::read(config_path(home)).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()) {
        Some(config) => classify(&config),
        None => Entry::Missing,
    }
}

/// One `agy mcp …` run, serialized so two sessions never write the file at once.
async fn agy_mcp(agy: &Path, args: &[&std::ffi::OsStr]) -> Result<(), Failure> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    let mut command = Command::new(agy).no_window();
    command.arg("mcp").args(args).stdin(std::process::Stdio::null()).kill_on_drop(true);
    match tokio::time::timeout(COMMAND_TIMEOUT, command.output()).await {
        Ok(Ok(output)) if output.status.success() => Ok(()),
        Ok(Ok(output)) => {
            let text = String::from_utf8_lossy(&output.stderr);
            let line = text.lines().rev().find(|line| !line.trim().is_empty()).unwrap_or("").trim();
            Err(Failure::Other(format!("`agy mcp` failed ({line}). Check that Antigravity runs, then turn this on again.")))
        }
        _ => Err(Failure::Other("`agy mcp` didn't answer. Check that Antigravity runs, then turn this on again.".into())),
    }
}

/// Make the `kybern` entry present and Kybern's. Adds it when it is missing or
/// its command no longer exists, and does nothing otherwise, so several daemons
/// on one machine do not rewrite each other's entry.
pub async fn ensure(agy: &Path, cli: &Path) -> Result<(), Failure> {
    let home = home().ok_or_else(|| Failure::Other("Kybern can't find your home folder.".into()))?;
    match read_entry(&home) {
        Entry::Foreign => return Err(Failure::Foreign),
        Entry::Ours { command } if command.is_file() => return Ok(()),
        Entry::Ours { .. } | Entry::Missing => {}
    }
    agy_mcp(agy, &["add".as_ref(), SERVER.as_ref(), "--".as_ref(), cli.as_os_str(), BRIDGE_ARG.as_ref()]).await?;
    match read_entry(&home) {
        Entry::Ours { .. } => Ok(()),
        Entry::Foreign => Err(Failure::Foreign),
        Entry::Missing => Err(Failure::Other("Antigravity didn't save the kybern entry. Turn this on again.".into())),
    }
}

/// Remove the entry, only when it is Kybern's.
pub async fn remove(agy: &Path) -> Result<(), Failure> {
    let Some(home) = home() else { return Ok(()) };
    match read_entry(&home) {
        Entry::Ours { .. } => agy_mcp(agy, &["remove".as_ref(), SERVER.as_ref()]).await,
        Entry::Missing | Entry::Foreign => Ok(()),
    }
}

fn agy_binary(settings: &kybern_protocol::Settings) -> Result<PathBuf, Failure> {
    let configured = settings.providers.get(&kybern_protocol::ProviderKind::Antigravity).and_then(|provider| provider.binary.clone());
    kybern_drivers::binary::resolve(kybern_protocol::ProviderKind::Antigravity, configured.map(PathBuf::from).as_ref())
        .map_err(|_| Failure::Other("Antigravity isn't installed, so Kybern can't add its tools yet.".into()))
}

/// Turning "Kybern tools" on: put the entry in place with this machine's `agy` and `kybern`.
pub async fn turn_on(settings: &kybern_protocol::Settings) -> Result<(), Failure> {
    let agy = agy_binary(settings)?;
    let cli = crate::askpass::find_cli()
        .ok_or_else(|| Failure::Other("Kybern can't find its command-line tool, so Antigravity can't start the bridge.".into()))?;
    ensure(&agy, &cli).await
}

/// Turning it off: take the entry out when it is Kybern's.
pub async fn turn_off(settings: &kybern_protocol::Settings) -> Result<(), Failure> {
    remove(&agy_binary(settings)?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_kybern_bridge_entry_is_ours() {
        assert_eq!(classify(&json!({})), Entry::Missing);
        assert_eq!(classify(&json!({"mcpServers": {"other": {"command": "x"}}})), Entry::Missing);
        let ours = json!({"mcpServers": {"kybern": {"command": "/Applications/Kybern.app/Contents/MacOS/kybern", "args": ["mcp-bridge"]}}});
        assert_eq!(classify(&ours), Entry::Ours { command: PathBuf::from("/Applications/Kybern.app/Contents/MacOS/kybern") });
        let windows = json!({"mcpServers": {"kybern": {"command": "C:\\k\\kybern.exe", "args": ["mcp-bridge"]}}});
        assert!(matches!(classify(&windows), Entry::Ours { .. }));
        for foreign in [
            json!({"mcpServers": {"kybern": {"command": "node", "args": ["server.js"]}}}),
            json!({"mcpServers": {"kybern": {"command": "kybern", "args": ["mcp-bridge", "--x"]}}}),
            json!({"mcpServers": {"kybern": {"serverUrl": "https://example.com/mcp"}}}),
        ] {
            assert_eq!(classify(&foreign), Entry::Foreign, "{foreign}");
        }
    }

    #[test]
    fn a_missing_file_has_no_entry() {
        let dir = std::env::temp_dir().join(format!("kybern-agy-mcp-{}", uuid::Uuid::new_v4()));
        assert_eq!(read_entry(&dir), Entry::Missing);
        std::fs::create_dir_all(dir.join(".gemini/config")).unwrap();
        std::fs::write(config_path(&dir), r#"{"mcpServers":{"kybern":{"command":"/a/kybern","args":["mcp-bridge"]}}}"#).unwrap();
        assert_eq!(read_entry(&dir), Entry::Ours { command: PathBuf::from("/a/kybern") });
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
