//! Group projects: a parent folder whose members are separate git repositories
//! inside it. This module owns the project side: adding a group, validating and
//! replacing its members and its worktree copy list, scanning a folder for
//! candidate repositories, live member status, the optional shared instruction
//! files, and the repository note every group session receives.
//!
//! Members are stored as '/'-separated paths relative to the group folder, "."
//! for the folder itself, primary first ("." when present, then by path).
//! Paths are compared as components so Windows works too; nothing here uses
//! Unix-only APIs or follows symlinks.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::Utc;
use futures::StreamExt;
use kybern_git::Repo;
use kybern_protocol::methods::{
    CopyCandidate, MemberState, ProjectsInstructionsCreateResult, ProjectsMembersStatusResult, ProjectsScanReposParams,
    ProjectsScanReposResult, RejectedFolder, RepoCandidate,
};
use kybern_protocol::rpc::{RpcError, codes};
use kybern_protocol::{MemberStatus, Project, ProjectId, ProjectKind, ProjectMember, SpaceId, Thread, ThreadMember};
use kybern_store::{GROUP_FOLDER_MEMBER, folder_name, member_display_names};
use uuid::Uuid;

use super::Orchestrator;

/// Fewest members a group can have; "." counts as one.
const MIN_MEMBERS: usize = 2;
/// Most members a group can have.
const MAX_MEMBERS: usize = 64;
/// Scan bounds: candidates listed, folders visited, wall time.
const SCAN_MAX_CANDIDATES: usize = 200;
const SCAN_MAX_FOLDERS: usize = 20_000;
const SCAN_MAX_TIME: Duration = Duration::from_secs(10);
const SCAN_DEFAULT_DEPTH: u8 = 2;
const SCAN_MAX_DEPTH: u8 = 4;
/// Git probes run at once while scanning or reading member status.
const GIT_PARALLELISM: usize = 8;
/// Folders a scan never enters (the same list as the file index), plus every dot-folder.
const SCAN_SKIP: &[&str] = &["node_modules", "target", "dist", "build", "vendor", ".venv", "venv", "__pycache__", ".cache", ".next"];
/// Copied into every worktree container anyway, so never offered for `worktree_copy`.
const ALWAYS_COPIED: &[&str] = &["AGENTS.md", "CLAUDE.md", ".claude"];
/// Most entries offered for `worktree_copy`.
const COPY_CANDIDATES_MAX: usize = 500;
/// Members listed one by one in the repository note; the rest are summarized.
const NOTE_LISTED_MEMBERS: usize = 12;

fn invalid(message: impl Into<String>) -> RpcError {
    RpcError::new(codes::INVALID_PARAMS, message.into())
}

fn internal(error: impl std::fmt::Display) -> RpcError {
    RpcError::internal(error)
}

fn plural(count: usize, one: &str, other: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { other })
}

/// "a, b and c".
fn join_names(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// `.git` (a folder, or a file for linked worktrees and submodules) is present.
fn has_git(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join(".git")).is_ok()
}

/// The live state of one member folder, from the file system alone.
pub(crate) fn probe_member(folder: &Path, path: &str) -> MemberStatus {
    let dir = member_dir(folder, path);
    match std::fs::metadata(&dir) {
        Ok(meta) if meta.is_dir() => {
            if has_git(&dir) {
                MemberStatus::Ok
            } else {
                MemberStatus::NotGit
            }
        }
        _ => MemberStatus::Missing,
    }
}

/// The absolute folder of a member path.
pub(crate) fn member_dir(folder: &Path, path: &str) -> PathBuf {
    if path == GROUP_FOLDER_MEMBER { folder.to_path_buf() } else { path.split('/').fold(folder.to_path_buf(), |dir, part| dir.join(part)) }
}

