//! Git status and GitHub pull requests through the user's `gh` CLI, which
//! already holds their credentials.

use std::path::Path;

use anyhow::{Context, Result, anyhow};
use kybern_git::Repo;
use kybern_protocol::methods::*;
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::OnceCell;

static GH_AVAILABLE: OnceCell<bool> = OnceCell::const_new();

pub(crate) async fn run(cwd: &Path, program: &str, args: &[&str]) -> Result<String> {
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

pub(crate) fn parse_pr(v: &Value) -> Option<PullRequest> {
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
        author_avatar_url: None,
        author_is_bot: false,
        created_at: None,
        additions: None,
        deletions: None,
        review_decision: None,
        mergeable: None,
        labels: Vec::new(),
        checks_summary: None,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Bucket {
    Passed,
    Failed,
    Pending,
    Skipped,
}

/// Classify one `statusCheckRollup` entry (a CheckRun or a StatusContext).
pub(crate) fn check_bucket(v: &Value) -> Bucket {
    let s = |key: &str| v.get(key).and_then(Value::as_str).unwrap_or_default().to_ascii_uppercase();
    let is_run = v.get("__typename").and_then(Value::as_str) == Some("CheckRun") || v.get("status").is_some();
    if is_run {
        if s("status") != "COMPLETED" {
            return Bucket::Pending;
        }
        return match s("conclusion").as_str() {
            "SUCCESS" => Bucket::Passed,
            "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => Bucket::Failed,
            _ => Bucket::Skipped,
        };
    }
    match s("state").as_str() {
        "SUCCESS" => Bucket::Passed,
        "FAILURE" | "ERROR" => Bucket::Failed,
        "PENDING" | "EXPECTED" => Bucket::Pending,
        _ => Bucket::Skipped,
    }
}

pub(crate) fn summarize_checks(rollup: &[Value]) -> PrChecksSummary {
    let mut out = PrChecksSummary { total: rollup.len() as u32, ..Default::default() };
    for v in rollup {
        match check_bucket(v) {
            Bucket::Passed => out.passed += 1,
            Bucket::Failed => out.failed += 1,
            Bucket::Pending => out.pending += 1,
            Bucket::Skipped => out.skipped += 1,
        }
    }
    out
}

/// Avatar URL for a GraphQL actor, which `gh --json` returns without one. GitHub
/// redirects `{host}/{login}.png` to the avatar CDN (also on Enterprise hosts).
pub(crate) fn avatar_url(pr_url: &str, login: &str, is_bot: bool) -> Option<String> {
    if login.is_empty() || is_bot || login.starts_with("app/") {
        return None;
    }
    let rest = pr_url.strip_prefix("https://").or_else(|| pr_url.strip_prefix("http://"))?;
    let host = rest.split('/').next().filter(|h| !h.is_empty())?;
    Some(format!("https://{host}/{login}.png?size=40"))
}

fn parse_time(v: &Value, key: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    v.get(key).and_then(Value::as_str).and_then(|s| s.parse().ok())
}

/// `parse_pr` plus the list and detail extras.
pub(crate) fn parse_pr_extended(v: &Value) -> Option<PullRequest> {
    let mut pr = parse_pr(v)?;
    pr.author_is_bot = v.pointer("/author/is_bot").and_then(Value::as_bool).unwrap_or(false);
    pr.author_avatar_url = avatar_url(&pr.url, &pr.author, pr.author_is_bot);
    pr.created_at = parse_time(v, "createdAt");
    pr.additions = v.get("additions").and_then(Value::as_u64).map(|n| n as u32);
    pr.deletions = v.get("deletions").and_then(Value::as_u64).map(|n| n as u32);
    pr.review_decision = v.get("reviewDecision").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    pr.mergeable = v.get("mergeable").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    pr.labels = v
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(20)
        .filter_map(|l| {
            Some(PrLabel {
                name: l.get("name")?.as_str()?.to_owned(),
                color: l.get("color").and_then(Value::as_str).unwrap_or_default().to_owned(),
            })
        })
        .collect();
    pr.checks_summary = v.get("statusCheckRollup").and_then(Value::as_array).map(|a| summarize_checks(a));
    Some(pr)
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
            "number,title,url,state,headRefName,baseRefName,isDraft,author,updatedAt,createdAt,additions,deletions,reviewDecision,mergeable,labels,statusCheckRollup",
        ],
    )
    .await?;
    let v: Value = serde_json::from_str(&json)?;
    Ok(v.as_array().map(|a| a.iter().filter_map(parse_pr_extended).collect()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn buckets_cover_every_conclusion_and_state() {
        let run = |status: &str, conclusion: &str| check_bucket(&json!({"__typename":"CheckRun","status":status,"conclusion":conclusion}));
        assert_eq!(run("IN_PROGRESS", ""), Bucket::Pending);
        assert_eq!(run("QUEUED", ""), Bucket::Pending);
        assert_eq!(run("COMPLETED", "SUCCESS"), Bucket::Passed);
        for c in ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"] {
            assert_eq!(run("COMPLETED", c), Bucket::Failed, "{c}");
        }
        for c in ["SKIPPED", "NEUTRAL", "STALE", ""] {
            assert_eq!(run("COMPLETED", c), Bucket::Skipped, "{c}");
        }
        let ctx = |state: &str| check_bucket(&json!({"__typename":"StatusContext","state":state}));
        assert_eq!(ctx("SUCCESS"), Bucket::Passed);
        assert_eq!(ctx("FAILURE"), Bucket::Failed);
        assert_eq!(ctx("ERROR"), Bucket::Failed);
        assert_eq!(ctx("PENDING"), Bucket::Pending);
        assert_eq!(ctx("EXPECTED"), Bucket::Pending);
    }

    #[test]
    fn list_entry_reduces_rollup_to_a_summary() {
        let v = json!({
            "number": 5, "title": "t", "url": "https://github.com/o/r/pull/5", "author": {"login": "ana", "is_bot": false},
            "additions": 12, "deletions": 3, "reviewDecision": "APPROVED", "mergeable": "CONFLICTING",
            "labels": [{"name": "bug", "color": "d73a4a"}],
            "statusCheckRollup": [
                {"__typename":"CheckRun","status":"COMPLETED","conclusion":"SUCCESS"},
                {"__typename":"CheckRun","status":"COMPLETED","conclusion":"FAILURE"},
                {"__typename":"CheckRun","status":"IN_PROGRESS"},
                {"__typename":"StatusContext","state":"SUCCESS"},
            ],
        });
        let pr = parse_pr_extended(&v).unwrap();
        let s = pr.checks_summary.unwrap();
        assert_eq!((s.total, s.passed, s.failed, s.pending, s.skipped), (4, 2, 1, 1, 0));
        assert_eq!(pr.additions, Some(12));
        assert_eq!(pr.mergeable.as_deref(), Some("CONFLICTING"));
        assert_eq!(pr.labels[0].name, "bug");
        assert_eq!(pr.author_avatar_url.as_deref(), Some("https://github.com/ana.png?size=40"));
    }

    #[test]
    fn avatar_urls_skip_bots_and_follow_the_host() {
        assert_eq!(avatar_url("https://github.com/o/r/pull/1", "ana", false).as_deref(), Some("https://github.com/ana.png?size=40"));
        assert_eq!(
            avatar_url("https://ghe.example.com/o/r/pull/1", "ana", false).as_deref(),
            Some("https://ghe.example.com/ana.png?size=40")
        );
        assert!(avatar_url("https://github.com/o/r/pull/1", "dependabot", true).is_none());
        assert!(avatar_url("https://github.com/o/r/pull/1", "app/renovate", false).is_none());
        assert!(avatar_url("https://github.com/o/r/pull/1", "", false).is_none());
    }
}
