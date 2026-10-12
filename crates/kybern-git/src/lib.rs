//! Git plumbing used by the daemon. Everything shells out to `git`, which is
//! the one dependency every user of a coding agent already has.
//!
//! Checkpoints are commits that are never on a branch: a snapshot of the
//! whole working tree (tracked and untracked, ignored files excluded) written
//! with a temporary index and referenced from `refs/kybern/<thread>/<turn>/<before|after>`.
//! Diffs are between two such commits, so untracked files show up and the
//! user's real index is never touched.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{Context, Result, anyhow};
use tokio::process::Command;

pub const AUTHOR_NAME: &str = "kybern";
pub const AUTHOR_EMAIL: &str = "checkpoint@kybern.local";
/// Keep a single diff response bounded so JSON parsing and rendering cannot
/// monopolize a desktop client's main thread. Metadata is never truncated.
pub const MAX_PATCH_BYTES: usize = 1024 * 1024;

/// One local branch from `for-each-ref`.
#[derive(Debug, Clone)]
pub struct BranchRef {
    pub name: String,
    pub upstream: Option<String>,
    /// Committer time of the tip, unix seconds.
    pub committed_at: i64,
}

pub struct Repo {
    /// Directory git commands run in (the project root or a worktree).
    pub workdir: PathBuf,
    /// Extra environment for every git command (tests isolate the user's
    /// global configuration with it).
    env: Vec<(String, String)>,
}

/// What a git command printed, whatever its exit status.
#[derive(Debug, Clone)]
pub struct GitOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// How `Repo::merge_no_ff` ended. A conflicting merge is aborted, so the
/// working tree is back to how it was.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MergeOutcome {
    Merged { commit: String },
    AlreadyUpToDate,
    Conflict { paths: Vec<String> },
}

/// One entry of `git status`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// Two-letter porcelain code, such as ` M`, `A ` or `??`.
    pub code: String,
    pub path: String,
}

/// Changes of the working tree against HEAD (or the index).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkingDiff {
    pub files: Vec<WorkingDiffFile>,
    pub patch: String,
    pub patch_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkingDiffFile {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

/// One commit of `git log`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    pub hash: String,
    pub author: String,
    /// Author date, strict ISO 8601.
    pub date: String,
    pub subject: String,
}

pub use kybern_protocol::{Diff, DiffStat, FileChange, FileStatus};

impl Repo {
    pub fn new(workdir: impl Into<PathBuf>) -> Self {
        Self { workdir: workdir.into(), env: Vec::new() }
    }

    /// The same repository with extra environment variables on every command.
    pub fn with_env(mut self, env: impl IntoIterator<Item = (String, String)>) -> Self {
        self.env.extend(env);
        self
    }

    async fn git(&self, args: &[&str]) -> Result<String> {
        self.git_env(args, &[]).await
    }