/// The folder a pull request call of `project` runs in: the project folder for
/// a single repository, else the folder of the member `repo`. A group call must
/// name its member: defaulting to the primary would let a client from before
/// member tags open, approve or close the primary's pull request of that number.
pub(crate) fn pr_repo_dir(project: &Project, repo: Option<&str>) -> Result<PathBuf, String> {
    let folder = Path::new(&project.path);
    if project.kind != ProjectKind::Group {
        return match repo {
            None => Ok(folder.to_path_buf()),
            Some(_) => Err(format!("{} is a single repository, so pull requests take no repo.", project.name)),
        };
    }
    let member = match repo {
        Some(repo) => {
            project.members.iter().find(|m| m.path == repo).ok_or_else(|| format!("{repo} isn't a repository of {}.", project.name))?
        }
        None if project.members.is_empty() => return Err(format!("{} has no repositories yet. Add one in its settings.", project.name)),
        None => {
            return Err(format!(
                "{} has several repositories, so this pull request needs its repository. Update Kybern on this device, then open it again.",
                project.name
            ));
        }
    };
    match probe_member(folder, &member.path) {
        MemberStatus::Ok => Ok(member_dir(folder, &member.path)),
        MemberStatus::Missing => {
            Err(format!("{} is missing from {}. Restore the folder or remove it in the project's settings.", member.name, project.name))
        }
        MemberStatus::NotGit => {
            Err(format!("{} is no longer a git repository. Restore its .git folder or remove it in the project's settings.", member.name))
        }
    }
}

/// '/'-separated relative form of `dir` inside `folder`, "." for the folder itself.
fn relative_member(folder: &Path, dir: &Path) -> Option<String> {
    let rest = dir.strip_prefix(folder).ok()?;
    let parts: Vec<String> = rest
        .components()
        .map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Option<_>>()?;
    Some(if parts.is_empty() { GROUP_FOLDER_MEMBER.to_string() } else { parts.join("/") })
}

/// Primary first: "." when present, then by path.
fn order_members(paths: &mut Vec<String>) {
    paths.sort_by(|a, b| match (a == GROUP_FOLDER_MEMBER, b == GROUP_FOLDER_MEMBER) {
        (true, true) => std::cmp::Ordering::Equal,
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        (false, false) => a.cmp(b),
    });
    paths.dedup();
}

/// When `dir` is a submodule (its `.git` file points into a `modules` folder of
/// another repository), the folder of that repository.
fn submodule_parent(dir: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(dir.join(".git")).ok()?;
    let target = text.lines().find_map(|line| line.strip_prefix("gitdir:"))?.trim();
    let target = if Path::new(target).is_absolute() { PathBuf::from(target) } else { dir.join(target) };
    // `<super>/.git/modules/<name>`: everything before the `.git` component is the superproject.
    let parts: Vec<Component> = target.components().collect();
    let modules = parts.windows(2).rposition(|pair| pair[0].as_os_str() == ".git" && pair[1].as_os_str() == "modules")?;
    let mut parent = PathBuf::new();
    for part in &parts[..modules] {
        parent.push(part.as_os_str());
    }
    Some(std::fs::canonicalize(&parent).unwrap_or(parent))
}

/// The display path of a submodule's superproject: its member form when it is
/// inside the folder, else its folder name.
fn submodule_of(folder: &Path, dir: &Path) -> Option<String> {
    let parent = submodule_parent(dir)?;
    Some(relative_member(folder, &parent).unwrap_or_else(|| folder_name(&parent.to_string_lossy())))
}

/// Why `raw` can't be a member of `folder`, or its normalized member path.
fn normalize_member(folder: &Path, folder_label: &str, raw: &str) -> Result<String, String> {
    let raw = raw.trim().trim_end_matches(['/', '\\']);
    let outside = || format!("Pick a folder inside {folder_label}. Folders outside the group can't be added yet.");
    if raw.is_empty() {
        return Err(outside());
    }
    if raw == GROUP_FOLDER_MEMBER {
        return Ok(GROUP_FOLDER_MEMBER.to_string());
    }
    let candidate = Path::new(raw);
    if !candidate.is_absolute()
        && candidate.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir))
    {
        return Err(outside());
    }
    let joined = if candidate.is_absolute() { candidate.to_path_buf() } else { folder.join(candidate) };
    let canonical = std::fs::canonicalize(&joined).map_err(|_| format!("Kybern can't find {raw} in {folder_label}."))?;
    relative_member(folder, &canonical).ok_or_else(outside)
}

/// Why `path` (normalized) can't be a member, checked on disk.
fn member_problem(folder: &Path, folder_label: &str, path: &str) -> Option<String> {
    let dir = member_dir(folder, path);
    if path == GROUP_FOLDER_MEMBER {
        return (!has_git(&dir)).then(|| format!("{folder_label} isn't a git repository, so it can't be a member itself."));
    }
    if !dir.is_dir() {
        return Some(format!("Kybern can't find {path} in {folder_label}."));
    }
    if !has_git(&dir) {
        return Some(format!("{path} isn't a git repository. Pick a folder that contains one."));
    }
    if let Some(parent) = submodule_of(folder, &dir) {
        let parent = if parent == GROUP_FOLDER_MEMBER { folder_label.to_string() } else { parent };
        return Some(format!("{path} is a submodule of {parent}. Add {parent} instead."));
    }
    None
}

