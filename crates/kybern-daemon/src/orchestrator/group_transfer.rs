//! Group projects across machines (ADE-92/91, design §6–§7): fork a group thread to another machine,
//! continue it there, or delegate to a group there. The single-repository flows (`fork_machine`,
//! `move_thread`, `remote_delegation`) call into this module when the thread has members.
//!
//! **What travels.** One snapshot per member the thread works in: a clean checkout is its HEAD, a dirty
//! one a snapshot commit (the group folder's own repository leaves the nested members out). Each
//! member's commit goes over as its own bundle (`git_transfer`, resumable chunks) under a transfer id
//! derived from the operation and the member's path, so the members of one operation never share a
//! staged file or a ref. The operation is still one outbox item and one `peer.*` call: the target
//! answers `needs: bundle` with the paths of the members whose commit it lacks, the source sends exactly
//! those and asks again. The target creates nothing before every member's commit is there, and the
//! thread and worktrees it makes are keyed by the operation, so a repeat finds them.
//!
//! **Which group.** The target needs a group project made of exactly the same repositories, matched by
//! repository identity (the rule clients merge projects by). Anything else is refused with the missing
//! repositories named, before anything is transferred. Members are paired by identity, so a group
//! folder laid out differently on the other machine still works.
//!
//! **The new thread** is a worktree chat: a container with one worktree per member the thread worked in,
//! on the branch the fork or move carried (`kybern/<thread-id>` for a delegation), exactly as
//! `group_git::create_group_workspace` makes it for a new group chat. Members the thread did not work in
//! stay deselected and read-only. Nothing is pushed to `origin` unless the fork asked for it.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::Result;
use kybern_git::Repo;
use kybern_protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::Orchestrator;
use super::fork_machine::{conflict, not_found};
use super::group_git::{self, RepoTarget, join_names, member_dir, snapshot_members};
use super::remote_delegation::{Delivery, RemoteHub, internal};
use crate::network::git_transfer;

/// Where one member of a sent group lives on the sending machine, for the outbox worker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct SourceMember {
    pub path: String,
    pub dir: String,
}

/// A group thread's work as it is sent: the group, each member's snapshot, and where each lives here.
pub(super) struct GroupSnapshot {
    pub work: GroupWork,
    pub targets: Vec<RepoTarget>,
    /// The snapshots are from the last finished turn rather than from now.
    pub at_turn_end: bool,
}

impl GroupSnapshot {
    pub fn sources(&self) -> Vec<SourceMember> {
        self.targets
            .iter()
            .map(|target| SourceMember { path: target.repo_path().to_string(), dir: target.dir.to_string_lossy().into_owned() })
            .collect()
    }

    /// The first member: `repo` and `commit` of the single-repository fields.
    pub fn primary(&self) -> Option<&GroupMemberWork> {
        self.work.members.first()
    }
}

/// One of the target's checkouts of a group's member repository.
#[derive(Debug, Clone)]
pub(super) struct CandidateMember {
    pub path: String,
    pub name: String,
    pub dir: PathBuf,
    pub repo: RepoIdentity,
}

/// A group project on this machine and its member repositories.
#[derive(Debug, Clone)]
pub(super) struct GroupCandidate {
    pub project: Project,
    pub members: Vec<CandidateMember>,
}

/// A member of the work, and the checkout that takes it on this machine.
#[derive(Debug, Clone)]
pub(super) struct MatchedMember {
    pub work: GroupMemberWork,
    /// The member's path in the group project here.
    pub path: String,
    pub dir: PathBuf,
}

/// The most repositories one group transfer names.
const MAX_MEMBERS: usize = 64;

