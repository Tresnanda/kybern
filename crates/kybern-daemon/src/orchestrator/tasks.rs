//! User tasks: work items that can be sent to an agent.
//!
//! Task commands take the same command lock as notes, then a task lock of their
//! own. The run tracker, which runs inside `emit` (and so may already be under
//! the command lock), only ever takes the task lock, so the order is always
//! command then task. Every change is published on the tasks channel; each
//! connection that can read orchestration state forwards it as a
//! `tasks.items.changed` notification.
//!
//! A task's run is its agent thread. The tracker follows that thread's events:
//! turn start, tool calls, approvals, completion and failure move the run (and,
//! while the task is run-owned, the task) between Running and Needs review.

use std::sync::MutexGuard;
use std::time::Instant;

use anyhow::{Result, anyhow};
use kybern_protocol::methods::{
    Note, NoteId, TaskItem, TaskItemId, TaskItemSource, TaskItemsChangedNotification, TaskItemsCreateParams, TaskItemsFollowupParams,
    TaskItemsFollowupResult, TaskItemsGetParams, TaskItemsSendParams, TaskItemsSendResult, TaskItemsUpdateParams, TaskRunDiff, TaskRunNote,
    TaskRunState, TaskStatus,
};
use kybern_protocol::*;
use kybern_store::{NewTask, NoteTarget, TaskError, TaskPatch, TaskRunPatch, TaskStatusChange};
use tokio::sync::broadcast;
use uuid::Uuid;

use super::{Orchestrator, truncate_utf8};

/// Activity-only changes reach clients at most this often per run.
const ACTIVITY_BROADCAST_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);
/// What the provider's copy of one attached note or task may hold, and of all of
/// them together (notes and tasks share the budget).
const NOTE_MENTION_MAX_BYTES: usize = 16 * 1024;
const NOTE_MENTIONS_MAX_BYTES: usize = 48 * 1024;
/// Path prefix of a mention that points at a note.
pub(crate) const NOTE_MENTION_PREFIX: &str = "kybern://note/";
/// Path prefix of a mention that points at a task. Like a note mention, it is a
/// reference: the provider's copy carries the task, and it never changes the task.
pub(crate) const TASK_MENTION_PREFIX: &str = "kybern://task/";

fn invalid<T>(message: &str) -> Result<T> {
    Err(TaskError::Invalid(message.into()).into())
}

pub(super) type TaskLocks<'a> = (MutexGuard<'a, ()>, MutexGuard<'a, ()>);

impl Orchestrator {
    /// Changes to tasks, for forwarding to connected clients.
    pub fn subscribe_tasks(&self) -> broadcast::Receiver<TaskItemsChangedNotification> {
        self.inner.tasks_changed.subscribe()
    }

    pub(super) fn publish_task(&self, task: TaskItem) {
        // No receivers just means no client is connected.
        let _ = self.inner.tasks_changed.send(TaskItemsChangedNotification { task: Some(task), deleted_id: None });
    }

    pub(super) fn publish_task_deleted(&self, id: TaskItemId) {
        let _ = self.inner.tasks_changed.send(TaskItemsChangedNotification { task: None, deleted_id: Some(id) });
    }