    async fn git_env(&self, args: &[&str], env: &[(&str, &str)]) -> Result<String> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.workdir).args(args).stdin(Stdio::null());
        cmd.envs(self.env.iter().map(|(k, v)| (k, v)));
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd.output().await.context("run git")?;
        if !out.status.success() {
            return Err(anyhow!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
    }

    /// Run a Git command where a non-zero status is meaningful output rather
    /// than a transport failure (for example `update-index --really-refresh`).
    async fn git_env_allow_nonzero(&self, args: &[&str], env: &[(&str, &str)]) -> Result<()> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.workdir).args(args).stdin(Stdio::null());
        cmd.envs(self.env.iter().map(|(k, v)| (k, v)));
        for (k, v) in env {
            cmd.env(k, v);
        }
        cmd.output().await.context("run git")?;
        Ok(())
    }

    pub async fn is_repo(path: &Path) -> bool {
        Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["rev-parse", "--is-inside-work-tree"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Whether git ignores `path` (relative to the workdir). A tracked file is
    /// not ignored: its changes would still be committed.
    pub async fn is_ignored(&self, path: &str) -> Result<bool> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.workdir)
            .args(["check-ignore", "-q", "--"])
            .arg(path)
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .await
            .context("run git")?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(anyhow!("git check-ignore failed: {}", String::from_utf8_lossy(&out.stderr).trim())),
        }
    }

    pub async fn toplevel(&self) -> Result<PathBuf> {
        Ok(PathBuf::from(self.git(&["rev-parse", "--show-toplevel"]).await?))
    }

    pub async fn git_dir(&self) -> Result<PathBuf> {
        let d = self.git(&["rev-parse", "--absolute-git-dir"]).await?;
        Ok(PathBuf::from(d))
    }

    async fn index_path(&self) -> Result<PathBuf> {
        let path = PathBuf::from(self.git(&["rev-parse", "--git-path", "index"]).await?);
        if path.is_absolute() { Ok(path) } else { Ok(self.workdir.join(path)) }
    }

    pub async fn head(&self) -> Option<String> {
        self.git(&["rev-parse", "--verify", "HEAD"]).await.ok()
    }

    pub async fn current_branch(&self) -> Option<String> {
        self.git(&["symbolic-ref", "--short", "-q", "HEAD"]).await.ok().filter(|s| !s.is_empty())
    }

    /// Local branches, most recently committed first.
    pub async fn branches(&self) -> Result<Vec<BranchRef>> {
        let out = self
            .git(&[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname:short)%09%(upstream:short)%09%(committerdate:unix)",
                "refs/heads",
            ])
            .await?;
        Ok(out
            .lines()
            .filter_map(|line| {
                let mut it = line.split('\t');
                let name = it.next()?.trim().to_string();
                if name.is_empty() {
                    return None;
                }
                let upstream = it.next().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
                let committed_at = it.next().and_then(|s| s.trim().parse().ok()).unwrap_or(0);
                Some(BranchRef { name, upstream, committed_at })
            })
            .collect())
    }

    /// Check out an existing local branch in this working tree.
    pub async fn switch(&self, branch: &str) -> Result<()> {
        self.git(&["switch", branch]).await.map(|_| ())
    }

    /// Snapshot the working tree into a dangling commit and return its hash.
    pub async fn snapshot(&self, message: &str) -> Result<String> {
        let (git_dir, working_index, head) = tokio::join!(self.git_dir(), self.index_path(), self.head());
        let git_dir = git_dir?;
        let index = git_dir.join(format!("kybern-index-{}", uuid::Uuid::new_v4().simple()));
        let index_str = index.to_string_lossy().to_string();
        let env = [("GIT_INDEX_FILE", index_str.as_str())];
        let result = async {
            let working_index_metadata = match working_index {
                Ok(working_index) => match tokio::fs::metadata(&working_index).await {
                    Ok(metadata) => {
                        // Seed from the real index so `git add` can reuse its
                        // stat cache instead of re-hashing the whole worktree.
                        tokio::fs::copy(&working_index, &index)
                            .await
                            .with_context(|| format!("copy git index {}", working_index.display()))?;
                        Some(metadata)
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    Err(error) => return Err(error).with_context(|| format!("stat git index {}", working_index.display())),
                },
                Err(_) => None,
            };

            if working_index_metadata.is_none()
                && let Some(head) = head.as_deref()
            {
                self.git_env(&["read-tree", head], &env).await?;
            }
            if let Some(metadata) = working_index_metadata {
                // Verify racily-clean entries without throwing away the copied
                // stat cache. A non-zero status only means paths need updating.
                self.git_env_allow_nonzero(&["update-index", "--really-refresh"], &env).await?;
                restore_file_times(&index, &metadata)?;
            }
            self.git_env(&["add", "-A", "--", "."], &env).await?;
            let tree = self.git_env(&["write-tree"], &env).await?;
            let mut args = vec!["commit-tree".to_string(), tree, "-m".into(), message.to_string()];
            if let Some(head) = head {
                args.push("-p".into());
                args.push(head);
            }
            let args_ref: Vec<&str> = args.iter().map(String::as_str).collect();
            self.git_env(
                &args_ref,
                &[
                    ("GIT_AUTHOR_NAME", AUTHOR_NAME),
                    ("GIT_AUTHOR_EMAIL", AUTHOR_EMAIL),
                    ("GIT_COMMITTER_NAME", AUTHOR_NAME),
                    ("GIT_COMMITTER_EMAIL", AUTHOR_EMAIL),
                ],
            )
            .await
        }
        .await;
        let _ = tokio::fs::remove_file(&index).await;
        let mut lock = index.as_os_str().to_os_string();
        lock.push(".lock");
        let _ = tokio::fs::remove_file(PathBuf::from(lock)).await;
        result
    }

    pub async fn update_ref(&self, name: &str, commit: &str) -> Result<()> {
        self.git(&["update-ref", name, commit]).await.map(|_| ())
    }

    pub async fn delete_ref(&self, name: &str) -> Result<()> {
        let _ = self.git(&["update-ref", "-d", name]).await;
        Ok(())
    }

    /// Reset the working tree and index to exactly the snapshot. Untracked,
    /// non-ignored files that are not in the snapshot are removed.
    pub async fn restore(&self, commit: &str) -> Result<()> {
        self.git(&["read-tree", "--reset", "-u", commit]).await?;
        self.git(&["clean", "-fd", "--", "."]).await?;
        Ok(())
    }

    pub async fn diff(&self, from: &str, to: &str) -> Result<Diff> {
        self.diff_with_options(from, to, true, None).await
    }

    /// Diff two snapshots, optionally omitting the unified patch or limiting it
    /// to one repository-relative path. Metadata is always returned.
    pub async fn diff_with_options(&self, from: &str, to: &str, include_patch: bool, path: Option<&str>) -> Result<Diff> {
        let args = |mode: &'static str| {
            let mut args = vec!["diff", mode, "-M", from, to];
            if let Some(path) = path {
                args.extend(["--", path]);
            }
            args
        };
        let numstat_args = args("--numstat");
        let status_args = args("--name-status");
        let (numstat, status) = tokio::try_join!(self.git(&numstat_args), self.git(&status_args))?;
        let mut patch = if include_patch { self.git(&args("--no-color")).await? } else { String::new() };
        let patch_truncated = truncate_utf8(&mut patch, MAX_PATCH_BYTES);

        let mut files: Vec<FileChange> = Vec::new();
        for line in status.lines() {
            let mut parts = line.split('\t');
            let code = parts.next().unwrap_or("");
            let a = parts.next().unwrap_or("").to_string();
            let b = parts.next().map(str::to_string);
            let (status, path, old_path) = match code.chars().next() {
                Some('A') => (FileStatus::Added, a, None),
                Some('M') => (FileStatus::Modified, a, None),
                Some('D') => (FileStatus::Deleted, a, None),
                Some('R') => (FileStatus::Renamed, b.clone().unwrap_or_default(), Some(a)),
                Some('C') => (FileStatus::Copied, b.clone().unwrap_or_default(), Some(a)),
                Some('T') => (FileStatus::TypeChanged, a, None),
                _ => (FileStatus::Unknown, a, None),
            };
            files.push(FileChange { path, old_path, status, additions: 0, deletions: 0, binary: false });
        }
        for line in numstat.lines() {
            let mut parts = line.split('\t');
            let add = parts.next().unwrap_or("-");
            let del = parts.next().unwrap_or("-");
            let rest = parts.next().unwrap_or("");
            // Renames appear as "old => new" or "{a => b}/x" in numstat; match on the new path.
            let path = rest.split(" => ").last().unwrap_or(rest).replace(['{', '}'], "");
            if let Some(f) = files.iter_mut().find(|f| f.path == path || f.path.ends_with(&path)) {
                if add == "-" {
                    f.binary = true;
                } else {
                    f.additions = add.parse().unwrap_or(0);
                    f.deletions = del.parse().unwrap_or(0);
                }
            }
        }
        Ok(Diff { from: from.into(), to: to.into(), files, patch, patch_truncated })
    }

    // ---- state queries used by delegated-worktree cleanup ----

    /// Whether the working tree has no changes, counting untracked files
    /// (ignored files do not count).
    pub async fn is_clean(&self) -> Result<bool> {
        Ok(self.git(&["status", "--porcelain"]).await?.is_empty())
    }

    /// Whether `ancestor` is reachable from `descendant` (`git merge-base
    /// --is-ancestor`). An unknown revision is an error, not `false`.
    pub async fn is_ancestor(&self, ancestor: &str, descendant: &str) -> Result<bool> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.workdir)
            .args(["merge-base", "--is-ancestor", ancestor, descendant])
            .envs(self.env.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .output()
            .await
            .context("run git")?;
        match out.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(anyhow!("git merge-base --is-ancestor failed: {}", String::from_utf8_lossy(&out.stderr).trim())),
        }
    }

    /// Resolve a revision to a full commit id.
    pub async fn rev_parse(&self, revision: &str) -> Result<String> {
        self.git(&["rev-parse", "--verify", &format!("{revision}^{{commit}}")]).await
    }

    /// Delete a local branch. Without `force` git refuses unless it is merged.
    pub async fn delete_branch(&self, branch: &str, force: bool) -> Result<()> {
        self.git(&["branch", if force { "-D" } else { "-d" }, "--", branch]).await.map(|_| ())
    }

    /// Files and lines changed from `base` to `head` (binary files count as a file).
    pub async fn diffstat(&self, base: &str, head: &str) -> Result<DiffStat> {
        let numstat = self.git(&["diff", "--numstat", "-M", base, head]).await?;
        let mut stat = DiffStat::default();
        for line in numstat.lines() {
            let mut parts = line.split('\t');
            let (add, del) = (parts.next().unwrap_or("-"), parts.next().unwrap_or("-"));
            stat.files += 1;
            stat.additions += add.parse::<u32>().unwrap_or(0);
            stat.deletions += del.parse::<u32>().unwrap_or(0);
        }
        Ok(stat)
    }

    // ---- operations behind the Coordinator's git tool ----

    /// Run git and return what it printed, whether or not it succeeded.
    pub async fn output(&self, args: &[&str]) -> Result<GitOutput> {
        self.output_with(args, &[], None).await
    }

    async fn output_with(&self, args: &[&str], env: &[(&str, &str)], timeout: Option<std::time::Duration>) -> Result<GitOutput> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.workdir).args(args).stdin(Stdio::null()).kill_on_drop(true);
        cmd.envs(self.env.iter().map(|(k, v)| (k, v)));
        // Never wait for a person at a prompt or an editor.
        cmd.env("GIT_TERMINAL_PROMPT", "0").env("GIT_EDITOR", "true");
        for (k, v) in env {
            cmd.env(k, v);
        }
        let run = cmd.output();
        let out = match timeout {
            Some(limit) => tokio::time::timeout(limit, run).await.map_err(|_| anyhow!("git {} timed out", args.join(" ")))?,
            None => run.await,
        }
        .context("run git")?;
        Ok(GitOutput {
            success: out.status.success(),
            stdout: String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
            stderr: String::from_utf8_lossy(&out.stderr).trim_end().to_string(),
        })
    }

    /// Changed files with their porcelain codes, untracked files listed one by one.
    pub async fn status_entries(&self) -> Result<Vec<StatusEntry>> {
        let out = self.git(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]).await?;
        let mut entries = Vec::new();
        let mut parts = out.split('\0').filter(|part| !part.is_empty());
        while let Some(part) = parts.next() {
            if part.len() < 4 {
                continue;
            }
            let (code, path) = part.split_at(2);
            if code.contains('R') || code.contains('C') {
                // A rename or copy is followed by its original path.
                parts.next();
            }
            entries.push(StatusEntry { code: code.to_string(), path: path.trim_start().to_string() });
        }
        Ok(entries)
    }

    /// The newest `limit` commits of the current branch; empty before the first commit.
    pub async fn log(&self, limit: usize) -> Result<Vec<LogEntry>> {
        if self.head().await.is_none() {
            return Ok(Vec::new());
        }
        let count = limit.max(1).to_string();
        let out = self.git(&["log", "-n", &count, "--format=%H%x1f%an%x1f%aI%x1f%s"]).await?;
        Ok(out
            .lines()
            .filter_map(|line| {
                let mut fields = line.split('\x1f');
                Some(LogEntry {
                    hash: fields.next()?.to_string(),
                    author: fields.next()?.to_string(),
                    date: fields.next()?.to_string(),
                    subject: fields.next().unwrap_or("").to_string(),
                })
            })
            .collect())
    }

    /// Uncommitted changes to tracked files (or only the staged ones) with a
    /// unified patch cut at `max_bytes`. Untracked files are in `status_entries`.
    pub async fn diff_uncommitted(&self, staged: bool, path: Option<&str>, max_bytes: usize) -> Result<WorkingDiff> {
        let mut base: Vec<&str> = vec!["diff"];
        if staged || self.head().await.is_none() {
            base.push("--cached");
        } else {
            base.push("HEAD");
        }
        let with = |mode: &'static str| {
            let mut args = base.clone();
            args.insert(1, mode);
            args.push("--");
            if let Some(path) = path {
                args.push(path);
            }
            args
        };
        let numstat = self.git(&with("--numstat")).await?;
        let mut patch = self.git(&with("--no-color")).await?;
        let patch_truncated = truncate_utf8(&mut patch, max_bytes);
        let files = numstat
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\t');
                let (add, del, path) = (parts.next()?, parts.next()?, parts.next()?);
                Some(WorkingDiffFile {
                    path: path.to_string(),
                    additions: add.parse().unwrap_or(0),
                    deletions: del.parse().unwrap_or(0),
                    binary: add == "-",
                })
            })
            .collect();
        Ok(WorkingDiff { files, patch, patch_truncated })
    }

    /// A configured value, or `None` when it is unset or empty.
    pub async fn config_get(&self, key: &str) -> Option<String> {
        let out = self.output(&["config", "--get", key]).await.ok()?;
        Some(out.stdout.trim().to_string()).filter(|value| out.success && !value.is_empty())
    }

    /// The configured commit identity `(name, email)`; either is `None` when unset.
    pub async fn identity(&self) -> (Option<String>, Option<String>) {
        tokio::join!(self.config_get("user.name"), self.config_get("user.email"))
    }

    /// The remote's default branch as the clone recorded it (`origin/HEAD`).
    pub async fn default_branch(&self) -> Option<String> {
        let out = self.git(&["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).await.ok()?;
        out.strip_prefix("origin/").map(str::to_string).filter(|name| !name.is_empty())
    }

    /// Whether `name` is the branch work must not be committed to directly:
    /// `main`, `master` or the remote's recorded default.
    pub async fn is_default_branch(&self, name: &str) -> bool {
        matches!(name, "main" | "master") || self.default_branch().await.as_deref() == Some(name)
    }

    /// Whether `name` is an acceptable branch name.
    pub async fn is_valid_branch_name(&self, name: &str) -> bool {
        !name.starts_with('-') && self.output(&["check-ref-format", "--branch", name]).await.is_ok_and(|out| out.success)
    }

    /// Create `name` (forked from `from`, HEAD when `None`) and switch to it.
    pub async fn create_branch(&self, name: &str, from: Option<&str>) -> Result<()> {
        let mut args = vec!["switch", "-c", name];
        if let Some(from) = from {
            args.push(from);
        }
        self.git(&args).await.map(|_| ())
    }

    /// Stage and commit. With `paths`, only those paths are committed (a new
    /// file is added first); otherwise every tracked and untracked change is.
    /// Uses the configured identity and returns the new commit.
    pub async fn commit(&self, message: &str, paths: Option<&[String]>) -> Result<String> {
        match paths {
            Some(paths) if !paths.is_empty() => {
                let mut add = vec!["add", "-A", "--"];
                add.extend(paths.iter().map(String::as_str));
                self.git(&add).await?;
                let mut commit = vec!["commit", "-q", "-m", message, "--"];
                commit.extend(paths.iter().map(String::as_str));
                self.git(&commit).await?;
            }
            _ => {
                self.git(&["add", "-A", "--", "."]).await?;
                self.git(&["commit", "-q", "-m", message]).await?;
            }
        }
        self.git(&["rev-parse", "HEAD"]).await
    }

    /// The branch's upstream (`origin/feature`), if it has one.
    pub async fn upstream(&self, branch: &str) -> Option<String> {
        self.git(&["rev-parse", "--abbrev-ref", &format!("{branch}@{{upstream}}")]).await.ok().filter(|value| !value.is_empty())
    }

    /// The remote a branch pushes to: its upstream's remote, else `origin`,
    /// else the only remote. `None` when there is no remote.
    pub async fn push_remote(&self, branch: &str) -> Option<String> {
        let remotes: Vec<String> = self.git(&["remote"]).await.ok()?.lines().map(str::to_string).collect();
        if let Some(remote) = self.config_get(&format!("branch.{branch}.remote")).await
            && remotes.contains(&remote)
        {
            return Some(remote);
        }
        match remotes.as_slice() {
            [] => None,
            [only] => Some(only.clone()),
            many => many.iter().find(|remote| remote.as_str() == "origin").cloned(),
        }
    }

    /// Commits of `branch` that its upstream (or, without one, any ref of
    /// `remote`) does not have.
    pub async fn commits_ahead(&self, branch: &str, remote: &str) -> Result<u32> {
        let count = match self.upstream(branch).await {
            Some(upstream) => self.git(&["rev-list", "--count", &format!("{upstream}..{branch}")]).await?,
            None => self.git(&["rev-list", "--count", branch, "--not", &format!("--remotes={remote}")]).await?,
        };
        Ok(count.trim().parse().unwrap_or(0))
    }

    /// Commits `(ahead, behind)` the upstream; `None` without one.
    pub async fn ahead_behind(&self, branch: &str) -> Option<(u32, u32)> {
        let upstream = self.upstream(branch).await?;
        let out = self.git(&["rev-list", "--left-right", "--count", &format!("{upstream}...{branch}")]).await.ok()?;
        let mut parts = out.split_whitespace();
        let behind = parts.next()?.parse().ok()?;
        let ahead = parts.next()?.parse().ok()?;
        Some((ahead, behind))
    }

    /// Merge `branch` into the current branch with a merge commit. A merge that
    /// conflicts is aborted and reports the conflicting paths.
    pub async fn merge_no_ff(&self, branch: &str, message: &str) -> Result<MergeOutcome> {
        let out = self.output(&["merge", "--no-ff", "--no-edit", "-m", message, branch]).await?;
        if out.success {
            if out.stdout.contains("Already up to date") {
                return Ok(MergeOutcome::AlreadyUpToDate);
            }
            return Ok(MergeOutcome::Merged { commit: self.git(&["rev-parse", "HEAD"]).await? });
        }
        let unmerged = self.output(&["diff", "--name-only", "--diff-filter=U"]).await?;
        let paths: Vec<String> = unmerged.stdout.lines().map(str::to_string).filter(|path| !path.is_empty()).collect();
        if self.rev_parse("MERGE_HEAD").await.is_ok() {
            self.output(&["merge", "--abort"]).await?;
        }
        if paths.is_empty() {
            let detail = if out.stderr.is_empty() { out.stdout } else { out.stderr };
            return Err(anyhow!("git merge failed: {detail}"));
        }
        Ok(MergeOutcome::Conflict { paths })
    }

    /// `git push -u remote branch`. Never forced; a rejected push is an error.
    pub async fn push_upstream(&self, remote: &str, branch: &str) -> Result<String> {
        let out = self.output_with(&["push", "-u", remote, branch], &[], Some(std::time::Duration::from_secs(120))).await?;
        if !out.success {
            return Err(anyhow!("git push failed: {}", out.stderr));
        }
        Ok(if out.stderr.is_empty() { out.stdout } else { out.stderr })
    }

    // ---- worktrees ----

    /// Add a worktree on a new branch, forked from `start` (HEAD when `None`).
    pub async fn worktree_add(&self, path: &Path, branch: &str, start: Option<&str>) -> Result<()> {
        let p = path.to_string_lossy().to_string();
        let mut args = vec!["worktree", "add", "-b", branch, &p];
        if let Some(start) = start {
            args.push(start);
        }
        self.git(&args).await.map(|_| ())
    }

    /// Restore a managed worktree on its retained branch.
    pub async fn worktree_add_existing(&self, path: &Path, branch: &str) -> Result<()> {
        self.git(&["worktree", "add", &path.to_string_lossy(), branch]).await.map(|_| ())
    }

    /// Forget worktrees whose directory no longer exists (`git worktree prune`).
    pub async fn worktree_prune(&self) -> Result<()> {
        self.git(&["worktree", "prune"]).await.map(|_| ())
    }

    pub async fn worktree_remove(&self, path: &Path, force: bool) -> Result<()> {
        let p = path.to_string_lossy().to_string();
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&p);
        self.git(&args).await.map(|_| ())
    }
}

