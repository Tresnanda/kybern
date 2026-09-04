//! Git status and GitHub pull requests through the user's `gh` CLI, which
//! already holds their credentials.

use std::path::Path;

use anyhow::{Context, Result, anyhow};
use kybern_git::Repo;
use kybern_protocol::methods::{BranchInfo, GitBranchesResult, GitStatus, PullRequest};
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::OnceCell;

static GH_AVAILABLE: OnceCell<bool> = OnceCell::const_new();

async fn run(cwd: &Path, program: &str, args: &[&str]) -> Result<String> {
    let out = Command::new(program)
        .current_dir(cwd)
        .args(args)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .with_context(|| format!("run {program}"))?;
    if !out.status.success() {
        return Err(anyhow!("{program} {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim_end().to_string())
}

/// Local branches of a project checkout, most recently committed first.
pub async fn branches(cwd: &Path) -> Result<GitBranchesResult> {
    if !Repo::is_repo(cwd).await {
        return Ok(GitBranchesResult { current: None, branches: Vec::new() });
    }
    let repo = Repo::new(cwd);
    let current = repo.current_branch().await;
    let branches = repo
        .branches()
        .await?
        .into_iter()
        .map(|b| BranchInfo {
            is_current: current.as_deref() == Some(b.name.as_str()),
            name: b.name,
            upstream: b.upstream,
            committed_at: b.committed_at,
        })
        .collect();
    Ok(GitBranchesResult { current, branches })
}

pub async fn gh_available() -> bool {
    *GH_AVAILABLE.get_or_init(|| async { Command::new("gh").arg("--version").output().await.is_ok_and(|o| o.status.success()) }).await
}

pub async fn status(cwd: &Path) -> Result<GitStatus> {
    if !Repo::is_repo(cwd).await {
        return Ok(GitStatus {
            is_git: false,
            branch: None,
            dirty_files: 0,
            ahead: 0,
            behind: 0,
            upstream: None,
            remote_url: None,
            pull_request: None,
        });
    }
    let repo = Repo::new(cwd);
    let branch = repo.current_branch().await;
    let dirty_files = run(cwd, "git", &["status", "--porcelain"]).await.map(|s| s.lines().count() as u32).unwrap_or(0);
    let upstream = run(cwd, "git", &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).await.ok();
    let (ahead, behind) = match &upstream {
        Some(_) => run(cwd, "git", &["rev-list", "--left-right", "--count", "@{u}...HEAD"])
            .await
            .ok()
            .and_then(|s| {
                let mut it = s.split_whitespace();
                Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
            })
            .map(|(behind, ahead)| (ahead, behind))
            .unwrap_or((0, 0)),
        None => (0, 0),
    };
    let remote_url = run(cwd, "git", &["remote", "get-url", "origin"]).await.ok();
    let pull_request = match (&branch, remote_url.as_deref().is_some_and(|u| u.contains("github.com")), gh_available().await) {
        (Some(_), true, true) => {
            run(cwd, "gh", &["pr", "view", "--json", "number,title,url,state,headRefName,baseRefName,isDraft,author,updatedAt"])
                .await
                .ok()
                .and_then(|s| serde_json::from_str::<Value>(&s).ok())
                .and_then(|v| parse_pr(&v))
        }
        _ => None,
    };
    Ok(GitStatus { is_git: true, branch, dirty_files, ahead, behind, upstream, remote_url, pull_request })
}

fn parse_pr(v: &Value) -> Option<PullRequest> {
    Some(PullRequest {
        number: v.get("number")?.as_u64()?,
        title: v.get("title")?.as_str()?.to_string(),
        url: v.get("url")?.as_str()?.to_string(),
        state: v.get("state").and_then(|s| s.as_str()).unwrap_or("OPEN").to_string(),
        head: v.get("headRefName").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        base: v.get("baseRefName").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        is_draft: v.get("isDraft").and_then(|b| b.as_bool()).unwrap_or(false),
        author: v.pointer("/author/login").and_then(|s| s.as_str()).unwrap_or("").to_string(),
        updated_at: v.get("updatedAt").and_then(|s| s.as_str()).and_then(|s| s.parse().ok()).unwrap_or_else(chrono::Utc::now),
    })
}

pub async fn commit_all(cwd: &Path, message: &str) -> Result<String> {
    run(cwd, "git", &["add", "-A", "--", "."]).await?;
    run(cwd, "git", &["commit", "-q", "-m", message]).await?;
    run(cwd, "git", &["rev-parse", "HEAD"]).await
}

pub async fn has_changes(cwd: &Path) -> bool {
    run(cwd, "git", &["status", "--porcelain"]).await.map(|s| !s.trim().is_empty()).unwrap_or(false)
}

/// Diff of what would go into a PR: committed changes vs the base branch plus the working tree.
pub async fn diff_against_base(cwd: &Path, base: &str) -> Result<String> {
    let merge_base =
        run(cwd, "git", &["merge-base", &format!("origin/{base}"), "HEAD"]).await.or_else(|_| Ok::<_, anyhow::Error>(base.to_string()))?;
    run(cwd, "git", &["diff", "--no-color", "--stat", "-p", &merge_base]).await
}

pub async fn default_base(cwd: &Path) -> String {
    if let Ok(s) = run(cwd, "gh", &["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]).await
        && !s.is_empty()
    {
        return s;
    }
    if let Ok(s) = run(cwd, "git", &["symbolic-ref", "refs/remotes/origin/HEAD"]).await
        && let Some(b) = s.rsplit('/').next()
    {
        return b.to_string();
    }
    "main".into()
}

pub async fn push_current(cwd: &Path) -> Result<()> {
    let branch = run(cwd, "git", &["symbolic-ref", "--short", "HEAD"]).await?;
    run(cwd, "git", &["push", "-u", "origin", &branch]).await.map(|_| ())
}

pub async fn pr_create(cwd: &Path, title: &str, body: &str, base: &str, draft: bool) -> Result<PullRequest> {
    let mut args = vec!["pr", "create", "--title", title, "--body", body, "--base", base];
    if draft {
        args.push("--draft");
    }
    run(cwd, "gh", &args).await?;
    let json = run(cwd, "gh", &["pr", "view", "--json", "number,title,url,state,headRefName,baseRefName,isDraft,author,updatedAt"]).await?;
    parse_pr(&serde_json::from_str::<Value>(&json)?).ok_or_else(|| anyhow!("could not read the created pull request"))
}

pub async fn pr_list(cwd: &Path, state: &str, limit: u32) -> Result<Vec<PullRequest>> {
    let limit = limit.to_string();
    let json = run(
        cwd,
        "gh",
        &[
            "pr",
            "list",
            "--state",
            state,
            "--limit",
            &limit,
            "--json",
            "number,title,url,state,headRefName,baseRefName,isDraft,author,updatedAt",
        ],
    )
    .await?;
    let v: Value = serde_json::from_str(&json)?;
    Ok(v.as_array().map(|a| a.iter().filter_map(parse_pr).collect()).unwrap_or_default())
}
