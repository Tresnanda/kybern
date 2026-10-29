//! Fork to a machine (ADE-86 M3 / F1, design §7.1): give another machine a copy of a thread's work
//! while both threads stay live.
//!
//! **The source machine (A).** `threads.fork_to_machine` works out the hand-off note (title, goal,
//! recent turns, open work, the checkout's state), commits a snapshot of the work to a fork branch
//! `kybern/fork-<id>` through a private index (the user's index and working tree stay as they are;
//! untracked files are in, ignored files such as `.env` are not), and writes one `fork` outbox item.
//! Nothing needs the target to be online: the outbox worker delivers the item when it is, and the
//! snapshot already exists by then. Delivery optionally pushes the branch to `origin` (only when the
//! user asked), calls `peer.fork`, and, when the target does not have the commit yet, sends the branch
//! as a bundle (`git_transfer`) and calls again. The whole fork is idempotent by `operation_id`.
//!
//! **The target machine (B).** [`Orchestrator::accept_fork`] serves `peer.fork`: it finds its checkout
//! of the repository, creates a worktree on the fork branch at the imported commit, and creates the
//! thread with an origin of kind `fork`. The thread's id and its first message's id are derived from the
//! operation, so a repeated call, or one that follows a crash half way, finds the same thread.
//!
//! When the item is delivered the source thread gets a notice, "Forked to satyamas", whose `data`
//! carries the new thread so clients can open it.

use std::path::Path;
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use kybern_git::Repo;
use kybern_protocol::methods::{Method, PeerFork, TaskStatus};
use kybern_protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::group_transfer::{SourceMember, needed_members, needs_bundle};
use super::remote_delegation::{CallFailure, Delivery, RemoteHub, from_value, internal, namespaced_operation, narrower};
use super::{Orchestrator, derived_operation_id};
use crate::network::git_transfer;
use crate::state::AppState;

/// The branch every fork uses on both machines: `kybern/fork-<short id>`.
const BRANCH_PREFIX: &str = "kybern/fork-";
/// The note a client can send is limited, so a long edit cannot fill the target's context.
pub(super) const NOTE_CAP: usize = 64 * 1024;
const GOAL_CAP: usize = 1_500;
const STATE_CAP: usize = 2_500;
const TURN_USER_CAP: usize = 400;
const TURN_AGENT_CAP: usize = 700;
const RECENT_TURNS: usize = 4;
const TODO_LINES: usize = 12;
const CHANGED_FILE_LINES: usize = 15;
/// A push to `origin` that does not finish in this long is tried again when the item is retried.
const PUSH_TIMEOUT: Duration = Duration::from_secs(180);

/// What the outbox item carries: what `peer.fork` needs plus what only the source needs to deliver it.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ForkPayload {
    source_thread_id: ThreadId,
    /// The source checkout, where the fork branch lives.
    source_cwd: String,
    push_origin: bool,
    params: PeerForkParams,
    /// A group thread: where each member's branch lives here. Empty for one repository.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    source_members: Vec<SourceMember>,
}

/// Whether another machine's work started this thread and it must not reach a third machine. A fork
/// or a move is the exception: the person who forked or moved it owns the new thread like any other.
pub(super) fn second_hop(thread: &Thread) -> bool {
    thread.origin.as_ref().is_some_and(|origin| !matches!(origin.kind, OriginKind::Fork | OriginKind::Move))
}

pub(super) fn short_id(operation_id: Uuid) -> String {
    let simple = operation_id.simple().to_string();
    simple[simple.len() - 8..].to_string()
}

pub(super) fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// Keeps a multi-line message (a table, a list) readable inside a `- ` list item: its later lines are
/// indented to the item's content column instead of being joined into one line.
fn in_list_item(text: &str) -> String {
    text.lines().map(str::trim_end).collect::<Vec<_>>().join("\n  ")
}

pub(super) fn conflict(message: impl Into<String>) -> RpcError {
    RpcError::new(codes::CONFLICT, message)
}

pub(super) fn not_found(message: impl Into<String>) -> RpcError {
    RpcError::new(codes::NOT_FOUND, message)
}

impl Orchestrator {
    // ---- the source machine ----

    /// `threads.fork_note`: the hand-off note for `thread_id`.
    pub async fn fork_note(&self, params: ThreadsForkNoteParams) -> Result<ThreadsForkNoteResult, RpcError> {
        let thread = self.fork_source(params.thread_id)?;
        Ok(ThreadsForkNoteResult { note: self.handoff_note(&thread).await.map_err(internal)? })
    }

    pub(super) fn fork_source(&self, thread_id: ThreadId) -> Result<Thread, RpcError> {
        let thread = self.inner.store.thread_get(thread_id).map_err(internal)?.ok_or_else(|| not_found("no such thread"))?;
        if thread.subagent.is_some() || thread.inbound.is_some() {
            return Err(RpcError::invalid_params(
                "A subagent's thread is read-only, so it cannot be forked. Fork the thread that started it.",
            ));
        }
        if second_hop(&thread) {
            return Err(conflict("Another machine started this thread, so it cannot be forked to a third machine."));
        }
        Ok(thread)
    }

