//! The small Claude Code plugin Kybern ships so rarely used built-in tools wait
//! behind ToolSearch instead of being described in every request.
//!
//! Claude Code re-sends the full description of each built-in tool that is not
//! deferred. With `CLAUDE_CODE_ARTIFACT=1` (set in `claude.rs`) the Artifact
//! tool alone is about 22,000 characters. The plugin's `tool.describe` hook
//! (`claude-plugin/hooks/register.ts`) lists a fixed set of such tools behind
//! ToolSearch; Claude loads one when a turn needs it.
//!
//! The three plugin files are embedded in the daemon and written to
//! `<cache dir>/claude-plugin/<hash>/` before a session starts, so an installed
//! build needs no resource folder beside the binary on any OS. The folder name
//! holds a hash of the contents, so an upgrade writes a new folder and a running
//! session keeps the files it loaded; folders an older build wrote are removed
//! a day later, when a new one is written.

use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::binary::at_least;

const PLUGIN_JSON: &str = include_str!("../claude-plugin/.claude-plugin/plugin.json");
const HOOKS_JSON: &str = include_str!("../claude-plugin/hooks/hooks.json");
const REGISTER_TS: &str = include_str!("../claude-plugin/hooks/register.ts");

const FILES: [(&str, &str); 3] =
    [(".claude-plugin/plugin.json", PLUGIN_JSON), ("hooks/hooks.json", HOOKS_JSON), ("hooks/register.ts", REGISTER_TS)];

/// The first Claude Code release that loads a plugin's hook modules and
/// answers `tool.describe` with `isDeferred`: 2.1.286, found by running the
/// plugin on 2.1.143 to 2.1.286 (no hook ran on 2.1.285 or earlier). Older
/// releases get no `--plugin-dir` and keep every tool inline.
pub(crate) const MIN_VERSION: (u64, u64, u64) = (2, 1, 286);

/// Set to `0`, `false`, `no` or `off` (in the account's environment or the
/// daemon's) to start Claude without the plugin.
pub(crate) const OPT_OUT_ENV: &str = "KYBERN_CLAUDE_TOOL_PLUGIN";

/// Whether a session should be started with the plugin: the Claude Code
/// release is known, understands plugin hook modules, and the user has not
/// opted out.
pub(crate) fn should_load(version: Option<&str>, opt_out: Option<&str>) -> bool {
    !opted_out(opt_out) && version.is_some_and(|version| at_least(version, MIN_VERSION))
}

/// Whether `KYBERN_CLAUDE_TOOL_PLUGIN` turns the plugin off.
pub(crate) fn opted_out(value: Option<&str>) -> bool {
    value.is_some_and(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "0" | "false" | "no" | "off"))
}

/// Write the plugin under `root` (when it is not there yet) and return the
/// folder to pass to `--plugin-dir`.
pub(crate) fn install(root: &Path) -> std::io::Result<PathBuf> {
    // Claude runs in the session's folder, so a relative data dir would not resolve there.
    let root = std::path::absolute(root)?;
    let dir = root.join(format!("{FOLDER_PREFIX}{}", &contents_hash()[..12]));
    let mut wrote = false;
    for (relative, contents) in FILES {
        let path = dir.join(relative);
        if has_contents(&path, contents) {
            continue;
        }
        // Another session starting at the same moment may have put the same file
        // there first, and Windows refuses to replace a file someone has open.
        write_atomically(&path, contents).or_else(|error| if has_contents(&path, contents) { Ok(()) } else { Err(error) })?;
        wrote = true;
    }
    if wrote {
        remove_stale_folders(&root, &dir, STALE_AFTER);
    }
    Ok(dir)
}

const FOLDER_PREFIX: &str = "kybern-tool-loading-";

/// How long a folder written by an older build is kept: long enough for any
/// session that loaded it to have started.
const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

fn has_contents(path: &Path, contents: &str) -> bool {
    std::fs::read_to_string(path).is_ok_and(|existing| existing == contents)
}

/// Remove plugin folders an older build wrote, once this build writes its own.
/// Best effort: a folder still in use (Windows) stays until the next upgrade.
fn remove_stale_folders(root: &Path, current: &Path, older_than: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let ours = entry.file_name().to_str().is_some_and(|name| name.starts_with(FOLDER_PREFIX));
        let old = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|age| age >= older_than);
        if ours && old && path != current && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