    /// The command lock, then the task lock. Always in this order.
    pub(super) fn task_locks(&self) -> Result<TaskLocks<'_>> {
        let command = self.inner.commands.lock().map_err(|_| anyhow!("command lock poisoned"))?;
        let tasks = self.inner.task_writes.lock().map_err(|_| anyhow!("task lock poisoned"))?;
        Ok((command, tasks))
    }

    fn task_lock(&self) -> Result<MutexGuard<'_, ()>> {
        self.inner.task_writes.lock().map_err(|_| anyhow!("task lock poisoned"))
    }

    pub fn task_items_list(&self) -> Result<Vec<TaskItem>> {
        self.inner.store.task_items_list()
    }

    /// The task by `id` or by `key`; `None` when no live task matches.
    pub fn task_item_get(&self, params: TaskItemsGetParams) -> Result<Option<TaskItem>> {
        match (params.id, params.key) {
            (Some(id), None) => self.inner.store.task_item_get(id),
            (None, Some(key)) => self.inner.store.task_item_by_key(&key),
            _ => invalid("Pass either id or key."),
        }
    }

    pub fn task_item_create(&self, params: TaskItemsCreateParams) -> Result<TaskItem> {
        let _locks = self.task_locks()?;
        let store = &self.inner.store;
        // Check the source line before creating anything, so a stale line fails cleanly.
        if let Some(source) = &params.source {
            let note = live_note(store.note_get(source.note_id)?)?;
            if kybern_store::task_link_source_line(&note.body, &source.line_text, "KEY-0", Uuid::nil()).is_none() {
                return invalid("That checklist line is no longer in the note. Edit the note and try again.");
            }
        }
        let task = store.task_item_create(NewTask {
            scope: params.scope,
            project_id: params.project_id,
            title: params.title,
            body: params.body.unwrap_or_default(),
            status: params.status,
            priority: params.priority.unwrap_or(0),
            note_ids: params.note_ids.unwrap_or_default(),
            source_note_id: params.source.as_ref().map(|source| source.note_id),
            created_by_thread: None,
        })?;
        if let Some(source) = params.source {
            self.link_source_line(&task, &source);
        }
        self.publish_task(task.clone());
        Ok(task)
    }

    pub fn task_item_update(&self, params: TaskItemsUpdateParams) -> Result<TaskItem> {
        let _locks = self.task_locks()?;
        let before = self.inner.store.task_item_get(params.id)?;
        let task = self.inner.store.task_item_update(
            params.id,
            TaskPatch {
                title: params.title,
                body: params.body,
                expected_revision: params.expected_revision,
                status: params.status,
                priority: params.priority,
                scope: params.scope,
                project_id: params.project_id,
                note_ids: params.note_ids,
                pending_followup: params.pending_followup,
                before_id: params.before_id,
            },
        )?;
        if before.as_ref() != Some(&task) {
            if before.as_ref().is_some_and(|before| before.status != task.status) {
                self.sync_note_line(&task);
            }
            self.publish_task(task.clone());
        }
        Ok(task)
    }

    pub fn task_item_delete(&self, id: TaskItemId) -> Result<()> {
        let _locks = self.task_locks()?;
        self.inner.store.task_item_delete(id)?;
        self.publish_task_deleted(id);
        Ok(())
    }

    pub fn task_item_restore(&self, id: TaskItemId) -> Result<TaskItem> {
        let _locks = self.task_locks()?;
        let task = self.inner.store.task_item_restore(id)?;
        self.publish_task(task.clone());
        Ok(task)
    }

    /// Permanently remove tasks that have been deleted past the retention period.
    pub fn purge_expired_tasks(&self) -> Result<usize> {
        let _locks = self.task_locks()?;
        let purged = self.inner.store.tasks_purge_expired()?;
        for id in &purged {
            self.publish_task_deleted(*id);
        }
        Ok(purged.len())
    }

    // ---- sending ----

    /// Start an agent on the task: create the thread, record the run, mark the task
    /// running and deliver the prompt with the attached notes.
    pub async fn task_item_send(&self, params: TaskItemsSendParams) -> Result<TaskItemsSendResult> {
        let prompt = params.prompt.as_deref().map(str::trim).unwrap_or_default().to_owned();
        let composed = match (params.message, prompt.is_empty()) {
            (Some(_), false) => return invalid("Send either a prompt or a message, not both."),
            (Some(message), true) => Some(message),
            (None, false) => None,
            (None, true) => return invalid("Write a prompt before sending this task to an agent."),
        };
        let (task, project_id, message, run_notes) = {
            let _tasks = self.task_lock()?;
            let store = &self.inner.store;
            let task = store.task_item_get(params.id)?.ok_or(TaskError::NotFound("Task not found. It may have been deleted."))?;
            if task.runs.last().is_some_and(|run| run.state.is_live()) {
                return invalid("This task already has a run in progress. Open it or send a follow-up instead.");
            }
            let project_id = match (task.project_id, params.project_id) {
                (Some(project_id), _) | (None, Some(project_id)) => project_id,
                (None, None) => return invalid("Choose a project to run this task in."),
            };
            if is_free_chat_project(project_id) {
                return invalid("Choose a project to run this task in.");
            }
            store.project_get(project_id)?.ok_or(TaskError::NotFound("Project not found. Choose another project."))?;
            let mut run_notes = Vec::new();
            let mut seen = Vec::new();
            let parts = match composed {
                None => vec![ContentPart::Text { text: prompt }],
                Some(message) => {
                    let mut parts = message.parts;
                    // The saved follow-up is cleared below, so the daemon delivers the
                    // exact text it clears rather than trusting a client's copy.
                    append_pending_followup(&mut parts, task.pending_followup.as_deref());
                    // The task enters as a reference chip: the provider's copy expands it.
                    let reference = format!("{TASK_MENTION_PREFIX}{}", task.id);
                    if !parts.iter().any(|part| matches!(part, ContentPart::Mention { path, .. } if *path == reference)) {
                        parts.insert(0, task_mention(&task));
                    }
                    // Notes the message already mentions are sent with the run too.
                    for part in &parts {
                        let ContentPart::Mention { path, .. } = part else { continue };
                        let Some(note_id) = path.strip_prefix(NOTE_MENTION_PREFIX).and_then(|id| id.parse::<NoteId>().ok()) else {
                            continue;
                        };
                        if seen.contains(&note_id) {
                            continue;
                        }
                        seen.push(note_id);
                        if let Some(note) = store.note_get(note_id)?.filter(|note| note.summary.deleted_at.is_none()) {
                            run_notes.push(TaskRunNote { note_id, revision: note.summary.revision });
                        }
                    }
                    parts
                }
            };
            let mut parts = parts;
            for note_id in params.note_ids.unwrap_or_default() {
                if seen.contains(&note_id) {
                    continue;
                }
                seen.push(note_id);
                let note = live_note(store.note_get(note_id)?)?;
                let title = if note.summary.title.trim().is_empty() { "Untitled note".to_owned() } else { note.summary.title.clone() };
                parts.push(ContentPart::Mention {
                    name: title.clone(),
                    path: format!("{NOTE_MENTION_PREFIX}{note_id}"),
                    display_name: Some(title),
                });
                run_notes.push(TaskRunNote { note_id, revision: note.summary.revision });
            }
            (task, project_id, UserMessage { parts }, run_notes)
        };

        // The title is the task's, so the thread keeps it: AI titling is skipped for task runs.
        let thread = self
            .create_thread_with_id(
                methods::ThreadsCreateParams {
                    project_id: Some(project_id),
                    provider: params.provider,
                    model: params.model,
                    effort: params.effort,
                    permission_mode: params.permission_mode,
                    use_worktree: params.use_worktree,
                    base_branch: params.base_branch,
                    title: Some(task.title.clone()),
                    message: None,
                },
                Uuid::now_v7(),
            )
            .await?;

        // Record the run before the first turn starts so no event of it is missed.
        let previous_status = task.status;
        let started = (|| -> Result<TaskItem> {
            let _locks = self.task_locks()?;
            let store = &self.inner.store;
            store.task_run_start(task.id, thread.id, &thread.provider, thread.model.as_deref(), &run_notes)?;
            // The saved follow-up is part of this prompt now. Text saved since the
            // task was read (while the thread was being made) is not, so it stays.
            let current = store.task_item_get(task.id)?.ok_or(TaskError::NotFound("Task not found. It may have been deleted."))?;
            let remaining = match (current.pending_followup.as_deref(), task.pending_followup.as_deref()) {
                (Some(now), Some(consumed)) => now.strip_prefix(consumed).unwrap_or(now).trim().to_owned(),
                (Some(now), None) => now.to_owned(),
                (None, _) => String::new(),
            };
            let started = store.task_item_update(task.id, TaskPatch { pending_followup: Some(remaining), ..Default::default() })?;
            self.track_task_thread(thread.id);
            if previous_status == TaskStatus::Done {
                self.sync_note_line(&started);
            }
            self.publish_task(started.clone());
            Ok(started)
        })();
        let started = match started {
            Ok(started) => started,
            Err(error) => {
                let _ = self.archive_thread(thread.id).await;
                return Err(error);
            }
        };

        if let Err(error) = self.send(thread.id, message).await {
            self.rollback_task_run(&started, thread.id, previous_status);
            let _ = self.archive_thread(thread.id).await;
            return Err(error);
        }
        let task = self.inner.store.task_item_get(task.id)?.unwrap_or(started);
        Ok(TaskItemsSendResult { task, thread_id: thread.id })
    }

    /// Undo a run whose first message never went out.
    fn rollback_task_run(&self, task: &TaskItem, thread_id: ThreadId, previous_status: TaskStatus) {
        let Ok(_locks) = self.task_locks() else { return };
        let store = &self.inner.store;
        if let Err(error) = store.task_run_delete(thread_id) {
            tracing::warn!(%error, task = %task.key, "could not remove a task run that never started");
        }
        self.inner.task_threads.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&thread_id);
        let restored = self.set_task_status_system(task.id, previous_status, None);
        match restored {
            Ok(Some(restored)) => self.publish_task(restored),
            Ok(None) => {
                if let Ok(Some(current)) = store.task_item_get(task.id) {
                    self.publish_task(current);
                }
            }
            Err(error) => tracing::warn!(%error, task = %task.key, "could not restore a task's status after a failed send"),
        }
    }

    /// Send text to the task's agent: into the latest run's thread now when it is idle,
    /// queued when it is busy, or saved for the next run when there is no run to receive it.
    pub async fn task_item_followup(&self, params: TaskItemsFollowupParams) -> Result<TaskItemsFollowupResult> {
        let text = params.text.trim().to_owned();
        if text.is_empty() {
            return invalid("Write a follow-up first.");
        }
        enum Route {
            Saved(Box<TaskItem>),
            Queue(ThreadId),
            Send(ThreadId),
        }
        let route = {
            let _locks = self.task_locks()?;
            let store = &self.inner.store;
            let task = store.task_item_get(params.id)?.ok_or(TaskError::NotFound("Task not found. It may have been deleted."))?;
            let thread = match task.runs.last() {
                Some(run) => store.thread_get(run.thread_id)?.filter(|thread| thread.status != ThreadStatus::Archived),
                None => None,
            };
            match thread {
                None => {
                    // Saved text stays one block per follow-up, a blank line apart.
                    let combined = match task.pending_followup.as_deref().map(str::trim) {
                        Some(existing) if !existing.is_empty() => format!("{existing}\n\n{text}"),
                        _ => text.clone(),
                    };
                    let saved = store
                        .task_item_update(task.id, TaskPatch { pending_followup: Some(combined), ..Default::default() })
                        .map_err(|error| match error.downcast_ref::<TaskError>() {
                            Some(TaskError::Invalid(_)) => anyhow!("This follow-up is too long to save. Shorten it and try again."),
                            _ => error,
                        })?;
                    self.publish_task(saved.clone());
                    Route::Saved(Box::new(saved))
                }
                Some(thread) if matches!(thread.status, ThreadStatus::Running | ThreadStatus::AwaitingApproval) => Route::Queue(thread.id),
                Some(thread) => Route::Send(thread.id),
            }
        };
        match route {
            Route::Saved(task) => Ok(TaskItemsFollowupResult { task: *task, sent_to: None }),
            Route::Queue(thread_id) => {
                self.enqueue(methods::QueuedMessage { id: Uuid::now_v7(), thread_id, message: UserMessage::text(text) })?;
                self.task_with_sent_to(params.id, thread_id)
            }
            Route::Send(thread_id) => {
                self.send(thread_id, UserMessage::text(text)).await?;
                self.task_with_sent_to(params.id, thread_id)
            }
        }
    }

    fn task_with_sent_to(&self, id: TaskItemId, thread_id: ThreadId) -> Result<TaskItemsFollowupResult> {
        let task = self.inner.store.task_item_get(id)?.ok_or(TaskError::NotFound("Task not found. It may have been deleted."))?;
        Ok(TaskItemsFollowupResult { task, sent_to: Some(thread_id) })
    }

    // ---- run tracking ----

    pub(crate) fn track_task_thread(&self, thread_id: ThreadId) {
        self.inner.task_threads.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).insert(thread_id);
    }

    /// The task lock, taken before an event of a task run's thread is stored, or
    /// `None` for threads and events the tracker ignores. Holding it from the
    /// append to [`Self::apply_task_run_event`] applies a thread's events to its
    /// task in the order they were stored, and keeps readers that take the lock
    /// from seeing an event stored but not yet applied. The lock is innermost
    /// (command, then task), so this is safe under the command lock.
    pub(super) fn task_event_guard(&self, thread_id: ThreadId, payload: &EventPayload) -> Option<MutexGuard<'_, ()>> {
        if !matches!(
            payload,
            EventPayload::TurnStarted { .. }
                | EventPayload::ToolCallStarted { .. }
                | EventPayload::ApprovalRequested { .. }
                | EventPayload::UserInputRequested { .. }
                | EventPayload::ThreadUpdated { .. }
                | EventPayload::TurnCompleted { .. }
                | EventPayload::TurnFailed { .. }
                | EventPayload::CheckpointUpdated { .. }
        ) {
            return None;
        }
        if !self.inner.task_threads.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).contains(&thread_id) {
            return None;
        }
        Some(self.inner.task_writes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()))
    }

    /// Follow a stored event of a task run's thread. The caller holds the task lock
    /// ([`Self::task_event_guard`]); a failure is logged, never returned, so it cannot break the thread.
    pub(super) fn track_task_run(&self, event: &ThreadEvent) {
        if let Err(error) = self.apply_task_run_event(event) {
            tracing::warn!(thread_id = %event.thread_id, %error, "could not update the task run for this thread");
        }
    }

    fn apply_task_run_event(&self, event: &ThreadEvent) -> Result<()> {
        let store = &self.inner.store;
        let thread_id = event.thread_id;
        if store.task_run_for_thread(thread_id)?.is_none() {
            return Ok(());
        }
        let live = [TaskRunState::Running, TaskRunState::Waiting];
        let mut activity_only = false;
        let mut settle_status = false;
        let patch = match &event.payload {
            EventPayload::TurnStarted { .. } => {
                // A new turn reopens the run, even one that had finished (a follow-up).
                settle_status = true;
                TaskRunPatch { state: Some(TaskRunState::Running), activity: Some(None), ended_at: Some(None), ..Default::default() }
            }
            EventPayload::ToolCallStarted { call, .. } => {
                activity_only = true;
                let cwd = store.thread_get(thread_id)?.map(|thread| thread.cwd).unwrap_or_default();
                TaskRunPatch {
                    activity: Some(Some(tool_activity(call, &cwd))),
                    only_from: Some(vec![TaskRunState::Running]),
                    ..Default::default()
                }
            }
            EventPayload::ApprovalRequested { .. } => TaskRunPatch {
                state: Some(TaskRunState::Waiting),
                activity: Some(Some("Waiting for approval".into())),
                only_from: Some(live.to_vec()),
                ..Default::default()
            },
            EventPayload::UserInputRequested { .. } => TaskRunPatch {
                state: Some(TaskRunState::Waiting),
                activity: Some(Some("Waiting for your answer".into())),
                only_from: Some(live.to_vec()),
                ..Default::default()
            },
            // Approvals resolved: the thread is running again.
            EventPayload::ThreadUpdated { thread } if thread.status == ThreadStatus::Running => TaskRunPatch {
                state: Some(TaskRunState::Running),
                activity: Some(None),
                only_from: Some(vec![TaskRunState::Waiting]),
                ..Default::default()
            },
            EventPayload::ThreadUpdated { .. } => return Ok(()),
            EventPayload::TurnCompleted { stop_reason, .. } => {
                settle_status = true;
                TaskRunPatch {
                    state: Some(match stop_reason {
                        StopReason::Interrupted => TaskRunState::Interrupted,
                        StopReason::Error => TaskRunState::Failed,
                        StopReason::Completed | StopReason::MaxTurns => TaskRunState::Completed,
                    }),
                    activity: Some(None),
                    ended_at: Some(Some(event.at)),
                    ..Default::default()
                }
            }
            EventPayload::TurnFailed { .. } => {
                settle_status = true;
                TaskRunPatch {
                    state: Some(TaskRunState::Failed),
                    activity: Some(None),
                    ended_at: Some(Some(event.at)),
                    ..Default::default()
                }
            }
            EventPayload::CheckpointUpdated { checkpoint } => {
                if let Some(after) = checkpoint.after.clone() {
                    self.spawn_run_diff(thread_id, after);
                }
                return Ok(());
            }
            _ => return Ok(()),
        };

        let ending = matches!(event.payload, EventPayload::TurnCompleted { .. } | EventPayload::TurnFailed { .. });
        // The run and its task change in one transaction: a new turn reopens both
        // (whatever the status was, even Done), and the end of a turn moves a task
        // still owned by the run to Needs review, leaving one the user moved alone.
        let status = settle_status.then(|| {
            if ending {
                TaskStatusChange { status: TaskStatus::NeedsReview, only_from: Some(vec![TaskStatus::Running]) }
            } else {
                TaskStatusChange { status: TaskStatus::Running, only_from: None }
            }
        });
        let Some(update) = store.task_run_update(thread_id, patch, status)? else { return Ok(()) };
        if update.status_changed {
            self.sync_note_line(&update.task);
        }
        let task = update.task;
        let now = Instant::now();
        let mut published = self.inner.task_published.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if activity_only && published.get(&thread_id).is_some_and(|at| now.duration_since(*at) < ACTIVITY_BROADCAST_INTERVAL) {
            return Ok(());
        }
        if ending {
            published.remove(&thread_id);
        } else {
            published.insert(thread_id, now);
        }
        drop(published);
        self.publish_task(task);
        Ok(())
    }

    /// Change a task's status without the user-status limits, keeping its source
    /// note's checklist line in step. Returns the task when the status changed.
    pub(super) fn set_task_status_system(
        &self,
        id: TaskItemId,
        status: TaskStatus,
        only_from: Option<&[TaskStatus]>,
    ) -> Result<Option<TaskItem>> {
        let changed = self.inner.store.task_item_set_status(id, status, only_from)?;
        if let Some(task) = &changed {
            self.sync_note_line(task);
        }
        Ok(changed)
    }

    /// Work out how many lines the run changed (first checkpoint to this one) and
    /// store it on the run. Runs in the background: it shells out to git.
    fn spawn_run_diff(&self, thread_id: ThreadId, after: String) {
        let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
        let this = self.clone();
        handle.spawn(async move {
            let stats = match this.run_diff_stats(thread_id, &after).await {
                Ok(Some(stats)) => stats,
                Ok(None) => return,
                Err(error) => {
                    tracing::debug!(%thread_id, %error, "could not measure a task run's diff");
                    return;
                }
            };
            let Ok(_tasks) = this.task_lock() else { return };
            let patch = TaskRunPatch { diff: Some(Some(stats)), ..Default::default() };
            match this.inner.store.task_run_patch(thread_id, patch) {
                Ok(Some(changed)) => {
                    if let Ok(Some(task)) = this.inner.store.task_item_get(changed.id) {
                        this.publish_task(task);
                    }
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(%thread_id, %error, "could not store a task run's diff"),
            }
        });
    }

    /// Lines added and removed from the thread's first checkpoint to `after`.
    async fn run_diff_stats(&self, thread_id: ThreadId, after: &str) -> Result<Option<TaskRunDiff>> {
        let Some(thread) = self.inner.store.thread_get(thread_id)? else { return Ok(None) };
        let Some(first) = self.inner.store.checkpoints_for_thread(thread_id)?.into_iter().next() else { return Ok(None) };
        let diff = kybern_git::Repo::new(&thread.cwd).diff_with_options(&first.before, after, false, None).await?;
        Ok(Some(TaskRunDiff {
            added: diff.files.iter().map(|file| file.additions).sum(),
            removed: diff.files.iter().map(|file| file.deletions).sum(),
            files: diff.files.len() as u32,
        }))
    }

    // ---- note sync ----

    /// End the source checklist line with the task's link.
    fn link_source_line(&self, task: &TaskItem, source: &TaskItemSource) {
        self.edit_note_body(source.note_id, |body| kybern_store::task_link_source_line(body, &source.line_text, &task.key, task.id));
    }

    /// Tick or untick the source note's checklist line to match the task being done.
    pub(super) fn sync_note_line(&self, task: &TaskItem) {
        let Some(note_id) = task.source_note_id else { return };
        let checked = task.status == TaskStatus::Done;
        self.edit_note_body(note_id, |body| kybern_store::task_set_line_checked(body, task.id, checked));
    }

    /// Rewrite a live note's body with `edit` (which returns `None` for no change)
    /// and publish it. Retries once when another save lands in between.
    fn edit_note_body(&self, note_id: NoteId, edit: impl Fn(&str) -> Option<String>) {
        for attempt in 0..2 {
            let note = match self.inner.store.note_get(note_id) {
                Ok(Some(note)) if note.summary.deleted_at.is_none() => note,
                _ => return,
            };
            let Some(body) = edit(&note.body) else { return };
            match self.inner.store.note_update(NoteTarget::Id(note_id), note.summary.revision, None, Some(&body)) {
                Ok(saved) => return self.publish_note(saved.summary),
                Err(error)
                    if attempt == 0
                        && matches!(error.downcast_ref::<kybern_store::NoteError>(), Some(kybern_store::NoteError::Conflict)) => {}
                Err(error) => {
                    tracing::warn!(%note_id, %error, "could not update a note's task line");
                    return;
                }
            }
        }
    }

    /// A note was saved: tasks whose linked checklist line was ticked or unticked
    /// follow it (done, or back to to do). Called under the command lock.
    pub(super) fn sync_tasks_from_note(&self, previous_body: &str, note: &Note) {
        let before = kybern_store::task_link_lines(previous_body);
        let after = kybern_store::task_link_lines(&note.body);
        if before == after {
            return;
        }
        let Ok(_tasks) = self.task_lock() else { return };
        let mut handled = Vec::new();
        for (task_id, checked) in &after {
            if handled.contains(task_id) {
                continue;
            }
            handled.push(*task_id);
            // Only a line that was already linked and changed state counts.
            let Some((_, was_checked)) = before.iter().find(|(id, _)| id == task_id) else { continue };
            if was_checked == checked {
                continue;
            }
            let Ok(Some(task)) = self.inner.store.task_item_get(*task_id) else { continue };
            // Compare with the task first so syncing back never ping-pongs.
            let target = match (*checked, task.status == TaskStatus::Done) {
                (true, false) => TaskStatus::Done,
                (false, true) => TaskStatus::Todo,
                _ => continue,
            };
            match self.inner.store.task_item_update(task.id, TaskPatch { status: Some(target), ..Default::default() }) {
                Ok(updated) => {
                    self.sync_note_line(&updated);
                    self.publish_task(updated);
                }
                Err(error) => tracing::warn!(task = %task.key, %error, "could not update a task from its note line"),
            }
        }
    }

    // ---- note and task mentions ----

    /// The provider's copy of a message whose `kybern://note/<id>` and
    /// `kybern://task/<id>` mentions became the note or task text, or `None` when it
    /// has none. Each is capped at 16 KiB and all of them together at 48 KiB; a
    /// deleted or missing note becomes "Note unavailable", a task "Task not found".
    /// The stored message keeps the mention chips.
    pub(super) fn expand_item_mentions(&self, message: &UserMessage) -> Option<UserMessage> {
        let is_item = |part: &ContentPart| matches!(part, ContentPart::Mention { path, .. } if path.starts_with(NOTE_MENTION_PREFIX) || path.starts_with(TASK_MENTION_PREFIX));
        if !message.parts.iter().any(is_item) {
            return None;
        }
        let mut remaining = NOTE_MENTIONS_MAX_BYTES;
        let parts = message
            .parts
            .iter()
            .map(|part| match part {
                ContentPart::Mention { path, .. } if path.starts_with(NOTE_MENTION_PREFIX) => {
                    let note = path[NOTE_MENTION_PREFIX.len()..]
                        .parse::<NoteId>()
                        .ok()
                        .and_then(|id| self.inner.store.note_get(id).ok().flatten());
                    ContentPart::Text { text: note_block(note.as_ref(), &mut remaining) }
                }
                ContentPart::Mention { path, .. } if path.starts_with(TASK_MENTION_PREFIX) => {
                    let task = path[TASK_MENTION_PREFIX.len()..]
                        .parse::<TaskItemId>()
                        .ok()
                        .and_then(|id| self.inner.store.task_item_get(id).ok().flatten());
                    ContentPart::Text { text: self.task_block(task.as_ref(), &mut remaining) }
                }
                other => other.clone(),
            })
            .collect();
        Some(UserMessage { parts })
    }

    /// One task as prompt text, spending from the shared `remaining` byte budget.
    /// Facts come first so a long description is what gets cut.
    fn task_block(&self, task: Option<&TaskItem>, remaining: &mut usize) -> String {
        let Some(task) = task else { return "Task not found".into() };
        let store = &self.inner.store;
        let mut text = format!(
            "Task {}: {}\nStatus: {}\nPriority: {}\n",
            task.key,
            task.title,
            status_label(task.status),
            priority_label(task.priority)
        );
        if let Some(project) = task.project_id.and_then(|id| store.project_get(id).ok().flatten()) {
            text.push_str(&format!("Project: {}\n", project.name));
        }
        if !task.note_ids.is_empty() {
            let notes = task
                .note_ids
                .iter()
                .map(|id| match store.note_get(*id).ok().flatten().filter(|note| note.summary.deleted_at.is_none()) {
                    Some(note) => {
                        let title = if note.summary.title.trim().is_empty() { "Untitled note" } else { note.summary.title.trim() };
                        format!("{title} ({NOTE_MENTION_PREFIX}{id})")
                    }
                    None => format!("Note unavailable ({id})"),
                })
                .collect::<Vec<_>>();
            text.push_str(&format!("Linked notes: {}\n", notes.join("; ")));
        }
        if let Some(run) = task.runs.last() {
            text.push_str(&format!("Latest run: thread {} ({}). Read it with kybern_thread_read.\n", run.thread_id, run.state.as_str()));
        }
        text.push_str(&format!("Link: {TASK_MENTION_PREFIX}{}\n", task.id));
        if !task.body.trim().is_empty() {
            text.push_str("\nDescription:\n");
            text.push_str(task.body.trim_end());
        }
        let allowed = NOTE_MENTION_MAX_BYTES.min(*remaining);
        let truncated = text.len() > allowed;
        truncate_utf8(&mut text, allowed);
        *remaining -= text.len();
        if truncated {
            text.push_str("\n[truncated]");
        }
        text
    }
}

