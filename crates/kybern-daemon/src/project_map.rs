//! The project map: a daemon-built, commit-stamped description of a project's
//! repositories. Deterministic and cheap: it reads `git ls-files`, a few
//! manifests and two bounded `git log` runs, and no model is involved.
//!
//! It answers "where is what, how is it built, what moved lately" for the
//! Coordinator (a bounded header in its session instructions and rotation seed)
//! and for every thread through the `kybern_project_map` tool and the
//! `projects.map` RPC. The map is cached per project, keyed by each
//! repository's HEAD, and rebuilt lazily when a request sees another HEAD.
//!
//! Sections: Repos, Layout (top two directory levels with file counts, named
//! from manifests), Commands (what the project documents; nothing is
//! inferred), Busy areas (last 30 days) and Removed and renamed (last 14 days).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, ensure};
use kybern_git::Repo;
use kybern_protocol::methods::{
    ProjectMap, ProjectMapArea, ProjectMapBusy, ProjectMapChange, ProjectMapChangeKind, ProjectMapCommand, ProjectMapRepo,
};
use kybern_protocol::*;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::files::{MAX_FILES, SKIP_DIRS};
use crate::orchestrator::group_git::member_dir;

pub(crate) const TOOL: &str = "kybern_project_map";

/// The header sessions receive.
pub(crate) const HEADER_MAX_BYTES: usize = 6 * 1024;

const BUSY_DAYS: u32 = 30;
const BUSY_TOP: usize = 8;
const REMOVED_DAYS: u32 = 14;
const REMOVED_TOP: usize = 15;
/// Commits scanned for the two log sections, so a huge window stays bounded.
const BUSY_MAX_COMMITS: usize = 2000;
const REMOVED_MAX_COMMITS: usize = 1000;
/// Most areas kept in the layout of one repository.
const LAYOUT_MAX_AREAS: usize = 400;
const MANIFEST_MAX_BYTES: u64 = 256 * 1024;
const MANIFEST_MAX_COUNT: usize = 80;
/// Deepest directory a manifest is read from.
const MANIFEST_MAX_DEPTH: usize = 4;
const SCRIPTS_PER_MANIFEST: usize = 40;
const SCRIPT_BODY_BYTES: usize = 300;
const COMMANDS_MAX: usize = 150;
const FENCE_MAX_BYTES: usize = 1200;
const FENCES_PER_FILE: usize = 12;
const MAKE_TARGETS_MAX: usize = 40;
/// Entries a path query lists and commits it adds.
const PATH_ENTRIES_MAX: usize = 200;
const PATH_COMMITS: usize = 10;

pub(crate) fn is_tool(name: &str) -> bool {
    name == TOOL
}

