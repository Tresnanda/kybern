//! What changed in git since a Coordinator last looked.
//!
//! A Coordinator is one long session, and the code moves under it: children
//! commit, the user edits, branches get rewritten. Without a nudge it keeps
//! describing code that is gone. At the start of each turn the daemon compares
//! the heads it last told the lead about with the heads now and, when they
//! differ, puts a "Code changed since your last turn" block in front of the
//! provider's copy of the message. The block is never stored or shown.
//!
//! Tracked per repository (every member of a group project): the default
//! branch, the branches this lead's delegated children worked on in the last
//! 14 days, and the uncommitted state of the main checkout. The last-seen
//! heads live in `meta` as `lead_seen:{thread}:{repo_key}` = `{branch: sha}`;
//! the uncommitted state is a hash under the key [`UNCOMMITTED_KEY`] (a name
//! with a space cannot be a branch).
//!
//! A repository with no stored heads yet (the lead's first turn) is recorded
//! without a report, and so is a branch seen for the first time. A head is
//! marked seen only once the message that carried the report was accepted.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

use anyhow::Result;
use chrono::{Duration, Utc};
use kybern_git::{FileStatus, LogEntryWithFiles, Repo};
use kybern_protocol::*;

use super::{Orchestrator, group_git, lead_git};

/// Commits listed in one report, across every branch and repository.
const MAX_COMMITS: usize = 20;
/// Deleted or renamed paths listed by name in one report.
const MAX_PATHS: usize = 15;
/// Uncommitted paths listed by name in one report.
const MAX_UNCOMMITTED: usize = 10;
/// Commits shown from the tip of a branch whose history was rewritten.
const REWRITE_COMMITS: usize = 5;
/// How long a child's branch stays tracked after the child last worked on it.
const CHILD_BRANCH_DAYS: i64 = 14;
/// The most commits read from one branch before the rest is only counted.
const READ_COMMITS: usize = 100;
/// Key of the uncommitted-state hash in a repository's `{branch: sha}` map.
const UNCOMMITTED_KEY: &str = "uncommitted state";
const HEADER: &str = "Code changed since your last turn:";

/// Last-seen heads: repository key (the member path, `.` for a single
/// repository) to `{branch: sha}`.
pub(crate) type SeenHeads = HashMap<String, BTreeMap<String, String>>;

/// A report ready to send, with the heads to mark seen once it was delivered.
pub(super) struct ChangeReport {
    pub text: String,
    seen: SeenHeads,
}

/// One repository of the lead's project.
struct RepoRef {
    key: String,
    /// What the report calls it: the project's name, or the group member's.
    name: String,
    dir: PathBuf,
    /// Nested members the repository's own status must leave out.
    exclude: Vec<String>,
}

/// What is left of each cap while a report is written.
struct Budget {
    commits: usize,
    paths: usize,
    uncommitted: usize,
}

impl Orchestrator {
    /// The report for a Coordinator's next turn, or `None` when nothing changed
    /// since the heads it last saw (or this is its first look, which records
    /// them). Call `lead_change_seen` with the report once the message that
    /// carries it was accepted. Not a Coordinator: `None`.
    pub(super) async fn lead_change_report(&self, thread: &Thread) -> Result<Option<ChangeReport>> {
        if thread.coordinator_project_id.is_none() {
            return Ok(None);
        }
        let since = self.load_seen(thread).await?;
        let (lines, seen) = self.git_delta(thread, &since).await?;
        if lines.is_empty() {
            // Nothing to say, but first sights and clean-ups are still recorded.
            self.store_seen(thread, &seen)?;
            return Ok(None);
        }
        Ok(Some(ChangeReport { text: format!("{HEADER}\n{}", lines.join("\n")), seen }))
    }

    /// Mark a delivered report's heads as seen.
    pub(super) async fn lead_change_seen(&self, thread: &Thread, report: ChangeReport) {
        if let Err(error) = self.store_seen(thread, &report.seen) {
            tracing::warn!(thread_id = %thread.id, %error, "could not record the heads the Coordinator has seen");
        }
    }

