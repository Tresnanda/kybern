//! The `kybern_git` tool as the Coordinator's session sees it: who may call it,
//! which guards depend on thread state, and the approval cards.
//!
//! Free ops (status, log, diff, branches, create_branch, switch, commit,
//! merge_child) run at once. Push and open_pr raise a daemon approval card
//! unless the user turned on "push without asking"; merge_pr always does. The
//! checks that could fail (a missing remote, `gh` not signed in) run before the
//! card, so the user is never asked to approve something that cannot happen.
//! Each call gets its own card: an earlier answer never covers a later push.

use std::path::Path;
use std::sync::Arc;

use anyhow::{Result, anyhow, ensure};
use kybern_protocol::*;
use serde_json::{Value, json};
use uuid::Uuid;

use kybern_git::MergeOutcome;

use super::{DaemonAnswer, LiveSession, Orchestrator, group_git};
use crate::lead_git::{APPROVAL_WAIT, Git, Op, TOOL};

/// Why a card was denied because its turn ended (see `resolve_finished_requests`).
const TURN_ENDED: &str = "turn ended";
/// Why a card was denied because nobody answered in time.
const TIMED_OUT: &str = "timed out";
/// Deepest delegation chain searched for agents still using the checkout.
const SHARED_SEARCH_DEPTH: usize = 4;

/// How a card was answered.
enum Verdict {
    Allowed,
    Declined,
    Cancelled,
    TimedOut,
}

impl Verdict {
    /// The tool result for a card that did not allow the action.
    fn outcome(&self, op: &str) -> Value {
        match self {
            Verdict::Allowed => unreachable!("an allowed card runs the operation"),
            Verdict::Declined => {
                json!({ "status": "declined", "op": op, "message": "The user declined. Do not try again unless they ask you to." })
            }
            Verdict::Cancelled => {
                json!({ "status": "cancelled", "op": op, "message": "The run ended before the user answered. Nothing was done." })
            }
            Verdict::TimedOut => {
                json!({ "status": "timed_out", "op": op, "message": "The user did not answer in time. Nothing was done; ask again only if you still need it." })
            }
        }
    }
}

impl Orchestrator {
    /// Whether the Coordinator of `project_id` may push and open pull requests
    /// without a card. The project's own override joins the lookup here once
    /// projects carry one (project override, then global setting, then off).
    fn lead_pushes_without_asking(&self, project_id: ProjectId) -> bool {
        let project = self.inner.store.project_get(project_id).ok().flatten();
        self.inner
            .settings
            .get()
            .orchestration
            .effective_for(project.as_ref().and_then(|p| p.coordinator.as_ref()))
            .lead_push_without_asking
    }

    /// Test hooks for the git tool.
    #[cfg(test)]
    pub(crate) fn lead_git_config(&self) -> &crate::lead_git::LeadGitConfig {
        &self.inner.lead_git
    }

    pub(super) async fn execute_lead_git(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        arguments: Value,
    ) -> Result<Value> {
        ensure!(
            thread.coordinator_project_id.is_some(),
            "kybern_git is only available to a project Coordinator. Ask the Coordinator to do the git work."
        );
        let repo = crate::lead_git::repo_arg(&arguments)?;
        let op = Op::parse(arguments)?;
        let project_id = thread.coordinator_project_id.unwrap_or(thread.project_id);
        if let Some(project) = self.inner.store.project_get(project_id)?.filter(|p| p.kind == ProjectKind::Group) {
            return self.execute_group_lead_git(thread, turn_id, live, &project, repo, op).await;
        }
        ensure!(repo.is_none(), "This project has a single repository. Call kybern_git again without repo.");
        let git = Git::open(Path::new(&thread.cwd), &self.inner.lead_git).await?;
        self.execute_lead_git_op(thread, turn_id, live, &git, op).await
    }

