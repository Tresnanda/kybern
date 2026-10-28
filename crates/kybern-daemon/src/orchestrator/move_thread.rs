//! Continue on another machine (ADE-86 M3 / F2, design §7.2): move a thread, with its uncommitted work
//! and its visible conversation, to another machine. The source ends up read-only with a link.
//!
//! **The source machine (A).** `threads.move_to_machine` writes one `move` outbox item and answers; it
//! takes neither the lease nor a snapshot, so an offline target, or a turn that is still running, only
//! delays the item. Each delivery attempt ([`Orchestrator::remote_deliver_move`]) is a small state
//! machine over `Thread.moved`:
//!
//! 1. the thread must be idle with nothing queued, or the attempt waits (the outbox is woken when the
//!    thread goes idle). Under the thread's admission gate A takes the **lease** (`moved.state =
//!    departing`, ten minutes, renewed while the attempt lives) and snapshots the work into the move
//!    branch `kybern/move-<id>`. While the lease is held, sends are refused with "Moving to satyamas…";
//! 2. `peer.move.prepare` reserves B's slot (B checks repository, harness and history size), after the
//!    branch went over as a bundle if B asked for it;
//! 3. A marks the move `uncertain` **before** it sends `peer.move.commit` with the transcript export,
//!    so a crash or a lost answer is never mistaken for "B has nothing";
//! 4. B's answer finalizes: `moved.state = departed` with the new thread's id, and a notice.
//!
//! Anything that fails before step 3 releases the lease at once, so the thread is writable again. An
//! `uncertain` move is resolved by asking B (`peer.move.get`) on the next attempt, after a restart or
//! when the user abandons it. A lease nobody renews expires ([`Orchestrator::move_sweep`]).
//!
//! **The target machine (B).** `peer.move.prepare` / `commit` / `get` / `abort` keep their state in
//! `meta` rows keyed by the namespaced operation. Commit creates the worktree on the move branch and the
//! thread with an origin of kind `move`, appends `HistoryImported`, and sends the hand-off note as the
//! first message to a fresh native session. Everything is idempotent by `operation_id`.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Utc};
use kybern_git::Repo;
use kybern_protocol::methods::{Method, PeerMoveAbort, PeerMoveCommit, PeerMoveGet, PeerMovePrepare};
use kybern_protocol::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::fork_machine::{ForkProvider, NOTE_CAP, clip, conflict, not_found, short_id};
use super::remote_delegation::{
    CallFailure, Delivery, RemoteHub, from_value, internal, namespaced_operation, narrower, remote_error_delivery,
};
use super::{Orchestrator, derived_operation_id};
use crate::network::git_transfer;
use crate::state::AppState;

/// The branch every move uses on both machines: `kybern/move-<short id>`.
const BRANCH_PREFIX: &str = "kybern/move-";
/// One attempt, however long the bundle takes, is dropped after this and tried again.
const ATTEMPT_CAP: Duration = Duration::from_secs(30 * 60);
/// The lease is pushed forward this often while an attempt lives.
const RENEW_EVERY: Duration = Duration::from_secs(60);
const USER_TEXT_CAP: usize = 8_000;
const ASSISTANT_TEXT_CAP: usize = 20_000;
const TOOL_TEXT_CAP: usize = 300;

/// What the outbox item carries: everything a delivery needs that does not change between attempts.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MovePayload {
    source_thread_id: ThreadId,
    source_title: String,
    handoff_note: String,
    title: Option<String>,
    project: Option<String>,
    repo: RepoIdentity,
    provider: ProviderKind,
    provider_chosen: bool,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: PermissionMode,
}

/// B's record of a move, in `meta` under `move_in:<namespaced operation>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MoveSlot {
    from: String,
    from_thread: ThreadId,
    state: PeerMoveState,
    lease_until: DateTime<Utc>,
    project_id: ProjectId,
    branch: String,
    commit: String,
    thread_id: Option<ThreadId>,
    /// What the continuing thread runs, from the request that reserved the slot.
    wanted: MoveWanted,
}

/// What the continuing thread should run.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct MoveWanted {
    kind: ProviderKind,
    chosen: bool,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: PermissionMode,
    cap: PermissionMode,
}

fn slot_key(operation: Uuid) -> String {
    format!("move_in:{operation}")
}

fn move_payload(item: &OutboxItem) -> Option<MovePayload> {
    if item.kind != OutboxKind::Move {
        return None;
    }
    serde_json::from_value(item.payload.clone()).ok()
}

/// Why a thread that is moving, or moved, takes no more messages.
pub(super) fn moved_message(info: &MoveInfo) -> String {
    let name = if info.peer_name.is_empty() { "another machine" } else { info.peer_name.as_str() };
    match info.state {
        MoveState::Departed => format!("This thread continues on {name}. Open it there to keep going."),
        _ => format!("Moving to {name}… This thread takes no messages until the move finishes or is stopped."),
    }
}

/// Marks a thread as having an attempt in flight, so a second one (or an abandon) leaves it alone.
struct Attempt {
    orchestrator: Orchestrator,
    thread_id: ThreadId,
}

impl Attempt {
    fn start(orchestrator: &Orchestrator, thread_id: ThreadId) -> Option<Self> {
        let mut moving = orchestrator.inner.remote.moving.lock().unwrap_or_else(|error| error.into_inner());
        moving.insert(thread_id).then(|| Self { orchestrator: orchestrator.clone(), thread_id })
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        self.orchestrator.inner.remote.moving.lock().unwrap_or_else(|error| error.into_inner()).remove(&self.thread_id);
    }
}

/// Pushes the lease forward while an attempt runs; stops with it.
struct Renewal(tokio::task::JoinHandle<()>);

impl Drop for Renewal {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Orchestrator {
    // ---- the source machine: asking for a move ----

