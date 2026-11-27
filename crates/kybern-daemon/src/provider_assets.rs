//! Share reusable provider assets between a harness's accounts on one machine. Auth and plugin
//! runtime data stay in each account's folder.
//!
//! Conversations are shared too, so a thread that switches account resumes its own native
//! session: Claude Code's `projects/` and Codex's sessions, archived sessions, shell snapshots,
//! writer locks and session index link to the terminal login's (`~/.claude`, `~/.codex`), and
//! named Codex accounts open its databases through `CODEX_SQLITE_HOME`. `auth.json`,
//! `auth.lock`, `.credentials.json` and `models_cache.json` stay private. Nothing in the terminal
//! login's folder is replaced or linked; it only gains the named accounts' conversations. Moving an account's
//! existing conversations into the shared folder never overwrites or deletes one: a file the
//! shared folder already has stays in the account's `*.kybern-local-*` backup.
use anyhow::{Result, ensure};
use kybern_protocol::{ProviderKind, ProviderSettings, Settings};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

// Preparation also runs before probes/spawns. Serialize migrations and config writes
// across those paths; no process-wide environment changes (including in tests).
static PREPARE: Mutex<()> = Mutex::new(());

pub fn prepare_existing(settings: &Settings) {
    for (kind, provider) in &settings.providers {
        if let Err(error) = prepare(provider, *kind) {
            tracing::warn!(provider = %kind, %error, "Could not share account skills and plugins");
        }
    }
}

pub fn prepare(provider: &ProviderSettings, kind: ProviderKind) -> Result<()> {
    if provider.accounts.is_empty() {
        return Ok(());
    }
    let _guard = PREPARE.lock().map_err(|_| anyhow::anyhow!("Account asset preparation interrupted. Restart Kybern and try again."))?;
    let Some(home) = home_of(provider) else {
        return Ok(());
    };
    let (shared, assets) = layout(kind, &provider.env, &home);
    ensure!(shared.is_absolute(), "Shared provider directory must be absolute. Fix the provider environment in Settings.");
    if kind == ProviderKind::ClaudeCode {
        for account in provider.accounts.values() {
            let root = Path::new(&account.directory);
            if root.is_dir() {
                merge_plugin_switches(&root.join("settings.json"), &shared.join("settings.json"))?;
            }
        }
    }
    for account in provider.accounts.values() {
        let account_root = Path::new(&account.directory);
        // Removed/unavailable imported accounts must not create directories on a disconnected volume.
        if !account_root.is_dir() {
            continue;
        }
        for (local, global, asset) in &assets {
            // Sharing is a convenience: an account whose assets cannot be linked
            // still signs in and runs, with its own account-local copies.
            let local = account_root.join(local);
            if let Err(error) = link_asset(&local, &shared.join(global), *asset) {
                tracing::warn!(provider = %kind, local = %local.display(), error = format!("{error:#}"), "Could not share account asset; the account keeps its own copy");
            }
        }
        if kind == ProviderKind::Codex
            && let Err(error) = keep_codex_login_in_file(account_root)
        {
            tracing::warn!(account = %account_root.display(), error = format!("{error:#}"), "Could not pin the Codex account's login to its auth.json");
        }
        if kind == ProviderKind::ClaudeCode {
            // Only booleans naming plugins are copied. Never share settings.json:
            // it can contain MCP headers, env secrets, hooks and account preferences.
            merge_plugin_switches(&shared.join("settings.json"), &account_root.join("settings.json"))?;
        }
    }
    Ok(())
}

/// How a shared asset is linked and how an account's own copy is merged into the shared one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssetKind {
    /// A folder: entries the shared folder lacks move into it.
    Dir,
    /// A JSON registry: missing keys and array entries are added.
    Registry,
    /// A JSON Lines file: lines the shared file lacks are appended.
    Lines,
}
use AssetKind::{Dir, Lines, Registry};

type Asset = (&'static str, &'static str, AssetKind);

fn configured(env: &BTreeMap<String, String>, key: &str, fallback: PathBuf) -> PathBuf {
    env.get(key).cloned().or_else(|| std::env::var(key).ok()).filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or(fallback)
}

