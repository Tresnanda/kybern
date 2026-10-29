//! Add a project to another machine (ADE-86 provisioning; payloads in `kybern_protocol::provision`).
//!
//! **Any machine to any machine.** The source is whichever daemon a client (or an agent's thread) asked;
//! the target is another member. This module holds both halves that need the orchestrator:
//!
//! * **Source.** [`Orchestrator::provision_plan`] says what adding a project would do (the target's
//!   proposed folder, which env files exist), [`Orchestrator::provision_enqueue`] queues the work as one
//!   `provision` outbox item, and [`Orchestrator::provision_for_agent`] is the agent path: a delegation,
//!   fork or move to an online machine without the repository raises the card "os-kdi doesn't have kybern
//!   yet" instead of failing (Full access approves it with the defaults), and the queued work waits for it.
//!   The delivery itself (bundles, sealing env files, progress) is `network::provision`.
//! * **Target.** `peer.provision.probe`, `prepare`, `chunk`, `import` and `finish`: every path is checked
//!   and spelled here, on the machine it belongs to, so POSIX and Windows paths never cross.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use chrono::Utc;
use kybern_git::Repo;
use kybern_protocol::methods::{Method, PeerProvisionProbeMethod};
use kybern_protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::remote_delegation::{CallFailure, Delivery, RemoteTarget, internal, remote_error_delivery};
use super::{DaemonAnswer, LiveSession, Orchestrator};
use crate::network::git_transfer;

/// How long a card waits for the user; the tool call that raised it waits as long.
pub(crate) const CARD_WAIT: Duration = Duration::from_secs(30 * 60);
/// How long a clone from the remote may take.
const CLONE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Env files larger than this are left out (they are not env files).
pub(crate) const MAX_ENV_FILE_BYTES: u64 = 1024 * 1024;
const MAX_ENV_FILES: usize = 50;
/// How deep below the project folder env files are looked for (`apps/web/.env` is two).
const ENV_DEPTH: usize = 3;
/// The tool an agent asks with.
pub(crate) const ADD_TOOL: &str = "kybern_project_add_to_machine";

/// A delegation to a machine may wait for the user's answer to the card, so its call may run that long.
pub(crate) fn call_budget(name: &str, arguments: &Value) -> Option<Duration> {
    let remote = name == "kybern_agent_delegate"
        && arguments.get("machine").and_then(Value::as_str).is_some_and(|machine| !machine.trim().is_empty());
    (remote || name == ADD_TOOL).then_some(CARD_WAIT + Duration::from_secs(60))
}

/// What the agent path came to.
#[derive(Debug)]
pub(crate) enum AgentProvision {
    /// The target has the repository, or cannot be asked (offline, older): go on as before.
    NotNeeded,
    /// Queued before the work that needs it; that work waits for it.
    Queued {
        item: Box<OutboxItem>,
        target_name: String,
        project_name: String,
        path: Option<String>,
        env_files: Vec<String>,
        approved_by: &'static str,
    },
}

impl AgentProvision {
    /// The part of a tool result that tells the agent what happened, so it can tell the user.
    pub(crate) fn note(&self) -> Option<Value> {
        let AgentProvision::Queued { item, target_name, project_name, path, env_files, approved_by } = self else { return None };
        Some(json!({
            "operation_id": item.operation_id,
            "machine": target_name,
            "project": project_name,
            "path": path,
            "env_files": env_files,
            "approved_by": approved_by,
            "note": format!("{target_name} did not have {project_name}, so Kybern is adding it there first; the work starts when it is ready."),
        }))
    }
}

// ---- paths on this machine (the target) ----

fn home_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf())
}

/// The path with links resolved and, on Windows, without the `\\?\` prefix canonicalizing adds, so it can
/// be compared with paths spelled the ordinary way. A path that does not exist is returned as given.
fn simple_canonical(path: &Path) -> PathBuf {
    match std::fs::canonicalize(path) {
        Ok(real) => kybern_git::simplify_path(&real),
        Err(_) => kybern_git::simplify_path(path),
    }
}

/// A folder name to suggest on this machine, in the spelling it uses.
fn example_folder() -> &'static str {
    if cfg!(windows) { r"D:\projects" } else { "~/projects" }
}

/// A Windows path spelled one way for comparing: `\` separators, no `\\?\` prefix, lower case, no trailing `\`.
fn windows_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('/', "\\");
    let text = kybern_git::simplify_path(Path::new(&text)).to_string_lossy().to_lowercase();
    text.trim_end_matches('\\').to_string()
}

fn path_same(windows: bool, a: &Path, b: &Path) -> bool {
    if windows { windows_key(a) == windows_key(b) } else { a == b }
}

/// Whether `path` is `prefix` or inside it; Windows paths compare without regard to case or spelling.
fn path_starts(windows: bool, path: &Path, prefix: &Path) -> bool {
    if windows {
        let (path, prefix) = (windows_key(path), windows_key(prefix));
        path == prefix || path.starts_with(&format!("{prefix}\\"))
    } else {
        path.starts_with(prefix)
    }
}

/// Where `path` really is: its deepest folder that exists, with links resolved, and the rest as given. A
/// folder that does not exist yet is checked where it will be made, not where its spelling says.
fn physical(path: &Path) -> PathBuf {
    let mut existing = path;
    let mut rest = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(existing) {
            let mut real = kybern_git::simplify_path(&real);
            real.extend(rest.iter().rev());
            return real;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                rest.push(name.to_os_string());
                existing = parent;
            }
            _ => return kybern_git::simplify_path(path),
        }
    }
}

/// `root` joined with `rel`, refused when a link (or a Windows junction) anywhere below `root` would lead
/// out of it, so what is read or written there stays in the project. Parts that do not exist yet are fine.
pub(crate) fn inside(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let shown = rel.to_string_lossy().replace('\\', "/");
    let mut path = root.to_path_buf();
    for part in rel.components() {
        let Component::Normal(part) = part else { return Err(format!("{shown} is not a path inside the project.")) };
        path.push(part);
        match std::fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(format!("{shown} goes through a link, so Kybern does not copy it."));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(format!("Kybern could not look at {shown}: {error}")),
        }
    }
    if !path_starts(cfg!(windows), &physical(&path), &physical(root)) {
        return Err(format!("{shown} leads out of the project, so Kybern does not copy it."));
    }
    Ok(path)
}