    /// `threads.move_to_machine`: write the outbox item and answer without waiting for anything.
    pub async fn move_to_machine(&self, params: ThreadsMoveToMachineParams) -> Result<ThreadsMoveToMachineResult, RpcError> {
        let hub = self.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?.clone();
        let thread = self.fork_source(params.thread_id)?;
        let target = hub.resolve(&params.machine).map_err(RpcError::invalid_params)?;
        if let Some(features) = &target.features
            && !features.iter().any(|feature| feature == features::MOVE_V1)
        {
            return Err(conflict(format!(
                "{} needs a newer Kybern to continue a thread there. Update it from Settings → Machines.",
                target.name
            )));
        }
        let operation_id = params.operation_id.unwrap_or_else(Uuid::now_v7);
        if let Some(existing) = self.inner.store.outbox_get_by_operation(operation_id).map_err(internal)? {
            return self.move_result_of(existing, params.thread_id);
        }
        if let Some(moved) = &thread.moved {
            return Err(conflict(moved_message(moved)));
        }
        for state in [OutboxState::Queued, OutboxState::Sending] {
            let waiting = self.inner.store.outbox_list(None, Some(state)).map_err(internal)?;
            if waiting.iter().filter_map(move_payload).any(|payload| payload.source_thread_id == thread.id) {
                return Err(conflict(
                    "This thread is already waiting to move to another machine. Keep it here first, or wait for that move.",
                ));
            }
        }
        let repo_identity = git_transfer::identity_of(std::path::Path::new(&thread.cwd)).await;
        if repo_identity.is_empty() {
            return Err(conflict("Continuing on another machine needs a git repository, so Kybern can find the matching checkout there."));
        }
        let handoff_note = match params.handoff_note.as_deref().map(str::trim).filter(|note| !note.is_empty()) {
            Some(note) => note.to_string(),
            None => self.handoff_note(&thread).await.map_err(internal)?,
        };
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
            kind: OriginKind::Move,
            permission_cap: permission_mode,
            hops: vec![hub.self_id()],
        };
        let payload = MovePayload {
            source_thread_id: thread.id,
            source_title: thread.title.clone(),
            handoff_note: handoff_note.clone(),
            title: params.title.clone().filter(|title| !title.trim().is_empty()),
            project: params.project.clone(),
            repo: repo_identity,
            provider: kind,
            provider_chosen: params.provider.is_some(),
            model,
            effort,
            permission_mode,
        };
        let now = Utc::now();
        let item = OutboxItem {
            id: Uuid::now_v7(),
            operation_id,
            target: target.id.clone(),
            kind: OutboxKind::Move,
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
        let item = self.inner.store.outbox_insert(&item).map_err(internal)?;
        hub.kick();
        let waiting_for = if !target.online || target.paused {
            Some("it to come online")
        } else if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) {
            Some("this turn to finish")
        } else {
            None
        };
        if let Some(waiting_for) = waiting_for {
            let text = format!("Moving to {}: waiting for {waiting_for}. Until then this thread works as usual.", target.name);
            let _ = self.emit(
                thread.id,
                None,
                EventPayload::ProviderNotice {
                    level: NoticeLevel::Info,
                    text,
                    data: Some(json!({ "kind": "move_queued", "machine_id": target.id, "machine_name": target.name, "operation_id": operation_id })),
                },
            );
        }
        Ok(ThreadsMoveToMachineResult { operation_id, item, target_name: target.name, handoff_note })
    }

    /// The answer for an item that already exists (a repeated request).
    fn move_result_of(&self, item: OutboxItem, thread_id: ThreadId) -> Result<ThreadsMoveToMachineResult, RpcError> {
        let payload = move_payload(&item).ok_or_else(|| conflict("operation_id already belongs to something other than a move."))?;
        if payload.source_thread_id != thread_id {
            return Err(conflict("operation_id already belongs to another thread's move. Use a fresh operation_id."));
        }
        let target_name =
            self.remote_hub().and_then(|hub| hub.target(&item.target)).map(|target| target.name).unwrap_or_else(|| item.target.clone());
        Ok(ThreadsMoveToMachineResult { operation_id: item.operation_id, target_name, handoff_note: payload.handoff_note, item })
    }

    /// `threads.move_abandon`: give up a move whose outcome is unknown. The target is asked first: a thread it
    /// already created makes the move done.
    pub async fn move_abandon(&self, params: ThreadsMoveAbandonParams) -> Result<ThreadsMoveAbandonResult, RpcError> {
        let thread = self.inner.store.thread_get(params.thread_id).map_err(internal)?.ok_or_else(|| not_found("no such thread"))?;
        let Some(info) = thread.moved.clone().filter(|info| info.state == MoveState::Departing) else {
            return Ok(ThreadsMoveAbandonResult { outcome: MoveAbandonOutcome::Nothing });
        };
        let Some(_attempt) = Attempt::start(self, thread.id) else {
            return Err(conflict("The move is being sent right now. Try again in a moment."));
        };
        let from_thread = thread.id;
        if info.uncertain {
            let hub =
                self.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?.clone();
            let ask = PeerMoveRefParams { operation_id: info.operation_id, from_thread };
            match hub.call(&info.peer, PeerMoveAbort::NAME, serde_json::to_value(&ask).unwrap_or(Value::Null)).await {
                Ok(value) => {
                    let status: PeerMoveStatus = serde_json::from_value(value).map_err(internal)?;
                    if status.state == PeerMoveState::Committed
                        && let Some(thread_id) = status.thread_id
                    {
                        self.move_finalize(&thread, &info, thread_id).map_err(internal)?;
                        self.move_cancel_item(info.operation_id);
                        return Ok(ThreadsMoveAbandonResult { outcome: MoveAbandonOutcome::Completed });
                    }
                }
                Err(failure) if !params.force => {
                    return Err(conflict(format!(
                        "Can't ask {} whether it already has this thread ({failure}). Try again when it is online, or abandon anyway; if it did create the thread there will be two.",
                        if info.peer_name.is_empty() { "the other machine" } else { info.peer_name.as_str() }
                    )));
                }
                Err(_) => {}
            }
        } else if let Some(hub) = self.remote_hub().cloned() {
            self.move_tell_abort(&hub, &info, from_thread);
        }
        self.move_set(thread.id, None).map_err(internal)?;
        self.move_cancel_item(info.operation_id);
        Ok(ThreadsMoveAbandonResult { outcome: MoveAbandonOutcome::Released })
    }

    fn move_cancel_item(&self, operation_id: Uuid) {
        let Ok(Some(mut item)) = self.inner.store.outbox_get_by_operation(operation_id) else { return };
        if item.state.is_settled() {
            return;
        }
        item.state = OutboxState::Cancelled;
        item.updated_at = Utc::now();
        if self.inner.store.outbox_update(&item).unwrap_or(false) {
            self.remote_outbox_changed(&item);
        }
    }