fn layout(kind: ProviderKind, env: &BTreeMap<String, String>, home: &Path) -> (PathBuf, Vec<Asset>) {
    let configured = |key: &str, fallback: PathBuf| configured(env, key, fallback);
    let skills = vec![("skills", "skills", Dir)];
    match kind {
        ProviderKind::ClaudeCode => (
            configured("CLAUDE_CONFIG_DIR", home.join(".claude")),
            vec![
                ("skills", "skills", Dir),
                ("commands", "commands", Dir),
                ("plugins/cache", "plugins/cache", Dir),
                ("plugins/marketplaces", "plugins/marketplaces", Dir),
                ("plugins/installed_plugins.json", "plugins/installed_plugins.json", Registry),
                ("plugins/known_marketplaces.json", "plugins/known_marketplaces.json", Registry),
                // Conversations, so `--resume` finds a thread's session on every account.
                ("projects", "projects", Dir),
            ],
        ),
        ProviderKind::Codex => (
            configured("CODEX_HOME", home.join(".codex")),
            vec![
                ("skills", "skills", Dir),
                ("plugins/cache", "plugins/cache", Dir),
                // Conversation history; the databases are shared through CODEX_SQLITE_HOME.
                ("sessions", "sessions", Dir),
                ("archived_sessions", "archived_sessions", Dir),
                ("shell_snapshots", "shell_snapshots", Dir),
                // One writer per conversation across accounts.
                ("thread-writer-locks", "thread-writer-locks", Dir),
                ("session_index.jsonl", "session_index.jsonl", Lines),
            ],
        ),
        // Cursor already discovers skills from regular HOME; these links also
        // cover content put inside an imported isolated account directory.
        ProviderKind::Cursor => (home.join(".cursor"), skills),
        // A named account's profile is `<account>/.gemini`: it shares the person's skills and
        // global rules with `~/.gemini`, never the login, conversations or MCP servers.
        ProviderKind::Antigravity => (
            home.join(".gemini"),
            vec![
                (".gemini/config/skills", "config/skills", Dir),
                (".gemini/antigravity-cli/skills", "antigravity-cli/skills", Dir),
                (".gemini/config/skills.json", "config/skills.json", Registry),
                (".gemini/GEMINI.md", "GEMINI.md", Registry),
                (".gemini/AGENTS.md", "AGENTS.md", Registry),
            ],
        ),
        ProviderKind::GrokBuild => {
            let configured = env.get("GROK_HOME").cloned().or_else(|| std::env::var("GROK_HOME").ok());
            (kybern_drivers::binary::grok_home(Some(home), configured.as_deref()).unwrap_or_else(|| home.join(".grok")), vec![])
        }
        ProviderKind::Pi => {
            (configured("PI_CODING_AGENT_DIR", home.join(".pi/agent")), vec![("skills", "skills", Dir), ("extensions", "extensions", Dir)])
        }
        ProviderKind::Omp => {
            let profile = kybern_drivers::omp_profile::resolve(env).ok().filter(|value| !value.is_empty());
            let root = profile
                .map(|profile| home.join(".omp/profiles").join(profile).join("agent"))
                .unwrap_or_else(|| configured("PI_CODING_AGENT_DIR", home.join(".omp/agent")));
            (root, vec![("skills", "skills", Dir), ("extensions", "extensions", Dir)])
        }
        ProviderKind::Opencode => (
            configured("XDG_CONFIG_HOME", home.join(".config")).join("opencode"),
            vec![("config/opencode/skills", "skills", Dir), ("config/opencode/plugins", "plugins", Dir)],
        ),
    }
}

fn home_of(provider: &ProviderSettings) -> Option<PathBuf> {
    provider.env.get("HOME").map(PathBuf::from).or_else(|| directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()))
}

/// The folder an account of `kind` keeps its conversations in, resolved through links. Two
/// accounts whose folders resolve to the same place resume each other's native sessions.
/// `None` for harnesses whose conversations are not shared, and when the folder is missing.
pub fn conversation_store(provider: &ProviderSettings, kind: ProviderKind, instance: &str) -> Option<PathBuf> {
    let child = match kind {
        ProviderKind::ClaudeCode => "projects",
        ProviderKind::Codex => "sessions",
        _ => return None,
    };
    let root = if instance == "default" {
        layout(kind, &provider.env, &home_of(provider)?).0
    } else {
        PathBuf::from(&provider.accounts.get(instance)?.directory)
    };
    root.join(child).canonicalize().ok()
}

/// Where named Codex accounts open Codex's databases (threads, logs, memories): the terminal
/// login's, so every account sees the same conversations. Codex reads `CODEX_SQLITE_HOME`,
/// then `sqlite_home` in its config, then `CODEX_HOME`.
pub fn codex_shared_sqlite_home(provider: &ProviderSettings) -> Option<PathBuf> {
    if let Some(home) =
        provider.env.get("CODEX_SQLITE_HOME").cloned().or_else(|| std::env::var("CODEX_SQLITE_HOME").ok()).filter(|v| !v.is_empty())
    {
        return Some(PathBuf::from(home));
    }
    let shared = layout(ProviderKind::Codex, &provider.env, &home_of(provider)?).0;
    let configured = std::fs::read_to_string(shared.join("config.toml"))
        .ok()
        .and_then(|text| text.parse::<toml_edit::DocumentMut>().ok())
        .and_then(|document| document.get("sqlite_home").and_then(|item| item.as_str()).map(PathBuf::from))
        .filter(|path| path.is_absolute());
    Some(configured.unwrap_or(shared))
}

/// A named Codex account keeps its login in its own `auth.json`: with conversations shared, a
/// keyring login would be the only thing telling two accounts apart. Set only when the account's
/// `config.toml` does not choose a store itself.
fn keep_codex_login_in_file(account_root: &Path) -> Result<()> {
    let path = account_root.join("config.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let mut document = text.parse::<toml_edit::DocumentMut>()?;
    if document.contains_key("cli_auth_credentials_store") {
        return Ok(());
    }
    document["cli_auth_credentials_store"] = toml_edit::value("file");
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::now_v7()));
    std::fs::write(&temporary, document.to_string())?;
    std::fs::rename(temporary, &path)?;
    Ok(())
}

