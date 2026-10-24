//! `kybern_git`: the Coordinator's git tool. It runs in the Coordinator's
//! checkout without a shell, and offers only the operations a lead needs to
//! inspect, branch, commit, integrate its agents' branches and land work.
//!
//! This module holds the parts that do not depend on a session: the tool
//! definition, argument validation and the git/GitHub operations themselves.
//! `orchestrator/lead_git.rs` adds the guards that need thread state and the
//! approval cards for push, pull requests and merging.
//!
//! Not offered, on purpose: tags, releases, force pushes, rebase, reset and
//! deleting branches.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Result, anyhow, bail, ensure};
use kybern_git::{MergeOutcome, Repo};
use kybern_protocol::ThreadId;
use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) const TOOL: &str = "kybern_git";

/// How long a push, pull request or merge card waits for the user.
pub(crate) const APPROVAL_WAIT: Duration = Duration::from_secs(600);
/// Slack on top of the card's wait for the work after the answer.
const CALL_SLACK: Duration = Duration::from_secs(90);
/// A call that never asks the user can still wait on hooks and the network.
const PLAIN_CALL: Duration = Duration::from_secs(65);

const MAX_CHANGES: usize = 200;
const MAX_BRANCHES: usize = 100;
const MAX_LOG: usize = 100;
const DEFAULT_LOG: usize = 20;
const MAX_PATCH_BYTES: usize = 128 * 1024;
const MAX_MESSAGE_CHARS: usize = 8000;
const MAX_TITLE_CHARS: usize = 256;
const MAX_BODY_CHARS: usize = 20_000;
const MAX_PATHS: usize = 200;

const GH_MISSING: &str =
    "The GitHub CLI (gh) is not installed. Ask the user to install it from https://cli.github.com and run `gh auth login`, then try again.";
const GH_SIGNED_OUT: &str = "The GitHub CLI (gh) is not signed in. Ask the user to run `gh auth login`, then try again.";
const NO_IDENTITY: &str = "Git has no commit identity in this repository. Ask the user to run `git config user.name \"Your Name\"` and `git config user.email you@example.com`, then try again.";
const BRANCH_FIRST: &str = "This is the default branch. Create a branch first with op create_branch.";

pub(crate) fn is_tool(name: &str) -> bool {
    name == TOOL
}

/// How long a call to `name` may run: the user's wait plus slack for the ops
/// that ask, a minute for the rest. `None` for other tools.
pub(crate) fn call_budget(name: &str, arguments: &Value) -> Option<Duration> {
    if !is_tool(name) {
        return None;
    }
    let asks = matches!(arguments.get("op").and_then(Value::as_str), Some("push" | "open_pr" | "merge_pr"));
    Some(if asks { APPROVAL_WAIT + CALL_SLACK } else { PLAIN_CALL })
}

/// Test hooks: the program that stands for `gh` and extra git environment.
#[derive(Default)]
pub(crate) struct LeadGitConfig {
    gh: Mutex<Option<String>>,
    git_env: Mutex<Vec<(String, String)>>,
}

impl LeadGitConfig {
    #[cfg(test)]
    pub(crate) fn set_gh(&self, program: impl Into<String>) {
        *self.gh.lock().unwrap_or_else(|error| error.into_inner()) = Some(program.into());
    }

    #[cfg(test)]
    pub(crate) fn set_git_env(&self, env: Vec<(String, String)>) {
        *self.git_env.lock().unwrap_or_else(|error| error.into_inner()) = env;
    }
}