    // ---- the source machine: delivering ----

    /// Deliver a queued `move` item. Each call is one attempt at the state machine in the module docs.
    pub async fn remote_deliver_move(&self, item: &OutboxItem) -> Delivery {
        let Some(hub) = self.remote_hub().cloned() else {
            return Delivery::Failed("This daemon cannot reach other machines.".into());
        };
        let Some(payload) = move_payload(item) else {
            return Delivery::Failed("The queued move is unreadable.".into());
        };
        let Some(_attempt) = Attempt::start(self, payload.source_thread_id) else {
            return Delivery::Retry("The move is already being sent.".into());
        };
        match tokio::time::timeout(ATTEMPT_CAP, self.move_attempt(&hub, item, &payload)).await {
            Ok(delivery) => delivery,
            Err(_) => {
                self.move_release_unless_uncertain(payload.source_thread_id, item.operation_id);
                Delivery::Retry("Sending the move took too long; trying again.".into())
            }
        }
    }

    async fn move_attempt(&self, hub: &Arc<dyn RemoteHub>, item: &OutboxItem, payload: &MovePayload) -> Delivery {
        let thread = match self.inner.store.thread_get(payload.source_thread_id) {
            Ok(Some(thread)) => thread,
            Ok(None) => return Delivery::Failed("The thread no longer exists on this machine.".into()),
            Err(error) => return Delivery::Retry(format!("{error:#}")),
        };
        if hub.target(&item.target).is_none() {
            return Delivery::Failed("That machine was removed from your network, so the thread cannot move there.".into());
        }
        match thread.moved.clone() {
            Some(info) if info.operation_id == item.operation_id => match info.state {
                MoveState::Departed => return Delivery::Delivered(departed_result(&thread, &info)),
                MoveState::Departing if info.uncertain => return self.move_resolve(hub, item, payload, &thread, info).await,
                // A lease whose attempt is gone (the daemon restarted, or the sweep has not run): start over.
                _ => {
                    self.move_tell_abort(hub, &info, thread.id);
                    if let Err(error) = self.move_set(thread.id, None) {
                        return Delivery::Retry(format!("{error:#}"));
                    }
                }
            },
            Some(other) => {
                return Delivery::Failed(format!(
                    "This thread is already {}.",
                    if other.state == MoveState::Departed { "moved" } else { "moving elsewhere" }
                ));
            }
            None => {}
        }
        let info = match self.move_begin(hub, item, payload).await {
            Ok(info) => info,
            Err(delivery) => return delivery,
        };
        self.move_run(hub, item, payload, info).await
    }

    /// Take the lease and snapshot the work, or say why the thread cannot go yet.
    async fn move_begin(&self, hub: &Arc<dyn RemoteHub>, item: &OutboxItem, payload: &MovePayload) -> Result<MoveInfo, Delivery> {
        let target = hub.target(&item.target).ok_or_else(|| Delivery::Failed("That machine was removed from your network.".into()))?;
        let admission = self.session_admission(payload.source_thread_id).await.lock_owned().await;
        let thread = self
            .inner
            .store
            .thread_get(payload.source_thread_id)
            .map_err(|error| Delivery::Retry(format!("{error:#}")))?
            .ok_or_else(|| Delivery::Failed("The thread no longer exists on this machine.".into()))?;
        match thread.status {
            ThreadStatus::Archived => return Err(Delivery::Failed("The thread was archived, so it cannot move.".into())),
            ThreadStatus::Running | ThreadStatus::AwaitingApproval => {
                return Err(Delivery::Retry("Waiting for the running turn to finish.".into()));
            }
            ThreadStatus::Idle | ThreadStatus::Failed => {}
        }
        if self.inner.store.queue_list(Some(thread.id)).map(|queued| !queued.is_empty()).unwrap_or(false) {
            return Err(Delivery::Retry("Waiting for the queued messages to finish.".into()));
        }
        let repo = Repo::new(&thread.cwd);
        let (commit, _) = self
            .fork_commit(&thread, &repo, &hub.self_name())
            .await
            .map_err(|error| Delivery::Failed(format!("Could not snapshot the work: {error:#}")))?;
        let branch = format!("{BRANCH_PREFIX}{}", short_id(item.operation_id));
        repo.update_ref(&format!("refs/heads/{branch}"), &commit)
            .await
            .map_err(|error| Delivery::Failed(format!("Could not create the move branch: {error:#}")))?;
        let info = MoveInfo {
            state: MoveState::Departing,
            peer: item.target.clone(),
            peer_name: target.name,
            peer_thread_id: None,
            lease_until: Some(Utc::now() + chrono::Duration::seconds(MOVE_LEASE_SECONDS)),
            operation_id: item.operation_id,
            branch: Some(branch),
            commit: Some(commit),
            uncertain: false,
        };
        self.move_set(thread.id, Some(info.clone())).map_err(|error| Delivery::Retry(format!("{error:#}")))?;
        drop(admission);
        Ok(info)
    }