/// Normalize, validate and order a member list. Members already stored on the
/// project (`kept`) skip the disk checks, so a missing one doesn't block other edits.
pub(crate) fn validate_members(folder: &Path, folder_label: &str, raw: &[String], kept: &HashSet<String>) -> Result<Vec<String>, RpcError> {
    let mut paths = Vec::with_capacity(raw.len());
    for entry in raw {
        let path = if kept.contains(entry.as_str()) {
            entry.clone()
        } else {
            let path = normalize_member(folder, folder_label, entry).map_err(invalid)?;
            if !kept.contains(&path)
                && let Some(problem) = member_problem(folder, folder_label, &path)
            {
                return Err(invalid(problem));
            }
            path
        };
        paths.push(path);
    }
    order_members(&mut paths);
    for (index, path) in paths.iter().enumerate() {
        if path == GROUP_FOLDER_MEMBER {
            continue;
        }
        if let Some(outer) = paths[..index].iter().find(|outer| *outer != GROUP_FOLDER_MEMBER && path.starts_with(&format!("{outer}/"))) {
            return Err(invalid(format!("{path} is inside {outer}. Pick one of them.")));
        }
    }
    if paths.len() < MIN_MEMBERS {
        let missing = MIN_MEMBERS - paths.len();
        return Err(invalid(if paths.is_empty() {
            "Select at least 2 repositories.".to_string()
        } else {
            format!("Select {} more {}.", missing, if missing == 1 { "repository" } else { "repositories" })
        }));
    }
    if paths.len() > MAX_MEMBERS {
        return Err(invalid(format!("A group can have up to {MAX_MEMBERS} repositories.")));
    }
    Ok(paths)
}

/// Validate a `worktree_copy` list: top-level entries of the folder, never a
/// member (or a folder holding one) and never `.git`. Entries already stored stay
/// even when they are gone now; copying skips those.
pub(crate) fn validate_worktree_copy(project: &Project, raw: &[String]) -> Result<Vec<String>, RpcError> {
    let folder = Path::new(&project.path);
    let member_roots: HashSet<&str> =
        project.members.iter().filter(|m| m.path != GROUP_FOLDER_MEMBER).map(|m| m.path.split('/').next().unwrap_or(&m.path)).collect();
    let mut entries: Vec<String> = Vec::with_capacity(raw.len());
    for entry in raw {
        let name = entry.trim();
        if entries.iter().any(|known| known == name) {
            continue;
        }
        let single = Path::new(name).components().count() == 1 && matches!(Path::new(name).components().next(), Some(Component::Normal(_)));
        if name.is_empty() || !single || name.contains(['/', '\\']) {
            return Err(invalid(format!("Pick a file or folder at the top of {}.", project.name)));
        }
        if name == ".git" {
            return Err(invalid(".git can't be copied into worktrees."));
        }
        if member_roots.contains(name) {
            return Err(invalid(format!("{name} holds a repository of this group, which gets its own worktree.")));
        }
        if ALWAYS_COPIED.contains(&name) {
            continue;
        }
        if !project.worktree_copy.iter().any(|known| known == name) && std::fs::symlink_metadata(folder.join(name)).is_err() {
            return Err(invalid(format!("Kybern can't find {name} in {}.", project.name)));
        }
        entries.push(name.to_string());
    }
    Ok(entries)
}

/// Top-level entries the "Also copy into worktrees" picker offers, sorted by name.
fn copy_candidates(project: &Project) -> Vec<CopyCandidate> {
    let member_roots: HashSet<&str> = project.members.iter().map(|m| m.path.split('/').next().unwrap_or(&m.path)).collect();
    let Ok(reader) = std::fs::read_dir(&project.path) else { return Vec::new() };
    let mut out: Vec<CopyCandidate> = reader
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let kind = entry.file_type().ok()?;
            // Symlinks are never copied, so never offered.
            if kind.is_symlink()
                || name == ".git"
                || name == ".DS_Store"
                || member_roots.contains(name.as_str())
                || ALWAYS_COPIED.contains(&name.as_str())
            {
                return None;
            }
            Some(CopyCandidate { name, is_dir: kind.is_dir() })
        })
        .take(COPY_CANDIDATES_MAX)
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    out
}