fn restore_file_times(path: &Path, metadata: &std::fs::Metadata) -> Result<()> {
    let modified = metadata.modified().context("read git index modified time")?;
    let accessed = metadata.accessed().unwrap_or(modified);
    let times = std::fs::FileTimes::new().set_accessed(accessed).set_modified(modified);
    std::fs::OpenOptions::new()
        .write(true)
        .open(path)
        .with_context(|| format!("open temporary git index {}", path.display()))?
        .set_times(times)
        .with_context(|| format!("restore temporary git index times {}", path.display()))
}

fn truncate_utf8(value: &mut String, max_bytes: usize) -> bool {
    if value.len() <= max_bytes {
        return false;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value.truncate(end);
    true
}

pub fn checkpoint_ref(thread_id: &str, turn_id: &str, which: &str) -> String {
    format!("refs/kybern/{thread_id}/{turn_id}/{which}")
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn init_repo() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repo::new(dir.path());
        repo.git(&["init", "-q"]).await.unwrap();
        repo.git(&["config", "user.email", "t@t"]).await.unwrap();
        repo.git(&["config", "user.name", "t"]).await.unwrap();
        (dir, repo)
    }

    #[tokio::test]
    async fn snapshot_diff_restore_roundtrip() {
        let (dir, repo) = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "init"]).await.unwrap();

        let before = repo.snapshot("before").await.unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.path().join("new.txt"), "hi\n").unwrap();
        let after = repo.snapshot("after").await.unwrap();

        let d = repo.diff(&before, &after).await.unwrap();
        assert_eq!(d.files.len(), 2);
        let a = d.files.iter().find(|f| f.path == "a.txt").unwrap();
        assert_eq!(a.status, FileStatus::Modified);
        assert_eq!(a.additions, 1);
        let n = d.files.iter().find(|f| f.path == "new.txt").unwrap();
        assert_eq!(n.status, FileStatus::Added);
        assert!(d.patch.contains("+two"));

        // The user's real index is untouched by snapshots.
        let status = repo.git(&["status", "--porcelain"]).await.unwrap();
        assert!(status.contains("?? new.txt"), "{status}");

        repo.restore(&before).await.unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one\n");
        assert!(!dir.path().join("new.txt").exists());
    }

    #[tokio::test]
    async fn diff_can_skip_patch_and_scope_to_path() {
        let (dir, repo) = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "one\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "init"]).await.unwrap();

        let before = repo.snapshot("before").await.unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "one\nthree\n").unwrap();
        let after = repo.snapshot("after").await.unwrap();

        let summary = repo.diff_with_options(&before, &after, false, None).await.unwrap();
        assert_eq!(summary.files.len(), 2);
        assert!(summary.patch.is_empty());

        let file = repo.diff_with_options(&before, &after, true, Some("a.txt")).await.unwrap();
        assert_eq!(file.files.len(), 1);
        assert_eq!(file.files[0].path, "a.txt");
        assert!(file.patch.contains("+two"));
        assert!(!file.patch.contains("b.txt"));
        assert!(!file.patch_truncated);
    }

    #[tokio::test]
    async fn oversized_patch_is_transport_bounded_without_losing_stats() {
        let (dir, repo) = init_repo().await;
        std::fs::write(dir.path().join("large.txt"), "before\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "init"]).await.unwrap();

        let before = repo.snapshot("before").await.unwrap();
        let contents = (0..30_000).map(|line| format!("{line:05} {}\n", "x".repeat(48))).collect::<String>();
        std::fs::write(dir.path().join("large.txt"), contents).unwrap();
        let after = repo.snapshot("after").await.unwrap();

        let diff = repo.diff_with_options(&before, &after, true, Some("large.txt")).await.unwrap();
        assert_eq!(diff.patch.len(), MAX_PATCH_BYTES);
        assert!(diff.patch_truncated);
        assert_eq!(diff.files[0].additions, 30_000);
    }

    #[tokio::test]
    async fn snapshot_works_without_head() {
        let (dir, repo) = init_repo().await;
        std::fs::write(dir.path().join("x"), "1").unwrap();
        let c = repo.snapshot("s").await.unwrap();
        assert_eq!(c.len(), 40);
    }

    #[tokio::test]
    async fn snapshot_preserves_staged_and_unstaged_index_state() {
        let (dir, repo) = init_repo().await;
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "committed\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "init"]).await.unwrap();

        std::fs::write(&path, "staged value\n").unwrap();
        repo.git(&["add", "a.txt"]).await.unwrap();
        std::fs::write(&path, "working value\n").unwrap();
        let status_before = repo.git(&["status", "--porcelain=v1"]).await.unwrap();

        let snapshot = repo.snapshot("snapshot").await.unwrap();

        assert_eq!(repo.git(&["status", "--porcelain=v1"]).await.unwrap(), status_before);
        assert_eq!(repo.git(&["show", &format!("{snapshot}:a.txt")]).await.unwrap(), "working value");
    }

    #[tokio::test]
    async fn state_queries_report_clean_ancestry_and_diffstat() {
        let (dir, repo) = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "init"]).await.unwrap();
        let base = repo.rev_parse("HEAD").await.unwrap();
        assert!(repo.is_clean().await.unwrap());

        std::fs::write(dir.path().join("new.txt"), "hi\n").unwrap();
        assert!(!repo.is_clean().await.unwrap(), "untracked files make the tree dirty");
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "more"]).await.unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        repo.git(&["commit", "-q", "-am", "edit"]).await.unwrap();
        let head = repo.rev_parse("HEAD").await.unwrap();

        assert!(repo.is_ancestor(&base, &head).await.unwrap());
        assert!(!repo.is_ancestor(&head, &base).await.unwrap());
        assert!(repo.is_ancestor(&head, &head).await.unwrap());
        assert!(repo.is_ancestor("does-not-exist", &head).await.is_err());
        assert_eq!(repo.diffstat(&base, &head).await.unwrap(), DiffStat { files: 2, additions: 3, deletions: 0 });
        assert_eq!(repo.diffstat(&head, &head).await.unwrap(), DiffStat::default());
    }

    #[tokio::test]
    async fn delete_branch_refuses_unmerged_unless_forced() {
        let (dir, repo) = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "init"]).await.unwrap();
        repo.git(&["checkout", "-q", "-b", "feature"]).await.unwrap();
        std::fs::write(dir.path().join("b.txt"), "two\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "feature work"]).await.unwrap();
        repo.git(&["checkout", "-q", "-"]).await.unwrap();

        assert!(repo.delete_branch("feature", false).await.is_err());
        repo.git(&["merge", "-q", "--no-ff", "-m", "merge", "feature"]).await.unwrap();
        repo.delete_branch("feature", false).await.unwrap();
        assert!(repo.branches().await.unwrap().iter().all(|branch| branch.name != "feature"));

        repo.git(&["branch", "scratch"]).await.unwrap();
        repo.delete_branch("scratch", true).await.unwrap();
    }

    #[tokio::test]
    async fn worktree_seeded_from_a_snapshot_is_clean_and_carries_uncommitted_files() {
        let (dir, repo) = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "init"]).await.unwrap();
        std::fs::write(dir.path().join("wip.txt"), "uncommitted\n").unwrap();
        let snapshot = repo.snapshot("base").await.unwrap();

        let parent = tempfile::tempdir().unwrap();
        let worktree = parent.path().join("child");
        repo.worktree_add(&worktree, "kybern/child", Some(&snapshot)).await.unwrap();
        let child = Repo::new(&worktree);
        assert_eq!(std::fs::read_to_string(worktree.join("wip.txt")).unwrap(), "uncommitted\n");
        assert!(child.is_clean().await.unwrap());
        assert_eq!(child.rev_parse("HEAD").await.unwrap(), snapshot);
        // No commits beyond the base yet: the branch tip is an ancestor of the base.
        assert!(repo.is_ancestor("kybern/child", &snapshot).await.unwrap());
        std::fs::write(worktree.join("scratch"), "x").unwrap();
        assert!(!child.is_clean().await.unwrap());
        repo.worktree_remove(&worktree, true).await.unwrap();
        // The snapshot is a dangling commit, so `-d` sees an unmerged branch.
        assert!(repo.delete_branch("kybern/child", false).await.is_err());
        repo.delete_branch("kybern/child", true).await.unwrap();
    }

    #[tokio::test]
    async fn worktree_prune_forgets_a_deleted_worktree_so_its_branch_can_be_judged() {
        let (dir, repo) = init_repo().await;
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "init"]).await.unwrap();
        let wt = tempfile::tempdir().unwrap();
        let path = wt.path().join("child");
        repo.worktree_add(&path, "kybern/x", None).await.unwrap();
        std::fs::remove_dir_all(&path).unwrap();
        assert!(repo.git(&["worktree", "list", "--porcelain"]).await.unwrap().contains("kybern/x"));
        repo.worktree_prune().await.unwrap();
        assert!(!repo.git(&["worktree", "list", "--porcelain"]).await.unwrap().contains("kybern/x"));
        // The branch survives and, with no commits of its own, is an ancestor of HEAD.
        assert!(repo.is_ancestor("kybern/x", "HEAD").await.unwrap());
        repo.delete_branch("kybern/x", false).await.unwrap();
    }

    async fn committed_repo() -> (tempfile::TempDir, Repo) {
        let (dir, repo) = init_repo().await;
        repo.git(&["symbolic-ref", "HEAD", "refs/heads/main"]).await.unwrap();
        std::fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        repo.git(&["add", "."]).await.unwrap();
        repo.git(&["commit", "-q", "-m", "init"]).await.unwrap();
        (dir, repo)
    }

    #[tokio::test]
    async fn status_log_and_diff_describe_the_working_tree() {
        let (dir, repo) = committed_repo().await;
        assert!(repo.status_entries().await.unwrap().is_empty());
        std::fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/new.txt"), "n\n").unwrap();
        let entries = repo.status_entries().await.unwrap();
        assert!(entries.contains(&StatusEntry { code: " M".into(), path: "a.txt".into() }), "{entries:?}");
        assert!(entries.contains(&StatusEntry { code: "??".into(), path: "sub/new.txt".into() }), "{entries:?}");

        let diff = repo.diff_uncommitted(false, None, 1024).await.unwrap();
        assert_eq!(diff.files, vec![WorkingDiffFile { path: "a.txt".into(), additions: 1, deletions: 0, binary: false }]);
        assert!(diff.patch.contains("+two"));
        assert!(repo.diff_uncommitted(true, None, 1024).await.unwrap().files.is_empty(), "nothing is staged");
        let tiny = repo.diff_uncommitted(false, Some("a.txt"), 10).await.unwrap();
        assert!(tiny.patch_truncated && tiny.patch.len() <= 10);

        let log = repo.log(5).await.unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!((log[0].subject.as_str(), log[0].author.as_str()), ("init", "t"));
        let (_empty_dir, empty) = init_repo().await;
        assert!(empty.log(5).await.unwrap().is_empty(), "no commits yet");
    }

    #[tokio::test]
    async fn commit_takes_only_the_named_paths_and_uses_the_configured_identity() {
        let (dir, repo) = committed_repo().await;
        std::fs::write(dir.path().join("a.txt"), "changed\n").unwrap();
        std::fs::write(dir.path().join("b.txt"), "new\n").unwrap();
        std::fs::write(dir.path().join("c.txt"), "other\n").unwrap();
        let first = repo.commit("only b", Some(&["b.txt".to_string()])).await.unwrap();
        assert_eq!(repo.git(&["show", "--name-only", "--format=%an <%ae>", &first]).await.unwrap(), "t <t@t>\n\nb.txt");
        let left: Vec<_> = repo.status_entries().await.unwrap().into_iter().map(|entry| entry.path).collect();
        assert_eq!(left, vec!["a.txt", "c.txt"]);
        repo.commit("everything else", None).await.unwrap();
        assert!(repo.status_entries().await.unwrap().is_empty());
        assert!(repo.commit("nothing", None).await.is_err());
    }

    #[tokio::test]
    async fn identity_reads_the_configured_values_and_notices_when_missing() {
        let (dir, repo) = committed_repo().await;
        assert_eq!(repo.identity().await, (Some("t".into()), Some("t@t".into())));
        let home = tempfile::tempdir().unwrap();
        let isolated = Repo::new(dir.path()).with_env([
            ("HOME".to_string(), home.path().to_string_lossy().into_owned()),
            ("GIT_CONFIG_GLOBAL".to_string(), "/dev/null".to_string()),
            ("GIT_CONFIG_NOSYSTEM".to_string(), "1".to_string()),
        ]);
        repo.git(&["config", "--unset", "user.name"]).await.unwrap();
        repo.git(&["config", "--unset", "user.email"]).await.unwrap();
        assert_eq!(isolated.identity().await, (None, None));
    }

    #[tokio::test]
    async fn branch_helpers_validate_names_and_spot_the_default_branch() {
        let (_dir, repo) = committed_repo().await;
        assert!(repo.is_valid_branch_name("feature/x").await);
        for bad in ["-x", "a b", "a..b", "", "x.lock"] {
            assert!(!repo.is_valid_branch_name(bad).await, "{bad:?}");
        }
        assert!(repo.is_default_branch("main").await && repo.is_default_branch("master").await);
        assert!(!repo.is_default_branch("feature").await);
        repo.create_branch("feature", None).await.unwrap();
        assert_eq!(repo.current_branch().await.as_deref(), Some("feature"));
        assert!(repo.create_branch("feature", None).await.is_err(), "it exists");
        repo.create_branch("from-main", Some("main")).await.unwrap();
        assert_eq!(repo.current_branch().await.as_deref(), Some("from-main"));
    }

    #[tokio::test]
    async fn merge_no_ff_makes_a_merge_commit_and_aborts_on_conflict() {
        let (dir, repo) = committed_repo().await;
        repo.git(&["checkout", "-q", "-b", "clean"]).await.unwrap();
        std::fs::write(dir.path().join("b.txt"), "b\n").unwrap();
        repo.commit("add b", None).await.unwrap();
        repo.git(&["checkout", "-q", "-b", "clash", "main"]).await.unwrap();
        std::fs::write(dir.path().join("a.txt"), "theirs\n").unwrap();
        repo.commit("their a", None).await.unwrap();
        repo.git(&["checkout", "-q", "main"]).await.unwrap();
        std::fs::write(dir.path().join("a.txt"), "ours\n").unwrap();
        repo.commit("our a", None).await.unwrap();

        let MergeOutcome::Conflict { paths } = repo.merge_no_ff("clash", "merge clash").await.unwrap() else {
            panic!("expected a conflict")
        };
        assert_eq!(paths, vec!["a.txt"]);
        assert!(repo.rev_parse("MERGE_HEAD").await.is_err(), "the merge was aborted");
        assert!(repo.is_clean().await.unwrap());
        assert_eq!(std::fs::read_to_string(dir.path().join("a.txt")).unwrap(), "ours\n");

        let MergeOutcome::Merged { commit } = repo.merge_no_ff("clean", "merge clean").await.unwrap() else { panic!("expected a merge") };
        assert_eq!(repo.git(&["rev-list", "--parents", "-n", "1", &commit]).await.unwrap().split_whitespace().count(), 3, "two parents");
        assert_eq!(repo.git(&["log", "-1", "--format=%s"]).await.unwrap(), "merge clean");
        assert_eq!(repo.merge_no_ff("clean", "again").await.unwrap(), MergeOutcome::AlreadyUpToDate);
        assert!(repo.merge_no_ff("does-not-exist", "x").await.is_err());
    }

    #[tokio::test]
    async fn push_sets_the_upstream_and_counts_commits_ahead() {
        let remote = tempfile::tempdir().unwrap();
        let bare = Repo::new(remote.path());
        bare.git(&["init", "-q", "--bare"]).await.unwrap();
        let (dir, repo) = committed_repo().await;
        assert_eq!(repo.push_remote("main").await, None, "no remote yet");
        repo.git(&["remote", "add", "origin", &remote.path().to_string_lossy()]).await.unwrap();
        assert_eq!(repo.push_remote("main").await.as_deref(), Some("origin"));
        assert_eq!(repo.commits_ahead("main", "origin").await.unwrap(), 1);
        assert_eq!(repo.upstream("main").await, None);
        repo.push_upstream("origin", "main").await.unwrap();
        assert_eq!(repo.upstream("main").await.as_deref(), Some("origin/main"));
        assert_eq!(repo.commits_ahead("main", "origin").await.unwrap(), 0);
        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        repo.commit("more", None).await.unwrap();
        assert_eq!(repo.ahead_behind("main").await, Some((1, 0)));
        assert_eq!(repo.commits_ahead("main", "origin").await.unwrap(), 1);
        // A diverged push is rejected, never forced.
        repo.git(&["reset", "-q", "--hard", "HEAD~1"]).await.unwrap();
        std::fs::write(dir.path().join("a.txt"), "diverged\n").unwrap();
        repo.commit("diverge", None).await.unwrap();
        repo.push_upstream("origin", "main").await.unwrap();
        repo.git(&["reset", "-q", "--hard", "HEAD~1"]).await.unwrap();
        std::fs::write(dir.path().join("a.txt"), "other\n").unwrap();
        repo.commit("other", None).await.unwrap();
        assert!(repo.push_upstream("origin", "main").await.is_err());
    }
}