    /// Run one op in one checkout: the project's, or a group member's.
    async fn execute_lead_git_op(&self, thread: &Thread, turn_id: TurnId, live: &Arc<LiveSession>, git: &Git, op: Op) -> Result<Value> {
        match op {
            Op::Status => git.status().await,
            Op::Log { limit } => git.log(limit).await,
            Op::Diff { staged, path } => git.diff(staged, path.as_deref()).await,
            Op::Branches => git.branches().await,
            Op::CreateBranch { name, from } => {
                self.ensure_no_shared_agents(thread)?;
                git.create_branch(&name, from.as_deref()).await
            }
            Op::Switch { branch } => {
                self.ensure_no_shared_agents(thread)?;
                git.switch(&branch).await
            }
            Op::Commit { message, paths } => git.commit(&message, paths.as_deref()).await,
            Op::MergeChild { thread_id } => self.lead_merge_child(thread, git, thread_id).await,
            Op::Push { branch } => {
                let plan = git.plan_push(branch.as_deref()).await?;
                if plan.ahead == 0 && plan.tracked {
                    return Ok(json!({ "status": "up_to_date", "remote": plan.remote, "branch": plan.branch, "ahead": 0 }));
                }
                if !self.lead_pushes_without_asking(thread.project_id) {
                    let input = json!({ "op": "push", "remote": plan.remote, "branch": plan.branch, "ahead": plan.ahead });
                    let summary = format!("Push {} to {} ({} to send)", plan.branch, plan.remote, commit_count(plan.ahead));
                    if let Some(refused) = self.ask_git_card(thread, turn_id, live, "push", input, summary).await? {
                        return Ok(refused);
                    }
                }
                git.push(&plan).await
            }
            Op::OpenPr { title, body, base } => {
                let plan = git.plan_open_pr(&title, &body, base.as_deref()).await?;
                if !self.lead_pushes_without_asking(thread.project_id) {
                    let input = json!({
                        "op": "open_pr", "remote": plan.push.remote, "branch": plan.push.branch, "ahead": plan.push.ahead,
                        "title": plan.title, "body": plan.body, "base": plan.base,
                    });
                    let summary = format!("Open a pull request for {} into {}", plan.push.branch, plan.base);
                    if let Some(refused) = self.ask_git_card(thread, turn_id, live, "open_pr", input, summary).await? {
                        return Ok(refused);
                    }
                }
                git.open_pr(&plan).await
            }
            Op::MergePr { number, method } => {
                let plan = git.plan_merge_pr(number, method).await?;
                // Merging always asks, whatever the push setting says.
                let input = json!({ "op": "merge_pr", "number": plan.number, "title": plan.title, "checks": plan.checks, "method": method.as_str() });
                let summary = format!("Merge pull request #{} ({})", plan.number, method.as_str());
                if let Some(refused) = self.ask_git_card(thread, turn_id, live, "merge_pr", input, summary).await? {
                    return Ok(refused);
                }
                git.merge_pr(&plan).await
            }
        }
    }

    /// Agents of this Coordinator still working in its checkout: they share its
    /// branch and files, so the branch must not move under them.
    fn ensure_no_shared_agents(&self, coordinator: &Thread) -> Result<()> {
        let running = self.running_shared_agents(coordinator.id, SHARED_SEARCH_DEPTH)?;
        ensure!(
            running == 0,
            "Wait for {running} agent{} working in this checkout to finish, or let them finish in their own worktrees.",
            if running == 1 { "" } else { "s" }
        );
        Ok(())
    }

    fn running_shared_agents(&self, parent: ThreadId, depth: usize) -> Result<usize> {
        if depth == 0 {
            return Ok(0);
        }
        let mut running = 0;
        for child in self.inner.store.delegation_children(parent)? {
            let Some(info) = child.delegation.as_ref() else { continue };
            if info.workspace == DelegationWorkspace::Shared && info.status == DelegationStatus::Running {
                running += 1;
            }
            running += self.running_shared_agents(child.id, depth - 1)?;
        }
        Ok(running)
    }