/// A group transfer from a peer is data, not trust: bound it, and let only full hashes reach git when it
/// carries commits (`commits`: a fork or a move needs them on every member).
pub(crate) fn validate_group(group: &GroupWork, commits: bool) -> Result<(), RpcError> {
    if group.members.is_empty() || group.members.len() > MAX_MEMBERS || group.repos.len() > MAX_MEMBERS {
        return Err(RpcError::invalid_params("a group transfer has to name between 1 and 64 repositories"));
    }
    for member in &group.members {
        if member.path.len() > 512 || member.name.len() > 256 {
            return Err(RpcError::invalid_params("a group member's path or name is too long"));
        }
        match member.commit.as_deref() {
            Some(commit) if !matches!(commit.len(), 40 | 64) || !commit.chars().all(|c| c.is_ascii_hexdigit()) => {
                return Err(RpcError::invalid_params("commit must be a full commit hash"));
            }
            None if commits => return Err(RpcError::invalid_params("every member of a group needs a commit")),
            _ => {}
        }
    }
    Ok(())
}

/// For each of `wanted`, the distinct entry of `have` that is the same repository (the first free one).
pub(super) fn pair_repos(wanted: &[RepoIdentity], have: &[RepoIdentity]) -> Vec<Option<usize>> {
    let mut used = vec![false; have.len()];
    wanted
        .iter()
        .map(|identity| {
            let found = (0..have.len()).find(|index| !used[*index] && git_transfer::same_repo(identity, &have[*index]));
            if let Some(index) = found {
                used[index] = true;
            }
            found
        })
        .collect()
}

/// The `members` of a `needs: bundle` answer: the paths (on the sender) of the members whose commit is lacking.
pub(super) fn needed_members(error: &RpcError) -> Option<Vec<String>> {
    let members = error.data.as_ref()?.get("members")?.as_array()?;
    Some(members.iter().filter_map(Value::as_str).map(str::to_string).collect())
}

/// The error a target answers when it lacks the commits of `members` (source paths).
pub(super) fn needs_bundle(needs: &str, members: Vec<String>, project: ProjectId) -> RpcError {
    RpcError::new(codes::CONFLICT, "This machine does not have the commits of this group yet.")
        .with_data(json!({ "needs": needs, "members": members, "project_id": project }))
}

fn missing_message(machine: &str, repos: &[GroupRepo], closest: Option<(&GroupCandidate, Vec<String>, Vec<String>)>) -> String {
    let all = join_names(&repos.iter().map(|repo| repo.name.as_str()).collect::<Vec<_>>());
    match closest {
        None => format!(
            "{machine} has no group project made of the same repositories ({all}). Add a group there that holds all of them, or work on this machine."
        ),
        Some((candidate, missing, extra)) if !missing.is_empty() => {
            let missing = join_names(&missing);
            let mut message = format!(
                "{machine}'s group \"{}\" is missing {missing}. A group only matches a group of the same repositories: clone {missing} into it, or work on this machine.",
                candidate.project.name
            );
            if !extra.is_empty() {
                message.push_str(&format!(" It also holds {}, which this project does not.", join_names(&extra)));
            }
            message
        }
        Some((candidate, _, extra)) => format!(
            "{machine}'s group \"{}\" also holds {}, which this project does not. A group only matches a group of exactly the same repositories ({all}).",
            candidate.project.name,
            join_names(&extra)
        ),
    }
}

impl Orchestrator {
    // ---- the sending machine ----

    /// The group a thread belongs to and the repositories it works in, without commits.
    pub(super) async fn group_work(&self, thread: &Thread) -> Result<(GroupWork, Vec<RepoTarget>), RpcError> {
        let project = self
            .inner
            .store
            .project_get(thread.project_id)
            .map_err(internal)?
            .ok_or_else(|| conflict("The thread's project no longer exists on this machine."))?;
        let folder = PathBuf::from(&project.path);
        let mut repos = Vec::new();
        for member in &project.members {
            let dir = member_dir(&folder, &member.path);
            if !dir.join(".git").exists() {
                continue;
            }
            let repo = git_transfer::identity_of(&dir).await;
            if !repo.is_empty() {
                repos.push(GroupRepo { name: member.name.clone(), repo });
            }
        }
        let targets = group_git::targets(thread);
        if targets.is_empty() {
            return Err(conflict("None of this group's repositories is available in the thread, so there is nothing to send."));
        }
        let mut members = Vec::new();
        for target in &targets {
            let repo = git_transfer::identity_of(&target.dir).await;
            if repo.is_empty() {
                return Err(conflict(format!(
                    "{} is no longer a git repository, so Kybern cannot find the matching checkout on the other machine.",
                    target.name
                )));
            }
            members.push(GroupMemberWork { path: target.repo_path().to_string(), name: target.name.clone(), repo, commit: None });
        }
        Ok((GroupWork { repos, members }, targets))
    }