fn present(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}
fn link_asset(local: &Path, shared: &Path, kind: AssetKind) -> Result<()> {
    let directory = kind == Dir;
    if let (Ok(local), Ok(shared)) = (local.canonicalize(), shared.canonicalize())
        && local == shared
    {
        return Ok(());
    }
    if !directory && !present(local) && !present(shared) {
        return Ok(());
    }
    ensure!(shared.is_absolute(), "Shared provider directory must be absolute. Fix the provider environment in Settings.");
    if directory {
        std::fs::create_dir_all(shared)?;
    }
    let parent = local.parent().unwrap();
    std::fs::create_dir_all(parent)?;
    // Create the replacement first: unsupported symlinks/permissions must fail
    // before moving any account-local content.
    let replacement = parent.join(format!(".kybern-shared-{}", uuid::Uuid::now_v7()));
    if let Err(error) = create_link(shared, &replacement, directory) {
        if !directory && cfg!(windows) {
            // Windows file symlinks need Developer Mode or elevation. A hard link
            // would split at the CLI's next atomic rewrite and re-merge (with a
            // backup) on every spawn, so the file stays account-local instead,
            // seeded once from the shared copy. Plugin folders are still shared.
            tracing::debug!(local = %local.display(), %error, "File link unavailable; keeping the file account-local");
            if !present(local) && shared.is_file() {
                std::fs::copy(shared, local)?;
            }
            return Ok(());
        }
        return Err(
            anyhow::Error::from(error).context(format!("Unable to share {}. Check folder permissions, then try again.", local.display()))
        );
    }
    let result = migrate_asset(local, shared, kind, &replacement);
    if present(&replacement) {
        if cfg!(windows) && directory {
            let _ = std::fs::remove_dir(&replacement);
        } else {
            let _ = std::fs::remove_file(&replacement);
        }
    }
    result
}

fn create_link(target: &Path, link: &Path, directory: bool) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let _ = directory;
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        #[cfg(test)]
        if !directory && tests::FAIL_FILE_LINKS.with(|fail| fail.get()) {
            // ERROR_PRIVILEGE_NOT_HELD, what a stock (non-Developer Mode) user gets.
            return Err(std::io::Error::from_raw_os_error(1314));
        }
        if !directory {
            return std::os::windows::fs::symlink_file(target, link);
        }
        // Junctions need no privilege, unlike directory symlinks (Developer Mode
        // or elevation). std reports them as symlinks (name-surrogate reparse
        // points), so the is_symlink checks, canonicalize and remove_dir below
        // treat both alike. Junctions only reach local volumes: fall back to a
        // symlink for anything else.
        let Err(error) = junction::create(target, link) else {
            return Ok(());
        };
        let _ = std::fs::remove_dir(link);
        std::os::windows::fs::symlink_dir(target, link).map_err(|_| error)
    }
}

fn migrate_asset(local: &Path, shared: &Path, kind: AssetKind, replacement: &Path) -> Result<()> {
    let parent = local.parent().unwrap();
    // Preserve conflicting originals before linking. Move unique entries rather
    // than duplicating potentially large plugin caches. Imported symlink targets
    // remain untouched and are copied only when absent from the shared tree.
    if present(local) {
        let backup = parent.join(format!("{}.kybern-local-{}", local.file_name().unwrap().to_string_lossy(), uuid::Uuid::now_v7()));
        std::fs::rename(local, &backup)?;
        let migration = match kind {
            Dir => merge_directory(&backup, shared, local),
            Registry => merge_registry(&backup, shared, local),
            Lines => merge_lines(&backup, shared),
        };
        if let Err(error) = migration {
            std::fs::rename(&backup, local)?;
            return Err(error);
        }
        tracing::warn!(local = %local.display(), backup = %backup.display(), "Account-local assets preserved before sharing; shared content wins conflicts");
    }
    std::fs::rename(replacement, local)?;
    Ok(())
}