pub(crate) fn tool_definition() -> kybern_drivers::NativeToolDefinition {
    kybern_drivers::NativeToolDefinition {
        name: TOOL.into(),
        description: concat!(
            "Run git in this project's checkout, without a shell. Set op to one of: ",
            "status; log {limit}; diff {staged, path} (uncommitted changes to tracked files; untracked files are listed by status); branches; ",
            "create_branch {name, from} (creates the branch and switches to it); switch {branch}; ",
            "commit {message, paths} (stages the given paths, or every change; refused on main and master); ",
            "merge_child {thread_id} (merges a worktree agent's branch into the current branch with a merge commit; a conflict is aborted and its files returned); ",
            "push {branch} (sets the upstream); open_pr {title, body, base} (pushes the branch first if needed); merge_pr {number, method: squash|merge}. ",
            "Free: status, log, diff, branches, create_branch, switch, commit, merge_child. ",
            "The user is asked first, in a card: push and open_pr (unless the user allowed pushing without asking in the Coordinator settings) and merge_pr (always). ",
            "A declined card means do not retry unless the user asks. ",
            "create_branch and switch wait until agents working in this checkout have finished; switch also needs a clean tree. ",
            "Commits use the repository's git identity. Not available: tags, releases, force push, rebase, reset, deleting branches. ",
            "Agents you delegate to never commit in this checkout; you review, commit and land their work. ",
            "Group projects hold several repositories: pass repo to act on one; status, log, diff and branches without repo cover every repository, ",
            "and merge_child merges every repository the agent changed, or none if any conflicts."
        )
        .into(),
        input_schema: json!({
            "type": "object", "additionalProperties": false,
            "properties": {
                "op": {"enum": ["status","log","diff","branches","create_branch","switch","commit","merge_child","push","open_pr","merge_pr"]},
                "repo": {"type":["string","null"],"description":"Group projects: the repository to act on. Omit for status, log, diff and branches to get every repository."},
                "limit": {"type":["integer","null"],"minimum":1,"maximum":MAX_LOG,"description":"log: how many commits. Default 20."},
                "staged": {"type":["boolean","null"],"description":"diff: only staged changes."},
                "path": {"type":["string","null"],"description":"diff: limit to one repository-relative path."},
                "name": {"type":["string","null"],"description":"create_branch: the new branch name."},
                "from": {"type":["string","null"],"description":"create_branch: start point. Default HEAD."},
                "branch": {"type":["string","null"],"description":"switch: the branch. push: the branch to push; default the current one."},
                "message": {"type":["string","null"],"description":"commit: the commit message."},
                "paths": {"type":["array","null"],"items":{"type":"string"},"description":"commit: repository-relative paths to commit. Omit to commit every change."},
                "thread_id": {"type":["string","null"],"format":"uuid","description":"merge_child: the worktree agent whose branch to merge."},
                "title": {"type":["string","null"],"description":"open_pr: the pull request title."},
                "body": {"type":["string","null"],"description":"open_pr: the pull request description."},
                "base": {"type":["string","null"],"description":"open_pr: the branch to merge into. Default the repository's default branch."},
                "number": {"type":["integer","null"],"minimum":1,"description":"merge_pr: the pull request number."},
                "method": {"enum": ["squash","merge",null],"description":"merge_pr: how to merge."}
            },
            "required": ["op"]
        }),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawArgs {
    op: String,
    /// Read by `repo_arg`; `Op` itself is the same for every repository.
    #[serde(default)]
    #[allow(dead_code)]
    repo: Option<String>,
    #[serde(default)]
    limit: Option<u64>,
    #[serde(default)]
    staged: Option<bool>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    from: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    paths: Option<Vec<String>>,
    #[serde(default)]
    thread_id: Option<ThreadId>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    number: Option<u64>,
    #[serde(default)]
    method: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MergeMethod {
    Squash,
    Merge,
}

impl MergeMethod {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            MergeMethod::Squash => "squash",
            MergeMethod::Merge => "merge",
        }
    }
}

/// A validated call.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Op {
    Status,
    Log { limit: usize },
    Diff { staged: bool, path: Option<String> },
    Branches,
    CreateBranch { name: String, from: Option<String> },
    Switch { branch: String },
    Commit { message: String, paths: Option<Vec<String>> },
    MergeChild { thread_id: ThreadId },
    Push { branch: Option<String> },
    OpenPr { title: String, body: String, base: Option<String> },
    MergePr { number: u64, method: MergeMethod },
}