    /// The git changes since `since` in the report's format (without the
    /// "Code changed since your last turn:" header), or `None` when there are
    /// none. Repositories absent from `since` have no baseline and are left
    /// out. For a fresh session's seed: pass the heads recorded at the last
    /// rotation (`lead_git_heads`).
    pub(crate) async fn git_delta_since(&self, thread: &Thread, since: &SeenHeads) -> Option<String> {
        let (lines, _) = self
            .git_delta(thread, since)
            .await
            .inspect_err(|error| tracing::warn!(thread_id = %thread.id, %error, "could not read the git changes"))
            .ok()?;
        (!lines.is_empty()).then(|| lines.join("\n"))
    }

    /// The heads of every repository of the lead's project as they are now,
    /// in the shape `git_delta_since` and `lead_git_mark_seen` take.
    pub(crate) async fn lead_git_heads(&self, thread: &Thread) -> SeenHeads {
        self.git_delta(thread, &SeenHeads::new()).await.map(|(_, heads)| heads).unwrap_or_default()
    }

    /// Record `heads` (from `lead_git_heads`) as what the Coordinator has been told.
    pub(crate) fn lead_git_mark_seen(&self, thread: &Thread, heads: &SeenHeads) -> Result<()> {
        self.store_seen(thread, heads)
    }

    /// The heads the Coordinator was last told about, for the rotation seed.
    pub(crate) async fn lead_seen_heads(&self, thread: &Thread) -> Result<SeenHeads> {
        self.load_seen(thread).await
    }

    async fn load_seen(&self, thread: &Thread) -> Result<SeenHeads> {
        let mut seen = SeenHeads::new();
        for repo in self.change_repos(thread)? {
            let stored = self.inner.store.meta_get(&seen_key(thread, &repo.key))?;
            if let Some(heads) = stored.and_then(|json| serde_json::from_str(&json).ok()) {
                seen.insert(repo.key, heads);
            }
        }
        Ok(seen)
    }

    fn store_seen(&self, thread: &Thread, seen: &SeenHeads) -> Result<()> {
        let rows =
            seen.iter().map(|(key, heads)| Ok((seen_key(thread, key), serde_json::to_string(heads)?))).collect::<Result<Vec<_>>>()?;
        let rows: Vec<(&str, &str)> = rows.iter().map(|(key, value)| (key.as_str(), value.as_str())).collect();
        self.inner.store.meta_set_many(&rows)
    }

    /// The repositories of the lead's project that exist on disk.
    fn change_repos(&self, thread: &Thread) -> Result<Vec<RepoRef>> {
        let project_id = thread.coordinator_project_id.unwrap_or(thread.project_id);
        let project = self.inner.store.project_get(project_id)?;
        let mut repos = Vec::new();
        match project.filter(|p| p.kind == ProjectKind::Group) {
            Some(project) => {
                let base = std::path::Path::new(&thread.cwd);
                for member in &project.members {
                    let dir = group_git::member_dir(base, &member.path);
                    if dir.join(".git").exists() {
                        let exclude = lead_git::nested_members(&project, &member.path);
                        repos.push(RepoRef { key: member.path.clone(), name: member.name.clone(), dir, exclude });
                    }
                }
            }
            None => {
                let dir = PathBuf::from(&thread.cwd);
                if dir.join(".git").exists() {
                    let name = self.inner.store.project_get(project_id)?.map(|p| p.name).unwrap_or_default();
                    repos.push(RepoRef { key: ".".into(), name, dir, exclude: Vec::new() });
                }
            }
        }
        Ok(repos)
    }

    /// Branches this lead's delegated children worked on in the last 14 days.
    fn recent_child_branches(&self, thread: &Thread) -> Result<Vec<String>> {
        let cutoff = Utc::now() - Duration::days(CHILD_BRANCH_DAYS);
        let mut branches: Vec<String> = Vec::new();
        for child in self.inner.store.delegation_children(thread.id)? {
            let Some(info) = child.delegation else { continue };
            let Some(branch) = info.branch.filter(|branch| !branch.is_empty()) else { continue };
            if info.completed_at.unwrap_or(info.started_at) >= cutoff && !branches.contains(&branch) {
                branches.push(branch);
            }
        }
        Ok(branches)
    }