/// The current branch, or the short SHA (and `detached`) when HEAD is detached.
async fn branch_of(dir: &Path) -> (Option<String>, bool) {
    let repo = Repo::new(dir);
    if let Some(branch) = repo.current_branch().await {
        return (Some(branch), false);
    }
    match repo.output(&["rev-parse", "--short", "HEAD"]).await {
        Ok(out) if out.success && !out.stdout.is_empty() => (Some(out.stdout), true),
        _ => (None, false),
    }
}

/// The member's own instruction file relative to the group folder, `AGENTS.md` first.
fn instruction_file(folder: &Path, path: &str) -> Option<String> {
    let dir = member_dir(folder, path);
    ["AGENTS.md", "CLAUDE.md"]
        .into_iter()
        .find(|file| dir.join(file).is_file())
        .map(|file| if path == GROUP_FOLDER_MEMBER { file.to_string() } else { format!("{path}/{file}") })
}

/// One pass of the scan: candidate folders (relative paths) below `root`, plus
/// whether a bound stopped it. Runs on a blocking thread; never follows symlinks.
fn walk_repos(root: &Path, depth: u8) -> (Vec<String>, bool) {
    let started = Instant::now();
    let mut found = Vec::new();
    let mut truncated = false;
    let mut visited = 0usize;
    let mut queue: VecDeque<(PathBuf, u8)> = VecDeque::from([(root.to_path_buf(), 0)]);
    if has_git(root) {
        found.push(GROUP_FOLDER_MEMBER.to_string());
    }
    'walk: while let Some((dir, level)) = queue.pop_front() {
        let Ok(reader) = std::fs::read_dir(&dir) else { continue };
        let mut children: Vec<(String, PathBuf)> = reader
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
            .filter(|(name, _)| !name.starts_with('.') && !SCAN_SKIP.contains(&name.as_str()))
            .collect();
        children.sort();
        for (_, child) in children {
            visited += 1;
            if visited > SCAN_MAX_FOLDERS || found.len() >= SCAN_MAX_CANDIDATES || started.elapsed() > SCAN_MAX_TIME {
                truncated = true;
                break 'walk;
            }
            if has_git(&child) {
                if let Some(path) = relative_member(root, &child) {
                    found.push(path);
                }
            } else if level + 1 < depth {
                queue.push_back((child, level + 1));
            }
        }
    }
    (found, truncated)
}