    /// `threads.fork_to_machine`: snapshot the work, write the outbox item, and answer without waiting
    /// for the target.
    pub async fn fork_to_machine(&self, params: ThreadsForkToMachineParams) -> Result<ThreadsForkToMachineResult, RpcError> {
        let hub = self.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?.clone();
        let thread = self.fork_source(params.thread_id)?;
        let target = hub.resolve(&params.machine).map_err(RpcError::invalid_params)?;
        if let Some(features) = &target.features
            && !features.iter().any(|feature| feature == features::FORK_V1)
        {
            return Err(conflict(format!("{} needs a newer Kybern to receive a fork. Update it from Settings → Machines.", target.name)));
        }
        let is_group = super::group_git::is_group(&thread);
        if is_group
            && let Some(features) = &target.features
            && !features.iter().any(|feature| feature == features::GROUP_V1)
        {
            return Err(conflict(format!(
                "{} needs a newer Kybern to receive a fork of a group project. Update it from Settings → Machines.",
                target.name
            )));
        }
        let operation_id = params.operation_id.unwrap_or_else(Uuid::now_v7);
        // A repeat is the first fork: no second snapshot, no second item.
        if let Some(existing) = self.inner.store.outbox_get_by_operation(operation_id).map_err(internal)? {
            return self.fork_result_of(existing, params.thread_id);
        }

        let branch = format!("{BRANCH_PREFIX}{}", short_id(operation_id));
        let (repo_identity, commit, at_turn_end, group, source_members) = if is_group {
            // Every member the thread works in is snapshotted before anything is queued: one that cannot be refuses the fork.
            let snapshot = self.group_snapshot(&thread, &hub.self_name()).await?;
            self.group_branch(&snapshot, &branch).await?;
            let primary = snapshot.primary().ok_or_else(|| conflict("This group thread has no repository to fork."))?;
            let (identity, commit) = (primary.repo.clone(), primary.commit.clone().unwrap_or_default());
            (identity, commit, snapshot.at_turn_end, Some(snapshot.work.clone()), snapshot.sources())
        } else {
            let repo = Repo::new(&thread.cwd);
            let repo_identity = git_transfer::identity_of(Path::new(&thread.cwd)).await;
            if repo_identity.is_empty() {
                return Err(conflict("Forking to another machine needs a git repository, so Kybern can find the matching checkout there."));
            }
            let (commit, at_turn_end) = self.fork_commit(&thread, &repo, &hub.self_name()).await.map_err(internal)?;
            repo.update_ref(&format!("refs/heads/{branch}"), &commit).await.map_err(internal)?;
            (repo_identity, commit, at_turn_end, None, Vec::new())
        };

        let mut handoff_note = match params.handoff_note.as_deref().map(str::trim).filter(|note| !note.is_empty()) {
            Some(note) => note.to_string(),
            None => self.handoff_note(&thread).await.map_err(internal)?,
        };
        if at_turn_end {
            handoff_note
                .push_str("\n\n(The thread was working when it was forked, so the branch holds its files as of the last finished turn.)");
        }
        if handoff_note.len() > NOTE_CAP {
            return Err(RpcError::invalid_params(format!(
                "The hand-off note is {} KiB; keep it under {} KiB.",
                handoff_note.len() / 1024,
                NOTE_CAP / 1024
            )));
        }

        let source_kind = thread.provider.kind;
        let kind = params.provider.unwrap_or(source_kind);
        let same_kind = kind == source_kind;
        let asked_model = params.model.clone().filter(|model| !model.trim().is_empty());
        let model = asked_model.clone().or_else(|| same_kind.then(|| thread.model.clone()).flatten());
        let effort = params
            .effort
            .clone()
            .filter(|effort| !effort.trim().is_empty())
            .or_else(|| (same_kind && asked_model.is_none()).then(|| thread.effort.clone()).flatten());
        let permission_mode = params.permission_mode.unwrap_or(thread.permission_mode);

        let origin = Origin {
            machine_id: hub.self_id(),
            machine_name: hub.self_name(),
            thread_id: Some(thread.id),
            operation_id,
            kind: OriginKind::Fork,
            permission_cap: permission_mode,
            hops: vec![hub.self_id()],
        };
        let peer = PeerForkParams {
            operation_id,
            origin: origin.clone(),
            source_title: thread.title.clone(),
            handoff_note: handoff_note.clone(),
            title: params.title.clone().filter(|title| !title.trim().is_empty()),
            repo: repo_identity,
            project: params.project.clone(),
            branch: branch.clone(),
            commit: commit.clone(),
            group,
            provider: kind,
            provider_chosen: params.provider.is_some(),
            model,
            effort,
            permission_mode,
        };
        let payload = ForkPayload {
            source_thread_id: thread.id,
            source_cwd: thread.cwd.clone(),
            push_origin: params.push_origin,
            params: peer,
            source_members,
        };
        let now = Utc::now();
        let item = OutboxItem {
            id: Uuid::now_v7(),
            operation_id,
            target: target.id.clone(),
            kind: OutboxKind::Fork,
            payload: serde_json::to_value(&payload).map_err(internal)?,
            origin: Some(origin),
            state: OutboxState::Queued,
            attempts: 0,
            next_attempt_at: None,
            last_error: None,
            result: None,
            created_at: now,
            expires_at: now + chrono::Duration::days(self.outbox_expiry_days()),
            updated_at: now,
        };
        if let Some(choice) = params.provision.clone() {
            self.provision_before(&thread, &target, choice, operation_id).await?;
        }
        let item = self.inner.store.outbox_insert(&item).map_err(internal)?;
        hub.kick();
        if !target.online || target.paused {
            let text = format!("Forking to {}: waiting for it to come online.", target.name);
            let _ = self.emit(
                thread.id,
                None,
                EventPayload::ProviderNotice {
                    level: NoticeLevel::Info,
                    text,
                    data: Some(json!({ "kind": "fork_queued", "machine_id": target.id, "machine_name": target.name, "operation_id": operation_id })),
                },
            );
        }
        Ok(ThreadsForkToMachineResult { operation_id, item, target_name: target.name, branch, commit, handoff_note })
    }