    /// `merge_child`: merge the recorded branch of one of this Coordinator's
    /// worktree agents into the current branch.
    async fn lead_merge_child(&self, coordinator: &Thread, git: &Git, child_id: ThreadId) -> Result<Value> {
        let (child, info) = self.mergeable_child(coordinator, child_id)?;
        let branch = info
            .branch
            .clone()
            .ok_or_else(|| anyhow!("That agent has no recorded branch to merge. Check its result with kybern_agent_status."))?;
        // Edits left uncommitted in the agent's worktree are not on its branch.
        let warning = match info.worktree_state {
            Some(WorktreeState::Removed) => None,
            _ if Path::new(&child.cwd).is_dir() && !kybern_git::Repo::new(&child.cwd).is_clean().await.unwrap_or(true) => Some(
                "The agent left uncommitted changes in its worktree that are not on the branch. Ask it to commit them, then merge again to include them.",
            ),
            _ => None,
        };
        let title = child.title.trim();
        let message = if title.is_empty() { format!("Merge {branch}") } else { format!("Merge {branch}: {title}") };
        git.merge_branch(&branch, &message, warning).await
    }

    /// One of this Coordinator's finished worktree agents, with its delegation record.
    fn mergeable_child(&self, coordinator: &Thread, child_id: ThreadId) -> Result<(Thread, DelegationInfo)> {
        let child = self
            .inner
            .store
            .thread_get(child_id)?
            .ok_or_else(|| anyhow!("There is no thread with that id. Use kybern_agent_status to list your agents."))?;
        let info = child
            .delegation
            .clone()
            .filter(|info| info.parent_thread_id == coordinator.id)
            .ok_or_else(|| anyhow!("That thread is not an agent you delegated to. Use kybern_agent_status to list your agents."))?;
        ensure!(
            info.workspace == DelegationWorkspace::Worktree,
            "That agent worked in this checkout, so its edits are already here. Review them with the diff op and commit."
        );
        ensure!(info.status != DelegationStatus::Running, "That agent is still running. Wait for it with kybern_agent_wait, then merge.");
        Ok((child, info))
    }

    /// `kybern_git` for a group project's Coordinator, whose cwd is the group
    /// folder: `repo` picks a member; read ops without it cover every member,
    /// mutating ops need it, and merge_child fans out over the agent's members.
    async fn execute_group_lead_git(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        project: &Project,
        repo: Option<String>,
        op: Op,
    ) -> Result<Value> {
        let paths: Vec<String> = project.members.iter().map(|m| m.path.clone()).collect();
        let choices = join_or(&paths);
        let cwd = Path::new(&thread.cwd);
        if let Op::MergeChild { thread_id } = op {
            return self.lead_group_merge_child(thread, project, thread_id).await;
        }
        let read_only = matches!(op, Op::Status | Op::Log { .. } | Op::Diff { .. } | Op::Branches);
        let Some(repo) = repo else {
            if !read_only {
                return Err(anyhow!("Name the repository: {choices}."));
            }
            let mut repos = Vec::new();
            for member in &project.members {
                let dir = group_git::member_dir(cwd, &member.path);
                let mut entry = if !dir.join(".git").exists() {
                    json!({ "error": format!("{} is missing", member.name) })
                } else {
                    let git = Git::open(&dir, &self.inner.lead_git).await?.excluding(nested_members(project, &member.path));
                    match self.execute_lead_git_op(thread, turn_id, live, &git, op.clone()).await {
                        Ok(value) => value,
                        Err(error) => json!({ "error": error.to_string() }),
                    }
                };
                if let Some(object) = entry.as_object_mut() {
                    object.insert("repo".into(), json!(member.path));
                    object.insert("name".into(), json!(member.name));
                }
                repos.push(entry);
            }
            return Ok(json!({ "repos": repos }));
        };
        if repo == "*" {
            // The group pull request path (github.pr.create_group) belongs to the chat, with one card for every PR.
            ensure!(matches!(op, Op::OpenPr { .. }), "repo \"*\" is only for open_pr. Name the repository: {choices}.");
            return Err(anyhow!("Open the pull requests from the chat's Create pull requests action."));
        }
        let member = project
            .members
            .iter()
            .find(|m| m.path == repo)
            .ok_or_else(|| anyhow!("{repo} isn't a repository of this project. Name one of: {choices}."))?;
        let dir = group_git::member_dir(cwd, &member.path);
        ensure!(dir.join(".git").exists(), "{} is missing or is no longer a git repository. Ask the user to put it back.", member.name);
        let git = Git::open(&dir, &self.inner.lead_git).await?.excluding(nested_members(project, &member.path));
        let mut result = self.execute_lead_git_op(thread, turn_id, live, &git, op).await?;
        if let Some(object) = result.as_object_mut() {
            object.insert("repo".into(), json!(member.path));
        }
        Ok(result)
    }