pub(crate) fn tool_definition() -> kybern_drivers::NativeToolDefinition {
    kybern_drivers::NativeToolDefinition {
        name: TOOL.into(),
        description: concat!(
            "Orient in this project without reading it file by file. Built by Kybern from git and manifests (no summary), stamped with the commit it describes; ",
            "check the current code before relying on it. With no arguments it returns the map header. ",
            "section: layout (directories to two levels with file counts, named from manifests), commands (scripts, aliases, make/just targets and fenced Build/Test blocks from AGENTS.md or README.md), ",
            "busy (directories with the most commits in 30 days), removed (files deleted or renamed in 14 days). ",
            "path: a directory or file, relative to the project folder; returns its tracked entries and the last 10 commits that touched it, and takes precedence over section. ",
            "Group projects hold several repositories: start a path with the repository's folder name."
        )
        .into(),
        input_schema: json!({
            "type": "object", "additionalProperties": false,
            "properties": {
                "section": {"enum": ["layout", "commands", "busy", "removed", null], "description": "One section of the map in full."},
                "path": {"type": ["string", "null"], "description": "A directory or file: its entries and the last 10 commits that touched it."}
            },
            "required": []
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ToolArgs {
    #[serde(default)]
    section: Option<Section>,
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Section {
    Layout,
    Commands,
    Busy,
    Removed,
}

// ---- repositories ----

/// One repository of a project and where it lives.
#[derive(Debug, Clone)]
pub(crate) struct RepoSpec {
    /// Member path relative to the project folder; "." for a single project or the group folder itself.
    pub path: String,
    pub name: String,
    pub dir: PathBuf,
    /// Members nested inside this one (the group folder, when it is a member itself).
    pub nested: Vec<String>,
}

/// The repositories of `project`: its available members for a group, the project
/// folder for a single git project, and none for a folder that is not a repository.
pub(crate) fn repo_specs(project: &Project) -> Vec<RepoSpec> {
    let base = Path::new(&project.path);
    if project.kind == ProjectKind::Group {
        let nested: Vec<String> = project.members.iter().filter(|m| m.path != ".").map(|m| m.path.clone()).collect();
        return project
            .members
            .iter()
            .filter(|m| m.status == MemberStatus::Ok)
            .map(|m| RepoSpec {
                path: m.path.clone(),
                name: m.name.clone(),
                dir: member_dir(base, &m.path),
                nested: if m.path == "." { nested.clone() } else { Vec::new() },
            })
            .collect();
    }
    if project.is_git || base.join(".git").exists() {
        return vec![RepoSpec { path: ".".into(), name: project.name.clone(), dir: base.to_path_buf(), nested: Vec::new() }];
    }
    Vec::new()
}

async fn run(repo: &Repo, args: &[&str]) -> Option<String> {
    let out = repo.output(args).await.ok()?;
    out.success.then_some(out.stdout)
}

/// HEAD of every repository that has one, in `specs` order.
async fn current_heads(specs: &[RepoSpec]) -> Vec<(String, String)> {
    let heads = futures::future::join_all(specs.iter().map(|spec| async move { Repo::new(&spec.dir).head().await })).await;
    specs.iter().zip(heads).filter_map(|(spec, head)| head.map(|head| (spec.path.clone(), head))).collect()
}

fn is_skipped(path: &str) -> bool {
    path.split('/').any(|part| SKIP_DIRS.contains(&part))
}

fn is_nested(path: &str, nested: &[String]) -> bool {
    nested.iter().any(|member| path.strip_prefix(member.as_str()).is_some_and(|rest| rest.starts_with('/')))
}

fn truncate_utf8(text: &mut String, max_bytes: usize) -> bool {
    if text.len() <= max_bytes {
        return false;
    }
    let mut end = max_bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    true
}

/// `text` cut to `max_bytes` on a character boundary, with an ellipsis when cut.
fn clip(text: &str, max_bytes: usize) -> String {
    let mut out = text.to_owned();
    if truncate_utf8(&mut out, max_bytes) {
        out.push('…');
    }
    out
}

// ---- build ----

#[derive(Default)]
struct RepoPart {
    repo: Option<ProjectMapRepo>,
    layout: Vec<ProjectMapArea>,
    commands: Vec<ProjectMapCommand>,
    busy: Vec<ProjectMapBusy>,
    removed: Vec<ProjectMapChange>,
}

/// Build the map of `project` from its repositories as they are now.
pub(crate) async fn build(project: &Project) -> Result<ProjectMap> {
    let specs = repo_specs(project);
    ensure!(!specs.is_empty(), "This project is not a git repository, so it has no map.");
    let parts = futures::future::join_all(specs.iter().map(build_repo)).await;
    let mut map = ProjectMap {
        built_at: chrono::Utc::now(),
        repos: Vec::new(),
        layout: Vec::new(),
        commands: Vec::new(),
        busy: Vec::new(),
        removed: Vec::new(),
        header: String::new(),
    };
    for part in parts {
        let Some(repo) = part.repo else { continue };
        map.repos.push(repo);
        map.layout.extend(part.layout);
        map.commands.extend(part.commands);
        map.busy.extend(part.busy);
        map.removed.extend(part.removed);
    }
    ensure!(!map.repos.is_empty(), "This project has no commits yet, so it has no map.");
    map.commands.truncate(COMMANDS_MAX);
    map.header = render_header(&map);
    Ok(map)
}

async fn build_repo(spec: &RepoSpec) -> RepoPart {
    let repo = Repo::new(&spec.dir);
    let Some(head) = repo.head().await else { return RepoPart::default() };
    let (files, busy, removed, branch, default_branch) = tokio::join!(
        tracked_files(&repo, spec),
        busy_areas(&repo, spec),
        removed_files(&repo, spec),
        repo.current_branch(),
        default_branch(&repo)
    );
    let (files, truncated) = files;
    let dir = spec.dir.clone();
    let listing = files.clone();
    let sources = tokio::task::spawn_blocking(move || read_sources(&dir, &listing)).await.unwrap_or_default();
    let layout = layout_areas(&spec.path, &files, &sources.manifests);
    let commands = sources.commands.into_iter().map(|c| ProjectMapCommand { repo: spec.path.clone(), ..c }).collect();
    RepoPart {
        repo: Some(ProjectMapRepo {
            path: spec.path.clone(),
            name: spec.name.clone(),
            default_branch: default_branch.or_else(|| branch.clone()),
            branch,
            head,
            files: files.len() as u32,
            truncated,
        }),
        layout,
        commands,
        busy: busy.into_iter().map(|(path, commits)| ProjectMapBusy { repo: spec.path.clone(), path, commits }).collect(),
        removed: removed.into_iter().map(|c| ProjectMapChange { repo: spec.path.clone(), ..c }).collect(),
    }
}

/// The remote's default branch, else `main` or `master` when one exists.
async fn default_branch(repo: &Repo) -> Option<String> {
    if let Some(name) = repo.default_branch().await {
        return Some(name);
    }
    for name in ["main", "master"] {
        if run(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).await.is_some() {
            return Some(name.to_owned());
        }
    }
    None
}

/// Tracked files, with the same skip list and cap as the composer's file index.
async fn tracked_files(repo: &Repo, spec: &RepoSpec) -> (Vec<String>, bool) {
    let Some(out) = run(repo, &["ls-files", "--cached", "-z"]).await else { return (Vec::new(), false) };
    let mut files: Vec<String> =
        out.split('\0').filter(|path| !path.is_empty() && !is_skipped(path) && !is_nested(path, &spec.nested)).map(str::to_owned).collect();
    let truncated = files.len() > MAX_FILES;
    files.truncate(MAX_FILES);
    (files, truncated)
}

/// Directory at depth two (`a/b`, or `a` for a file directly under `a`); `None` for a root file.
fn area_of(path: &str) -> Option<String> {
    let mut parts = path.split('/');
    let (first, second, third) = (parts.next()?, parts.next(), parts.next());
    match (second, third) {
        (None, _) => None,
        (Some(_), None) => Some(first.to_owned()),
        (Some(second), Some(_)) => Some(format!("{first}/{second}")),
    }
}

/// Commits per directory over the last 30 days, busiest first.
async fn busy_areas(repo: &Repo, spec: &RepoSpec) -> Vec<(String, u32)> {
    let since = format!("--since={BUSY_DAYS}.days");
    let limit = format!("--max-count={BUSY_MAX_COMMITS}");
    let args = ["-c", "core.quotepath=false", "log", &since, &limit, "--no-merges", "--relative", "--name-only", "--format=%x01"];
    let Some(out) = run(repo, &args).await else { return Vec::new() };
    let mut counts: HashMap<String, u32> = HashMap::new();
    for commit in out.split('\x01').filter(|chunk| !chunk.trim().is_empty()) {
        let areas: BTreeSet<String> = commit
            .lines()
            .map(str::trim)
            .filter(|path| !path.is_empty() && !is_skipped(path) && !is_nested(path, &spec.nested))
            .filter_map(area_of)
            .collect();
        for area in areas {
            *counts.entry(area).or_default() += 1;
        }
    }
    let mut ranked: Vec<(String, u32)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.truncate(BUSY_TOP);
    ranked
}

/// Files deleted or renamed in the last 14 days, newest first. The caller sets `repo`.
async fn removed_files(repo: &Repo, spec: &RepoSpec) -> Vec<ProjectMapChange> {
    let since = format!("--since={REMOVED_DAYS}.days");
    let limit = format!("--max-count={REMOVED_MAX_COMMITS}");
    let args = [
        "-c",
        "core.quotepath=false",
        "log",
        &since,
        &limit,
        "--no-merges",
        "--relative",
        "--diff-filter=DR",
        "--name-status",
        "-M",
        "--format=%x01%h%x1f%aI%x1f%s",
    ];
    let Some(out) = run(repo, &args).await else { return Vec::new() };
    let mut changes = Vec::new();
    'commits: for chunk in out.split('\x01').filter(|chunk| !chunk.trim().is_empty()) {
        let mut lines = chunk.lines();
        let mut header = lines.next().unwrap_or_default().splitn(3, '\x1f');
        let (commit, date, subject) =
            (header.next().unwrap_or_default(), header.next().unwrap_or_default(), header.next().unwrap_or_default());
        for line in lines {
            let mut fields = line.split('\t');
            let (status, first, second) = (fields.next().unwrap_or_default(), fields.next(), fields.next());
            let (kind, path, from) = match (status.chars().next(), first, second) {
                (Some('D'), Some(path), _) => (ProjectMapChangeKind::Deleted, path, None),
                (Some('R'), Some(old), Some(new)) => (ProjectMapChangeKind::Renamed, new, Some(old)),
                _ => continue,
            };
            if is_skipped(path) || is_nested(path, &spec.nested) {
                continue;
            }
            changes.push(ProjectMapChange {
                repo: String::new(),
                kind,
                path: path.to_owned(),
                from: from.map(str::to_owned),
                commit: commit.to_owned(),
                date: date.to_owned(),
                subject: subject.to_owned(),
            });
            if changes.len() >= REMOVED_TOP {
                break 'commits;
            }
        }
    }
    changes
}

// ---- manifests and commands ----

/// What one manifest says. `dir` is relative to the repository ('' for the root).
#[derive(Debug, Clone, Default)]
struct Manifest {
    dir: String,
    kind: &'static str,
    name: Option<String>,
    /// Workspace member globs, relative to the repository.
    workspace: Vec<String>,
}

#[derive(Default)]
struct Sources {
    manifests: Vec<Manifest>,
    commands: Vec<ProjectMapCommand>,
}

fn join_dir(dir: &str, rel: &str) -> String {
    let rel = rel.trim_start_matches("./");
    if dir.is_empty() { rel.to_owned() } else { format!("{dir}/{rel}") }
}

fn depth(dir: &str) -> usize {
    if dir.is_empty() { 0 } else { dir.split('/').count() }
}

/// Read the manifests and documented commands of a repository. Blocking file reads, bounded.
fn read_sources(root: &Path, files: &[String]) -> Sources {
    let tracked: BTreeSet<&str> = files.iter().map(String::as_str).collect();
    let real_root = root.canonicalize().ok();
    // A tracked symlink (the file itself or a folder above it) must not pull a
    // file from outside the repository into the map.
    let read = |rel: &str| -> Option<String> {
        let path = rel.split('/').fold(root.to_path_buf(), |dir, part| dir.join(part));
        let meta = std::fs::symlink_metadata(&path).ok()?;
        if !meta.is_file() || meta.len() > MANIFEST_MAX_BYTES {
            return None;
        }
        let real = path.canonicalize().ok()?;
        real_root.as_ref().is_some_and(|root| real.starts_with(root)).then(|| std::fs::read_to_string(real).ok()).flatten()
    };

    // Manifests, shallowest first so a cap keeps the ones that name the top-level areas.
    let mut candidates: Vec<(&str, &str)> = files
        .iter()
        .filter_map(|file| {
            let (dir, name) = file.rsplit_once('/').unwrap_or(("", file));
            matches!(name, "Cargo.toml" | "package.json" | "go.mod" | "pyproject.toml" | "pnpm-workspace.yaml")
                .then_some((dir, file.as_str()))
                .filter(|(dir, _)| depth(dir) <= MANIFEST_MAX_DEPTH)
        })
        .collect();
    candidates.sort_by(|a, b| depth(a.0).cmp(&depth(b.0)).then_with(|| a.1.cmp(b.1)));
    candidates.truncate(MANIFEST_MAX_COUNT);

    let mut sources = Sources::default();
    let mut scripts: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for (dir, file) in &candidates {
        let Some(text) = read(file) else { continue };
        let name = file.rsplit('/').next().unwrap_or(file);
        let mut manifest = Manifest { dir: (*dir).to_owned(), ..Manifest::default() };
        match name {
            "Cargo.toml" => {
                manifest.kind = "cargo";
                let entries = toml_entries(&text);
                manifest.name = toml_first(&entries, "package", "name");
                manifest.workspace = toml_all(&entries, "workspace", "members").into_iter().map(|glob| join_dir(dir, &glob)).collect();
            }
            "package.json" => {
                manifest.kind = "npm";
                if let Ok(json) = serde_json::from_str::<Value>(&text) {
                    manifest.name = json.get("name").and_then(Value::as_str).map(str::to_owned);
                    let workspaces = json.get("workspaces").map(|w| w.get("packages").unwrap_or(w));
                    if let Some(list) = workspaces.and_then(Value::as_array) {
                        manifest.workspace = list.iter().filter_map(Value::as_str).map(|glob| join_dir(dir, glob)).collect();
                    }
                    if let Some(object) = json.get("scripts").and_then(Value::as_object) {
                        let list = object.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned()))).collect();
                        scripts.push(((*file).to_owned(), list));
                    }
                }
            }
            "go.mod" => {
                manifest.kind = "go";
                manifest.name = text
                    .lines()
                    .find_map(|line| line.trim().strip_prefix("module "))
                    .map(|module| module.trim().trim_matches('"').to_owned())
                    .filter(|module| !module.is_empty());
            }
            "pyproject.toml" => {
                manifest.kind = "python";
                let entries = toml_entries(&text);
                manifest.name = toml_first(&entries, "project", "name").or_else(|| toml_first(&entries, "tool.poetry", "name"));
            }
            _ => {
                // pnpm-workspace.yaml adds member globs to the npm package beside it.
                let globs: Vec<String> = yaml_list(&text, "packages").into_iter().map(|glob| join_dir(dir, &glob)).collect();
                if let Some(existing) = sources.manifests.iter_mut().find(|m| m.dir == *dir && m.kind == "npm") {
                    existing.workspace.extend(globs);
                } else {
                    sources.manifests.push(Manifest { dir: (*dir).to_owned(), kind: "npm", name: None, workspace: globs });
                }
                continue;
            }
        }
        sources.manifests.push(manifest);
    }

    // A package.json's scripts are listed for the manifests that name an area.
    let globs: Vec<String> = sources.manifests.iter().flat_map(|m| m.workspace.iter().cloned()).collect();
    let is_area = |dir: &str| depth(dir) <= 2 || matches_any(&globs, dir);
    for (file, list) in scripts {
        let dir = file.rsplit_once('/').map_or("", |(dir, _)| dir);
        if !is_area(dir) {
            continue;
        }
        for (name, body) in list.into_iter().take(SCRIPTS_PER_MANIFEST) {
            sources.commands.push(ProjectMapCommand {
                repo: String::new(),
                source: file.clone(),
                name,
                run: clip(&body, SCRIPT_BODY_BYTES),
            });
        }
    }

    // Cargo aliases.
    for file in [".cargo/config.toml", ".cargo/config"] {
        if !tracked.contains(file) {
            continue;
        }
        if let Some(text) = read(file) {
            for (section, key, value) in toml_entries(&text) {
                if section == "alias" {
                    let parts = toml_strings(&value);
                    if !parts.is_empty() {
                        sources.commands.push(ProjectMapCommand {
                            repo: String::new(),
                            source: file.to_owned(),
                            name: key,
                            run: clip(&format!("cargo {}", parts.join(" ")), SCRIPT_BODY_BYTES),
                        });
                    }
                }
            }
            break;
        }
    }

    // Make and just targets, from the repository root.
    for file in ["Makefile", "makefile", "GNUmakefile"] {
        if tracked.contains(file)
            && let Some(text) = read(file)
        {
            for target in make_targets(&text).into_iter().take(MAKE_TARGETS_MAX) {
                sources.commands.push(ProjectMapCommand {
                    repo: String::new(),
                    source: file.to_owned(),
                    run: format!("make {target}"),
                    name: target,
                });
            }
            break;
        }
    }
    for file in ["justfile", "Justfile", ".justfile"] {
        if tracked.contains(file)
            && let Some(text) = read(file)
        {
            for recipe in just_recipes(&text).into_iter().take(MAKE_TARGETS_MAX) {
                sources.commands.push(ProjectMapCommand {
                    repo: String::new(),
                    source: file.to_owned(),
                    run: format!("just {recipe}"),
                    name: recipe,
                });
            }
            break;
        }
    }

    // Fenced shell blocks under a Build or Test heading, copied as written.
    for file in ["AGENTS.md", "README.md"] {
        if tracked.contains(file)
            && let Some(text) = read(file)
        {
            for (heading, block) in fenced_commands(&text).into_iter().take(FENCES_PER_FILE) {
                sources.commands.push(ProjectMapCommand { repo: String::new(), source: file.to_owned(), name: heading, run: block });
            }
        }
    }
    sources
}

/// `(section, key, raw value)` of every `key = value` line of a TOML file. Values that open
/// an array carry on until it closes. This reads the few fields the map needs, not TOML.
fn toml_entries(text: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let mut section = String::new();
    let mut lines = text.lines();
    while let Some(raw) = lines.next() {
        let line = strip_comment(raw).trim().to_owned();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') {
            section = line.trim_matches(|c| c == '[' || c == ']').trim().to_owned();
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim().trim_matches(|c| c == '"' || c == '\'').to_owned();
        let mut value = value.trim().to_owned();
        let mut balance = bracket_balance(&value);
        while balance > 0 {
            let Some(next) = lines.next() else { break };
            let next = strip_comment(next).trim().to_owned();
            balance += bracket_balance(&next);
            value.push(' ');
            value.push_str(&next);
        }
        out.push((section.clone(), key, value));
    }
    out
}

/// `[` minus `]` outside quotes.
fn bracket_balance(text: &str) -> i32 {
    let mut quote = None;
    let mut balance = 0;
    for c in text.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '[') => balance += 1,
            (None, ']') => balance -= 1,
            _ => {}
        }
    }
    balance
}