    /// Report lines for everything that changed since `since`, and the heads now.
    async fn git_delta(&self, thread: &Thread, since: &SeenHeads) -> Result<(Vec<String>, SeenHeads)> {
        let children = self.recent_child_branches(thread)?;
        let mut budget = Budget { commits: MAX_COMMITS, paths: MAX_PATHS, uncommitted: MAX_UNCOMMITTED };
        let mut lines = Vec::new();
        let mut seen = SeenHeads::new();
        for repo_ref in self.change_repos(thread)? {
            let repo = Repo::new(&repo_ref.dir);
            let branches = tracked_branches(&repo, &children).await;
            let status = repo.status_porcelain(&repo_ref.exclude).await.unwrap_or_default();
            let state = uncommitted_state(&status);
            let mut heads: BTreeMap<String, String> = branches.iter().cloned().collect();
            heads.insert(UNCOMMITTED_KEY.into(), state.clone());
            if let Some(baseline) = since.get(&repo_ref.key) {
                let mut listed = HashSet::new();
                for (branch, sha) in &branches {
                    if let Some(old) = baseline.get(branch).filter(|old| *old != sha) {
                        lines.extend(branch_section(&repo, &repo_ref.name, branch, old, sha, &mut budget, &mut listed).await);
                    }
                }
                if !status.is_empty() && baseline.get(UNCOMMITTED_KEY) != Some(&state) {
                    lines.push(uncommitted_line(&repo_ref.name, &status, &mut budget));
                }
            }
            seen.insert(repo_ref.key, heads);
        }
        Ok((lines, seen))
    }
}

fn seen_key(thread: &Thread, repo_key: &str) -> String {
    format!("lead_seen:{}:{repo_key}", thread.id)
}

/// The default branch first, then the children's branches that still exist,
/// each with its tip.
async fn tracked_branches(repo: &Repo, children: &[String]) -> Vec<(String, String)> {
    let mut branches: Vec<(String, String)> = Vec::new();
    if let Some(name) = default_branch(repo).await
        && let Ok(sha) = repo.rev_parse(&name).await
    {
        branches.push((name, sha));
    }
    for name in children {
        if branches.iter().any(|(existing, _)| existing == name) {
            continue;
        }
        if let Ok(sha) = repo.rev_parse(&format!("refs/heads/{name}")).await {
            branches.push((name.clone(), sha));
        }
    }
    branches
}

/// The remote's default branch if it exists locally, else `main`, `master`,
/// else whatever is checked out.
async fn default_branch(repo: &Repo) -> Option<String> {
    let mut candidates: Vec<String> = repo.default_branch().await.into_iter().collect();
    candidates.extend(["main".to_string(), "master".to_string()]);
    for name in candidates {
        if repo.rev_parse(&format!("refs/heads/{name}")).await.is_ok() {
            return Some(name);
        }
    }
    repo.current_branch().await
}

/// A stable stand-in for the uncommitted state: "clean", or a hash of the status lines.
fn uncommitted_state(status: &[String]) -> String {
    if status.is_empty() {
        return "clean".into();
    }
    let mut sorted: Vec<&String> = status.iter().collect();
    sorted.sort();
    // FNV-1a: the same value in every build, unlike `DefaultHasher`.
    let hash = sorted
        .iter()
        .flat_map(|line| line.bytes().chain(*b"\n"))
        .fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3));
    format!("{hash:016x}")
}

/// The report lines for one branch that moved from `old` to `new`.
async fn branch_section(
    repo: &Repo,
    name: &str,
    branch: &str,
    old: &str,
    new: &str,
    budget: &mut Budget,
    listed: &mut HashSet<String>,
) -> Vec<String> {
    let (old7, new7) = (short(old), short(new));
    if repo.is_ancestor(old, new).await.unwrap_or(false) {
        let count = repo.count_range(old, new).await.unwrap_or(0);
        let entries = repo.log_range(old, new, count.clamp(1, READ_COMMITS)).await.unwrap_or_default();
        let (entries, duplicates) = split_listed(entries, listed);
        if entries.is_empty() && duplicates > 0 && duplicates >= count {
            // Everything here was already listed under another branch.
            return Vec::new();
        }
        let mut lines = vec![format!("- {name} · {branch}: {} ({old7}..{new7})", plural(count, "commit"))];
        let shown = push_commits(&mut lines, &entries, budget);
        let more = count.saturating_sub(shown + duplicates);
        if more > 0 {
            lines.push(format!("  - +{more} more (kybern_git log for the rest)"));
        }
        lines
    } else {
        // The old tip is gone or no longer an ancestor: history was rewritten.
        let entries = repo.log_range("", new, REWRITE_COMMITS).await.unwrap_or_default();
        let mut lines = vec![format!("- {name} · {branch}: history rewritten (was {old7}, now {new7}); last {} commits:", entries.len())];
        push_commits(&mut lines, &entries, budget);
        lines
    }
}

