//! User tasks: Linear-style work items that can be sent to an agent.
//!
//! Like notes, the tables have no foreign keys to projects or notes. A task
//! outlives its project (it is soft deleted with it and kept for 30 days) and a
//! note link is only a reference. Keys come from per-prefix counters that are
//! never decremented, so a key is not reused even after its task is purged.

use std::collections::HashMap;

use anyhow::Result;
use chrono::{DateTime, Duration, Utc};
use kybern_protocol::methods::{
    NoteId, TaskItem, TaskItemId, TaskPriority, TaskRun, TaskRunDiff, TaskRunNote, TaskRunState, TaskScope, TaskStatus,
};
use kybern_protocol::{ProjectId, ProviderInstance, ProviderKind, ThreadId, is_free_chat_project};
use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;
use uuid::Uuid;

use crate::notes::list_item;
use crate::{Store, other, parse_time, parse_uuid};

/// Key prefix of tasks that belong to no project.
pub const GLOBAL_TASK_PREFIX: &str = "TSK";
/// Longest accepted task title.
pub const TASK_TITLE_MAX_CHARS: usize = 300;
/// Largest accepted task body.
pub const TASK_BODY_MAX_BYTES: usize = 512 * 1024;
/// How long a deleted task stays restorable.
pub const TASK_RETENTION_DAYS: i64 = 30;
const FOLLOWUP_MAX_BYTES: usize = 64 * 1024;
const RANK_STEP: f64 = 1024.0;
const MIN_RANK_GAP: f64 = 1e-6;
const TASK_LINK: &str = "kybern://task/";

/// A failure the caller can act on. Everything else is an internal error.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TaskError {
    #[error("{0}")]
    NotFound(&'static str),
    /// The task changed since the caller last read it.
    #[error("This task changed on another device. Choose which version to keep.")]
    Conflict,
    #[error("{0}")]
    Invalid(String),
}

fn invalid<T>(message: &str) -> Result<T> {
    Err(TaskError::Invalid(message.into()).into())
}

/// A task to create.
#[derive(Debug, Clone)]
pub struct NewTask {
    pub scope: TaskScope,
    pub project_id: Option<ProjectId>,
    pub title: String,
    pub body: String,
    /// A user status; `inbox` when absent.
    pub status: Option<TaskStatus>,
    pub priority: TaskPriority,
    pub note_ids: Vec<NoteId>,
    /// The note whose checklist line this task came from; it is also linked.
    pub source_note_id: Option<NoteId>,
    /// The thread whose agent created the task; `None` for the user's own tasks.
    pub created_by_thread: Option<ThreadId>,
}

/// Changes to a task. Every field is optional; absent means unchanged.
#[derive(Debug, Clone, Default)]
pub struct TaskPatch {
    pub title: Option<String>,
    pub body: Option<String>,
    /// Required when the title or body actually change.
    pub expected_revision: Option<i64>,
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    pub scope: Option<TaskScope>,
    pub project_id: Option<ProjectId>,
    pub note_ids: Option<Vec<NoteId>>,
    /// An empty string clears the saved follow-up.
    pub pending_followup: Option<String>,
    pub before_id: Option<TaskItemId>,
}

/// A change to a run, applied by thread id as its thread's events arrive.
#[derive(Debug, Clone, Default)]
pub struct TaskRunPatch {
    pub state: Option<TaskRunState>,
    pub activity: Option<Option<String>>,
    pub ended_at: Option<Option<DateTime<Utc>>>,
    pub diff: Option<Option<TaskRunDiff>>,
    /// Apply only while the run is in one of these states.
    pub only_from: Option<Vec<TaskRunState>>,
}

/// The status a task takes together with a change to its run.
#[derive(Debug, Clone)]
pub struct TaskStatusChange {
    pub status: TaskStatus,
    /// Apply only while the task has one of these statuses.
    pub only_from: Option<Vec<TaskStatus>>,
}

/// What [`Store::task_run_update`] changed, and the task afterwards.
#[derive(Debug, Clone)]
pub struct TaskRunUpdate {
    pub task: TaskItem,
    pub run_changed: bool,
    pub status_changed: bool,
}

impl Store {
    /// Every task that has not been deleted, in column order (rank).
    pub fn task_items_list(&self) -> Result<Vec<TaskItem>> {
        self.with(|c| {
            let mut items = query_items(c, "WHERE deleted_at IS NULL ORDER BY rank, created_at", [])?;
            attach(c, &mut items, None)?;
            Ok(items)
        })
    }

    /// A live task by id. Deleted tasks are hidden.
    pub fn task_item_get(&self, id: TaskItemId) -> Result<Option<TaskItem>> {
        self.with(|c| Ok(fetch_item(c, id)?.filter(|(_, deleted)| deleted.is_none()).map(|(item, _)| item)))
    }

    /// A live task by its key, such as `ADE-14` (case-insensitive).
    pub fn task_item_by_key(&self, key: &str) -> Result<Option<TaskItem>> {
        self.with(|c| {
            let id: Option<String> = c
                .query_row("SELECT id FROM task_items WHERE key = ?1 COLLATE NOCASE AND deleted_at IS NULL", [key.trim()], |r| r.get(0))
                .optional()?;
            match id {
                Some(id) => Ok(fetch_item(c, id.parse()?)?.map(|(item, _)| item)),
                None => Ok(None),
            }
        })
    }