impl Orchestrator {
    /// `projects.add` with `kind: group`. An existing project at the folder is
    /// returned unchanged, as for single projects.
    pub fn add_group_project(
        &self,
        path: String,
        name: Option<String>,
        space_id: Option<SpaceId>,
        members: Vec<String>,
    ) -> Result<Project, RpcError> {
        let folder = std::fs::canonicalize(&path).map_err(|_| invalid(format!("Kybern can't find the folder {path}.")))?;
        if !folder.is_dir() {
            return Err(invalid(format!("{} is not a folder.", folder.display())));
        }
        let folder_path = folder.to_string_lossy().into_owned();
        if let Some(space_id) = space_id
            && self.inner.store.space_get(space_id).map_err(internal)?.is_none()
        {
            return Err(RpcError::not_found("space"));
        }
        if let Some(existing) = self.inner.store.project_by_path(&folder_path).map_err(internal)? {
            if existing.kind != ProjectKind::Group {
                return Err(invalid(format!(
                    "{} is already a single-repository project. Open it from the sidebar, or choose another folder for the group.",
                    existing.name
                )));
            }
            return Ok(existing);
        }
        let label = folder_name(&folder_path);
        let paths = validate_members(&folder, &label, &members, &HashSet::new())?;
        let now = Utc::now();
        let names = member_display_names(&folder_path, &paths.iter().map(String::as_str).collect::<Vec<_>>());
        let project = Project {
            id: Uuid::now_v7(),
            name: name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| label.clone()),
            is_git: paths.iter().any(|p| p == GROUP_FOLDER_MEMBER),
            path: folder_path,
            worktrees_default: None,
            task_prefix: None,
            brief_in_all_threads: false,
            coordinator: None,
            space_id,
            created_at: now,
            updated_at: now,
            kind: ProjectKind::Group,
            members: paths
                .iter()
                .zip(names)
                .map(|(path, name)| ProjectMember { path: path.clone(), name, status: MemberStatus::Ok })
                .collect(),
            worktree_copy: Vec::new(),
            instructions_offer_dismissed: false,
        };
        if let Err(error) = self.inner.store.project_insert(&project) {
            if let Some(existing) = self.inner.store.project_by_path(&project.path).map_err(internal)? {
                return Ok(existing);
            }
            return Err(internal(error));
        }
        self.publish_projects();
        Ok(self.inner.store.project_get(project.id).map_err(internal)?.unwrap_or(project))
    }

    /// Validate the group-only fields of `projects.update` and apply them to
    /// `project` in memory. Returns the new member list for the caller to store
    /// once every other field has been validated too.
    pub fn apply_group_update(
        &self,
        project: &mut Project,
        members: Option<Vec<String>>,
        worktree_copy: Option<Vec<String>>,
        instructions_offer_dismissed: Option<bool>,
    ) -> Result<Option<Vec<String>>, RpcError> {
        if project.kind != ProjectKind::Group && (members.is_some() || worktree_copy.is_some() || instructions_offer_dismissed.is_some()) {
            return Err(invalid("Only group projects have repositories."));
        }
        let mut stored = None;
        if let Some(members) = members {
            let folder = PathBuf::from(&project.path);
            let kept: HashSet<String> = project.members.iter().map(|m| m.path.clone()).collect();
            let paths = validate_members(&folder, &project.name, &members, &kept)?;
            project.is_git = paths.iter().any(|p| p == GROUP_FOLDER_MEMBER) && has_git(&folder);
            let names = member_display_names(&project.path, &paths.iter().map(String::as_str).collect::<Vec<_>>());
            project.members = paths
                .iter()
                .zip(names)
                .map(|(path, name)| ProjectMember { path: path.clone(), name, status: probe_member(&folder, path) })
                .collect();
            stored = Some(paths);
        }
        if let Some(entries) = worktree_copy {
            project.worktree_copy = validate_worktree_copy(project, &entries)?;
        }
        if let Some(dismissed) = instructions_offer_dismissed {
            project.instructions_offer_dismissed = dismissed;
        }
        Ok(stored)
    }

    /// Re-probe a group's members. Returns whether a stored status changed.
    pub(super) fn refresh_group_members(&self, project: &Project) -> anyhow::Result<bool> {
        let folder = Path::new(&project.path);
        let mut changed = false;
        for member in &project.members {
            changed |= self.inner.store.project_set_member_status(project.id, &member.path, probe_member(folder, &member.path))?;
        }
        let is_git = project.members.iter().any(|m| m.path == GROUP_FOLDER_MEMBER) && has_git(folder);
        changed |= self.inner.store.project_set_git_status(project.id, is_git)?;
        Ok(changed)
    }

    /// `projects.scan_repos`: candidate members below a folder.
    pub async fn scan_repos(&self, params: ProjectsScanReposParams) -> Result<ProjectsScanReposResult, RpcError> {
        let raw = params.path.trim();
        let home = directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_owned());
        let root = match raw {
            "~" => home.clone().ok_or_else(|| invalid("Enter an absolute folder path."))?,
            value if value.starts_with("~/") => home.ok_or_else(|| invalid("Enter an absolute folder path."))?.join(&value[2..]),
            value => PathBuf::from(value),
        };
        if !root.is_absolute() {
            return Err(invalid("Enter an absolute folder path."));
        }
        let root = tokio::fs::canonicalize(&root).await.map_err(|_| invalid(format!("Kybern can't find the folder {raw}.")))?;
        if !root.is_dir() {
            return Err(invalid(format!("{} is not a folder.", root.display())));
        }
        let depth = params.depth.unwrap_or(SCAN_DEFAULT_DEPTH).clamp(1, SCAN_MAX_DEPTH);
        let root_path = root.to_string_lossy().into_owned();
        let label = folder_name(&root_path);
        let include = params.include.clone();
        let (found, truncated, added, rejected) = {
            let root = root.clone();
            let label = label.clone();
            tokio::task::spawn_blocking(move || {
                let (mut found, truncated) = walk_repos(&root, depth);
                let mut added = Vec::new();
                let mut rejected = Vec::new();
                for entry in include {
                    let path = match normalize_member(&root, &label, &entry) {
                        Ok(path) => path,
                        Err(reason) => {
                            rejected.push(RejectedFolder { path: entry, reason });
                            continue;
                        }
                    };
                    if let Some(reason) = member_problem(&root, &label, &path) {
                        rejected.push(RejectedFolder { path, reason });
                    } else if !found.contains(&path) {
                        found.push(path.clone());
                        added.push(path);
                    }
                }
                (found, truncated, added, rejected)
            })
            .await
            .map_err(internal)?
        };
        let mut paths = found;
        order_members(&mut paths);
        let projects: HashMap<String, ProjectId> = self
            .inner
            .store
            .projects_list()
            .map_err(internal)?
            .into_iter()
            .filter(|p| p.kind == ProjectKind::Single)
            .map(|p| (p.path, p.id))
            .collect();
        let names = member_display_names(&root_path, &paths.iter().map(String::as_str).collect::<Vec<_>>());
        let candidates: Vec<RepoCandidate> = futures::stream::iter(paths.into_iter().zip(names))
            .map(|(path, name)| {
                let dir = member_dir(&root, &path);
                let added = added.contains(&path);
                let project_id = projects.get(&dir.to_string_lossy().into_owned()).copied();
                let root = root.clone();
                async move {
                    let (branch, detached) = branch_of(&dir).await;
                    let submodule_of = if path == GROUP_FOLDER_MEMBER { None } else { submodule_of(&root, &dir) };
                    RepoCandidate { path, name, branch, detached, submodule_of, project_id, added }
                }
            })
            .buffered(GIT_PARALLELISM)
            .collect()
            .await;
        Ok(ProjectsScanReposResult {
            existing_project_id: self.inner.store.project_by_path(&root_path).map_err(internal)?.map(|p| p.id),
            is_git: has_git(&root),
            name: label,
            path: root_path,
            candidates,
            rejected,
            truncated,
        })
    }

    /// `projects.members.status`: live state of each member, the shared files and
    /// the copy candidates. Persists changed member statuses as a side effect.
    pub async fn members_status(&self, project_id: ProjectId) -> Result<ProjectsMembersStatusResult, RpcError> {
        let project = self.inner.store.project_get(project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
        if project.kind != ProjectKind::Group {
            return Err(invalid("Only group projects have repositories."));
        }
        if self.refresh_group_members(&project).map_err(internal)? {
            self.publish_projects();
        }
        let folder = PathBuf::from(&project.path);
        let nested = project_member_paths(&project.members);
        let members: Vec<MemberState> = futures::stream::iter(project.members.clone())
            .map(|member| {
                let folder = folder.clone();
                let nested = nested.clone();
                async move {
                    let status = probe_member(&folder, &member.path);
                    let dir = member_dir(&folder, &member.path);
                    let mut state = MemberState {
                        instructions: instruction_file(&folder, &member.path),
                        path: member.path,
                        name: member.name,
                        status,
                        branch: None,
                        detached: false,
                        dirty_files: 0,
                        remote_url: None,
                    };
                    if status == MemberStatus::Ok {
                        let repo = Repo::new(&dir);
                        (state.branch, state.detached) = branch_of(&dir).await;
                        state.dirty_files = dirty_files(&repo, state.path == GROUP_FOLDER_MEMBER, &nested).await;
                        state.remote_url = repo.config_get("remote.origin.url").await;
                    }
                    state
                }
            })
            .buffered(GIT_PARALLELISM)
            .collect()
            .await;
        Ok(ProjectsMembersStatusResult {
            members,
            agents_md: folder.join("AGENTS.md").is_file(),
            claude_md: folder.join("CLAUDE.md").is_file(),
            copy_candidates: copy_candidates(&project),
        })
    }

    /// `projects.instructions.create`: write the group folder's missing shared
    /// files. Never overwrites; Kybern never edits them afterwards.
    pub fn create_group_instructions(&self, project_id: ProjectId) -> Result<ProjectsInstructionsCreateResult, RpcError> {
        let project = self.inner.store.project_get(project_id).map_err(internal)?.ok_or_else(|| RpcError::not_found("project"))?;
        if project.kind != ProjectKind::Group {
            return Err(invalid("Only group projects get shared instructions."));
        }
        let folder = PathBuf::from(&project.path);
        let mut created = Vec::new();
        let write = |file: &str, text: &str| -> Result<(), RpcError> {
            use std::io::Write;
            let mut handle = std::fs::OpenOptions::new().write(true).create_new(true).open(folder.join(file)).map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    invalid(format!("{file} already exists in {}. Open it to edit.", project.name))
                } else {
                    invalid(format!("Kybern couldn't write {file} in {}: {error}", project.name))
                }
            })?;
            handle.write_all(text.as_bytes()).map_err(internal)
        };
        if !folder.join("AGENTS.md").exists() {
            write("AGENTS.md", &instructions_template(&project))?;
            created.push("AGENTS.md".to_string());
        }
        if !folder.join("CLAUDE.md").exists() {
            write("CLAUDE.md", "@AGENTS.md\n")?;
            created.push("CLAUDE.md".to_string());
        }
        Ok(ProjectsInstructionsCreateResult { created })
    }

    /// The members a session describes: the thread's own snapshot; else, for a
    /// delegated child in its parent's workspace, the parent's; else, for a thread
    /// working in a group folder itself (a Coordinator, or one started before group
    /// snapshots existed), the project's current members.
    pub(super) fn note_members(&self, thread: &Thread) -> anyhow::Result<Vec<ThreadMember>> {
        if !thread.members.is_empty() {
            return Ok(thread.members.clone());
        }
        if let Some(parent_id) = thread.parent_thread_id
            && thread.subagent.is_none()
            && let Some(parent) = self.inner.store.thread_get(parent_id)?
            && parent.cwd == thread.cwd
            && !parent.members.is_empty()
        {
            return Ok(parent.members);
        }
        let Some(project) = self.inner.store.project_get(thread.project_id)? else { return Ok(Vec::new()) };
        if project.kind != ProjectKind::Group || thread.cwd != project.path {
            return Ok(Vec::new());
        }
        let folder = Path::new(&project.path);
        Ok(project
            .members
            .iter()
            .map(|member| {
                let missing = probe_member(folder, &member.path) != MemberStatus::Ok;
                ThreadMember {
                    path: member.path.clone(),
                    name: member.name.clone(),
                    included: !missing,
                    source_path: member_dir(folder, &member.path).to_string_lossy().into_owned(),
                    worktree: None,
                    base_branch: None,
                    base_commit: None,
                    worktree_state: None,
                    missing,
                }
            })
            .collect())
    }

    /// The repository note for a group session, or `None` for single-repo threads.
    pub(super) fn repository_note(&self, thread: &Thread) -> anyhow::Result<Option<String>> {
        let members = self.note_members(thread)?;
        if members.is_empty() {
            return Ok(None);
        }
        let folder_label = match self.inner.store.project_get(thread.project_id)? {
            Some(project) => folder_name(&project.path),
            None => folder_name(&thread.cwd),
        };
        let cwd = Path::new(&thread.cwd);
        let instructions: Vec<Option<String>> = members.iter().map(|member| instruction_file(cwd, &member.path)).collect();
        let worktree_branch = thread.worktree.as_ref().map(|w| w.branch.as_str());
        Ok(Some(render_repository_note(&members, &instructions, &folder_label, worktree_branch)))
    }
}