/// Drop (and count) commits already listed under an earlier branch.
fn split_listed(entries: Vec<LogEntryWithFiles>, listed: &mut HashSet<String>) -> (Vec<LogEntryWithFiles>, usize) {
    let total = entries.len();
    let fresh: Vec<_> = entries.into_iter().filter(|entry| listed.insert(entry.entry.hash.clone())).collect();
    let duplicates = total - fresh.len();
    (fresh, duplicates)
}

/// Add commit lines while the commit budget lasts; returns how many.
fn push_commits(lines: &mut Vec<String>, entries: &[LogEntryWithFiles], budget: &mut Budget) -> usize {
    let mut shown = 0;
    for entry in entries.iter().take(budget.commits) {
        lines.push(commit_line(entry, budget));
        shown += 1;
    }
    budget.commits -= shown;
    shown
}

/// `  - def5678 Subject (Author): deleted `a`; renamed `b` → `c`; modified 2 files`.
/// Deletions and renames are named while the path budget lasts, the rest counted.
fn commit_line(commit: &LogEntryWithFiles, budget: &mut Budget) -> String {
    let (mut deleted, mut renamed, mut hidden) = (Vec::new(), Vec::new(), 0);
    let (mut modified, mut added) = (0, 0);
    for change in &commit.files {
        match change.status {
            FileStatus::Deleted | FileStatus::Renamed => {
                if budget.paths == 0 {
                    hidden += 1;
                    continue;
                }
                budget.paths -= 1;
                if change.status == FileStatus::Deleted {
                    deleted.push(format!("`{}`", change.path));
                } else {
                    renamed.push(format!("`{}` → `{}`", change.old_path.as_deref().unwrap_or("?"), change.path));
                }
            }
            FileStatus::Added => added += 1,
            _ => modified += 1,
        }
    }
    let mut parts = Vec::new();
    if !deleted.is_empty() {
        parts.push(format!("deleted {}", deleted.join(", ")));
    }
    if !renamed.is_empty() {
        parts.push(format!("renamed {}", renamed.join(", ")));
    }
    if hidden > 0 {
        parts.push(format!("+{hidden} more deleted or renamed (kybern_git diff for the paths)"));
    }
    if modified > 0 {
        parts.push(format!("modified {}", plural(modified, "file")));
    }
    if added > 0 {
        parts.push(format!("added {}", plural(added, "file")));
    }
    let mut line = format!("  - {} {} ({})", short(&commit.entry.hash), commit.entry.subject, commit.entry.author);
    if !parts.is_empty() {
        line.push_str(": ");
        line.push_str(&parts.join("; "));
    }
    line
}

/// `- ade · uncommitted in the main checkout: 5 files (`a`, `b`, +3)`.
fn uncommitted_line(name: &str, status: &[String], budget: &mut Budget) -> String {
    let paths: Vec<&str> = status.iter().map(|line| status_path(line)).collect();
    let listed = paths.len().min(budget.uncommitted);
    budget.uncommitted -= listed;
    let mut names: Vec<String> = paths[..listed].iter().map(|path| format!("`{path}`")).collect();
    if paths.len() > listed {
        names.push(format!("+{}", paths.len() - listed));
    }
    let detail = if names.is_empty() { String::new() } else { format!(" ({})", names.join(", ")) };
    format!("- {name} · uncommitted in the main checkout: {}{detail}", plural(paths.len(), "file"))
}

/// The path of a `git status --porcelain` line (the new one for a rename).
fn status_path(line: &str) -> &str {
    let path = line.get(3..).unwrap_or(line).trim();
    path.rsplit_once(" -> ").map_or(path, |(_, new)| new)
}

fn short(sha: &str) -> &str {
    sha.get(..7).unwrap_or(sha)
}

fn plural(count: usize, noun: &str) -> String {
    if count == 1 { format!("1 {noun}") } else { format!("{count} {noun}s") }
}