fn contents_hash() -> String {
    let mut hasher = Sha256::new();
    for (relative, contents) in FILES {
        hasher.update(relative.as_bytes());
        hasher.update([0]);
        hasher.update(contents.as_bytes());
        hasher.update([0]);
    }
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Write beside the target and rename, so a session starting at the same time
/// never reads half a file.
fn write_atomically(path: &Path, contents: &str) -> std::io::Result<()> {
    let parent = path.parent().expect("plugin files live in a folder");
    std::fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("file"),
        uuid::Uuid::new_v4().simple()
    ));
    let result = std::fs::File::create(&temporary).and_then(|mut file| file.write_all(contents.as_bytes()));
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    std::fs::rename(&temporary, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_releases_with_plugin_hook_modules_load_the_plugin() {
        assert!(should_load(Some("2.1.319 (Claude Code)"), None));
        assert!(should_load(Some("2.1.299 (Claude Code)"), None));
        assert!(should_load(Some("2.1.286 (Claude Code)"), None));
        assert!(should_load(Some("2.2.0"), None));
        assert!(should_load(Some("3.0.0"), None));
        assert!(!should_load(Some("2.1.285 (Claude Code)"), None));
        assert!(!should_load(Some("2.1.143"), None));
        assert!(!should_load(Some("1.9.9"), None));
        assert!(!should_load(Some("not a version"), None));
        assert!(!should_load(None, None), "an unknown release keeps today's launch");
    }

    #[test]
    fn the_opt_out_wins_over_a_supported_release() {
        for value in ["0", "false", "FALSE", " no ", "off"] {
            assert!(!should_load(Some("2.1.319"), Some(value)), "{value:?}");
        }
        for value in ["1", "true", "", "yes"] {
            assert!(should_load(Some("2.1.319"), Some(value)), "{value:?}");
        }
    }

    #[test]
    fn install_writes_the_plugin_once_and_repairs_a_damaged_copy() {
        let root = tempfile::tempdir().unwrap();
        let dir = install(root.path()).unwrap();
        for (relative, contents) in FILES {
            assert_eq!(std::fs::read_to_string(dir.join(relative)).unwrap(), contents, "{relative}");
        }
        assert_eq!(install(root.path()).unwrap(), dir, "the folder name is stable");
        assert!(dir.is_absolute());

        std::fs::write(dir.join("hooks/register.ts"), "tampered").unwrap();
        std::fs::remove_file(dir.join("hooks/hooks.json")).unwrap();
        assert_eq!(install(root.path()).unwrap(), dir);
        assert_eq!(std::fs::read_to_string(dir.join("hooks/register.ts")).unwrap(), REGISTER_TS);
        assert_eq!(std::fs::read_to_string(dir.join("hooks/hooks.json")).unwrap(), HOOKS_JSON);
        let leftovers = std::fs::read_dir(dir.join("hooks"))
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn an_upgrade_removes_folders_older_builds_wrote_but_keeps_its_own() {
        let root = tempfile::tempdir().unwrap();
        let older = root.path().join(format!("{FOLDER_PREFIX}000000000000"));
        std::fs::create_dir_all(older.join("hooks")).unwrap();
        std::fs::write(older.join("hooks/register.ts"), "old").unwrap();
        let unrelated = root.path().join("something-else");
        std::fs::create_dir_all(&unrelated).unwrap();

        // A fresh folder from an older build is kept for sessions that may still be starting with it.
        let dir = install(root.path()).unwrap();
        assert!(older.is_dir());

        remove_stale_folders(root.path(), &dir, std::time::Duration::ZERO);
        assert!(!older.exists(), "an older build's folder is removed");
        assert!(dir.join("hooks/register.ts").is_file(), "the current folder stays");
        assert!(unrelated.is_dir(), "only the plugin's own folders are touched");
    }

    #[test]
    fn a_relative_root_gives_an_absolute_plugin_folder() {
        let dir = install(Path::new("target/relative-plugin-root-test")).unwrap();
        assert!(dir.is_absolute(), "{dir:?}");
        assert!(dir.join("hooks/register.ts").is_file());
        std::fs::remove_dir_all(std::path::absolute("target/relative-plugin-root-test").unwrap()).unwrap();
    }

    #[test]
    fn the_embedded_plugin_matches_what_claude_code_expects() {
        let manifest: serde_json::Value = serde_json::from_str(PLUGIN_JSON).unwrap();
        assert_eq!(manifest["name"], "kybern-tool-loading");
        let hooks: serde_json::Value = serde_json::from_str(HOOKS_JSON).unwrap();
        assert_eq!(hooks["modules"], serde_json::json!(["./register.ts"]));
        for tool in ["Artifact", "ArtifactData", "ArtifactComments", "Workflow", "ScheduleWakeup", "ReportFindings", "ListAgents"] {
            assert!(REGISTER_TS.contains(&format!("'{tool}'")), "{tool} should be listed behind ToolSearch");
        }
        assert!(REGISTER_TS.contains("isDeferred: true"));
    }
}