/// Paths of every member, for excluding nested members from the "." member's counts.
fn project_member_paths(members: &[ProjectMember]) -> Vec<String> {
    members.iter().filter(|m| m.path != GROUP_FOLDER_MEMBER).map(|m| m.path.clone()).collect()
}

/// Uncommitted files of a member. The "." member leaves nested members out.
async fn dirty_files(repo: &Repo, is_folder: bool, nested: &[String]) -> u32 {
    let mut args: Vec<String> = vec!["status".into(), "--porcelain".into()];
    if is_folder && !nested.is_empty() {
        args.push("--".into());
        args.push(".".into());
        args.extend(nested.iter().map(|path| format!(":(exclude,literal){path}")));
    }
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    match repo.output(&args).await {
        Ok(out) if out.success => out.stdout.lines().filter(|line| !line.trim().is_empty()).count() as u32,
        _ => 0,
    }
}

/// The shared `AGENTS.md` offered for a group folder.
fn instructions_template(project: &Project) -> String {
    let folder = Path::new(&project.path);
    let folder_is_member = project.members.iter().any(|m| m.path == GROUP_FOLDER_MEMBER);
    let mut text = format!("# {}\n\n", project.name);
    text.push_str(if folder_is_member {
        "This folder is a git repository, and it also contains separate repositories nested inside it. Each has its own history, branches and pull requests.\n\n"
    } else {
        "This folder groups separate git repositories. Each has its own history, branches and pull requests.\n\n"
    });
    for member in project.members.iter().filter(|m| m.path != GROUP_FOLDER_MEMBER) {
        match instruction_file(folder, &member.path) {
            Some(file) => text.push_str(&format!("- `{}/`: instructions in `{file}`\n", member.path)),
            None => text.push_str(&format!("- `{}/`: no instructions file\n", member.path)),
        }
    }
    text.push_str("\nBefore you edit files in a repository, read its instructions file.\n");
    text.push_str(if folder_is_member {
        "Run git inside the repository you changed.\n"
    } else {
        "Run git inside the repository you changed; this folder is not a repository.\n"
    });
    text.push_str("A change across repositories needs a commit in each of them.\n");
    text
}

