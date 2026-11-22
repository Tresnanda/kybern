//! Workspace-aware skill discovery for providers that do not expose a native
//! catalog API. Codex is queried through app-server first; this scanner is the
//! fallback and the source for Claude, Cursor, pi, and omp. OpenCode is also
//! queried through its CLI first so its configured roots and precedence win.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Result;
use directories::BaseDirs;
use kybern_protocol::{ProviderKind, SkillHome, SkillInfo, SkillScope};

const MAX_DEPTH: usize = 10;
const MAX_INHERIT_DEPTH: usize = 10;
const MAX_ENTRIES: usize = 10_000;
const MAX_SKILL_BYTES: u64 = 1_000_000;
const MAX_TOTAL_BYTES: u64 = 8_000_000;

#[derive(Clone)]
struct Root {
    path: PathBuf,
    scope: SkillScope,
    depth: usize,
}

#[derive(Default)]
struct Budget {
    entries: usize,
    bytes: u64,
}

#[derive(Default)]
pub(crate) struct Frontmatter {
    pub(crate) display_name: Option<String>,
    pub(crate) description: Option<String>,
    user_invocable: bool,
}

/// Discover invocable skills in the same provider-specific roots used by the
/// corresponding CLIs. Unreadable or malformed entries are skipped so opening
/// a composer never fails because one local skill is broken.
pub async fn list(cwd: &Path, provider: ProviderKind, env: &BTreeMap<String, String>) -> Result<Vec<SkillInfo>> {
    let cwd = cwd.to_path_buf();
    let env = env.clone();
    Ok(tokio::task::spawn_blocking(move || scan(&cwd, provider, &env)).await?)
}

pub async fn plugin_skills(roots: Vec<(String, PathBuf)>) -> Result<Vec<SkillInfo>> {
    Ok(tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        let mut visited = HashSet::new();
        let mut budget = Budget::default();
        for (namespace, path) in roots {
            let root = Root { path: path.join("skills"), scope: SkillScope::App, depth: MAX_DEPTH };
            let start = found.len();
            visit(&root.path, &root, 0, &mut visited, &mut budget, &mut found);
            for skill in &mut found[start..] {
                skill.name = format!("{namespace}:{}", skill.name);
                skill.plugin = Some(namespace.clone());
            }
            if budget.entries >= MAX_ENTRIES || budget.bytes >= MAX_TOTAL_BYTES {
                break;
            }
        }
        // Claude lists a plugin once per scope and version it is installed in; each root carries the same
        // `namespace:name`, and the first one is what Claude lists first.
        let mut seen = HashSet::new();
        found.retain(|skill| seen.insert(skill.name.to_ascii_lowercase()));
        found
    })
    .await?)
}

/// The skills in the given skill homes, each tagged with its home: what `skills.list` adds for `include_other_agents`
/// (the caller leaves out the homes the selected agent reads itself). A name found in an earlier home hides a later one.
pub async fn list_homes(homes: Vec<(SkillHome, PathBuf)>) -> Result<Vec<SkillInfo>> {
    Ok(tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        let mut visited = HashSet::new();
        let mut budget = Budget::default();
        for (home, path) in homes {
            let root = Root { path, scope: SkillScope::User, depth: MAX_DEPTH };
            let start = found.len();
            visit(&root.path, &root, 0, &mut visited, &mut budget, &mut found);
            for skill in &mut found[start..] {
                skill.home = Some(home);
            }
            if budget.entries >= MAX_ENTRIES || budget.bytes >= MAX_TOTAL_BYTES {
                break;
            }
        }
        let mut seen = HashSet::new();
        found.retain(|skill| seen.insert(skill.name.to_ascii_lowercase()));
        found.sort_by_key(|skill| skill.name.to_ascii_lowercase());
        found
    })
    .await?)
}

fn scan(cwd: &Path, provider: ProviderKind, env: &BTreeMap<String, String>) -> Vec<SkillInfo> {
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()));
    if provider == ProviderKind::Antigravity {
        return scan_antigravity(cwd, home.as_deref());
    }
    let roots = roots(cwd, provider, env, home.as_deref());
    let mut found = Vec::new();
    let mut seen_names = HashSet::new();
    let mut visited = HashSet::new();
    let mut budget = Budget::default();

    for root in roots {
        visit(&root.path, &root, 0, &mut visited, &mut budget, &mut found);
        if budget.entries >= MAX_ENTRIES || budget.bytes >= MAX_TOTAL_BYTES {
            break;
        }
    }

    found.retain(|skill| seen_names.insert(skill.name.to_ascii_lowercase()));
    found.sort_by_key(|skill| skill.name.to_ascii_lowercase());
    found
}

