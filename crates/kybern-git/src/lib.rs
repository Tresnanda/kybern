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

pub struct Repo {
    /// Directory git commands run in (the project root or a worktree).
    pub workdir: PathBuf,
}

pub use kybern_protocol::{Diff, FileChange, FileStatus};

impl Repo {
    pub fn new(workdir: impl Into<PathBuf>) -> Self {
        Self { workdir: workdir.into() }
    }

    async fn git(&self, args: &[&str]) -> Result<String> {
        self.git_env(args, &[]).await
    }

    async fn git_env(&self, args: &[&str], env: &[(&str, &str)]) -> Result<String> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.workdir).args(args).stdin(Stdio::null());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let out = cmd.output().await.context("run git")?;
        if !out.status.success() {
            return Err(anyhow!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
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

    pub async fn toplevel(&self) -> Result<PathBuf> {
        Ok(PathBuf::from(self.git(&["rev-parse", "--show-toplevel"]).await?))
    }

    pub async fn git_dir(&self) -> Result<PathBuf> {
        let d = self.git(&["rev-parse", "--absolute-git-dir"]).await?;
        Ok(PathBuf::from(d))
    }

    pub async fn head(&self) -> Option<String> {
        self.git(&["rev-parse", "--verify", "HEAD"]).await.ok()
    }

    pub async fn current_branch(&self) -> Option<String> {
        self.git(&["symbolic-ref", "--short", "-q", "HEAD"]).await.ok().filter(|s| !s.is_empty())
    }

    /// Snapshot the working tree into a dangling commit and return its hash.
    pub async fn snapshot(&self, message: &str) -> Result<String> {
        let git_dir = self.git_dir().await?;
        let index = git_dir.join(format!("kybern-index-{}", uuid::Uuid::new_v4().simple()));
        let index_str = index.to_string_lossy().to_string();
        let env = [("GIT_INDEX_FILE", index_str.as_str())];
        let result = async {
            if let Some(head) = self.head().await {
                self.git_env(&["read-tree", &head], &env).await?;
            }
            self.git_env(&["add", "-A", "--", "."], &env).await?;
            let tree = self.git_env(&["write-tree"], &env).await?;
            let mut args = vec!["commit-tree".to_string(), tree, "-m".into(), message.to_string()];
            if let Some(head) = self.head().await {
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
        let numstat = self.git(&["diff", "--numstat", "-M", from, to]).await?;
        let status = self.git(&["diff", "--name-status", "-M", from, to]).await?;
        let patch = self.git(&["diff", "--no-color", "-M", from, to]).await?;

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
        Ok(Diff { from: from.into(), to: to.into(), files, patch })
    }

    // ---- worktrees ----

    pub async fn worktree_add(&self, path: &Path, branch: &str) -> Result<()> {
        let p = path.to_string_lossy().to_string();
        self.git(&["worktree", "add", "-b", branch, &p]).await.map(|_| ())
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
    async fn snapshot_works_without_head() {
        let (dir, repo) = init_repo().await;
        std::fs::write(dir.path().join("x"), "1").unwrap();
        let c = repo.snapshot("s").await.unwrap();
        assert_eq!(c.len(), 40);
    }
}