/// `line` without a trailing `# comment` that sits outside quotes.
fn strip_comment(line: &str) -> &str {
    let mut quote = None;
    for (index, c) in line.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '#') => return &line[..index],
            _ => {}
        }
    }
    line
}

/// Every quoted string in a raw TOML value.
fn toml_strings(value: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = value.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '"' && c != '\'' {
            continue;
        }
        let mut text = String::new();
        while let Some(next) = chars.next() {
            if next == c {
                break;
            }
            if next == '\\' && c == '"' {
                if let Some(escaped) = chars.next() {
                    text.push(escaped);
                }
                continue;
            }
            text.push(next);
        }
        out.push(text);
    }
    out
}

fn toml_first(entries: &[(String, String, String)], section: &str, key: &str) -> Option<String> {
    toml_all(entries, section, key).into_iter().next().filter(|value| !value.is_empty())
}

fn toml_all(entries: &[(String, String, String)], section: &str, key: &str) -> Vec<String> {
    entries.iter().filter(|(s, k, _)| s == section && k == key).flat_map(|(_, _, value)| toml_strings(value)).collect()
}

/// Items of a top-level YAML list under `key:` (`- 'apps/*'`).
fn yaml_list(text: &str, key: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if !line.starts_with([' ', '\t', '-']) {
            inside = trimmed.strip_suffix(':').is_some_and(|name| name == key) || trimmed == format!("{key}:");
            continue;
        }
        if inside && let Some(item) = trimmed.strip_prefix('-') {
            let item = strip_comment(item).trim().trim_matches(|c| c == '"' || c == '\'');
            if !item.is_empty() {
                out.push(item.to_owned());
            }
        }
    }
    out
}

/// Whether `dir` matches one of the workspace globs (`*` is one path segment, `**` any number).
fn matches_any(globs: &[String], dir: &str) -> bool {
    let mut positive = false;
    for glob in globs {
        if let Some(negated) = glob.strip_prefix('!') {
            if glob_match(negated, dir) {
                return false;
            }
        } else if glob_match(glob, dir) {
            positive = true;
        }
    }
    positive
}

fn glob_match(glob: &str, dir: &str) -> bool {
    fn segments(pattern: &[&str], parts: &[&str]) -> bool {
        match pattern.split_first() {
            None => parts.is_empty(),
            Some((&"**", rest)) => (0..=parts.len()).any(|skip| segments(rest, &parts[skip..])),
            Some((first, rest)) => parts.split_first().is_some_and(|(part, tail)| wildcard(first, part) && segments(rest, tail)),
        }
    }
    let pattern: Vec<&str> = glob.trim_matches('/').split('/').filter(|part| !part.is_empty() && *part != ".").collect();
    let parts: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    segments(&pattern, &parts)
}

/// `*` inside one path segment.
fn wildcard(pattern: &str, text: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == text,
        Some((prefix, rest)) => {
            let Some(after) = text.strip_prefix(prefix) else { return false };
            (0..=after.len()).filter(|i| after.is_char_boundary(*i)).any(|i| wildcard(rest, &after[i..]))
        }
    }
}

/// Targets of a Makefile: `name:` at the start of a line, no assignments or special targets.
fn make_targets(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.starts_with([' ', '\t', '#', '.']) {
            continue;
        }
        let Some((names, rest)) = line.split_once(':') else { continue };
        if rest.starts_with('=') || names.contains(['=', '$', '%', '(']) {
            continue;
        }
        for name in names.split_whitespace() {
            if !out.iter().any(|seen| seen == name) {
                out.push(name.to_owned());
            }
        }
    }
    out
}

/// Recipe names of a justfile: a line at column 0 that ends the signature with `:`.
fn just_recipes(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.starts_with([' ', '\t', '#']) || line.trim().is_empty() {
            continue;
        }
        let head = line.split(':').next().unwrap_or_default();
        if line.contains(":=")
            || line.starts_with("set ")
            || line.starts_with("import ")
            || line.starts_with("alias ")
            || !line.contains(':')
        {
            continue;
        }
        let name = head.trim_start_matches('@').split_whitespace().next().unwrap_or_default();
        if !name.is_empty() && !out.iter().any(|seen| seen == name) {
            out.push(name.to_owned());
        }
    }
    out
}