fn roots(cwd: &Path, provider: ProviderKind, env: &BTreeMap<String, String>, home: Option<&Path>) -> Vec<Root> {
    let mut roots = Vec::new();
    let mut add = |path: PathBuf, scope, depth| roots.push(Root { path, scope, depth });

    match provider {
        ProviderKind::ClaudeCode => {
            if let Some(config) = claude_config_dir(cwd, env, home) {
                add(config.join("skills"), SkillScope::User, 1);
            }
            add(cwd.join(".claude/skills"), SkillScope::Project, 1);
        }
        ProviderKind::Cursor => {
            for relative in [".cursor/skills", ".agents/skills", ".codex/skills", ".claude/skills"] {
                add(cwd.join(relative), SkillScope::Project, MAX_DEPTH);
            }
            if let Some(home) = home {
                for relative in [".cursor/skills", ".agents/skills", ".codex/skills", ".claude/skills"] {
                    add(home.join(relative), SkillScope::User, MAX_DEPTH);
                }
            }
        }
        ProviderKind::Codex => {
            for relative in [".codex/skills", ".agents/skills"] {
                add(cwd.join(relative), SkillScope::Project, MAX_DEPTH);
            }
            if let Some(home) = home {
                let codex =
                    env.get("CODEX_HOME").filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".codex"));
                add(codex.join("skills"), SkillScope::User, MAX_DEPTH);
                add(home.join(".agents/skills"), SkillScope::User, MAX_DEPTH);
            }
        }
        ProviderKind::Antigravity => {
            // Exact native root order for `agy`: `~/.agents/skills` is never read
            // (`.agents/skills` is project-only).
            if let Some(home) = home {
                add(home.join(".gemini/config/skills"), SkillScope::User, 1);
            }
            add(cwd.join(".gemini/skills"), SkillScope::Project, 1);
            if let Some(home) = home {
                add(home.join(".gemini/antigravity-cli/skills"), SkillScope::User, 1);
            }
            add(cwd.join(".agents/skills"), SkillScope::Project, 1);
            add(cwd.join(".agent/skills"), SkillScope::Project, 1);
        }
        ProviderKind::GrokBuild => {
            for relative in [".grok/skills", ".agents/skills"] {
                add(cwd.join(relative), SkillScope::Project, MAX_DEPTH);
            }
            if let Some(home) = home {
                let grok = kybern_drivers::binary::grok_home(Some(home), env.get("GROK_HOME").map(String::as_str))
                    .unwrap_or_else(|| home.join(".grok"));
                add(grok.join("skills"), SkillScope::User, MAX_DEPTH);
                add(home.join(".agents/skills"), SkillScope::User, MAX_DEPTH);
            }
        }
        ProviderKind::Opencode => {
            for relative in [".opencode/skills", ".claude/skills", ".agents/skills"] {
                add(cwd.join(relative), SkillScope::Project, MAX_DEPTH);
            }
            if let Some(home) = home {
                let config =
                    env.get("XDG_CONFIG_HOME").filter(|value| !value.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
                add(config.join("opencode/skills"), SkillScope::User, MAX_DEPTH);
                add(home.join(".claude/skills"), SkillScope::User, MAX_DEPTH);
                add(home.join(".agents/skills"), SkillScope::User, MAX_DEPTH);
            }
        }
        ProviderKind::Pi => {
            add(cwd.join(".pi/skills"), SkillScope::Project, MAX_DEPTH);
            let agent_dir = pi_agent_dir(cwd, env, home, ".pi/agent");
            if let Some(agent_dir) = &agent_dir {
                add(agent_dir.join("skills"), SkillScope::User, MAX_DEPTH);
                for path in configured_skill_paths(&agent_dir.join("settings.json"), home) {
                    add(path, SkillScope::User, MAX_DEPTH);
                }
            }
            for path in configured_skill_paths(&cwd.join(".pi/settings.json"), home) {
                add(path, SkillScope::Project, MAX_DEPTH);
            }
        }
        ProviderKind::Omp => {
            for relative in [".agents/skills", ".pi/skills", ".omp/skills"] {
                add(cwd.join(relative), SkillScope::Project, MAX_DEPTH);
            }
            if let Some(home) = home {
                add(home.join(".agents/skills"), SkillScope::User, MAX_DEPTH);
                add(home.join(".pi/agent/skills"), SkillScope::User, MAX_DEPTH);
            }
            let profile = kybern_drivers::omp_profile::resolve(env).ok();
            let agent_dir = match profile.as_deref() {
                Some(profile) if !profile.is_empty() => home.map(|home| home.join(".omp/profiles").join(profile).join("agent")),
                Some(_) => pi_agent_dir(cwd, env, home, ".omp/agent"),
                None => None,
            };
            if let Some(agent_dir) = agent_dir {
                add(agent_dir.join("skills"), SkillScope::User, MAX_DEPTH);
            }
        }
    }
    roots
}

/// A harness's user skill folder (`SkillHome`), resolved the way [`roots`] resolves the user roots of the
/// harness that owns it. `home` is the user's home folder; the variables come from `env`. Used by the skill
/// copies between machines (`network/skill_sync.rs`), which only touch these folders.
pub(crate) fn user_skill_home(home_kind: SkillHome, env: &BTreeMap<String, String>, home: &Path) -> Option<PathBuf> {
    let var = |name: &str| env.get(name).map(|value| value.trim()).filter(|value| !value.is_empty());
    // Relative overrides are taken from the home folder: the daemon has no project here.
    let path = match home_kind {
        SkillHome::Agents => home.join(".agents/skills"),
        SkillHome::Claude => claude_config_dir(home, env, Some(home))?.join("skills"),
        SkillHome::Codex => {
            var("CODEX_HOME").map(|value| expand_home(Path::new(value), Some(home))).unwrap_or_else(|| home.join(".codex")).join("skills")
        }
        SkillHome::Cursor => home.join(".cursor/skills"),
        SkillHome::Opencode => var("XDG_CONFIG_HOME")
            .map(|value| expand_home(Path::new(value), Some(home)))
            .unwrap_or_else(|| home.join(".config"))
            .join("opencode/skills"),
        SkillHome::Pi => pi_agent_dir(home, env, Some(home), ".pi/agent")?.join("skills"),
        SkillHome::Omp => match kybern_drivers::omp_profile::resolve(env).ok().as_deref() {
            Some(profile) if !profile.is_empty() => home.join(".omp/profiles").join(profile).join("agent/skills"),
            _ => home.join(".omp/agent/skills"),
        },
    };
    Some(if path.is_absolute() { path } else { home.join(path) })
}

fn pi_agent_dir(cwd: &Path, env: &BTreeMap<String, String>, home: Option<&Path>, fallback: &str) -> Option<PathBuf> {
    if let Some(value) = env.get("PI_CODING_AGENT_DIR").map(|value| value.trim()).filter(|value| !value.is_empty()) {
        let path = expand_home(Path::new(value), home);
        return Some(if path.is_absolute() { path } else { cwd.join(path) });
    }
    home.map(|home| home.join(fallback))
}

fn configured_skill_paths(settings_path: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let Ok(contents) = std::fs::read_to_string(settings_path) else { return Vec::new() };
    let Ok(settings) = serde_json::from_str::<serde_json::Value>(&contents) else { return Vec::new() };
    let Some(paths) = settings.get("skills").and_then(serde_json::Value::as_array) else { return Vec::new() };
    let base = settings_path.parent().unwrap_or_else(|| Path::new("."));
    paths
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(|path| {
            let expanded = expand_home(Path::new(path), home);
            if expanded.is_absolute() { expanded } else { base.join(expanded) }
        })
        .collect()
}

fn expand_home(path: &Path, home: Option<&Path>) -> PathBuf {
    let text = path.to_string_lossy();
    if text == "~" {
        return home.map(Path::to_path_buf).unwrap_or_else(|| path.to_path_buf());
    }
    if let Some(rest) = text.strip_prefix("~/")
        && let Some(home) = home
    {
        return home.join(rest);
    }
    path.to_path_buf()
}