fn merge_directory(source: &Path, target: &Path, original: &Path) -> Result<()> {
    ensure!(source.is_dir(), "Expected an asset directory. Original content is preserved.");
    // Canonical roots prevent imported symlinks from copying a tree into itself.
    let source_root = source.canonicalize()?;
    let target_root = target.canonicalize()?;
    ensure!(
        !source_root.starts_with(&target_root) && !target_root.starts_with(&source_root),
        "Asset folders overlap. Choose separate account directories."
    );
    let move_entries = !std::fs::symlink_metadata(source)?.file_type().is_symlink();
    copy_missing(&source_root, &target_root, move_entries, &source_root, &target_root, original)
}
fn copy_missing(source: &Path, target: &Path, move_entries: bool, source_root: &Path, target_root: &Path, original: &Path) -> Result<()> {
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            if present(&to) && (!to.is_dir() || std::fs::symlink_metadata(&to)?.file_type().is_symlink()) {
                continue;
            }
            std::fs::create_dir_all(&to)?;
            copy_missing(&from, &to, move_entries, source_root, target_root, original)?;
        } else if !present(&to) {
            if kind.is_symlink() {
                // Preserve the resolved target when a relative symlink moves roots.
                let link = std::fs::read_link(&from)?;
                let link = normalize_path(if link.is_absolute() { link } else { from.parent().unwrap().join(link) });
                let link = if move_entries {
                    link.strip_prefix(source_root)
                        .or_else(|_| link.strip_prefix(original))
                        .map(|suffix| target_root.join(suffix))
                        .unwrap_or(link)
                } else {
                    link
                };
                create_link(&link, &to, from.is_dir())?;
            } else if kind.is_file() {
                if move_entries {
                    std::fs::rename(from, to)?;
                } else {
                    std::fs::copy(from, to)?;
                }
            }
        }
    }
    Ok(())
}
fn normalize_path(path: PathBuf) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}
/// Append the lines of `source` that `target` lacks, keeping `target`'s order.
fn merge_lines(source: &Path, target: &Path) -> Result<()> {
    let local = std::fs::read_to_string(source)?;
    let shared = match std::fs::read_to_string(target) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let known = shared.lines().collect::<std::collections::HashSet<_>>();
    let missing = local.lines().filter(|line| !line.trim().is_empty() && !known.contains(line)).collect::<Vec<_>>();
    if missing.is_empty() && present(target) {
        return Ok(());
    }
    let mut text = shared.clone();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    for line in missing {
        text.push_str(line);
        text.push('\n');
    }
    let temporary = target.with_extension(format!("{}.tmp", uuid::Uuid::now_v7()));
    std::fs::write(&temporary, text)?;
    std::fs::rename(temporary, target)?;
    Ok(())
}
fn merge_registry(source: &Path, target: &Path, original: &Path) -> Result<()> {
    // Installation registries contain objects and arrays. Preserve current values,
    // add missing plugin identities/versions, leave conflicting originals in backup.
    let mut local: serde_json::Value = serde_json::from_slice(&std::fs::read(source)?)?;
    relocate_install_paths(&mut local, original.parent().unwrap(), target.parent().unwrap());
    let mut shared = read_json(target)?;
    merge_missing(&mut shared, local);
    write_json(target, &shared)
}
fn relocate_install_paths(value: &mut serde_json::Value, local: &Path, shared: &Path) {
    match value {
        serde_json::Value::Object(entries) => {
            for (key, value) in entries {
                if matches!(key.as_str(), "installPath" | "installLocation")
                    && let Some(path) = value.as_str()
                    && let Ok(suffix) = Path::new(path).strip_prefix(local)
                {
                    *value = serde_json::Value::String(shared.join(suffix).to_string_lossy().into_owned());
                } else {
                    relocate_install_paths(value, local, shared);
                }
            }
        }
        serde_json::Value::Array(entries) => {
            for value in entries {
                relocate_install_paths(value, local, shared);
            }
        }
        _ => {}
    }
}
fn merge_missing(target: &mut serde_json::Value, source: serde_json::Value) {
    match (target, source) {
        (serde_json::Value::Object(target), serde_json::Value::Object(source)) => {
            for (key, value) in source {
                if let Some(current) = target.get_mut(&key) {
                    merge_missing(current, value);
                } else {
                    target.insert(key, value);
                }
            }
        }
        (serde_json::Value::Array(target), serde_json::Value::Array(source)) => {
            for value in source {
                if !target.contains(&value) {
                    target.push(value);
                }
            }
        }
        _ => {}
    }
}
fn read_json(path: &Path) -> Result<serde_json::Value> {
    match std::fs::read(path) {
        Ok(text) => Ok(serde_json::from_slice(&text)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(error) => Err(error.into()),
    }
}
fn write_json(path: &Path, value: &serde_json::Value) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::now_v7()));
    std::fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}