/// `(heading, block)` for each fenced shell block under a heading that mentions Build or Test.
/// The heading is copied as written; the block is cut to a bounded size on a line boundary.
fn fenced_commands(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut headings: Vec<(usize, String)> = Vec::new();
    let mut fence: Option<(bool, Vec<&str>)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some((shell, lines)) = fence.as_mut() {
            if trimmed.starts_with("```") {
                let (shell, lines) = (*shell, std::mem::take(lines));
                fence = None;
                let heading = headings.iter().rev().find(|(_, text)| {
                    let lower = text.to_lowercase();
                    lower.contains("build") || lower.contains("test")
                });
                if let (true, Some((_, heading))) = (shell, heading) {
                    let mut block = String::new();
                    for line in lines {
                        if block.len() + line.len() + 1 > FENCE_MAX_BYTES {
                            block.push('…');
                            break;
                        }
                        block.push_str(line.trim_end());
                        block.push('\n');
                    }
                    let block = block.trim_end().to_owned();
                    if !block.is_empty() {
                        out.push((heading.clone(), block));
                    }
                }
            } else {
                lines.push(line);
            }
            continue;
        }
        if let Some(info) = trimmed.strip_prefix("```") {
            let lang = info.split_whitespace().next().unwrap_or_default().to_lowercase();
            fence = Some((matches!(lang.as_str(), "sh" | "bash" | "shell" | "zsh"), Vec::new()));
        } else if line.starts_with('#') {
            let level = line.chars().take_while(|c| *c == '#').count();
            if let Some(title) = line[level..].strip_prefix(' ') {
                headings.retain(|(l, _)| *l < level);
                headings.push((level, title.trim().to_owned()));
            }
        }
    }
    out
}

// ---- layout ----

fn manifest_label(kind: &str) -> Option<String> {
    (!kind.is_empty()).then(|| kind.to_owned())
}

/// The top two directory levels with tracked-file counts, named from manifests. A manifest
/// deeper than that is listed too when a workspace declares it.
fn layout_areas(repo: &str, files: &[String], manifests: &[Manifest]) -> Vec<ProjectMapArea> {
    let mut counts: BTreeMap<String, u32> = BTreeMap::new();
    let mut root_files = 0u32;
    for file in files {
        let mut parts = file.splitn(3, '/');
        let (first, second, third) = (parts.next().unwrap_or_default(), parts.next(), parts.next());
        match (second, third) {
            (None, _) => root_files += 1,
            (Some(_), None) => *counts.entry(first.to_owned()).or_default() += 1,
            (Some(second), Some(_)) => {
                *counts.entry(first.to_owned()).or_default() += 1;
                *counts.entry(format!("{first}/{second}")).or_default() += 1;
            }
        }
    }
    let globs: Vec<String> = manifests.iter().flat_map(|m| m.workspace.iter().cloned()).collect();
    for manifest in manifests.iter().filter(|m| depth(&m.dir) > 2 && m.name.is_some() && matches_any(&globs, &m.dir)) {
        let prefix = format!("{}/", manifest.dir);
        counts.insert(manifest.dir.clone(), files.iter().filter(|f| f.starts_with(&prefix)).count() as u32);
    }
    let by_dir: HashMap<&str, &Manifest> = manifests.iter().filter(|m| m.name.is_some()).map(|m| (m.dir.as_str(), m)).collect();
    let area = |path: &str, files: u32| {
        let manifest = by_dir.get(if path == "." { "" } else { path });
        ProjectMapArea {
            repo: repo.to_owned(),
            path: path.to_owned(),
            files,
            name: manifest.and_then(|m| m.name.clone()),
            manifest: manifest.and_then(|m| manifest_label(m.kind)),
        }
    };
    let mut out = Vec::new();
    if by_dir.contains_key("") {
        out.push(area(".", root_files));
    }
    if counts.len() > LAYOUT_MAX_AREAS {
        // Keep every top-level directory, then the busiest of the rest.
        let mut deep: Vec<(String, u32)> = counts.iter().filter(|(path, _)| path.contains('/')).map(|(p, n)| (p.clone(), *n)).collect();
        deep.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        let top = counts.keys().filter(|path| !path.contains('/')).count();
        let keep: BTreeSet<String> = deep.into_iter().take(LAYOUT_MAX_AREAS.saturating_sub(top)).map(|(path, _)| path).collect();
        counts.retain(|path, _| !path.contains('/') || keep.contains(path));
    }
    out.extend(counts.into_iter().map(|(path, files)| area(&path, files)));
    out
}

// ---- header ----

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

/// The text sessions receive: at most [`HEADER_MAX_BYTES`], starting `Map as of {repo}@{sha}`.
/// Sections shrink from their tails until it fits.
fn render_header(map: &ProjectMap) -> String {
    let multi = map.repos.len() > 1;
    let tag = |repo: &str| -> String {
        let name = map.repos.iter().find(|r| r.path == repo).map_or(repo, |r| r.name.as_str());
        if multi { format!("{name}: ") } else { String::new() }
    };
    let stamp: Vec<String> = map.repos.iter().map(|r| format!("{}@{}", r.name, short(&r.head))).collect();
    let lead = format!(
        "Map as of {} ({}). Built by Kybern from git and manifests, not summarized: use it to find your way, then check the code before you rely on it. Ask for more with kybern_project_map.",
        stamp.join(", "),
        map.built_at.format("%Y-%m-%d")
    );

    let mut repos = vec!["Repos:".to_owned()];
    for repo in &map.repos {
        let branch = repo.branch.as_deref().map_or("detached HEAD".to_owned(), |b| format!("on {b}"));
        let default = repo.default_branch.as_deref().map_or(String::new(), |d| format!(", default {d}"));
        let more = if repo.truncated { "+" } else { "" };
        repos.push(format!("  {} ({}) {branch}{default}, {}{more} files", repo.name, repo.path, repo.files));
    }

    let mut layout = vec!["Layout (tracked files):".to_owned()];
    for area in &map.layout {
        let depth = area.path.matches('/').count();
        // Second-level directories only where a manifest names them.
        if depth > 0 && area.name.is_none() {
            continue;
        }
        let name = match (&area.name, &area.manifest) {
            (Some(name), Some(kind)) => format!(" · {name} ({kind})"),
            (Some(name), None) => format!(" · {name}"),
            _ => String::new(),
        };
        let path = if area.path == "." { "./".to_owned() } else { format!("{}/", area.path) };
        layout.push(format!("  {}{path} {}{name}", tag(&area.repo), area.files));
    }

    let mut commands = vec!["Commands (as documented):".to_owned()];
    let mut grouped: Vec<(String, String, Vec<&ProjectMapCommand>)> = Vec::new();
    for command in &map.commands {
        let fenced = command.source.ends_with(".md");
        let key = if fenced { format!("{} \"{}\"", command.source, command.name) } else { command.source.clone() };
        match grouped.iter_mut().find(|(repo, k, _)| *repo == command.repo && *k == key) {
            Some((_, _, list)) => list.push(command),
            None => grouped.push((command.repo.clone(), key, vec![command])),
        }
    }
    for (repo, key, list) in grouped {
        let body = if list[0].source.ends_with(".md") {
            let lines =
                list[0].run.lines().map(|line| line.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|line| !line.is_empty());
            lines.take(3).map(|line| clip(&line, 100)).collect::<Vec<_>>().join(" ; ")
        } else {
            list.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")
        };
        commands.push(format!("  {}{key}: {}", tag(&repo), clip(&body, 220)));
    }

    let mut busy = vec![format!("Busy areas (commits, last {BUSY_DAYS} days):")];
    for repo in &map.repos {
        let items: Vec<String> = map.busy.iter().filter(|b| b.repo == repo.path).map(|b| format!("{} {}", b.path, b.commits)).collect();
        if !items.is_empty() {
            busy.push(format!("  {}{}", tag(&repo.path), items.join(" · ")));
        }
    }

    // One line per commit: a bulk deletion would otherwise repeat its subject fifteen times.
    let mut removed = vec![format!("Removed and renamed (last {REMOVED_DAYS} days):")];
    let mut by_commit: Vec<Vec<&ProjectMapChange>> = Vec::new();
    for change in &map.removed {
        match by_commit.last_mut() {
            Some(group) if group[0].repo == change.repo && group[0].commit == change.commit => group.push(change),
            _ => by_commit.push(vec![change]),
        }
    }
    for group in by_commit {
        let deleted: Vec<&str> = group.iter().filter(|c| c.kind == ProjectMapChangeKind::Deleted).map(|c| c.path.as_str()).collect();
        let renamed: Vec<String> = group
            .iter()
            .filter(|c| c.kind == ProjectMapChangeKind::Renamed)
            .map(|c| format!("{} → {}", c.from.as_deref().unwrap_or("?"), c.path))
            .collect();
        let mut what = Vec::new();
        if !deleted.is_empty() {
            what.push(clip(&format!("deleted {}", deleted.join(", ")), 300));
        }
        if !renamed.is_empty() {
            what.push(clip(&format!("renamed {}", renamed.join(", ")), 300));
        }
        let first = group[0];
        let date = first.date.get(..10).unwrap_or(&first.date);
        removed.push(format!("  {}{} {date} {}: {}", tag(&first.repo), first.commit, clip(&first.subject, 60), what.join("; ")));
    }

    // Sections with only a heading say nothing.
    let mut sections: Vec<Vec<String>> = [repos, layout, commands, busy, removed].into_iter().filter(|s| s.len() > 1).collect();
    let size = |sections: &[Vec<String>]| lead.len() + sections.iter().map(|s| s.iter().map(|l| l.len() + 1).sum::<usize>()).sum::<usize>();
    // Trim the longest section's tail until the header fits. Repos stays whole.
    while size(&sections) + 1 > HEADER_MAX_BYTES {
        let Some(longest) = sections.iter().enumerate().skip(1).filter(|(_, s)| s.len() > 2).max_by_key(|(_, s)| s.len()).map(|(i, _)| i)
        else {
            break;
        };
        sections[longest].pop();
    }
    let mut header = lead;
    for section in sections {
        header.push('\n');
        header.push_str(&section.join("\n"));
    }
    if truncate_utf8(&mut header, HEADER_MAX_BYTES - 4) {
        header.push_str("\n…");
    }
    header
}