fn claude_config_dir(cwd: &Path, env: &BTreeMap<String, String>, home: Option<&Path>) -> Option<PathBuf> {
    if let Some(value) = env.get("CLAUDE_CONFIG_DIR").map(|value| value.trim()).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(value);
        return Some(if path.is_absolute() { path } else { cwd.join(path) });
    }
    home.map(|home| home.join(".claude"))
}

fn visit(directory: &Path, root: &Root, depth: usize, visited: &mut HashSet<PathBuf>, budget: &mut Budget, found: &mut Vec<SkillInfo>) {
    if depth > root.depth || budget.entries >= MAX_ENTRIES || budget.bytes >= MAX_TOTAL_BYTES {
        return;
    }
    let canonical = match std::fs::canonicalize(directory) {
        Ok(path) => path,
        Err(_) => return,
    };
    if !visited.insert(canonical.clone()) {
        return;
    }

    let skill_path = canonical.join("SKILL.md");
    if let Ok(metadata) = std::fs::metadata(&skill_path)
        && metadata.is_file()
        && metadata.len() <= MAX_SKILL_BYTES
        && budget.bytes.saturating_add(metadata.len()) <= MAX_TOTAL_BYTES
        && let Ok(contents) = std::fs::read_to_string(&skill_path)
    {
        budget.bytes += metadata.len();
        let frontmatter = parse_frontmatter(&contents);
        if frontmatter.user_invocable
            && let Some(name) = canonical.file_name().and_then(|name| name.to_str()).map(str::trim).filter(|name| !name.is_empty())
        {
            found.push(SkillInfo {
                name: name.to_string(),
                display_name: frontmatter.display_name.filter(|value| value != name),
                description: frontmatter.description,
                path: skill_path.to_string_lossy().to_string(),
                scope: effective_scope(&skill_path, root.scope),
                enabled: true,
                home: None,
                plugin: plugin_in_path(&skill_path),
            });
        }
    }

    let Ok(entries) = std::fs::read_dir(&canonical) else { return };
    let mut children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
    children.sort();
    for child in children {
        budget.entries += 1;
        if budget.entries >= MAX_ENTRIES {
            return;
        }
        visit(&child, root, depth + 1, visited, budget, found);
    }
}

/// The plugin a skill file sits in when it lives in a Codex or `.agents` plugin cache
/// (`…/plugins/cache/<marketplace>/<plugin>/<version>/skills/…`); `None` for everything else.
fn plugin_in_path(path: &Path) -> Option<String> {
    let normalized = path.to_string_lossy().replace('\\', "/");
    let rest = ["/.codex/plugins/", "/.agents/plugins/"].iter().find_map(|marker| normalized.split_once(marker).map(|(_, rest)| rest))?;
    let mut parts = rest.split('/').filter(|part| !part.is_empty());
    let first = parts.next()?;
    let name = if first == "cache" { parts.nth(1)? } else { first };
    Some(name.to_string())
}

/// What `skills.list` shows when a skill is installed twice, once as a plugin and once as a standalone skill (plugins only
/// reach some agents, so people keep the standalone copy for the rest). Identical `SKILL.md` files are one row, the
/// standalone one, which then names the plugin; different files stay two rows. Standalone skills in another agent's
/// folder (`home` set) are not what the selected agent loads, so they never replace a plugin row.
pub fn merge_plugin_copies(skills: Vec<SkillInfo>) -> Vec<SkillInfo> {
    let mut seen = HashSet::new();
    let mut skills: Vec<SkillInfo> =
        skills.into_iter().filter(|skill| skill.plugin.is_none() || seen.insert(skill.name.to_ascii_lowercase())).collect();
    let mut standalone: BTreeMap<String, usize> = BTreeMap::new();
    for (index, skill) in skills.iter().enumerate() {
        if skill.plugin.is_none() && skill.home.is_none() && skill.scope != SkillScope::Plugin {
            standalone.entry(skill.name.to_ascii_lowercase()).or_insert(index);
        }
    }
    let mut hashes: std::collections::HashMap<String, Option<[u8; 32]>> = Default::default();
    let mut hash_of = |path: &str| *hashes.entry(path.to_string()).or_insert_with(|| content_hash(Path::new(path)));
    let mut dropped = HashSet::new();
    // The plugin rows as listed, before a standalone row takes a plugin's name.
    let plugin_rows: Vec<usize> =
        (0..skills.len()).filter(|&index| skills[index].plugin.is_some() && skills[index].scope != SkillScope::Plugin).collect();
    for index in plugin_rows {
        let Some(plugin) = skills[index].plugin.clone() else { continue };
        let base = skills[index].name.rsplit(':').next().unwrap_or_default().to_ascii_lowercase();
        let Some(&other) = standalone.get(&base) else { continue };
        let (Some(theirs), Some(ours)) = (hash_of(&skills[other].path), hash_of(&skills[index].path)) else { continue };
        if theirs == ours {
            skills[other].plugin = Some(plugin);
            dropped.insert(index);
        }
    }
    let mut index = 0;
    skills.retain(|_| {
        index += 1;
        !dropped.contains(&(index - 1))
    });
    skills
}

fn content_hash(path: &Path) -> Option<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let text = std::fs::read_to_string(path).ok()?;
    Some(Sha256::digest(text.replace("\r\n", "\n").trim().as_bytes()).into())
}

fn effective_scope(path: &Path, fallback: SkillScope) -> SkillScope {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.contains("/.codex/plugins/") || normalized.contains("/.agents/plugins/") {
        SkillScope::App
    } else if normalized.contains("/.system/") {
        SkillScope::System
    } else {
        fallback
    }
}