fn merge_plugin_switches(shared_path: &Path, local_path: &Path) -> Result<()> {
    let shared = read_json(shared_path)?;
    let Some(plugins) = shared.get("enabledPlugins").and_then(serde_json::Value::as_object) else {
        return Ok(());
    };
    let mut local = read_json(local_path)?;
    ensure!(local.is_object(), "Account settings must be a JSON object. Fix the settings file, then retry.");
    let before = local.clone();
    let enabled = local.as_object_mut().unwrap().entry("enabledPlugins").or_insert_with(|| serde_json::json!({}));
    ensure!(enabled.is_object(), "enabledPlugins must be a JSON object. Fix the settings file, then retry.");
    let enabled = enabled.as_object_mut().unwrap();
    for (id, value) in plugins {
        if value.is_boolean() {
            enabled.entry(id.clone()).or_insert_with(|| value.clone());
        }
    }
    if local != before {
        std::fs::create_dir_all(local_path.parent().unwrap())?;
        write_json(local_path, &local)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kybern_protocol::ProviderAccount;
    #[cfg(windows)]
    thread_local! {
        /// Simulates a Windows user without the symlink privilege (no Developer Mode).
        pub(super) static FAIL_FILE_LINKS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("kybern-assets-test-{}", uuid::Uuid::now_v7()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn put(&self, path: &str, text: &str) {
            let path = self.0.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        fn provider(&self) -> ProviderSettings {
            let mut provider = ProviderSettings::default();
            for (key, value) in [
                ("HOME", "home"),
                ("CLAUDE_CONFIG_DIR", "home/.claude"),
                ("CODEX_HOME", "home/.codex"),
                ("XDG_CONFIG_HOME", "home/.config"),
            ] {
                provider.env.insert(key.into(), self.0.join(value).to_string_lossy().into_owned());
            }
            provider.env.insert("OMP_PROFILE".into(), "".into());
            provider.env.insert("PI_CODING_AGENT_DIR".into(), self.0.join("home/agent").to_string_lossy().into_owned());
            for id in ["one", "two"] {
                let path = self.0.join(id);
                std::fs::create_dir_all(&path).unwrap();
                provider.accounts.insert(
                    id.into(),
                    ProviderAccount { name: id.into(), directory: path.to_string_lossy().into_owned(), ..Default::default() },
                );
            }
            provider
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn grok_storage_follows_grok_home() {
        let home = Path::new("/home/me");
        let env = BTreeMap::from([("GROK_HOME".to_string(), "~/xai".to_string())]);
        assert_eq!(layout(ProviderKind::GrokBuild, &env, home).0, home.join("xai"));
        let env = BTreeMap::from([("GROK_HOME".to_string(), "/opt/grok".to_string())]);
        assert_eq!(layout(ProviderKind::GrokBuild, &env, home).0, PathBuf::from("/opt/grok"));
    }

    #[test]
    fn every_provider_links_assets_for_existing_and_new_accounts() {
        // Antigravity and Grok Build have one account per machine, and Kybern links nothing into their storage.
        for kind in ProviderKind::ALL.into_iter().filter(|kind| !matches!(kind, ProviderKind::Antigravity | ProviderKind::GrokBuild)) {
            let scratch = Scratch::new();
            let provider = scratch.provider();
            prepare(&provider, kind).unwrap();
            let (shared, assets) = layout(kind, &provider.env, &scratch.0.join("home"));
            for (local, global, asset) in assets {
                if asset != Dir {
                    continue;
                }
                assert_eq!(
                    scratch.0.join("one").join(local).canonicalize().unwrap(),
                    shared.join(global).canonicalize().unwrap(),
                    "{kind}: {local}"
                );
                std::fs::write(shared.join(global).join("updated"), "shared update").unwrap();
                assert_eq!(std::fs::read_to_string(scratch.0.join("two").join(local).join("updated")).unwrap(), "shared update");
            }
            // Idempotent across catalog refreshes and daemon restart.
            prepare(&provider, kind).unwrap();
            let mut newer = provider.clone();
            std::fs::create_dir_all(scratch.0.join("three")).unwrap();
            newer.accounts.insert(
                "three".into(),
                ProviderAccount {
                    name: "Three".into(),
                    directory: scratch.0.join("three").to_string_lossy().into_owned(),
                    ..Default::default()
                },
            );
            prepare(&newer, kind).unwrap();
            let local = if kind == ProviderKind::Opencode { "config/opencode/skills" } else { "skills" };
            assert_eq!(std::fs::read_to_string(scratch.0.join("three").join(local).join("updated")).unwrap(), "shared update");
        }
    }
    #[test]
    fn preserves_conflicts_and_never_shares_credentials_sessions_or_plugin_data() {
        let scratch = Scratch::new();
        let provider = scratch.provider();
        scratch.put("home/.claude/skills/review/SKILL.md", "shared");
        scratch.put("one/skills/review/SKILL.md", "local conflict");
        scratch.put("one/skills/new/SKILL.md", "local addition");
        scratch.put("one/.credentials.json", "account one secret");
        scratch.put("two/.credentials.json", "account two secret");
        scratch.put("one/plugins/data/secret", "account one plugin secret");
        scratch.put("two/plugins/data/secret", "account two plugin secret");
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        assert_eq!(std::fs::read_to_string(scratch.0.join("two/skills/new/SKILL.md")).unwrap(), "local addition");
        assert_eq!(std::fs::read_to_string(scratch.0.join("one/skills/review/SKILL.md")).unwrap(), "shared");
        let backup = std::fs::read_dir(scratch.0.join("one"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.file_name().unwrap().to_string_lossy().starts_with("skills.kybern-local-"))
            .unwrap();
        assert_eq!(std::fs::read_to_string(backup.join("review/SKILL.md")).unwrap(), "local conflict");
        assert_eq!(std::fs::read_to_string(scratch.0.join("one/.credentials.json")).unwrap(), "account one secret");
        assert_eq!(std::fs::read_to_string(scratch.0.join("two/.credentials.json")).unwrap(), "account two secret");
        assert_eq!(std::fs::read_to_string(scratch.0.join("two/plugins/data/secret")).unwrap(), "account two plugin secret");
        assert_eq!(std::fs::read_to_string(scratch.0.join("one/plugins/data/secret")).unwrap(), "account one plugin secret");
    }

    fn is_link(path: &Path) -> bool {
        std::fs::symlink_metadata(path).unwrap().file_type().is_symlink()
    }

    #[test]
    fn claude_accounts_share_conversations_and_keep_their_logins() {
        let scratch = Scratch::new();
        let provider = scratch.provider();
        scratch.put("home/.claude/projects/-repo/terminal.jsonl", "terminal session");
        scratch.put("home/.claude/.credentials.json", "terminal secret");
        scratch.put("one/.credentials.json", "account one secret");
        scratch.put("one/.claude.json", "{\"oauthAccount\":\"one\"}");
        scratch.put("one/projects/-repo/one.jsonl", "account one session");
        // The same session file on both sides: the shared copy wins, the account's stays in its backup.
        scratch.put("home/.claude/projects/-repo/both.jsonl", "shared copy");
        scratch.put("one/projects/-repo/both.jsonl", "account copy");
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        for id in ["one", "two"] {
            assert!(is_link(&scratch.0.join(id).join("projects")), "{id}");
            assert_eq!(std::fs::read_to_string(scratch.0.join(id).join("projects/-repo/terminal.jsonl")).unwrap(), "terminal session");
            assert_eq!(std::fs::read_to_string(scratch.0.join(id).join("projects/-repo/one.jsonl")).unwrap(), "account one session");
        }
        assert_eq!(std::fs::read_to_string(scratch.0.join("home/.claude/projects/-repo/one.jsonl")).unwrap(), "account one session");
        assert_eq!(std::fs::read_to_string(scratch.0.join("home/.claude/projects/-repo/both.jsonl")).unwrap(), "shared copy");
        let backup = std::fs::read_dir(scratch.0.join("one"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.file_name().unwrap().to_string_lossy().starts_with("projects.kybern-local-"))
            .unwrap();
        assert_eq!(std::fs::read_to_string(backup.join("-repo/both.jsonl")).unwrap(), "account copy");
        // Logins never move or link.
        assert!(!is_link(&scratch.0.join("one/.credentials.json")));
        assert_eq!(std::fs::read_to_string(scratch.0.join("one/.credentials.json")).unwrap(), "account one secret");
        assert!(!scratch.0.join("two/.credentials.json").exists());
        assert!(!is_link(&scratch.0.join("one/.claude.json")));
        assert!(!is_link(&scratch.0.join("home/.claude/projects")), "the terminal login keeps its own folder");
        // Idempotent: nothing is moved or backed up again.
        let entries = |id: &str| std::fs::read_dir(scratch.0.join(id)).unwrap().count();
        let before = (entries("one"), entries("two"));
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        assert_eq!((entries("one"), entries("two")), before);
        // Every account (and the terminal login) resolves to the same conversation store.
        let stores = ["default", "one", "two"].map(|id| conversation_store(&provider, ProviderKind::ClaudeCode, id).unwrap());
        assert!(stores.iter().all(|store| *store == stores[0]));
        assert_eq!(conversation_store(&provider, ProviderKind::Cursor, "one"), None);
    }

    #[test]
    fn codex_accounts_share_history_and_keep_auth_private() {
        let scratch = Scratch::new();
        let provider = scratch.provider();
        scratch.put("home/.codex/sessions/2026/11/27/rollout-terminal.jsonl", "terminal rollout");
        scratch.put("home/.codex/session_index.jsonl", "{\"id\":\"terminal\"}\n");
        scratch.put("home/.codex/auth.json", "terminal auth");
        scratch.put("one/sessions/2026/11/26/rollout-one.jsonl", "account one rollout");
        scratch.put("one/archived_sessions/rollout-old.jsonl", "archived");
        scratch.put("one/shell_snapshots/snap.sh", "snapshot");
        scratch.put("one/session_index.jsonl", "{\"id\":\"one\"}\n{\"id\":\"terminal\"}\n");
        scratch.put("one/auth.json", "account one auth");
        scratch.put("one/auth.lock", "");
        scratch.put("one/models_cache.json", "{}");
        scratch.put("two/auth.json", "account two auth");
        prepare(&provider, ProviderKind::Codex).unwrap();
        for id in ["one", "two"] {
            let root = scratch.0.join(id);
            for shared in ["sessions", "archived_sessions", "shell_snapshots", "thread-writer-locks", "session_index.jsonl"] {
                assert!(is_link(&root.join(shared)), "{id}: {shared}");
            }
            assert_eq!(std::fs::read_to_string(root.join("sessions/2026/11/27/rollout-terminal.jsonl")).unwrap(), "terminal rollout");
            assert_eq!(std::fs::read_to_string(root.join("sessions/2026/11/26/rollout-one.jsonl")).unwrap(), "account one rollout");
            assert_eq!(std::fs::read_to_string(root.join("archived_sessions/rollout-old.jsonl")).unwrap(), "archived");
            assert!(!is_link(&root.join("auth.json")), "{id}");
        }
        // The index gained the account's line once; the terminal's order stays.
        assert_eq!(
            std::fs::read_to_string(scratch.0.join("home/.codex/session_index.jsonl")).unwrap(),
            "{\"id\":\"terminal\"}\n{\"id\":\"one\"}\n"
        );
        assert_eq!(std::fs::read_to_string(scratch.0.join("one/auth.json")).unwrap(), "account one auth");
        assert_eq!(std::fs::read_to_string(scratch.0.join("two/auth.json")).unwrap(), "account two auth");
        assert_eq!(std::fs::read_to_string(scratch.0.join("home/.codex/auth.json")).unwrap(), "terminal auth");
        assert!(!is_link(&scratch.0.join("one/auth.lock")) && !is_link(&scratch.0.join("one/models_cache.json")));
        assert!(!scratch.0.join("two/models_cache.json").exists());
        // Each account keeps its login in its own auth.json, and an explicit choice stays.
        assert!(std::fs::read_to_string(scratch.0.join("two/config.toml")).unwrap().contains("cli_auth_credentials_store = \"file\""));
        scratch.put("one/config.toml", "model = \"x\"\ncli_auth_credentials_store = \"keyring\"\n");
        prepare(&provider, ProviderKind::Codex).unwrap();
        assert_eq!(
            std::fs::read_to_string(scratch.0.join("one/config.toml")).unwrap(),
            "model = \"x\"\ncli_auth_credentials_store = \"keyring\"\n"
        );
        assert_eq!(
            std::fs::read_to_string(scratch.0.join("home/.codex/session_index.jsonl")).unwrap(),
            "{\"id\":\"terminal\"}\n{\"id\":\"one\"}\n"
        );
        let stores = ["default", "one", "two"].map(|id| conversation_store(&provider, ProviderKind::Codex, id).unwrap());
        assert!(stores.iter().all(|store| *store == stores[0]));
        // Named accounts open the terminal login's databases.
        assert_eq!(codex_shared_sqlite_home(&provider).unwrap(), scratch.0.join("home/.codex"));
        scratch.put("home/.codex/config.toml", &format!("sqlite_home = \"{}\"\n", scratch.0.join("db").display()));
        assert_eq!(codex_shared_sqlite_home(&provider).unwrap(), scratch.0.join("db"));
    }
    #[test]
    fn plugin_registry_union_and_enablement_preserve_account_settings() {
        let scratch = Scratch::new();
        let provider = scratch.provider();
        scratch.put("home/.claude/plugins/installed_plugins.json", r#"{"version":2,"plugins":{"shared@m":[{"installPath":"shared"}]}}"#);
        scratch.put("one/plugins/cache/local/skill", "plugin content");
        scratch.put(
            "one/plugins/installed_plugins.json",
            &serde_json::json!({"version":2,"plugins":{"local@m":[{"installPath": scratch.0.join("one/plugins/cache/local")} ]}})
                .to_string(),
        );
        scratch.put(
            "home/.claude/settings.json",
            r#"{"enabledPlugins":{"shared@m":true},"env":{"SECRET":"do not copy"},"mcpServers":{"private":{}}}"#,
        );
        scratch.put("one/settings.json", r#"{"enabledPlugins":{"local@m":true},"env":{"ACCOUNT":"keep"},"model":"local"}"#);
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        let registry = read_json(&scratch.0.join("two/plugins/installed_plugins.json")).unwrap();
        assert!(registry["plugins"].get("shared@m").is_some());
        assert!(registry["plugins"].get("local@m").is_some());
        assert_eq!(
            Path::new(registry["plugins"]["local@m"][0]["installPath"].as_str().unwrap()),
            scratch.0.join("home/.claude/plugins/cache/local")
        );
        let settings = read_json(&scratch.0.join("one/settings.json")).unwrap();
        assert_eq!(settings["enabledPlugins"]["shared@m"], true);
        assert_eq!(settings["env"]["ACCOUNT"], "keep");
        assert_eq!(settings["model"], "local");
        assert!(settings["env"].get("SECRET").is_none());
        assert!(settings.get("mcpServers").is_none());
        let second = read_json(&scratch.0.join("two/settings.json")).unwrap();
        assert!(second.get("env").is_none());
        assert_eq!(second["enabledPlugins"]["local@m"], true);
        // A CLI atomically replacing a symlinked registry is reconciled next time.
        std::fs::remove_file(scratch.0.join("one/plugins/installed_plugins.json")).unwrap();
        scratch.put("one/plugins/installed_plugins.json", r#"{"plugins":{"new@m":[{"installPath":"new"}]}}"#);
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        assert!(read_json(&scratch.0.join("two/plugins/installed_plugins.json")).unwrap()["plugins"].get("new@m").is_some());
        // Removing the original account cannot invalidate another account's install paths.
        std::fs::remove_dir_all(scratch.0.join("one")).unwrap();
        assert_eq!(std::fs::read_to_string(scratch.0.join("two/plugins/cache/local/skill")).unwrap(), "plugin content");
    }
    #[tokio::test]
    async fn discovery_reads_shared_skills_from_selected_account() {
        let scratch = Scratch::new();
        let provider = scratch.provider();
        scratch.put("one/skills/local/SKILL.md", "---\nname: local\ndescription: Shared from an account\n---\nLocal skill");
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        for id in ["default", "one", "two"] {
            let env = crate::provider_accounts::environment(&provider, ProviderKind::ClaudeCode, id).unwrap();
            let skills = crate::skills::list(&scratch.0, ProviderKind::ClaudeCode, &env).await.unwrap();
            assert_eq!(skills.len(), 1);
            assert_eq!(skills[0].name, "local");
        }
    }

    #[cfg(unix)]
    #[test]
    fn migration_preserves_relative_links_and_imported_symlink_targets() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new();
        let provider = scratch.provider();
        scratch.put("one/skills/base/SKILL.md", "original");
        scratch.put("external/SKILL.md", "external");
        symlink("base", scratch.0.join("one/skills/alias")).unwrap();
        symlink("../../external", scratch.0.join("one/skills/outside")).unwrap();
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        scratch.put("home/.claude/skills/base/SKILL.md", "updated");
        assert_eq!(std::fs::read_to_string(scratch.0.join("two/skills/alias/SKILL.md")).unwrap(), "updated");
        assert_eq!(std::fs::read_to_string(scratch.0.join("two/skills/outside/SKILL.md")).unwrap(), "external");

        let imported = Scratch::new();
        let provider = imported.provider();
        imported.put("external/base/SKILL.md", "imported");
        symlink("base", imported.0.join("external/alias")).unwrap();
        symlink("../external", imported.0.join("one/skills")).unwrap();
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        assert_eq!(std::fs::read_to_string(imported.0.join("external/base/SKILL.md")).unwrap(), "imported");
        assert_eq!(std::fs::read_to_string(imported.0.join("two/skills/alias/SKILL.md")).unwrap(), "imported");
    }

    #[test]
    fn invalid_asset_preserves_original_and_cleans_up_replacement_link() {
        let scratch = Scratch::new();
        let provider = scratch.provider();
        scratch.put("one/skills", "unexpected file");
        // A failed share is logged, never a reason to refuse the account.
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        assert_eq!(scratch.0.join("two/skills").canonicalize().unwrap(), scratch.0.join("home/.claude/skills").canonicalize().unwrap());
        assert_eq!(std::fs::read_to_string(scratch.0.join("one/skills")).unwrap(), "unexpected file");
        assert!(
            !std::fs::read_dir(scratch.0.join("one")).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".kybern-shared-"))
        );
    }

    #[cfg(windows)]
    fn entries_starting_with(dir: &Path, prefix: &str) -> usize {
        std::fs::read_dir(dir).unwrap().filter(|entry| entry.as_ref().unwrap().file_name().to_string_lossy().starts_with(prefix)).count()
    }

    #[cfg(windows)]
    #[test]
    fn windows_directories_share_through_junctions() {
        let scratch = Scratch::new();
        let provider = scratch.provider();
        scratch.put("one/skills/local/SKILL.md", "account one");
        prepare(&provider, ProviderKind::Codex).unwrap();
        for id in ["one", "two"] {
            let skills = scratch.0.join(id).join("skills");
            // A junction, not a directory symlink: no Developer Mode or elevation needed.
            assert!(junction::exists(&skills).unwrap(), "{id}");
            assert!(std::fs::symlink_metadata(&skills).unwrap().file_type().is_symlink(), "std treats junctions as links");
            assert_eq!(skills.canonicalize().unwrap(), scratch.0.join("home/.codex/skills").canonicalize().unwrap());
            assert!(junction::exists(scratch.0.join(id).join("plugins/cache")).unwrap());
        }
        assert_eq!(std::fs::read_to_string(scratch.0.join("two/skills/local/SKILL.md")).unwrap(), "account one");
        // Idempotent: an existing junction is recognised, nothing is migrated again.
        let backups = entries_starting_with(&scratch.0.join("one"), "skills.kybern-local-");
        prepare(&provider, ProviderKind::Codex).unwrap();
        assert_eq!(entries_starting_with(&scratch.0.join("one"), "skills.kybern-local-"), backups);
        assert_eq!(entries_starting_with(&scratch.0.join("one"), ".kybern-shared-"), 0);
        // Removing an account's junction leaves the shared skills intact.
        std::fs::remove_dir(scratch.0.join("two/skills")).unwrap();
        assert_eq!(std::fs::read_to_string(scratch.0.join("home/.codex/skills/local/SKILL.md")).unwrap(), "account one");
    }

    #[cfg(windows)]
    #[test]
    fn windows_file_links_fall_back_to_account_local_copies() {
        FAIL_FILE_LINKS.with(|fail| fail.set(true));
        let scratch = Scratch::new();
        let provider = scratch.provider();
        scratch.put("home/.claude/plugins/installed_plugins.json", r#"{"plugins":{"shared@m":[]}}"#);
        scratch.put("one/plugins/installed_plugins.json", r#"{"plugins":{"local@m":[]}}"#);
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        prepare(&provider, ProviderKind::ClaudeCode).unwrap();
        FAIL_FILE_LINKS.with(|fail| fail.set(false));
        // Folders are still shared; registry files stay per account, seeded once from the shared copy.
        assert!(junction::exists(scratch.0.join("one/plugins/cache")).unwrap());
        let registry = |id: &str| scratch.0.join(id).join("plugins/installed_plugins.json");
        assert!(!std::fs::symlink_metadata(registry("two")).unwrap().file_type().is_symlink());
        assert!(read_json(&registry("two")).unwrap()["plugins"].get("shared@m").is_some());
        assert!(read_json(&registry("one")).unwrap()["plugins"].get("local@m").is_some());
        assert!(read_json(&registry("one")).unwrap()["plugins"].get("shared@m").is_none());
        assert!(!scratch.0.join("one/plugins/known_marketplaces.json").exists());
        assert_eq!(entries_starting_with(&scratch.0.join("one/plugins"), "installed_plugins.json.kybern-local-"), 0);
        assert_eq!(entries_starting_with(&scratch.0.join("one/plugins"), ".kybern-shared-"), 0);
    }
}