// ---- cache ----

pub(crate) fn cache_file(cache_root: &Path, project_id: ProjectId) -> PathBuf {
    cache_root.join(format!("{project_id}.json"))
}

pub(crate) fn read_cache(cache_root: &Path, project_id: ProjectId) -> Option<ProjectMap> {
    serde_json::from_slice(&std::fs::read(cache_file(cache_root, project_id)).ok()?).ok()
}

fn write_cache(cache_root: &Path, project_id: ProjectId, map: &ProjectMap) -> Result<()> {
    std::fs::create_dir_all(cache_root).context("create the project map cache folder")?;
    let target = cache_file(cache_root, project_id);
    let temp = cache_root.join(format!("{project_id}.json.{}", uuid::Uuid::new_v4().simple()));
    std::fs::write(&temp, serde_json::to_vec(map)?)?;
    std::fs::rename(&temp, &target).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })?;
    Ok(())
}

/// Whether `map` describes exactly these HEADs, repository by repository.
fn describes(map: &ProjectMap, heads: &[(String, String)]) -> bool {
    map.repos.len() == heads.len() && map.repos.iter().zip(heads).all(|(repo, (path, head))| repo.path == *path && repo.head == *head)
}

/// Builds run one at a time: two requests that see the same new HEAD share one build.
static BUILD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The map of `project` for the repositories' HEADs as they are now: the cached
/// one when it describes them, else a fresh build that replaces the cache.
pub(crate) async fn current(cache_root: &Path, project: &Project) -> Result<ProjectMap> {
    let specs = repo_specs(project);
    ensure!(!specs.is_empty(), "This project is not a git repository, so it has no map.");
    let heads = current_heads(&specs).await;
    ensure!(!heads.is_empty(), "This project has no commits yet, so it has no map.");
    if let Some(map) = read_cache(cache_root, project.id).filter(|map| describes(map, &heads)) {
        return Ok(map);
    }
    let _building = BUILD_LOCK.lock().await;
    if let Some(map) = read_cache(cache_root, project.id).filter(|map| describes(map, &heads)) {
        return Ok(map);
    }
    let map = build(project).await?;
    if let Err(error) = write_cache(cache_root, project.id, &map) {
        tracing::warn!(project_id = %project.id, %error, "could not cache the project map");
    }
    Ok(map)
}

// ---- tool ----

/// What `kybern_project_map` returns for `args`.
pub(crate) async fn tool_result(cache_root: &Path, project: &Project, args: ToolArgs) -> Result<Value> {
    let map = current(cache_root, project).await?;
    if let Some(path) = args.path.as_deref().map(str::trim).filter(|path| !path.is_empty()) {
        return path_query(project, &map, path).await;
    }
    let repos: Vec<Value> = map
        .repos
        .iter()
        .map(|r| json!({ "path": r.path, "name": r.name, "head": r.head, "branch": r.branch, "default_branch": r.default_branch }))
        .collect();
    Ok(match args.section {
        None => json!({
            "built_at": map.built_at, "repos": repos, "header": map.header,
            "more": "section: layout, commands, busy or removed for one in full; path for a directory's entries and recent commits.",
        }),
        Some(Section::Layout) => json!({ "built_at": map.built_at, "repos": repos, "layout": map.layout }),
        Some(Section::Commands) => json!({ "built_at": map.built_at, "repos": repos, "commands": map.commands }),
        Some(Section::Busy) => json!({ "built_at": map.built_at, "repos": repos, "busy": map.busy, "days": BUSY_DAYS }),
        Some(Section::Removed) => json!({ "built_at": map.built_at, "repos": repos, "removed": map.removed, "days": REMOVED_DAYS }),
    })
}

/// A path inside the project folder: relative, forward slashes, no `..`, no option-like names.
fn clean_path(path: &str) -> Result<String> {
    let path = path.trim().trim_start_matches("./").trim_end_matches('/');
    ensure!(
        !path.contains('\0')
            && !path.starts_with('-')
            && !path.starts_with('/')
            && !path.contains('\\')
            && path.split('/').all(|part| part != ".." && part != "."),
        "path must be relative to the project folder and stay inside it (got {path:?})."
    );
    Ok(path.to_owned())
}

/// The repository a project-relative path belongs to, and the path inside it.
fn locate<'a>(specs: &'a [RepoSpec], path: &str) -> Option<(&'a RepoSpec, String)> {
    let mut best: Option<(&RepoSpec, String)> = None;
    for spec in specs {
        let rest = if spec.path == "." {
            Some(path.to_owned())
        } else if path == spec.path {
            Some(String::new())
        } else {
            path.strip_prefix(spec.path.as_str()).and_then(|rest| rest.strip_prefix('/')).map(str::to_owned)
        };
        if let Some(rest) = rest.filter(|rest| !is_nested(rest, &spec.nested) || spec.path != ".") {
            // The longest member path wins; the group folder itself is the fallback.
            if best.as_ref().is_none_or(|(b, _)| spec.path.len() > b.path.len()) {
                best = Some((spec, rest));
            }
        }
    }
    best
}

async fn path_query(project: &Project, map: &ProjectMap, path: &str) -> Result<Value> {
    let path = clean_path(path)?;
    let specs = repo_specs(project);
    let (spec, inner) = locate(&specs, &path).ok_or_else(|| {
        let names: Vec<&str> = specs.iter().map(|s| s.path.as_str()).collect();
        anyhow!("{path} is not inside a repository of this project. Start the path with one of: {}.", names.join(", "))
    })?;
    let repo = Repo::new(&spec.dir);
    let pathspec = if inner.is_empty() { ".".to_owned() } else { inner.clone() };
    let listing = run(&repo, &["--literal-pathspecs", "ls-files", "--cached", "-z", "--", &pathspec]).await.unwrap_or_default();
    let mut dirs: BTreeMap<String, u32> = BTreeMap::new();
    let mut entries: Vec<Value> = Vec::new();
    let prefix = if inner.is_empty() { String::new() } else { format!("{inner}/") };
    let mut total = 0usize;
    for file in listing.split('\0').filter(|file| !file.is_empty() && !is_nested(file, &spec.nested)) {
        total += 1;
        let Some(rest) = file.strip_prefix(prefix.as_str()) else {
            // The path names a file itself.
            if file == inner {
                entries.push(json!({ "name": file.rsplit('/').next().unwrap_or(file), "kind": "file" }));
            }
            continue;
        };
        match rest.split_once('/') {
            Some((dir, _)) => *dirs.entry(dir.to_owned()).or_default() += 1,
            None => entries.push(json!({ "name": rest, "kind": "file" })),
        }
    }
    ensure!(total > 0, "No tracked files under {path}. Check the path with kybern_list_files, or ask for the layout section.");
    let mut listed: Vec<Value> = dirs.into_iter().map(|(name, files)| json!({ "name": name, "kind": "dir", "files": files })).collect();
    listed.extend(entries);
    let truncated = listed.len() > PATH_ENTRIES_MAX;
    listed.truncate(PATH_ENTRIES_MAX);

    let count = format!("--max-count={PATH_COMMITS}");
    let log = run(&repo, &["--literal-pathspecs", "log", &count, "--no-merges", "--format=%h%x1f%an%x1f%aI%x1f%s", "--", &pathspec])
        .await
        .unwrap_or_default();
    let commits: Vec<Value> = log
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(4, '\x1f');
            Some(json!({ "commit": fields.next()?, "author": fields.next()?, "date": fields.next()?, "subject": fields.next()? }))
        })
        .collect();
    let head = map.repos.iter().find(|r| r.path == spec.path).map(|r| short(&r.head).to_owned());
    Ok(json!({
        "repo": spec.path, "path": inner, "as_of": head, "files": total,
        "entries": listed, "entries_truncated": truncated, "commits": commits,
    }))
}

/// The header text for a map, used by `Orchestrator::map_header`.
pub(crate) fn header_of(map: &ProjectMap) -> Option<String> {
    (!map.header.is_empty()).then(|| map.header.clone())
}