pub(crate) fn parse_frontmatter(contents: &str) -> Frontmatter {
    let mut result = Frontmatter { user_invocable: true, ..Frontmatter::default() };
    let normalized = contents.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else { return result };
    let Some((frontmatter, _)) = rest.split_once("\n---") else { return result };
    let lines: Vec<&str> = frontmatter.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        if line.starts_with(char::is_whitespace) || line.trim_start().starts_with('#') {
            index += 1;
            continue;
        }
        let Some((key, raw_value)) = line.split_once(':') else {
            index += 1;
            continue;
        };
        let key = key.trim();
        let raw_value = raw_value.trim();
        let mut value = scalar(raw_value);
        if (raw_value.starts_with('|') || raw_value.starts_with('>')) && key == "description" {
            let mut chunks = Vec::new();
            index += 1;
            while index < lines.len() && (lines[index].starts_with(' ') || lines[index].is_empty()) {
                let chunk = lines[index].trim();
                if !chunk.is_empty() {
                    chunks.push(chunk);
                }
                index += 1;
            }
            value = chunks.join(" ");
            index = index.saturating_sub(1);
        }
        match key {
            "name" if !value.is_empty() => result.display_name = Some(value),
            "description" if !value.is_empty() => result.description = Some(compact_description(&value)),
            "user-invocable" if is_false(&value) => result.user_invocable = false,
            _ => {}
        }
        index += 1;
    }
    result
}

fn scalar(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 && matches!((value.as_bytes()[0], value.as_bytes()[value.len() - 1]), (b'\'', b'\'') | (b'"', b'"')) {
        value[1..value.len() - 1].trim().to_string()
    } else {
        value.to_string()
    }
}

fn is_false(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "false" | "no" | "off" | "n" | "0")
}

fn compact_description(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= 240 {
        compact
    } else {
        let shortened: String = compact.chars().take(239).collect();
        format!("{}…", shortened.trim_end())
    }
}

#[derive(serde::Deserialize)]
struct AgySkillsManifest {
    #[serde(default)]
    inherits: Option<Vec<AgySkillEntry>>,
    #[serde(default)]
    entries: Option<Vec<AgySkillEntry>>,
}

#[derive(serde::Deserialize)]
struct AgySkillEntry {
    path: String,
    #[serde(default)]
    include_only: Option<Vec<String>>,
    #[serde(default)]
    exclude: Option<Vec<String>>,
}

#[derive(Clone, Default)]
struct AgyFilter {
    include_groups: Vec<Vec<String>>,
    exclude_names: Vec<String>,
}

impl AgyFilter {
    fn narrow(&self, entry: &AgySkillEntry) -> Self {
        let mut include_groups = self.include_groups.clone();
        if let Some(list) = entry.include_only.as_ref().filter(|list| !list.is_empty()) {
            include_groups.push(list.clone());
        }
        let mut exclude_names = self.exclude_names.clone();
        if let Some(list) = entry.exclude.as_ref().filter(|list| !list.is_empty()) {
            exclude_names.extend(list.iter().cloned());
        }
        Self { include_groups, exclude_names }
    }

    fn matches(&self, entry: &str) -> bool {
        self.include_groups.iter().all(|group| group.iter().any(|name| name == entry))
            && !self.exclude_names.iter().any(|name| name == entry)
    }
}

#[derive(Default)]
struct AgyScan {
    budget: Budget,
    seen_names: HashSet<String>,
    found: Vec<SkillInfo>,
}

impl AgyScan {
    fn exhausted(&self) -> bool {
        self.budget.entries >= MAX_ENTRIES || self.budget.bytes >= MAX_TOTAL_BYTES
    }
}

/// Discover skills the way `agy` loads them:
/// - native roots in precedence order (`~/.gemini/config/skills`, `.gemini/skills`,
///   `~/.gemini/antigravity-cli/skills`, `.agents/skills`, `.agent/skills`); never `~/.agents/skills`;
/// - `skills.json` manifests (`.agents/skills.json`, `.agent/skills.json`, `~/.gemini/config/skills.json`),
///   with `inherits`, `include_only`, `exclude` (literal matching), null lists, and file entries;
/// - enabled plugins under `~/.gemini/config/plugins`.
fn scan_antigravity(cwd: &Path, home: Option<&Path>) -> Vec<SkillInfo> {
    let mut scan = AgyScan::default();

    let mut native_roots: Vec<(PathBuf, SkillScope)> = Vec::new();
    if let Some(home) = home {
        native_roots.push((home.join(".gemini/config/skills"), SkillScope::User));
    }
    native_roots.push((cwd.join(".gemini/skills"), SkillScope::Project));
    if let Some(home) = home {
        native_roots.push((home.join(".gemini/antigravity-cli/skills"), SkillScope::User));
    }
    native_roots.push((cwd.join(".agents/skills"), SkillScope::Project));
    native_roots.push((cwd.join(".agent/skills"), SkillScope::Project));

    let empty = AgyFilter::default();
    for (directory, scope) in native_roots {
        agy_scan_directory(&directory, scope, true, &empty, false, &mut scan);
        if scan.exhausted() {
            break;
        }
    }

    let mut manifests: Vec<(PathBuf, PathBuf, SkillScope)> = vec![
        (cwd.join(".agents/skills.json"), cwd.to_path_buf(), SkillScope::Project),
        (cwd.join(".agent/skills.json"), cwd.to_path_buf(), SkillScope::Project),
    ];
    if let Some(home) = home {
        let config_dir = home.join(".gemini/config");
        manifests.push((config_dir.join("skills.json"), config_dir, SkillScope::User));
    }
    for (config_path, base_dir, scope) in manifests {
        if scan.exhausted() {
            break;
        }
        agy_scan_manifest(&config_path, &base_dir, scope, &empty, &HashSet::new(), 0, &mut scan);
    }

    if let Some(home) = home
        && !scan.exhausted()
    {
        agy_scan_plugins(&home.join(".gemini/config"), &mut scan);
    }

    scan.found.sort_by_key(|skill| skill.name.to_ascii_lowercase());
    scan.found
}

fn agy_scan_plugins(config_dir: &Path, scan: &mut AgyScan) {
    let plugins_dir = config_dir.join("plugins");
    let Ok(entries) = std::fs::read_dir(&plugins_dir) else { return };
    let disabled = agy_disabled_plugins(&config_dir.join("config.json"));
    let mut plugins: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let path = entry.path();
            path.is_dir().then_some((name, path))
        })
        .collect();
    plugins.sort_by(|a, b| a.0.cmp(&b.0));
    let empty = AgyFilter::default();
    for (name, path) in plugins {
        if disabled.contains(&name) {
            continue;
        }
        agy_scan_directory(&path.join("skills"), SkillScope::User, true, &empty, false, scan);
        if scan.exhausted() {
            break;
        }
    }
}