/// Expand `~` and check that `raw` is a place a project may be written to on this machine. Returns the
/// folder as this machine spells it.
pub(crate) fn resolve_destination(raw: &str, data_dir: &Path) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Choose a folder.".into());
    }
    let home = home_dir();
    let path = match raw.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') => match &home {
            Some(home) => home.join(rest.trim_start_matches(['/', '\\'])),
            None => return Err("This machine has no home folder to put ~ in. Enter the full path.".into()),
        },
        _ => PathBuf::from(raw),
    };
    if !path.is_absolute() {
        return Err(format!("Enter the full path of the folder, like {}.", example_folder()));
    }
    if path.components().any(|component| matches!(component, Component::ParentDir | Component::CurDir)) {
        return Err("Enter the path without . or .. in it.".into());
    }
    // A link resolves to where it points, and that place is the one checked, also for a folder not made yet.
    let checked = physical(&path);
    if checked.parent().is_none() || checked.file_name().is_none() {
        return Err("That is the top of the drive. Choose a folder inside it.".into());
    }
    let (same, starts) =
        (|a: &Path, b: &Path| path_same(cfg!(windows), a, b), |path: &Path, prefix: &Path| path_starts(cfg!(windows), path, prefix));
    if let Some(home) = home.as_deref().map(simple_canonical) {
        if same(&checked, &home) || starts(&home, &checked) {
            return Err(format!("That folder holds your home folder. Choose a folder inside it, like {}.", example_folder()));
        }
        if cfg!(target_os = "macos") && starts(&checked, &home.join("Library")) {
            return Err("~/Library belongs to macOS and apps. Choose a folder like ~/projects.".into());
        }
    }
    let data = simple_canonical(data_dir);
    if starts(&checked, &data) || starts(&data, &checked) {
        return Err("That folder is Kybern's own data folder. Choose another one.".into());
    }
    let system: &[&str] = if cfg!(windows) {
        &["C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"]
    } else if cfg!(target_os = "macos") {
        &["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/etc", "/private", "/var", "/dev", "/Volumes/Recovery"]
    } else {
        &["/usr", "/bin", "/sbin", "/etc", "/var", "/proc", "/sys", "/dev", "/boot", "/lib", "/lib64", "/run", "/snap"]
    };
    if let Some(folder) = system.iter().map(Path::new).find(|folder| starts(&checked, folder)) {
        return Err(format!("{} is a system folder. Choose another folder, like {}.", folder.display(), example_folder()));
    }
    Ok(path)
}

/// A relative path inside a project (`/`-separated): no root, no `..`, nothing in `.git`.
pub(crate) fn safe_relative(rel: &str) -> Option<PathBuf> {
    let rel = rel.trim();
    if rel.is_empty() || rel.contains('\\') || rel.contains('\0') || rel.starts_with('/') || rel.contains(':') {
        return None;
    }
    let mut path = PathBuf::new();
    for part in rel.split('/').filter(|part| !part.is_empty()) {
        if part == ".." || part.eq_ignore_ascii_case(".git") {
            return None;
        }
        if part != "." {
            path.push(part);
        }
    }
    Some(path)
}