    /// Steps 2 to 4: prepare, send the branch if asked, commit, finalize.
    async fn move_run(&self, hub: &Arc<dyn RemoteHub>, item: &OutboxItem, payload: &MovePayload, info: MoveInfo) -> Delivery {
        let thread_id = payload.source_thread_id;
        let _renewal = self.move_renewal(thread_id, item.operation_id);
        let (Some(branch), Some(commit)) = (info.branch.clone(), info.commit.clone()) else {
            self.move_release_unless_uncertain(thread_id, item.operation_id);
            return Delivery::Failed("The move lost its snapshot.".into());
        };
        let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else {
            return Delivery::Failed("The thread no longer exists on this machine.".into());
        };
        let history = self.move_history(&thread);
        let Some(origin) = item.origin.clone() else {
            self.move_release_unless_uncertain(thread_id, item.operation_id);
            return Delivery::Failed("The queued move has no origin.".into());
        };
        let prepare = PeerMovePrepareParams {
            operation_id: item.operation_id,
            origin,
            source_title: payload.source_title.clone(),
            repo: payload.repo.clone(),
            project: payload.project.clone(),
            branch,
            commit: commit.clone(),
            provider: payload.provider,
            provider_chosen: payload.provider_chosen,
            model: payload.model.clone(),
            effort: payload.effort.clone(),
            permission_mode: payload.permission_mode,
            history_bytes: history.bytes as u64,
        };
        let prepare_value = serde_json::to_value(&prepare).unwrap_or(Value::Null);
        let repo = Repo::new(&thread.cwd);
        let mut answer = hub.call(&item.target, PeerMovePrepare::NAME, prepare_value.clone()).await;
        if let Err(CallFailure::Remote(error)) = &answer
            && error.data.as_ref().and_then(|data| data.get("needs")).and_then(Value::as_str) == Some(MOVE_NEEDS_BUNDLE)
        {
            match self.send_branch(&**hub, item, &payload.repo, payload.project.as_deref(), &commit, &repo).await {
                Ok(()) => answer = hub.call(&item.target, PeerMovePrepare::NAME, prepare_value).await,
                Err(delivery) => return self.move_not_sent(thread_id, item.operation_id, delivery),
            }
        }
        match answer {
            Ok(value) => {
                if serde_json::from_value::<PeerMovePrepareResult>(value).is_err() {
                    return self.move_not_sent(
                        thread_id,
                        item.operation_id,
                        Delivery::Failed("the machine answered with something unreadable".into()),
                    );
                }
            }
            Err(CallFailure::Offline(reason)) => return self.move_not_sent(thread_id, item.operation_id, Delivery::Retry(reason)),
            Err(CallFailure::Gone(reason)) => return self.move_not_sent(thread_id, item.operation_id, Delivery::Failed(reason)),
            Err(CallFailure::Remote(error)) => return self.move_not_sent(thread_id, item.operation_id, remote_error_delivery(&error)),
        }

        // From here on the target may create the thread, so a missing answer is "unknown", never "no".
        let mut sent = info;
        sent.uncertain = true;
        sent.lease_until = None;
        if let Err(error) = self.move_set(thread_id, Some(sent.clone())) {
            return self.move_not_sent(thread_id, item.operation_id, Delivery::Retry(format!("{error:#}")));
        }
        self.move_commit(hub, item, payload, &thread, sent, history).await
    }

    async fn move_commit(
        &self,
        hub: &Arc<dyn RemoteHub>,
        item: &OutboxItem,
        payload: &MovePayload,
        thread: &Thread,
        info: MoveInfo,
        history: History,
    ) -> Delivery {
        let commit = PeerMoveCommitParams {
            operation_id: item.operation_id,
            handoff_note: payload.handoff_note.clone(),
            title: payload.title.clone(),
            from_thread: thread.id,
            from_title: thread.title.clone(),
            items: history.items,
            omitted: history.omitted,
        };
        match hub.call(&item.target, PeerMoveCommit::NAME, serde_json::to_value(&commit).unwrap_or(Value::Null)).await {
            Ok(value) => match serde_json::from_value::<PeerMoveCommitResult>(value.clone()) {
                Ok(result) => match self.move_finalize(thread, &info, result.thread_id) {
                    Ok(()) => Delivery::Delivered(value),
                    Err(error) => Delivery::Retry(format!("{error:#}")),
                },
                Err(error) => Delivery::Retry(format!("the machine answered with something unreadable: {error}")),
            },
            // The target may have made the thread before the line dropped: the next attempt asks it.
            Err(CallFailure::Offline(reason)) => Delivery::Retry(reason),
            Err(CallFailure::Gone(reason)) => Delivery::Failed(reason),
            Err(CallFailure::Remote(error)) => match remote_error_delivery(&error) {
                // The target broke part way (busy, restarting): it may have the thread.
                Delivery::Retry(reason) => Delivery::Retry(reason),
                // It refused, and creates nothing before it has checked everything.
                other => {
                    self.move_tell_abort(hub, &info, thread.id);
                    self.move_clear(thread.id, item.operation_id);
                    other
                }
            },
        }
    }

    /// An attempt that comes back with an `uncertain` move: ask the target what it did.
    async fn move_resolve(
        &self,
        hub: &Arc<dyn RemoteHub>,
        item: &OutboxItem,
        payload: &MovePayload,
        thread: &Thread,
        info: MoveInfo,
    ) -> Delivery {
        let ask = PeerMoveRefParams { operation_id: item.operation_id, from_thread: thread.id };
        match hub.call(&item.target, PeerMoveGet::NAME, serde_json::to_value(&ask).unwrap_or(Value::Null)).await {
            Ok(value) => {
                let Ok(status) = serde_json::from_value::<PeerMoveStatus>(value) else {
                    return Delivery::Retry("the machine answered with something unreadable".into());
                };
                match (status.state, status.thread_id) {
                    (PeerMoveState::Committed, Some(thread_id)) => match self.move_finalize(thread, &info, thread_id) {
                        Ok(()) => Delivery::Delivered(departed_result(
                            &self.inner.store.thread_get(thread.id).ok().flatten().unwrap_or_else(|| thread.clone()),
                            &info,
                        )),
                        Err(error) => Delivery::Retry(format!("{error:#}")),
                    },
                    // The target is holding the slot: send the commit again.
                    (PeerMoveState::Prepared, _) => {
                        let history = self.move_history(thread);
                        self.move_commit(hub, item, payload, thread, info, history).await
                    }
                    // It has nothing: no thread exists, so the thread is free to try again from the start.
                    _ => {
                        self.move_clear(thread.id, item.operation_id);
                        Delivery::Retry("The other machine dropped the move; starting it again.".into())
                    }
                }
            }
            Err(CallFailure::Offline(reason)) => Delivery::Retry(reason),
            Err(CallFailure::Gone(reason)) => Delivery::Failed(reason),
            Err(CallFailure::Remote(error)) => remote_error_delivery(&error),
        }
    }

    /// The attempt ended before the commit went out: the thread is yours again, and `delivery` says what happens next.
    fn move_not_sent(&self, thread_id: ThreadId, operation_id: Uuid, delivery: Delivery) -> Delivery {
        self.move_release_unless_uncertain(thread_id, operation_id);
        delivery
    }

    /// Clear the lease of `operation_id` unless the commit may have gone out.
    fn move_release_unless_uncertain(&self, thread_id: ThreadId, operation_id: Uuid) {
        let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else { return };
        if thread
            .moved
            .as_ref()
            .is_some_and(|info| info.operation_id == operation_id && info.state == MoveState::Departing && !info.uncertain)
        {
            if let Err(error) = self.move_set(thread_id, None) {
                tracing::warn!(%error, %thread_id, "could not release a move lease");
            }
            if let (Some(hub), Some(info)) = (self.remote_hub().cloned(), thread.moved.as_ref()) {
                self.move_tell_abort(&hub, info, thread_id);
            }
        }
    }