    /// Create a task at the end of its status column.
    pub fn task_item_create(&self, new: NewTask) -> Result<TaskItem> {
        let title = new.title.trim().to_owned();
        if title.is_empty() {
            return invalid("Name this task before saving it.");
        }
        check_content(Some(&title), Some(&new.body))?;
        let status = new.status.unwrap_or(TaskStatus::Inbox);
        if !status.is_user_settable() {
            return invalid("New tasks start as Inbox, To do, Done or Canceled. Send the task to an agent to run it.");
        }
        check_priority(new.priority)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let project_id = resolve_scope(&tx, new.scope, new.project_id)?;
            let mut note_ids = dedupe(new.note_ids);
            if let Some(source) = new.source_note_id
                && !note_ids.contains(&source)
            {
                note_ids.insert(0, source);
            }
            check_notes(&tx, &note_ids)?;
            let id = Uuid::now_v7();
            let (key, _) = allocate_key(&tx, &prefix_for(&tx, project_id)?)?;
            let now = Utc::now().to_rfc3339();
            tx.execute(
                "INSERT INTO task_items(id, key, project_id, title, body, status, priority, rank, source_note_id, revision,
                                        created_at, updated_at, status_changed_at, created_by_thread_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10, ?10, ?11)",
                params![
                    id.to_string(),
                    key,
                    project_id.map(|id| id.to_string()),
                    title,
                    new.body,
                    status.as_str(),
                    new.priority,
                    end_rank(&tx, status, None)?,
                    new.source_note_id.map(|id| id.to_string()),
                    now,
                    new.created_by_thread.map(|id| id.to_string())
                ],
            )?;
            write_note_links(&tx, id, &note_ids)?;
            tx.commit()?;
            expect_item(c, id)
        })
    }

    /// Apply a patch. Unchanged content returns the current task without a
    /// revision bump, so a retry after a lost reply is harmless.
    pub fn task_item_update(&self, id: TaskItemId, patch: TaskPatch) -> Result<TaskItem> {
        check_content(patch.title.as_deref().map(str::trim), patch.body.as_deref())?;
        if patch.title.as_deref().is_some_and(|title| title.trim().is_empty()) {
            return invalid("A task needs a title. Type one and try again.");
        }
        if let Some(priority) = patch.priority {
            check_priority(priority)?;
        }
        if patch.status.is_some_and(|status| !status.is_user_settable()) {
            return invalid("Running and Needs review follow the agent run. Send the task to an agent instead.");
        }
        if patch.pending_followup.as_deref().is_some_and(|text| text.len() > FOLLOWUP_MAX_BYTES) {
            return invalid("This follow-up is too long. Keep it under 64 KB and try again.");
        }
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let (current, deleted) =
                fetch_item(&tx, id)?.ok_or(TaskError::NotFound("Task not found. It may have been deleted permanently."))?;
            if deleted.is_some() {
                return invalid("Restore this task before editing it.");
            }
            let mut touched = false;

            let new_title = patch.title.as_deref().map(str::trim).filter(|title| *title != current.title);
            let new_body = patch.body.as_deref().filter(|body| *body != current.body);
            if new_title.is_some() || new_body.is_some() {
                match patch.expected_revision {
                    Some(revision) if revision == current.revision => {}
                    Some(_) => return Err(TaskError::Conflict.into()),
                    None => return invalid("Pass expected_revision when changing the title or body."),
                }
                tx.execute(
                    "UPDATE task_items SET title = ?2, body = ?3, revision = revision + 1 WHERE id = ?1",
                    params![id.to_string(), new_title.unwrap_or(&current.title), new_body.unwrap_or(&current.body)],
                )?;
                touched = true;
            }
            if let Some(priority) = patch.priority.filter(|priority| *priority != current.priority) {
                tx.execute("UPDATE task_items SET priority = ?2 WHERE id = ?1", params![id.to_string(), priority])?;
                touched = true;
            }

            // Scope: moving between Global and a project re-keys only a task that never ran.
            let target_project = match (patch.scope, patch.project_id) {
                (None, None) => current.project_id,
                (Some(TaskScope::Global), None) => None,
                (Some(TaskScope::Global), Some(_)) => return invalid("Global tasks do not belong to a project. Leave the project empty."),
                (Some(TaskScope::Project) | None, Some(project_id)) => Some(project_id),
                (Some(TaskScope::Project), None) => return invalid("Choose a project for this task."),
            };
            if target_project != current.project_id {
                let project_id =
                    resolve_scope(&tx, if target_project.is_some() { TaskScope::Project } else { TaskScope::Global }, target_project)?;
                if current.runs.is_empty() {
                    let (key, _) = allocate_key(&tx, &prefix_for(&tx, project_id)?)?;
                    tx.execute(
                        "UPDATE task_items SET project_id = ?2, key = ?3 WHERE id = ?1",
                        params![id.to_string(), project_id.map(|id| id.to_string()), key],
                    )?;
                } else {
                    tx.execute(
                        "UPDATE task_items SET project_id = ?2 WHERE id = ?1",
                        params![id.to_string(), project_id.map(|id| id.to_string())],
                    )?;
                }
                touched = true;
            }

            if let Some(note_ids) = patch.note_ids {
                let note_ids = dedupe(note_ids);
                if note_ids != current.note_ids {
                    check_notes(&tx, &note_ids)?;
                    tx.execute("DELETE FROM task_item_notes WHERE task_id = ?1", [id.to_string()])?;
                    write_note_links(&tx, id, &note_ids)?;
                    touched = true;
                }
            }
            if let Some(text) = patch.pending_followup {
                let text = text.trim();
                let value = (!text.is_empty()).then(|| text.to_owned());
                if value != current.pending_followup {
                    tx.execute("UPDATE task_items SET pending_followup = ?2 WHERE id = ?1", params![id.to_string(), value])?;
                    touched = true;
                }
            }

            // Status and order. A status (even the current one) without `before_id`
            // places the task at the end of that column.
            let status = patch.status.unwrap_or(current.status);
            let status_changed = status != current.status;
            if status_changed {
                let now = Utc::now().to_rfc3339();
                tx.execute(
                    "UPDATE task_items SET status = ?2, status_changed_at = ?3 WHERE id = ?1",
                    params![id.to_string(), status.as_str(), now],
                )?;
                touched = true;
            }
            if patch.before_id.is_some() || patch.status.is_some() {
                let already_last = patch.before_id.is_none()
                    && !status_changed
                    && current.rank > max_rank(&tx, status, Some(id))?.unwrap_or(f64::NEG_INFINITY);
                if !already_last {
                    let rank = place(&tx, id, status, patch.before_id)?;
                    tx.execute("UPDATE task_items SET rank = ?2 WHERE id = ?1", params![id.to_string(), rank])?;
                }
            }
            if touched {
                tx.execute("UPDATE task_items SET updated_at = ?2 WHERE id = ?1", params![id.to_string(), Utc::now().to_rfc3339()])?;
            }
            tx.commit()?;
            expect_item(c, id)
        })
    }

    /// Set the status without the user-status restriction, for run tracking and
    /// sends. Returns the task when the status changed, `None` when it already
    /// had it (or, with `only_from`, was in a different status). The task moves
    /// to the end of its new column.
    pub fn task_item_set_status(&self, id: TaskItemId, status: TaskStatus, only_from: Option<&[TaskStatus]>) -> Result<Option<TaskItem>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let (current, _) = fetch_item(&tx, id)?.ok_or(TaskError::NotFound("Task not found. It may have been deleted permanently."))?;
            if current.status == status || only_from.is_some_and(|from| !from.contains(&current.status)) {
                return Ok(None);
            }
            set_status(&tx, id, status)?;
            tx.commit()?;
            Ok(Some(expect_item(c, id)?))
        })
    }

    /// Soft delete. Deleting a deleted task changes nothing.
    pub fn task_item_delete(&self, id: TaskItemId) -> Result<()> {
        self.with(|c| {
            let (_, deleted) = fetch_item(c, id)?.ok_or(TaskError::NotFound("Task not found. It may have been deleted permanently."))?;
            if deleted.is_none() {
                c.execute("UPDATE task_items SET deleted_at = ?2 WHERE id = ?1", params![id.to_string(), Utc::now().to_rfc3339()])?;
            }
            Ok(())
        })
    }

    /// Bring a deleted task back. A task whose project is gone becomes a global
    /// task and keeps its key.
    pub fn task_item_restore(&self, id: TaskItemId) -> Result<TaskItem> {
        self.with(|c| {
            let (current, deleted) =
                fetch_item(c, id)?.ok_or(TaskError::NotFound("Task not found. It may have been deleted permanently."))?;
            if deleted.is_none() {
                return Ok(current);
            }
            let project_exists = match current.project_id {
                Some(project_id) => {
                    c.query_row("SELECT 1 FROM projects WHERE id = ?1", [project_id.to_string()], |_| Ok(())).optional()?.is_some()
                }
                None => true,
            };
            let project_id = current.project_id.filter(|_| project_exists);
            c.execute(
                "UPDATE task_items SET deleted_at = NULL, project_id = ?2 WHERE id = ?1",
                params![id.to_string(), project_id.map(|id| id.to_string())],
            )?;
            expect_item(c, id)
        })
    }

    /// Permanently remove tasks deleted before `cutoff` and return their ids.
    pub fn tasks_purge_deleted_before(&self, cutoff: DateTime<Utc>) -> Result<Vec<TaskItemId>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let mut expired = Vec::new();
            {
                let mut st = tx.prepare("SELECT id, deleted_at FROM task_items WHERE deleted_at IS NOT NULL")?;
                let rows = st.query_map([], |r| Ok((parse_uuid(r.get::<_, String>(0)?)?, parse_time(r.get::<_, String>(1)?)?)))?;
                for row in rows {
                    let (id, at) = row?;
                    if at < cutoff {
                        expired.push(id);
                    }
                }
            }
            for id in &expired {
                for table in ["task_runs", "task_item_notes", "task_items"] {
                    let column = if table == "task_items" { "id" } else { "task_id" };
                    tx.execute(&format!("DELETE FROM {table} WHERE {column} = ?1"), [id.to_string()])?;
                }
            }
            tx.commit()?;
            Ok(expired)
        })
    }

    /// Purge tasks deleted more than [`TASK_RETENTION_DAYS`] ago.
    pub fn tasks_purge_expired(&self) -> Result<Vec<TaskItemId>> {
        self.tasks_purge_deleted_before(Utc::now() - Duration::days(TASK_RETENTION_DAYS))
    }

    /// Change a project's task prefix: 2 to 5 letters A-Z, unique across
    /// projects. Existing task keys keep the prefix they were created with.
    pub fn project_set_task_prefix(&self, project_id: ProjectId, prefix: &str) -> Result<()> {
        let prefix = validate_prefix(prefix)?;
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let project: Option<Option<String>> =
                tx.query_row("SELECT task_prefix FROM projects WHERE id = ?1", [project_id.to_string()], |r| r.get(0)).optional()?;
            let Some(current) = project else {
                return Err(TaskError::NotFound("Project not found. Choose another project.").into());
            };
            if current.as_deref() == Some(prefix.as_str()) {
                return Ok(());
            }
            if prefix_taken(&tx, &prefix)? {
                return Err(TaskError::Invalid(format!("Another project already uses {prefix}. Choose a different prefix.")).into());
            }
            tx.execute(
                "UPDATE projects SET task_prefix = ?2, updated_at = ?3 WHERE id = ?1",
                params![project_id.to_string(), prefix, Utc::now().to_rfc3339()],
            )?;
            tx.commit()?;
            Ok(())
        })
    }

    // ---- runs ----

    /// Record a new run for the task and set the task to running. The run
    /// number is one more than the task's latest.
    pub fn task_run_start(
        &self,
        task_id: TaskItemId,
        thread_id: ThreadId,
        provider: &ProviderInstance,
        model: Option<&str>,
        notes: &[TaskRunNote],
    ) -> Result<TaskItem> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let (_, deleted) =
                fetch_item(&tx, task_id)?.ok_or(TaskError::NotFound("Task not found. It may have been deleted permanently."))?;
            if deleted.is_some() {
                return invalid("Restore this task before sending it to an agent.");
            }
            let number: i64 =
                tx.query_row("SELECT COALESCE(MAX(number), 0) + 1 FROM task_runs WHERE task_id = ?1", [task_id.to_string()], |r| r.get(0))?;
            tx.execute(
                "INSERT INTO task_runs(task_id, number, thread_id, provider_kind, provider_instance, model, started_at, state, notes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8)",
                params![
                    task_id.to_string(),
                    number,
                    thread_id.to_string(),
                    provider.kind.as_str(),
                    provider.instance,
                    model,
                    Utc::now().to_rfc3339(),
                    serde_json::to_string(notes)?
                ],
            )?;
            set_status(&tx, task_id, TaskStatus::Running)?;
            tx.commit()?;
            expect_item(c, task_id)
        })
    }

    /// The task and run number a thread belongs to, when it is a task run.
    pub fn task_run_for_thread(&self, thread_id: ThreadId) -> Result<Option<(TaskItemId, u32)>> {
        self.with(|c| {
            c.query_row("SELECT task_id, number FROM task_runs WHERE thread_id = ?1", [thread_id.to_string()], |r| {
                Ok((parse_uuid(r.get::<_, String>(0)?)?, r.get::<_, u32>(1)?))
            })
            .optional()
            .map_err(Into::into)
        })
    }

    /// Every thread that is a task run, to seed the daemon's in-memory index.
    pub fn task_run_thread_ids(&self) -> Result<Vec<ThreadId>> {
        self.with(|c| {
            let mut st = c.prepare("SELECT thread_id FROM task_runs")?;
            let rows = st.query_map([], |r| parse_uuid(r.get::<_, String>(0)?))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
    }

    /// Apply a patch to the run of `thread_id`. Returns the task as it is now,
    /// or `None` when the thread is not a task run or nothing changed.
    pub fn task_run_patch(&self, thread_id: ThreadId, patch: TaskRunPatch) -> Result<Option<TaskItem>> {
        Ok(self.task_run_update(thread_id, patch, None)?.map(|update| update.task))
    }

    /// Patch the run of `thread_id` and, in the same transaction, move its task to
    /// `status`. Readers see the run and the task change together, never a task
    /// that is running next to a run that already finished. The task follows only
    /// its latest run: a run that a newer one replaced changes the task's status
    /// no more. `None` when the thread is not a task run or nothing changed.
    pub fn task_run_update(
        &self,
        thread_id: ThreadId,
        patch: TaskRunPatch,
        status: Option<TaskStatusChange>,
    ) -> Result<Option<TaskRunUpdate>> {
        self.with(|c| {
            let tx = c.unchecked_transaction()?;
            let found: Option<(String, u32)> = tx
                .query_row("SELECT task_id, number FROM task_runs WHERE thread_id = ?1", [thread_id.to_string()], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .optional()?;
            let Some((task_id, number)) = found else { return Ok(None) };
            let id: TaskItemId = task_id.parse()?;
            let before = fetch_item(&tx, id)?.map(|(item, _)| item);
            let Some(before) = before else { return Ok(None) };
            let Some(run) = before.runs.iter().find(|run| run.number == number).cloned() else { return Ok(None) };
            if patch.only_from.as_ref().is_some_and(|from| !from.contains(&run.state)) {
                return Ok(None);
            }
            let mut next = run.clone();
            if let Some(state) = patch.state {
                next.state = state;
            }
            if let Some(activity) = patch.activity {
                next.activity = activity;
            }
            if let Some(ended_at) = patch.ended_at {
                next.ended_at = ended_at;
            }
            if let Some(diff) = patch.diff {
                next.diff = diff;
            }
            let run_changed = next != run;
            if run_changed {
                tx.execute(
                    "UPDATE task_runs SET state = ?3, activity = ?4, ended_at = ?5, diff_added = ?6, diff_removed = ?7, diff_files = ?8
                     WHERE task_id = ?1 AND number = ?2",
                    params![
                        task_id,
                        number,
                        next.state.as_str(),
                        next.activity,
                        next.ended_at.map(|at| at.to_rfc3339()),
                        next.diff.map(|diff| diff.added),
                        next.diff.map(|diff| diff.removed),
                        next.diff.map(|diff| diff.files),
                    ],
                )?;
            }
            let latest = before.runs.iter().map(|run| run.number).max() == Some(number);
            let status_changed = match status {
                Some(change)
                    if latest
                        && before.status != change.status
                        && change.only_from.as_ref().is_none_or(|from| from.contains(&before.status)) =>
                {
                    set_status(&tx, id, change.status)?;
                    true
                }
                _ => false,
            };
            if !run_changed && !status_changed {
                return Ok(None);
            }
            tx.commit()?;
            Ok(Some(TaskRunUpdate { task: expect_item(c, id)?, run_changed, status_changed }))
        })
    }

    /// Remove a run record, for a send that failed before the agent started.
    pub fn task_run_delete(&self, thread_id: ThreadId) -> Result<()> {
        self.with(|c| {
            c.execute("DELETE FROM task_runs WHERE thread_id = ?1", [thread_id.to_string()])?;
            Ok(())
        })
    }
}

// ---- projects: prefixes ----

/// A task key prefix from a project name, uppercase A-Z, two to five characters.
/// A one-word name gives its first three letters; a longer name gives the first
/// two letters of its first word plus the first letter of each later word.
/// "ade" gives `ADE`, "kybern-mobile" gives `KYM`, "anamorphia-gallery" gives `ANG`.
pub fn derive_task_prefix(name: &str) -> String {
    let words: Vec<String> = name
        .split(|c: char| !c.is_alphanumeric())
        .map(|word| word.chars().filter(char::is_ascii_alphabetic).map(|c| c.to_ascii_uppercase()).collect::<String>())
        .filter(|word| !word.is_empty())
        .collect();
    let Some(first) = words.first() else { return "PRJ".into() };
    let mut prefix: String = first.chars().take(if words.len() > 1 { 2 } else { 3 }).collect();
    for word in &words[1..] {
        if prefix.len() >= 5 {
            break;
        }
        prefix.extend(word.chars().next());
    }
    while prefix.len() < 2 {
        prefix.push('X');
    }
    prefix
}

fn validate_prefix(raw: &str) -> Result<String> {
    let prefix = raw.trim().to_ascii_uppercase();
    if !(2..=5).contains(&prefix.len()) || !prefix.chars().all(|c| c.is_ascii_uppercase()) {
        return invalid("A task prefix is 2 to 5 letters, A to Z. Use something like ADE.");
    }
    if prefix == GLOBAL_TASK_PREFIX {
        return invalid("TSK is used for tasks without a project. Choose a different prefix.");
    }
    Ok(prefix)
}

fn prefix_taken(c: &Connection, prefix: &str) -> Result<bool> {
    Ok(prefix == GLOBAL_TASK_PREFIX
        || c.query_row("SELECT 1 FROM projects WHERE task_prefix = ?1", [prefix], |_| Ok(())).optional()?.is_some())
}

/// `base`, or `base` with a letter added (the last letter replaced once it is five long) until no project has it.
fn unique_prefix(c: &Connection, base: &str) -> Result<String> {
    if !prefix_taken(c, base)? {
        return Ok(base.to_owned());
    }
    let letters = 'A'..='Z';
    let stem: String = base.chars().take(4).collect();
    for letter in letters.clone() {
        let candidate = format!("{stem}{letter}");
        if !prefix_taken(c, &candidate)? {
            return Ok(candidate);
        }
    }
    let stem: String = base.chars().take(3).collect();
    for first in letters.clone() {
        for second in letters.clone() {
            let candidate = format!("{stem}{first}{second}");
            if !prefix_taken(c, &candidate)? {
                return Ok(candidate);
            }
        }
    }
    anyhow::bail!("no free task prefix is left for this project name")
}

/// Give a project its task prefix unless it has one. A requested prefix is used
/// when it is valid and free; otherwise one is derived from the name.
pub(crate) fn assign_project_prefix(c: &Connection, project_id: ProjectId, name: &str, requested: Option<&str>) -> Result<()> {
    if is_free_chat_project(project_id) {
        return Ok(());
    }
    let existing: Option<String> =
        c.query_row("SELECT task_prefix FROM projects WHERE id = ?1", [project_id.to_string()], |r| r.get(0)).optional()?.flatten();
    if existing.is_some() {
        return Ok(());
    }
    let prefix = match requested.and_then(|raw| validate_prefix(raw).ok()) {
        Some(prefix) if !prefix_taken(c, &prefix)? => prefix,
        _ => unique_prefix(c, &derive_task_prefix(name))?,
    };
    c.execute("UPDATE projects SET task_prefix = ?2 WHERE id = ?1", params![project_id.to_string(), prefix])?;
    Ok(())
}

/// Backfill prefixes for projects that predate tasks (and any a downgrade left empty).
pub(crate) fn ensure_project_prefixes(c: &Connection) -> Result<()> {
    let missing: Vec<(String, String)> = {
        let mut st = c.prepare("SELECT id, name FROM projects WHERE task_prefix IS NULL ORDER BY created_at, id")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?
    };
    for (id, name) in missing {
        assign_project_prefix(c, id.parse()?, &name, None)?;
    }
    Ok(())
}

/// Soft delete the live tasks of a project, for its removal. Returns their ids.
pub(crate) fn soft_delete_project_tasks(c: &Connection, project_id: ProjectId) -> Result<Vec<TaskItemId>> {
    let ids: Vec<TaskItemId> = {
        let mut st = c.prepare("SELECT id FROM task_items WHERE project_id = ?1 AND deleted_at IS NULL")?;
        let rows = st.query_map([project_id.to_string()], |r| parse_uuid(r.get::<_, String>(0)?))?;
        rows.collect::<Result<_, _>>()?
    };
    let now = Utc::now().to_rfc3339();
    for id in &ids {
        c.execute("UPDATE task_items SET deleted_at = ?2 WHERE id = ?1", params![id.to_string(), now])?;
    }
    Ok(ids)
}

// ---- keys, ranks, links ----

fn prefix_for(c: &Connection, project_id: Option<ProjectId>) -> Result<String> {
    let Some(project_id) = project_id else { return Ok(GLOBAL_TASK_PREFIX.into()) };
    let existing: Option<Option<String>> =
        c.query_row("SELECT task_prefix FROM projects WHERE id = ?1", [project_id.to_string()], |r| r.get(0)).optional()?;
    match existing {
        Some(Some(prefix)) => Ok(prefix),
        Some(None) => {
            let name: String = c.query_row("SELECT name FROM projects WHERE id = ?1", [project_id.to_string()], |r| r.get(0))?;
            assign_project_prefix(c, project_id, &name, None)?;
            Ok(c.query_row("SELECT task_prefix FROM projects WHERE id = ?1", [project_id.to_string()], |r| r.get(0))?)
        }
        None => Err(TaskError::NotFound("Project not found. Choose another project.").into()),
    }
}

/// Hand out the next number for `prefix`. Numbers only go up.
fn allocate_key(c: &Connection, prefix: &str) -> Result<(String, i64)> {
    c.execute("INSERT INTO task_counters(prefix, next) VALUES (?1, 1) ON CONFLICT(prefix) DO NOTHING", [prefix])?;
    let number: i64 = c.query_row("SELECT next FROM task_counters WHERE prefix = ?1", [prefix], |r| r.get(0))?;
    c.execute("UPDATE task_counters SET next = next + 1 WHERE prefix = ?1", [prefix])?;
    Ok((format!("{prefix}-{number}"), number))
}

fn max_rank(c: &Connection, status: TaskStatus, except: Option<TaskItemId>) -> Result<Option<f64>> {
    Ok(c.query_row(
        "SELECT MAX(rank) FROM task_items WHERE status = ?1 AND deleted_at IS NULL AND id != ?2",
        params![status.as_str(), except.map(|id| id.to_string()).unwrap_or_default()],
        |r| r.get(0),
    )?)
}

fn end_rank(c: &Connection, status: TaskStatus, except: Option<TaskItemId>) -> Result<f64> {
    Ok(max_rank(c, status, except)?.unwrap_or(0.0) + RANK_STEP)
}

/// Move to `status` and the end of its column.
fn set_status(c: &Connection, id: TaskItemId, status: TaskStatus) -> Result<()> {
    let now = Utc::now().to_rfc3339();
    c.execute(
        "UPDATE task_items SET status = ?2, rank = ?3, status_changed_at = ?4, updated_at = ?4 WHERE id = ?1",
        params![id.to_string(), status.as_str(), end_rank(c, status, Some(id))?, now],
    )?;
    Ok(())
}

/// The rank that puts `id` right before `before` in the `status` column, or at the end.
fn place(c: &Connection, id: TaskItemId, status: TaskStatus, before: Option<TaskItemId>) -> Result<f64> {
    let Some(before) = before else { return end_rank(c, status, Some(id)) };
    if before == id {
        return invalid("Drop a task before a different task.");
    }
    for _ in 0..2 {
        let target: Option<(f64, String)> = c
            .query_row("SELECT rank, status FROM task_items WHERE id = ?1 AND deleted_at IS NULL", [before.to_string()], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?;
        let Some((before_rank, before_status)) = target else {
            return Err(TaskError::NotFound("The task you dropped on was deleted. Refresh and try again.").into());
        };
        if before_status != status.as_str() {
            return invalid("Drop before a task in the same column.");
        }
        let previous: Option<f64> = c.query_row(
            "SELECT MAX(rank) FROM task_items WHERE status = ?1 AND deleted_at IS NULL AND id != ?2 AND rank < ?3",
            params![status.as_str(), id.to_string(), before_rank],
            |r| r.get(0),
        )?;
        match previous {
            None => return Ok(before_rank - RANK_STEP),
            Some(previous) if before_rank - previous > MIN_RANK_GAP => return Ok((previous + before_rank) / 2.0),
            Some(_) => renormalize(c, status)?,
        }
    }
    anyhow::bail!("could not make room to place the task")
}

/// Space a column's ranks evenly again once repeated halving has used up the gaps.
fn renormalize(c: &Connection, status: TaskStatus) -> Result<()> {
    let ids: Vec<String> = {
        let mut st = c.prepare("SELECT id FROM task_items WHERE status = ?1 AND deleted_at IS NULL ORDER BY rank, created_at")?;
        st.query_map([status.as_str()], |r| r.get(0))?.collect::<Result<_, _>>()?
    };
    for (index, id) in ids.iter().enumerate() {
        c.execute("UPDATE task_items SET rank = ?2 WHERE id = ?1", params![id, (index as f64 + 1.0) * RANK_STEP])?;
    }
    Ok(())
}

fn resolve_scope(c: &Connection, scope: TaskScope, project_id: Option<ProjectId>) -> Result<Option<ProjectId>> {
    match (scope, project_id) {
        (TaskScope::Global, None) => Ok(None),
        (TaskScope::Global, Some(_)) => invalid("Global tasks do not belong to a project. Leave the project empty."),
        (TaskScope::Project, None) => invalid("Choose a project for this task."),
        (TaskScope::Project, Some(id)) => {
            if is_free_chat_project(id) {
                return invalid("Chats without a project have no project tasks. Choose a project or make it a global task.");
            }
            if c.query_row("SELECT 1 FROM projects WHERE id = ?1", [id.to_string()], |_| Ok(())).optional()?.is_none() {
                return Err(TaskError::NotFound("Project not found. Choose another project.").into());
            }
            Ok(Some(id))
        }
    }
}

fn dedupe(ids: Vec<NoteId>) -> Vec<NoteId> {
    let mut seen = Vec::with_capacity(ids.len());
    for id in ids {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

fn check_notes(c: &Connection, ids: &[NoteId]) -> Result<()> {
    for id in ids {
        let live: Option<Option<String>> =
            c.query_row("SELECT deleted_at FROM notes WHERE id = ?1", [id.to_string()], |r| r.get(0)).optional()?;
        match live {
            None => return Err(TaskError::NotFound("A linked note was not found. Remove it and try again.").into()),
            Some(Some(_)) => return invalid("A linked note is in Recently deleted. Restore it or remove it from the task."),
            Some(None) => {}
        }
    }
    Ok(())
}

fn write_note_links(c: &Connection, task_id: TaskItemId, note_ids: &[NoteId]) -> Result<()> {
    for (position, note_id) in note_ids.iter().enumerate() {
        c.execute(
            "INSERT INTO task_item_notes(task_id, note_id, position) VALUES (?1, ?2, ?3)",
            params![task_id.to_string(), note_id.to_string(), position as i64],
        )?;
    }
    Ok(())
}

fn check_content(title: Option<&str>, body: Option<&str>) -> Result<()> {
    if title.is_some_and(|title| title.chars().count() > TASK_TITLE_MAX_CHARS) {
        return invalid("This title is too long. Keep it under 300 characters and try again.");
    }
    if body.is_some_and(|body| body.len() > TASK_BODY_MAX_BYTES) {
        return invalid("This description is too long. Keep it under 512 KB and try again.");
    }
    Ok(())
}

fn check_priority(priority: TaskPriority) -> Result<()> {
    if priority > 4 {
        return invalid("Priority is 0 (none) to 4 (low).");
    }
    Ok(())
}

// ---- rows ----

const ITEM_SELECT: &str = "SELECT id, key, project_id, title, body, status, priority, rank, source_note_id, pending_followup,
        revision, created_at, updated_at, status_changed_at, deleted_at, created_by_thread_id FROM task_items";

fn parse_enum<T: DeserializeOwned>(value: String) -> rusqlite::Result<T> {
    serde_json::from_value(serde_json::Value::String(value)).map_err(other)
}

fn row_to_item(r: &rusqlite::Row<'_>) -> rusqlite::Result<(TaskItem, Option<DateTime<Utc>>)> {
    let project_id = r.get::<_, Option<String>>(2)?.map(parse_uuid).transpose()?;
    let item = TaskItem {
        id: parse_uuid(r.get::<_, String>(0)?)?,
        key: r.get(1)?,
        scope: if project_id.is_some() { TaskScope::Project } else { TaskScope::Global },
        project_id,
        title: r.get(3)?,
        body: r.get(4)?,
        status: parse_enum(r.get::<_, String>(5)?)?,
        priority: r.get(6)?,
        rank: r.get(7)?,
        note_ids: Vec::new(),
        source_note_id: r.get::<_, Option<String>>(8)?.map(parse_uuid).transpose()?,
        pending_followup: r.get(9)?,
        runs: Vec::new(),
        revision: r.get(10)?,
        created_at: parse_time(r.get::<_, String>(11)?)?,
        updated_at: parse_time(r.get::<_, String>(12)?)?,
        status_changed_at: parse_time(r.get::<_, String>(13)?)?,
        created_by_thread: r.get::<_, Option<String>>(15)?.map(parse_uuid).transpose()?,
    };
    let deleted_at = r.get::<_, Option<String>>(14)?.map(parse_time).transpose()?;
    Ok((item, deleted_at))
}

fn query_items<P: rusqlite::Params>(c: &Connection, clause: &str, params: P) -> Result<Vec<TaskItem>> {
    let mut st = c.prepare(&format!("{ITEM_SELECT} {clause}"))?;
    let rows = st.query_map(params, row_to_item)?;
    Ok(rows.map(|row| row.map(|(item, _)| item)).collect::<Result<Vec<_>, _>>()?)
}

/// The task with its runs and notes, and when it was deleted.
fn fetch_item(c: &Connection, id: TaskItemId) -> Result<Option<(TaskItem, Option<DateTime<Utc>>)>> {
    let row = c.query_row(&format!("{ITEM_SELECT} WHERE id = ?1"), [id.to_string()], row_to_item).optional()?;
    let Some((item, deleted)) = row else { return Ok(None) };
    let mut items = vec![item];
    attach(c, &mut items, Some(id))?;
    Ok(items.pop().map(|item| (item, deleted)))
}

fn expect_item(c: &Connection, id: TaskItemId) -> Result<TaskItem> {
    fetch_item(c, id)?
        .map(|(item, _)| item)
        .ok_or_else(|| TaskError::NotFound("Task not found. It may have been deleted permanently.").into())
}

/// Load runs (oldest first) and linked notes (in order) onto `items`; for one task or for all.
fn attach(c: &Connection, items: &mut [TaskItem], only: Option<TaskItemId>) -> Result<()> {
    let filter = if only.is_some() { "WHERE task_id = ?1" } else { "WHERE ?1 IS NULL" };
    let only = only.map(|id| id.to_string());

    let mut runs: HashMap<String, Vec<TaskRun>> = HashMap::new();
    let mut st = c.prepare(&format!(
        "SELECT task_id, number, thread_id, provider_kind, provider_instance, model, started_at, ended_at, state, activity,
                diff_added, diff_removed, diff_files, notes
         FROM task_runs {filter} ORDER BY task_id, number"
    ))?;
    let rows = st.query_map([&only], |r| {
        let kind: String = r.get(3)?;
        let diff = match (r.get::<_, Option<u32>>(10)?, r.get::<_, Option<u32>>(11)?, r.get::<_, Option<u32>>(12)?) {
            (Some(added), Some(removed), Some(files)) => Some(TaskRunDiff { added, removed, files }),
            _ => None,
        };
        let notes: String = r.get(13)?;
        Ok((
            r.get::<_, String>(0)?,
            TaskRun {
                number: r.get(1)?,
                thread_id: parse_uuid(r.get::<_, String>(2)?)?,
                provider: ProviderInstance {
                    kind: kind.parse::<ProviderKind>().map_err(|e| other(std::io::Error::other(e)))?,
                    instance: r.get(4)?,
                },
                model: r.get(5)?,
                started_at: parse_time(r.get::<_, String>(6)?)?,
                ended_at: r.get::<_, Option<String>>(7)?.map(parse_time).transpose()?,
                state: parse_enum(r.get::<_, String>(8)?)?,
                activity: r.get(9)?,
                diff,
                notes: serde_json::from_str::<Vec<TaskRunNote>>(&notes).map_err(other)?,
            },
        ))
    })?;
    for row in rows {
        let (task_id, run) = row?;
        runs.entry(task_id).or_default().push(run);
    }

    let mut links: HashMap<String, Vec<NoteId>> = HashMap::new();
    let mut st = c.prepare(&format!("SELECT task_id, note_id FROM task_item_notes {filter} ORDER BY task_id, position"))?;
    let rows = st.query_map([&only], |r| Ok((r.get::<_, String>(0)?, parse_uuid(r.get::<_, String>(1)?)?)))?;
    for row in rows {
        let (task_id, note_id) = row?;
        links.entry(task_id).or_default().push(note_id);
    }

    for item in items {
        let key = item.id.to_string();
        item.runs = runs.remove(&key).unwrap_or_default();
        item.note_ids = links.remove(&key).unwrap_or_default();
    }
    Ok(())
}

// ---- note lines ----

/// A checklist line (`- [ ] text`, `* [x] text`, `1. [X] text`): where its
/// checkbox mark and its text start, and whether it is ticked.
struct ChecklistLine {
    /// Byte index of the character between the brackets.
    mark: usize,
    /// Byte index where the item text starts.
    text: usize,
    checked: bool,
}

fn parse_checklist_line(line: &str) -> Option<ChecklistLine> {
    let trimmed = line.trim_start();
    let item = list_item(trimmed)?;
    let checked = match item.get(..3)? {
        "[ ]" => false,
        "[x]" | "[X]" => true,
        _ => return None,
    };
    if item.len() > 3 && !item[3..].starts_with(char::is_whitespace) {
        return None;
    }
    let marker_start = line.len() - item.len();
    let after_marker = &item[3..];
    let text = marker_start + 3 + (after_marker.len() - after_marker.trim_start().len());
    Some(ChecklistLine { mark: marker_start + 1, text, checked })
}

/// The task id of the first `kybern://task/<id>` link in `text`.
fn linked_task(text: &str) -> Option<TaskItemId> {
    let start = text.find(TASK_LINK)? + TASK_LINK.len();
    text.get(start..start + 36)?.parse().ok()
}

/// Lines of `body` outside code fences, with their terminators.
fn body_lines(body: &str) -> Vec<(&str, bool)> {
    let mut in_fence = false;
    body.split_inclusive('\n')
        .map(|line| {
            let trimmed = line.trim_start();
            let fence = trimmed.starts_with("```") || trimmed.starts_with("~~~");
            if fence {
                in_fence = !in_fence;
            }
            (line, in_fence || fence)
        })
        .collect()
}

/// Checklist lines that link a task, as `(task id, ticked)`, in document order.
pub fn task_link_lines(body: &str) -> Vec<(TaskItemId, bool)> {
    body_lines(body)
        .into_iter()
        .filter(|(_, fenced)| !fenced)
        .filter_map(|(line, _)| {
            let parsed = parse_checklist_line(line)?;
            Some((linked_task(&line[parsed.text..])?, parsed.checked))
        })
        .collect()
}

/// Tick or untick every checklist line that links `task_id`. `None` when no line needs to change.
pub fn task_set_line_checked(body: &str, task_id: TaskItemId, checked: bool) -> Option<String> {
    let mut out = String::with_capacity(body.len());
    let mut changed = false;
    for (line, fenced) in body_lines(body) {
        let parsed = (!fenced).then(|| parse_checklist_line(line)).flatten();
        match parsed {
            Some(parsed) if parsed.checked != checked && linked_task(&line[parsed.text..]) == Some(task_id) => {
                out.push_str(&line[..parsed.mark]);
                out.push(if checked { 'x' } else { ' ' });
                out.push_str(&line[parsed.mark + 1..]);
                changed = true;
            }
            _ => out.push_str(line),
        }
    }
    changed.then_some(out)
}

/// End the first checklist line that matches `line_text` and has no task link yet
/// with ` [KEY](kybern://task/<id>)`. `line_text` may include the `- [ ]` marker.
/// `None` when no line matches.
pub fn task_link_source_line(body: &str, line_text: &str, key: &str, task_id: TaskItemId) -> Option<String> {
    let wanted = line_text.trim();
    let wanted = parse_checklist_line(wanted).map_or(wanted, |parsed| wanted[parsed.text..].trim());
    if wanted.is_empty() {
        return None;
    }
    let mut out = String::with_capacity(body.len() + 64);
    let mut linked = false;
    for (line, fenced) in body_lines(body) {
        let parsed = (!linked && !fenced).then(|| parse_checklist_line(line)).flatten();
        match parsed {
            Some(parsed) if line[parsed.text..].trim() == wanted && !line.contains(TASK_LINK) => {
                let content = line.trim_end_matches(['\r', '\n']);
                out.push_str(content.trim_end());
                out.push_str(&format!(" [{key}]({TASK_LINK}{task_id})"));
                out.push_str(&line[content.len()..]);
                linked = true;
            }
            _ => out.push_str(line),
        }
    }
    linked.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use kybern_protocol::methods::NoteScope;
    use kybern_protocol::{PermissionMode, Project, Thread, ThreadStatus};

    fn project(store: &Store, name: &str) -> Project {
        let now = Utc::now();
        let project = Project {
            id: Uuid::now_v7(),
            name: name.into(),
            path: format!("/tmp/{}", Uuid::now_v7()),
            is_git: false,
            worktrees_default: None,
            task_prefix: None,
            created_at: now,
            updated_at: now,
        };
        store.project_insert(&project).unwrap();
        store.project_get(project.id).unwrap().unwrap()
    }

    fn thread(store: &Store, project: &Project) -> Thread {
        let now = Utc::now();
        let thread = Thread {
            id: Uuid::now_v7(),
            project_id: project.id,
            title: "Run".into(),
            provider: ProviderInstance::default_for(ProviderKind::ClaudeCode),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Supervised,
            status: ThreadStatus::Idle,
            worktree: None,
            cwd: project.path.clone(),
            provider_session_id: None,
            pinned: false,
            created_at: now,
            updated_at: now,
            last_seq: 0,
            parent_thread_id: None,
            coordinator_project_id: None,
            collaboration_group_id: None,
            subagent: None,
        };
        store.thread_upsert(&thread).unwrap();
        thread
    }

    fn new_task(project: Option<&Project>, title: &str) -> NewTask {
        NewTask {
            scope: if project.is_some() { TaskScope::Project } else { TaskScope::Global },
            project_id: project.map(|p| p.id),
            title: title.into(),
            body: String::new(),
            status: None,
            priority: 0,
            note_ids: Vec::new(),
            source_note_id: None,
            created_by_thread: None,
        }
    }

    fn task_error(result: Result<impl std::fmt::Debug>) -> TaskError {
        match result.unwrap_err().downcast::<TaskError>() {
            Ok(error) => error,
            Err(other) => panic!("expected a task error, got {other:#}"),
        }
    }

    fn titles(store: &Store, status: TaskStatus) -> Vec<String> {
        store.task_items_list().unwrap().into_iter().filter(|t| t.status == status).map(|t| t.title).collect()
    }

    #[test]
    fn agent_authorship_survives_the_migration_and_round_trips() {
        // A v14 database (tasks, no authorship) gains the column with every old row unattributed.
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate_to(&conn, 14).unwrap();
        conn.execute_batch(
            "INSERT INTO task_items(id, key, title, status, rank, revision, created_at, updated_at, status_changed_at)
               VALUES ('00000000-0000-7000-8000-000000000001', 'TSK-1', 'Old', 'inbox', 1024, 1,
                       '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00');
             INSERT INTO notes(id, scope, title, body, revision, created_at, updated_at)
               VALUES ('00000000-0000-7000-8000-000000000002', 'global', 'Old note', '', 1, '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00');",
        )
        .unwrap();
        crate::schema::migrate(&conn).unwrap();
        let authors: Vec<Option<String>> = conn
            .prepare("SELECT created_by_thread_id FROM task_items UNION ALL SELECT created_by_thread_id FROM notes")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(authors, vec![None, None]);

        let store = Store::open_in_memory().unwrap();
        let ade = project(&store, "ade");
        let agent = thread(&store, &ade);
        let user_task = store.task_item_create(new_task(Some(&ade), "Mine")).unwrap();
        assert_eq!(user_task.created_by_thread, None);
        let agent_task =
            store.task_item_create(NewTask { created_by_thread: Some(agent.id), ..new_task(Some(&ade), "Filed by an agent") }).unwrap();
        assert_eq!(agent_task.created_by_thread, Some(agent.id));
        assert_eq!(store.task_item_get(agent_task.id).unwrap().unwrap().created_by_thread, Some(agent.id));
        let listed = store.task_items_list().unwrap();
        assert_eq!(listed.iter().find(|task| task.id == agent_task.id).unwrap().created_by_thread, Some(agent.id));

        let user_note = store.note_create(NoteScope::Project, Some(ade.id), "Mine", "").unwrap();
        assert_eq!(user_note.summary.created_by_thread, None);
        let agent_note = store.note_create_by(NoteScope::Project, Some(ade.id), "Findings", "x", Some(agent.id)).unwrap();
        assert_eq!(store.note_get(agent_note.summary.id).unwrap().unwrap().summary.created_by_thread, Some(agent.id));
        let edited = store.note_update(crate::NoteTarget::Id(agent_note.summary.id), 1, None, Some("y")).unwrap();
        assert_eq!(edited.summary.created_by_thread, Some(agent.id), "edits keep the author");

        // Descriptions now take as much as notes do.
        let big = "x".repeat(TASK_BODY_MAX_BYTES);
        assert!(store.task_item_create(NewTask { body: big.clone(), ..new_task(None, "Big") }).is_ok());
        let error = task_error(store.task_item_create(NewTask { body: big + "x", ..new_task(None, "Too big") }));
        assert_eq!(error, TaskError::Invalid("This description is too long. Keep it under 512 KB and try again.".into()));
    }

    #[test]
    fn derives_prefixes_from_project_names() {
        assert_eq!(derive_task_prefix("kybern-mobile"), "KYM");
        assert_eq!(derive_task_prefix("ade"), "ADE");
        assert_eq!(derive_task_prefix("anamorphia-gallery"), "ANG");
        assert_eq!(derive_task_prefix("Kybern"), "KYB");
        assert_eq!(derive_task_prefix("my big shiny project name"), "MYBSP");
        assert_eq!(derive_task_prefix("ab"), "AB");
        assert_eq!(derive_task_prefix("x"), "XX");
        assert_eq!(derive_task_prefix("12345"), "PRJ");
        assert_eq!(derive_task_prefix("Café Ñandú"), "CAA", "only A-Z letters count");
    }

    #[test]
    fn projects_get_unique_prefixes_and_the_global_one_stays_reserved() {
        let store = Store::open_in_memory().unwrap();
        let first = project(&store, "ade");
        let second = project(&store, "ade");
        let third = project(&store, "ade");
        assert_eq!(first.task_prefix.as_deref(), Some("ADE"));
        assert_eq!(second.task_prefix.as_deref(), Some("ADEA"));
        assert_eq!(third.task_prefix.as_deref(), Some("ADEB"));
        let tsk = project(&store, "tsk");
        assert_eq!(tsk.task_prefix.as_deref(), Some("TSKA"), "TSK belongs to global tasks");
        let long = project(&store, "alpha beta gamma delta");
        assert_eq!(long.task_prefix.as_deref(), Some("ALBGD"));
        let long2 = project(&store, "alpha beta gamma delta");
        assert_eq!(long2.task_prefix.as_deref(), Some("ALBGA"), "a full prefix replaces its last letter");
        let listed = store.projects_list().unwrap();
        assert!(listed.iter().all(|p| p.task_prefix.is_some()));
        assert!(store.project_get(kybern_protocol::FREE_CHAT_PROJECT_ID).unwrap().is_none());
    }

    #[test]
    fn editing_a_prefix_validates_and_keeps_existing_keys() {
        let store = Store::open_in_memory().unwrap();
        let ade = project(&store, "ade");
        let other = project(&store, "other");
        let task = store.task_item_create(new_task(Some(&ade), "First")).unwrap();
        assert_eq!(task.key, "ADE-1");

        store.project_set_task_prefix(ade.id, " kyb ").unwrap();
        assert_eq!(store.project_get(ade.id).unwrap().unwrap().task_prefix.as_deref(), Some("KYB"));
        assert_eq!(store.task_item_get(task.id).unwrap().unwrap().key, "ADE-1", "existing keys are kept");
        assert_eq!(store.task_item_create(new_task(Some(&ade), "Second")).unwrap().key, "KYB-1");

        for bad in ["A", "ABCDEF", "AB1", "TSK", "ÄÖ"] {
            assert!(matches!(task_error(store.project_set_task_prefix(ade.id, bad)), TaskError::Invalid(_)), "{bad}");
        }
        assert!(matches!(task_error(store.project_set_task_prefix(other.id, "KYB")), TaskError::Invalid(_)), "taken by another project");
        store.project_set_task_prefix(ade.id, "KYB").unwrap();
        assert!(matches!(task_error(store.project_set_task_prefix(Uuid::now_v7(), "ZZZ")), TaskError::NotFound(_)));
        // The old prefix is free again, and its counter continues rather than restarting.
        store.project_set_task_prefix(other.id, "ADE").unwrap();
        assert_eq!(store.task_item_create(new_task(Some(&other), "Third")).unwrap().key, "ADE-2");
    }

    #[test]
    fn migration_creates_the_tables_and_backfills_existing_projects() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate_to(&conn, 13).unwrap();
        conn.execute_batch(
            "INSERT INTO projects(id, name, path, is_git, created_at, updated_at) VALUES
               ('00000000-0000-0000-0000-0000000000a1', 'kybern-mobile', '/a', 0, '2026-09-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00'),
               ('00000000-0000-0000-0000-0000000000a2', 'kybern-mobile', '/b', 0, '2026-09-02T00:00:00+00:00', '2026-09-02T00:00:00+00:00'),
               ('00000000-0000-0000-0000-0000000000a3', 'ade', '/c', 0, '2026-09-03T00:00:00+00:00', '2026-09-03T00:00:00+00:00');",
        )
        .unwrap();
        crate::schema::migrate(&conn).unwrap();
        assert_eq!(conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0)).unwrap(), crate::schema::migration_count() as i64);
        for table in ["task_items", "task_runs", "task_item_notes", "task_counters"] {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap();
        }
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM projects WHERE task_prefix IS NULL", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
        ensure_project_prefixes(&conn).unwrap();
        let prefixes: Vec<String> = conn
            .prepare("SELECT task_prefix FROM projects ORDER BY created_at")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(prefixes, ["KYM", "KYMA", "ADE"], "oldest project gets the plain prefix");
        ensure_project_prefixes(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT task_prefix FROM projects WHERE name = 'ade'", [], |r| r.get::<_, String>(0)).unwrap(),
            "ADE",
            "backfilling again changes nothing"
        );
    }

    #[test]
    fn keys_count_up_per_prefix_and_are_never_reused() {
        let store = Store::open_in_memory().unwrap();
        let ade = project(&store, "ade");
        let a = store.task_item_create(new_task(Some(&ade), "One")).unwrap();
        let b = store.task_item_create(new_task(Some(&ade), "Two")).unwrap();
        let global = store.task_item_create(new_task(None, "Loose")).unwrap();
        let global2 = store.task_item_create(new_task(None, "Loose two")).unwrap();
        assert_eq!((a.key.as_str(), b.key.as_str()), ("ADE-1", "ADE-2"));
        assert_eq!((global.key.as_str(), global2.key.as_str()), ("TSK-1", "TSK-2"));
        assert_eq!((a.scope, global.scope, global.project_id), (TaskScope::Project, TaskScope::Global, None));

        // Deleting and even purging a task does not free its number.
        store.task_item_delete(b.id).unwrap();
        assert_eq!(store.tasks_purge_deleted_before(Utc::now() + Duration::seconds(1)).unwrap(), vec![b.id]);
        assert!(store.task_item_get(b.id).unwrap().is_none());
        assert_eq!(store.task_item_create(new_task(Some(&ade), "Three")).unwrap().key, "ADE-3");

        assert_eq!(store.task_item_by_key("ade-1").unwrap().unwrap().id, a.id, "keys match case-insensitively");
        assert!(store.task_item_by_key("ADE-2").unwrap().is_none());
    }

    #[test]
    fn create_validates_its_input() {
        let store = Store::open_in_memory().unwrap();
        let ade = project(&store, "ade");
        let note = store.note_create(NoteScope::Global, None, "Spec", "").unwrap();
        assert!(matches!(task_error(store.task_item_create(new_task(None, "   "))), TaskError::Invalid(_)));
        assert!(matches!(task_error(store.task_item_create(new_task(None, &"t".repeat(301)))), TaskError::Invalid(_)));
        let mut running = new_task(None, "Nope");
        running.status = Some(TaskStatus::Running);
        assert!(matches!(task_error(store.task_item_create(running)), TaskError::Invalid(_)));
        let mut priority = new_task(None, "Nope");
        priority.priority = 5;
        assert!(matches!(task_error(store.task_item_create(priority)), TaskError::Invalid(_)));
        let mut mismatch = new_task(Some(&ade), "Nope");
        mismatch.scope = TaskScope::Global;
        assert!(matches!(task_error(store.task_item_create(mismatch)), TaskError::Invalid(_)));
        let mut missing_project = new_task(None, "Nope");
        missing_project.scope = TaskScope::Project;
        assert!(matches!(task_error(store.task_item_create(missing_project)), TaskError::Invalid(_)));
        let mut unknown_project = new_task(None, "Nope");
        unknown_project.scope = TaskScope::Project;
        unknown_project.project_id = Some(Uuid::now_v7());
        assert!(matches!(task_error(store.task_item_create(unknown_project)), TaskError::NotFound(_)));
        let mut free_chat = new_task(None, "Nope");
        free_chat.scope = TaskScope::Project;
        free_chat.project_id = Some(kybern_protocol::FREE_CHAT_PROJECT_ID);
        assert!(matches!(task_error(store.task_item_create(free_chat)), TaskError::Invalid(_)));
        let mut missing_note = new_task(None, "Nope");
        missing_note.note_ids = vec![Uuid::now_v7()];
        assert!(matches!(task_error(store.task_item_create(missing_note)), TaskError::NotFound(_)));

        let mut ok = new_task(Some(&ade), "  Fix login  ");
        ok.note_ids = vec![note.summary.id, note.summary.id];
        ok.source_note_id = Some(note.summary.id);
        ok.priority = 2;
        let task = store.task_item_create(ok).unwrap();
        assert_eq!((task.title.as_str(), task.status, task.priority, task.revision), ("Fix login", TaskStatus::Inbox, 2, 1));
        assert_eq!((task.note_ids.clone(), task.source_note_id), (vec![note.summary.id], Some(note.summary.id)));
        assert!(task.runs.is_empty() && task.pending_followup.is_none());
    }

    #[test]
    fn updates_check_the_revision_and_unchanged_saves_do_not_bump_it() {
        let store = Store::open_in_memory().unwrap();
        let task = store.task_item_create(new_task(None, "Plan")).unwrap();
        let edit = |patch: TaskPatch| store.task_item_update(task.id, patch);

        let same = edit(TaskPatch { title: Some("Plan".into()), expected_revision: Some(99), ..Default::default() }).unwrap();
        assert_eq!(same, task, "unchanged content is a no-op even with a stale revision");
        let edited = edit(TaskPatch { body: Some("details".into()), expected_revision: Some(1), ..Default::default() }).unwrap();
        assert_eq!((edited.revision, edited.body.as_str(), edited.title.as_str()), (2, "details", "Plan"));
        assert!(edited.updated_at >= task.updated_at);
        assert_eq!(
            task_error(edit(TaskPatch { body: Some("stale".into()), expected_revision: Some(1), ..Default::default() })),
            TaskError::Conflict
        );
        assert!(matches!(task_error(edit(TaskPatch { body: Some("no rev".into()), ..Default::default() })), TaskError::Invalid(_)));
        assert!(matches!(
            task_error(edit(TaskPatch { title: Some(" ".into()), expected_revision: Some(2), ..Default::default() })),
            TaskError::Invalid(_)
        ));
        // Priority, status and notes need no revision and leave it alone.
        let prioritized = edit(TaskPatch { priority: Some(1), ..Default::default() }).unwrap();
        assert_eq!((prioritized.priority, prioritized.revision), (1, 2));
        assert!(matches!(task_error(edit(TaskPatch { priority: Some(9), ..Default::default() })), TaskError::Invalid(_)));
        let followup = edit(TaskPatch { pending_followup: Some("  also add tests ".into()), ..Default::default() }).unwrap();
        assert_eq!(followup.pending_followup.as_deref(), Some("also add tests"));
        let cleared = edit(TaskPatch { pending_followup: Some("  ".into()), ..Default::default() }).unwrap();
        assert!(cleared.pending_followup.is_none());
        assert_eq!(TaskError::Conflict.to_string(), "This task changed on another device. Choose which version to keep.");
    }

    #[test]
    fn user_statuses_only_and_rank_ordering() {
        let store = Store::open_in_memory().unwrap();
        let a = store.task_item_create(new_task(None, "a")).unwrap();
        let b = store.task_item_create(new_task(None, "b")).unwrap();
        let c = store.task_item_create(new_task(None, "c")).unwrap();
        assert_eq!(titles(&store, TaskStatus::Inbox), ["a", "b", "c"], "new tasks go to the end");

        let update = |id, patch: TaskPatch| store.task_item_update(id, patch);
        for status in [TaskStatus::Running, TaskStatus::NeedsReview] {
            assert!(matches!(task_error(update(a.id, TaskPatch { status: Some(status), ..Default::default() })), TaskError::Invalid(_)));
        }
        // Reorder: c before a, then b before c.
        update(c.id, TaskPatch { before_id: Some(a.id), ..Default::default() }).unwrap();
        assert_eq!(titles(&store, TaskStatus::Inbox), ["c", "a", "b"]);
        update(b.id, TaskPatch { before_id: Some(c.id), ..Default::default() }).unwrap();
        assert_eq!(titles(&store, TaskStatus::Inbox), ["b", "c", "a"]);
        // A status without before_id goes to the end of that column; the same status moves it to the end.
        let todo = update(b.id, TaskPatch { status: Some(TaskStatus::Todo), ..Default::default() }).unwrap();
        assert_eq!(todo.status, TaskStatus::Todo);
        assert!(todo.status_changed_at >= b.status_changed_at);
        update(a.id, TaskPatch { status: Some(TaskStatus::Todo), ..Default::default() }).unwrap();
        update(c.id, TaskPatch { status: Some(TaskStatus::Todo), before_id: Some(b.id), ..Default::default() }).unwrap();
        assert_eq!(titles(&store, TaskStatus::Todo), ["c", "b", "a"]);
        update(c.id, TaskPatch { status: Some(TaskStatus::Todo), ..Default::default() }).unwrap();
        assert_eq!(titles(&store, TaskStatus::Todo), ["b", "a", "c"], "same status, no before_id: move to the end");
        // Dropping before a task in another column is refused, so is a missing or self target.
        let inbox = store.task_item_create(new_task(None, "d")).unwrap();
        assert!(matches!(task_error(update(inbox.id, TaskPatch { before_id: Some(a.id), ..Default::default() })), TaskError::Invalid(_)));
        assert!(matches!(
            task_error(update(inbox.id, TaskPatch { before_id: Some(inbox.id), ..Default::default() })),
            TaskError::Invalid(_)
        ));
        assert!(matches!(
            task_error(update(inbox.id, TaskPatch { before_id: Some(Uuid::now_v7()), ..Default::default() })),
            TaskError::NotFound(_)
        ));
    }

    #[test]
    fn repeated_drops_in_one_gap_renormalize_instead_of_running_out_of_precision() {
        let store = Store::open_in_memory().unwrap();
        let first = store.task_item_create(new_task(None, "first")).unwrap();
        let last = store.task_item_create(new_task(None, "last")).unwrap();
        // Each new task is dropped right before `last`, halving the gap above it every time.
        let mut expected = vec!["first".to_owned()];
        for i in 0..60 {
            let task = store.task_item_create(new_task(None, &format!("t{i}"))).unwrap();
            store.task_item_update(task.id, TaskPatch { before_id: Some(last.id), ..Default::default() }).unwrap();
            expected.push(format!("t{i}"));
        }
        expected.push("last".into());
        assert_eq!(titles(&store, TaskStatus::Inbox), expected);
        let ranks: Vec<f64> = store.task_items_list().unwrap().into_iter().map(|t| t.rank).collect();
        assert!(ranks.windows(2).all(|w| w[1] - w[0] > 0.0), "ranks stay strictly increasing: {ranks:?}");
        let _ = first;
    }

    #[test]
    fn moving_between_global_and_a_project_rekeys_only_tasks_without_runs() {
        let store = Store::open_in_memory().unwrap();
        let ade = project(&store, "ade");
        let thread = thread(&store, &ade);
        let loose = store.task_item_create(new_task(None, "loose")).unwrap();
        assert_eq!(loose.key, "TSK-1");
        let moved = store
            .task_item_update(loose.id, TaskPatch { scope: Some(TaskScope::Project), project_id: Some(ade.id), ..Default::default() })
            .unwrap();
        assert_eq!((moved.key.as_str(), moved.scope, moved.project_id), ("ADE-1", TaskScope::Project, Some(ade.id)));
        let back = store.task_item_update(loose.id, TaskPatch { scope: Some(TaskScope::Global), ..Default::default() }).unwrap();
        assert_eq!((back.key.as_str(), back.project_id), ("TSK-2", None), "the global counter moved on");

        store.task_run_start(loose.id, thread.id, &ProviderInstance::default_for(ProviderKind::ClaudeCode), None, &[]).unwrap();
        let kept = store.task_item_update(loose.id, TaskPatch { project_id: Some(ade.id), ..Default::default() }).unwrap();
        assert_eq!((kept.key.as_str(), kept.project_id), ("TSK-2", Some(ade.id)), "a task with runs keeps its key");
        assert!(matches!(
            task_error(store.task_item_update(loose.id, TaskPatch { scope: Some(TaskScope::Project), ..Default::default() })),
            TaskError::Invalid(_)
        ));
        assert!(matches!(
            task_error(
                store.task_item_update(
                    loose.id,
                    TaskPatch { scope: Some(TaskScope::Global), project_id: Some(ade.id), ..Default::default() }
                )
            ),
            TaskError::Invalid(_)
        ));
    }

    #[test]
    fn soft_delete_hides_restore_brings_back_and_purge_removes_for_good() {
        let store = Store::open_in_memory().unwrap();
        let task = store.task_item_create(new_task(None, "Gone soon")).unwrap();
        let keep = store.task_item_create(new_task(None, "Stays")).unwrap();
        store.task_item_delete(task.id).unwrap();
        store.task_item_delete(task.id).unwrap();
        assert!(store.task_item_get(task.id).unwrap().is_none());
        assert!(store.task_item_by_key(&task.key).unwrap().is_none());
        assert_eq!(store.task_items_list().unwrap().len(), 1);
        assert!(matches!(
            task_error(store.task_item_update(task.id, TaskPatch { priority: Some(1), ..Default::default() })),
            TaskError::Invalid(_)
        ));

        // Not old enough yet.
        assert!(store.tasks_purge_expired().unwrap().is_empty());
        let restored = store.task_item_restore(task.id).unwrap();
        assert_eq!(restored.key, task.key);
        assert_eq!(store.task_items_list().unwrap().len(), 2);
        assert_eq!(store.task_item_restore(task.id).unwrap().id, task.id, "restoring a live task changes nothing");

        store.task_item_delete(task.id).unwrap();
        let purged = store.tasks_purge_deleted_before(Utc::now() + Duration::days(1)).unwrap();
        assert_eq!(purged, vec![task.id]);
        assert!(matches!(task_error(store.task_item_restore(task.id)), TaskError::NotFound(_)));
        assert_eq!(store.task_items_list().unwrap()[0].id, keep.id);
        // Retention: a task deleted 31 days ago is expired, one deleted a day ago is not.
        store.task_item_delete(keep.id).unwrap();
        store
            .with(|c| {
                Ok(c.execute(
                    "UPDATE task_items SET deleted_at = ?2 WHERE id = ?1",
                    params![keep.id.to_string(), (Utc::now() - Duration::days(31)).to_rfc3339()],
                )?)
            })
            .unwrap();
        assert_eq!(store.tasks_purge_expired().unwrap(), vec![keep.id]);
    }

    #[test]
    fn removing_a_project_soft_deletes_its_tasks_and_restore_makes_them_global() {
        let store = Store::open_in_memory().unwrap();
        let ade = project(&store, "ade");
        let other = project(&store, "other");
        let mine = store.task_item_create(new_task(Some(&ade), "mine")).unwrap();
        let theirs = store.task_item_create(new_task(Some(&other), "theirs")).unwrap();
        let global = store.task_item_create(new_task(None, "global")).unwrap();

        let removal = store.project_remove(ade.id).unwrap();
        assert_eq!(removal.tasks, vec![mine.id]);
        assert!(store.task_item_get(mine.id).unwrap().is_none());
        let live: Vec<_> = store.task_items_list().unwrap().into_iter().map(|t| t.id).collect();
        assert!(live.contains(&theirs.id) && live.contains(&global.id) && !live.contains(&mine.id));

        let restored = store.task_item_restore(mine.id).unwrap();
        assert_eq!((restored.scope, restored.project_id, restored.key.as_str()), (TaskScope::Global, None, "ADE-1"));
    }

    #[test]
    fn runs_are_numbered_patched_by_thread_and_survive_in_order() {
        let store = Store::open_in_memory().unwrap();
        let ade = project(&store, "ade");
        let note = store.note_create(NoteScope::Global, None, "Spec", "body").unwrap();
        let task = store.task_item_create(new_task(Some(&ade), "Ship")).unwrap();
        let (t1, t2) = (thread(&store, &ade), thread(&store, &ade));
        let provider = ProviderInstance::default_for(ProviderKind::ClaudeCode);
        let notes = [TaskRunNote { note_id: note.summary.id, revision: 1 }];

        assert!(store.task_run_for_thread(t1.id).unwrap().is_none());
        let started = store.task_run_start(task.id, t1.id, &provider, Some("opus"), &notes).unwrap();
        assert_eq!(started.status, TaskStatus::Running);
        let run = &started.runs[0];
        assert_eq!((run.number, run.thread_id, run.state, run.model.as_deref()), (1, t1.id, TaskRunState::Running, Some("opus")));
        assert_eq!(run.notes, notes);
        assert_eq!(store.task_run_for_thread(t1.id).unwrap(), Some((task.id, 1)));

        let now = Utc::now();
        let patched = store
            .task_run_patch(
                t1.id,
                TaskRunPatch {
                    state: Some(TaskRunState::Completed),
                    activity: Some(None),
                    ended_at: Some(Some(now)),
                    diff: Some(Some(TaskRunDiff { added: 5, removed: 2, files: 1 })),
                    ..Default::default()
                },
            )
            .unwrap()
            .unwrap();
        let run = &patched.runs[0];
        assert_eq!(
            (run.state, run.diff, run.activity.clone()),
            (TaskRunState::Completed, Some(TaskRunDiff { added: 5, removed: 2, files: 1 }), None)
        );
        assert!(run.ended_at.is_some());
        assert!(
            store.task_run_patch(t1.id, TaskRunPatch { state: Some(TaskRunState::Completed), ..Default::default() }).unwrap().is_none(),
            "no change, no result"
        );
        assert!(store.task_run_patch(Uuid::now_v7(), TaskRunPatch::default()).unwrap().is_none());

        let second = store.task_run_start(task.id, t2.id, &provider, None, &[]).unwrap();
        assert_eq!(second.runs.iter().map(|r| r.number).collect::<Vec<_>>(), [1, 2]);
        assert_eq!(second.runs[0].state, TaskRunState::Completed);
        assert_eq!(second.runs[1].thread_id, t2.id);
        let mut ids = store.task_run_thread_ids().unwrap();
        ids.sort();
        let mut expected = vec![t1.id, t2.id];
        expected.sort();
        assert_eq!(ids, expected);

        store.task_run_delete(t2.id).unwrap();
        assert_eq!(store.task_item_get(task.id).unwrap().unwrap().runs.len(), 1);
        // A rolled-back latest run frees its number: nothing ever referenced it.
        assert_eq!(store.task_run_start(task.id, t2.id, &provider, None, &[]).unwrap().runs[1].number, 2);
    }

    #[test]
    fn a_run_and_its_task_status_change_in_one_step_and_only_the_latest_run_moves_the_task() {
        let store = Store::open_in_memory().unwrap();
        let ade = project(&store, "ade");
        let task = store.task_item_create(new_task(Some(&ade), "Ship")).unwrap();
        let (t1, t2) = (thread(&store, &ade), thread(&store, &ade));
        let provider = ProviderInstance::default_for(ProviderKind::ClaudeCode);
        store.task_run_start(task.id, t1.id, &provider, None, &[]).unwrap();
        let finish = |status_from: Option<Vec<TaskStatus>>| {
            (
                TaskRunPatch { state: Some(TaskRunState::Completed), ended_at: Some(Some(Utc::now())), ..Default::default() },
                Some(TaskStatusChange { status: TaskStatus::NeedsReview, only_from: status_from }),
            )
        };

        let (patch, status) = finish(Some(vec![TaskStatus::Running]));
        let update = store.task_run_update(t1.id, patch, status).unwrap().unwrap();
        assert_eq!((update.run_changed, update.status_changed), (true, true));
        assert_eq!((update.task.status, update.task.runs[0].state), (TaskStatus::NeedsReview, TaskRunState::Completed));
        // Reopening: the run and the task go back to running together, ended_at cleared.
        let reopen = TaskRunPatch { state: Some(TaskRunState::Running), ended_at: Some(None), ..Default::default() };
        let update =
            store.task_run_update(t1.id, reopen, Some(TaskStatusChange { status: TaskStatus::Running, only_from: None })).unwrap().unwrap();
        assert_eq!(
            (update.task.status, update.task.runs[0].state, update.task.runs[0].ended_at),
            (TaskStatus::Running, TaskRunState::Running, None)
        );

        // `only_from` leaves a status the user set alone; the run still ends.
        store.task_item_update(task.id, TaskPatch { status: Some(TaskStatus::Done), ..Default::default() }).unwrap();
        let (patch, status) = finish(Some(vec![TaskStatus::Running]));
        let update = store.task_run_update(t1.id, patch, status).unwrap().unwrap();
        assert_eq!((update.run_changed, update.status_changed, update.task.status), (true, false, TaskStatus::Done));

        // A newer run owns the task: the older run's thread no longer changes its status.
        store.task_run_start(task.id, t2.id, &provider, None, &[]).unwrap();
        let reopen = TaskRunPatch { state: Some(TaskRunState::Running), ended_at: Some(None), ..Default::default() };
        let (patch, status) = finish(None);
        store.task_run_update(t2.id, patch, status).unwrap().unwrap();
        let update =
            store.task_run_update(t1.id, reopen, Some(TaskStatusChange { status: TaskStatus::Running, only_from: None })).unwrap().unwrap();
        assert_eq!((update.run_changed, update.status_changed), (true, false));
        assert_eq!(
            (update.task.status, update.task.runs[0].state, update.task.runs[1].state),
            (TaskStatus::NeedsReview, TaskRunState::Running, TaskRunState::Completed)
        );
        // Nothing to change, nothing returned.
        let same = TaskRunPatch { state: Some(TaskRunState::Completed), ..Default::default() };
        let review = TaskStatusChange { status: TaskStatus::NeedsReview, only_from: None };
        assert!(store.task_run_update(t2.id, same, Some(review)).unwrap().is_none());
        assert!(store.task_run_update(Uuid::now_v7(), TaskRunPatch::default(), None).unwrap().is_none());
    }

    #[test]
    fn system_status_changes_only_when_needed_and_move_to_the_end() {
        let store = Store::open_in_memory().unwrap();
        let a = store.task_item_create(new_task(None, "a")).unwrap();
        let b = store.task_item_create(new_task(None, "b")).unwrap();
        assert!(store.task_item_set_status(a.id, TaskStatus::Inbox, None).unwrap().is_none());
        assert!(store.task_item_set_status(a.id, TaskStatus::NeedsReview, Some(&[TaskStatus::Running])).unwrap().is_none());
        let moved = store.task_item_set_status(a.id, TaskStatus::NeedsReview, Some(&[TaskStatus::Inbox])).unwrap().unwrap();
        assert_eq!(moved.status, TaskStatus::NeedsReview);
        store.task_item_set_status(b.id, TaskStatus::NeedsReview, None).unwrap();
        assert_eq!(titles(&store, TaskStatus::NeedsReview), ["a", "b"]);
        assert!(matches!(task_error(store.task_item_set_status(Uuid::now_v7(), TaskStatus::Done, None)), TaskError::NotFound(_)));
    }

    #[test]
    fn note_links_replace_in_order_and_reject_unknown_or_deleted_notes() {
        let store = Store::open_in_memory().unwrap();
        let (n1, n2, n3) = (
            store.note_create(NoteScope::Global, None, "one", "").unwrap().summary.id,
            store.note_create(NoteScope::Global, None, "two", "").unwrap().summary.id,
            store.note_create(NoteScope::Global, None, "three", "").unwrap().summary.id,
        );
        let task = store.task_item_create(NewTask { note_ids: vec![n2, n1], ..new_task(None, "linked") }).unwrap();
        assert_eq!(task.note_ids, [n2, n1], "link order is kept");
        let replaced = store.task_item_update(task.id, TaskPatch { note_ids: Some(vec![n3, n1]), ..Default::default() }).unwrap();
        assert_eq!(replaced.note_ids, [n3, n1]);
        store.note_delete(n1).unwrap();
        assert!(matches!(
            task_error(store.task_item_update(task.id, TaskPatch { note_ids: Some(vec![n1]), ..Default::default() })),
            TaskError::Invalid(_)
        ));
        assert!(matches!(
            task_error(store.task_item_update(task.id, TaskPatch { note_ids: Some(vec![Uuid::now_v7()]), ..Default::default() })),
            TaskError::NotFound(_)
        ));
        assert_eq!(store.task_item_get(task.id).unwrap().unwrap().note_ids, [n3, n1], "a failed replace leaves the links alone");
    }

    #[test]
    fn checklist_link_helpers_rewrite_only_the_right_lines() {
        let id: TaskItemId = "00000000-0000-0000-0000-000000000042".parse().unwrap();
        let other: TaskItemId = "00000000-0000-0000-0000-000000000043".parse().unwrap();
        let body = "# Plan\n- [ ] Fix login\n- [ ] Fix login\n```\n- [ ] Fix login\n```\n* [x] Ship it\n";

        // The first unlinked match (outside code) takes the link; the marker in line_text is optional.
        let linked = task_link_source_line(body, "Fix login", "ADE-14", id).unwrap();
        assert_eq!(
            linked,
            "# Plan\n- [ ] Fix login [ADE-14](kybern://task/00000000-0000-0000-0000-000000000042)\n- [ ] Fix login\n```\n- [ ] Fix login\n```\n* [x] Ship it\n"
        );
        assert_eq!(task_link_source_line(body, "- [ ] Fix login", "ADE-14", id).unwrap(), linked);
        // A second task with the same text links the next unlinked line.
        let twice = task_link_source_line(&linked, "Fix login", "ADE-15", other).unwrap();
        assert!(twice.contains("- [ ] Fix login [ADE-15](kybern://task/00000000-0000-0000-0000-000000000043)\n```"));
        assert!(task_link_source_line(body, "No such line", "ADE-14", id).is_none());
        assert!(task_link_source_line(body, "  ", "ADE-14", id).is_none());
        assert!(task_link_source_line("- plain bullet Fix login\n", "Fix login", "ADE-1", id).is_none(), "only checklist lines link");
        assert_eq!(
            task_link_source_line("- [ ] Fix login  \r\n- [ ] x", "Fix login", "A-1", id).unwrap(),
            "- [ ] Fix login [A-1](kybern://task/00000000-0000-0000-0000-000000000042)\r\n- [ ] x",
            "line endings and trailing spaces are handled"
        );

        assert_eq!(task_link_lines(&twice), vec![(id, false), (other, false)]);
        let ticked = task_set_line_checked(&linked, id, true).unwrap();
        assert!(ticked.contains("- [x] Fix login [ADE-14]"));
        assert_eq!(task_link_lines(&ticked), vec![(id, true)]);
        assert!(task_set_line_checked(&ticked, id, true).is_none(), "already ticked");
        assert!(task_set_line_checked(&ticked, other, false).is_none(), "other tasks are untouched");
        assert_eq!(task_set_line_checked(&ticked, id, false).unwrap(), linked, "unticking restores the line exactly");
        // Links in code fences and in non-checklist lines are ignored.
        let fenced = format!("```\n- [ ] x [A-1](kybern://task/{id})\n```\n- plain [A-1](kybern://task/{id})\n");
        assert!(task_link_lines(&fenced).is_empty());
        assert!(task_set_line_checked(&fenced, id, true).is_none());
    }
}