    /// The answer for an item that already exists (a repeated request).
    fn fork_result_of(&self, item: OutboxItem, thread_id: ThreadId) -> Result<ThreadsForkToMachineResult, RpcError> {
        let payload = fork_payload(&item).ok_or_else(|| conflict("operation_id already belongs to something other than a fork."))?;
        if payload.source_thread_id != thread_id {
            return Err(conflict("operation_id already belongs to another thread's fork. Use a fresh operation_id."));
        }
        let target_name =
            self.remote_hub().and_then(|hub| hub.target(&item.target)).map(|target| target.name).unwrap_or_else(|| item.target.clone());
        Ok(ThreadsForkToMachineResult {
            operation_id: item.operation_id,
            target_name,
            branch: payload.params.branch,
            commit: payload.params.commit,
            handoff_note: payload.params.handoff_note,
            item,
        })
    }

    /// The commit the fork carries: the work as it stands, or, while a turn runs, as of the last
    /// finished turn. A clean checkout needs no WIP commit: its HEAD is the fork. Returns whether the
    /// commit is from a finished turn rather than from now.
    pub(super) async fn fork_commit(&self, thread: &Thread, repo: &Repo, machine: &str) -> Result<(String, bool)> {
        if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            let events = self.inner.store.events_for_thread(thread.id)?;
            let finished = events.iter().rev().find_map(|event| match &event.payload {
                EventPayload::CheckpointUpdated { checkpoint } if !checkpoint.incomplete => checkpoint.after.clone(),
                _ => None,
            });
            if let Some(commit) = finished.filter(|commit| !commit.is_empty()) {
                return Ok((commit, true));
            }
        }
        let commit = match repo.head().await {
            Some(head) if repo.is_clean().await.unwrap_or(false) => head,
            _ => repo.snapshot(&format!("WIP from {machine}")).await?,
        };
        Ok((commit, false))
    }

    /// The hand-off note: what a person picking this thread up would need to know (§7.1).
    pub(super) async fn handoff_note(&self, thread: &Thread) -> Result<String> {
        let events = self.inner.store.events_for_thread(thread.id)?;
        let entries = kybern_store::project_transcript(&events);
        let machine = self.remote_hub().map(|hub| hub.self_name()).unwrap_or_else(|| "the other machine".into());

        let mut users: Vec<(TurnId, String)> = Vec::new();
        let mut replies: Vec<(TurnId, String)> = Vec::new();
        let mut todos: Option<Vec<String>> = None;
        for entry in &entries {
            match entry {
                TranscriptEntry::User { turn_id, message, .. } => {
                    let text = message.plain_text();
                    if !text.trim().is_empty() {
                        users.push((*turn_id, text));
                    }
                }
                TranscriptEntry::Assistant { turn_id, origin: EventOrigin::Root, text, .. } if !text.trim().is_empty() => {
                    match replies.last_mut() {
                        Some((last, existing)) if last == turn_id => {
                            existing.push_str("\n\n");
                            existing.push_str(text);
                        }
                        _ => replies.push((*turn_id, text.clone())),
                    }
                }
                TranscriptEntry::ToolCall { call, .. } if call.name.ends_with("TodoWrite") => {
                    todos = call.input.get("todos").and_then(Value::as_array).map(|items| {
                        items
                            .iter()
                            .filter(|item| item.get("status").and_then(Value::as_str) != Some("completed"))
                            .filter_map(|item| item.get("content").and_then(Value::as_str))
                            .map(|content| clip(content, 200))
                            .collect()
                    });
                }
                _ => {}
            }
        }

        let mut note = format!(
            "# Hand-off: {}\n\nThis work started on {machine} (thread \"{}\"). Pick it up from here.\n",
            thread.title, thread.title
        );
        if let Some((_, goal)) = users.first() {
            note.push_str(&format!("\n## Goal\n{}\n", clip(goal, GOAL_CAP)));
        }
        if let Some((_, last)) = replies.last() {
            note.push_str(&format!("\n## Where it stands\n{}\n", clip(last, STATE_CAP)));
        }
        let mut turns = String::new();
        let skip = replies.len().saturating_sub(RECENT_TURNS);
        for (turn_id, reply) in replies.iter().skip(skip) {
            if let Some((_, user)) = users.iter().rev().find(|(id, _)| id == turn_id) {
                turns.push_str(&format!("- You asked: {}\n", in_list_item(&clip(user, TURN_USER_CAP))));
            }
            turns.push_str(&format!("  The agent: {}\n", in_list_item(&clip(reply, TURN_AGENT_CAP))));
        }
        if !turns.is_empty() {
            note.push_str(&format!("\n## Recent turns\n{turns}"));
        }

        let mut open: Vec<String> = Vec::new();
        for task in self.inner.store.task_items_list()? {
            if matches!(task.status, TaskStatus::Done | TaskStatus::Canceled) {
                continue;
            }
            if task.created_by_thread == Some(thread.id) || task.runs.iter().any(|run| run.thread_id == thread.id) {
                open.push(format!("{} {} ({})", task.key, task.title, task.status.as_str()));
            }
        }
        open.extend(todos.unwrap_or_default());
        if !open.is_empty() {
            note.push_str("\n## Open work\n");
            for line in open.iter().take(TODO_LINES) {
                note.push_str(&format!("- {line}\n"));
            }
            if open.len() > TODO_LINES {
                note.push_str(&format!("- …and {} more\n", open.len() - TODO_LINES));
            }
        }

        note.push_str(&format!("\n## Checkout on {machine}\n"));
        if super::group_git::is_group(thread) {
            if let Some(worktree) = &thread.worktree {
                note.push_str(&format!("- Each repository is a worktree on `{}`.\n", worktree.branch));
            }
            note.push_str(&self.group_checkout_note(thread).await);
            return Ok(note);
        }
        let repo = Repo::new(&thread.cwd);
        let branch = repo.current_branch().await;
        let head = repo.head().await;
        note.push_str(&format!(
            "- On {}{}.\n",
            branch.as_deref().map(|branch| format!("branch `{branch}`")).unwrap_or_else(|| "a detached HEAD".into()),
            head.as_deref().map(|head| format!(" at `{}`", &head[..head.len().min(9)])).unwrap_or_default()
        ));
        if let Some(worktree) = &thread.worktree {
            note.push_str(&format!("- It is a worktree on `{}`.\n", worktree.branch));
        }
        if let Ok(status) = repo.output(&["status", "--porcelain"]).await
            && status.success
        {
            let changed: Vec<&str> = status.stdout.lines().filter(|line| !line.trim().is_empty()).collect();
            if changed.is_empty() {
                note.push_str("- No uncommitted changes.\n");
            } else {
                note.push_str(&format!("- {} files with uncommitted changes (the fork branch includes them):\n", changed.len()));
                for line in changed.iter().take(CHANGED_FILE_LINES) {
                    note.push_str(&format!("  - `{}`\n", line.trim()));
                }
                if changed.len() > CHANGED_FILE_LINES {
                    note.push_str(&format!("  - …and {} more\n", changed.len() - CHANGED_FILE_LINES));
                }
            }
        }
        Ok(note)
    }

    /// Deliver a queued `fork` item: push to `origin` if the user asked, then `peer.fork`, sending the
    /// branch first if the target says it lacks the commit.
    pub async fn remote_deliver_fork(&self, item: &OutboxItem) -> Delivery {
        let Some(hub) = self.remote_hub().cloned() else {
            return Delivery::Failed("This daemon cannot reach other machines.".into());
        };
        let Some(payload) = fork_payload(item) else {
            return Delivery::Failed("The queued fork is unreadable.".into());
        };
        let repo = Repo::new(&payload.source_cwd);
        if let Some(group) = &payload.params.group {
            for member in &group.members {
                let dir = payload.source_members.iter().find(|source| source.path == member.path).map(|source| source.dir.as_str());
                let held = match (dir, member.commit.as_deref()) {
                    (Some(dir), Some(commit)) => git_transfer::has_commit(&Repo::new(dir), commit).await,
                    _ => false,
                };
                if !held {
                    return Delivery::Failed(format!(
                        "The fork branch {} of {} is no longer here, so it cannot be sent. Fork the thread again.",
                        payload.params.branch, member.name
                    ));
                }
                if payload.push_origin
                    && let Some(dir) = dir
                    && let Err(delivery) = self.fork_push_origin(&Repo::new(dir), &payload.params.branch).await
                {
                    return delivery;
                }
            }
        } else {
            if !git_transfer::has_commit(&repo, &payload.params.commit).await {
                return Delivery::Failed(format!(
                    "The fork branch {} is no longer in {}, so it cannot be sent. Fork the thread again.",
                    payload.params.branch, payload.source_cwd
                ));
            }
            if payload.push_origin
                && let Err(delivery) = self.fork_push_origin(&repo, &payload.params.branch).await
            {
                return delivery;
            }
        }
        let value = serde_json::to_value(&payload.params).unwrap_or(Value::Null);
        let mut answer = hub.call(&item.target, PeerFork::NAME, value.clone()).await;
        if let Err(CallFailure::Remote(error)) = &answer
            && error.data.as_ref().and_then(|data| data.get("needs")).and_then(Value::as_str) == Some(FORK_NEEDS_BUNDLE)
        {
            let sent = match &payload.params.group {
                Some(group) => {
                    let only = needed_members(error);
                    self.send_group_bundles(&*hub, item, group, payload.params.project.as_deref(), &payload.source_members, only.as_deref())
                        .await
                }
                None => {
                    self.send_branch(
                        &*hub,
                        item,
                        &payload.params.repo,
                        payload.params.project.as_deref(),
                        &payload.params.commit,
                        &repo,
                        item.operation_id,
                        &[],
                    )
                    .await
                }
            };
            match sent {
                Ok(()) => answer = hub.call(&item.target, PeerFork::NAME, value).await,
                Err(delivery) => return delivery,
            }
        }
        match answer {
            Ok(value) => match serde_json::from_value::<PeerForkResult>(value.clone()) {
                Ok(_) => Delivery::Delivered(value),
                Err(error) => Delivery::Failed(format!("the machine answered with something unreadable: {error}")),
            },
            Err(CallFailure::Offline(reason)) => Delivery::Retry(reason),
            Err(CallFailure::Gone(reason)) => Delivery::Failed(reason),
            Err(CallFailure::Remote(error)) => self.remote_refusal(item, &error),
        }
    }

    async fn fork_push_origin(&self, repo: &Repo, branch: &str) -> Result<(), Delivery> {
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        match tokio::time::timeout(PUSH_TIMEOUT, repo.output(&["push", "origin", &refspec])).await {
            Err(_) => Err(Delivery::Retry("Pushing the fork branch to origin took too long.".into())),
            Ok(Err(error)) => Err(Delivery::Failed(format!("Could not push the fork branch to origin: {error:#}"))),
            Ok(Ok(out)) if !out.success => Err(Delivery::Failed(format!(
                "Could not push the fork branch to origin: {}. Fix that, or retry the fork without \"Also push to origin\".",
                out.stderr.lines().last().unwrap_or("git push failed").trim()
            ))),
            Ok(Ok(_)) => Ok(()),
        }
    }

    /// Send the branch's commit as a bundle (transfer `transfer_id`: the operation's own id, or a group
    /// member's) and have the target import it. `group_repos` is empty for one repository.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn send_branch(
        &self,
        hub: &dyn RemoteHub,
        item: &OutboxItem,
        identity: &RepoIdentity,
        project: Option<&str>,
        commit: &str,
        repo: &Repo,
        transfer_id: Uuid,
        group_repos: &[RepoIdentity],
    ) -> Result<(), Delivery> {
        let staged = git_transfer::staged_path(&self.inner.paths.root, transfer_id);
        let mut full = false;
        loop {
            let bundle = match git_transfer::create_bundle(repo, commit, transfer_id, &staged, full).await {
                Ok(Some(bundle)) => bundle,
                // A remote already has everything yet the target lacks it: send the whole history.
                Ok(None) if !full => {
                    full = true;
                    continue;
                }
                Ok(None) => return Err(Delivery::Failed("There was nothing to send, yet the target lacks the commit.".into())),
                Err(error) => return Err(Delivery::Failed(format!("{error:#}"))),
            };
            let result = self.stream_bundle(hub, item, transfer_id, group_repos, identity, project, commit, &bundle).await;
            let _ = std::fs::remove_file(&staged);
            match result {
                Ok(()) => return Ok(()),
                Err(CallFailure::Remote(error))
                    if !full && error.data.as_ref().and_then(|data| data.get("needs")).and_then(Value::as_str) == Some("full_bundle") =>
                {
                    full = true;
                }
                Err(CallFailure::Offline(reason)) => return Err(Delivery::Retry(reason)),
                Err(CallFailure::Gone(reason)) => return Err(Delivery::Failed(reason)),
                Err(CallFailure::Remote(error)) => return Err(self.remote_refusal(item, &error)),
            }
        }
    }

    /// The fork item reached a final state: tell the source thread.
    pub(super) fn fork_outbox_changed(&self, item: &OutboxItem) {
        let Some(payload) = fork_payload(item) else { return };
        let name = self
            .remote_hub()
            .and_then(|hub| hub.target(&item.target))
            .map(|target| target.name)
            .unwrap_or_else(|| "the other machine".into());
        let (level, text, data) = match item.state {
            OutboxState::Delivered => {
                let Some(result) = item.result.clone().and_then(|value| serde_json::from_value::<PeerForkResult>(value).ok()) else {
                    return;
                };
                (
                    NoticeLevel::Info,
                    format!("Forked to {name} · open"),
                    json!({
                        "kind": "fork", "machine_id": item.target, "machine_name": name, "thread_id": result.thread_id,
                        "branch": payload.params.branch, "operation_id": item.operation_id,
                    }),
                )
            }
            OutboxState::Failed | OutboxState::Expired => (
                NoticeLevel::Warning,
                format!("The fork to {name} did not arrive: {}", item.last_error.as_deref().unwrap_or("delivery failed")),
                json!({ "kind": "fork_failed", "machine_id": item.target, "machine_name": name, "operation_id": item.operation_id }),
            ),
            _ => return,
        };
        let key = format!("fork_notice:{}:{}", item.operation_id, item.state.as_str());
        if matches!(self.inner.store.meta_get(&key), Ok(Some(_))) {
            return;
        }
        if self.inner.store.thread_get(payload.source_thread_id).ok().flatten().is_none() {
            return;
        }
        match self.emit(payload.source_thread_id, None, EventPayload::ProviderNotice { level, text, data: Some(data) }) {
            Ok(_) => {
                let _ = self.inner.store.meta_set(&key, "1");
            }
            Err(error) => tracing::warn!(%error, "could not tell a thread that it was forked"),
        }
    }

    // ---- the target machine ----

    /// `peer.fork`: open the thread a fork from machine `from` carries.
    pub(super) async fn accept_fork(&self, from: &str, params: PeerForkParams) -> Result<PeerForkResult, RpcError> {
        let hub = self.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?.clone();
        // The origin is the session's machine and nothing the caller wrote, and it travels one hop only.
        if params.origin.hops.len() > 1
            || params.origin.hops.first().is_some_and(|hop| hop != from)
            || params.origin.kind != OriginKind::Fork
        {
            return Err(RpcError::new(codes::FORBIDDEN, "A fork has to come straight from the machine that is forking."));
        }
        if !params.branch.starts_with(BRANCH_PREFIX)
            || !params.branch.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_'))
        {
            return Err(RpcError::invalid_params("branch must be a kybern/fork-… branch name"));
        }
        // The commit goes to git as an argument: only a full hash may.
        if !matches!(params.commit.len(), 40 | 64) || !params.commit.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(RpcError::invalid_params("commit must be a full commit hash"));
        }
        if let Some(group) = &params.group {
            super::group_transfer::validate_group(group, true)?;
        }
        if params.handoff_note.len() > NOTE_CAP {
            return Err(RpcError::invalid_params("The hand-off note is too long."));
        }
        let from_name = hub.target(from).map(|target| target.name).unwrap_or_else(|| from.to_string());
        let origin = Origin {
            machine_id: from.to_string(),
            machine_name: from_name.clone(),
            thread_id: params.origin.thread_id,
            operation_id: params.operation_id,
            kind: OriginKind::Fork,
            permission_cap: params.origin.permission_cap,
            hops: vec![from.to_string()],
        };
        let operation = namespaced_operation(from, origin.thread_id, params.operation_id);
        let thread_id = derived_operation_id(operation, 0x46);
        let message_id = derived_operation_id(operation, 0x47);
        let message = UserMessage::text(fork_message(&params, &from_name, from, origin.thread_id));
        // The lock hands back an anyhow result; the fork's own refusals ride inside it.
        self.with_client_thread_id(thread_id, async {
            Ok::<_, anyhow::Error>(self.open_fork(&hub, from, &params, origin, thread_id, message_id, message).await)
        })
        .await
        .map_err(internal)?
    }

    /// Create the forked thread, or find the one an earlier call made. Runs with the thread id held.
    #[allow(clippy::too_many_arguments)]
    async fn open_fork(
        &self,
        hub: &std::sync::Arc<dyn RemoteHub>,
        from: &str,
        params: &PeerForkParams,
        origin: Origin,
        thread_id: ThreadId,
        message_id: MessageId,
        message: UserMessage,
    ) -> Result<PeerForkResult, RpcError> {
        if let Some(existing) = self.inner.store.thread_get(thread_id).map_err(internal)? {
            if !existing.origin.as_ref().is_some_and(|known| known.machine_id == from && known.kind == OriginKind::Fork) {
                return Err(conflict("operation_id already belongs to another thread."));
            }
            // An earlier try may have died before the message went in; it is answered from its receipt if it did.
            self.fork_send_note(thread_id, message_id, message).await?;
            return Ok(fork_result(hub, &existing, params, None));
        }
        let hub_name = hub.self_name();
        let (project, group) = match &params.group {
            Some(work) => {
                let (candidate, matched) = self.group_target(work, params.project.as_deref(), &hub_name).await?;
                (candidate.project, Some(matched))
            }
            None => (self.match_project(&params.repo, params.project.as_deref(), &hub_name).await?, None),
        };
        let (kind, model, effort) = self.fork_provider(&project, ForkProvider::of(params), &hub_name).await?;
        // Nothing is made before every commit is here, so a fork that waits for a bundle leaves no half-built thread.
        let (worktree, members) = match &group {
            Some(matched) => {
                let missing = Self::group_missing_commits(matched).await;
                if !missing.is_empty() {
                    return Err(needs_bundle(FORK_NEEDS_BUNDLE, missing, project.id));
                }
                let (worktree, members) = self.group_fork_workspace(&project, thread_id, matched, &params.branch).await?;
                self.group_forget(matched, params.operation_id).await;
                (worktree, members)
            }
            None => {
                let repo = Repo::new(&project.path);
                if !git_transfer::has_commit(&repo, &params.commit).await {
                    return Err(RpcError::new(codes::CONFLICT, format!("{hub_name} does not have commit {} yet.", params.commit))
                        .with_data(json!({ "needs": FORK_NEEDS_BUNDLE, "project_id": project.id })));
                }
                let path = self.fork_worktree(&project, &repo, thread_id, &params.branch, &params.commit).await?;
                git_transfer::forget(Some(&repo), &self.inner.paths.root, params.operation_id).await;
                (WorktreeInfo { path, branch: params.branch.clone() }, Vec::new())
            }
        };
        let path = worktree.path.clone();
        let now = Utc::now();
        let provider = ProviderInstance::default_for(kind);
        let thread = Thread {
            id: thread_id,
            project_id: project.id,
            title: params.title.clone().unwrap_or_else(|| params.source_title.clone()),
            provider,
            model,
            effort,
            permission_mode: narrower(params.permission_mode, origin.permission_cap),
            status: ThreadStatus::Idle,
            worktree: Some(worktree),
            cwd: path,
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            origin: Some(origin),
            inbound: None,
            moved: None,
            subagent: None,
            delegation: None,
            members,
        };
        self.inner.store.thread_upsert(&thread).map_err(internal)?;
        let event = self.emit(thread.id, None, EventPayload::ThreadCreated { thread: thread.clone() }).map_err(internal)?;
        let thread = Thread { last_seq: event.seq, ..thread };
        self.inner.store.thread_upsert(&thread).map_err(internal)?;
        if let Err(error) = self.fork_send_note(thread.id, message_id, message).await {
            // The thread exists; a repeat of this call sends the note again.
            tracing::warn!(thread_id = %thread.id, error = %error.message, "a forked thread could not start");
            return Err(error);
        }
        let created = self.inner.store.thread_get(thread.id).map_err(internal)?.unwrap_or(thread);
        Ok::<PeerForkResult, RpcError>(fork_result(hub, &created, params, Some(project.name)))
    }

    /// The worktree for a thread that starts from `branch` at `commit`, or the one an earlier try made.
    pub(super) async fn fork_worktree(
        &self,
        project: &Project,
        repo: &Repo,
        thread_id: ThreadId,
        branch: &str,
        commit: &str,
    ) -> Result<String, RpcError> {
        let dir = self.worktree_dir(project, &thread_id.to_string());
        if !dir.join(".git").exists() {
            if let Some(parent_dir) = dir.parent() {
                std::fs::create_dir_all(parent_dir).map_err(internal)?;
            }
            if let Err(error) = repo.worktree_add(&dir, branch, Some(commit)).await {
                // The branch is already here (pushed to origin and fetched, or left by a try that died): use it if it is the fork.
                let known = repo.rev_parse(&format!("refs/heads/{branch}")).await.ok();
                if known.as_deref() != Some(commit) {
                    return Err(conflict(format!("Could not create the worktree on {branch}: {error:#}")));
                }
                repo.worktree_add_existing(&dir, branch).await.map_err(internal)?;
            }
        }
        Ok(dir.to_string_lossy().into_owned())
    }

    pub(super) async fn fork_send_note(&self, thread_id: ThreadId, message_id: MessageId, message: UserMessage) -> Result<(), RpcError> {
        self.send_with_id(thread_id, message_id, message, false, true).await.map(|_| ()).map_err(super::remote_delegation::thread_error)
    }

    /// The harness, model and effort the new thread runs: the source's when this machine has it, else
    /// the first usable one, unless the user named a harness.
    pub(super) async fn fork_provider(
        &self,
        project: &Project,
        wanted: ForkProvider,
        machine: &str,
    ) -> Result<(ProviderKind, Option<String>, Option<String>), RpcError> {
        let usable = |statuses: &Option<Vec<ProviderStatus>>, kind: ProviderKind| {
            self.inner.drivers.get(kind).is_some()
                && statuses.as_ref().and_then(|all| all.iter().find(|status| status.kind == kind)).is_none_or(|status| status.available)
        };
        let cached = self.cached_provider_statuses(project.id).await.ok().flatten();
        let mut kind = wanted.kind;
        let (mut model, mut effort) = (wanted.model, wanted.effort);
        if !usable(&cached, kind) {
            if wanted.chosen {
                return Err(RpcError::new(codes::PROVIDER_UNAVAILABLE, format!("{kind} is not available on {machine}.")));
            }
            let all = self.refresh_provider_statuses(project.id).await.ok();
            let fallback =
                all.as_ref().and_then(|all| all.iter().find(|status| status.available && self.inner.drivers.get(status.kind).is_some()));
            let Some(fallback) = fallback else {
                return Err(RpcError::new(codes::PROVIDER_UNAVAILABLE, format!("No agent is available on {machine}.")));
            };
            kind = fallback.kind;
            // The source's model belongs to its own harness.
            (model, effort) = (None, None);
        }
        let provider = ProviderInstance::default_for(kind);
        self.validate_provider_selection(project.id, &provider, model.as_deref(), effort.as_deref())
            .await
            .map_err(|error| RpcError::new(codes::PROVIDER_UNAVAILABLE, format!("{error:#}")))?;
        Ok((kind, model, effort))
    }
}