    /// Clear the lease of a move the target is known not to have, even though it was marked uncertain.
    fn move_clear(&self, thread_id: ThreadId, operation_id: Uuid) {
        let Ok(Some(thread)) = self.inner.store.thread_get(thread_id) else { return };
        if thread.moved.as_ref().is_some_and(|info| info.operation_id == operation_id && info.state == MoveState::Departing) {
            let _ = self.move_set(thread_id, None);
        }
    }

    /// Tell the target to drop its slot. Best effort: its own lease copy expires anyway.
    fn move_tell_abort(&self, hub: &Arc<dyn RemoteHub>, info: &MoveInfo, from_thread: ThreadId) {
        let hub = hub.clone();
        let (peer, operation_id) = (info.peer.clone(), info.operation_id);
        tokio::spawn(async move {
            let ask = PeerMoveRefParams { operation_id, from_thread };
            let _ = hub.call(&peer, PeerMoveAbort::NAME, serde_json::to_value(&ask).unwrap_or(Value::Null)).await;
        });
    }

    /// Keep the lease alive while an attempt runs.
    fn move_renewal(&self, thread_id: ThreadId, operation_id: Uuid) -> Renewal {
        let orchestrator = self.clone();
        Renewal(tokio::spawn(async move {
            loop {
                tokio::time::sleep(RENEW_EVERY).await;
                let Ok(Some(thread)) = orchestrator.inner.store.thread_get(thread_id) else { return };
                let Some(mut info) = thread.moved.filter(|info| info.operation_id == operation_id && info.state == MoveState::Departing)
                else {
                    return;
                };
                if info.uncertain {
                    return;
                }
                info.lease_until = Some(Utc::now() + chrono::Duration::seconds(MOVE_LEASE_SECONDS));
                let _ = orchestrator.inner.store.thread_set_moved(thread_id, Some(&info));
            }
        }))
    }

    /// Record the departure: the source is read-only and says where the work continues.
    fn move_finalize(&self, thread: &Thread, info: &MoveInfo, peer_thread: ThreadId) -> Result<()> {
        let current = self.inner.store.thread_get(thread.id)?.unwrap_or_else(|| thread.clone());
        if current.moved.as_ref().is_some_and(|moved| moved.state == MoveState::Departed && moved.operation_id == info.operation_id) {
            return Ok(());
        }
        let done =
            MoveInfo { state: MoveState::Departed, peer_thread_id: Some(peer_thread), lease_until: None, uncertain: false, ..info.clone() };
        self.move_set(thread.id, Some(done.clone()))?;
        let name = if done.peer_name.is_empty() { "the other machine".to_string() } else { done.peer_name.clone() };
        let _ = self.emit(
            thread.id,
            None,
            EventPayload::ProviderNotice {
                level: NoticeLevel::Info,
                text: format!("Continued on {name} · open"),
                data: Some(json!({
                    "kind": "move", "machine_id": done.peer, "machine_name": name, "thread_id": peer_thread,
                    "branch": done.branch, "operation_id": done.operation_id,
                })),
            },
        );
        Ok(())
    }

    /// Set or clear `Thread.moved` and publish the thread. Nothing else writes the field.
    pub(super) fn move_set(&self, thread_id: ThreadId, moved: Option<MoveInfo>) -> Result<Thread> {
        let _updates = self.inner.thread_updates.lock().map_err(|_| anyhow::anyhow!("thread update lock poisoned"))?;
        let mut thread =
            self.inner.store.thread_set_moved(thread_id, moved.as_ref())?.ok_or_else(|| anyhow::anyhow!("The thread no longer exists."))?;
        thread.updated_at = Utc::now();
        self.inner.store.thread_upsert(&thread)?;
        let event = self.emit(thread.id, None, EventPayload::ThreadUpdated { thread: thread.clone() })?;
        thread.last_seq = event.seq;
        self.inner.store.thread_upsert(&thread)?;
        Ok(thread)
    }

    /// The outbox item reached a final state: tell the source thread what became of the move.
    pub(super) fn move_outbox_changed(&self, item: &OutboxItem) {
        let Some(payload) = move_payload(item) else { return };
        let thread_id = payload.source_thread_id;
        let name = self
            .remote_hub()
            .and_then(|hub| hub.target(&item.target))
            .map(|target| target.name)
            .unwrap_or_else(|| "the other machine".into());
        match item.state {
            OutboxState::Failed | OutboxState::Expired | OutboxState::Cancelled => {
                // A lease nobody can finish is released; an uncertain one stays until the user abandons it.
                self.move_release_unless_uncertain(thread_id, item.operation_id);
                if item.state == OutboxState::Cancelled {
                    return;
                }
                let text = format!("Couldn't move to {name}: {}", item.last_error.as_deref().unwrap_or("delivery failed"));
                let data = json!({ "kind": "move_failed", "machine_id": item.target, "machine_name": name, "operation_id": item.operation_id, "item_id": item.id });
                self.move_notice_once(thread_id, item, NoticeLevel::Warning, text, data);
            }
            _ => {}
        }
    }

    fn move_notice_once(&self, thread_id: ThreadId, item: &OutboxItem, level: NoticeLevel, text: String, data: Value) {
        // A retried item gets a fresh expiry, so each round of failure is told once.
        let key = format!("move_notice:{}:{}:{}", item.operation_id, item.state.as_str(), item.expires_at.timestamp());
        if matches!(self.inner.store.meta_get(&key), Ok(Some(_))) {
            return;
        }
        if self.inner.store.thread_get(thread_id).ok().flatten().is_none() {
            return;
        }
        match self.emit(thread_id, None, EventPayload::ProviderNotice { level, text, data: Some(data) }) {
            Ok(_) => {
                let _ = self.inner.store.meta_set(&key, "1");
            }
            Err(error) => tracing::warn!(%error, "could not tell a thread that its move stopped"),
        }
    }