/// The repository note, from a thread's member snapshot and the instruction file
/// found for each member (relative to the working folder). Byte-stable for a
/// given input, so it can sit in a cached session prefix.
pub(crate) fn render_repository_note(
    members: &[ThreadMember],
    instructions: &[Option<String>],
    folder_label: &str,
    worktree_branch: Option<&str>,
) -> String {
    let available: Vec<(&ThreadMember, Option<&String>)> = members
        .iter()
        .zip(instructions.iter().map(Option::as_ref).chain(std::iter::repeat(None)))
        .filter(|(member, _)| member.included && !member.missing)
        .collect();
    let folder_is_member = available.iter().any(|(member, _)| member.path == GROUP_FOLDER_MEMBER);
    let mut text = String::from("## Repositories in this working folder\n");
    let count = available.len();
    if count == 1 {
        text.push_str("This folder holds 1 git repository for this chat. It has its own branches, commits and pull requests:\n");
    } else {
        text.push_str(&format!(
            "This folder holds {}. Each has its own branches, commits and pull requests:\n",
            plural(count, "separate git repository", "separate git repositories")
        ));
    }
    for (index, (member, file)) in available.iter().enumerate().take(NOTE_LISTED_MEMBERS) {
        let label = if member.path == GROUP_FOLDER_MEMBER {
            format!("./ ({folder_label}{})", if index == 0 { ", primary" } else { "" })
        } else {
            format!("{}/{}", member.path, if index == 0 { " (primary)" } else { "" })
        };
        match file {
            Some(file) => text.push_str(&format!("- {label}: read {file} before you edit files there.\n")),
            None => text.push_str(&format!("- {label}: no instructions file.\n")),
        }
    }
    if count > NOTE_LISTED_MEMBERS {
        let rest: Vec<String> = available[NOTE_LISTED_MEMBERS..].iter().map(|(member, _)| format!("{}/", member.path)).collect();
        text.push_str(&format!("- and {} more: {}.\n", rest.len(), rest.join(", ")));
    }
    if folder_is_member {
        text.push_str(&format!(
            "Run git commands inside a repository. The working folder is itself the repository {folder_label}; the others are separate repositories nested in it, not part of its history. A change across repositories needs a commit in each.\n"
        ));
    } else {
        text.push_str("Run git commands inside a repository; the working folder itself is not a repository. A change across repositories needs a commit in each.\n");
    }
    if let Some(branch) = worktree_branch {
        text.push_str(&format!("Each repository is a worktree on branch {branch}.\n"));
    }
    let deselected: Vec<String> = members
        .iter()
        .filter(|member| !member.included && !member.missing)
        .map(|member| format!("{} at {}", member.name, member.source_path))
        .collect();
    if !deselected.is_empty() {
        text.push_str(&format!("Not in this worktree; read only, do not edit: {}.\n", deselected.join(", ")));
    }
    let missing: Vec<String> = members.iter().filter(|member| member.missing).map(|member| member.name.clone()).collect();
    if !missing.is_empty() {
        let (verb, pronoun) = if missing.len() == 1 { ("was", "it is") } else { ("were", "they are") };
        text.push_str(&format!("{} {verb} missing when this chat started, so {pronoun} not available.\n", join_names(&missing)));
    }
    text.truncate(text.trim_end().len());
    text
}