/// The harness a fork or move asks for, and whether the user named it.
pub(super) struct ForkProvider {
    pub kind: ProviderKind,
    pub chosen: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
}

impl ForkProvider {
    fn of(params: &PeerForkParams) -> Self {
        Self { kind: params.provider, chosen: params.provider_chosen, model: params.model.clone(), effort: params.effort.clone() }
    }
}

fn fork_payload(item: &OutboxItem) -> Option<ForkPayload> {
    if item.kind != OutboxKind::Fork {
        return None;
    }
    serde_json::from_value(item.payload.clone()).ok()
}

fn fork_result(
    hub: &std::sync::Arc<dyn RemoteHub>,
    thread: &Thread,
    params: &PeerForkParams,
    project_name: Option<String>,
) -> PeerForkResult {
    PeerForkResult {
        thread_id: thread.id,
        machine_id: hub.self_id(),
        project_name,
        branch: thread.worktree.as_ref().map_or_else(|| params.branch.clone(), |worktree| worktree.branch.clone()),
        provider: thread.provider.kind,
    }
}

/// The new thread's first message: the note, the way back to the source, and what the branch is.
fn fork_message(params: &PeerForkParams, from_name: &str, from_id: &str, source: Option<ThreadId>) -> String {
    let mut text = params.handoff_note.trim().to_string();
    text.push_str("\n\n---\n");
    match source {
        Some(source) => {
            text.push_str(&format!("Forked from \"{}\" on {from_name}: {}\n", params.source_title, thread_link(from_id, source)))
        }
        None => text.push_str(&format!("Forked from \"{}\" on {from_name}.\n", params.source_title)),
    }
    match &params.group {
        Some(group) => text.push_str(&format!(
            "Each repository of this group ({}) is checked out on `{}`, a snapshot of that thread's work including its uncommitted changes. The original thread keeps going on {from_name}, independently; nothing you commit here is pushed unless you push it.",
            super::group_git::join_names(&group.members.iter().map(|member| member.name.as_str()).collect::<Vec<_>>()),
            params.branch
        )),
        None => text.push_str(&format!(
            "This checkout is on `{}`, a snapshot of that thread's work including its uncommitted changes. The original thread keeps going on {from_name}, independently; nothing you commit here is pushed unless you push it.",
            params.branch
        )),
    }
    text
}