    /// `merge_child` for a group: merge the agent's branch in every member it
    /// changed, or in none. Every member is checked first (feature branch,
    /// identity, clean tree, `git merge-tree`); a conflict anywhere merges nothing.
    async fn lead_group_merge_child(&self, coordinator: &Thread, project: &Project, child_id: ThreadId) -> Result<Value> {
        let (child, _) = self.mergeable_child(coordinator, child_id)?;
        ensure!(
            !child.members.is_empty(),
            "That agent's worktree does not record its repositories, so Kybern can't merge it here. Merge its branches with Git."
        );
        // Several repositories change together: once, under the daemon-wide workspace lock.
        let _workspace = self.inner.workspace_ops.lock().await;
        let cwd = Path::new(&coordinator.cwd);
        struct Plan {
            repo: String,
            name: String,
            git: Git,
            branch: String,
            warning: Option<String>,
        }
        let mut plans = Vec::new();
        let mut skipped = Vec::new();
        for member in child.members.iter().filter(|m| m.included) {
            let Some(tree) = member.worktree.as_ref() else { continue };
            let dir = group_git::member_dir(cwd, &member.path);
            ensure!(
                dir.join(".git").exists(),
                "{} is missing from this folder, so nothing was merged. Ask the user to put it back.",
                member.name
            );
            let git = Git::open(&dir, &self.inner.lead_git).await?.excluding(nested_members(project, &member.path));
            let branch = tree.branch.clone();
            if git.repo.rev_parse(&format!("refs/heads/{branch}")).await.is_err() {
                skipped.push(json!({ "repo": member.path, "reason": "The branch no longer exists." }));
                continue;
            }
            if git.repo.is_ancestor(&branch, "HEAD").await.unwrap_or(false) {
                skipped.push(json!({ "repo": member.path, "reason": "Nothing new to merge." }));
                continue;
            }
            let warning = (member.worktree_state != Some(WorktreeState::Removed)
                && Path::new(&tree.path).is_dir()
                && !kybern_git::Repo::new(&tree.path).is_clean().await.unwrap_or(true))
            .then(|| format!("The agent left uncommitted changes in its {} worktree that are not on the branch.", member.name));
            plans.push(Plan { repo: member.path.clone(), name: member.name.clone(), git, branch, warning });
        }
        if plans.is_empty() {
            return Ok(json!({ "status": "already_merged", "repos": [], "skipped": skipped }));
        }
        let mut conflicts = Vec::new();
        for plan in &plans {
            plan.git.preflight_merge().await.map_err(|error| anyhow!("{}: {error} Nothing was merged.", plan.name))?;
            match plan.git.repo.merge_tree_check("HEAD", &plan.branch).await? {
                kybern_git::MergeCheck::Conflicts(paths) => conflicts.push(json!({ "repo": plan.repo, "paths": paths })),
                // Older git cannot tell without merging; the merge below aborts cleanly on a conflict.
                kybern_git::MergeCheck::Clean | kybern_git::MergeCheck::Unknown => {}
            }
        }
        if !conflicts.is_empty() {
            return Ok(json!({
                "status": "conflict",
                "conflicts": conflicts,
                "merged": [],
                "message": "Nothing was merged in any repository. Send the agent the conflicting files and ask it to merge the current branches into its own and resolve them, then merge_child again."
            }));
        }
        let title = child.title.trim();
        let mut merged: Vec<Value> = Vec::new();
        let warnings: Vec<String> = plans.iter().filter_map(|plan| plan.warning.clone()).collect();
        for (index, plan) in plans.iter().enumerate() {
            let message = if title.is_empty() { format!("Merge {}", plan.branch) } else { format!("Merge {}: {title}", plan.branch) };
            let failure = match plan.git.repo.merge_no_ff(&plan.branch, &message).await {
                Ok(MergeOutcome::Merged { commit }) => {
                    merged.push(json!({ "repo": plan.repo, "status": "merged", "commit": commit }));
                    continue;
                }
                Ok(MergeOutcome::AlreadyUpToDate) => {
                    merged.push(json!({ "repo": plan.repo, "status": "already_merged" }));
                    continue;
                }
                Ok(MergeOutcome::Conflict { paths }) => json!({ "repo": plan.repo, "conflicts": paths }),
                Err(error) => json!({ "repo": plan.repo, "error": error.to_string() }),
            };
            let not_merged: Vec<&str> = plans[index..].iter().map(|plan| plan.repo.as_str()).collect();
            return Ok(json!({
                "status": "partial",
                "merged": merged,
                "failed": failure,
                "not_merged": not_merged,
                "message": format!("Merged {} of {} repositories; {} failed and the rest were left as they were. Resolve it, then merge_child again to finish.", merged.len(), plans.len(), plan.name),
            }));
        }
        let mut result = json!({ "status": "merged", "branch": format!("kybern/{}", child.id), "repos": merged, "skipped": skipped });
        if !warnings.is_empty() {
            result["warning"] = json!(warnings.join(" ") + " Ask it to commit them, then merge again to include them.");
        }
        Ok(result)
    }