fn agy_disabled_plugins(config_path: &Path) -> HashSet<String> {
    let Ok(meta) = std::fs::metadata(config_path) else { return HashSet::new() };
    if !meta.is_file() || meta.len() > MAX_SKILL_BYTES {
        return HashSet::new();
    }
    let Ok(raw) = std::fs::read_to_string(config_path) else { return HashSet::new() };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else { return HashSet::new() };
    json.get("plugins")
        .and_then(serde_json::Value::as_object)
        .map(|plugins| {
            plugins
                .iter()
                .filter(|(_, value)| value.get("enabled").and_then(serde_json::Value::as_bool) == Some(false))
                .map(|(name, _)| name.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// `agy` does not expand `~`, so a `~/…` path stays relative to `base_dir`.
fn agy_resolve_manifest_path(raw: &str, base_dir: &Path) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() { path.to_path_buf() } else { base_dir.join(path) }
}

fn agy_scan_manifest(
    config_path: &Path,
    base_dir: &Path,
    scope: SkillScope,
    filter: &AgyFilter,
    visited: &HashSet<PathBuf>,
    depth: usize,
    scan: &mut AgyScan,
) {
    if depth > MAX_INHERIT_DEPTH || scan.exhausted() {
        return;
    }
    let resolved = std::fs::canonicalize(config_path).unwrap_or_else(|_| config_path.to_path_buf());
    if visited.contains(&resolved) {
        return;
    }
    let Ok(meta) = std::fs::metadata(&resolved) else { return };
    if !meta.is_file() || meta.len() > MAX_SKILL_BYTES || scan.budget.bytes.saturating_add(meta.len()) > MAX_TOTAL_BYTES {
        return;
    }
    let Ok(raw) = std::fs::read_to_string(&resolved) else { return };
    scan.budget.bytes = scan.budget.bytes.saturating_add(raw.len() as u64);
    let Ok(manifest) = serde_json::from_str::<AgySkillsManifest>(&raw) else { return };

    let mut next_visited = visited.clone();
    next_visited.insert(resolved);

    for inherited in manifest.inherits.unwrap_or_default() {
        let inherited_path = agy_resolve_manifest_path(&inherited.path, base_dir);
        let inherited_base = inherited_path.parent().unwrap_or(base_dir).to_path_buf();
        let narrowed = filter.narrow(&inherited);
        agy_scan_manifest(&inherited_path, &inherited_base, scope, &narrowed, &next_visited, depth + 1, scan);
    }
    for entry in manifest.entries.unwrap_or_default() {
        let entry_path = agy_resolve_manifest_path(&entry.path, base_dir);
        let narrowed = filter.narrow(&entry);
        agy_scan_directory(&entry_path, scope, true, &narrowed, true, scan);
    }
}

fn is_agy_skill_file(file_name: &str) -> bool {
    file_name.eq_ignore_ascii_case("skill.md") && file_name.ends_with(".md")
}

/// Go's `url.PathEscape` order used by `agy` when sorting children inside a skill root.
fn agy_sort_key(entry: &str) -> String {
    let mut out = String::with_capacity(entry.len());
    for byte in entry.as_bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || matches!(byte, b'-' | b'_' | b'.' | b'~' | b'$' | b'&' | b'+' | b',' | b':' | b';' | b'=' | b'@');
        if keep {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn agy_scan_directory(
    path: &Path,
    scope: SkillScope,
    scan_children: bool,
    filter: &AgyFilter,
    accept_skill_file: bool,
    scan: &mut AgyScan,
) {
    if scan.exhausted() {
        return;
    }
    let Ok(meta) = std::fs::metadata(path) else { return };
    if meta.is_file() && accept_skill_file {
        scan.budget.entries += 1;
        let parent_name = path.parent().and_then(|parent| parent.file_name()).and_then(|name| name.to_str()).unwrap_or("");
        if filter.matches(parent_name) {
            agy_add_skill_file(path, scope, scan);
        }
        return;
    }
    if !meta.is_dir() {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(path) else { return };
    let mut entries: Vec<String> = read_dir.flatten().filter_map(|entry| entry.file_name().to_str().map(str::to_string)).collect();
    if scan.budget.entries.saturating_add(entries.len()) > MAX_ENTRIES {
        return;
    }
    scan.budget.entries += entries.len();
    entries.sort();

    if let Some(skill_file) = entries.iter().find(|entry| entry.eq_ignore_ascii_case("skill.md")) {
        agy_add_skill_file(&path.join(skill_file), scope, scan);
        return;
    }
    if scan_children {
        let mut children: Vec<(String, String)> =
            entries.into_iter().filter(|entry| filter.matches(entry)).map(|entry| (agy_sort_key(&entry), entry)).collect();
        children.sort_by(|left, right| left.0.cmp(&right.0));
        let empty = AgyFilter::default();
        for (_, child) in children {
            agy_scan_directory(&path.join(child), scope, false, &empty, false, scan);
        }
    }
}

fn agy_add_skill_file(skill_path: &Path, scope: SkillScope, scan: &mut AgyScan) {
    let Some(file_name) = skill_path.file_name().and_then(|name| name.to_str()) else { return };
    if !is_agy_skill_file(file_name) {
        return;
    }
    let Ok(meta) = std::fs::metadata(skill_path) else { return };
    if !meta.is_file() || meta.len() > MAX_SKILL_BYTES || scan.budget.bytes.saturating_add(meta.len()) > MAX_TOTAL_BYTES {
        return;
    }
    let Ok(contents) = std::fs::read_to_string(skill_path) else { return };
    scan.budget.bytes = scan.budget.bytes.saturating_add(meta.len());
    let Some((name, description)) = parse_agy_frontmatter(&contents, file_name) else { return };
    if !scan.seen_names.insert(name.to_ascii_lowercase()) {
        return;
    }
    scan.found.push(SkillInfo {
        name,
        display_name: None,
        description,
        path: skill_path.to_string_lossy().to_string(),
        scope: effective_scope(skill_path, scope),
        enabled: true,
        home: None,
        plugin: plugin_in_path(skill_path),
    });
}

/// Parse Antigravity's `--- ... ---` frontmatter. Requires valid frontmatter delimiters;
/// falls back to the file stem when `name` is omitted; skips malformed or blank names.
fn parse_agy_frontmatter(contents: &str, file_name: &str) -> Option<(String, Option<String>)> {
    let normalized = contents.replace("\r\n", "\n");
    let start = normalized.find("---")?;
    let after_open = &normalized[start + 3..];
    let end = after_open.find("---")?;
    let block = after_open[..end].trim();

    let mut name: Option<String> = None;
    let mut description: Option<String> = None;
    let mut user_invocable = true;

    if !block.is_empty() {
        let lines: Vec<&str> = block.lines().collect();
        let mut index = 0;
        let mut saw_mapping = false;
        while index < lines.len() {
            let line = lines[index];
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || line.starts_with(char::is_whitespace) {
                index += 1;
                continue;
            }
            let (key, raw_value) = line.split_once(':')?;
            saw_mapping = true;
            let key = key.trim();
            let raw_value = raw_value.trim();
            let (value, is_null) = if (raw_value.starts_with('|') || raw_value.starts_with('>')) && key == "description" {
                let mut chunks = Vec::new();
                index += 1;
                while index < lines.len() && (lines[index].starts_with(' ') || lines[index].is_empty()) {
                    let chunk = lines[index].trim();
                    if !chunk.is_empty() {
                        chunks.push(chunk);
                    }
                    index += 1;
                }
                index = index.saturating_sub(1);
                (chunks.join(" "), false)
            } else if raw_value.is_empty() || raw_value.eq_ignore_ascii_case("null") || raw_value == "~" {
                (String::new(), true)
            } else if raw_value.starts_with('[') || raw_value.starts_with('{') {
                // Non-string values (lists/objects) or unclosed flow syntax are invalid for string fields.
                if matches!(key, "name" | "description") {
                    return None;
                }
                (String::new(), false)
            } else {
                (unquote_preserving_whitespace(raw_value), false)
            };
            match key {
                "name" if !is_null => {
                    if value.is_empty() || value != value.trim() {
                        return None;
                    }
                    name = Some(value);
                }
                "description" if !is_null => {
                    let trimmed = value.trim();
                    if !trimmed.is_empty() {
                        description = Some(compact_description(trimmed));
                    }
                }
                "user-invocable" if !is_null && is_false(&value) => user_invocable = false,
                _ => {}
            }
            index += 1;
        }
        if !saw_mapping {
            return None;
        }
    }

    if !user_invocable {
        return None;
    }
    let resolved_name = name.unwrap_or_else(|| file_name.strip_suffix(".md").unwrap_or(file_name).to_string());
    if resolved_name.is_empty() || resolved_name != resolved_name.trim() {
        return None;
    }
    Some((resolved_name, description))
}

fn unquote_preserving_whitespace(value: &str) -> String {
    if value.len() >= 2 && matches!((value.as_bytes()[0], value.as_bytes()[value.len() - 1]), (b'\'', b'\'') | (b'"', b'"')) {
        value[1..value.len() - 1].to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_frontmatter, roots};
    use kybern_protocol::{ProviderKind, SkillHome};
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    struct TempTree(PathBuf);

    impl TempTree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("kybern-skills-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).expect("create temp tree");
            Self(path)
        }
    }

    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn reads_common_skill_frontmatter() {
        let parsed = parse_frontmatter("---\nname: Better UI\ndescription: >\n  Make dense interfaces\n  easier to scan.\n---\nBody");
        assert_eq!(parsed.display_name.as_deref(), Some("Better UI"));
        assert_eq!(parsed.description.as_deref(), Some("Make dense interfaces easier to scan."));
        assert!(parsed.user_invocable);
    }

    #[test]
    fn hides_provider_reserved_skills() {
        let parsed = parse_frontmatter("---\nuser-invocable: no\n---\nBody");
        assert!(!parsed.user_invocable);
    }

    #[test]
    fn every_supported_harness_has_a_skill_catalog() {
        let cwd = PathBuf::from("/workspace");
        let home = PathBuf::from("/home/test");
        for provider in [
            ProviderKind::ClaudeCode,
            ProviderKind::Codex,
            ProviderKind::Opencode,
            ProviderKind::Pi,
            ProviderKind::Omp,
            ProviderKind::Cursor,
            ProviderKind::Antigravity,
            ProviderKind::GrokBuild,
        ] {
            assert!(!roots(&cwd, provider, &BTreeMap::new(), Some(&home)).is_empty(), "{provider} has no skill roots");
        }
    }

    #[test]
    fn grok_catalog_includes_its_own_skill_folders_under_grok_home() {
        let cwd = PathBuf::from("/workspace");
        let home = PathBuf::from("/home/test");
        let paths = |env: &BTreeMap<String, String>| -> Vec<PathBuf> {
            roots(&cwd, ProviderKind::GrokBuild, env, Some(&home)).into_iter().map(|root| root.path).collect()
        };
        let default = paths(&BTreeMap::new());
        for path in [cwd.join(".grok/skills"), cwd.join(".agents/skills"), home.join(".grok/skills"), home.join(".agents/skills")] {
            assert!(default.contains(&path), "{path:?} in {default:?}");
        }
        let custom = paths(&BTreeMap::from([("GROK_HOME".to_string(), "~/xai".to_string())]));
        assert!(custom.contains(&home.join("xai/skills")) && !custom.contains(&home.join(".grok/skills")), "{custom:?}");
    }

    #[test]
    fn opencode_catalog_includes_its_compatible_skill_roots() {
        let cwd = PathBuf::from("/workspace");
        let home = PathBuf::from("/home/test");
        let paths: Vec<_> = roots(&cwd, ProviderKind::Opencode, &BTreeMap::new(), Some(&home)).into_iter().map(|root| root.path).collect();
        assert!(paths.contains(&cwd.join(".opencode/skills")));
        assert!(paths.contains(&cwd.join(".claude/skills")));
        assert!(paths.contains(&cwd.join(".agents/skills")));
        assert!(paths.contains(&home.join(".config/opencode/skills")));
    }

    #[test]
    fn pi_catalog_follows_configured_external_skill_directories() {
        let tree = TempTree::new();
        let cwd = tree.0.join("workspace");
        let home = tree.0.join("home");
        std::fs::create_dir_all(cwd.join(".pi")).expect("project settings dir");
        std::fs::create_dir_all(home.join(".pi/agent")).expect("user settings dir");
        std::fs::write(cwd.join(".pi/settings.json"), r#"{"skills":["../.agents/skills"]}"#).expect("project settings");
        std::fs::write(home.join(".pi/agent/settings.json"), r#"{"skills":["~/.claude/skills"]}"#).expect("user settings");

        let paths: Vec<_> = roots(&cwd, ProviderKind::Pi, &BTreeMap::new(), Some(&home)).into_iter().map(|root| root.path).collect();
        assert!(paths.contains(&cwd.join(".pi/../.agents/skills")));
        assert!(paths.contains(&home.join(".claude/skills")));
        assert!(!paths.contains(&home.join(".agents/skills")), "Pi should not advertise unconfigured cross-provider roots");
    }
    #[tokio::test]
    async fn other_agents_homes_are_listed_with_their_home_and_the_first_name_wins() {
        let tree = TempTree::new();
        for (home, name) in [("claude", "polish"), ("claude", "shared"), ("agents", "shared"), ("agents", "review")] {
            let folder = tree.0.join(home).join(name);
            std::fs::create_dir_all(&folder).expect("skill folder");
            std::fs::write(folder.join("SKILL.md"), format!("---\nname: {name}\ndescription: From {home}\n---\nBody")).expect("skill file");
        }
        let homes = vec![
            (SkillHome::Claude, tree.0.join("claude")),
            (SkillHome::Agents, tree.0.join("agents")),
            (SkillHome::Pi, tree.0.join("missing")),
        ];
        let skills = super::list_homes(homes).await.expect("listing never fails on a missing folder");
        let found: Vec<_> = skills.iter().map(|skill| (skill.name.as_str(), skill.home)).collect();
        assert_eq!(found, [("polish", Some(SkillHome::Claude)), ("review", Some(SkillHome::Agents)), ("shared", Some(SkillHome::Claude))]);
        assert!(skills.iter().all(|skill| skill.enabled && skill.path.ends_with("SKILL.md")));
    }

    #[test]
    fn an_agents_own_skills_carry_no_home() {
        let tree = TempTree::new();
        let folder = tree.0.join("skills/own");
        std::fs::create_dir_all(&folder).expect("skill folder");
        std::fs::write(folder.join("SKILL.md"), "Body").expect("skill file");
        let root = super::Root { path: tree.0.join("skills"), scope: kybern_protocol::SkillScope::User, depth: 1 };
        let mut found = Vec::new();
        super::visit(&root.path, &root, 0, &mut Default::default(), &mut Default::default(), &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].home, None);
    }

    fn write_skill(root: &std::path::Path, name: &str, body: &str) -> PathBuf {
        let folder = root.join(name);
        std::fs::create_dir_all(&folder).expect("skill folder");
        std::fs::write(folder.join("SKILL.md"), format!("---\nname: {name}\ndescription: Checks {name}\n---\n{body}")).expect("skill file");
        folder.join("SKILL.md")
    }

    fn standalone(
        path: &std::path::Path,
        name: &str,
        scope: kybern_protocol::SkillScope,
        home: Option<SkillHome>,
    ) -> kybern_protocol::SkillInfo {
        kybern_protocol::SkillInfo {
            name: name.into(),
            display_name: None,
            description: None,
            path: path.to_string_lossy().into(),
            scope,
            enabled: true,
            home,
            plugin: None,
        }
    }

    #[tokio::test]
    async fn a_plugin_installed_in_two_places_lists_each_skill_once() {
        let tree = TempTree::new();
        for version in ["1.0.0", "1.1.0"] {
            write_skill(&tree.0.join(version).join("skills"), "better-colors", "Body");
        }
        let roots = vec![("interfaces".to_string(), tree.0.join("1.0.0")), ("interfaces".to_string(), tree.0.join("1.1.0"))];
        let found = super::plugin_skills(roots).await.expect("plugin skills");
        assert_eq!(found.iter().map(|skill| skill.name.as_str()).collect::<Vec<_>>(), ["interfaces:better-colors"]);
        assert_eq!(found[0].plugin.as_deref(), Some("interfaces"));
        assert_eq!(found[0].scope, kybern_protocol::SkillScope::App);
    }

    #[tokio::test]
    async fn a_plugin_skill_with_an_identical_standalone_copy_is_one_row_that_names_the_plugin() {
        let tree = TempTree::new();
        let plugin = write_skill(&tree.0.join("plugin/skills"), "better-colors", "Same body");
        let own = write_skill(&tree.0.join("own"), "better-colors", "Same body");
        let other = write_skill(&tree.0.join("own"), "better-layout", "Not a plugin skill");
        let mut skills = super::plugin_skills(vec![("interfaces".into(), tree.0.join("plugin"))]).await.expect("plugin skills");
        assert_eq!(skills[0].path, plugin.canonicalize().unwrap().to_string_lossy());
        skills.push(standalone(&own, "better-colors", kybern_protocol::SkillScope::User, None));
        skills.push(standalone(&other, "better-layout", kybern_protocol::SkillScope::User, None));
        let merged = super::merge_plugin_copies(skills);
        let rows: Vec<_> = merged.iter().map(|skill| (skill.name.as_str(), skill.scope, skill.plugin.as_deref())).collect();
        assert_eq!(
            rows,
            [
                ("better-colors", kybern_protocol::SkillScope::User, Some("interfaces")),
                ("better-layout", kybern_protocol::SkillScope::User, None)
            ]
        );
    }

    #[tokio::test]
    async fn a_plugin_skill_whose_standalone_copy_differs_keeps_both_rows() {
        let tree = TempTree::new();
        write_skill(&tree.0.join("plugin/skills"), "better-colors", "Plugin body");
        let own = write_skill(&tree.0.join("own"), "better-colors", "My own edit");
        let mut skills = super::plugin_skills(vec![("interfaces".into(), tree.0.join("plugin"))]).await.expect("plugin skills");
        skills.push(standalone(&own, "better-colors", kybern_protocol::SkillScope::User, None));
        let merged = super::merge_plugin_copies(skills);
        let rows: Vec<_> = merged.iter().map(|skill| (skill.name.as_str(), skill.plugin.as_deref())).collect();
        assert_eq!(rows, [("interfaces:better-colors", Some("interfaces")), ("better-colors", None)]);
    }

    #[tokio::test]
    async fn a_copy_in_another_agents_folder_does_not_replace_the_plugin_row() {
        let tree = TempTree::new();
        write_skill(&tree.0.join("plugin/skills"), "better-colors", "Same body");
        let elsewhere = write_skill(&tree.0.join("agents"), "better-colors", "Same body");
        let mut skills = super::plugin_skills(vec![("interfaces".into(), tree.0.join("plugin"))]).await.expect("plugin skills");
        skills.push(standalone(&elsewhere, "better-colors", kybern_protocol::SkillScope::User, Some(SkillHome::Agents)));
        assert_eq!(super::merge_plugin_copies(skills).len(), 2);
    }

    #[test]
    fn codex_plugin_cache_skills_name_their_plugin() {
        let path = |value: &str| super::plugin_in_path(std::path::Path::new(value));
        assert_eq!(path("/home/a/.codex/plugins/cache/openai-curated/github/1.2/skills/triage/SKILL.md").as_deref(), Some("github"));
        assert_eq!(path("/home/a/.agents/plugins/tools/skills/x/SKILL.md").as_deref(), Some("tools"));
        assert_eq!(path("/home/a/.agents/skills/x/SKILL.md"), None);
    }

    #[test]
    fn omp_named_profile_skills_do_not_fall_back_to_the_default_profile() {
        let cwd = PathBuf::from("/workspace");
        let home = PathBuf::from("/home/test");
        let env = [("OMP_PROFILE".into(), "work".into()), ("PI_CODING_AGENT_DIR".into(), "/other/agent".into())].into();
        let paths: Vec<_> = roots(&cwd, ProviderKind::Omp, &env, Some(&home)).into_iter().map(|root| root.path).collect();
        assert!(paths.contains(&home.join(".omp/profiles/work/agent/skills")));
        assert!(!paths.contains(&home.join(".omp/agent/skills")));
        assert!(!paths.contains(&PathBuf::from("/other/agent/skills")));
    }

    #[tokio::test]
    async fn antigravity_reads_its_native_roots_and_skips_home_agents_skills() {
        let tree = TempTree::new();
        let cwd = tree.0.join("workspace");
        let home = tree.0.join("home");
        std::fs::create_dir_all(&cwd).unwrap();
        write_skill(&home.join(".gemini/config/skills"), "from-config", "body");
        write_skill(&cwd.join(".gemini/skills"), "from-project-gemini", "body");
        write_skill(&home.join(".gemini/antigravity-cli/skills"), "from-cli", "body");
        write_skill(&cwd.join(".agents/skills"), "from-project-agents", "body");
        write_skill(&cwd.join(".agent/skills"), "from-project-agent", "body");
        // `~/.agents/skills` is never read by `agy` unless cwd == home or referenced in skills.json.
        write_skill(&home.join(".agents/skills"), "ignored-home-agents", "body");

        let env = BTreeMap::from([("HOME".into(), home.display().to_string())]);
        let found = super::list(&cwd, ProviderKind::Antigravity, &env).await.unwrap();
        let rows: Vec<(&str, kybern_protocol::SkillScope)> = found.iter().map(|s| (s.name.as_str(), s.scope)).collect();
        assert_eq!(
            rows,
            [
                ("from-cli", kybern_protocol::SkillScope::User),
                ("from-config", kybern_protocol::SkillScope::User),
                ("from-project-agent", kybern_protocol::SkillScope::Project),
                ("from-project-agents", kybern_protocol::SkillScope::Project),
                ("from-project-gemini", kybern_protocol::SkillScope::Project),
            ]
        );
    }

    #[tokio::test]
    async fn antigravity_reads_skills_json_manifests_with_inherits_literal_filters_nulls_and_files() {
        let tree = TempTree::new();
        let cwd = tree.0.join("workspace");
        let home = tree.0.join("home");
        std::fs::create_dir_all(cwd.join(".agents")).unwrap();
        std::fs::create_dir_all(home.join(".gemini/config")).unwrap();

        let shared = home.join(".agents/skills");
        write_skill(&shared, "yagni", "body");
        write_skill(&shared, "experimental-draft", "body");

        let inherited = home.join("inherited-skills");
        write_skill(&inherited, "linter", "body");
        write_skill(&inherited, "skipped", "body");
        write_skill(&inherited, "lint-draft", "body");

        let project_tools = cwd.join("tools/skills");
        write_skill(&project_tools, "deploy", "body");
        write_skill(&project_tools, "internal", "body");

        // `agy` does not expand `~`, so `~/tilde-skills` must not be loaded.
        write_skill(&home.join("tilde-skills"), "tilde", "body");

        // Enabled and disabled plugins.
        let plugins = home.join(".gemini/config/plugins");
        write_skill(&plugins.join("demo/skills"), "demo-skill", "body");
        write_skill(&plugins.join("off/skills"), "off-skill", "body");
        std::fs::write(home.join(".gemini/config/config.json"), r#"{"plugins":{"off":{"enabled":false}}}"#).unwrap();

        let inherited_manifest = home.join("shared-skills.json");
        let global_manifest = home.join(".gemini/config/skills.json");
        // Cyclic inherit back to global_manifest must terminate cleanly.
        std::fs::write(
            &inherited_manifest,
            serde_json::json!({
                "inherits": [{"path": global_manifest.display().to_string()}],
                "entries": [{"path": inherited.display().to_string()}]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            &global_manifest,
            serde_json::json!({
                "inherits": [{"path": inherited_manifest.display().to_string(), "include_only": ["linter", "lint-.*"]}],
                "entries": [
                    {"path": shared.display().to_string(), "exclude": ["experimental-.*"]},
                    {"path": "~/tilde-skills"}
                ]
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            cwd.join(".agents/skills.json"),
            r#"{"entries":null,"inherits":[{"path":"workspace-skills.json","include_only":null}]}"#,
        )
        .unwrap();
        std::fs::write(
            cwd.join("workspace-skills.json"),
            r#"{"inherits":null,"entries":[{"path":"tools/skills/deploy/SKILL.md","exclude":null},{"path":"tools/skills/internal/SKILL.md","exclude":["internal"]}]}"#,
        )
        .unwrap();

        let env = BTreeMap::from([("HOME".into(), home.display().to_string())]);
        let found = super::list(&cwd, ProviderKind::Antigravity, &env).await.unwrap();
        let names: Vec<&str> = found.iter().map(|s| s.name.as_str()).collect();
        // `lint-.*` and `experimental-.*` are literal strings, not regexes: `lint-draft` is not
        // included and `experimental-draft` is not excluded.
        assert_eq!(names, ["demo-skill", "deploy", "experimental-draft", "linter", "yagni"]);
    }
}