    /// Release every lease that ran out with no attempt alive to renew it (a crash, a hung attempt).
    pub fn move_sweep(&self) {
        let Ok(threads) = self.inner.store.threads_with_move() else { return };
        let now = Utc::now();
        for thread in threads {
            let Some(info) = thread.moved.clone() else { continue };
            if info.state != MoveState::Departing || info.uncertain || info.lease_until.is_none_or(|until| until > now) {
                continue;
            }
            let moving = self.inner.remote.moving.lock().unwrap_or_else(|error| error.into_inner()).contains(&thread.id);
            if moving {
                continue;
            }
            tracing::info!(thread_id = %thread.id, "a move lease ran out; the thread is writable again");
            if self.move_set(thread.id, None).is_err() {
                continue;
            }
            if let Some(hub) = self.remote_hub().cloned() {
                self.move_tell_abort(&hub, &info, thread.id);
            }
            let name = if info.peer_name.is_empty() { "the other machine".to_string() } else { info.peer_name.clone() };
            let _ = self.emit(
                thread.id,
                None,
                EventPayload::ProviderNotice {
                    level: NoticeLevel::Warning,
                    text: format!("The move to {name} didn't finish, so this thread is yours again. It will try again when {name} is reachable."),
                    data: Some(json!({ "kind": "move_released", "machine_id": info.peer, "machine_name": name, "operation_id": info.operation_id })),
                },
            );
        }
    }

    /// A thread went idle: a move that waited for it can go now.
    pub(super) fn move_thread_idle(&self, thread: &Thread) {
        if thread.status != ThreadStatus::Idle || thread.moved.is_some() {
            return;
        }
        let Some(hub) = self.remote_hub() else { return };
        if self.inner.store.outbox_wake_move(thread.id).unwrap_or(false) {
            hub.kick();
        }
    }

    // ---- the carried history ----

    fn move_history(&self, thread: &Thread) -> History {
        let events = self.inner.store.events_for_thread(thread.id).unwrap_or_default();
        let entries = kybern_store::project_transcript(&events);
        let mut items: Vec<HistoryItem> = Vec::new();
        for entry in entries {
            match entry {
                // A thread that moved before carries what it had.
                TranscriptEntry::History { items: earlier, .. } => items.extend(earlier),
                TranscriptEntry::User { message, at, .. } => {
                    let text = message.plain_text();
                    if !text.trim().is_empty() {
                        items.push(HistoryItem { role: HistoryRole::User, text: clip(&text, USER_TEXT_CAP), at: Some(at), tool: None });
                    }
                }
                TranscriptEntry::Assistant { origin: EventOrigin::Root, text, at, complete, .. } if complete && !text.trim().is_empty() => {
                    items.push(HistoryItem {
                        role: HistoryRole::Assistant,
                        text: clip(&text, ASSISTANT_TEXT_CAP),
                        at: Some(at),
                        tool: None,
                    });
                }
                TranscriptEntry::ToolCall { origin: EventOrigin::Root, call, at, .. } => {
                    items.push(HistoryItem {
                        role: HistoryRole::Tool,
                        text: tool_summary(&call),
                        at: Some(at),
                        tool: Some(call.name.clone()),
                    });
                }
                _ => {}
            }
        }
        fit_history(items)
    }

    // ---- the target machine ----

    fn move_slot(&self, operation: Uuid) -> Option<MoveSlot> {
        self.inner.store.meta_get(&slot_key(operation)).ok().flatten().and_then(|json| serde_json::from_str(&json).ok())
    }

    fn move_slot_save(&self, operation: Uuid, slot: &MoveSlot) -> Result<(), RpcError> {
        self.inner.store.meta_set(&slot_key(operation), &serde_json::to_string(slot).map_err(internal)?).map_err(internal)
    }

    /// The slot as it stands now: a prepared one whose lease ran out is gone.
    fn move_slot_live(&self, operation: Uuid) -> Option<MoveSlot> {
        let mut slot = self.move_slot(operation)?;
        if slot.state == PeerMoveState::Prepared && slot.lease_until < Utc::now() {
            slot.state = PeerMoveState::Aborted;
            let _ = self.move_slot_save(operation, &slot);
        }
        Some(slot)
    }

    fn move_checked_origin(&self, from: &str, origin: &Origin) -> Result<(), RpcError> {
        // The origin is the session's machine and nothing the caller wrote, and it travels one hop only.
        if origin.hops.len() > 1 || origin.hops.first().is_some_and(|hop| hop != from) || origin.kind != OriginKind::Move {
            return Err(RpcError::new(codes::FORBIDDEN, "A move has to come straight from the machine that is moving."));
        }
        Ok(())
    }