/// A `kybern://task/<id>` mention chip for the task.
pub(crate) fn task_mention(task: &TaskItem) -> ContentPart {
    ContentPart::Mention {
        name: task.key.clone(),
        path: format!("{TASK_MENTION_PREFIX}{}", task.id),
        display_name: Some(format!("{} {}", task.key, task.title)),
    }
}

/// Add the task's saved follow-up to the end of a first message, a blank line
/// after its text. A message whose text already ends with it is left alone.
fn append_pending_followup(parts: &mut Vec<ContentPart>, pending: Option<&str>) {
    let Some(pending) = pending.map(str::trim).filter(|text| !text.is_empty()) else { return };
    match parts.last_mut() {
        Some(ContentPart::Text { text }) => {
            let existing = text.trim_end();
            if existing.ends_with(pending) {
                return;
            }
            *text = if existing.is_empty() { pending.to_owned() } else { format!("{existing}\n\n{pending}") };
        }
        Some(_) => parts.push(ContentPart::Text { text: format!("\n\n{pending}") }),
        None => parts.push(ContentPart::Text { text: pending.to_owned() }),
    }
}

pub(crate) fn status_label(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Inbox => "Inbox",
        TaskStatus::Todo => "To do",
        TaskStatus::Running => "Running",
        TaskStatus::NeedsReview => "Needs review",
        TaskStatus::Done => "Done",
        TaskStatus::Canceled => "Canceled",
    }
}

pub(crate) fn priority_label(priority: u8) -> &'static str {
    match priority {
        1 => "Urgent",
        2 => "High",
        3 => "Medium",
        4 => "Low",
        _ => "No priority",
    }
}