    /// `group_work` with each member's snapshot: its HEAD when clean, else a snapshot of its changes, or
    /// as of the last finished turn while one runs. A member that cannot be snapshotted refuses the whole.
    pub(super) async fn group_snapshot(&self, thread: &Thread, machine: &str) -> Result<GroupSnapshot, RpcError> {
        let (mut work, targets) = self.group_work(thread).await?;
        let (commits, at_turn_end) = self.group_commits(thread, &targets, machine).await?;
        for (member, commit) in work.members.iter_mut().zip(commits) {
            member.commit = Some(commit);
        }
        Ok(GroupSnapshot { work, targets, at_turn_end })
    }

    async fn group_commits(&self, thread: &Thread, targets: &[RepoTarget], machine: &str) -> Result<(Vec<String>, bool), RpcError> {
        if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            let events = self.inner.store.events_for_thread(thread.id).map_err(internal)?;
            let finished = events.iter().rev().find_map(|event| match &event.payload {
                EventPayload::CheckpointUpdated { checkpoint } if !checkpoint.incomplete => Some(checkpoint.clone()),
                _ => None,
            });
            if let Some(checkpoint) = finished {
                let afters: Option<Vec<String>> = targets
                    .iter()
                    .map(|target| {
                        checkpoint
                            .repos
                            .iter()
                            .find(|entry| entry.repo == target.repo_path())
                            .and_then(|entry| entry.after.clone())
                            .filter(|commit| !commit.is_empty())
                    })
                    .collect();
                if let Some(afters) = afters {
                    return Ok((afters, true));
                }
            }
        }
        let mut commits = Vec::new();
        for target in targets {
            if !target.present() {
                return Err(conflict(format!("{} is missing or is no longer a git repository, so its work cannot be sent.", target.name)));
            }
            let git = target.git();
            let clean = git.status_porcelain(&target.exclude).await.is_ok_and(|lines| lines.is_empty());
            let commit = match git.head().await {
                Some(head) if clean => head,
                _ => git
                    .snapshot_excluding(&format!("WIP from {machine}"), &target.exclude)
                    .await
                    .map_err(|error| conflict(format!("Kybern could not snapshot {}: {error:#}", target.name)))?,
            };
            commits.push(commit);
        }
        Ok((commits, false))
    }

    /// Name each member's snapshot as `branch` in its own repository, so the work stays reachable there.
    pub(super) async fn group_branch(&self, snapshot: &GroupSnapshot, branch: &str) -> Result<(), RpcError> {
        for (target, member) in snapshot.targets.iter().zip(&snapshot.work.members) {
            let commit = member.commit.as_deref().unwrap_or_default();
            target
                .git()
                .update_ref(&format!("refs/heads/{branch}"), commit)
                .await
                .map_err(|error| conflict(format!("Could not create the branch in {}: {error:#}", target.name)))?;
        }
        Ok(())
    }

    /// The "Checkout" lines of a hand-off note for a group thread: each member's branch, head and changes.
    pub(super) async fn group_checkout_note(&self, thread: &Thread) -> String {
        let mut note = String::new();
        for target in group_git::targets(thread) {
            let repo = target.git();
            let branch = repo.current_branch().await;
            let head = repo.head().await;
            note.push_str(&format!(
                "- {}: on {}{}.\n",
                target.name,
                branch.as_deref().map(|branch| format!("branch `{branch}`")).unwrap_or_else(|| "a detached HEAD".into()),
                head.as_deref().map(|head| format!(" at `{}`", &head[..head.len().min(9)])).unwrap_or_default()
            ));
            match repo.status_porcelain(&target.exclude).await {
                Ok(lines) if lines.is_empty() => note.push_str("  - No uncommitted changes.\n"),
                Ok(lines) => {
                    note.push_str(&format!("  - {} files with uncommitted changes (the fork branch includes them):\n", lines.len()));
                    for line in lines.iter().take(5) {
                        note.push_str(&format!("    - `{}`\n", line.trim()));
                    }
                    if lines.len() > 5 {
                        note.push_str(&format!("    - …and {} more\n", lines.len() - 5));
                    }
                }
                Err(_) => {}
            }
        }
        note
    }

    /// Send the bundles of `group`'s members (only `only`, when the target named them) from `dirs`.
    pub(super) async fn send_group_bundles(
        &self,
        hub: &dyn RemoteHub,
        item: &OutboxItem,
        group: &GroupWork,
        project: Option<&str>,
        dirs: &[SourceMember],
        only: Option<&[String]>,
    ) -> Result<(), Delivery> {
        let repos = group.repo_identities();
        for member in &group.members {
            if only.is_some_and(|only| !only.contains(&member.path)) {
                continue;
            }
            let Some(commit) = member.commit.as_deref() else { continue };
            let Some(source) = dirs.iter().find(|source| source.path == member.path) else {
                return Err(Delivery::Failed(format!("{} is no longer part of this thread, so its changes cannot be sent.", member.name)));
            };
            let repo = Repo::new(&source.dir);
            if !git_transfer::has_commit(&repo, commit).await {
                return Err(Delivery::Failed(format!(
                    "The snapshot of {} is no longer in {}, so it cannot be sent.",
                    member.name, source.dir
                )));
            }
            let transfer = git_transfer::member_transfer_id(item.operation_id, &member.path);
            self.send_branch(hub, item, &member.repo, project, commit, &repo, transfer, &repos).await?;
        }
        Ok(())
    }

    // ---- the receiving machine ----

    async fn group_candidates(&self) -> Result<Vec<GroupCandidate>, RpcError> {
        let mut candidates = Vec::new();
        for project in self.inner.store.projects_list().map_err(internal)?.into_iter().filter(|project| project.kind == ProjectKind::Group)
        {
            let folder = PathBuf::from(&project.path);
            let mut members = Vec::new();
            for member in &project.members {
                let dir = member_dir(&folder, &member.path);
                if !dir.join(".git").exists() {
                    continue;
                }
                let repo = git_transfer::identity_of(&dir).await;
                if !repo.is_empty() {
                    members.push(CandidateMember { path: member.path.clone(), name: member.name.clone(), dir, repo });
                }
            }
            candidates.push(GroupCandidate { project, members });
        }
        Ok(candidates)
    }

    /// The group project of this machine made of exactly `repos` (§4.4, the rule clients merge by), or why
    /// there is none: the closest group's missing repositories are named.
    pub(super) async fn match_group(
        &self,
        repos: &[GroupRepo],
        hint: Option<&str>,
        this_machine: &str,
    ) -> Result<GroupCandidate, RpcError> {
        let wanted: Vec<RepoIdentity> = repos.iter().map(|repo| repo.repo.clone()).collect();
        if wanted.is_empty() {
            return Err(RpcError::invalid_params("a group has to name at least one repository"));
        }
        let mut exact: Vec<GroupCandidate> = Vec::new();
        let mut closest: Option<(usize, GroupCandidate, Vec<String>, Vec<String>)> = None;
        for candidate in self.group_candidates().await? {
            let have: Vec<RepoIdentity> = candidate.members.iter().map(|member| member.repo.clone()).collect();
            let pairs = pair_repos(&wanted, &have);
            let matched = pairs.iter().flatten().count();
            let missing: Vec<String> =
                pairs.iter().zip(repos).filter(|(pair, _)| pair.is_none()).map(|(_, repo)| repo.name.clone()).collect();
            let taken: Vec<usize> = pairs.iter().flatten().copied().collect();
            let extra: Vec<String> = candidate
                .members
                .iter()
                .enumerate()
                .filter(|(index, _)| !taken.contains(index))
                .map(|(_, member)| member.name.clone())
                .collect();
            if missing.is_empty() && extra.is_empty() {
                exact.push(candidate);
            } else if closest.as_ref().is_none_or(|(best, ..)| matched > *best) {
                closest = Some((matched, candidate, missing, extra));
            }
        }
        if let Some(hint) = hint.map(str::trim).filter(|hint| !hint.is_empty()) {
            let narrowed: Vec<GroupCandidate> = exact
                .iter()
                .filter(|candidate| {
                    let project = &candidate.project;
                    project.id.to_string() == hint || project.name.eq_ignore_ascii_case(hint) || project.path == hint
                })
                .cloned()
                .collect();
            if !narrowed.is_empty() {
                exact = narrowed;
            }
        }
        match exact.len() {
            0 => Err(not_found(missing_message(
                this_machine,
                repos,
                closest.as_ref().map(|(_, candidate, missing, extra)| (candidate, missing.clone(), extra.clone())),
            ))),
            1 => Ok(exact.remove(0)),
            _ => {
                let list = exact.iter().map(|c| format!("{} ({})", c.project.name, c.project.path)).collect::<Vec<_>>().join(", ");
                Err(conflict(format!(
                    "{this_machine} has several groups made of these repositories: {list}. Retry with project set to one of them."
                )))
            }
        }
    }

    /// Pair each member of the work with the checkout that takes it.
    pub(super) fn group_pairs(candidate: &GroupCandidate, work: &[GroupMemberWork]) -> Result<Vec<MatchedMember>, RpcError> {
        let mut used = vec![false; candidate.members.len()];
        let mut matched = Vec::new();
        for member in work {
            let found =
                (0..used.len()).find(|index| !used[*index] && git_transfer::same_repo(&member.repo, &candidate.members[*index].repo));
            let Some(index) = found else {
                return Err(not_found(format!("This machine has no checkout of {} in the matching group.", member.name)));
            };
            used[index] = true;
            let target = &candidate.members[index];
            matched.push(MatchedMember { work: member.clone(), path: target.path.clone(), dir: target.dir.clone() });
        }
        Ok(matched)
    }

    /// The group, its members and the checkouts for a `GroupWork`, or why this machine cannot take it.
    pub(super) async fn group_target(
        &self,
        group: &GroupWork,
        hint: Option<&str>,
        this_machine: &str,
    ) -> Result<(GroupCandidate, Vec<MatchedMember>), RpcError> {
        if group.members.is_empty() {
            return Err(RpcError::invalid_params("a group transfer has to name at least one member"));
        }
        let candidate = self.match_group(&group.repos, hint, this_machine).await?;
        let matched = Self::group_pairs(&candidate, &group.members)?;
        Ok((candidate, matched))
    }

    /// The source paths of the members whose commit this machine lacks.
    pub(super) async fn group_missing_commits(matched: &[MatchedMember]) -> Vec<String> {
        let mut missing = Vec::new();
        for member in matched {
            let Some(commit) = member.work.commit.as_deref() else { continue };
            if !git_transfer::has_commit(&Repo::new(&member.dir), commit).await {
                missing.push(member.work.path.clone());
            }
        }
        missing
    }

    /// Remove the staged files and imported refs of every member's transfer.
    pub(super) async fn group_forget(&self, matched: &[MatchedMember], operation_id: Uuid) {
        for member in matched {
            let transfer = git_transfer::member_transfer_id(operation_id, &member.work.path);
            git_transfer::forget(Some(&Repo::new(&member.dir)), &self.inner.paths.root, transfer).await;
        }
    }

    /// The members a thread here starts with: the group's, with only the matched ones included.
    pub(super) fn group_thread_members(project: &Project, matched: &[MatchedMember]) -> Vec<ThreadMember> {
        let mut members = snapshot_members(project);
        for member in &mut members {
            member.included = member.included && matched.iter().any(|m| m.path == member.path);
        }
        members
    }

    /// The container for a thread that starts from each member's commit on `branch`, or the one an
    /// earlier try of the same call made. Runs with the thread id held, before the thread exists.
    pub(super) async fn group_fork_workspace(
        &self,
        project: &Project,
        thread_id: ThreadId,
        matched: &[MatchedMember],
        branch: &str,
    ) -> Result<(WorktreeInfo, Vec<ThreadMember>), RpcError> {
        let mut members = Self::group_thread_members(project, matched);
        let starts: BTreeMap<String, String> =
            matched.iter().filter_map(|member| member.work.commit.clone().map(|commit| (member.path.clone(), commit))).collect();
        let container = self.worktree_dir(project, &thread_id.to_string());
        if container.exists() {
            let included = || members.iter().filter(|member| member.included);
            if included().all(|member| member_dir(&container, &member.path).join(".git").exists()) {
                for member in members.iter_mut().filter(|member| member.included) {
                    let tree = member_dir(&container, &member.path);
                    member.worktree = Some(WorktreeInfo { path: tree.to_string_lossy().into_owned(), branch: branch.to_string() });
                    member.base_commit = starts.get(&member.path).cloned();
                }
                return Ok((WorktreeInfo { path: container.to_string_lossy().into_owned(), branch: branch.to_string() }, members));
            }
            self.group_discard_workspace(&members, &container, branch).await;
        }
        self.create_group_workspace(project, thread_id, members, &starts, Some(branch))
            .await
            .map_err(|error| conflict(format!("Could not create the worktrees for this group: {error:#}")))
    }

    /// Remove what a try that died half way left: its member worktrees (nested first), branch and folder.
    async fn group_discard_workspace(&self, members: &[ThreadMember], container: &std::path::Path, branch: &str) {
        for member in members.iter().rev().filter(|member| member.included) {
            let source = Repo::new(&member.source_path);
            let tree = member_dir(container, &member.path);
            if tree.exists() {
                let _ = source.worktree_remove(&tree, true).await;
            }
            let _ = source.worktree_prune().await;
            let _ = source.delete_branch(branch, true).await;
        }
        let _ = std::fs::remove_dir_all(container);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(root: &str) -> RepoIdentity {
        RepoIdentity { root_commit: Some(root.into()), remote: None }
    }

    #[test]
    fn repositories_pair_one_to_one_by_identity() {
        let wanted = [id("a"), id("b"), id("a")];
        assert_eq!(pair_repos(&wanted, &[id("b"), id("a"), id("a")]), [Some(1), Some(0), Some(2)], "two clones need two checkouts");
        assert_eq!(pair_repos(&wanted, &[id("a"), id("b")]), [Some(0), Some(1), None], "a checkout serves one member");
        assert_eq!(pair_repos(&[id("c")], &[id("a")]), [None]);
        let by_remote = RepoIdentity { root_commit: None, remote: Some("github.com/acme/web".into()) };
        let both = RepoIdentity { root_commit: Some("w".into()), remote: Some("github.com/acme/web".into()) };
        assert_eq!(pair_repos(&[by_remote], &[both]), [Some(0)], "a remote alone matches a repository that has one");
    }

    #[test]
    fn a_refusal_names_the_repositories_the_group_lacks() {
        let repos = vec![
            GroupRepo { name: "api".into(), repo: id("a") },
            GroupRepo { name: "web".into(), repo: id("w") },
            GroupRepo { name: "infra".into(), repo: id("i") },
        ];
        let none = missing_message("satyamas", &repos, None);
        assert!(none.contains("satyamas has no group project") && none.contains("api, web and infra"), "{none}");
    }

    #[test]
    fn the_needed_members_come_from_the_error_data() {
        let error = needs_bundle("bundle", vec!["api".into(), "web".into()], Uuid::nil());
        assert_eq!(needed_members(&error), Some(vec!["api".to_string(), "web".to_string()]));
        assert_eq!(needed_members(&RpcError::new(codes::CONFLICT, "x").with_data(json!({ "needs": "bundle" }))), None);
    }
}