    /// `peer.move.prepare`: reserve a slot for a thread moving here.
    pub(super) async fn accept_move_prepare(&self, from: &str, params: PeerMovePrepareParams) -> Result<PeerMovePrepareResult, RpcError> {
        let hub = self.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?.clone();
        self.move_checked_origin(from, &params.origin)?;
        if !params.branch.starts_with(BRANCH_PREFIX)
            || !params.branch.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_'))
        {
            return Err(RpcError::invalid_params("branch must be a kybern/move-… branch name"));
        }
        if !matches!(params.commit.len(), 40 | 64) || !params.commit.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(RpcError::invalid_params("commit must be a full commit hash"));
        }
        if params.history_bytes as usize > MAX_HISTORY_BYTES + 64 * 1024 {
            return Err(RpcError::invalid_params("The conversation to carry is too large."));
        }
        let from_thread = params.origin.thread_id.ok_or_else(|| RpcError::invalid_params("origin.thread_id is required"))?;
        let operation = namespaced_operation(from, Some(from_thread), params.operation_id);
        let hub_name = hub.self_name();
        let project = self.match_project(&params.repo, params.project.as_deref(), &hub_name).await?;
        if let Some(slot) = self.move_slot_live(operation)
            && slot.state == PeerMoveState::Committed
        {
            return Ok(PeerMovePrepareResult { lease_until: Utc::now(), project_name: project.name, provider: slot.wanted.kind });
        }
        let wanted = ForkProvider {
            kind: params.provider,
            chosen: params.provider_chosen,
            model: params.model.clone(),
            effort: params.effort.clone(),
        };
        let (kind, ..) = self.fork_provider(&project, wanted, &hub_name).await?;
        let repo = Repo::new(&project.path);
        if !git_transfer::has_commit(&repo, &params.commit).await {
            return Err(RpcError::new(codes::CONFLICT, format!("{hub_name} does not have commit {} yet.", params.commit))
                .with_data(json!({ "needs": MOVE_NEEDS_BUNDLE, "project_id": project.id })));
        }
        let lease_until = Utc::now() + chrono::Duration::seconds(MOVE_LEASE_SECONDS);
        let slot = MoveSlot {
            from: from.to_string(),
            from_thread,
            state: PeerMoveState::Prepared,
            lease_until,
            project_id: project.id,
            branch: params.branch.clone(),
            commit: params.commit.clone(),
            thread_id: None,
            wanted: MoveWanted {
                kind,
                chosen: params.provider_chosen,
                model: params.model.clone(),
                effort: params.effort.clone(),
                permission_mode: params.permission_mode,
                cap: params.origin.permission_cap,
            },
        };
        self.move_slot_save(operation, &slot)?;
        Ok(PeerMovePrepareResult { lease_until, project_name: project.name, provider: kind })
    }

    /// `peer.move.commit`: create the thread from the carried history, or find the one an earlier call made.
    pub(super) async fn accept_move_commit(&self, from: &str, params: PeerMoveCommitParams) -> Result<PeerMoveCommitResult, RpcError> {
        let hub = self.remote_hub().ok_or_else(|| RpcError::new(codes::NOT_AVAILABLE, "This daemon cannot reach other machines."))?.clone();
        if params.handoff_note.len() > NOTE_CAP {
            return Err(RpcError::invalid_params("The hand-off note is too long."));
        }
        let size: usize = params.items.iter().map(|item| item.text.len() + 64).sum();
        if size > MAX_HISTORY_BYTES + 64 * 1024 {
            return Err(RpcError::invalid_params("The conversation to carry is too large."));
        }
        let operation = namespaced_operation(from, Some(params.from_thread), params.operation_id);
        let thread_id = derived_operation_id(operation, 0x4d);
        let message_id = derived_operation_id(operation, 0x4e);
        self.with_client_thread_id(thread_id, async {
            Ok::<_, anyhow::Error>(self.open_move(&hub, from, &params, operation, thread_id, message_id).await)
        })
        .await
        .map_err(internal)?
    }

    async fn open_move(
        &self,
        hub: &Arc<dyn RemoteHub>,
        from: &str,
        params: &PeerMoveCommitParams,
        operation: Uuid,
        thread_id: ThreadId,
        message_id: MessageId,
    ) -> Result<PeerMoveCommitResult, RpcError> {
        let Some(mut slot) = self.move_slot_live(operation) else {
            return Err(conflict("This machine has no reservation for the move (it may have expired). The other machine starts it again."));
        };
        if slot.from != from {
            return Err(RpcError::new(codes::FORBIDDEN, "That move belongs to another machine."));
        }
        let from_name = hub.target(from).map(|target| target.name).unwrap_or_else(|| from.to_string());
        let message = UserMessage::text(move_message(params, &slot.branch, &from_name, from));
        if let Some(existing) = self.inner.store.thread_get(thread_id).map_err(internal)? {
            if !existing.origin.as_ref().is_some_and(|known| known.machine_id == from && known.kind == OriginKind::Move) {
                return Err(conflict("operation_id already belongs to another thread."));
            }
            // An earlier try may have died before the history or the note went in.
            self.move_ensure_history(&existing, params, from, &from_name).map_err(internal)?;
            self.fork_send_note(thread_id, message_id, message).await?;
            slot.state = PeerMoveState::Committed;
            slot.thread_id = Some(thread_id);
            self.move_slot_save(operation, &slot)?;
            return Ok(move_commit_result(hub, &existing, None));
        }
        if slot.state != PeerMoveState::Prepared {
            return Err(conflict("The move was stopped before it was committed."));
        }
        let Some(project) = self.inner.store.project_get(slot.project_id).map_err(internal)? else {
            return Err(conflict("The project for this move is gone."));
        };
        let wanted = ForkProvider {
            kind: slot.wanted.kind,
            chosen: slot.wanted.chosen,
            model: slot.wanted.model.clone(),
            effort: slot.wanted.effort.clone(),
        };
        let (kind, model, effort) = self.fork_provider(&project, wanted, &hub.self_name()).await?;
        let repo = Repo::new(&project.path);
        if !git_transfer::has_commit(&repo, &slot.commit).await {
            return Err(conflict(format!("{} lost the move's commit.", hub.self_name())));
        }
        let path = self.fork_worktree(&project, &repo, thread_id, &slot.branch, &slot.commit).await?;
        git_transfer::forget(Some(&repo), &self.inner.paths.root, params.operation_id).await;
        let origin = Origin {
            machine_id: from.to_string(),
            machine_name: from_name.clone(),
            thread_id: Some(params.from_thread),
            operation_id: params.operation_id,
            kind: OriginKind::Move,
            permission_cap: slot.wanted.cap,
            hops: vec![from.to_string()],
        };
        let now = Utc::now();
        let thread = Thread {
            id: thread_id,
            project_id: project.id,
            title: params.title.clone().filter(|title| !title.trim().is_empty()).unwrap_or_else(|| params.from_title.clone()),
            provider: ProviderInstance::default_for(kind),
            model,
            effort,
            permission_mode: narrower(slot.wanted.permission_mode, origin.permission_cap),
            status: ThreadStatus::Idle,
            worktree: Some(WorktreeInfo { path: path.clone(), branch: slot.branch.clone() }),
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
            members: Vec::new(),
        };
        self.inner.store.thread_upsert(&thread).map_err(internal)?;
        let created = self.emit(thread.id, None, EventPayload::ThreadCreated { thread: thread.clone() }).map_err(internal)?;
        let mut thread = Thread { last_seq: created.seq, ..thread };
        self.inner.store.thread_upsert(&thread).map_err(internal)?;
        self.move_ensure_history(&thread, params, from, &from_name).map_err(internal)?;
        thread = self.inner.store.thread_get(thread.id).map_err(internal)?.unwrap_or(thread);
        slot.state = PeerMoveState::Committed;
        slot.thread_id = Some(thread.id);
        self.move_slot_save(operation, &slot)?;
        if let Err(error) = self.fork_send_note(thread.id, message_id, message).await {
            // The thread exists and the slot says so; a repeat of this call sends the note again.
            tracing::warn!(thread_id = %thread.id, error = %error.message, "a moved thread could not start");
            return Err(error);
        }
        let created = self.inner.store.thread_get(thread.id).map_err(internal)?.unwrap_or(thread);
        Ok(move_commit_result(hub, &created, Some(project.name)))
    }

    /// Append `HistoryImported` unless the thread has it.
    fn move_ensure_history(&self, thread: &Thread, params: &PeerMoveCommitParams, from: &str, from_name: &str) -> Result<()> {
        let events = self.inner.store.events_for_thread(thread.id)?;
        if events.iter().any(|event| matches!(event.payload, EventPayload::HistoryImported { .. })) {
            return Ok(());
        }
        self.emit(
            thread.id,
            None,
            EventPayload::HistoryImported {
                from_machine: from.to_string(),
                from_machine_name: from_name.to_string(),
                from_thread: params.from_thread,
                from_title: params.from_title.clone(),
                items: params.items.clone(),
                omitted: params.omitted,
            },
        )?;
        Ok(())
    }

    /// `peer.move.get` and `peer.move.abort`: where the move stands here; `abort` also drops a prepared slot.
    pub(super) async fn accept_move_status(&self, from: &str, params: PeerMoveRefParams, abort: bool) -> Result<PeerMoveStatus, RpcError> {
        let operation = namespaced_operation(from, Some(params.from_thread), params.operation_id);
        let Some(mut slot) = self.move_slot_live(operation) else {
            return Ok(PeerMoveStatus {
                state: PeerMoveState::Unknown,
                thread_id: None,
                machine_id: None,
                project_name: None,
                branch: None,
                provider: None,
            });
        };
        if slot.from != from {
            return Err(RpcError::new(codes::FORBIDDEN, "That move belongs to another machine."));
        }
        if abort && slot.state == PeerMoveState::Prepared {
            slot.state = PeerMoveState::Aborted;
            self.move_slot_save(operation, &slot)?;
            if let Ok(Some(project)) = self.inner.store.project_get(slot.project_id) {
                git_transfer::forget(Some(&Repo::new(&project.path)), &self.inner.paths.root, params.operation_id).await;
            }
        }
        let thread = slot.thread_id.and_then(|id| self.inner.store.thread_get(id).ok().flatten());
        Ok(PeerMoveStatus {
            state: slot.state,
            thread_id: slot.thread_id,
            machine_id: thread.as_ref().and(self.remote_hub().map(|hub| hub.self_id())),
            project_name: None,
            branch: Some(slot.branch),
            provider: thread.map(|thread| thread.provider.kind),
        })
    }
}