    /// Raise the card for `op` and wait for the answer. `None` when the user
    /// allowed it; otherwise the tool result to return instead.
    async fn ask_git_card(
        &self,
        thread: &Thread,
        turn_id: TurnId,
        live: &Arc<LiveSession>,
        op: &str,
        input: Value,
        summary: String,
    ) -> Result<Option<Value>> {
        let key = format!("git:{}:{}", op, Uuid::now_v7());
        let (card, answer) =
            self.ask_daemon_approval_within(thread.id, turn_id, live, key, TOOL, input, summary, None, APPROVAL_WAIT).await?;
        let decision = match answer {
            DaemonAnswer::Decided(decision) => decision,
            DaemonAnswer::TurnEnded => return Ok(Some(Verdict::Cancelled.outcome(op))),
            DaemonAnswer::Pending => match self.close_unanswered_secret_card(thread.id, turn_id, live, card).await? {
                Some(decision) => decision,
                None => return Ok(Some(Verdict::TimedOut.outcome(op))),
            },
        };
        let verdict = match decision {
            ApprovalDecision::AllowOnce | ApprovalDecision::AllowAlways => Verdict::Allowed,
            ApprovalDecision::Deny { reason } if reason.as_deref() == Some(TURN_ENDED) => Verdict::Cancelled,
            ApprovalDecision::Deny { reason } if reason.as_deref() == Some(TIMED_OUT) => Verdict::TimedOut,
            ApprovalDecision::Deny { .. } | ApprovalDecision::Submit { .. } => Verdict::Declined,
        };
        Ok(match verdict {
            Verdict::Allowed => None,
            refused => Some(refused.outcome(op)),
        })
    }
}

/// "api", "api or web", "api, web or infra".
fn join_or(names: &[String]) -> String {
    match names {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

/// The members nested in `path`'s checkout: every other member when `path` is
/// the group folder itself, else none.
pub(super) fn nested_members(project: &Project, path: &str) -> Vec<String> {
    if path != "." {
        return Vec::new();
    }
    project.members.iter().filter(|m| m.path != ".").map(|m| m.path.clone()).collect()
}

fn commit_count(count: u32) -> String {
    if count == 1 { "1 commit".into() } else { format!("{count} commits") }
}