// ---- the AppState entry points the RPC dispatcher calls ----

/// `threads.fork_to_machine`, and tell the clients about the item it queued.
pub(crate) async fn serve_fork_to_machine(state: &AppState, params: Value) -> Result<ThreadsForkToMachineResult, RpcError> {
    let result = state.orchestrator.fork_to_machine(from_value(params)?).await?;
    state.network.notify_outbox(result.item.clone());
    Ok(result)
}

/// `outbox.enqueue` with a `fork` operation: the same fork, for a client that queues it that way.
pub(crate) async fn serve_fork_enqueue(state: &AppState, params: OutboxEnqueueParams) -> Result<OutboxItem, RpcError> {
    let mut fork: ThreadsForkToMachineParams = serde_json::from_value(params.operation.payload).map_err(RpcError::invalid_params)?;
    fork.machine = params.target;
    fork.operation_id = params.operation.operation_id.or(fork.operation_id);
    let result = state.orchestrator.fork_to_machine(fork).await?;
    state.network.notify_outbox(result.item.clone());
    Ok(result.item)
}

#[cfg(test)]
mod tests {
    use super::in_list_item;

    #[test]
    fn a_reply_with_a_table_keeps_its_lines_inside_the_list_item() {
        let reply = "All green.\n\n| Machine | Result |\n| --- | --- |\n| os-kdi | pass |  ";
        assert_eq!(in_list_item(reply), "All green.\n  \n  | Machine | Result |\n  | --- | --- |\n  | os-kdi | pass |");
    }
}