pub(crate) fn tool_args(arguments: Value) -> Result<ToolArgs> {
    serde_json::from_value(arguments).map_err(|error| {
        anyhow!("Invalid arguments for kybern_project_map: {error}. Pass section (layout, commands, busy or removed), path, or nothing.")
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    pub(crate) fn git(dir: &Path, args: &[&str]) -> String {
        git_at(dir, args, None)
    }

    /// Run git in `dir`; `days_ago` backdates the commit it makes.
    pub(crate) fn git_at(dir: &Path, args: &[&str], days_ago: Option<u32>) -> String {
        let mut cmd = std::process::Command::new("git");
        cmd.arg("-C").arg(dir).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1");
        if let Some(days) = days_ago {
            let date = (chrono::Utc::now() - chrono::Duration::days(days.into())).to_rfc3339();
            cmd.env("GIT_AUTHOR_DATE", &date).env("GIT_COMMITTER_DATE", &date);
        }
        let out = cmd.output().unwrap();
        assert!(out.status.success(), "git {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    pub(crate) fn new_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("kybern-map-test-{label}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    pub(crate) fn init(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        git(dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(dir, &["config", "user.name", "Map Test"]);
        git(dir, &["config", "user.email", "map@example.com"]);
    }

    pub(crate) fn write(dir: &Path, rel: &str, text: &str) {
        let path = dir.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    pub(crate) fn commit(dir: &Path, message: &str, days_ago: u32) {
        git(dir, &["add", "-A"]);
        git_at(dir, &["commit", "-q", "-m", message], Some(days_ago));
    }

    pub(crate) fn project(path: &Path, members: &[&str]) -> Project {
        let now = chrono::Utc::now();
        let group = !members.is_empty();
        let members: Vec<Value> =
            members.iter().map(|m| json!({ "path": m, "name": m.rsplit('/').next().unwrap(), "status": "ok" })).collect();
        serde_json::from_value(json!({
            "id": uuid::Uuid::now_v7(), "name": "fixture", "path": path, "is_git": !group,
            "kind": if group { "group" } else { "single" }, "members": members,
            "created_at": now, "updated_at": now,
        }))
        .unwrap()
    }

    /// A workspace repository: Cargo and pnpm packages, docs with build blocks, a Makefile.
    fn workspace_repo() -> PathBuf {
        let dir = new_dir("workspace");
        init(&dir);
        write(&dir, "Cargo.toml", "[workspace]\nresolver = \"2\"\nmembers = [\n  \"crates/*\", # all crates\n  \"tools/xtask\",\n]\n");
        write(&dir, "crates/alpha/Cargo.toml", "[package]\nname = \"alpha-core\"\nversion = \"0.1.0\"\n");
        write(&dir, "crates/alpha/src/lib.rs", "pub fn a() {}\n");
        write(&dir, "crates/alpha/src/util.rs", "pub fn b() {}\n");
        write(&dir, "crates/beta/Cargo.toml", "[package]\nname = \"beta\"\n");
        write(&dir, "crates/beta/src/main.rs", "fn main() {}\n");
        write(&dir, "tools/xtask/Cargo.toml", "[package]\nname = \"xtask\"\n");
        write(&dir, "tools/xtask/src/main.rs", "fn main() {}\n");
        write(&dir, ".cargo/config.toml", "[alias]\nxt = \"run -p xtask --\"\nci = [\"fmt\", \"--check\"]\n");
        write(
            &dir,
            "package.json",
            r#"{"name":"root-app","private":true,"workspaces":["apps/*","packages/**"],"scripts":{"lint":"eslint ."}}"#,
        );
        write(&dir, "pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n  - \"packages/**\"\n  - '!packages/ignored'\n");
        write(&dir, "apps/web/package.json", r#"{"name":"@acme/web","scripts":{"dev":"vite","build":"vite build"}}"#);
        write(&dir, "apps/web/src/index.ts", "export {}\n");
        write(&dir, "packages/ui/kit/package.json", r#"{"name":"@acme/ui-kit","scripts":{"test":"vitest"}}"#);
        write(&dir, "packages/ui/kit/index.ts", "export {}\n");
        write(&dir, "packages/ignored/package.json", r#"{"name":"@acme/ignored"}"#);
        write(&dir, "go/svc/go.mod", "module example.com/acme/svc\n\ngo 1.22\n");
        write(&dir, "py/tool/pyproject.toml", "[project]\nname = \"acme-tool\"\n");
        write(&dir, "node_modules/left-pad/index.js", "module.exports = 1\n");
        write(&dir, "Makefile", "CC := cc\n.PHONY: build test\nbuild:\n\tcc x.c\ntest: build\n\t./a.out\n%.o: %.c\n\tcc -c $<\n");
        write(
            &dir,
            "justfile",
            "set shell := [\"sh\", \"-c\"]\nversion := \"1\"\n\n# build it\nrelease flag='':\n  cargo build\n@fmt:\n  cargo fmt\n",
        );
        write(
            &dir,
            "AGENTS.md",
            "# Project\n\n## Build and run\n\n```sh\ncargo build -p alpha-core\n./target/debug/beta\n```\n\n### Details\n\n```bash\nmake build\n```\n\n## Release\n\n```sh\nrm -rf everything\n```\n\n## Tests and checks\n\n```text\nnot shell\n```\n\n```sh\ncargo test --workspace\n```\n",
        );
        write(&dir, "README.md", "# Readme\n\n## Install\n\n```sh\nbrew install thing\n```\n\n## Test\n\n```sh\nmake test\n```\n");
        write(&dir, ".gitignore", "node_modules\n");
        git(&dir, &["add", "-A", "-f", "node_modules"]);
        commit(&dir, "initial", 60);
        dir
    }

    #[tokio::test]
    async fn layout_names_areas_from_cargo_and_pnpm_workspaces() {
        let dir = workspace_repo();
        let map = build(&project(&dir, &[])).await.unwrap();
        let area = |path: &str| map.layout.iter().find(|a| a.path == path).unwrap_or_else(|| panic!("no area {path}: {:#?}", map.layout));
        assert_eq!((area("crates").files, area("crates").name.clone()), (5, None));
        let alpha = area("crates/alpha");
        assert_eq!((alpha.files, alpha.name.as_deref(), alpha.manifest.as_deref()), (3, Some("alpha-core"), Some("cargo")));
        assert_eq!(area("tools/xtask").name.as_deref(), Some("xtask"));
        assert_eq!(area("apps/web").name.as_deref(), Some("@acme/web"));
        assert_eq!(area("apps/web").manifest.as_deref(), Some("npm"));
        assert_eq!(area("go/svc").name.as_deref(), Some("example.com/acme/svc"));
        assert_eq!(area("go/svc").manifest.as_deref(), Some("go"));
        assert_eq!(area("py/tool").name.as_deref(), Some("acme-tool"));
        assert_eq!(area(".").name.as_deref(), Some("root-app"), "the root manifest names the root");
        // Deeper than two levels: listed because the workspace declares `packages/**`.
        assert_eq!(area("packages/ui/kit").name.as_deref(), Some("@acme/ui-kit"));
        // Skipped folders never appear, and the root keeps only its own files in its count.
        assert!(!map.layout.iter().any(|a| a.path.starts_with("node_modules")), "{:#?}", map.layout);
        assert_eq!(map.repos.len(), 1);
        assert_eq!(
            (map.repos[0].path.as_str(), map.repos[0].default_branch.as_deref(), map.repos[0].branch.as_deref()),
            (".", Some("main"), Some("main"))
        );
        assert_eq!(map.repos[0].head, git(&dir, &["rev-parse", "HEAD"]));
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn commands_come_from_manifests_and_fenced_blocks_under_build_or_test_headings() {
        let dir = workspace_repo();
        let map = build(&project(&dir, &[])).await.unwrap();
        let find = |source: &str, name: &str| {
            map.commands
                .iter()
                .find(|c| c.source == source && c.name == name)
                .unwrap_or_else(|| panic!("no {source} {name}: {:#?}", map.commands))
                .run
                .clone()
        };
        assert_eq!(find("package.json", "lint"), "eslint .");
        assert_eq!(find("apps/web/package.json", "build"), "vite build");
        assert_eq!(find("packages/ui/kit/package.json", "test"), "vitest");
        assert_eq!(find(".cargo/config.toml", "xt"), "cargo run -p xtask --");
        assert_eq!(find(".cargo/config.toml", "ci"), "cargo fmt --check");
        assert_eq!(find("Makefile", "build"), "make build");
        assert_eq!(find("Makefile", "test"), "make test");
        assert_eq!(find("justfile", "release"), "just release");
        assert_eq!(find("justfile", "fmt"), "just fmt");
        // Headings are copied verbatim; a sub-heading under "Build and run" still counts as under it.
        assert_eq!(find("AGENTS.md", "Build and run"), "cargo build -p alpha-core\n./target/debug/beta");
        assert!(map.commands.iter().any(|c| c.source == "AGENTS.md" && c.name == "Build and run" && c.run == "make build"));
        assert_eq!(find("AGENTS.md", "Tests and checks"), "cargo test --workspace");
        assert_eq!(find("README.md", "Test"), "make test");
        // Nothing is inferred: other headings, non-shell blocks, assignments and pattern rules are left out.
        for (source, name) in
            [("AGENTS.md", "Release"), ("README.md", "Install"), ("Makefile", "CC"), ("Makefile", "%.o"), ("Makefile", ".PHONY")]
        {
            assert!(!map.commands.iter().any(|c| c.source == source && c.name == name), "{source} {name}");
        }
        assert!(!map.commands.iter().any(|c| c.run.contains("not shell") || c.run.contains("brew install")));
        assert!(!map.commands.iter().any(|c| c.source == "packages/ignored/package.json"));
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn busy_areas_count_commits_per_directory_in_the_last_30_days() {
        let dir = new_dir("busy");
        init(&dir);
        write(&dir, "old/a.txt", "1");
        write(&dir, "root.txt", "1");
        commit(&dir, "ancient", 45);
        for i in 0..3 {
            write(&dir, "src/core/a.rs", &format!("{i}"));
            commit(&dir, &format!("core {i}"), 5 - i);
        }
        write(&dir, "src/core/a.rs", "x");
        write(&dir, "src/ui/b.rs", "x");
        write(&dir, "docs/readme.md", "x");
        write(&dir, "root.txt", "2");
        commit(&dir, "mixed", 1);
        write(&dir, "old/a.txt", "2");
        commit(&dir, "old again", 0);
        let map = build(&project(&dir, &[])).await.unwrap();
        let busy: Vec<(&str, u32)> = map.busy.iter().map(|b| (b.path.as_str(), b.commits)).collect();
        assert_eq!(busy, vec![("src/core", 4), ("docs", 1), ("old", 1), ("src/ui", 1)], "{busy:?}");
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn removed_and_renamed_list_the_last_14_days_newest_first() {
        let dir = new_dir("removed");
        init(&dir);
        write(
            &dir,
            "src/auth/prelaunch.ts",
            "export const gate = 1;\n// padding so the rename is detected as a rename\nexport const more = 2;\n",
        );
        write(&dir, "src/old_name.ts", "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n");
        write(&dir, "src/stale.ts", "stale\nstale\nstale\n");
        write(&dir, "keep.ts", "keep\n");
        commit(&dir, "initial", 60);
        fs::remove_file(dir.join("src/stale.ts")).unwrap();
        commit(&dir, "Remove stale file", 40);
        fs::remove_file(dir.join("src/auth/prelaunch.ts")).unwrap();
        commit(&dir, "Remove pre-launch fallback", 3);
        git(&dir, &["mv", "src/old_name.ts", "src/new_name.ts"]);
        commit(&dir, "Rename old_name", 1);
        let map = build(&project(&dir, &[])).await.unwrap();
        assert_eq!(map.removed.len(), 2, "{:#?}", map.removed);
        let [renamed, deleted] = [&map.removed[0], &map.removed[1]];
        assert_eq!(
            (renamed.kind, renamed.path.as_str(), renamed.from.as_deref()),
            (ProjectMapChangeKind::Renamed, "src/new_name.ts", Some("src/old_name.ts"))
        );
        assert_eq!(
            (deleted.kind, deleted.path.as_str(), deleted.from.as_deref()),
            (ProjectMapChangeKind::Deleted, "src/auth/prelaunch.ts", None)
        );
        assert_eq!(deleted.subject, "Remove pre-launch fallback");
        assert_eq!(deleted.commit, git(&dir, &["rev-parse", "--short", "HEAD~1"]));
        assert!(
            deleted.date.starts_with(&(chrono::Utc::now() - chrono::Duration::days(3)).format("%Y-%m-%d").to_string()),
            "{}",
            deleted.date
        );
        assert!(map.header.contains("deleted src/auth/prelaunch.ts") && map.header.contains("renamed src/old_name.ts → src/new_name.ts"));
        assert!(!map.header.contains("stale.ts"), "outside the 14 day window");
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn the_cache_is_reused_until_head_moves() {
        let dir = new_dir("cache");
        let cache = new_dir("cache-root");
        init(&dir);
        write(&dir, "a.txt", "1");
        commit(&dir, "one", 0);
        let project = project(&dir, &[]);
        let first = current(&cache, &project).await.unwrap();
        assert!(cache_file(&cache, project.id).is_file());
        let again = current(&cache, &project).await.unwrap();
        assert_eq!(again.built_at, first.built_at, "same HEAD: served from the cache");
        // An uncommitted change does not move HEAD.
        write(&dir, "b.txt", "2");
        assert_eq!(current(&cache, &project).await.unwrap().built_at, first.built_at);
        commit(&dir, "two", 0);
        let rebuilt = current(&cache, &project).await.unwrap();
        assert_ne!(rebuilt.built_at, first.built_at, "new HEAD: rebuilt");
        assert_eq!(rebuilt.repos[0].head, git(&dir, &["rev-parse", "HEAD"]));
        assert_eq!(rebuilt.repos[0].files, 2);
        assert_eq!(read_cache(&cache, project.id).unwrap().built_at, rebuilt.built_at);
        // A corrupt cache is rebuilt, not trusted.
        fs::write(cache_file(&cache, project.id), "{ not json").unwrap();
        assert_eq!(current(&cache, &project).await.unwrap().repos[0].head, rebuilt.repos[0].head);
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn a_group_project_maps_every_repository() {
        let group = new_dir("group");
        let (api, web) = (group.join("api"), group.join("web"));
        init(&api);
        write(&api, "Cargo.toml", "[package]\nname = \"api-server\"\n");
        write(&api, "src/main.rs", "fn main() {}\n");
        write(&api, "README.md", "# API\n\n## Build\n\n```sh\ncargo build\n```\n");
        commit(&api, "api init", 0);
        init(&web);
        write(&web, "package.json", r#"{"name":"web-app","scripts":{"dev":"vite"}}"#);
        write(&web, "src/App.tsx", "export {}\n");
        commit(&web, "web init", 0);
        git(&web, &["rm", "-q", "src/App.tsx"]);
        commit(&web, "Drop App", 0);
        let cache = new_dir("group-cache");
        let project = project(&group, &["api", "web"]);
        let map = current(&cache, &project).await.unwrap();
        assert_eq!(map.repos.iter().map(|r| (r.path.as_str(), r.name.as_str())).collect::<Vec<_>>(), vec![("api", "api"), ("web", "web")]);
        assert!(map.layout.iter().any(|a| a.repo == "api" && a.path == "." && a.name.as_deref() == Some("api-server")));
        assert!(map.layout.iter().any(|a| a.repo == "web" && a.path == "." && a.name.as_deref() == Some("web-app")));
        assert!(map.commands.iter().any(|c| c.repo == "api" && c.source == "README.md" && c.name == "Build" && c.run == "cargo build"));
        assert!(map.commands.iter().any(|c| c.repo == "web" && c.source == "package.json" && c.name == "dev"));
        assert!(map.removed.iter().any(|c| c.repo == "web" && c.path == "src/App.tsx"));
        assert!(map.busy.iter().any(|b| b.repo == "api" && b.path == "src"));
        let stamp = format!("Map as of api@{}, web@{}", &map.repos[0].head[..7], &map.repos[1].head[..7]);
        assert!(map.header.starts_with(&stamp), "{}", map.header);
        assert!(map.header.contains("api: ") && map.header.contains("web: "), "lines name their repository: {}", map.header);
        // A new commit in only one repository rebuilds the map.
        write(&api, "src/lib.rs", "pub fn x() {}\n");
        commit(&api, "more api", 0);
        let rebuilt = current(&cache, &project).await.unwrap();
        assert_ne!(rebuilt.repos[0].head, map.repos[0].head);
        assert_eq!(rebuilt.repos[1].head, map.repos[1].head);
        // A member that is not available is left out; the others still map.
        let mut partial = project.clone();
        partial.members[1].status = MemberStatus::Missing;
        assert_eq!(build(&partial).await.unwrap().repos.len(), 1);
        let _ = fs::remove_dir_all(group);
        let _ = fs::remove_dir_all(cache);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn tracked_symlinks_never_bring_outside_files_into_the_map() {
        let dir = new_dir("links");
        let outside = new_dir("outside");
        init(&dir);
        write(&outside, "README.md", "# Secret\n\n## Build\n\n```sh\ncat ~/.ssh/id_ed25519\n```\n");
        write(&outside, "pkg/package.json", r#"{"name":"outside-package","scripts":{"leak":"cat /etc/passwd"}}"#);
        std::os::unix::fs::symlink(outside.join("README.md"), dir.join("README.md")).unwrap();
        std::os::unix::fs::symlink(outside.join("pkg"), dir.join("pkg")).unwrap();
        write(&dir, "package.json", r#"{"name":"inside","scripts":{"test":"vitest"}}"#);
        write(&dir, "src/a.ts", "export {}\n");
        commit(&dir, "init", 1);

        let map = build(&project(&dir, &[])).await.unwrap();
        assert!(map.commands.iter().any(|c| c.name == "test" && c.run == "vitest"), "{:?}", map.commands);
        let header = map.header.clone();
        for leaked in ["id_ed25519", "/etc/passwd", "outside-package"] {
            assert!(!header.contains(leaked), "{leaked} came through a symlink: {header}");
        }
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn the_header_stays_within_six_kib_and_starts_with_the_stamp() {
        let dir = new_dir("big");
        init(&dir);
        // Many areas, scripts, deleted files with long subjects: far more than fits.
        for i in 0..60 {
            write(&dir, &format!("dir{i:02}/sub{i:02}/file.txt"), "x");
            write(
                &dir,
                &format!("dir{i:02}/sub{i:02}/package.json"),
                &format!(r#"{{"name":"package-with-a-long-name-{i}","scripts":{{"build":"x","test":"y"}}}}"#),
            );
            write(&dir, &format!("gone/file{i:02}.txt"), "x");
        }
        let long = "very long commit subject ".repeat(12);
        commit(&dir, "init", 20);
        for i in 0..30 {
            fs::remove_file(dir.join(format!("gone/file{i:02}.txt"))).unwrap();
        }
        commit(&dir, &long, 1);
        let map = build(&project(&dir, &[])).await.unwrap();
        assert!(map.header.starts_with(&format!("Map as of fixture@{}", &map.repos[0].head[..7])), "{}", &map.header[..80]);
        assert!(map.header.len() <= HEADER_MAX_BYTES, "{} bytes", map.header.len());
        assert!(map.header.contains("Repos:") && map.header.contains("Layout"), "kept the sections that matter");
        assert_eq!(map.layout.iter().filter(|a| a.path.starts_with("dir")).count(), 120, "the full map is not trimmed");
        assert_eq!(map.removed.len(), 15);
        // Many repositories do not break the cap either.
        let mut huge = map.clone();
        huge.removed =
            (0..500).map(|i| ProjectMapChange { subject: long.clone(), path: format!("p/{i}"), ..huge.removed[0].clone() }).collect();
        assert!(render_header(&huge).len() <= HEADER_MAX_BYTES);
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn path_queries_list_a_subtree_and_its_last_ten_commits() {
        let dir = new_dir("path");
        init(&dir);
        write(&dir, "src/auth/session.ts", "a");
        write(&dir, "src/auth/util/hash.ts", "a");
        write(&dir, "src/other.ts", "a");
        commit(&dir, "init", 30);
        for i in 0..12 {
            write(&dir, "src/auth/session.ts", &format!("{i}"));
            commit(&dir, &format!("auth change {i}"), 12 - i);
        }
        write(&dir, "src/other.ts", "b");
        commit(&dir, "unrelated", 0);
        let project = project(&dir, &[]);
        let cache = new_dir("path-cache");
        let map = current(&cache, &project).await.unwrap();
        let result = path_query(&project, &map, "src/auth/").await.unwrap();
        assert_eq!((result["repo"].clone(), result["path"].clone(), result["files"].clone()), (json!("."), json!("src/auth"), json!(2)));
        assert_eq!(result["entries"], json!([{"name": "util", "kind": "dir", "files": 1}, {"name": "session.ts", "kind": "file"}]));
        let commits = result["commits"].as_array().unwrap();
        assert_eq!(commits.len(), 10);
        assert_eq!(commits[0]["subject"], json!("auth change 11"));
        assert!(commits.iter().all(|c| c["subject"].as_str().unwrap().starts_with("auth change")), "{commits:?}");
        assert_eq!(commits[0]["commit"], json!(git(&dir, &["rev-parse", "--short", "HEAD~1"])));
        assert_eq!(result["as_of"], json!(map.repos[0].head[..7].to_owned()));
        // A file, the root, and the errors.
        let file = path_query(&project, &map, "src/auth/session.ts").await.unwrap();
        assert_eq!(file["entries"], json!([{"name": "session.ts", "kind": "file"}]));
        assert_eq!(path_query(&project, &map, "src").await.unwrap()["entries"].as_array().unwrap().len(), 2);
        for bad in ["../etc", "/etc", "src/../x", "-x", "a\\b"] {
            assert!(path_query(&project, &map, bad).await.is_err(), "{bad}");
        }
        let missing = path_query(&project, &map, "nope").await.unwrap_err().to_string();
        assert!(missing.contains("No tracked files under nope"), "{missing}");
        // Pathspec magic is literal.
        assert!(path_query(&project, &map, ":(top)src").await.is_err());
        let _ = fs::remove_dir_all(dir);
        let _ = fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn path_queries_in_a_group_pick_the_repository_by_its_folder() {
        let group = new_dir("group-path");
        let (api, web) = (group.join("api"), group.join("web"));
        for (repo, file) in [(&api, "src/main.rs"), (&web, "src/App.tsx")] {
            init(repo);
            write(repo, file, "x");
            commit(repo, &format!("{} init", file), 0);
        }
        let project = project(&group, &["api", "web"]);
        let cache = new_dir("group-path-cache");
        let map = current(&cache, &project).await.unwrap();
        let api_src = path_query(&project, &map, "api/src").await.unwrap();
        assert_eq!((api_src["repo"].clone(), api_src["path"].clone()), (json!("api"), json!("src")));
        assert_eq!(api_src["entries"], json!([{"name": "main.rs", "kind": "file"}]));
        assert_eq!(path_query(&project, &map, "web").await.unwrap()["entries"], json!([{"name": "src", "kind": "dir", "files": 1}]));
        let error = path_query(&project, &map, "other/src").await.unwrap_err().to_string();
        assert!(error.contains("Start the path with one of: api, web"), "{error}");
        let _ = fs::remove_dir_all(group);
        let _ = fs::remove_dir_all(cache);
    }

    #[tokio::test]
    async fn projects_without_a_repository_or_commit_have_no_map() {
        let plain = new_dir("plain");
        let mut project = project(&plain, &[]);
        project.is_git = false;
        let error = build(&project).await.unwrap_err().to_string();
        assert!(error.contains("not a git repository"), "{error}");
        init(&plain);
        project.is_git = true;
        let error = build(&project).await.unwrap_err().to_string();
        assert!(error.contains("no commits"), "{error}");
        let _ = fs::remove_dir_all(plain);
    }

    /// Timing and output on this repository: `cargo test -p kybern-daemon this_repository -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore = "reads the real repository this crate lives in"]
    async fn this_repository_builds_in_under_a_second() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
        let project = project(&root, &[]);
        let mut times = Vec::new();
        let mut map = None;
        for _ in 0..5 {
            let started = std::time::Instant::now();
            map = Some(build(&project).await.unwrap());
            times.push(started.elapsed());
        }
        let map = map.unwrap();
        eprintln!("build times: {times:?}\nfiles: {}, header: {} bytes\n{}", map.repos[0].files, map.header.len(), map.header);
        assert!(times.iter().all(|t| t.as_millis() < 1000), "{times:?}");
    }

    #[test]
    fn small_parsers_read_the_fields_the_map_needs() {
        let entries = toml_entries(
            "# top\n[package]\nname = \"a#b\" # trailing\n\n[workspace]\nmembers = [\n  \"x/*\", # c\n  'y',\n]\n[[bin]]\nname = \"tool\"\n",
        );
        assert_eq!(toml_first(&entries, "package", "name").as_deref(), Some("a#b"));
        assert_eq!(toml_all(&entries, "workspace", "members"), vec!["x/*", "y"]);
        assert_eq!(toml_first(&entries, "bin", "name").as_deref(), Some("tool"));
        assert_eq!(yaml_list("packages:\n  - 'a/*'\n  - b # note\nother:\n  - c\n", "packages"), vec!["a/*", "b"]);
        let globs: Vec<String> = ["apps/*", "libs/**", "!libs/skip", "tools/x-*"].iter().map(|g| g.to_string()).collect();
        for (dir, expected) in [
            ("apps/web", true),
            ("apps/web/deep", false),
            ("libs", true),
            ("libs/a/b/c", true),
            ("libs/skip", false),
            ("tools/x-one", true),
            ("tools/y", false),
        ] {
            assert_eq!(matches_any(&globs, dir), expected, "{dir}");
        }
        assert_eq!(make_targets("CC := cc\nall: a b\n\techo\n.PHONY: all\n%.o: %.c\nVAR=1\nclean:\n"), vec!["all", "clean"]);
        assert_eq!(just_recipes("set x := 1\nname := \"v\"\n# c\nbuild a='1':\n  x\n@test:\n  y\n"), vec!["build", "test"]);
        assert_eq!(area_of("a/b/c/d.rs").as_deref(), Some("a/b"));
        assert_eq!(area_of("a/b.rs").as_deref(), Some("a"));
        assert_eq!(area_of("b.rs"), None);
    }
}