/// The history a move carries, newest items first dropped last.
struct History {
    items: Vec<HistoryItem>,
    omitted: u32,
    bytes: usize,
}

/// Keep the newest items that fit [`MAX_HISTORY_BYTES`] and count the rest.
fn fit_history(items: Vec<HistoryItem>) -> History {
    let mut kept: Vec<HistoryItem> = Vec::new();
    let mut bytes = 0usize;
    let total = items.len();
    for item in items.into_iter().rev() {
        let size = item.text.len() + item.tool.as_ref().map_or(0, String::len) + 96;
        if bytes + size > MAX_HISTORY_BYTES {
            break;
        }
        bytes += size;
        kept.push(item);
    }
    kept.reverse();
    History { omitted: (total - kept.len()) as u32, items: kept, bytes }
}

/// A tool call as one line: what it was and the one argument that says what it did. No output.
fn tool_summary(call: &ToolCall) -> String {
    let argument = ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"]
        .iter()
        .find_map(|key| call.input.get(*key).and_then(Value::as_str))
        .map(|value| value.lines().next().unwrap_or("").trim().to_string())
        .filter(|value| !value.is_empty());
    match argument {
        Some(argument) => clip(&format!("{}: {argument}", call.name), TOOL_TEXT_CAP),
        None => clip(&call.name, TOOL_TEXT_CAP),
    }
}

fn departed_result(thread: &Thread, info: &MoveInfo) -> Value {
    json!({
        "thread_id": info.peer_thread_id,
        "machine_id": info.peer,
        "branch": info.branch,
        "provider": thread.provider.kind,
    })
}

fn move_commit_result(hub: &Arc<dyn RemoteHub>, thread: &Thread, project_name: Option<String>) -> PeerMoveCommitResult {
    PeerMoveCommitResult {
        thread_id: thread.id,
        machine_id: hub.self_id(),
        project_name,
        branch: thread.worktree.as_ref().map(|worktree| worktree.branch.clone()).unwrap_or_default(),
        provider: thread.provider.kind,
    }
}

/// The continuing thread's first message: the note, the way back, and what the checkout holds.
fn move_message(params: &PeerMoveCommitParams, branch: &str, from_name: &str, from_id: &str) -> String {
    let mut text = params.handoff_note.trim().to_string();
    text.push_str("\n\n---\n");
    text.push_str(&format!("Continued from \"{}\" on {from_name}: {}\n", params.from_title, thread_link(from_id, params.from_thread)));
    text.push_str(&format!(
        "This checkout is on `{branch}`, a snapshot of that thread's work including its uncommitted changes. The earlier conversation is above, under \"Earlier on {from_name}\"; the original thread is now read-only and this one carries on from it."
    ));
    text
}

// ---- the AppState entry points the RPC dispatcher calls ----

/// `threads.move_to_machine`, and tell the clients about the item it queued.
pub(crate) async fn serve_move_to_machine(state: &AppState, params: Value) -> Result<ThreadsMoveToMachineResult, RpcError> {
    let result = state.orchestrator.move_to_machine(from_value(params)?).await?;
    state.network.notify_outbox(result.item.clone());
    Ok(result)
}

/// `outbox.enqueue` with a `move` operation: the same move, for a client that queues it that way.
pub(crate) async fn serve_move_enqueue(state: &AppState, params: OutboxEnqueueParams) -> Result<OutboxItem, RpcError> {
    let mut request: ThreadsMoveToMachineParams = serde_json::from_value(params.operation.payload).map_err(RpcError::invalid_params)?;
    request.machine = params.target;
    request.operation_id = params.operation.operation_id.or(request.operation_id);
    let result = state.orchestrator.move_to_machine(request).await?;
    state.network.notify_outbox(result.item.clone());
    Ok(result.item)
}