fn is_empty_dir(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

/// What `dest` holds, for the repositories `repos` (paired with their folders `rels` inside it).
async fn check_path(dest: &Path, repos: &[RepoIdentity], rels: &[String], name: &str) -> PathCheck {
    let shown = dest.to_string_lossy().into_owned();
    let check = |state, message: String| PathCheck { state, path: shown.clone(), message };
    if !dest.exists() {
        return check(PathState::Free, "New folder · it will be created".into());
    }
    if !dest.is_dir() {
        return check(PathState::NotEmpty, "That is a file, not a folder. Choose another name.".into());
    }
    if is_empty_dir(dest) {
        return check(PathState::Free, "Empty folder · it will be used".into());
    }
    let mut all = !repos.is_empty();
    for (index, repo) in repos.iter().enumerate() {
        let rel = rels.get(index).map(String::as_str).unwrap_or(".");
        let dir = safe_relative(rel).map(|rel| dest.join(rel)).unwrap_or_else(|| dest.to_path_buf());
        if !git_transfer::same_repo(repo, &git_transfer::identity_of(&dir).await) {
            all = false;
            break;
        }
    }
    if all {
        check(PathState::SameRepo, format!("Already has {name} · it will be added as it is"))
    } else {
        check(PathState::NotEmpty, "This folder already holds other files. Choose an empty or new folder.".into())
    }
}

/// A folder name for a project: what the user named it, without separators or characters Windows refuses.
fn folder_name(name: &str) -> String {
    let cleaned: String =
        name.trim().chars().map(|c| if c.is_control() || r#"/\:*?"<>|"#.contains(c) { '-' } else { c }).collect::<String>();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c == ' ' || c == '-').to_string();
    if cleaned.is_empty() { "project".into() } else { cleaned }
}

/// The parent folder most of this machine's projects live in, else `~/projects`.
fn projects_parent(projects: &[Project], data_dir: &Path) -> Option<PathBuf> {
    let mut counts: Vec<(PathBuf, usize, chrono::DateTime<Utc>)> = Vec::new();
    let data = simple_canonical(data_dir);
    for project in projects {
        let path = kybern_git::simplify_path(Path::new(&project.path));
        let Some(parent) = path.parent() else { continue };
        // Never propose Kybern's own data folder, nor a folder that holds it (both are refused as destinations).
        if path_starts(cfg!(windows), &path, &data) || path_starts(cfg!(windows), &data, parent) || parent.parent().is_none() {
            continue;
        }
        match counts.iter_mut().find(|(known, ..)| known == parent) {
            Some(entry) => {
                entry.1 += 1;
                entry.2 = entry.2.max(project.updated_at);
            }
            None => counts.push((parent.to_path_buf(), 1, project.updated_at)),
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    counts.into_iter().map(|(parent, ..)| parent).next().or_else(|| home_dir().map(|home| home.join("projects")))
}

/// The OS name the network uses.
pub(crate) fn this_os() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

// ---- env files on this machine (the source) ----

/// Whether a file name is an env or secret file worth carrying.
pub(crate) fn is_env_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let template = [".example", ".sample", ".template", ".dist", ".defaults"].iter().any(|suffix| lower.ends_with(suffix));
    !template && (lower.starts_with(".env") || lower.ends_with(".env") || lower == ".dev.vars")
}

/// The git-ignored env files of the project at `root`: names and sizes only, never contents.
pub(crate) async fn detect_env_files(root: &Path) -> Vec<EnvFileCandidate> {
    let repo = Repo::new(root);
    // `--directory` lists an ignored folder (`node_modules/`) as one entry instead of everything in it.
    let listed = repo.output(&["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]).await;
    let mut found = Vec::new();
    let Ok(out) = listed else { return found };
    if !out.success {
        return found;
    }
    for rel in out.stdout.split('\0').map(str::trim).filter(|rel| !rel.is_empty() && !rel.ends_with('/')) {
        let parts: Vec<&str> = rel.split('/').collect();
        if parts.len() > ENV_DEPTH + 1 || !parts.last().is_some_and(|name| is_env_name(name)) {
            continue;
        }
        if parts.iter().any(|part| crate::files::CREDENTIAL_DIRS.contains(&part.to_ascii_lowercase().as_str())) {
            continue;
        }
        let path = root.join(rel);
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() || meta.len() > MAX_ENV_FILE_BYTES {
            continue;
        }
        found.push(EnvFileCandidate { path: rel.to_string(), size: meta.len(), selected: true });
        if found.len() >= MAX_ENV_FILES {
            break;
        }
    }
    found.sort_by(|a, b| a.path.matches('/').count().cmp(&b.path.matches('/').count()).then(a.path.cmp(&b.path)));
    found
}

/// The source's `origin` URL with any user name or password removed.
pub(crate) fn strip_credentials(url: &str) -> String {
    let url = url.trim();
    match url.split_once("://") {
        Some((scheme, rest)) => {
            let (authority, path) = rest.split_once('/').map_or((rest, ""), |(authority, path)| (authority, path));
            let host = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
            if path.is_empty() { format!("{scheme}://{host}") } else { format!("{scheme}://{host}/{path}") }
        }
        // `git@github.com:owner/repo.git` names an SSH user, not a secret.
        None => url.to_string(),
    }
}

/// Remove anything that looks like a credential from git's own words.
fn redact(text: &str) -> String {
    text.split_whitespace()
        .map(|word| if word.contains("://") && word.contains('@') { strip_credentials(word) } else { word.to_string() })
        .collect::<Vec<_>>()
        .join(" ")
}

/// One repository of a source project.
#[derive(Debug, Clone)]
pub(crate) struct SourceRepo {
    pub rel: String,
    pub dir: PathBuf,
    pub identity: RepoIdentity,
    pub remote_url: Option<String>,
    pub branch: Option<String>,
    pub commit: Option<String>,
}

/// The repositories of a project on this machine: the folder itself, or each member of a group.
pub(crate) async fn source_repos(project: &Project) -> Vec<SourceRepo> {
    let root = PathBuf::from(&project.path);
    let rels: Vec<String> =
        if project.kind.is_single() { vec![".".into()] } else { project.members.iter().map(|member| member.path.clone()).collect() };
    let mut repos = Vec::new();
    for rel in rels {
        let dir = safe_relative(&rel).map(|part| root.join(part)).unwrap_or_else(|| root.clone());
        let repo = Repo::new(&dir);
        let branch = repo
            .output(&["symbolic-ref", "--short", "-q", "HEAD"])
            .await
            .ok()
            .filter(|out| out.success && !out.stdout.trim().is_empty())
            .map(|out| out.stdout.trim().to_string());
        repos.push(SourceRepo {
            identity: git_transfer::identity_of(&dir).await,
            remote_url: repo.config_get("remote.origin.url").await.map(|url| strip_credentials(&url)).filter(|url| !url.is_empty()),
            commit: repo.head().await,
            branch,
            rel,
            dir,
        });
    }
    repos
}

// ---- the idempotency record on the target ----

#[derive(Debug, Default, Serialize, Deserialize)]
struct Record {
    /// Where the project goes, as [`physical`] spells it.
    path: String,
    /// The machine that started the operation; only it continues it.
    #[serde(default)]
    peer: String,
    /// The repository folders this operation created (so a retry may continue in them).
    #[serde(default)]
    created: Vec<String>,
}

fn record_path(data_dir: &Path, operation_id: Uuid) -> PathBuf {
    data_dir.join("provision").join(format!("{operation_id}.json"))
}

fn load_record(data_dir: &Path, operation_id: Uuid) -> Record {
    std::fs::read(record_path(data_dir, operation_id)).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

fn save_record(data_dir: &Path, operation_id: Uuid, record: &Record) -> std::io::Result<()> {
    let path = record_path(data_dir, operation_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec(record).unwrap_or_default())
}

/// The record of `operation_id` for `peer` putting a project in `dest`: a fresh one when there is none, and a
/// refusal when another machine started it or it was for another folder, so a reused id never reaches (or
/// removes) a folder the operation did not make.
fn bound_record(data_dir: &Path, operation_id: Uuid, peer: &str, dest: &Path) -> Result<Record, RpcError> {
    let record = load_record(data_dir, operation_id);
    let here = physical(dest).to_string_lossy().into_owned();
    if record.path.is_empty() && record.created.is_empty() {
        return Ok(Record { path: here, peer: peer.to_string(), created: Vec::new() });
    }
    if record.peer != peer || !path_same(cfg!(windows), Path::new(&record.path), Path::new(&here)) {
        return Err(conflict("That operation was started for another folder. Add the project again."));
    }
    Ok(record)
}

fn conflict(message: impl Into<String>) -> RpcError {
    RpcError::new(codes::CONFLICT, message.into())
}

/// Check out `branch` (or detach) at `commit`, tracking `origin/<branch>` when the remote has it.
async fn check_out(repo: &Repo, branch: Option<&str>, commit: &str) -> Result<(), RpcError> {
    let out = match branch {
        Some(branch) => repo.output(&["checkout", "-q", "-B", branch, commit]).await,
        None => repo.output(&["checkout", "-q", "--detach", commit]).await,
    }
    .map_err(internal)?;
    if !out.success {
        return Err(conflict(format!("Kybern could not check out the files: {}", redact(out.stderr.trim()))));
    }
    if let Some(branch) = branch {
        let upstream = format!("origin/{branch}");
        if repo.output(&["rev-parse", "--verify", "-q", &upstream]).await.is_ok_and(|out| out.success) {
            let _ = repo.output(&["branch", "-q", "--set-upstream-to", &upstream, branch]).await;
        }
    }
    Ok(())
}

impl Orchestrator {
    // ---- the source ----

    /// `projects.provision_plan`.
    pub async fn provision_plan(&self, project_id: ProjectId, machine: &str, path: Option<String>) -> Result<ProvisionPlan, RpcError> {
        let hub = self.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?.clone();
        let project = self.inner.store.project_get(project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
        let target = hub.resolve(machine).map_err(|reason| RpcError::new(codes::NOT_FOUND, reason))?;
        let members = hub.members();
        let os_of = |id: &str| members.iter().find(|member| member.id == id).map(|member| member.os.clone()).unwrap_or_default();
        let source = ProvisionMachine { id: hub.self_id(), name: hub.self_name(), os: this_os().into(), online: true };
        let target_view = ProvisionMachine {
            id: target.id.clone(),
            name: target.name.clone(),
            os: os_of(&target.id),
            online: target.online && !target.paused,
        };
        let repos = source_repos(&project).await;
        let mut plan = ProvisionPlan {
            project_id,
            project_name: project.name.clone(),
            kind: project.kind,
            source,
            target: target_view,
            repos: repos
                .iter()
                .map(|repo| ProvisionRepo { path: repo.rel.clone(), remote: repo.identity.remote.clone(), branch: repo.branch.clone() })
                .collect(),
            existing: Vec::new(),
            suggested_path: None,
            target_home: None,
            path_check: None,
            env_files: detect_env_files(Path::new(&project.path)).await,
            blocked: None,
        };
        if repos.iter().any(|repo| repo.identity.is_empty() || repo.commit.is_none()) || repos.is_empty() {
            // Git also finds "no commits" in a folder it refuses to open (another user owns it): say that instead.
            for repo in &repos {
                if let kybern_git::RepoState::Unsafe(message) = Repo::probe(&repo.dir).await {
                    plan.blocked = Some(message);
                    return Ok(plan);
                }
            }
            plan.blocked = Some(format!(
                "{} has no git commits here yet, so there is nothing to copy. Commit once, then add it to {}.",
                project.name, target.name
            ));
            return Ok(plan);
        }
        if let Some(features) = &target.features
            && !features.iter().any(|feature| feature == features::PROVISION_V1)
        {
            plan.blocked = Some(format!("{} needs a newer Kybern to add projects. Update it from Settings → Machines.", target.name));
            return Ok(plan);
        }
        if plan.target.online {
            let probe = PeerProvisionProbeParams {
                repos: repos.iter().map(|repo| repo.identity.clone()).collect(),
                members: repos.iter().map(|repo| repo.rel.clone()).collect(),
                kind: project.kind,
                name: project.name.clone(),
                path: path.clone(),
            };
            match hub.call(&target.id, PeerProvisionProbeMethod::NAME, serde_json::to_value(probe).map_err(internal)?).await {
                Ok(value) => {
                    let probe: PeerProvisionProbe = serde_json::from_value(value).map_err(internal)?;
                    if plan.target.os.is_empty() {
                        plan.target.os = probe.os.clone();
                    }
                    plan.existing = probe.existing;
                    plan.suggested_path = Some(probe.suggested_path);
                    plan.target_home = probe.home;
                    plan.path_check = Some(probe.path_check);
                    return Ok(plan);
                }
                Err(CallFailure::Remote(error)) if error.code == codes::METHOD_NOT_FOUND => {
                    plan.blocked =
                        Some(format!("{} needs a newer Kybern to add projects. Update it from Settings → Machines.", target.name));
                    return Ok(plan);
                }
                Err(CallFailure::Remote(error)) => return Err(error),
                Err(_) => plan.target.online = false,
            }
        }
        // Offline: the target proposes and checks the folder when the work reaches it.
        plan.path_check = Some(PathCheck {
            state: PathState::Unknown,
            path: path.unwrap_or_default(),
            message: format!("{} is offline · it checks the folder when it returns", target.name),
        });
        Ok(plan)
    }

    /// `projects.provision` and the agent path: queue the work for `target`. A repeated operation id returns the first item.
    pub async fn provision_enqueue(
        &self,
        project: &Project,
        target: &RemoteTarget,
        choice: ProvisionChoice,
        operation_id: Uuid,
        origin: Option<Origin>,
    ) -> Result<OutboxItem, RpcError> {
        let hub = self.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?.clone();
        if let Some(existing) = self.inner.store.outbox_get_by_operation(operation_id).map_err(internal)? {
            if existing.kind != OutboxKind::Provision {
                return Err(conflict("operation_id already belongs to other work. Use a fresh one."));
            }
            return Ok(existing);
        }
        let env_files = match choice.env_files {
            Some(files) => {
                for file in &files {
                    if safe_relative(file).is_none_or(|path| path.as_os_str().is_empty()) {
                        return Err(RpcError::invalid_params(format!("{file} is not a path inside the project.")));
                    }
                }
                files
            }
            None => {
                detect_env_files(Path::new(&project.path)).await.into_iter().filter(|file| file.selected).map(|file| file.path).collect()
            }
        };
        let request = ProvisionRequest {
            operation_id,
            project_id: project.id,
            project_name: project.name.clone(),
            path: choice.path.map(|path| path.trim().to_string()).filter(|path| !path.is_empty()),
            env_files,
        };
        let now = Utc::now();
        let item = OutboxItem {
            id: Uuid::now_v7(),
            operation_id,
            target: target.id.clone(),
            kind: OutboxKind::Provision,
            payload: serde_json::to_value(&request).map_err(internal)?,
            origin,
            state: OutboxState::Queued,
            attempts: 0,
            next_attempt_at: None,
            last_error: None,
            result: None,
            created_at: now,
            expires_at: now + chrono::Duration::days(self.outbox_expiry_days()),
            updated_at: now,
        };
        let item = self.inner.store.outbox_insert(&item).map_err(internal)?;
        hub.kick();
        Ok(item)
    }

    /// A fork or move the user sent to a machine without the repository: queue the provisioning first; the fork or move waits for it.
    pub(crate) async fn provision_before(
        &self,
        thread: &Thread,
        target: &RemoteTarget,
        choice: ProvisionChoice,
        operation_id: Uuid,
    ) -> Result<OutboxItem, RpcError> {
        let project = self.inner.store.project_get(thread.project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
        self.provision_enqueue(&project, target, choice, super::derived_operation_id(operation_id, 0x9c), None).await
    }

    #[allow(clippy::too_many_arguments)]
    /// The agent path: before a delegation, fork or move goes to `target`, make sure it has the thread's project.
    pub(super) async fn provision_for_agent(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        target: &RemoteTarget,
        then: &str,
        reason: Option<String>,
        requested_path: Option<String>,
        operation_id: Uuid,
    ) -> Result<AgentProvision> {
        if !target.online || target.paused {
            return Ok(AgentProvision::NotNeeded);
        }
        let Some(project) = self.inner.store.project_get(thread.project_id)? else { return Ok(AgentProvision::NotNeeded) };
        // A queued provisioning for this target already covers it; the work waits for it.
        if let Some(existing) = self.inner.store.outbox_get_by_operation(operation_id)?.filter(|item| item.kind == OutboxKind::Provision) {
            return Ok(queued(existing, target, &project, None, Vec::new(), "earlier"));
        }
        let requested_path = requested_path.map(|path| path.trim().to_string()).filter(|path| !path.is_empty());
        let plan = self.provision_plan(project.id, &target.id, requested_path.clone()).await.map_err(|error| anyhow!(error.message))?;
        if !plan.existing.is_empty() || plan.blocked.is_some() || !plan.target.online {
            return Ok(AgentProvision::NotNeeded);
        }
        // A folder the agent named is checked by the target like one typed in the sheet; a refused one fails, never falls back.
        if let Some(asked) = &requested_path
            && let Some(check) = plan.path_check.as_ref().filter(|check| !matches!(check.state, PathState::Free | PathState::SameRepo))
        {
            bail!(
                "{} cannot take the project at {asked}: {}. Pass another path, or leave it out to use the proposed folder.",
                target.name,
                check.message
            );
        }
        if self.inner.store.outbox_provision_pending(&target.id)? {
            return Ok(AgentProvision::NotNeeded);
        }
        let default_path = plan
            .path_check
            .as_ref()
            .filter(|check| matches!(check.state, PathState::Free | PathState::SameRepo))
            .map(|check| check.path.clone())
            .or_else(|| plan.suggested_path.clone());
        let default_env: Vec<String> = plan.env_files.iter().filter(|file| file.selected).map(|file| file.path.clone()).collect();
        let origin = Some(Origin {
            machine_id: self.remote_hub().map(|hub| hub.self_id()).unwrap_or_default(),
            machine_name: self.remote_hub().map(|hub| hub.self_name()).unwrap_or_default(),
            thread_id: Some(thread.id),
            operation_id,
            kind: OriginKind::Delegation { task_id: operation_id.to_string() },
            permission_cap: thread.permission_mode,
            hops: Vec::new(),
        });

        if thread.permission_mode == PermissionMode::FullAccess && default_path.is_some() {
            let choice = ProvisionChoice { path: default_path.clone(), env_files: Some(default_env.clone()) };
            let item =
                self.provision_enqueue(&project, target, choice, operation_id, origin).await.map_err(|error| anyhow!(error.message))?;
            return Ok(queued(item, target, &project, default_path, default_env, "full_access"));
        }

        let input = ProvisionCardInput { plan: plan.clone(), then: then.to_string(), reason, operation_id };
        let summary = format!("Add {} to {}", project.name, target.name);
        let key = format!("provision:{operation_id}");
        let (card, answer) = self
            .ask_daemon_approval_within(
                thread.id,
                turn_id,
                live,
                key,
                PROJECT_PROVISION_TOOL,
                serde_json::to_value(&input)?,
                summary,
                Some(operation_id),
                CARD_WAIT,
            )
            .await?;
        let decision = match answer {
            DaemonAnswer::Decided(decision) => Some(decision),
            DaemonAnswer::TurnEnded => None,
            DaemonAnswer::Pending => self.close_unanswered_secret_card(thread.id, turn_id, live, card).await?,
        };
        let declined = || {
            anyhow!("The user chose not to add {} to {}. Do the work on this machine instead, or ask the user.", project.name, target.name)
        };
        let Some(ApprovalDecision::Submit { response }) = decision else { return Err(declined()) };
        let path = response.get("path").and_then(Value::as_str).map(str::to_string).or(default_path);
        let env_files: Vec<String> = response
            .get("env_files")
            .and_then(Value::as_array)
            .map(|files| files.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or(default_env);
        let choice = ProvisionChoice { path: path.clone(), env_files: Some(env_files.clone()) };
        let item = self.provision_enqueue(&project, target, choice, operation_id, origin).await.map_err(|error| anyhow!(error.message))?;
        Ok(queued(item, target, &project, path, env_files, "user"))
    }

    /// `kybern_project_add_to_machine`: the agent asks for the thread's project on another machine.
    pub(super) async fn execute_add_to_machine(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        arguments: Value,
    ) -> Result<Value> {
        #[derive(Deserialize)]
        struct Args {
            machine: String,
            #[serde(default)]
            path: Option<String>,
            #[serde(default)]
            reason: Option<String>,
            #[serde(default)]
            request_key: Option<String>,
        }
        let args: Args = serde_json::from_value(arguments)
            .map_err(|error| anyhow!("Invalid arguments for {ADD_TOOL}: {error}. Pass machine (a name from kybern_agent_capabilities)."))?;
        let hub = self.remote_hub().ok_or_else(|| anyhow!("This daemon cannot reach other machines."))?.clone();
        let target = hub.resolve(&args.machine).map_err(|reason| anyhow!(reason))?;
        if !target.online || target.paused {
            bail!(
                "{} is offline, so Kybern cannot check its folders now. Ask the user to add the project from its menu (Add to another machine…).",
                target.name
            );
        }
        let key = args.request_key.unwrap_or_else(|| format!("{}:{}", thread.id, target.id));
        let digest = <sha2::Sha256 as sha2::Digest>::digest(format!("kybern-provision-add\0{key}").as_bytes());
        let operation_id = Uuid::from_slice(&digest[..16]).unwrap_or_else(|_| Uuid::now_v7());
        match self.provision_for_agent(thread, turn_id, live, &target, "add", args.reason, args.path, operation_id).await? {
            AgentProvision::NotNeeded => {
                let project = self.inner.store.project_get(thread.project_id)?.map(|project| project.name).unwrap_or_default();
                Ok(json!({ "status": "already_there", "machine": target.name, "project": project }))
            }
            queued @ AgentProvision::Queued { .. } => {
                let mut note = queued.note().unwrap_or(Value::Null);
                if let Some(object) = note.as_object_mut() {
                    object.insert("status".into(), json!("queued"));
                    object.insert(
                        "note".into(),
                        json!(
                            "Kybern is adding the project there now. Delegate to that machine as usual; the work waits until it is ready."
                        ),
                    );
                }
                Ok(note)
            }
        }
    }

    /// A delivery the target refused because it has no checkout: wait while a provisioning for it is queued.
    pub(crate) fn remote_refusal(&self, item: &OutboxItem, error: &RpcError) -> Delivery {
        let needs_project = error.data.as_ref().and_then(|data| data.get("needs")).and_then(Value::as_str) == Some(NEEDS_PROJECT);
        if needs_project {
            let name = self.machine_name(&item.target);
            if self.inner.store.outbox_provision_pending(&item.target).unwrap_or(false) {
                return Delivery::Retry(format!("Waiting for the project to be added to {name}"));
            }
            return Delivery::Failed(error.message.clone());
        }
        remote_error_delivery(error)
    }

    /// A provisioning settled: the work that waited for it goes now (or fails with the reason).
    pub(crate) fn provision_settled(&self, item: &OutboxItem) {
        if !item.state.is_settled() {
            return;
        }
        if let Ok(count) = self.inner.store.outbox_wake_waiting(&item.target)
            && count > 0
            && let Some(hub) = self.remote_hub()
        {
            hub.kick();
        }
    }

    // ---- the target ----

    /// The projects of this machine that already are `repos`.
    async fn provision_existing(
        &self,
        repos: &[RepoIdentity],
        members: &[String],
        kind: ProjectKind,
    ) -> Result<Vec<ProvisionExisting>, RpcError> {
        let view = |project: &Project| ProvisionExisting { project_id: project.id, name: project.name.clone(), path: project.path.clone() };
        if kind == ProjectKind::Group {
            let named: Vec<GroupRepo> = repos
                .iter()
                .zip(members.iter().chain(std::iter::repeat(&String::new())))
                .map(|(repo, name)| GroupRepo { name: name.clone(), repo: repo.clone() })
                .collect();
            if let Ok(candidate) = self.match_group(&named, None, "").await {
                return Ok(vec![view(&candidate.project)]);
            }
            // A group that has some of these repositories is this project, set up differently: adding a second copy
            // would only confuse which one work goes to, so it counts as there (work sent to it says what is missing).
            return Ok(self
                .group_candidates()
                .await?
                .into_iter()
                .filter(|candidate| {
                    candidate.members.iter().any(|member| repos.iter().any(|repo| git_transfer::same_repo(repo, &member.repo)))
                })
                .map(|candidate| view(&candidate.project))
                .collect());
        }
        let Some(primary) = repos.first() else { return Ok(Vec::new()) };
        let mut found = Vec::new();
        for project in
            self.inner.store.projects_list().map_err(internal)?.into_iter().filter(|project| project.kind.is_single() && project.is_git)
        {
            let identity = match &project.repo {
                Some(identity) if !identity.is_empty() => identity.clone(),
                _ => git_transfer::identity_of(Path::new(&project.path)).await,
            };
            if git_transfer::same_repo(primary, &identity) {
                found.push(view(&project));
            }
        }
        Ok(found)
    }

    /// `peer.provision.probe`.
    pub(crate) async fn serve_provision_probe(&self, params: PeerProvisionProbeParams) -> Result<PeerProvisionProbe, RpcError> {
        let data_dir = self.inner.paths.root.clone();
        let existing = self.provision_existing(&params.repos, &params.members, params.kind).await?;
        let projects = self.inner.store.projects_list().map_err(internal)?;
        let parent =
            projects_parent(&projects, &data_dir).ok_or_else(|| conflict("This machine has no home folder to propose a folder in."))?;
        let base = folder_name(&params.name);
        let mut suggested = parent.join(&base);
        for n in 2..50 {
            let check = check_path(&suggested, &params.repos, &params.members, &params.name).await;
            if check.state != PathState::NotEmpty {
                break;
            }
            suggested = parent.join(format!("{base}-{n}"));
        }
        let path_check = match params.path.as_deref().map(str::trim).filter(|path| !path.is_empty()) {
            Some(asked) => match resolve_destination(asked, &data_dir) {
                Ok(dest) => check_path(&dest, &params.repos, &params.members, &params.name).await,
                Err(message) => PathCheck { state: PathState::Forbidden, path: asked.to_string(), message },
            },
            None => check_path(&suggested, &params.repos, &params.members, &params.name).await,
        };
        Ok(PeerProvisionProbe {
            os: this_os().into(),
            home: home_dir().map(|home| home.to_string_lossy().into_owned()),
            existing,
            suggested_path: suggested.to_string_lossy().into_owned(),
            path_check,
        })
    }

    /// `peer.provision.prepare`: make the repository folder exist, cloning it from its remote when possible.
    pub(crate) async fn serve_provision_prepare(
        &self,
        peer: &str,
        params: PeerProvisionPrepareParams,
    ) -> Result<PeerProvisionPrepareResult, RpcError> {
        let data_dir = self.inner.paths.root.clone();
        let dest = resolve_destination(&params.path, &data_dir).map_err(|message| RpcError::new(codes::FORBIDDEN, message))?;
        let rel = safe_relative(&params.rel).ok_or_else(|| RpcError::invalid_params("rel must be a folder inside the project"))?;
        let dir = inside(&dest, &rel).map_err(|message| RpcError::new(codes::FORBIDDEN, message))?;
        let shown = dir.to_string_lossy().into_owned();
        let mut record = bound_record(&data_dir, params.operation_id, peer, &dest)?;
        let ours = record.created.contains(&params.rel);
        if !ours && dir.exists() && !(dir.is_dir() && is_empty_dir(&dir)) {
            if dir.is_dir() && git_transfer::same_repo(&params.repo, &git_transfer::identity_of(&dir).await) {
                // The user's own checkout: used as it is, never checked out or changed.
                return Ok(PeerProvisionPrepareResult {
                    state: PrepareState::Existing,
                    path: shown,
                    full: false,
                    cloned: false,
                    clone_error: None,
                });
            }
            return Err(conflict(format!("{shown} already holds other files. Choose an empty or new folder.")));
        }
        if !ours {
            record.created.push(params.rel.clone());
            save_record(&data_dir, params.operation_id, &record).map_err(internal)?;
        }
        let repo = Repo::new(&dir);
        let mut cloned = false;
        let mut clone_error = None;
        if !dir.join(".git").exists() {
            // A folder this operation made and that holds no repository yet: start it again.
            if dir.exists() {
                let _ = std::fs::remove_dir_all(&dir);
            }
            let parent = dir.parent().ok_or_else(|| conflict("That folder has no parent."))?.to_path_buf();
            std::fs::create_dir_all(&parent).map_err(|error| conflict(format!("Kybern could not create {}: {error}", parent.display())))?;
            if let Some(url) = params.remote_url.as_deref() {
                let name = dir.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                let ssh_set =
                    std::env::var_os("GIT_SSH_COMMAND").is_some() || Repo::new(&parent).config_get("core.sshCommand").await.is_some();
                let env: Vec<(&str, &str)> = if ssh_set { Vec::new() } else { vec![("GIT_SSH_COMMAND", "ssh -o BatchMode=yes")] };
                let out = Repo::new(&parent).output_env(&["clone", "--quiet", "--", url, &name], &env, Some(CLONE_TIMEOUT)).await;
                match out {
                    Ok(out) if out.success => cloned = true,
                    Ok(out) => clone_error = Some(redact(out.stderr.trim())),
                    Err(error) => clone_error = Some(redact(&format!("{error:#}"))),
                }
                if !cloned && dir.exists() {
                    let _ = std::fs::remove_dir_all(&dir);
                }
            }
            if !cloned {
                std::fs::create_dir_all(&dir).map_err(|error| conflict(format!("Kybern could not create {shown}: {error}")))?;
                let init = repo.output(&["init", "-q"]).await.map_err(internal)?;
                if !init.success {
                    return Err(conflict(format!("Kybern could not start a repository in {shown}: {}", init.stderr.trim())));
                }
            }
        }
        if git_transfer::has_commit(&repo, &params.commit).await {
            check_out(&repo, params.branch.as_deref(), &params.commit).await?;
            return Ok(PeerProvisionPrepareResult { state: PrepareState::Ready, path: shown, full: false, cloned, clone_error });
        }
        // A repository with no commits needs everything; a clone only what its remote lacks.
        let full = repo.head().await.is_none() && !cloned;
        Ok(PeerProvisionPrepareResult { state: PrepareState::NeedsBundle, path: shown, full, cloned, clone_error })
    }

    /// `peer.provision.chunk`.
    pub(crate) fn serve_provision_chunk(&self, params: PeerGitBundleParams) -> Result<PeerGitBundleResult, RpcError> {
        use base64::Engine;
        let data = base64::engine::general_purpose::STANDARD
            .decode(params.data.as_bytes())
            .map_err(|error| RpcError::invalid_params(format!("the chunk is not base64: {error}")))?;
        let path = git_transfer::staged_path(&self.inner.paths.root, params.operation_id);
        let received = git_transfer::append_chunk_within(&path, params.offset, params.total, &data, MAX_PROVISION_BUNDLE_BYTES)
            .map_err(|error| RpcError::invalid_params(format!("{error:#}")))?;
        Ok(PeerGitBundleResult { received })
    }

    /// `peer.provision.import`: import the staged bundle into a folder `prepare` made, and check it out.
    pub(crate) async fn serve_provision_import(
        &self,
        peer: &str,
        params: PeerProvisionImportParams,
    ) -> Result<PeerProvisionPrepareResult, RpcError> {
        let data_dir = self.inner.paths.root.clone();
        let dest = resolve_destination(&params.path, &data_dir).map_err(|message| RpcError::new(codes::FORBIDDEN, message))?;
        let rel = safe_relative(&params.rel).ok_or_else(|| RpcError::invalid_params("rel must be a folder inside the project"))?;
        let dir = inside(&dest, &rel).map_err(|message| RpcError::new(codes::FORBIDDEN, message))?;
        let record = bound_record(&data_dir, params.operation_id, peer, &dest)?;
        if !record.created.contains(&params.rel) {
            return Err(conflict("Kybern did not make that folder for this operation, so it does not import into it."));
        }
        let staged = git_transfer::staged_path(&data_dir, params.transfer_id);
        let file =
            git_transfer::describe(&staged).map_err(|_| RpcError::new(codes::NOT_FOUND, "no bundle was staged for this transfer"))?;
        if file.size != params.total || file.sha256 != params.sha256 {
            return Err(conflict("the staged bundle is incomplete or damaged; send it again"));
        }
        let repo = Repo::new(&dir);
        let imported = git_transfer::import_bundle(&repo, &staged, params.transfer_id, &params.commit).await;
        let _ = std::fs::remove_file(&staged);
        match imported {
            Ok(_) => {}
            Err(git_transfer::ImportError::MissingBase(detail)) => {
                return Err(conflict(format!("the checkout lacks the commits this bundle builds on: {detail}"))
                    .with_data(json!({ "needs": "full_bundle" })));
            }
            Err(git_transfer::ImportError::Other(error)) => return Err(conflict(format!("{error:#}"))),
        }
        check_out(&repo, params.branch.as_deref(), &params.commit).await?;
        let _ = repo.delete_ref(&git_transfer::incoming_ref(params.transfer_id)).await;
        if let Some(url) = params.remote_url.as_deref()
            && repo.config_get("remote.origin.url").await.is_none()
        {
            let _ = repo.output(&["remote", "add", "origin", url]).await;
        }
        Ok(PeerProvisionPrepareResult {
            state: PrepareState::Ready,
            path: dir.to_string_lossy().into_owned(),
            full: false,
            cloned: false,
            clone_error: None,
        })
    }

    /// `peer.provision.finish` (the env files already opened): write them and register the project.
    pub(crate) async fn serve_provision_finish(
        &self,
        peer: &str,
        params: &PeerProvisionFinishParams,
        env_files: Vec<(String, Vec<u8>)>,
    ) -> Result<ProvisionResult, RpcError> {
        let data_dir = self.inner.paths.root.clone();
        let dest = resolve_destination(&params.path, &data_dir).map_err(|message| RpcError::new(codes::FORBIDDEN, message))?;
        if !dest.is_dir() {
            return Err(conflict(format!("{} does not exist yet; add the project again.", dest.display())));
        }
        bound_record(&data_dir, params.operation_id, peer, &dest)?;
        let (written, kept) = write_env_files(&dest, env_files)?;
        let path = dest.to_string_lossy().into_owned();
        let project = if params.kind == ProjectKind::Group {
            self.add_group_project(path, Some(params.name.clone()), None, params.members.clone())?
        } else {
            self.add_project(path, Some(params.name.clone()), None).map_err(|error| conflict(format!("{error:#}")))?
        };
        tracing::info!(project_id = %project.id, written = written.len(), kept = kept.len(), "a project was added to this machine from another one");
        Ok(ProvisionResult { project, env_written: written, env_kept: kept, cloned_from_remote: params.cloned_from_remote })
    }
}

/// Write the opened env files into `dest`, keeping any that are already there. Returns (written, kept).
fn write_env_files(dest: &Path, env_files: Vec<(String, Vec<u8>)>) -> Result<(Vec<String>, Vec<String>), RpcError> {
    let (mut written, mut kept) = (Vec::new(), Vec::new());
    for (rel, contents) in env_files {
        let Some(part) = safe_relative(&rel).filter(|part| !part.as_os_str().is_empty()) else {
            return Err(RpcError::invalid_params(format!("{rel} is not a path inside the project.")));
        };
        if !part.file_name().is_some_and(|name| is_env_name(&name.to_string_lossy())) {
            return Err(RpcError::new(codes::FORBIDDEN, format!("{rel} is not an env file, so Kybern does not write it.")));
        }
        // Its folders must not lead out of the project (a link the repository checked out, say).
        inside(dest, part.parent().unwrap_or(Path::new(""))).map_err(|message| RpcError::new(codes::FORBIDDEN, message))?;
        let path = dest.join(&part);
        if std::fs::symlink_metadata(&path).is_ok() {
            kept.push(rel);
            continue;
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| conflict(format!("Kybern could not create the folder for {rel}: {error}")))?;
        }
        write_private(&path, &contents).map_err(|error| conflict(format!("Kybern could not write {rel}: {error}")))?;
        written.push(rel);
    }
    Ok((written, kept))
}

/// A new file only its owner reads (never one that exists): 0600, or an owner-only ACL on Windows set
/// before anything is written to it.
fn write_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    #[cfg(windows)]
    if let Err(error) = crate::network::keys::restrict_to_current_user(path) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    file.write_all(contents)?;
    file.flush()
}

fn queued(
    item: OutboxItem,
    target: &RemoteTarget,
    project: &Project,
    path: Option<String>,
    env_files: Vec<String>,
    approved_by: &'static str,
) -> AgentProvision {
    AgentProvision::Queued {
        item: Box::new(item),
        target_name: target.name.clone(),
        project_name: project.name.clone(),
        path,
        env_files,
        approved_by,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_paths_compare_without_case_or_the_verbatim_prefix() {
        let simple = |text: &str| kybern_git::simplify_path(Path::new(text));
        // What `canonicalize` gives for the data folder must match the way people spell a project path.
        let data = simple(r"\\?\D:\kybern\network-test");
        assert!(path_starts(true, &simple(r"d:\Kybern\Network-Test\x"), &data));
        assert!(path_starts(true, &data, &simple(r"D:\kybern")), "a folder that holds the data folder");
        assert!(!path_starts(true, &simple(r"D:\kybern\network-tests\x"), &data), "a sibling with the same prefix");
        assert!(path_same(true, &simple(r"\\?\D:\Work"), &simple(r"d:\work")));
        // Spelled with `/`, with the prefix, or with a trailing separator, a system folder is still one.
        let system = Path::new(r"C:\ProgramData");
        for spelled in ["C:/ProgramData/new", r"\\?\C:\ProgramData\new", r"c:\programdata\", "C:/PROGRAMDATA"] {
            assert!(path_starts(true, Path::new(spelled), system), "{spelled}");
        }
        assert!(path_same(true, Path::new("D:/work/"), Path::new(r"\\?\d:\Work")));
    }

    /// A scratch folder outside the system folders the destination check refuses (`/var` holds the macOS temp folder).
    #[cfg(unix)]
    fn scratch() -> PathBuf {
        let base = std::env::var_os("CARGO_TARGET_TMPDIR").map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap());
        let dir = base.join(format!("kybern-provision-links-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn new_folders_are_checked_where_their_links_lead() {
        let root = scratch();
        let data = root.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(root.join("projects")).unwrap();
        std::os::unix::fs::symlink(&data, root.join("projects/link")).unwrap();
        let through = root.join("projects/link/new-project");
        let refused = resolve_destination(&through.to_string_lossy(), &data).unwrap_err();
        assert!(refused.contains("data folder"), "{refused}");
        assert!(resolve_destination(&root.join("projects/new-project").to_string_lossy(), &data).is_ok());
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn env_files_never_go_through_a_link_out_of_the_project() {
        let root = scratch();
        let (project, outside) = (root.join("project"), root.join("outside"));
        std::fs::create_dir_all(project.join("apps/web")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join(".env"), "OUTSIDE=1\n").unwrap();
        std::os::unix::fs::symlink(&outside, project.join("config")).unwrap();
        // The source never reads a file through a linked folder.
        assert!(inside(&project, Path::new("config/.env")).is_err());
        assert_eq!(inside(&project, Path::new("apps/web/.env")).unwrap(), project.join("apps/web/.env"));
        assert_eq!(inside(&project, Path::new("")).unwrap(), project);
        // The target never writes one there: not beside an existing file, and not as a new one.
        std::fs::remove_file(outside.join(".env")).unwrap();
        let refused = write_env_files(&project, vec![("config/.env".into(), b"A=1\n".to_vec())]);
        assert!(refused.is_err());
        assert!(!outside.join(".env").exists(), "nothing was written outside the project");
        let refused = write_env_files(&project, vec![("config/deeper/.envrc".into(), b"A=1\n".to_vec())]);
        assert!(refused.is_err());
        assert!(!outside.join("deeper").exists());
        let (written, kept) = write_env_files(&project, vec![("apps/web/.env".into(), b"A=1\n".to_vec())]).unwrap();
        assert_eq!((written, kept), (vec!["apps/web/.env".to_string()], Vec::new()));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(project.join("apps/web/.env")).unwrap().permissions().mode() & 0o777, 0o600);
        // A project folder that is itself a link is fine: only links below it lead out.
        std::os::unix::fs::symlink(&project, root.join("alias")).unwrap();
        assert!(inside(&root.join("alias"), Path::new("apps/web/.env")).is_ok());
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(windows)]
    #[test]
    fn env_files_get_an_owner_only_acl_on_windows() {
        let dir = std::env::temp_dir().join(format!("kybern-provision-acl-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        // A folder everyone may read, whose files inherit that.
        let icacls = |args: &[&str]| {
            let out = std::process::Command::new("icacls").arg(&dir).args(args).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stdout));
        };
        icacls(&["/grant", "*S-1-1-0:(OI)(CI)R"]);
        let plain = dir.join("plain.txt");
        std::fs::write(&plain, "x").unwrap();
        let sids = |path: &Path| {
            let out = std::process::Command::new("powershell")
                .args(["-NoProfile", "-Command"])
                .arg(format!("(Get-Acl -LiteralPath '{}').Access | ForEach-Object {{ $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }}", path.display()))
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).into_owned()
        };
        assert!(sids(&plain).contains("S-1-1-0"), "the folder passes Everyone on: {}", sids(&plain));
        let env = dir.join(".env");
        write_private(&env, b"SECRET=1\n").unwrap();
        let granted = sids(&env);
        assert!(!granted.contains("S-1-1-0"), "{granted}");
        assert_eq!(granted.lines().filter(|line| !line.trim().is_empty()).count(), 1, "only the owner: {granted}");
        assert_eq!(std::fs::read_to_string(&env).unwrap(), "SECRET=1\n");
        assert!(write_private(&env, b"OTHER=1\n").is_err(), "never overwrites");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(windows)]
    #[test]
    fn the_proposed_folder_never_lands_inside_the_data_folder_on_windows() {
        let data = std::env::temp_dir().join(format!("kybern-provision-data-{}", Uuid::now_v7()));
        std::fs::create_dir_all(&data).unwrap();
        let verbatim = std::fs::canonicalize(&data).unwrap();
        assert!(verbatim.to_string_lossy().starts_with(r"\\?\"), "canonicalize adds the prefix");
        assert!(resolve_destination(&data.join("x").to_string_lossy(), &data).is_err(), "inside the data folder");
        assert!(resolve_destination(&data.to_string_lossy().to_uppercase(), &data).is_err(), "different case");
        let project = |path: &Path| {
            let now = Utc::now();
            Project {
                repo: None,
                repos: Vec::new(),
                id: Uuid::now_v7(),
                name: "p".into(),
                path: path.to_string_lossy().into_owned(),
                is_git: true,
                worktrees_default: None,
                task_prefix: None,
                brief_in_all_threads: false,
                coordinator: None,
                space_id: None,
                created_at: now,
                updated_at: now,
                kind: ProjectKind::Single,
                members: Vec::new(),
                worktree_copy: Vec::new(),
                instructions_offer_dismissed: false,
            }
        };
        let inside = [project(&data.join("a")), project(&data.join("b"))];
        let parent = projects_parent(&inside, &data).expect("falls back to home");
        assert!(!path_starts(true, &parent, &simple_canonical(&data)), "{parent:?}");
        std::fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn destinations_refuse_roots_home_and_system_folders() {
        let data = std::env::temp_dir().join(format!("kybern-provision-data-{}", Uuid::now_v7()));
        let home = home_dir().unwrap();
        assert!(resolve_destination("", &data).is_err());
        assert!(resolve_destination("projects/x", &data).is_err(), "relative");
        assert!(resolve_destination("~", &data).is_err(), "home itself");
        assert!(resolve_destination(&home.parent().unwrap().to_string_lossy(), &data).is_err(), "above home");
        assert!(resolve_destination("~/projects/../x", &data).is_err(), "dot-dot");
        assert_eq!(resolve_destination("~/projects/kybern", &data).unwrap(), home.join("projects/kybern"));
        assert!(resolve_destination(&data.join("x").to_string_lossy(), &data).is_err(), "the data dir");
        if cfg!(unix) {
            assert!(resolve_destination("/", &data).is_err());
            assert!(resolve_destination("/usr/local/src/x", &data).is_err());
            assert!(resolve_destination("/etc/kybern", &data).is_err());
        }
        if cfg!(windows) {
            assert!(resolve_destination(r"C:\", &data).is_err());
            assert!(resolve_destination(r"c:\windows\x", &data).is_err());
            assert!(resolve_destination(r"D:\code\kybern", &data).is_ok());
        }
    }

    #[test]
    fn relative_paths_stay_inside() {
        assert_eq!(safe_relative(".").unwrap(), PathBuf::new());
        assert_eq!(safe_relative("apps/web/.env").unwrap(), PathBuf::from("apps").join("web").join(".env"));
        for bad in ["", "/etc/passwd", "../x", "a/../../b", ".git/config", "a\\b", "C:/x"] {
            assert!(safe_relative(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn env_names_and_credentials() {
        for name in [".env", ".env.local", ".env.production", "prod.env", ".envrc", ".dev.vars"] {
            assert!(is_env_name(name), "{name}");
        }
        for name in [".env.example", ".env.sample", ".env.template", "env.ts", "README.md"] {
            assert!(!is_env_name(name), "{name}");
        }
        assert_eq!(strip_credentials("https://user:token@github.com/o/r.git"), "https://github.com/o/r.git");
        assert_eq!(strip_credentials("git@github.com:o/r.git"), "git@github.com:o/r.git");
        assert_eq!(redact("fatal: could not read from https://x:secret@host/o/r"), "fatal: could not read from https://host/o/r");
        assert_eq!(folder_name("my/app: v2"), "my-app- v2");
        assert_eq!(folder_name(".."), "project");
    }

    #[tokio::test]
    async fn env_files_are_the_ignored_ones_without_templates_or_folders_like_node_modules() {
        let dir = std::env::temp_dir().join(format!("kybern-provision-env-{}", Uuid::now_v7()));
        std::fs::create_dir_all(dir.join("apps/web")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        let git = |args: &[&str]| {
            let out =
                std::process::Command::new("git").arg("-C").arg(&dir).args(args).env("GIT_CONFIG_GLOBAL", "/dev/null").output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        std::fs::write(dir.join(".gitignore"), ".env*\n!.env.example\nnode_modules/\n*.log\n").unwrap();
        std::fs::write(dir.join(".env"), "A=1\n").unwrap();
        std::fs::write(dir.join(".env.example"), "A=\n").unwrap();
        std::fs::write(dir.join("apps/web/.env.local"), "B=2\n").unwrap();
        std::fs::write(dir.join("node_modules/pkg/.env"), "C=3\n").unwrap();
        std::fs::write(dir.join("debug.log"), "x").unwrap();
        let found: Vec<String> = detect_env_files(&dir).await.into_iter().map(|file| file.path).collect();
        assert_eq!(found, vec![".env".to_string(), "apps/web/.env.local".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