fn live_note(note: Option<Note>) -> Result<Note> {
    match note {
        None => Err(TaskError::NotFound("A note was not found. Remove it and try again.").into()),
        Some(note) if note.summary.deleted_at.is_some() => invalid("A note is in Recently deleted. Restore it or remove it from the task."),
        Some(note) => Ok(note),
    }
}

/// One note as prompt text, spending from the shared `remaining` byte budget.
fn note_block(note: Option<&Note>, remaining: &mut usize) -> String {
    let Some(note) = note.filter(|note| note.summary.deleted_at.is_none()) else { return "Note unavailable".into() };
    let title = if note.summary.title.trim().is_empty() { "Untitled note" } else { note.summary.title.trim() };
    let mut body = note.body.clone();
    let allowed = NOTE_MENTION_MAX_BYTES.min(*remaining);
    let truncated = body.len() > allowed;
    truncate_utf8(&mut body, allowed);
    *remaining -= body.len();
    let mut text = format!("Note: {title}\n\n{body}");
    if truncated {
        text.push_str("\n[truncated]");
    }
    text
}

// ---- tool activity ----

const NESTED_INPUT_KEYS: [&str; 10] = ["raw", "raw_input", "rawInput", "input", "arguments", "args", "params", "item", "data", "call"];

/// The first of `keys` found as a string (or list of strings) in the tool input or
/// anything it wraps. Providers differ mostly in how deeply they nest the original input.
fn input_string(input: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let mut queue = std::collections::VecDeque::from([(input.clone(), 0)]);
    while let Some((value, depth)) = queue.pop_front() {
        let Some(record) = value.as_object() else { continue };
        for key in keys {
            match record.get(*key) {
                Some(serde_json::Value::String(text)) => {
                    if let Some(line) = text.lines().map(str::trim).find(|line| !line.is_empty()) {
                        return Some(line.to_owned());
                    }
                }
                Some(serde_json::Value::Array(parts)) if !parts.is_empty() && parts.iter().all(|part| part.is_string()) => {
                    let joined = parts.iter().filter_map(|part| part.as_str()).collect::<Vec<_>>().join(" ");
                    if !joined.trim().is_empty() {
                        return Some(joined.trim().to_owned());
                    }
                }
                _ => {}
            }
        }
        if depth < 3 {
            for key in NESTED_INPUT_KEYS {
                match record.get(key) {
                    Some(nested) if nested.is_object() => queue.push_back((nested.clone(), depth + 1)),
                    // Some providers wrap the input as a JSON string.
                    Some(serde_json::Value::String(text)) if text.trim_start().starts_with('{') => {
                        if let Ok(nested) = serde_json::from_str::<serde_json::Value>(text) {
                            queue.push_back((nested, depth + 1));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    None
}

/// A path as the run's workspace sees it: relative to its working directory, and
/// short enough for one line (the tail is kept).
fn short_path(path: &str, cwd: &str) -> String {
    let relative = std::path::Path::new(path)
        .strip_prefix(cwd)
        .ok()
        .and_then(|relative| relative.to_str())
        .filter(|relative| !relative.is_empty())
        .unwrap_or(path);
    shorten(relative, 72, true)
}

fn shorten(text: &str, max_chars: usize, keep_tail: bool) -> String {
    let count = text.chars().count();
    if count <= max_chars {
        return text.to_owned();
    }
    if keep_tail {
        format!("…{}", text.chars().skip(count - (max_chars - 1)).collect::<String>())
    } else {
        format!("{}…", text.chars().take(max_chars - 1).collect::<String>())
    }
}

/// A short present-tense summary of a tool call, such as "Editing src/main.rs",
/// "Running cargo test" or "Reading README.md". Mirrors the desktop's tool rows.
pub(crate) fn tool_activity(call: &ToolCall, cwd: &str) -> String {
    let normalized: String = call.name.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_lowercase()).collect();
    let shown = call.name.rsplit("__").next().filter(|name| !name.is_empty()).unwrap_or(&call.name);
    let path = || input_string(&call.input, &["file_path", "filePath", "path", "file", "filename", "target_file", "notebook_path"]);
    let named = |verb: &str, noun: &str| match path() {
        Some(path) => format!("{verb} {}", short_path(&path, cwd)),
        None => format!("{verb} {noun}"),
    };
    match normalized.as_str() {
        "bash" | "shell" | "execute" | "exec" | "run" | "command" | "commandexecution" => {
            match input_string(&call.input, &["command", "cmd"]) {
                Some(command) => format!("Running {}", shorten(&command, 60, false)),
                None => "Running a command".into(),
            }
        }
        "read" | "readfile" | "viewfile" | "openfile" => named("Reading", "files"),
        "write" | "writefile" | "createfile" => named("Writing", "a file"),
        "edit" | "editfile" | "multiedit" | "applypatch" | "strreplaceeditor" | "patch" | "filechange" => named("Editing", "files"),
        "grep" | "glob" | "search" | "ripgrep" | "find" | "findfiles" => match input_string(&call.input, &["pattern", "query", "regex"]) {
            Some(pattern) => format!("Searching {}", shorten(&pattern, 48, false)),
            None => "Searching the project".into(),
        },
        "list" | "listfiles" | "ls" => named("Listing", "files"),
        "webfetch" | "fetch" | "urlfetch" | "httpfetch" => match input_string(&call.input, &["url"]) {
            Some(url) => format!("Fetching {}", shorten(&url, 60, false)),
            None => "Fetching a page".into(),
        },
        "websearch" | "searchweb" | "webrun" => "Searching the web".into(),
        "task" | "agent" | "subagent" | "delegate" | "spawnagent" | "sendmessagetoagent" | "followuptask" | "waitagent" | "listagents" => {
            "Working with a subagent".into()
        }
        "todowrite" | "todo" | "plan" | "updateplan" => "Updating the plan".into(),
        "imageview" | "viewimage" | "imagegeneration" | "generateimage" | "imagegen" => "Working with an image".into(),
        _ => format!("Using {}", shorten(shown, 40, false)),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    use chrono::Utc;
    use kybern_drivers::registry::DriverRegistry;
    use kybern_protocol::methods::{NoteScope, NotesCreateParams, NotesUpdateParams, TaskItemsChangedNotification, TaskScope};
    use kybern_store::Store;
    use serde_json::json;

    use super::*;
    use crate::config::Paths;
    use crate::settings::SettingsStore;

    struct Fixture {
        root: PathBuf,
        store: Store,
        orchestrator: Orchestrator,
        project: Project,
        changes: broadcast::Receiver<TaskItemsChangedNotification>,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("kybern-tasks-test-{}", Uuid::now_v7()));
            let workspace = root.join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();
            let paths = Paths::resolve(Some(root.join("data"))).unwrap();
            let settings = SettingsStore::load(&paths.settings).unwrap();
            let store = Store::open_in_memory().unwrap();
            let (events_tx, _) = crate::bounded_broadcast::channel(64, 8 * 1024 * 1024);
            let orchestrator = Orchestrator::new(store.clone(), DriverRegistry::default(), events_tx, paths, settings);
            let project = orchestrator.add_project(workspace.to_string_lossy().into_owned(), Some("ade".into())).unwrap();
            let changes = orchestrator.subscribe_tasks();
            Self { root, store, orchestrator, project, changes }
        }

        fn task(&self, title: &str) -> TaskItem {
            self.orchestrator
                .task_item_create(TaskItemsCreateParams {
                    scope: TaskScope::Project,
                    project_id: Some(self.project.id),
                    title: title.into(),
                    body: None,
                    status: Some(TaskStatus::Todo),
                    priority: None,
                    note_ids: None,
                    source: None,
                })
                .unwrap()
        }

        fn note(&self, title: &str, body: &str) -> Note {
            self.orchestrator
                .note_create(NotesCreateParams {
                    scope: NoteScope::Project,
                    project_id: Some(self.project.id),
                    title: Some(title.into()),
                    body: Some(body.into()),
                })
                .unwrap()
        }

        fn send_params(&self, task: &TaskItem, note_ids: Vec<NoteId>) -> TaskItemsSendParams {
            TaskItemsSendParams {
                id: task.id,
                provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
                model: None,
                effort: None,
                permission_mode: None,
                use_worktree: Some(false),
                base_branch: None,
                project_id: None,
                prompt: Some(format!("{}\n\nDo it.", task.title)),
                message: None,
                note_ids: Some(note_ids),
            }
        }

        /// A run whose thread exists but whose agent never starts, so events are driven by hand.
        fn manual_run(&self, task: &TaskItem) -> Thread {
            let now = Utc::now();
            let thread = Thread {
                id: Uuid::now_v7(),
                project_id: self.project.id,
                title: task.title.clone(),
                provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
                model: Some("opus".into()),
                effort: None,
                permission_mode: PermissionMode::Supervised,
                status: ThreadStatus::Running,
                worktree: None,
                cwd: self.project.path.clone(),
                provider_session_id: None,
                pinned: false,
                created_at: now,
                updated_at: now,
                last_seq: 0,
                parent_thread_id: None,
                coordinator_project_id: None,
                collaboration_group_id: None,
            };
            self.store.thread_upsert(&thread).unwrap();
            self.store.task_run_start(task.id, thread.id, &thread.provider, thread.model.as_deref(), &[]).unwrap();
            self.orchestrator.track_task_thread(thread.id);
            thread
        }

        fn emit(&self, thread: &Thread, payload: EventPayload) {
            self.orchestrator.emit(thread.id, Some(Uuid::nil()), payload).unwrap();
        }

        fn current(&self, task: &TaskItem) -> TaskItem {
            self.store.task_item_get(task.id).unwrap().unwrap()
        }

        fn drain(&mut self) -> Vec<TaskItemsChangedNotification> {
            let mut out = Vec::new();
            while let Ok(change) = self.changes.try_recv() {
                out.push(change);
            }
            out
        }

        async fn wait_for(&self, task: &TaskItem, done: impl Fn(&TaskItem) -> bool) -> TaskItem {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let current = self.current(task);
                    if done(&current) {
                        return current;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("the task reached the expected state")
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn turn_started() -> EventPayload {
        EventPayload::TurnStarted { message_id: Uuid::now_v7(), message: UserMessage::text("go") }
    }

    fn turn_completed(stop_reason: StopReason) -> EventPayload {
        EventPayload::TurnCompleted { stop_reason, usage: Usage::default(), cost_usd: None, duration_ms: 1, terminal_message_id: None }
    }

    fn tool(name: &str, input: serde_json::Value) -> EventPayload {
        EventPayload::ToolCallStarted {
            call: ToolCall { id: Uuid::now_v7().to_string(), name: name.into(), input, parent_id: None },
            origin: EventOrigin::Root,
        }
    }

    fn approval(thread: &Thread) -> ApprovalRequest {
        ApprovalRequest {
            id: Uuid::now_v7(),
            thread_id: thread.id,
            turn_id: Uuid::nil(),
            tool_call_id: None,
            tool_name: "Bash".into(),
            input: json!({ "command": "ls" }),
            summary: "bash: ls".into(),
            suggestions: Vec::new(),
            created_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn send_creates_the_thread_records_the_run_and_expands_notes_for_the_provider_only() {
        let fixture = Fixture::new();
        let note = fixture.note("Spec", "- [ ] one\n");
        let task = fixture.task("Fix login");
        let result = fixture.orchestrator.task_item_send(fixture.send_params(&task, vec![note.summary.id, note.summary.id])).await.unwrap();

        let thread = fixture.store.thread_get(result.thread_id).unwrap().unwrap();
        assert_eq!((thread.title.as_str(), thread.project_id), ("Fix login", fixture.project.id), "the task's title, no AI titling");
        let run = &result.task.runs[0];
        assert_eq!((run.number, run.thread_id, run.provider.kind), (1, thread.id, ProviderKind::ClaudeCode));
        assert_eq!(run.notes, vec![TaskRunNote { note_id: note.summary.id, revision: 1 }], "each note once, at its revision");
        assert_eq!(result.task.pending_followup, None);
        assert!(matches!(result.task.status, TaskStatus::Running | TaskStatus::NeedsReview));

        // The stored message keeps the chip; the transcript sees a Mention with the note id and title.
        let events = fixture.store.events_for_thread(thread.id).unwrap();
        let sent = events
            .iter()
            .find_map(|event| match &event.payload {
                EventPayload::TurnStarted { message, .. } => Some(message.clone()),
                _ => None,
            })
            .expect("the first turn started");
        assert_eq!(sent.parts.len(), 2);
        assert_eq!(sent.parts[0], ContentPart::Text { text: "Fix login\n\nDo it.".into() });
        assert_eq!(
            sent.parts[1],
            ContentPart::Mention {
                name: "Spec".into(),
                path: format!("kybern://note/{}", note.summary.id),
                display_name: Some("Spec".into())
            }
        );
        // The provider's copy has the note text instead.
        let expanded = fixture.orchestrator.expand_item_mentions(&sent).unwrap();
        assert_eq!(expanded.parts[1], ContentPart::Text { text: "Note: Spec\n\n- [ ] one\n".into() });

        // No agent exists in this fixture, so the turn fails and the run settles for review.
        let settled = fixture.wait_for(&task, |task| task.status == TaskStatus::NeedsReview).await;
        assert_eq!(settled.runs[0].state, TaskRunState::Failed);
        assert!(settled.runs[0].ended_at.is_some() && settled.runs[0].activity.is_none());
        assert!(fixture.store.thread_get(thread.id).unwrap().unwrap().title == "Fix login", "the title survives the turn");
    }

    #[tokio::test]
    async fn send_validates_before_creating_anything() {
        let fixture = Fixture::new();
        let global = fixture
            .orchestrator
            .task_item_create(TaskItemsCreateParams {
                scope: TaskScope::Global,
                project_id: None,
                title: "Loose".into(),
                body: None,
                status: None,
                priority: None,
                note_ids: None,
                source: None,
            })
            .unwrap();
        let mut params = fixture.send_params(&global, vec![]);
        assert!(fixture.orchestrator.task_item_send(params.clone()).await.is_err(), "a global task needs a project");
        params.project_id = Some(FREE_CHAT_PROJECT_ID);
        assert!(fixture.orchestrator.task_item_send(params.clone()).await.is_err());
        params.project_id = Some(fixture.project.id);
        params.prompt = Some("  ".into());
        assert!(fixture.orchestrator.task_item_send(params.clone()).await.is_err(), "an empty prompt");
        params.prompt = Some("go".into());
        params.note_ids = Some(vec![Uuid::now_v7()]);
        assert!(fixture.orchestrator.task_item_send(params.clone()).await.is_err(), "an unknown note");
        assert!(fixture.store.threads_list(None, true).unwrap().is_empty(), "nothing was created");
        assert!(fixture.current(&global).runs.is_empty());

        // A global task runs in the project the sender chose.
        params.note_ids = None;
        let sent = fixture.orchestrator.task_item_send(params).await.unwrap();
        assert_eq!(fixture.store.thread_get(sent.thread_id).unwrap().unwrap().project_id, fixture.project.id);
        assert_eq!(sent.task.project_id, None, "the task itself stays global");
        // A run in progress blocks a second send.
        let live = fixture.task("Busy");
        fixture.manual_run(&live);
        assert!(fixture.orchestrator.task_item_send(fixture.send_params(&live, vec![])).await.is_err());
    }

    #[tokio::test]
    async fn run_events_move_the_run_and_the_task_through_their_states() {
        let mut fixture = Fixture::new();
        let task = fixture.task("Ship it");
        let thread = fixture.manual_run(&task);
        assert_eq!(fixture.current(&task).status, TaskStatus::Running);
        fixture.drain();

        fixture.emit(&thread, turn_started());
        let current = fixture.current(&task);
        assert_eq!((current.status, current.runs[0].state), (TaskStatus::Running, TaskRunState::Running));

        fixture.emit(&thread, EventPayload::ApprovalRequested { approval: approval(&thread) });
        let waiting = fixture.current(&task);
        assert_eq!((waiting.status, waiting.runs[0].state), (TaskStatus::Running, TaskRunState::Waiting));
        assert_eq!(waiting.runs[0].activity.as_deref(), Some("Waiting for approval"));
        // The thread going back to Running (approval answered) resumes the run.
        let mut resumed = fixture.store.thread_get(thread.id).unwrap().unwrap();
        resumed.status = ThreadStatus::Running;
        fixture.emit(&thread, EventPayload::ThreadUpdated { thread: resumed });
        let running = fixture.current(&task);
        assert_eq!((running.runs[0].state, running.runs[0].activity.clone()), (TaskRunState::Running, None));

        fixture.emit(&thread, EventPayload::UserInputRequested { approval: approval(&thread) });
        assert_eq!(fixture.current(&task).runs[0].activity.as_deref(), Some("Waiting for your answer"));
        fixture.emit(&thread, turn_started());

        fixture.emit(&thread, turn_completed(StopReason::Completed));
        let done = fixture.current(&task);
        assert_eq!((done.status, done.runs[0].state), (TaskStatus::NeedsReview, TaskRunState::Completed));
        assert!(done.runs[0].ended_at.is_some() && done.runs[0].activity.is_none());
        let published = fixture.drain();
        assert!(published.iter().all(|change| change.task.is_some()));
        assert_eq!(published.last().unwrap().task.as_ref().unwrap().status, TaskStatus::NeedsReview);

        // A follow-up turn reopens the run and the task.
        fixture.emit(&thread, turn_started());
        let reopened = fixture.current(&task);
        assert_eq!(
            (reopened.status, reopened.runs[0].state, reopened.runs[0].ended_at),
            (TaskStatus::Running, TaskRunState::Running, None)
        );
        fixture.emit(&thread, turn_completed(StopReason::Interrupted));
        let interrupted = fixture.current(&task);
        assert_eq!((interrupted.status, interrupted.runs[0].state), (TaskStatus::NeedsReview, TaskRunState::Interrupted));

        fixture.emit(&thread, turn_started());
        fixture.emit(&thread, EventPayload::TurnFailed { error: "boom".into() });
        let failed = fixture.current(&task);
        assert_eq!((failed.status, failed.runs[0].state), (TaskStatus::NeedsReview, TaskRunState::Failed));

        // The user dropping the task on Done mid-run is respected: the run ending does not override it.
        fixture.emit(&thread, turn_started());
        fixture.orchestrator.task_item_update(update(task.id, TaskStatus::Done)).unwrap();
        fixture.emit(&thread, turn_completed(StopReason::Completed));
        let respected = fixture.current(&task);
        assert_eq!((respected.status, respected.runs[0].state), (TaskStatus::Done, TaskRunState::Completed));
        // Unrelated threads and events change nothing.
        fixture.drain();
        let other = fixture.store.thread_get(thread.id).unwrap().unwrap();
        let stray = Thread { id: Uuid::now_v7(), ..other };
        fixture.store.thread_upsert(&stray).unwrap();
        fixture.emit(&stray, turn_completed(StopReason::Completed));
        fixture.emit(&thread, EventPayload::AssistantTextDelta { message_id: Uuid::nil(), origin: EventOrigin::Root, delta: "x".into() });
        assert!(fixture.drain().is_empty());
    }

    fn update(id: TaskItemId, status: TaskStatus) -> TaskItemsUpdateParams {
        TaskItemsUpdateParams {
            id,
            expected_revision: None,
            title: None,
            body: None,
            status: Some(status),
            priority: None,
            scope: None,
            project_id: None,
            note_ids: None,
            pending_followup: None,
            before_id: None,
        }
    }

    #[tokio::test]
    async fn tool_calls_set_the_activity_and_broadcasts_are_throttled() {
        let mut fixture = Fixture::new();
        let task = fixture.task("Edit things");
        let thread = fixture.manual_run(&task);
        fixture.drain();

        let file = format!("{}/src/main.rs", fixture.project.path);
        fixture.emit(&thread, tool("Edit", json!({ "file_path": file })));
        assert_eq!(fixture.current(&task).runs[0].activity.as_deref(), Some("Editing src/main.rs"));
        assert_eq!(fixture.drain().len(), 1);
        // Within a second the activity is stored but not broadcast again.
        fixture.emit(&thread, tool("Bash", json!({ "command": "cargo test --workspace\nsecond line" })));
        assert_eq!(fixture.current(&task).runs[0].activity.as_deref(), Some("Running cargo test --workspace"));
        assert!(fixture.drain().is_empty(), "throttled");
        // Settling always publishes, throttle or not.
        fixture.emit(&thread, turn_completed(StopReason::Completed));
        assert_eq!(fixture.drain().len(), 1);
        // A tool call arriving after the run settled does not reopen it.
        fixture.emit(&thread, tool("Read", json!({ "file_path": "x" })));
        assert_eq!(fixture.current(&task).runs[0].state, TaskRunState::Completed);
        assert!(fixture.current(&task).runs[0].activity.is_none());
    }

    #[test]
    fn tool_activity_phrases_common_calls() {
        let call = |name: &str, input: serde_json::Value| ToolCall { id: "1".into(), name: name.into(), input, parent_id: None };
        let cwd = "/work/ade";
        assert_eq!(tool_activity(&call("Read", json!({ "file_path": "/work/ade/README.md" })), cwd), "Reading README.md");
        assert_eq!(tool_activity(&call("Read", json!({ "file_path": "/elsewhere/a.txt" })), cwd), "Reading /elsewhere/a.txt");
        assert_eq!(tool_activity(&call("Write", json!({ "path": "/work/ade/a/b.rs" })), cwd), "Writing a/b.rs");
        assert_eq!(tool_activity(&call("MultiEdit", json!({ "file_path": "/work/ade/lib.rs" })), cwd), "Editing lib.rs");
        assert_eq!(tool_activity(&call("fileChange", json!({})), cwd), "Editing files");
        assert_eq!(tool_activity(&call("shell", json!({ "command": ["cargo", "build"] })), cwd), "Running cargo build");
        assert_eq!(tool_activity(&call("execute", json!({ "raw": { "input": { "command": "ls -la" } } })), cwd), "Running ls -la");
        assert_eq!(tool_activity(&call("Bash", json!({})), cwd), "Running a command");
        assert_eq!(tool_activity(&call("Grep", json!({ "pattern": "TODO" })), cwd), "Searching TODO");
        assert_eq!(tool_activity(&call("WebFetch", json!({ "url": "https://example.com" })), cwd), "Fetching https://example.com");
        assert_eq!(tool_activity(&call("WebSearch", json!({ "query": "x" })), cwd), "Searching the web");
        assert_eq!(tool_activity(&call("Task", json!({ "description": "audit" })), cwd), "Working with a subagent");
        assert_eq!(tool_activity(&call("TodoWrite", json!({})), cwd), "Updating the plan");
        assert_eq!(tool_activity(&call("mcp__kybern__kybern_thread_read", json!({})), cwd), "Using kybern_thread_read");
        assert_eq!(
            tool_activity(&call("Bash", json!({ "command": "x".repeat(200) })), cwd).chars().count(),
            "Running ".len() + 60,
            "long commands are cut"
        );
    }

    #[tokio::test]
    async fn followup_goes_to_an_idle_run_queues_when_busy_and_is_saved_without_a_run() {
        let fixture = Fixture::new();
        let task = fixture.task("Talk");
        // No run yet: saved, appended on repeat, and no thread involved.
        let first =
            fixture.orchestrator.task_item_followup(TaskItemsFollowupParams { id: task.id, text: " also tests ".into() }).await.unwrap();
        assert_eq!((first.sent_to, first.task.pending_followup.as_deref()), (None, Some("also tests")));
        let second =
            fixture.orchestrator.task_item_followup(TaskItemsFollowupParams { id: task.id, text: "and docs".into() }).await.unwrap();
        assert_eq!(second.task.pending_followup.as_deref(), Some("also tests\n\nand docs"));
        assert!(fixture.orchestrator.task_item_followup(TaskItemsFollowupParams { id: task.id, text: "  ".into() }).await.is_err());

        // A busy run queues the text on its thread.
        let thread = fixture.manual_run(&task);
        let queued =
            fixture.orchestrator.task_item_followup(TaskItemsFollowupParams { id: task.id, text: "while you work".into() }).await.unwrap();
        assert_eq!(queued.sent_to, Some(thread.id));
        let queue = fixture.store.queue_list(Some(thread.id)).unwrap();
        assert_eq!(queue.len(), 1);
        assert_eq!(queue[0].message.plain_text(), "while you work");
        assert_eq!(queued.task.pending_followup.as_deref(), Some("also tests\n\nand docs"), "the saved text is left for the next run");

        // Once the thread is idle the text is sent into it and the task is running again.
        let mut idle = fixture.store.thread_get(thread.id).unwrap().unwrap();
        idle.status = ThreadStatus::Idle;
        fixture.store.thread_upsert(&idle).unwrap();
        fixture.emit(&thread, turn_completed(StopReason::Completed));
        assert_eq!(fixture.current(&task).status, TaskStatus::NeedsReview);
        let sent = fixture.orchestrator.task_item_followup(TaskItemsFollowupParams { id: task.id, text: "now this".into() }).await.unwrap();
        assert_eq!(sent.sent_to, Some(thread.id));
        assert_eq!((sent.task.status, sent.task.runs[0].state), (TaskStatus::Running, TaskRunState::Running));
        let started = fixture
            .store
            .events_for_thread(thread.id)
            .unwrap()
            .into_iter()
            .any(|event| matches!(&event.payload, EventPayload::TurnStarted { message, .. } if message.plain_text() == "now this"));
        assert!(started, "the follow-up started a turn on the run's thread");
        // An archived run thread cannot take it: back to saving.
        let mut archived = fixture.store.thread_get(thread.id).unwrap().unwrap();
        archived.status = ThreadStatus::Archived;
        fixture.store.thread_upsert(&archived).unwrap();
        let saved = fixture.orchestrator.task_item_followup(TaskItemsFollowupParams { id: task.id, text: "later".into() }).await.unwrap();
        assert_eq!(saved.sent_to, None);
        assert!(saved.task.pending_followup.as_deref().unwrap().ends_with("later"));
    }

    /// The task's status and its latest run belong together: a task is Running
    /// while the run is live and in Needs review once it is not.
    fn assert_in_step(task: &TaskItem, context: &str) {
        let run = task.runs.last().expect("a run");
        match task.status {
            TaskStatus::Running => assert!(run.state.is_live(), "{context}: task running next to a {:?} run", run.state),
            TaskStatus::NeedsReview => assert!(!run.state.is_live(), "{context}: task in review next to a {:?} run", run.state),
            _ => {}
        }
    }

    #[tokio::test]
    async fn a_follow_up_reopens_a_settled_run_even_when_the_user_marked_it_done() {
        let mut fixture = Fixture::new();
        let task = fixture.task("Talk");
        let thread = fixture.manual_run(&task);
        fixture.emit(&thread, turn_started());
        fixture.emit(&thread, turn_completed(StopReason::Completed));
        let settled = fixture.current(&task);
        assert_eq!((settled.status, settled.runs[0].state), (TaskStatus::NeedsReview, TaskRunState::Completed));
        let first_end = settled.runs[0].ended_at.expect("the run ended");
        // The user accepted the work; a later follow-up is an explicit request for more.
        fixture.orchestrator.task_item_update(update(task.id, TaskStatus::Done)).unwrap();
        let mut idle = fixture.store.thread_get(thread.id).unwrap().unwrap();
        idle.status = ThreadStatus::Idle;
        fixture.store.thread_upsert(&idle).unwrap();
        fixture.drain();
        tokio::time::sleep(Duration::from_millis(5)).await;

        let sent =
            fixture.orchestrator.task_item_followup(TaskItemsFollowupParams { id: task.id, text: "one more thing".into() }).await.unwrap();
        assert_eq!(sent.sent_to, Some(thread.id));
        let running = fixture.current(&task);
        assert_eq!((running.status, running.runs[0].state, running.runs[0].ended_at), (TaskStatus::Running, TaskRunState::Running, None));
        assert_eq!((sent.task.status, sent.task.runs[0].state), (TaskStatus::Running, TaskRunState::Running), "the reply shows it too");
        let published = fixture.drain();
        let last = published.iter().rev().find_map(|change| change.task.as_ref()).expect("a broadcast");
        assert_eq!((last.status, last.runs[0].state, last.runs[0].ended_at), (TaskStatus::Running, TaskRunState::Running, None));
        assert!(published.iter().filter_map(|change| change.task.as_ref()).all(|task| {
            assert_in_step(task, "follow-up broadcast");
            true
        }));

        // The turn ends (here the missing agent fails it): back to review with a newer end.
        let reviewed = fixture.wait_for(&task, |task| task.status == TaskStatus::NeedsReview).await;
        assert_ne!(reviewed.runs[0].state, TaskRunState::Running);
        assert!(reviewed.runs[0].ended_at.expect("ended again") > first_end, "the end time moves to the new turn");
        let last = fixture.drain().into_iter().rev().find_map(|change| change.task).expect("a broadcast");
        assert_eq!((last.status, last.runs[0].ended_at), (TaskStatus::NeedsReview, reviewed.runs[0].ended_at));
    }

    #[tokio::test]
    async fn an_older_run_does_not_move_the_task_once_a_newer_run_exists() {
        let fixture = Fixture::new();
        let task = fixture.task("Twice");
        let first = fixture.manual_run(&task);
        fixture.emit(&first, turn_started());
        fixture.emit(&first, turn_completed(StopReason::Completed));
        let second = fixture.manual_run(&task);
        fixture.emit(&second, turn_started());
        fixture.emit(&second, turn_completed(StopReason::Completed));
        assert_eq!(fixture.current(&task).status, TaskStatus::NeedsReview);

        // Someone continues the first run's thread directly: that run reopens, the task follows the latest run.
        fixture.emit(&first, turn_started());
        let current = fixture.current(&task);
        assert_eq!(
            (current.runs[0].state, current.runs[1].state, current.status),
            (TaskRunState::Running, TaskRunState::Completed, TaskStatus::NeedsReview)
        );
        fixture.emit(&first, turn_completed(StopReason::Completed));
        assert_eq!(fixture.current(&task).status, TaskStatus::NeedsReview);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_task_and_its_run_are_never_observed_out_of_step_while_a_fast_turn_ends() {
        let mut fixture = Fixture::new();
        for round in 0..25 {
            let task = fixture.task(&format!("Fast {round}"));
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let reader = {
                let (store, id, stop) = (fixture.store.clone(), task.id, stop.clone());
                tokio::spawn(async move {
                    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                        if let Some(task) = store.task_item_get(id).unwrap().filter(|task| !task.runs.is_empty()) {
                            assert_in_step(&task, "store read");
                        }
                        tokio::task::yield_now().await;
                    }
                })
            };
            // No agent exists here, so the first turn fails at once: the fastest turn there is.
            let result = fixture.orchestrator.task_item_send(fixture.send_params(&task, vec![])).await.unwrap();
            assert_in_step(&result.task, "send result");
            let settled = fixture.wait_for(&task, |task| task.status == TaskStatus::NeedsReview).await;
            assert_in_step(&settled, "settled");
            stop.store(true, std::sync::atomic::Ordering::Relaxed);
            reader.await.unwrap();
            for change in fixture.drain() {
                if let Some(task) = change.task.filter(|published| published.id == task.id && !published.runs.is_empty()) {
                    assert_in_step(&task, "broadcast");
                }
            }
        }
    }

    #[test]
    fn events_reach_the_task_in_the_order_they_were_stored() {
        let fixture = Fixture::new();
        let task = fixture.task("Racing");
        let thread = fixture.manual_run(&task);
        let orchestrator = fixture.orchestrator.clone();
        for round in 0..200 {
            // A turn ends on one thread while the next one starts on another.
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let (a, b) = (orchestrator.clone(), orchestrator.clone());
            let (ba, bb) = (barrier.clone(), barrier);
            let id = thread.id;
            let ender = std::thread::spawn(move || {
                ba.wait();
                a.emit(id, Some(Uuid::nil()), turn_completed(StopReason::Completed)).unwrap().seq
            });
            let starter = std::thread::spawn(move || {
                bb.wait();
                b.emit(id, Some(Uuid::nil()), turn_started()).unwrap().seq
            });
            let (ended, started) = (ender.join().unwrap(), starter.join().unwrap());
            let current = fixture.current(&task);
            if started > ended {
                assert_eq!(
                    (current.status, current.runs[0].state),
                    (TaskStatus::Running, TaskRunState::Running),
                    "round {round}: started last"
                );
            } else {
                assert_eq!(
                    (current.status, current.runs[0].state),
                    (TaskStatus::NeedsReview, TaskRunState::Completed),
                    "round {round}: ended last"
                );
            }
        }
    }

    #[tokio::test]
    async fn saved_follow_ups_are_trimmed_and_separated_by_a_blank_line() {
        let fixture = Fixture::new();
        let task = fixture.task("Notes to self");
        let add = |text: &str| fixture.orchestrator.task_item_followup(TaskItemsFollowupParams { id: task.id, text: text.into() });
        assert_eq!(
            add("\n  first line\nsecond line \n\n").await.unwrap().task.pending_followup.as_deref(),
            Some("first line\nsecond line")
        );
        assert_eq!(
            add("  third\t\n").await.unwrap().task.pending_followup.as_deref(),
            Some("first line\nsecond line\n\nthird"),
            "one blank line between saves, nothing trailing"
        );
        // Text that was saved with stray whitespace before still joins cleanly.
        fixture.store.task_item_update(task.id, TaskPatch { pending_followup: Some("kept".into()), ..Default::default() }).unwrap();
        assert_eq!(add("more").await.unwrap().task.pending_followup.as_deref(), Some("kept\n\nmore"));
        // Starting a run uses it up.
        let sent = fixture.orchestrator.task_item_send(fixture.send_params(&task, vec![])).await.unwrap();
        assert_eq!(sent.task.pending_followup, None);
    }

    #[tokio::test]
    async fn sending_a_message_delivers_the_saved_follow_up_once() {
        let fixture = Fixture::new();
        let first_text = |thread_id: ThreadId| {
            fixture
                .store
                .events_for_thread(thread_id)
                .unwrap()
                .into_iter()
                .find_map(|event| match event.payload {
                    EventPayload::TurnStarted { message, .. } => Some(message),
                    _ => None,
                })
                .expect("the first turn started")
        };
        let with_message = |task: &TaskItem, text: &str| TaskItemsSendParams {
            prompt: None,
            message: Some(UserMessage::text(text)),
            ..fixture.send_params(task, vec![])
        };
        for (title, text) in [("Plain", "Do it."), ("Already there", "Do it.\n\nalso tests\n")] {
            let task = fixture.task(title);
            fixture
                .store
                .task_item_update(task.id, TaskPatch { pending_followup: Some("also tests".into()), ..Default::default() })
                .unwrap();
            let sent = fixture.orchestrator.task_item_send(with_message(&task, text)).await.unwrap();
            assert_eq!(sent.task.pending_followup, None, "{title}: the saved text is used up");
            let message = first_text(sent.thread_id);
            assert!(matches!(&message.parts[0], ContentPart::Mention { path, .. } if path.starts_with(TASK_MENTION_PREFIX)));
            let text = message.plain_text();
            assert!(text.trim_end().ends_with("Do it.\n\nalso tests"), "{title}: {text:?}");
            assert_eq!(text.matches("also tests").count(), 1, "{title}: delivered once");
        }
    }

    #[tokio::test]
    async fn creating_from_a_checklist_line_links_it_and_done_syncs_both_ways() {
        let fixture = Fixture::new();
        let note = fixture.note("Plan", "# Plan\n- [ ] Fix login\n- [ ] Fix login\n- [x] Ship\n");
        let task = fixture
            .orchestrator
            .task_item_create(TaskItemsCreateParams {
                scope: TaskScope::Project,
                project_id: Some(fixture.project.id),
                title: "Fix login".into(),
                body: None,
                status: Some(TaskStatus::Todo),
                priority: None,
                note_ids: None,
                source: Some(TaskItemSource { note_id: note.summary.id, line_text: "Fix login".into() }),
            })
            .unwrap();
        assert_eq!((task.source_note_id, task.note_ids.clone()), (Some(note.summary.id), vec![note.summary.id]));
        let link = format!("[{}](kybern://task/{})", task.key, task.id);
        let body = |fixture: &Fixture| fixture.store.note_get(note.summary.id).unwrap().unwrap();
        assert_eq!(body(&fixture).body, format!("# Plan\n- [ ] Fix login {link}\n- [ ] Fix login\n- [x] Ship\n"));
        assert_eq!(body(&fixture).summary.revision, 2);

        // Task done: the line is ticked and the note change is published; reopened: unticked.
        let mut notes = fixture.orchestrator.subscribe_notes();
        fixture.orchestrator.task_item_update(update(task.id, TaskStatus::Done)).unwrap();
        assert!(body(&fixture).body.contains(&format!("- [x] Fix login {link}")));
        assert_eq!(notes.try_recv().unwrap().note.unwrap().revision, 3);
        fixture.orchestrator.task_item_update(update(task.id, TaskStatus::Todo)).unwrap();
        assert!(body(&fixture).body.contains(&format!("- [ ] Fix login {link}")));
        assert_eq!(body(&fixture).summary.revision, 4);
        fixture.orchestrator.task_item_update(update(task.id, TaskStatus::Todo)).unwrap();
        assert_eq!(body(&fixture).summary.revision, 4, "no status change, no rewrite");

        // Ticking the line in the editor marks the task done; unticking sends it back to to do.
        let tick = |fixture: &Fixture, text: String| {
            let revision = fixture.store.note_get(note.summary.id).unwrap().unwrap().summary.revision;
            fixture
                .orchestrator
                .note_update(NotesUpdateParams {
                    id: Some(note.summary.id),
                    thread_id: None,
                    expected_revision: revision,
                    title: None,
                    body: Some(text),
                })
                .unwrap()
        };
        let ticked = body(&fixture).body.replace(&format!("- [ ] Fix login {link}"), &format!("- [x] Fix login {link}"));
        let after_tick = tick(&fixture, ticked);
        assert_eq!(fixture.current(&task).status, TaskStatus::Done);
        assert_eq!(after_tick.summary.revision, 5, "syncing back does not rewrite the note again (no ping-pong)");
        let unticked = after_tick.body.replace(&format!("- [x] Fix login {link}"), &format!("- [ ] Fix login {link}"));
        let after_untick = tick(&fixture, unticked);
        assert_eq!(fixture.current(&task).status, TaskStatus::Todo);
        assert_eq!(after_untick.summary.revision, 6);
        // Editing other text while the box keeps its state does not touch the task.
        fixture.orchestrator.task_item_update(update(task.id, TaskStatus::Canceled)).unwrap();
        let edited = tick(&fixture, format!("{}\nmore words\n", after_untick.body));
        assert_eq!(fixture.current(&task).status, TaskStatus::Canceled);
        assert_eq!(edited.summary.revision, 7);

        // A done task whose run thread gets a new turn leaves done, so its line unticks.
        let thread = fixture.manual_run(&fixture.current(&task));
        fixture.emit(&thread, turn_completed(StopReason::Completed));
        fixture.orchestrator.task_item_update(update(task.id, TaskStatus::Done)).unwrap();
        assert!(body(&fixture).body.contains(&format!("- [x] Fix login {link}")));
        fixture.emit(&thread, turn_started());
        assert_eq!(fixture.current(&task).status, TaskStatus::Running);
        assert!(body(&fixture).body.contains(&format!("- [ ] Fix login {link}")));

        // The line must exist: a stale source fails before anything is created.
        let missing = fixture.orchestrator.task_item_create(TaskItemsCreateParams {
            scope: TaskScope::Global,
            project_id: None,
            title: "Gone".into(),
            body: None,
            status: None,
            priority: None,
            note_ids: None,
            source: Some(TaskItemSource { note_id: note.summary.id, line_text: "Not in the note".into() }),
        });
        assert!(missing.is_err());
        assert_eq!(fixture.orchestrator.task_items_list().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn deleting_and_restoring_publish_changes_and_project_removal_hides_tasks() {
        let mut fixture = Fixture::new();
        let task = fixture.task("Short lived");
        fixture.drain();
        fixture.orchestrator.task_item_delete(task.id).unwrap();
        assert_eq!(fixture.drain(), vec![TaskItemsChangedNotification { task: None, deleted_id: Some(task.id) }]);
        assert!(fixture.orchestrator.task_item_get(TaskItemsGetParams { id: Some(task.id), key: None }).unwrap().is_none());
        let restored = fixture.orchestrator.task_item_restore(task.id).unwrap();
        assert_eq!(fixture.drain(), vec![TaskItemsChangedNotification { task: Some(restored), deleted_id: None }]);
        let by_key = fixture.orchestrator.task_item_get(TaskItemsGetParams { id: None, key: Some(task.key.to_lowercase()) }).unwrap();
        assert_eq!(by_key.map(|found| found.id), Some(task.id));
        assert!(fixture.orchestrator.task_item_get(TaskItemsGetParams::default()).is_err());

        fixture.orchestrator.remove_project(fixture.project.id).unwrap();
        assert_eq!(fixture.drain(), vec![TaskItemsChangedNotification { task: None, deleted_id: Some(task.id) }]);
        assert!(fixture.orchestrator.task_items_list().unwrap().is_empty());
        assert_eq!(fixture.orchestrator.purge_expired_tasks().unwrap(), 0);
    }

    #[test]
    fn note_mentions_expand_with_caps_and_unavailable_markers() {
        let fixture = Fixture::new();
        let small = fixture.note("Small", "tiny body");
        let big = fixture.note("Big", &"x".repeat(NOTE_MENTION_MAX_BYTES + 100));
        let gone = fixture.note("Gone", "bye");
        fixture.orchestrator.note_delete(gone.summary.id).unwrap();
        let mention = |id: NoteId| ContentPart::Mention {
            name: "n".into(),
            path: format!("{NOTE_MENTION_PREFIX}{id}"),
            display_name: Some("n".into()),
        };
        let message = UserMessage {
            parts: vec![
                ContentPart::Text { text: "Do it".into() },
                mention(small.summary.id),
                mention(big.summary.id),
                mention(gone.summary.id),
                mention(Uuid::now_v7()),
                ContentPart::Mention { name: "computer".into(), path: "kybern://computer".into(), display_name: None },
                ContentPart::Mention { name: "bad".into(), path: format!("{NOTE_MENTION_PREFIX}not-an-id"), display_name: None },
            ],
        };
        let expanded = fixture.orchestrator.expand_item_mentions(&message).unwrap();
        let text = |index: usize| match &expanded.parts[index] {
            ContentPart::Text { text } => text.clone(),
            other => panic!("expected text, got {other:?}"),
        };
        assert_eq!(text(0), "Do it");
        assert_eq!(text(1), "Note: Small\n\ntiny body");
        let big_text = text(2);
        assert!(big_text.starts_with("Note: Big\n\n") && big_text.ends_with("\n[truncated]"));
        assert_eq!(big_text.len(), "Note: Big\n\n".len() + NOTE_MENTION_MAX_BYTES + "\n[truncated]".len(), "16 KiB of body per note");
        assert_eq!((text(3).as_str(), text(4).as_str(), text(6).as_str()), ("Note unavailable", "Note unavailable", "Note unavailable"));
        assert!(matches!(expanded.parts[5], ContentPart::Mention { .. }), "other mentions pass through");
        assert!(fixture.orchestrator.expand_item_mentions(&UserMessage::text("plain")).is_none());

        // Four big notes share 48 KiB: the first three get 16 KiB, the rest what is left (nothing).
        let message = UserMessage { parts: (0..4).map(|_| mention(big.summary.id)).collect() };
        let expanded = fixture.orchestrator.expand_item_mentions(&message).unwrap();
        let bodies: Vec<usize> = expanded
            .parts
            .iter()
            .map(|part| match part {
                ContentPart::Text { text } => text.len(),
                _ => 0,
            })
            .collect();
        let overhead = "Note: Big\n\n".len() + "\n[truncated]".len();
        assert_eq!(bodies[..3], [NOTE_MENTION_MAX_BYTES + overhead; 3]);
        assert_eq!(bodies[3], overhead, "the budget is spent: only the marker is left");
        let total: usize = bodies.iter().map(|len| len - overhead).sum();
        assert!(total <= NOTE_MENTIONS_MAX_BYTES);

        // A multi-byte body is cut on a character boundary.
        let wide = fixture.note("Wide", &"é".repeat(NOTE_MENTION_MAX_BYTES));
        let expanded = fixture.orchestrator.expand_item_mentions(&UserMessage { parts: vec![mention(wide.summary.id)] }).unwrap();
        let ContentPart::Text { text } = &expanded.parts[0] else { panic!() };
        assert!(text.ends_with("\n[truncated]") || text.len() <= NOTE_MENTION_MAX_BYTES + 64);
    }

    #[tokio::test]
    async fn task_mentions_expand_to_the_task_and_share_the_budget_with_notes() {
        let fixture = Fixture::new();
        let spec = fixture.note("Spec", "details");
        let task = fixture
            .orchestrator
            .task_item_create(TaskItemsCreateParams {
                scope: TaskScope::Project,
                project_id: Some(fixture.project.id),
                title: "Fix login".into(),
                body: Some("Redirect after sign in.\n\n- [ ] Lands on home\n- [x] Keeps session\n".into()),
                status: Some(TaskStatus::Todo),
                priority: Some(2),
                note_ids: Some(vec![spec.summary.id]),
                source: None,
            })
            .unwrap();
        let run = fixture.manual_run(&task);
        let message = UserMessage {
            parts: vec![
                ContentPart::Text { text: "Look at".into() },
                task_mention(&task),
                ContentPart::Mention { name: "gone".into(), path: format!("{TASK_MENTION_PREFIX}{}", Uuid::now_v7()), display_name: None },
            ],
        };
        let expanded = fixture.orchestrator.expand_item_mentions(&message).unwrap();
        let ContentPart::Text { text } = &expanded.parts[1] else { panic!("the task became text") };
        assert!(text.starts_with(&format!("Task {}: Fix login\nStatus: Running\nPriority: High\nProject: ade\n", task.key)), "{text}");
        assert!(text.contains(&format!("Linked notes: Spec (kybern://note/{})", spec.summary.id)), "{text}");
        assert!(text.contains(&format!("Latest run: thread {} (running). Read it with kybern_thread_read.", run.id)), "{text}");
        assert!(text.ends_with("Description:\nRedirect after sign in.\n\n- [ ] Lands on home\n- [x] Keeps session"), "{text}");
        assert_eq!(expanded.parts[2], ContentPart::Text { text: "Task not found".into() });
        assert_eq!(message.parts[1], task_mention(&task), "the stored message keeps the chip");

        // A long description is capped at 16 KiB and spends the budget notes share.
        let long = fixture.task("Long");
        fixture
            .orchestrator
            .task_item_update(TaskItemsUpdateParams {
                id: long.id,
                expected_revision: Some(long.revision),
                title: None,
                body: Some("y".repeat(NOTE_MENTION_MAX_BYTES * 2)),
                status: None,
                priority: None,
                scope: None,
                project_id: None,
                note_ids: None,
                pending_followup: None,
                before_id: None,
            })
            .unwrap();
        let long = fixture.current(&long);
        let big = fixture.note("Big", &"x".repeat(NOTE_MENTION_MAX_BYTES + 100));
        let note_mention =
            ContentPart::Mention { name: "n".into(), path: format!("{NOTE_MENTION_PREFIX}{}", big.summary.id), display_name: None };
        let message = UserMessage { parts: vec![task_mention(&long), task_mention(&long), note_mention.clone(), note_mention] };
        let expanded = fixture.orchestrator.expand_item_mentions(&message).unwrap();
        let lengths: Vec<usize> = expanded
            .parts
            .iter()
            .map(|part| match part {
                ContentPart::Text { text } => text.len(),
                _ => 0,
            })
            .collect();
        let marker = "\n[truncated]".len();
        assert_eq!(lengths[..2], [NOTE_MENTION_MAX_BYTES + marker; 2]);
        assert_eq!(lengths[2], "Note: Big\n\n".len() + NOTE_MENTION_MAX_BYTES + marker);
        assert_eq!(lengths[3], "Note: Big\n\n".len() + marker, "the shared 48 KiB is spent");
    }

    #[tokio::test]
    async fn send_with_a_message_keeps_its_parts_and_adds_the_task_reference() {
        let fixture = Fixture::new();
        let spec = fixture.note("Spec", "details");
        let extra = fixture.note("Extra", "more");
        let task = fixture.task("Fix login");
        let mut params = fixture.send_params(&task, vec![extra.summary.id]);
        params.prompt = None;
        params.message = Some(UserMessage {
            parts: vec![
                ContentPart::Text { text: "Start with the redirect.".into() },
                ContentPart::Mention { name: "Spec".into(), path: format!("{NOTE_MENTION_PREFIX}{}", spec.summary.id), display_name: None },
                ContentPart::FileMention { path: "src/login.rs".into() },
            ],
        });
        let result = fixture.orchestrator.task_item_send(params).await.unwrap();
        let events = fixture.store.events_for_thread(result.thread_id).unwrap();
        let sent = events
            .iter()
            .find_map(|event| match &event.payload {
                EventPayload::TurnStarted { message, .. } => Some(message.clone()),
                _ => None,
            })
            .expect("the first turn started");
        assert_eq!(sent.parts[0], task_mention(&task), "the task reference leads");
        assert_eq!(sent.parts[1], ContentPart::Text { text: "Start with the redirect.".into() });
        assert!(matches!(&sent.parts[3], ContentPart::FileMention { path } if path == "src/login.rs"));
        assert!(
            matches!(&sent.parts[4], ContentPart::Mention { path, .. } if *path == format!("{NOTE_MENTION_PREFIX}{}", extra.summary.id))
        );
        assert_eq!(sent.parts.len(), 5);
        let noted: Vec<NoteId> = result.task.runs[0].notes.iter().map(|note| note.note_id).collect();
        assert_eq!(noted, vec![spec.summary.id, extra.summary.id], "mentioned and attached notes are both recorded");

        // A message that already references the task is not given a second chip.
        let other = fixture.task("Other");
        let mut params = fixture.send_params(&other, vec![]);
        params.prompt = None;
        params.message = Some(UserMessage { parts: vec![ContentPart::Text { text: "Go".into() }, task_mention(&other)] });
        let result = fixture.orchestrator.task_item_send(params).await.unwrap();
        let events = fixture.store.events_for_thread(result.thread_id).unwrap();
        let sent = events
            .iter()
            .find_map(|event| match &event.payload {
                EventPayload::TurnStarted { message, .. } => Some(message.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(sent.parts, vec![ContentPart::Text { text: "Go".into() }, task_mention(&other)]);

        // Prompt and message together are ambiguous; neither is an empty send.
        let third = fixture.task("Third");
        let mut both = fixture.send_params(&third, vec![]);
        both.message = Some(UserMessage::text("x"));
        assert!(fixture.orchestrator.task_item_send(both).await.unwrap_err().to_string().contains("not both"));
        let mut neither = fixture.send_params(&third, vec![]);
        neither.prompt = None;
        assert!(fixture.orchestrator.task_item_send(neither).await.is_err());
    }

    #[tokio::test]
    async fn a_finished_run_gets_its_diff_from_the_first_checkpoint_to_the_latest() {
        let fixture = Fixture::new();
        let task = fixture.task("Change files");
        let thread = fixture.manual_run(&task);
        let workspace = PathBuf::from(&fixture.project.path);
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(["-c", "user.name=Test", "-c", "user.email=test@example.com"])
                .args(args)
                .current_dir(&workspace)
                .output()
                .unwrap();
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        };
        git(&["init", "-q"]);
        std::fs::write(workspace.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        git(&["add", "."]);
        git(&["commit", "-q", "-m", "start"]);

        let repo = kybern_git::Repo::new(&fixture.project.path);
        let before = repo.snapshot("before").await.unwrap();
        let turn_id = Uuid::now_v7();
        fixture
            .store
            .checkpoint_upsert(&Checkpoint {
                thread_id: thread.id,
                turn_id,
                before: before.clone(),
                after: None,
                provider_turn_id: None,
                provider_turn_end: None,
                created_at: Utc::now(),
            })
            .unwrap();
        std::fs::write(workspace.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        std::fs::write(workspace.join("b.txt"), "new file\n").unwrap();
        let after = repo.snapshot("after").await.unwrap();
        let mut checkpoint = fixture.store.checkpoint_get(turn_id).unwrap().unwrap();
        checkpoint.after = Some(after);
        fixture.store.checkpoint_upsert(&checkpoint).unwrap();
        fixture.emit(&thread, EventPayload::CheckpointUpdated { checkpoint });

        let measured = fixture.wait_for(&task, |task| task.runs[0].diff.is_some()).await;
        // a.txt: +2 (TWO, four) -1 (two); b.txt: +1.
        assert_eq!(measured.runs[0].diff, Some(TaskRunDiff { added: 3, removed: 1, files: 2 }));
        assert_eq!(measured.status, TaskStatus::Running, "measuring the diff does not settle the run");
    }

    #[test]
    fn startup_follows_threads_that_already_run_a_task() {
        let fixture = Fixture::new();
        let task = fixture.task("Survives restarts");
        let thread = fixture.manual_run(&task);
        // A fresh orchestrator over the same store finds the run's thread on its own.
        let paths = Paths::resolve(Some(fixture.root.join("data2"))).unwrap();
        let settings = SettingsStore::load(&paths.settings).unwrap();
        let (events_tx, _) = crate::bounded_broadcast::channel(8, 1024 * 1024);
        let restarted = Orchestrator::new(fixture.store.clone(), DriverRegistry::default(), events_tx, paths, settings);
        restarted.emit(thread.id, Some(Uuid::nil()), EventPayload::TurnFailed { error: "daemon restarted".into() }).unwrap();
        let settled = fixture.current(&task);
        assert_eq!((settled.status, settled.runs[0].state), (TaskStatus::NeedsReview, TaskRunState::Failed));
    }
}