fn text(value: Option<String>) -> Option<String> {
    value.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

fn required(value: Option<String>, field: &str, op: &str) -> Result<String> {
    text(value).ok_or_else(|| anyhow!("{op} needs {field}. Pass {field} and call kybern_git again."))
}

fn too_long(value: &str, max: usize, field: &str) -> Result<()> {
    ensure!(value.chars().count() <= max, "{field} is too long (at most {max} characters). Shorten it and call kybern_git again.");
    Ok(())
}

/// A repository-relative path: no absolute paths, no `..`, no option-like names.
fn relative_path(path: &str) -> Result<String> {
    let path = path.trim();
    let candidate = Path::new(path);
    ensure!(
        !path.is_empty()
            && !path.starts_with('-')
            && !path.contains('\0')
            && !candidate.is_absolute()
            && candidate.components().all(|part| matches!(part, std::path::Component::Normal(_) | std::path::Component::CurDir)),
        "paths must be relative to the repository and stay inside it (got {path:?})."
    );
    Ok(path.to_owned())
}

/// A ref name that cannot be mistaken for a git option.
fn ref_name(value: &str, field: &str) -> Result<()> {
    ensure!(
        !value.starts_with('-') && !value.contains('\0') && !value.contains(char::is_whitespace),
        "{field} is not a valid branch name. Use letters, digits and `/`, `-`, `_`, `.`."
    );
    Ok(())
}

impl Op {
    pub(crate) fn parse(arguments: Value) -> Result<Op> {
        let raw: RawArgs = serde_json::from_value(arguments).map_err(|error| {
            anyhow!("Invalid arguments for kybern_git: {error}. Pass op, plus the fields that op uses (see the tool description).")
        })?;
        let op = raw.op.as_str();
        Ok(match op {
            "status" => Op::Status,
            "log" => Op::Log { limit: raw.limit.map_or(DEFAULT_LOG, |limit| (limit as usize).clamp(1, MAX_LOG)) },
            "diff" => Op::Diff { staged: raw.staged.unwrap_or(false), path: text(raw.path).map(|path| relative_path(&path)).transpose()? },
            "branches" => Op::Branches,
            "create_branch" => {
                let name = required(raw.name, "name", op)?;
                ref_name(&name, "name")?;
                let from = text(raw.from);
                if let Some(from) = &from {
                    ref_name(from, "from")?;
                }
                Op::CreateBranch { name, from }
            }
            "switch" => {
                let branch = required(raw.branch, "branch", op)?;
                ref_name(&branch, "branch")?;
                Op::Switch { branch }
            }
            "commit" => {
                let message = required(raw.message, "message", op)?;
                too_long(&message, MAX_MESSAGE_CHARS, "message")?;
                let paths = match raw.paths {
                    Some(paths) if !paths.is_empty() => {
                        ensure!(paths.len() <= MAX_PATHS, "Pass at most {MAX_PATHS} paths, or omit paths to commit every change.");
                        Some(paths.iter().map(|path| relative_path(path)).collect::<Result<Vec<_>>>()?)
                    }
                    _ => None,
                };
                Op::Commit { message, paths }
            }
            "merge_child" => Op::MergeChild {
                thread_id: raw.thread_id.ok_or_else(|| anyhow!("merge_child needs thread_id: the id of the worktree agent."))?,
            },
            "push" => {
                let branch = text(raw.branch);
                if let Some(branch) = &branch {
                    ref_name(branch, "branch")?;
                }
                Op::Push { branch }
            }
            "open_pr" => {
                let title = required(raw.title, "title", op)?;
                too_long(&title, MAX_TITLE_CHARS, "title")?;
                let body = raw.body.unwrap_or_default().trim().to_owned();
                too_long(&body, MAX_BODY_CHARS, "body")?;
                let base = text(raw.base);
                if let Some(base) = &base {
                    ref_name(base, "base")?;
                }
                Op::OpenPr { title, body, base }
            }
            "merge_pr" => {
                let number = raw.number.ok_or_else(|| anyhow!("merge_pr needs number: the pull request number."))?;
                let method = match text(raw.method).as_deref() {
                    Some("squash") => MergeMethod::Squash,
                    Some("merge") => MergeMethod::Merge,
                    _ => bail!("merge_pr needs method: \"squash\" or \"merge\"."),
                };
                Op::MergePr { number, method }
            }
            other => bail!(
                "Unknown op {other:?}. Use status, log, diff, branches, create_branch, switch, commit, merge_child, push, open_pr or merge_pr. Tags, releases, force push, rebase, reset and deleting branches are not offered."
            ),
        })
    }
}

/// The `repo` argument: a member path relative to the group folder, `*` (every
/// repository) or `None`. Validated like other paths; `.` is the folder itself.
pub(crate) fn repo_arg(arguments: &Value) -> Result<Option<String>> {
    let Some(value) = arguments.get("repo").filter(|value| !value.is_null()) else { return Ok(None) };
    let repo = value.as_str().ok_or_else(|| anyhow!("repo must be a repository path such as \"api\"."))?.trim();
    if repo.is_empty() {
        return Ok(None);
    }
    if repo == "*" || repo == "." {
        return Ok(Some(repo.to_owned()));
    }
    let repo = relative_path(repo)?;
    Ok(Some(repo.trim_start_matches("./").trim_end_matches('/').to_owned()))
}

/// What a push will do, shown on the card.
#[derive(Debug, Clone)]
pub(crate) struct PushPlan {
    pub remote: String,
    pub branch: String,
    pub ahead: u32,
    /// The branch has an upstream already.
    pub tracked: bool,
}

/// What opening a pull request will do, shown on the card.
#[derive(Debug, Clone)]
pub(crate) struct PrPlan {
    pub push: PushPlan,
    pub title: String,
    pub body: String,
    pub base: String,
}

/// A pull request about to be merged, shown on the card.
#[derive(Debug, Clone)]
pub(crate) struct MergePlan {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub checks: Value,
    pub method: MergeMethod,
}

/// A checkout and the programs to work on it with.
pub(crate) struct Git {
    pub repo: Repo,
    cwd: PathBuf,
    gh: String,
    /// Paths of nested repositories this checkout must leave alone: the other
    /// members, when this is a group folder that is itself a repository.
    exclude: Vec<String>,
}

impl Git {
    pub(crate) async fn open(cwd: &Path, config: &LeadGitConfig) -> Result<Git> {
        ensure!(Repo::is_repo(cwd).await, "This project is not a git repository. Ask the user to run `git init` in it, then try again.");
        let env = config.git_env.lock().unwrap_or_else(|error| error.into_inner()).clone();
        let gh = config.gh.lock().unwrap_or_else(|error| error.into_inner()).clone().unwrap_or_else(|| "gh".into());
        Ok(Git { repo: Repo::new(cwd).with_env(env), cwd: cwd.to_path_buf(), gh, exclude: Vec::new() })
    }

    /// The same checkout, leaving the nested repositories at `exclude` out of
    /// status, diffs, clean checks and commits.
    pub(crate) fn excluding(mut self, exclude: Vec<String>) -> Git {
        self.exclude = exclude;
        self
    }

    fn is_excluded(&self, path: &str) -> bool {
        let path = path.trim_end_matches('/');
        self.exclude.iter().any(|nested| path == nested || path.starts_with(&format!("{nested}/")))
    }

    async fn entries(&self) -> Result<Vec<kybern_git::StatusEntry>> {
        let mut entries = self.repo.status_entries().await?;
        entries.retain(|entry| !self.is_excluded(&entry.path));
        Ok(entries)
    }

    pub(crate) async fn current_branch(&self) -> Option<String> {
        self.repo.current_branch().await
    }

    async fn require_branch(&self) -> Result<String> {
        self.current_branch()
            .await
            .ok_or_else(|| anyhow!("HEAD is detached, not on a branch. Create a branch first with op create_branch."))
    }

    async fn require_identity(&self) -> Result<()> {
        let (name, email) = self.repo.identity().await;
        ensure!(name.is_some() && email.is_some(), NO_IDENTITY);
        Ok(())
    }

    /// Refuse to commit or merge onto the default branch.
    async fn require_feature_branch(&self) -> Result<String> {
        let branch = self.require_branch().await?;
        ensure!(!self.repo.is_default_branch(&branch).await, BRANCH_FIRST);
        Ok(branch)
    }

    async fn require_clean(&self, why: &str) -> Result<()> {
        let changes = self.entries().await?.len();
        ensure!(changes == 0, "There are {changes} uncommitted changes. Commit them first with op commit, then {why}.");
        Ok(())
    }

    // ---- free ops ----

    pub(crate) async fn status(&self) -> Result<Value> {
        let branch = self.current_branch().await;
        let entries = self.entries().await?;
        let (upstream, ahead_behind) = match &branch {
            Some(branch) => (self.repo.upstream(branch).await, self.repo.ahead_behind(branch).await),
            None => (None, None),
        };
        let on_default = match &branch {
            Some(branch) => self.repo.is_default_branch(branch).await,
            None => false,
        };
        let merging = self.repo.git_dir().await.map(|dir| dir.join("MERGE_HEAD").exists()).unwrap_or(false);
        let total = entries.len();
        let changes: Vec<Value> =
            entries.into_iter().take(MAX_CHANGES).map(|entry| json!({"code": entry.code, "path": entry.path})).collect();
        Ok(json!({
            "branch": branch,
            "detached": branch.is_none(),
            "head": self.repo.head().await.map(|head| head.chars().take(12).collect::<String>()),
            "on_default_branch": on_default,
            "default_branch": self.repo.default_branch().await,
            "upstream": upstream,
            "ahead": ahead_behind.map(|(ahead, _)| ahead),
            "behind": ahead_behind.map(|(_, behind)| behind),
            "clean": total == 0,
            "merge_in_progress": merging,
            "changes": changes,
            "changes_truncated": total.saturating_sub(MAX_CHANGES),
        }))
    }

    pub(crate) async fn log(&self, limit: usize) -> Result<Value> {
        let entries = self.repo.log(limit).await?;
        let commits: Vec<Value> = entries
            .into_iter()
            .map(|entry| {
                json!({
                    "hash": entry.hash,
                    "short": entry.hash.chars().take(8).collect::<String>(),
                    "author": entry.author,
                    "date": entry.date,
                    "subject": entry.subject,
                })
            })
            .collect();
        Ok(json!({ "branch": self.current_branch().await, "commits": commits }))
    }

    pub(crate) async fn diff(&self, staged: bool, path: Option<&str>) -> Result<Value> {
        let diff = self.repo.diff_uncommitted(staged, path, MAX_PATCH_BYTES).await?;
        let files: Vec<Value> = diff
            .files
            .iter()
            .filter(|file| !self.is_excluded(&file.path))
            .take(MAX_CHANGES)
            .map(|file| json!({"path": file.path, "additions": file.additions, "deletions": file.deletions, "binary": file.binary}))
            .collect();
        let untracked: Vec<String> = if staged {
            Vec::new()
        } else {
            self.entries()
                .await?
                .into_iter()
                .filter(|entry| entry.code == "??")
                .map(|entry| entry.path)
                .filter(|entry| path.is_none_or(|path| entry == path || entry.starts_with(&format!("{}/", path.trim_end_matches('/')))))
                .take(MAX_CHANGES)
                .collect()
        };
        Ok(json!({
            "scope": if staged { "staged" } else { "uncommitted" },
            "files": files,
            "untracked": untracked,
            "patch": diff.patch,
            "patch_truncated": diff.patch_truncated,
        }))
    }

    pub(crate) async fn branches(&self) -> Result<Value> {
        let current = self.current_branch().await;
        let all = self.repo.branches().await?;
        let total = all.len();
        let branches: Vec<Value> = all
            .into_iter()
            .take(MAX_BRANCHES)
            .map(|branch| {
                json!({
                    "name": branch.name,
                    "is_current": current.as_deref() == Some(branch.name.as_str()),
                    "upstream": branch.upstream,
                    "committed_at": branch.committed_at,
                })
            })
            .collect();
        Ok(json!({
            "current": current,
            "default_branch": self.repo.default_branch().await,
            "branches": branches,
            "truncated": total.saturating_sub(MAX_BRANCHES),
        }))
    }

    pub(crate) async fn create_branch(&self, name: &str, from: Option<&str>) -> Result<Value> {
        ensure!(
            self.repo.is_valid_branch_name(name).await,
            "{name:?} is not a valid branch name. Use letters, digits and `/`, `-`, `_`, `.`."
        );
        ensure!(
            self.repo.rev_parse(&format!("refs/heads/{name}")).await.is_err(),
            "A branch named {name} already exists. Pick another name, or switch to it with op switch."
        );
        if let Some(from) = from {
            ensure!(self.repo.rev_parse(from).await.is_ok(), "{from} is not a branch or commit in this repository.");
        }
        let before = self.current_branch().await;
        self.repo.create_branch(name, from).await?;
        Ok(json!({ "status": "created", "branch": name, "from": from.map(str::to_owned).or(before) }))
    }

    pub(crate) async fn switch(&self, branch: &str) -> Result<Value> {
        ensure!(
            self.repo.rev_parse(&format!("refs/heads/{branch}")).await.is_ok(),
            "There is no local branch named {branch}. See the branches op for the choices."
        );
        if self.current_branch().await.as_deref() == Some(branch) {
            return Ok(json!({ "status": "already_on_branch", "branch": branch }));
        }
        self.require_clean(&format!("switch to {branch}")).await?;
        self.repo.switch(branch).await?;
        Ok(json!({ "status": "switched", "branch": branch }))
    }

    pub(crate) async fn commit(&self, message: &str, paths: Option<&[String]>) -> Result<Value> {
        let branch = self.require_feature_branch().await?;
        self.require_identity().await?;
        ensure!(!self.entries().await?.is_empty(), "Nothing to commit: the working tree is clean.");
        // "Every change" in a group folder that is a repository never adds the nested ones.
        let everything: Vec<String> = if paths.is_none() && !self.exclude.is_empty() {
            std::iter::once(".".to_owned()).chain(kybern_git::exclude_pathspecs(&self.exclude)).collect()
        } else {
            Vec::new()
        };
        let paths = if everything.is_empty() { paths } else { Some(everything.as_slice()) };
        let commit = self.repo.commit(message, paths).await?;
        Ok(json!({
            "status": "committed",
            "branch": branch,
            "commit": commit,
            "short": commit.chars().take(8).collect::<String>(),
            "subject": message.lines().next().unwrap_or(""),
        }))
    }

    /// What every merge needs, checked in each repository of a group before any merges.
    pub(crate) async fn preflight_merge(&self) -> Result<()> {
        self.require_feature_branch().await?;
        self.require_identity().await?;
        self.require_clean("merge").await
    }

    /// Merge a worktree agent's branch into the current one.
    pub(crate) async fn merge_branch(&self, branch: &str, message: &str, warning: Option<&str>) -> Result<Value> {
        let current = self.require_feature_branch().await?;
        self.require_identity().await?;
        self.require_clean("merge").await?;
        ensure!(
            self.repo.rev_parse(&format!("refs/heads/{branch}")).await.is_ok(),
            "The branch {branch} no longer exists. It was removed after its work was merged, or because it held no commits."
        );
        let mut result = match self.repo.merge_no_ff(branch, message).await? {
            MergeOutcome::Merged { commit } => json!({ "status": "merged", "branch": branch, "into": current, "commit": commit }),
            MergeOutcome::AlreadyUpToDate => json!({ "status": "already_merged", "branch": branch, "into": current }),
            MergeOutcome::Conflict { paths } => json!({
                "status": "conflict",
                "branch": branch,
                "into": current,
                "conflicts": paths,
                "message": "The merge was aborted and nothing changed. Send the agent the conflicting files and ask it to merge the current branch into its own branch and resolve them, then merge_child again."
            }),
        };
        if let (Some(warning), Some(object)) = (warning, result.as_object_mut()) {
            object.insert("warning".into(), json!(warning));
        }
        Ok(result)
    }

    // ---- push ----

    pub(crate) async fn plan_push(&self, branch: Option<&str>) -> Result<PushPlan> {
        let branch = match branch {
            Some(branch) => branch.to_owned(),
            None => self.require_branch().await?,
        };
        ensure!(
            self.repo.rev_parse(&format!("refs/heads/{branch}")).await.is_ok(),
            "There is no local branch named {branch}. See the branches op for the choices."
        );
        let remote = self.repo.push_remote(&branch).await.ok_or_else(|| {
            anyhow!("This repository has no remote to push to. Ask the user to add one with `git remote add origin <url>`, then try again.")
        })?;
        let ahead = self.repo.commits_ahead(&branch, &remote).await?;
        let tracked = self.repo.upstream(&branch).await.is_some();
        Ok(PushPlan { remote, branch, ahead, tracked })
    }

    pub(crate) async fn push(&self, plan: &PushPlan) -> Result<Value> {
        let output = self.repo.push_upstream(&plan.remote, &plan.branch).await?;
        Ok(json!({
            "status": "pushed",
            "remote": plan.remote,
            "branch": plan.branch,
            "upstream": self.repo.upstream(&plan.branch).await,
            "ahead": plan.ahead,
            "output": output.chars().take(2000).collect::<String>(),
        }))
    }

    // ---- GitHub ----

    async fn gh(&self, args: &[&str]) -> Result<String> {
        crate::github::run(&self.cwd, &self.gh, args).await
    }

    /// `gh` is installed and signed in. Checked before a card is raised, so the
    /// user is never asked to approve something that cannot run.
    pub(crate) async fn require_gh(&self) -> Result<()> {
        ensure!(self.gh(&["--version"]).await.is_ok(), GH_MISSING);
        ensure!(self.gh(&["auth", "status"]).await.is_ok(), GH_SIGNED_OUT);
        Ok(())
    }

    async fn default_base(&self) -> String {
        if let Ok(name) = self.gh(&["repo", "view", "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"]).await
            && !name.is_empty()
        {
            return name;
        }
        self.repo.default_branch().await.unwrap_or_else(|| "main".into())
    }

    pub(crate) async fn plan_open_pr(&self, title: &str, body: &str, base: Option<&str>) -> Result<PrPlan> {
        self.require_gh().await?;
        let branch = self.require_feature_branch().await?;
        let push = self.plan_push(Some(&branch)).await?;
        let base = match base {
            Some(base) => base.to_owned(),
            None => self.default_base().await,
        };
        ensure!(branch != base, "The branch {branch} is the base of the pull request. Create a branch first with op create_branch.");
        if let Ok(existing) = self.gh(&["pr", "view", &branch, "--json", "number,url,state"]).await
            && let Ok(existing) = serde_json::from_str::<Value>(&existing)
            && existing["state"].as_str() == Some("OPEN")
        {
            bail!(
                "A pull request is already open for {branch}: {}. Push new commits with op push instead.",
                existing["url"].as_str().unwrap_or("(no link)")
            );
        }
        Ok(PrPlan { push, title: title.to_owned(), body: body.to_owned(), base })
    }

    pub(crate) async fn open_pr(&self, plan: &PrPlan) -> Result<Value> {
        let branch = &plan.push.branch;
        if plan.push.ahead > 0 || !plan.push.tracked {
            self.push(&plan.push).await?;
        }
        self.gh(&["pr", "create", "--title", &plan.title, "--body", &plan.body, "--base", &plan.base, "--head", branch]).await?;
        let view =
            self.gh(&["pr", "view", branch, "--json", "number,title,url,state,headRefName,baseRefName,isDraft,author,updatedAt"]).await?;
        let pr = crate::github::parse_pr(&serde_json::from_str::<Value>(&view)?)
            .ok_or_else(|| anyhow!("The pull request was created but could not be read back. Check GitHub for it."))?;
        Ok(json!({ "status": "opened", "number": pr.number, "url": pr.url, "title": pr.title, "head": pr.head, "base": pr.base }))
    }

    pub(crate) async fn plan_merge_pr(&self, number: u64, method: MergeMethod) -> Result<MergePlan> {
        self.require_gh().await?;
        let number_text = number.to_string();
        let view = self
            .gh(&["pr", "view", &number_text, "--json", "number,title,url,state,mergeable,isDraft,statusCheckRollup"])
            .await
            .map_err(|error| anyhow!("Could not read pull request #{number}: {error}. Check the number, then try again."))?;
        let view: Value = serde_json::from_str(&view)?;
        let state = view["state"].as_str().unwrap_or("");
        ensure!(state == "OPEN", "Pull request #{number} is {}, not open.", state.to_lowercase());
        ensure!(
            view["isDraft"].as_bool() != Some(true),
            "Pull request #{number} is a draft. Ask the user to mark it ready, then try again."
        );
        ensure!(
            view["mergeable"].as_str() != Some("CONFLICTING"),
            "Pull request #{number} has merge conflicts. Merge its base branch into the branch and resolve them first."
        );
        let rollup: Vec<Value> = view["statusCheckRollup"].as_array().cloned().unwrap_or_default();
        let checks = serde_json::to_value(crate::github::summarize_checks(&rollup))?;
        Ok(MergePlan {
            number,
            title: view["title"].as_str().unwrap_or("").to_owned(),
            url: view["url"].as_str().unwrap_or("").to_owned(),
            checks,
            method,
        })
    }

    pub(crate) async fn merge_pr(&self, plan: &MergePlan) -> Result<Value> {
        let number = plan.number.to_string();
        let flag = match plan.method {
            MergeMethod::Squash => "--squash",
            MergeMethod::Merge => "--merge",
        };
        self.gh(&["pr", "merge", &number, flag]).await?;
        Ok(json!({ "status": "merged", "number": plan.number, "method": plan.method.as_str(), "url": plan.url }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(value: Value) -> Result<Op> {
        Op::parse(value)
    }

    #[test]
    fn every_op_parses_and_unknown_ones_name_what_is_not_offered() {
        assert_eq!(parse(json!({"op":"status"})).unwrap(), Op::Status);
        assert_eq!(parse(json!({"op":"log"})).unwrap(), Op::Log { limit: 20 });
        assert_eq!(parse(json!({"op":"log","limit":500})).unwrap(), Op::Log { limit: 100 });
        assert_eq!(
            parse(json!({"op":"diff","staged":true,"path":"src/a.rs","name":null})).unwrap(),
            Op::Diff { staged: true, path: Some("src/a.rs".into()) }
        );
        assert_eq!(
            parse(json!({"op":"create_branch","name":"feat/x","from":"main"})).unwrap(),
            Op::CreateBranch { name: "feat/x".into(), from: Some("main".into()) }
        );
        assert_eq!(
            parse(json!({"op":"commit","message":" Fix it ","paths":[]})).unwrap(),
            Op::Commit { message: "Fix it".into(), paths: None }
        );
        assert_eq!(
            parse(json!({"op":"open_pr","title":"T","body":null})).unwrap(),
            Op::OpenPr { title: "T".into(), body: String::new(), base: None }
        );
        assert_eq!(
            parse(json!({"op":"merge_pr","number":7,"method":"squash"})).unwrap(),
            Op::MergePr { number: 7, method: MergeMethod::Squash }
        );
        for op in ["tag", "release", "force_push", "rebase", "reset", "delete_branch"] {
            let error = parse(json!({"op": op})).unwrap_err().to_string();
            assert!(error.contains("not offered"), "{op}: {error}");
        }
    }

    #[test]
    fn bad_arguments_say_what_to_pass() {
        for (args, needle) in [
            (json!({"op":"switch"}), "branch"),
            (json!({"op":"create_branch","name":"-x"}), "valid branch name"),
            (json!({"op":"create_branch","name":"a b"}), "valid branch name"),
            (json!({"op":"commit"}), "message"),
            (json!({"op":"commit","message":"m","paths":["/etc/passwd"]}), "relative"),
            (json!({"op":"commit","message":"m","paths":["../x"]}), "relative"),
            (json!({"op":"commit","message":"m","paths":["--all"]}), "relative"),
            (json!({"op":"merge_child"}), "thread_id"),
            (json!({"op":"merge_pr","number":1}), "method"),
            (json!({"op":"merge_pr","number":1,"method":"rebase"}), "method"),
            (json!({"op":"merge_pr","method":"merge"}), "number"),
            (json!({"op":"open_pr"}), "title"),
            (json!({"op":"push","remote":"origin"}), "unknown field"),
            (json!({"op":"diff","path":"../x"}), "relative"),
        ] {
            let error = parse(args.clone()).unwrap_err().to_string();
            assert!(error.contains(needle), "{args}: {error}");
        }
    }

    #[test]
    fn long_calls_get_the_users_wait_and_the_rest_a_minute() {
        assert_eq!(call_budget(TOOL, &json!({"op":"push"})), Some(Duration::from_secs(690)));
        assert_eq!(call_budget(TOOL, &json!({"op":"merge_pr"})), Some(Duration::from_secs(690)));
        assert_eq!(call_budget(TOOL, &json!({"op":"status"})), Some(Duration::from_secs(65)));
        assert_eq!(call_budget("kybern_read_file", &json!({"op":"push"})), None);
    }

    #[test]
    fn the_definition_is_strict_and_names_the_tiers() {
        let definition = tool_definition();
        assert_eq!(definition.name, TOOL);
        for needle in ["push and open_pr", "merge_pr (always)", "Not available: tags, releases, force push, rebase, reset"] {
            assert!(definition.description.contains(needle), "{needle}");
        }
        assert_eq!(definition.input_schema["additionalProperties"], json!(false));
        let ops = definition.input_schema["properties"]["op"]["enum"].as_array().unwrap();
        assert_eq!(ops.len(), 11);
        for forbidden in ["tag", "release", "force_push", "rebase", "reset", "delete_branch"] {
            assert!(!ops.contains(&json!(forbidden)));
        }
    }
}
